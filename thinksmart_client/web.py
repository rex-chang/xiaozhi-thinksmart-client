"""The page the kiosk shows (127.0.0.1 only): static files, an event stream and button actions."""
import asyncio
import glob
import json
import logging
import os
import shutil
import subprocess
import time

from aiohttp import web

from . import __version__, update
from .app import ROOT, Client, local_ip

log = logging.getLogger(__name__)
WEB = ROOT / 'web'
# changes on every restart (every deploy restarts the client): the page reloads itself when it
# reconnects to a different run, so the kiosk never keeps running an old app.js
BUILD = str(int(time.time()))


def _read_meminfo():
    info = {}
    try:
        with open('/proc/meminfo') as f:
            for line in f:
                key, value = line.split(':', 1)
                info[key] = int(value.split()[0])
    except OSError:
        pass
    total = info.get('MemTotal', 0) // 1024
    avail = info.get('MemAvailable', 0) // 1024
    swap_total = info.get('SwapTotal', 0) // 1024
    swap_free = info.get('SwapFree', 0) // 1024
    return {'total_mb': total, 'used_mb': max(0, total - avail), 'available_mb': avail,
            'swap_total_mb': swap_total, 'swap_used_mb': max(0, swap_total - swap_free)}


def _cpu_snapshot():
    with open('/proc/stat') as f:
        parts = f.readline().split()
    values = [int(x) for x in parts[1:]]
    idle = values[3] + (values[4] if len(values) > 4 else 0)
    return idle, sum(values)


def _cpu_percent():
    try:
        a = _cpu_snapshot()
        time.sleep(0.35)
        b = _cpu_snapshot()
        total = b[1] - a[1]
        idle = b[0] - a[0]
        return round(100 * (total - idle) / total, 1) if total > 0 else None
    except (OSError, ValueError):
        return None


def _disk():
    try:
        usage = shutil.disk_usage('/')
        gb = 1024 ** 3
        return {'total_gb': round(usage.total / gb, 1), 'used_gb': round(usage.used / gb, 1),
                'free_gb': round(usage.free / gb, 1)}
    except OSError:
        return {}


def _temperature():
    values = []
    for path in glob.glob('/sys/class/thermal/thermal_zone*/temp'):
        try:
            with open(path) as f:
                values.append(int(f.read().strip()) / 1000)
        except (OSError, ValueError):
            pass
    return round(max(values), 1) if values else None


def _service(name, user=False):
    cmd = ['systemctl'] + (['--user'] if user else []) + ['is-active', name]
    try:
        return subprocess.run(cmd, capture_output=True, text=True, timeout=2).stdout.strip() or 'unknown'
    except (OSError, subprocess.SubprocessError):
        return 'unknown'


def _processes():
    try:
        out = subprocess.run(['ps', '-eo', 'pid,comm,rss', '--sort=-rss'],
                             capture_output=True, text=True, timeout=2).stdout
    except (OSError, subprocess.SubprocessError):
        return []
    rows = []
    for line in out.splitlines()[1:7]:
        parts = line.split(None, 2)
        if len(parts) == 3:
            rows.append({'pid': int(parts[0]), 'name': parts[1],
                         'rss_mb': round(int(parts[2]) / 1024, 1)})
    return rows


def _update_status():
    try:
        with open('/var/lib/thinksmart-update/status.json') as f:
            d = json.load(f)
        return {'current': d.get('current'), 'available': d.get('available'),
                'check_error': d.get('check_error')}
    except (OSError, ValueError):
        return None


def _collect_status(client):
    snap = client.snapshot()
    health = client.health()
    music = snap.get('music') or {}
    status = snap.get('status') or {}
    try:
        with open('/proc/loadavg') as f:
            load = [float(x) for x in f.read().split()[:3]]
    except (OSError, ValueError):
        load = []
    try:
        with open('/proc/uptime') as f:
            uptime = int(float(f.read().split()[0]))
    except (OSError, ValueError):
        uptime = 0
    music_view = None
    if music:
        music_view = {key: music.get(key) for key in
                      ('state', 'id', 'title', 'artists', 'position', 'duration', 'paused', 'queue', 'index')}
    return {
        'version': __version__,
        'uptime_s': uptime,
        'cpu': {'cores': os.cpu_count(), 'used_percent': _cpu_percent(), 'load': load},
        'memory': _read_meminfo(),
        'disk': _disk(),
        'temperature_c': _temperature(),
        'services': {
            'client': _service('thinksmart-client.service'),
            'kiosk': _service('thinksmart-kiosk.service'),
            'hub': _service('xiaozhi-hub.service', user=True),
        },
        'processes': _processes(),
        'client': {'state': status.get('state'), 'connected': status.get('connected'),
                   'audio': health.get('audio'), 'hub': health.get('hub')},
        'music': music_view,
        'update': _update_status(),
    }



def make_app(client: Client):
    app = web.Application()

    async def index(_request):
        # the second design (orb with a face) is the UI since 2026-10-31; /v1 keeps the first one
        return web.FileResponse(WEB / 'v2' / 'index.html', headers={'Cache-Control': 'no-cache'})

    async def index_v1(_request):
        return web.FileResponse(WEB / 'index.html', headers={'Cache-Control': 'no-cache'})

    async def events(request):
        resp = web.StreamResponse(headers={'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache'})
        await resp.prepare(request)
        q = asyncio.Queue()
        client.events.queues.add(q)
        try:
            q.put_nowait(('snapshot', {**client.snapshot(), 'build': BUILD, 'version': __version__,
                                       'update': update.read()}))
            while True:
                try:
                    event, data = await asyncio.wait_for(q.get(), timeout=15)
                    await resp.write(f'event: {event}\ndata: {json.dumps(data, ensure_ascii=False)}\n\n'.encode())
                except asyncio.TimeoutError:
                    await resp.write(b': keepalive\n\n')
        except (ConnectionResetError, asyncio.CancelledError):
            pass
        finally:
            client.events.queues.discard(q)
        return resp

    def action(coro_fn):
        async def handler(_request):
            asyncio.create_task(coro_fn())
            return web.json_response({'ok': True})
        return handler

    async def text(request):
        body = await request.json()
        asyncio.create_task(client.say(body.get('text', '')))
        return web.json_response({'ok': True})

    async def music(request):
        body = await request.json()
        asyncio.create_task(client.music_action(body.get('action', ''), body.get('value', '')))
        return web.json_response({'ok': True})

    async def netease_login_action(request):
        body = await request.json()
        action = body.get('action')
        if action not in ('refresh', 'cancel') or set(body) != {'action', 'task_id'}:
            return web.json_response({'ok': False, 'error': '请求无效'}, status=400)
        result = await client.netease_login_action(action, body.get('task_id'))
        return web.json_response(result, status=200 if result.get('ok') else 400)
    async def model(request):
        body = await request.json()
        return web.json_response(await client.set_model(body.get('kind'), body.get('vendor'), body.get('entry')))

    async def sleep_setting(request):
        body = await request.json()
        try:
            value = await client.set_sleep(**{k: body.get(k) for k in ('enabled', 'start', 'end')})
        except ValueError as e:
            return web.json_response({'ok': False, 'error': str(e)}, status=400)
        return web.json_response({'ok': True, 'sleep': value})

    async def brightness(request):
        body = await request.json()
        try:
            value = await client.set_brightness(body.get('level'))
        except (TypeError, ValueError) as e:
            return web.json_response({'ok': False, 'error': str(e)}, status=400)
        return web.json_response({'ok': True, 'brightness': value})

    async def screen_off(request):
        body = await request.json()
        try:
            value = await client.set_screen_off(**{k: body.get(k) for k in ('enabled', 'minutes')})
        except ValueError as e:
            return web.json_response({'ok': False, 'error': str(e)}, status=400)
        return web.json_response({'ok': True, 'screen_off': value})

    async def volume(request):
        body = await request.json()
        try:
            value = await client.set_volume(body.get('volume'))
        except (TypeError, ValueError) as e:
            return web.json_response({'ok': False, 'error': str(e)}, status=400)
        return web.json_response({'ok': True, 'volume': value})

    async def alarm_volume(request):
        body = await request.json()
        try:
            value = await client.set_alarm_volume(body.get('volume'))
        except (TypeError, ValueError) as e:
            return web.json_response({'ok': False, 'error': str(e)}, status=400)
        return web.json_response({'ok': True, 'volume': value})

    async def alarm_tone(request):
        body = await request.json()
        try:
            if body.get('stop'):
                await client._stop_preview()      # the settings closed while a tone was being tried
            elif body.get('preview'):
                await client.preview_tone(body.get('tone'))
            else:
                client.set_alarm_tone(body.get('tone'))
        except ValueError as e:
            return web.json_response({'ok': False, 'error': str(e)}, status=400)
        return web.json_response({'ok': True})

    async def alarm_delete(request):
        body = await request.json()
        try:
            item = await client.delete_alarm(int(body.get('id')))
        except (TypeError, ValueError):
            return web.json_response({'ok': False, 'error': 'id must be a number'}, status=400)
        return web.json_response({'ok': bool(item), **({} if item else {'error': '这一条已经没有了'})})

    async def alarm_snooze(_request):
        found = await client.snooze_alarm()
        return web.json_response({'ok': bool(found), **({} if found else {'error': '没有刚响过的闹钟'})})

    async def alarm_stop(_request):
        return web.json_response({'ok': await client.stop_alarm()})

    async def alarm_missed_clear(_request):
        client.clear_missed()
        return web.json_response({'ok': True})

    async def clear_history(request):
        body = await request.json()
        return web.json_response(await client.clear_history(bool(body.get('memory_only'))))

    async def bluetooth(request):
        body = await request.json()
        args = {k: body[k] for k in ('enabled', 'window', 'remove', 'disconnect') if k in body}
        ok = await client.bluetooth(**args)
        return web.json_response({'ok': bool(ok), **({} if ok else {'error': '蓝牙没有响应'})})

    async def health(_request):
        return web.json_response({'version': __version__, **client.health()})

    async def status(_request):
        return web.json_response(await asyncio.to_thread(_collect_status, client))

    async def power_off(_request):
        return web.json_response(await client.power_off())

    async def network(_request):
        return web.json_response({'ip': local_ip()})

    async def update_check(_request):
        return web.json_response({'ok': update.request('check')})

    async def update_install(request):
        if client.state != 'idle':
            return web.json_response({'ok': False, 'error': '对话结束后再更新'}, status=409)
        body = await request.json()
        return web.json_response({'ok': update.request('install', str(body.get('version') or ''),
                                                       str(body.get('system') or ''))})

    watchers = []   # keeps the task referenced

    async def watch_updates(_app):
        watchers.append(asyncio.create_task(update.watch(client.events.publish)))

    app.on_startup.append(watch_updates)
    app.router.add_get('/', index)
    app.router.add_get('/v2', index)
    app.router.add_get('/v1', index_v1)
    app.router.add_get('/events', events)
    app.router.add_post('/api/wake', action(lambda: client.wake('button')))
    app.router.add_post('/api/end', action(client.end))
    app.router.add_post('/api/abort', action(client.abort))
    app.router.add_post('/api/ptt/start', action(client.ptt_start))
    app.router.add_post('/api/ptt/stop', action(client.ptt_stop))
    app.router.add_post('/api/model', model)
    app.router.add_post('/api/text', text)
    app.router.add_post('/api/music', music)
    app.router.add_post('/api/netease/login/refresh', netease_login_action)
    app.router.add_post('/api/netease/login/cancel', netease_login_action)
    app.router.add_post('/api/sleep', sleep_setting)
    app.router.add_post('/api/brightness', brightness)
    app.router.add_post('/api/screen-off', screen_off)
    app.router.add_post('/api/volume', volume)
    app.router.add_post('/api/alarm-volume', alarm_volume)
    app.router.add_post('/api/alarm-tone', alarm_tone)
    app.router.add_post('/api/alarms/delete', alarm_delete)
    app.router.add_post('/api/alarms/snooze', alarm_snooze)
    app.router.add_post('/api/alarms/stop', alarm_stop)
    app.router.add_post('/api/alarms/missed/clear', alarm_missed_clear)
    app.router.add_post('/api/reports/play', action(client.play_reports))
    app.router.add_post('/api/history/clear', clear_history)
    app.router.add_post('/api/bluetooth', bluetooth)
    app.router.add_get('/api/health', health)
    app.router.add_get('/api/status', status)
    app.router.add_get('/api/network', network)
    app.router.add_post('/api/power-off', power_off)
    app.router.add_post('/api/update/check', update_check)
    app.router.add_post('/api/update/install', update_install)
    app.router.add_static('/static/', WEB)

    async def revalidate(request, response):
        # the kiosk keeps a disk cache; without this it goes on running the old app.js/css after
        # an update (heuristic freshness from Last-Modified). no-cache = check the ETag every load.
        if request.path.startswith('/static/'):
            response.headers['Cache-Control'] = 'no-cache'
    app.on_response_prepare.append(revalidate)
    return app
