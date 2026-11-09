"""Settings: DEFAULTS, overridden by ~/.config/thinksmart-client/config.json.

The file holds only what belongs to this device or its user (ids, settings changed on the page or
by voice), never copies of the defaults, so a client update can change a default."""
import json
import logging
import pathlib
import uuid

log = logging.getLogger(__name__)

PATH = pathlib.Path.home() / '.config' / 'thinksmart-client' / 'config.json'

DEFAULTS = {
    'hub_ws': 'ws://127.0.0.1:16689/xiaozhi/v1/',
    'hub_http': 'http://127.0.0.1:16688',
    'token': 'test-token',
    'device_id': '',      # filled from the Wi-Fi MAC; the hub remembers the model per device id
    'client_id': '',
    # sherpa-onnx keywords: pinyin initials/finals with tones, then @label
    # 2026-10-31: renamed 小二 -> 小麦. Tested with 10 edge-tts voices x 3 speeds: 小麦小麦 and
    # 哈喽小麦 30/30 each, no false wakes on 20 confusable sentences x 10 voices (小麦色, 小卖部,
    # 晓梅...). 小麦 alone woke on nearly every sentence containing it. 小麦同学 added the same day:
    # 30/30, the other two unchanged, 1/10 false wake on 小美同学. 你好小麦 left out: 你好小妹 woke it
    # 8-9/10 at any threshold (the model can't tell 麦 from 妹 there).
    'wake_words': ['x iǎo m ài x iǎo m ài @小麦小麦', 'h ā l óu x iǎo m ài @哈喽小麦',
                   'x iǎo m ài t óng x ué @小麦同学'],
    'kws_score': 2.0,
    'kws_threshold': 0.25,
    # beam width: with 2 a keyword easily loses its path before it is finished (哈喽阿满 woke only
    # 6/30, 你好小二 25/30 instead of 30/30); 8 costs ~6% more decoding CPU, only while there is sound
    'kws_paths': 8,
    # digital gain in front of the wake word model (not its quiet gate): it misses more at low
    # levels; with 10 dB eval/wake missed 15% -> 7% at -30 dBFS, 39% -> 32% across the room
    'kws_gain_db': 10,
    # second look at each wake word hit (wake_verify.py): 'hub' asks the hub's speech recogniser
    # whether the wake word is really there, '' trusts the wake word model. Off for now: the hub
    # takes 2-2.5 s here, which delays the answer to "小麦小麦今天天气怎么样" said in one go by ~4 s
    'wake_verify': '',
    'follow_up_seconds': 10,   # after a reply: keep listening this long for a follow-up
    'port': 8090,
    'sleep': {'enabled': False, 'start': '22:00', 'end': '07:00'},   # sleep.py
    'brightness': 100,    # the screen's 0-100, set on the page or by voice (no automatic brightness: the user asked)
    # blank this long after the last touch or conversation (device.SCREEN_OFF_MINUTES); off: never
    'screen_off': {'enabled': True, 'minutes': 5},
    'alarm_volume': 70,   # countdowns, alarms and reminders ring at this, whatever the device volume (alarms.py)
    'alarm_tone': 'coffee',   # alarms.TONES
    'bluetooth': True,    # the Bluetooth speaker switch (bt.py): off powers the adapter down
}


def _mac():
    for iface in ('wlan0', 'eth0', 'end0'):
        try:
            return pathlib.Path(f'/sys/class/net/{iface}/address').read_text().strip()
        except OSError:
            continue
    return ''


def load():
    cfg = dict(DEFAULTS)
    try:
        cfg.update(json.loads(PATH.read_text()))
    except FileNotFoundError:
        pass
    except ValueError:
        log.error('%s is not valid JSON, using defaults', PATH)
    changed = False
    if not cfg['device_id']:
        cfg['device_id'], changed = _mac() or uuid.uuid4().hex[:12], True
    if not cfg['client_id']:
        cfg['client_id'], changed = str(uuid.uuid4()), True
    if changed:
        save(device_id=cfg['device_id'], client_id=cfg['client_id'])
    return cfg


def save(**values):
    """Store these keys in the user file, keeping whatever else it has."""
    try:
        data = json.loads(PATH.read_text())
    except (FileNotFoundError, ValueError):
        data = {}
    data.update(values)
    PATH.parent.mkdir(parents=True, exist_ok=True)
    tmp = PATH.with_suffix('.tmp')
    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=2))
    tmp.replace(PATH)
