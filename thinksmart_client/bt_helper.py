#!/usr/bin/python3
"""BlueZ for the Bluetooth speaker, run by bt.py as a child process with the SYSTEM python3.

It uses the system's dbus-python and GLib (python3-dbus, python3-gi: part of the image), so the
client's own environment needs no D-Bus library (a new dependency would make every device download
a new environment package with the next update). It talks JSON lines: commands on stdin, the state
on stdout whenever it changes.

What it does:
- registers the pairing agent: no input, no output ("Just Works"). Pairing is accepted only while
  the user has opened the "add a phone" window (adapter Pairable, at most WINDOW seconds); a phone
  that paired is trusted, so it reconnects later without the window and without asking.
- the window itself: discoverable + pairable, closed by us when it runs out or a phone paired;
- the on/off switch (adapter Powered), forgetting and disconnecting a phone, pausing the phones
  (AVRCP) when an alarm rings;
- the state: adapter, phones (paired or connected), which one streams and its track.

Commands: {"cmd": "power", "on": bool}, {"cmd": "window", "seconds": n} (0 closes it),
{"cmd": "remove", "address": "..."}, {"cmd": "disconnect", "address": "..."}, {"cmd": "pause"}.
State: {"available": bool, "powered": bool, "window": seconds left or 0, "name": str,
"devices": [{"address", "name", "paired", "connected", "streaming", "title", "artist"}]}.
Errors: {"error": "..."}.
"""
import json
import sys
import threading
import time

import dbus
import dbus.mainloop.glib
import dbus.service
from gi.repository import GLib

BUS = 'org.bluez'
AGENT_PATH = '/thinksmart/agent'
WINDOW = 180          # seconds the "add a phone" window stays open at most
NAME = 'ThinkSmart View'
ADAPTER = 'org.bluez.Adapter1'
DEVICE = 'org.bluez.Device1'
TRANSPORT = 'org.bluez.MediaTransport1'
PLAYER = 'org.bluez.MediaPlayer1'
PROPS = 'org.freedesktop.DBus.Properties'
A2DP_SOURCE = '0000110a-0000-1000-8000-00805f9b34fb'   # the phone's side of the music stream
AUDIO_AFTER = 3       # seconds after a phone connects: no music channel yet, open it from our side


def out(obj):
    sys.stdout.write(json.dumps(obj, ensure_ascii=False) + '\n')
    sys.stdout.flush()


class Rejected(dbus.DBusException):
    _dbus_error_name = 'org.bluez.Error.Rejected'


class Agent(dbus.service.Object):
    """Just Works pairing, only while the window is open; services only for paired phones."""

    def __init__(self, bus, helper):
        super().__init__(bus, AGENT_PATH)
        self.helper = helper

    def _allow(self, device):
        if not self.helper.window_open():
            raise Rejected('not pairable now')

    @dbus.service.method('org.bluez.Agent1', in_signature='', out_signature='')
    def Release(self):
        pass

    @dbus.service.method('org.bluez.Agent1', in_signature='os', out_signature='')
    def AuthorizeService(self, device, uuid):
        # a phone connecting audio: fine once it is paired (trusted ones never ask)
        props = self.helper.props(device, DEVICE)
        if not props.get('Paired'):
            raise Rejected('not paired')
        self.helper.trust(device)

    @dbus.service.method('org.bluez.Agent1', in_signature='o', out_signature='s')
    def RequestPinCode(self, device):
        self._allow(device)
        return '0000'   # old phones without secure simple pairing

    @dbus.service.method('org.bluez.Agent1', in_signature='o', out_signature='u')
    def RequestPasskey(self, device):
        self._allow(device)
        return dbus.UInt32(0)

    @dbus.service.method('org.bluez.Agent1', in_signature='ouq', out_signature='')
    def DisplayPasskey(self, device, passkey, entered):
        pass

    @dbus.service.method('org.bluez.Agent1', in_signature='os', out_signature='')
    def DisplayPinCode(self, device, pincode):
        pass

    @dbus.service.method('org.bluez.Agent1', in_signature='ou', out_signature='')
    def RequestConfirmation(self, device, passkey):
        self._allow(device)

    @dbus.service.method('org.bluez.Agent1', in_signature='o', out_signature='')
    def RequestAuthorization(self, device):
        self._allow(device)

    @dbus.service.method('org.bluez.Agent1', in_signature='', out_signature='')
    def Cancel(self):
        pass


class Helper:
    def __init__(self):
        dbus.mainloop.glib.DBusGMainLoop(set_as_default=True)
        self.bus = dbus.SystemBus()
        self.loop = GLib.MainLoop()
        self.adapter = None           # object path of hci0
        self.window_until = 0.0       # monotonic: the "add a phone" window closes then
        self.window_timer = None
        self.pending = None           # GLib source id of the coalesced state report
        self.last = None
        self.agent = Agent(self.bus, self)
        self.registered = False

    # ---- D-Bus helpers ----

    def objects(self):
        om = dbus.Interface(self.bus.get_object(BUS, '/'), 'org.freedesktop.DBus.ObjectManager')
        return om.GetManagedObjects()

    def props(self, path, iface):
        try:
            return dbus.Interface(self.bus.get_object(BUS, path), PROPS).GetAll(iface)
        except dbus.DBusException:
            return {}

    def set_prop(self, path, iface, name, value):
        dbus.Interface(self.bus.get_object(BUS, path), PROPS).Set(iface, name, value)

    def trust(self, device):
        try:
            if not self.props(device, DEVICE).get('Trusted'):
                self.set_prop(device, DEVICE, 'Trusted', dbus.Boolean(True))
        except dbus.DBusException as e:
            out({'error': f'trust: {e}'})

    def find_adapter(self):
        for path, ifaces in self.objects().items():
            if ADAPTER in ifaces:
                return str(path)
        return None

    def device_path(self, address):
        for path, ifaces in self.objects().items():
            if DEVICE in ifaces and str(ifaces[DEVICE].get('Address')) == address:
                return str(path)
        return None

    # ---- setup ----

    def setup(self):
        """Find the adapter, register the agent, close any window a previous run left open."""
        self.adapter = self.find_adapter()
        if not self.adapter:
            return
        if not self.registered:
            try:
                mgr = dbus.Interface(self.bus.get_object(BUS, '/org/bluez'), 'org.bluez.AgentManager1')
                mgr.RegisterAgent(AGENT_PATH, 'NoInputNoOutput')
                mgr.RequestDefaultAgent(AGENT_PATH)
                self.registered = True
            except dbus.DBusException as e:
                out({'error': f'agent: {e}'})
        try:
            a = self.props(self.adapter, ADAPTER)
            if a.get('Alias') in (None, '', a.get('Name')):
                self.set_prop(self.adapter, ADAPTER, 'Alias', dbus.String(NAME))
            if not self.window_open():
                self.close_window()
        except dbus.DBusException as e:
            out({'error': f'adapter: {e}'})

    # ---- the "add a phone" window ----

    def window_open(self):
        return time.monotonic() < self.window_until

    def open_window(self, seconds):
        seconds = max(1, min(WINDOW, int(seconds)))
        self.set_prop(self.adapter, ADAPTER, 'Powered', dbus.Boolean(True))
        self.set_prop(self.adapter, ADAPTER, 'PairableTimeout', dbus.UInt32(seconds))
        self.set_prop(self.adapter, ADAPTER, 'DiscoverableTimeout', dbus.UInt32(seconds))
        self.set_prop(self.adapter, ADAPTER, 'Pairable', dbus.Boolean(True))
        self.set_prop(self.adapter, ADAPTER, 'Discoverable', dbus.Boolean(True))
        self.window_until = time.monotonic() + seconds
        if self.window_timer:
            GLib.source_remove(self.window_timer)
        self.window_timer = GLib.timeout_add_seconds(seconds, self._window_over)

    def _window_over(self):
        self.window_timer = None
        self.close_window()
        return False

    def close_window(self):
        self.window_until = 0.0
        if self.window_timer:
            GLib.source_remove(self.window_timer)
            self.window_timer = None
        for name in ('Discoverable', 'Pairable'):
            try:
                self.set_prop(self.adapter, ADAPTER, name, dbus.Boolean(False))
            except dbus.DBusException:
                pass   # powered off: nothing to close
        self.report()

    # ---- commands ----

    def command(self, msg):
        cmd = msg.get('cmd')
        try:
            if not self.adapter:
                self.setup()
            if not self.adapter:
                raise RuntimeError('no Bluetooth adapter')
            if cmd == 'power':
                if not msg.get('on'):
                    self.close_window()
                self.set_prop(self.adapter, ADAPTER, 'Powered', dbus.Boolean(bool(msg.get('on'))))
            elif cmd == 'window':
                if msg.get('seconds'):
                    self.open_window(msg['seconds'])
                else:
                    self.close_window()
            elif cmd in ('remove', 'disconnect'):
                path = self.device_path(str(msg.get('address', '')))
                if path and cmd == 'remove':
                    dbus.Interface(self.bus.get_object(BUS, self.adapter), ADAPTER).RemoveDevice(path)
                elif path:
                    dbus.Interface(self.bus.get_object(BUS, path), DEVICE).Disconnect()
            elif cmd == 'pause':
                for path, ifaces in self.objects().items():
                    if PLAYER in ifaces and ifaces[PLAYER].get('Status') == 'playing':
                        dbus.Interface(self.bus.get_object(BUS, path), PLAYER).Pause()
            else:
                raise RuntimeError(f'unknown command {cmd!r}')
        except (dbus.DBusException, RuntimeError) as e:
            out({'error': f'{cmd}: {e}'})
        self.report()

    def _stdin(self):
        for line in sys.stdin:
            try:
                msg = json.loads(line)
            except ValueError:
                continue
            GLib.idle_add(lambda m=msg: self.command(m) and False)
        GLib.idle_add(self.loop.quit)   # the client went away

    # ---- state ----

    def state(self):
        objs = self.objects()
        adapter = next((p for p, i in objs.items() if ADAPTER in i), None)
        if adapter is None:
            return {'available': False, 'powered': False, 'window': 0, 'name': '', 'devices': []}
        a = objs[adapter][ADAPTER]
        streaming, players = set(), {}
        for path, ifaces in objs.items():
            # pending: the phone is starting (its source is being made): count it, it must be recorded now
            if TRANSPORT in ifaces and ifaces[TRANSPORT].get('State') in ('pending', 'active'):
                streaming.add(str(ifaces[TRANSPORT].get('Device')))
            if PLAYER in ifaces:
                players[str(ifaces[PLAYER].get('Device'))] = ifaces[PLAYER]
        devices = []
        for path, ifaces in objs.items():
            d = ifaces.get(DEVICE)
            if not d or not (d.get('Paired') or d.get('Connected')):
                continue
            track = players.get(str(path), {}).get('Track', {})
            devices.append({'address': str(d.get('Address')), 'name': str(d.get('Alias') or d.get('Name') or d.get('Address')),
                            'paired': bool(d.get('Paired')), 'connected': bool(d.get('Connected')),
                            'streaming': str(path) in streaming,
                            'playing': players.get(str(path), {}).get('Status') == 'playing',
                            'title': str(track.get('Title', '')), 'artist': str(track.get('Artist', ''))})
        devices.sort(key=lambda d: (not d['connected'], d['name']))
        left = max(0, round(self.window_until - time.monotonic())) if a.get('Discoverable') else 0
        return {'available': True, 'powered': bool(a.get('Powered')), 'window': left,
                'name': str(a.get('Alias') or ''), 'devices': devices}

    def report(self):
        """Send the state soon (changes come in bursts: one report for all of them)."""
        if self.pending is None:
            self.pending = GLib.timeout_add(150, self._report_now)

    def _report_now(self):
        self.pending = None
        try:
            st = self.state()
        except dbus.DBusException as e:
            st = {'available': False, 'powered': False, 'window': 0, 'name': '', 'devices': [], 'error': str(e)}
        if st != self.last:
            self.last = st
            out({'state': st})
        return False

    def _changed(self, iface, changed, _invalidated, path=None):
        if iface == DEVICE and changed.get('Paired') and path:
            # a phone just paired in the window: trust it (reconnects later) and close the window
            self.trust(path)
            GLib.timeout_add_seconds(2, lambda: self.close_window() and False)
        if iface == DEVICE and changed.get('Connected') and path:
            GLib.timeout_add_seconds(AUDIO_AFTER, lambda p=str(path): self.ensure_audio(p) and False)
        self.report()

    def ensure_audio(self, path):
        """A phone that connected (right after pairing, often) without opening the music channel: the
        iPhone then plays on its own speaker, or keeps showing this device with no sound. Open it."""
        d = self.props(path, DEVICE)
        if not (d.get('Connected') and d.get('Paired')) or A2DP_SOURCE not in [str(u) for u in d.get('UUIDs', [])]:
            return
        if any(str(p).startswith(path + '/') and TRANSPORT in i for p, i in self.objects().items()):
            return
        dbus.Interface(self.bus.get_object(BUS, path), DEVICE).ConnectProfile(
            A2DP_SOURCE, reply_handler=lambda: None,
            error_handler=lambda e: out({'error': f'audio channel to {path}: {e}'}))

    def _added(self, path, ifaces):
        if ADAPTER in ifaces:
            GLib.idle_add(lambda: self.setup() and False)
        self.report()

    def _owner(self, _name, _old, new):
        # bluetoothd restarted: our agent registration went with it
        if new:
            self.registered = False
            self.adapter = None
            GLib.timeout_add(500, lambda: self.setup() and False)
        self.report()

    def run(self):
        self.bus.add_signal_receiver(self._changed, signal_name='PropertiesChanged', dbus_interface=PROPS,
                                     bus_name=BUS, path_keyword='path')
        self.bus.add_signal_receiver(self._added, signal_name='InterfacesAdded',
                                     dbus_interface='org.freedesktop.DBus.ObjectManager', bus_name=BUS)
        self.bus.add_signal_receiver(lambda *_a: self.report(), signal_name='InterfacesRemoved',
                                     dbus_interface='org.freedesktop.DBus.ObjectManager', bus_name=BUS)
        self.bus.add_signal_receiver(self._owner, signal_name='NameOwnerChanged', dbus_interface='org.freedesktop.DBus',
                                     arg0=BUS)
        try:
            self.setup()
        except dbus.DBusException as e:
            out({'error': f'setup: {e}'})
        self.report()
        # the window's seconds left, while it is open
        GLib.timeout_add_seconds(1, lambda: (self.report() if self.window_open() else None) or True)
        threading.Thread(target=self._stdin, daemon=True).start()
        self.loop.run()


if __name__ == '__main__':
    Helper().run()
