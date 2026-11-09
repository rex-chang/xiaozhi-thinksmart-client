"""Microphone and speaker.

Both go through PipeWire's ALSA plugin ("default"): opening the hardware PCMs directly
breaks this device's audio DSP until reboot, which is why the service runs with
PrivateDevices=yes. Both streams use latency="high": with "low" the capture callback
overflows now and then, the microphone falls behind the speaker reference and echo
cancellation stops working.

Capture: 16 kHz mono in 20 ms blocks. The callback only queues; a worker thread runs echo
cancellation and hands each cleaned block to on_block (wake word, upload, level meter).
Playback: 48 kHz stereo from a buffer; everything that is played (replies and local
sounds) is also what echo cancellation subtracts. Background sound (a phone playing through
Bluetooth, bt.py) is added to it in the same callback, with its own gain (lowered during a
conversation): the canceller subtracts it too, so the wake word still works while music plays.

If PipeWire restarts, the streams stop (or hang) and their callbacks no longer run while the process
lives on: no wake word ever again. stalled() notices it and the client exits for systemd to restart it.

on_block gets two versions of each block: for uploading (WebRTC's full canceller) and for the wake
word, which while something plays gets the linear-only canceller's output instead (aec.py): the full
one suppresses too much of a voice talking over the reply to interrupt it.
"""
import logging
import queue
import threading
import time
import wave

import numpy as np
import sounddevice as sd
import soxr

from .aec import Aec

log = logging.getLogger(__name__)

MIC_RATE = 16000
BLOCK = 320          # 20 ms at 16 kHz
OUT_RATE = 48000
OUT_BLOCK = 960      # 20 ms at 48 kHz
# after the last sound played, the wake word keeps the linear canceller this long (latency + room echo)
LINEAR_AFTER = 0.5
FADE = 240           # 5 ms: fade out where sound is cut off mid-wave, fade in where it resumes
CUT_LEVEL = 0.01     # a buffer that runs dry above this level was cut off, not at the end of a word
# Replies arrive at about the speed they play (the hub paces them; it sends ~0.3 s ahead), so the
# buffer holds a second or two. Far more means the speaker callback stopped running: drop what comes.
MAX_BUFFER = 60      # seconds
# The mic delivers a block every 20 ms (zeros while the mic switch is off) and the speaker callback
# runs every 20 ms (silence when idle); nothing for this long means the stream is dead.
STALL = 5            # seconds


def _ramp(k):
    """k gains rising from just above 0 to 1 (reversed: falling from 1 to just above 0)."""
    return np.linspace(0, 1, k + 1, dtype=np.float32)[1:, None]


class Player:
    """Thread-safe playback buffer of 48 kHz stereo float32.

    Wherever the sound is cut off mid-wave (the buffer runs dry before the reply has really ended,
    or trim() drops the rest on an interruption) the last few milliseconds are faded out, and audio
    that resumes after such a cut is faded in: a waveform that jumps to zero clicks.
    """

    def __init__(self):
        self._lock = threading.Lock()
        self._chunks = []
        self._pos = 0
        self.level = 0.0
        self.last_sound = 0.0   # monotonic time something was last played
        self.ran_out = []       # |last sample| each time the buffer ran dry while sound was playing
        self.late = []          # PortAudio's flags when the speaker callback ran late (output underflow)
        self._sounding = False
        self._tail = 0.0        # |last sample| played
        self._fade_in = False
        self._size = 0          # samples in _chunks
        self.dropped = 0        # samples refused by push() (buffer full)

    def push(self, stereo):
        """Queue sound; refused while MAX_BUFFER seconds are already queued. The newest is dropped,
        not the oldest: the oldest is what is playing (cutting it would click), and if the speaker
        stopped nothing is heard either way (Audio.stalled() restarts the client)."""
        with self._lock:
            if self._size - self._pos >= MAX_BUFFER * OUT_RATE:
                if not self.dropped:
                    log.warning('playback buffer full (%d s queued): dropping sound', MAX_BUFFER)
                self.dropped += len(stereo)
                return
            self.dropped = 0
            self._chunks.append(stereo)
            self._size += len(stereo)

    def pull(self, n):
        out = np.zeros((n, 2), dtype=np.float32)
        got = 0
        with self._lock:
            while got < n and self._chunks:
                chunk = self._chunks[0]
                take = min(n - got, len(chunk) - self._pos)
                out[got:got + take] = chunk[self._pos:self._pos + take]
                got += take
                self._pos += take
                if self._pos >= len(chunk):
                    self._chunks.pop(0)
                    self._size -= len(chunk)
                    self._pos = 0
        if got and self._fade_in:
            k = min(FADE, got)
            out[:k] *= _ramp(k)
            self._fade_in = False
        if got < n and (got or self._sounding):
            tail = float(np.abs(out[got - 1]).max()) if got else self._tail
            self.ran_out.append(tail)
            if tail > CUT_LEVEL:
                if got:
                    k = min(FADE, got)
                    out[got - k:got] *= _ramp(k)[::-1]
                self._fade_in = True
        self._tail = float(np.abs(out[n - 1]).max())
        self._sounding = got == n
        self.level = float(np.sqrt(np.mean(out[:got] ** 2))) if got else 0.0
        if got:
            self.last_sound = time.monotonic()
        return out

    def buffered(self):
        """Seconds of audio still queued."""
        with self._lock:
            return (self._size - self._pos) / OUT_RATE

    def trim(self, keep_seconds):
        """Drop everything beyond keep_seconds (0 clears), fading out where it is cut."""
        keep = max(int(keep_seconds * OUT_RATE), FADE)
        with self._lock:
            kept, total = [], -self._pos
            for c in self._chunks:
                if total >= keep:
                    break
                kept.append(c)
                total += len(c)
            if total <= keep and len(kept) == len(self._chunks):
                return   # nothing beyond keep_seconds
            # (total == keep with chunks after it: what is left of an earlier cut, then new sound to drop)
            kept[-1] = kept[-1][:len(kept[-1]) - (total - keep)]
            # fade out the last FADE samples of what is kept (they may span the ends of two chunks)
            down, left = _ramp(FADE)[::-1], FADE
            for i in range(len(kept) - 1, -1, -1):
                k = min(left, len(kept[i]) - (self._pos if i == 0 else 0))
                kept[i] = kept[i].copy()
                kept[i][len(kept[i]) - k:] *= down[left - k:left]
                left -= k
                if not left:
                    break
            self._chunks = kept
            self._size = sum(len(c) for c in kept)


class Background:
    """Sound from outside that plays under the replies (a phone over Bluetooth): 48 kHz stereo
    float32 pushed as it arrives (from another clock), pulled by the speaker callback.

    Its own gain follows `target` smoothly (down in DUCK_DOWN s, up in DUCK_UP s): the client lowers
    it during a conversation and mutes it while an alarm rings. The queue is kept short: it starts
    once PRIME is queued and, because the phone's clock and the speaker's drift apart, drops back to
    PRIME whenever more than MAX_LAG has piled up. Running dry fades out; what follows fades in.
    """
    PRIME = 0.08     # seconds queued before playing (and after running dry)
    MAX_LAG = 0.4    # more than this queued: drop the oldest down to PRIME
    DUCK_DOWN = 0.3
    DUCK_UP = 1.0
    SILENT = 1e-4    # |sample| below this doesn't count as sound (for the echo canceller's timing)

    def __init__(self):
        self._lock = threading.Lock()
        self._q = np.zeros((0, 2), dtype=np.float32)
        self._primed = False
        self.gain = 1.0
        self.target = 1.0
        self.last_sound = 0.0   # monotonic: something audible was last played
        self.level = 0.0

    def push(self, stereo):
        with self._lock:
            self._q = np.concatenate([self._q, stereo]) if len(self._q) else stereo
            if len(self._q) > self.MAX_LAG * OUT_RATE:
                self._q = self._q[len(self._q) - int(self.PRIME * OUT_RATE):]

    def clear(self):
        with self._lock:
            self._q = np.zeros((0, 2), dtype=np.float32)
            self._primed = False

    def pull(self, n):
        """n frames to add to the speaker's, or None when there is nothing to add."""
        with self._lock:
            if not self._primed and len(self._q) < self.PRIME * OUT_RATE:
                self.level = 0.0
                return None
            self._primed = True
            out = self._q[:n]
            self._q = self._q[n:]
            if len(out) < n:   # ran dry: fade out what there is, play silence, prime again
                self._primed = False
                k = min(FADE, len(out))
                out = np.concatenate([out[:len(out) - k], out[len(out) - k:] * _ramp(k)[::-1],
                                      np.zeros((n - len(out), 2), dtype=np.float32)])
        # gain ramp towards the target, per sample
        step = 1.0 / ((self.DUCK_DOWN if self.target < self.gain else self.DUCK_UP) * OUT_RATE)
        end = self.gain + max(-step * n, min(step * n, self.target - self.gain))
        g = np.linspace(self.gain, end, n, dtype=np.float32)[:, None]
        self.gain = float(end)
        out = out * g
        peak = float(np.abs(out).max())
        self.level = float(np.sqrt(np.mean(out ** 2)))
        if peak > self.SILENT:
            self.last_sound = time.monotonic()
        return out


class Audio:
    def __init__(self, on_block):
        self.on_block = on_block          # called on the worker thread: on_block(block, wake_block), 20 ms
        self.player = Player()
        self.background = Background()
        self.aec = Aec(MIC_RATE, OUT_RATE)
        self.mic_level = 0.0
        # Echo cancellation costs ~21% of a core, so it runs only during a conversation
        # (set by the client) or while something was played in the last few seconds. The
        # canceller keeps what it learned about the room in between.
        self.aec_hold = False
        self._echo = np.zeros(4)   # while playing: energy of mic, full canceller, linear one; blocks
        self._q = queue.Queue(maxsize=200)
        self._streams = []
        self.last_in = self.last_out = 0.0   # monotonic: last mic block handled, last speaker callback

    def start(self):
        self.last_in = self.last_out = time.monotonic()
        threading.Thread(target=self._work, name='mic', daemon=True).start()
        self._streams = [
            sd.InputStream(samplerate=MIC_RATE, channels=1, dtype='float32', blocksize=BLOCK,
                           latency='high', callback=self._in_cb),
            sd.OutputStream(samplerate=OUT_RATE, channels=2, dtype='float32', blocksize=OUT_BLOCK,
                            latency='high', callback=self._out_cb),
        ]
        for s in self._streams:
            s.start()

    def _in_cb(self, indata, _frames, _time, status):
        if status:
            log.warning('mic: %s', status)
        try:
            self._q.put_nowait(indata[:, 0].copy())
        except queue.Full:
            pass

    def _out_cb(self, outdata, frames, _time, status):
        self.last_out = time.monotonic()
        if status and len(self.player.late) < 100:
            self.player.late.append(str(status))
        out = self.player.pull(frames)
        bg = self.background.pull(frames)
        if bg is not None:
            out = np.clip(out + bg, -1.0, 1.0)
        outdata[:] = out
        self.aec.feed_far(outdata)

    def _work(self):
        while True:
            block = raw = self._q.get()
            self.last_in = time.monotonic()
            wake_block = None
            since_sound = time.monotonic() - max(self.player.last_sound, self.background.last_sound)
            if self.aec_hold or since_sound < 3:
                try:
                    block = self.aec.process_near(block)
                    if since_sound < LINEAR_AFTER:
                        wake_block = self.aec.linear
                        self._echo += (np.mean(raw ** 2), np.mean(block ** 2), np.mean(wake_block ** 2), 1)
                except Exception:
                    log.exception('echo cancellation failed')
            else:
                self.aec.skip_far()
            self.mic_level = float(np.sqrt(np.mean(block ** 2)))
            try:
                self.on_block(block, block if wake_block is None else wake_block)
            except Exception:
                log.exception('mic block handler failed')


    def stalled(self):
        """Why the audio is dead (a stream stopped, or no mic block / speaker callback for STALL
        seconds), or None. The mic time is taken on the worker thread: a hung worker is as deaf."""
        if not self._streams:
            return None
        now = time.monotonic()
        if not all(s.active for s in self._streams):
            return 'stream stopped'
        if now - self.last_in > STALL:
            return f'no microphone block for {now - self.last_in:.0f} s'
        if now - self.last_out > STALL:
            return f'no speaker callback for {now - self.last_out:.0f} s'
        return None

    def take_echo_levels(self):
        """dBFS at the mic while something played since the last call: raw, after the full canceller,
        after the linear one (what the wake word heard). For the log: how well the echo was removed."""
        e, self._echo = self._echo, np.zeros(4)
        if not e[3]:
            return None
        return tuple(round(10 * np.log10(max(v / e[3], 1e-12)), 1) for v in e[:3])


def load_wav(path, gain=1.0):
    """A local sound (chime, short replies, a reminder's words; a path or a file object) as 48 kHz stereo float32."""
    with wave.open(path if hasattr(path, 'read') else str(path)) as w:
        rate, ch, width = w.getframerate(), w.getnchannels(), w.getsampwidth()
        raw = w.readframes(w.getnframes())
    dtype = {2: np.int16, 4: np.int32}[width]
    x = np.frombuffer(raw, dtype=dtype).astype(np.float32) / float(np.iinfo(dtype).max)
    x = x.reshape(-1, ch).mean(axis=1)
    if rate != OUT_RATE:
        x = soxr.resample(x, rate, OUT_RATE)
    return np.repeat((x * gain)[:, None], 2, axis=1).astype(np.float32)
