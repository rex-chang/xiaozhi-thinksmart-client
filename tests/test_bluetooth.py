"""Bluetooth speaker: the background channel (mixing, ducking, the short queue), what the client sets it
to (conversation, alarms), and finding / recording the phone's source.

Run like test_barge_in.py (same stubs).
"""
import asyncio
import types

import numpy as np
import pytest

import test_barge_in
from thinksmart_client import bt
from thinksmart_client.audio import OUT_RATE, Background

N = 960   # one 20 ms speaker callback


def tone(seconds, level=0.5):
    return np.full((int(seconds * OUT_RATE), 2), level, dtype=np.float32)


def test_waits_for_prime_then_plays():
    b = Background()
    b.push(tone(0.04))
    assert b.pull(N) is None          # less than PRIME queued: nothing yet
    b.push(tone(0.06))
    out = b.pull(N)
    assert out is not None and np.allclose(out, 0.5)
    assert b.last_sound > 0


def test_running_dry_fades_and_primes_again():
    b = Background()
    b.push(tone(0.1))
    for _ in range(4):
        b.pull(N)
    out = b.pull(N)                   # 20 ms left of 100: the 5th callback takes the last of it
    assert out is not None
    out = b.pull(N)                   # dry: silence, and nothing until PRIME is queued again
    assert out is None or not out.any()
    b.push(tone(0.02))
    assert b.pull(N) is None


def test_lag_is_dropped_back_to_prime():
    b = Background()
    b.push(tone(0.3))
    b.push(tone(0.3))                 # 0.6 s queued > MAX_LAG
    assert len(b._q) == int(Background.PRIME * OUT_RATE)


def test_ducking_ramps_down_fast_and_up_slowly():
    b = Background()

    def play(callbacks):   # a stream arriving as fast as it plays
        for _ in range(callbacks):
            b.push(tone(0.02, 1.0))
            out = b.pull(N)
        return out
    b.push(tone(0.08, 1.0))
    play(1)
    b.target = 0.2
    out = play(int(Background.DUCK_DOWN * 50) + 1)   # DUCK_DOWN seconds of callbacks
    assert b.gain == pytest.approx(0.2)
    assert np.allclose(out[-1], 0.2)
    b.target = 1.0
    play(25)                                         # half a second
    assert b.gain == pytest.approx(0.7, abs=0.01)   # up at 1/DUCK_UP per second: +0.5 in half a second
    b.target = 0.0
    out = play(50)
    assert b.gain == 0.0 and not out.any()


def test_clear_drops_everything():
    b = Background()
    b.push(tone(0.2))
    b.pull(N)
    b.clear()
    assert b.pull(N) is None


# ---- what the client sets the background to ----

def make_client():
    c = test_barge_in.make_client()
    c.ring = None
    c.preview = None
    c.audio.background = Background()
    return c


def test_target_follows_the_conversation_and_alarms():
    c = make_client()
    assert c.background_target() == 1.0
    c.state = 'listening'
    assert c.background_target() == test_barge_in.app.BACKGROUND_DUCKED
    c.state = 'idle'
    c.audio.player.push(tone(0.5))   # a chime
    assert c.background_target() == test_barge_in.app.BACKGROUND_DUCKED
    c.audio.player.trim(0)
    c.audio.player.pull(OUT_RATE)
    assert c.background_target() == 1.0
    c.ring = {'items': []}
    assert c.background_target() == 0.0
    c.ring = None


class FakeTask:
    def __init__(self, done):
        self._done = done

    def done(self):
        return self._done


def test_a_tone_preview_mutes_only_while_it_plays():
    # it stays in c.preview after playing to its end: the phone's music must come back then
    c = make_client()
    c.preview = FakeTask(done=False)
    assert c.background_target() == 0.0
    c.preview = FakeTask(done=True)
    assert c.background_target() == 1.0


class FakeBt:
    def __init__(self, streaming=True):
        self.paused = 0
        self._streaming = streaming

    def streaming(self):
        return {'name': 'phone'} if self._streaming else None

    async def pause(self):
        self.paused += 1


@pytest.mark.asyncio
async def test_a_ring_pauses_the_phone_once():
    c = make_client()
    c.bt = FakeBt()
    task = asyncio.create_task(c._bluetooth_loop())
    await asyncio.sleep(0.25)
    assert c.bt.paused == 0 and c.audio.background.target == 1.0
    c.ring = {'items': []}
    await asyncio.sleep(0.35)
    assert c.bt.paused == 1 and c.audio.background.target == 0.0
    c.ring = None
    await asyncio.sleep(0.15)
    assert c.audio.background.target == 1.0
    c.ring = {'items': []}           # another ring: asked again
    await asyncio.sleep(0.25)
    assert c.bt.paused == 2
    task.cancel()


@pytest.mark.asyncio
async def test_page_controls_are_stored(monkeypatch):
    c = make_client()
    calls, saved = [], {}

    class B:
        async def set_enabled(self, on):
            calls.append(('enabled', on)); return True

        async def open_window(self, on):
            calls.append(('window', on)); return True

        async def remove(self, a):
            calls.append(('remove', a)); return True

        async def disconnect(self, a):
            calls.append(('disconnect', a)); return True
    c.bt = B()
    monkeypatch.setattr(test_barge_in.app.config, 'save', lambda **kv: saved.update(kv))
    assert await c.bluetooth(enabled=False)
    assert await c.bluetooth(window=True)
    assert await c.bluetooth(remove='AA:BB')
    assert calls == [('enabled', False), ('window', True), ('remove', 'AA:BB')]
    assert saved == {'bluetooth': False}


# ---- the phone's source ----

SOURCES = ('53\talsa_output.platform-c051000.sound-card.HiFi__Speaker__sink.monitor\tPipeWire\ts16le 2ch 48000Hz\tRUNNING\n'
           '70\tbluez_input.AA_BB_CC_DD_EE_01.2\tPipeWire\ts16le 2ch 48000Hz\tSUSPENDED\n')


def test_source_for():
    assert bt.source_for(SOURCES, 'AA:BB:CC:DD:EE:01') == 'bluez_input.AA_BB_CC_DD_EE_01.2'
    assert bt.source_for(SOURCES, 'AA:BB:CC:DD:EE:02') is None


def phone(streaming=False, address='AA:BB:CC:DD:EE:01'):
    return {'address': address, 'name': 'phone', 'paired': True, 'connected': True, 'streaming': streaming}


@pytest.mark.asyncio
async def test_records_the_streaming_phone_until_its_source_goes(monkeypatch):
    b = bt.Bluetooth(Background(), lambda *a: None)
    started, stopped, pactl = [], [], []

    async def fake_run(*cmd):
        pactl.append(cmd)
        return SOURCES

    async def fake_start(address, source):
        started.append(source)
        b.capture = (address, source, types.SimpleNamespace(returncode=None), None)

    async def fake_stop():
        stopped.append(b.capture[1])
        b.capture = None
    monkeypatch.setattr(bt, '_run', fake_run)
    monkeypatch.setattr(b, '_start_capture', fake_start)
    monkeypatch.setattr(b, '_stop_capture', fake_stop)
    b.state = {'devices': [phone()]}
    await b._check_capture()          # connected, not streaming: no source to look for
    assert not started and not pactl
    b.state = {'devices': [phone(streaming=True)]}
    await b._check_capture()
    assert started == ['bluez_input.AA_BB_CC_DD_EE_01.2']
    await b._check_capture()          # already recording it: no more lookups
    assert len(started) == 1 and len(pactl) == 1
    b.capture[2].returncode = 1       # paused: the source went away, pw-record exited
    b.state = {'devices': [phone()]}
    await b._check_capture()
    assert stopped == ['bluez_input.AA_BB_CC_DD_EE_01.2'] and b.capture is None
    b.state = {'devices': [phone(streaming=True)]}   # played again: a new source, recorded again
    await b._check_capture()
    assert len(started) == 2
    b.state = {'devices': []}         # gone
    await b._check_capture()
    assert len(stopped) == 2 and not b.direct


@pytest.mark.asyncio
async def test_no_source_while_streaming_means_old_system_layer(monkeypatch):
    b = bt.Bluetooth(Background(), lambda *a: None)
    now = [100.0]

    async def fake_run(*cmd):
        return SOURCES.splitlines()[0]   # only the speaker's monitor: the phone went straight to the speaker
    monkeypatch.setattr(bt, '_run', fake_run)
    monkeypatch.setattr(bt.time, 'monotonic', lambda: now[0])
    b.state = {'devices': [phone(streaming=True)]}
    await b._check_capture()
    assert not b.direct
    now[0] += bt.DIRECT_AFTER + 1
    await b._check_capture()
    assert b.direct and b.view()['direct']
