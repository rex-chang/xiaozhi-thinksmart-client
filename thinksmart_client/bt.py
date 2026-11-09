"""The device as a Bluetooth speaker: phones pair with it and play their music through it.

BlueZ is handled by bt_helper.py, a child process on the system python3 (see there: pairing agent,
the 3-minute "add a phone" window, the switch, the list of phones). Here: its state for the page,
and the sound.

The system layer (thinksmart-ubuntu-image bluetooth/) makes WirePlumber treat a phone's stream as
an audio source ("bluez_input.<address>...") instead of linking it to the speaker. The source exists
only while the phone streams (PipeWire makes it when the phone starts, removes it when it pauses or
stops); we record it then (pw-record, 48 kHz stereo float) into the client's background channel
(audio.Background): it plays under the replies and the echo canceller knows it, so the wake word
still works while music plays. pw-record is told never to follow another source: when the phone's
goes away it exits (PulseAudio's parec would have been moved to the default source: the microphone,
played back out of the speaker). A phone that starts must be recorded within a couple of seconds or
it gives up sending: CHECK is short. On a device whose system layer predates this, the phone's sound goes
straight to the speaker ('direct' in the state): it plays, but the wake word hardly hears through it.

The client sets what the background does (Client._bluetooth_loop): full, lowered during a
conversation, muted while an alarm rings (the phones are also asked to pause then).
"""
import asyncio
import json
import logging
import pathlib
import shutil
import time

import numpy as np

from .audio import OUT_RATE

log = logging.getLogger(__name__)

HELPER = pathlib.Path(__file__).with_name('bt_helper.py')
SYSTEM_PYTHON = '/usr/bin/python3'
WINDOW = 180              # seconds the "add a phone" window stays open
CHUNK = OUT_RATE // 50    # 20 ms of frames per read
CHECK = 0.5               # seconds between looks for a phone's source while one streams
RESTART_AFTER = 10        # seconds before starting the helper again after it died
DIRECT_AFTER = 5          # a phone streams this long with no source to record: its sound bypasses us


def source_for(sources_text, address):
    """The PipeWire source of a phone, from `pactl list short sources` output, or None."""
    want = 'bluez_input.' + address.replace(':', '_')
    for line in sources_text.splitlines():
        parts = line.split('\t')
        if len(parts) > 1 and parts[1].startswith(want):
            return parts[1]
    return None


class Bluetooth:
    def __init__(self, background, publish, enabled=True):
        self.background = background
        self.publish = publish        # publish(event, data) to the page
        self.enabled = enabled        # the user's switch (config 'bluetooth')
        self.state = {'available': False, 'powered': False, 'window': 0, 'name': '', 'devices': []}
        self.proc = None
        self.capture = None           # (address, source, process, task) while recording a phone
        self.direct = False           # a phone streams but there is no source: old system layer
        self._streaming_since = None

    # ---- what the page shows ----

    def view(self):
        st = dict(self.state)
        st['enabled'] = self.enabled
        st['direct'] = self.direct
        return st

    def streaming(self):
        """The phone playing now ({'name', 'title', 'artist'}) or None."""
        return next((d for d in self.state.get('devices', []) if d.get('streaming')), None)

    def _changed(self):
        self.publish('bluetooth', self.view())

    # ---- the helper ----

    async def start(self):
        if not shutil.which(SYSTEM_PYTHON) or not HELPER.exists():
            log.warning('bluetooth: no %s, no speaker mode', SYSTEM_PYTHON)
            return
        asyncio.create_task(self._run_helper())
        asyncio.create_task(self._capture_loop())

    async def _run_helper(self):
        while True:
            try:
                self.proc = await asyncio.create_subprocess_exec(
                    SYSTEM_PYTHON, str(HELPER), stdin=asyncio.subprocess.PIPE,
                    stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
            except OSError as e:
                log.warning('bluetooth: cannot start the helper: %s', e)
                return
            # the switch decides, also after a restart of the client, the helper or bluetoothd's AutoEnable
            await self._send({'cmd': 'power', 'on': self.enabled})
            err = asyncio.create_task(self._log_stderr(self.proc))
            async for line in self.proc.stdout:
                try:
                    msg = json.loads(line)
                except ValueError:
                    continue
                if 'state' in msg:
                    self._on_state(msg['state'])
                elif 'error' in msg:
                    log.warning('bluetooth: %s', msg['error'])
            await self.proc.wait()
            await err
            log.warning('bluetooth: helper exited (%s), restarting in %d s', self.proc.returncode, RESTART_AFTER)
            self.proc = None
            self.state = dict(self.state, available=False)
            self._changed()
            await asyncio.sleep(RESTART_AFTER)

    @staticmethod
    async def _log_stderr(proc):
        async for line in proc.stderr:
            log.warning('bluetooth helper: %s', line.decode(errors='replace').rstrip())

    async def _send(self, msg):
        if not self.proc or self.proc.stdin.is_closing():
            return False
        self.proc.stdin.write((json.dumps(msg) + '\n').encode())
        try:
            await self.proc.stdin.drain()
        except (ConnectionError, BrokenPipeError):
            return False
        return True

    def _on_state(self, st):
        before = {(d['address'], d['connected'], d['streaming']) for d in self.state.get('devices', [])}
        self.state = st
        after = {(d['address'], d['connected'], d['streaming']) for d in st.get('devices', [])}
        if before != after:
            log.info('bluetooth: %s', [(d['name'], 'streaming' if d['streaming'] else 'connected' if d['connected'] else 'paired')
                                       for d in st.get('devices', [])])
        self._changed()

    # ---- commands (from the page, the alarms) ----

    async def set_enabled(self, on):
        self.enabled = bool(on)
        ok = await self._send({'cmd': 'power', 'on': self.enabled})
        self._changed()
        return ok

    async def open_window(self, on=True):
        if on and not self.enabled:
            await self.set_enabled(True)
        return await self._send({'cmd': 'window', 'seconds': WINDOW if on else 0})

    async def remove(self, address):
        return await self._send({'cmd': 'remove', 'address': str(address)})

    async def disconnect(self, address):
        return await self._send({'cmd': 'disconnect', 'address': str(address)})

    async def pause(self):
        """Ask the phones to pause (AVRCP); most music apps do."""
        return await self._send({'cmd': 'pause'})

    # ---- the sound ----

    async def _capture_loop(self):
        """Record the streaming phone's source while there is one."""
        while True:
            await asyncio.sleep(CHECK)
            try:
                await self._check_capture()
            except Exception:
                log.exception('bluetooth: capture check failed')

    async def _check_capture(self):
        phones = [d for d in self.state.get('devices', []) if d.get('connected')]
        if self.capture and (self.capture[2].returncode is not None   # its source went away (paused, stopped)
                             or self.capture[0] not in {d['address'] for d in phones}):
            await self._stop_capture()
        streaming = next((d for d in phones if d.get('streaming')), None)
        if not streaming:
            self._set_direct(False)
            self._streaming_since = None
            return
        if self.capture:
            return
        source = source_for(await _run('pactl', 'list', 'short', 'sources'), streaming['address'])
        if source:
            self._streaming_since = None
            self._set_direct(False)
            await self._start_capture(streaming['address'], source)
        else:
            # streaming with no source to record: on an old system layer the phone's stream goes
            # straight to the speaker (a moment without one is just PipeWire still making it)
            self._streaming_since = self._streaming_since or time.monotonic()
            if time.monotonic() - self._streaming_since > DIRECT_AFTER:
                self._set_direct(True)

    def _set_direct(self, direct):
        if direct != self.direct:
            self.direct = direct
            if direct:
                log.warning('bluetooth: the phone plays straight to the speaker (system layer without '
                            'bluetooth/60-thinksmart-speaker.lua): the wake word hardly hears through it')
            self._changed()

    async def _start_capture(self, address, source):
        proc = await asyncio.create_subprocess_exec(
            'pw-record', '--target', source, '--rate', str(OUT_RATE), '--channels', '2', '--format', 'f32',
            '--latency', '20ms', '-P', '{ node.dont-reconnect = true, node.dont-move = true, '
            'node.name = thinksmart-bluetooth, media.name = phone }', '-',
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL)
        task = asyncio.create_task(self._read(proc))
        self.capture = (address, source, proc, task)
        log.info('bluetooth: playing %s', source)

    async def _read(self, proc):
        size = CHUNK * 2 * 4
        try:
            while True:
                data = await proc.stdout.readexactly(size)
                self.background.push(np.frombuffer(data, dtype='<f4').reshape(-1, 2).copy())
        except (asyncio.IncompleteReadError, ConnectionError):
            pass

    async def _stop_capture(self):
        address, source, proc, task = self.capture
        self.capture = None
        if proc.returncode is None:
            proc.terminate()
            try:
                await asyncio.wait_for(proc.wait(), 3)
            except asyncio.TimeoutError:
                proc.kill()
        task.cancel()
        self.background.clear()
        log.info('bluetooth: stopped playing %s', source)


async def _run(*cmd):
    try:
        p = await asyncio.create_subprocess_exec(*cmd, stdout=asyncio.subprocess.PIPE,
                                                 stderr=asyncio.subprocess.DEVNULL)
        out, _ = await asyncio.wait_for(p.communicate(), 5)
        return out.decode(errors='replace')
    except (OSError, asyncio.TimeoutError):
        return ''
