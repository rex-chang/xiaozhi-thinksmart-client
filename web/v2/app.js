// ThinkSmart voice client page v2: renders what the client streams on /events and sends the buttons back.
// Same contract as v1. Open with ?demo (or ?demo=music for the player) to preview without a client.
const $ = id => document.getElementById(id);
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const pad = n => String(n).padStart(2, '0');
const WEEK = '日一二三四五六';
const DEMO = new URLSearchParams(location.search).get('demo');   // null when not a demo
if (DEMO !== null && /[?&]still\b/.test(location.search)) document.documentElement.classList.add('still');

const ui = {
  status: { state: 'idle', connected: false, uploading: false },
  models: { current: null, options: [] },
  thread: { entry: null, messages: [] },
  ptt: false,
  music: null,
  neteaseLogin: null,
  metaKey: '',
  barArtKey: '',
  pfArtKey: '',
  playerOpen: false,
  lyrics: null,
  lyricsFull: false,
  playlists: null,
  playlistView: null,
  playlistTracks: null,
  drawerTab: 'queue',
  alarms: { synced: true, items: [], missed: [], ringing: null, volume: 70, tone: 'coffee', tones: {} },
};

const SUGGEST = [
  ['明天北京天气怎么样？', '#ffb54729', '#ffcf7a', '<circle cx="12" cy="12" r="4"/><path d="M12 2.5v2M12 19.5v2M4.6 4.6L6 6M18 18l1.4 1.4M2.5 12h2M19.5 12h2M4.6 19.4L6 18M18 6l1.4-1.4"/>'],
  ['帮我想个周末计划', '#5ee0ff24', '#8ff0ff', '<path d="M12 3l2.2 5.8L20 11l-5.8 2.2L12 19l-2.2-5.8L4 11l5.8-2.2z"/>'],
  ['讲个冷笑话', '#ff7ac824', '#ff9bd6', '<circle cx="12" cy="12" r="9"/><path d="M8 14.5a5 5 0 0 0 8 0M9 9.5h.01M15 9.5h.01"/>'],
  ['把音量调小一点', '#9b7bff2b', '#c8b4ff', '<path d="M4 9v6h4l5 4V5L8 9H4z"/><path d="M17 12h4"/>'],
];

/* ---- clock ---- */
function tick() {
  const now = new Date();
  const hm = pad(now.getHours()) + ':' + pad(now.getMinutes());
  $('time').textContent = hm;
  $('bigTime').textContent = hm;
  $('bigDate').textContent = `${now.getMonth() + 1}月${now.getDate()}日  星期${WEEK[now.getDay()]}`;
  const h = now.getHours();
  $('greet').textContent = h < 5 ? '夜深了' : h < 9 ? '早上好' : h < 12 ? '上午好' : h < 14 ? '中午好' : h < 18 ? '下午好' : h < 23 ? '晚上好' : '夜深了';
  $('ringTime').textContent = hm;
  tickAlarms();
}

/* ---- the orb's corona: 48 bars around the orb, one shape per state ----
   idle: short and still. connecting: 12 dashes, turned slowly by CSS. thinking: a comet orbiting (CSS).
   listening: the whole ring pushes outward with your voice, all bars together — loud is big, quiet barely moves.
   speaking: three lobes turning round the ring, swelling with the reply's volume.
   Only listening/speaking redraw every frame; any state change morphs the bars over 0.4 s, then the loop stops.
   All bars are drawn on one canvas: as 48 elements, restyling them 30 times a second kept
   the device's main thread at ~93% and the page at ~17 fps. */
const BARS = 48, R_IN = 110, BAR_W = 6, REST = 8, REACH = 46;   // px; REST + REACH stays inside the canvas
const corona = document.createElement('canvas');
const CSIZE = 330, DPR = Math.min(2, window.devicePixelRatio || 1);
corona.width = corona.height = CSIZE * DPR;
corona.style.width = corona.style.height = '100%';
$('corona').appendChild(corona);
const cx = corona.getContext('2d');
const ANG = Array.from({ length: BARS }, (_, i) => i / BARS * Math.PI * 2);
const COS = ANG.map(Math.cos), SIN = ANG.map(Math.sin);
// per bar: [length px, opacity]; what is on screen, where a morph starts, and where the state wants it
const cur = new Float32Array(BARS * 2), from = new Float32Array(BARS * 2), tgt = new Float32Array(BARS * 2);
let barFill = null, barFillState = '';
function fillFor(state) {
  // one radial gradient for all bars: inner end --c2, outer end --c1
  if (barFillState !== state) {
    const css = getComputedStyle(document.body);
    barFill = cx.createRadialGradient(0, 0, R_IN, 0, 0, R_IN + REST + REACH);
    barFill.addColorStop(0, css.getPropertyValue('--c2').trim());
    barFill.addColorStop(1, css.getPropertyValue('--c1').trim());
    barFillState = state;
  }
  return barFill;
}
// Bars of (nearly) the same opacity share one path and one fill: 48 separate fills cost the device's
// main thread ~20% of a core while speaking. The path takes each bar's transform as it is added.
const bucket = new Uint8Array(BARS);
function drawBars(bars) {
  const c = CSIZE * DPR / 2;
  cx.setTransform(1, 0, 0, 1, 0, 0);
  cx.clearRect(0, 0, corona.width, corona.height);
  cx.fillStyle = fillFor(document.body.dataset.state || 'idle');
  for (let i = 0; i < BARS; i++) bucket[i] = bars[i * 2] < .5 ? 0 : Math.max(1, Math.round(bars[i * 2 + 1] * 20));
  for (let q = 1; q <= 20; q++) {
    if (!bucket.includes(q)) continue;
    cx.beginPath();
    for (let i = 0; i < BARS; i++) {
      if (bucket[i] !== q) continue;
      cx.setTransform(COS[i] * DPR, SIN[i] * DPR, -SIN[i] * DPR, COS[i] * DPR, c, c);
      cx.roundRect(-BAR_W / 2, -R_IN - bars[i * 2], BAR_W, bars[i * 2], BAR_W / 2);
    }
    cx.setTransform(DPR, 0, 0, DPR, c, c);   // the radial gradient is centred on the orb
    cx.globalAlpha = q / 20;
    cx.fill();
  }
  cx.globalAlpha = 1;
}

// target shape of a state into out; v = sound level 0..1, p = phase (s), t = seconds in this state
function shapeOf(state, v, p, t, out) {
  for (let i = 0; i < BARS; i++) {
    const a = ANG[i], f = i / BARS;
    let len = REST, alpha = 1;
    if (state === 'thinking') { len = 6.6 + 28.5 * f * f; alpha = .1 + .9 * f ** 1.6; }
    else if (state === 'connecting') { len = i % 4 ? 4.2 : 16.5; alpha = i % 4 ? .35 : 1; }
    else if (state === 'listening') {
      // a short burst on waking says "I'm here", then the ring follows the voice as one
      const env = Math.max(v, .5 * Math.max(0, 1 - t / .6) ** 2);
      const grain = .84 + .16 * Math.sin(a * 5 + p * 3.1) * Math.sin(a * 3 - p * 2.3);
      len = REST - 1 + 1.2 * Math.sin(a * 4 + p * 1.5) + REACH * env * grain;
    } else if (state === 'speaking') {
      const lobe = .5 + .5 * Math.sin(a * 3 - p * 1.3);
      len = REST + 4 * lobe + REACH * v * (.3 + .7 * lobe);
      alpha = .6 + .4 * lobe;
    }
    out[i * 2] = len;
    out[i * 2 + 1] = alpha;
  }
}

// The mic level (RMS) in decibels, so a quiet voice visibly moves the corona. Measured on the device
// (2026-11-01, 9 listening turns): room noise -74..-80 dBFS with rare blips to -62, normal speech
// -60..-42 dBFS. The old linear scale (full at -23 dBFS) moved the corona 1–7% for that speech.
// Now noise stays 0, a quiet voice (-55) reaches ~30%, a normal one (-45) ~58%, a loud one (-30) 100%.
const MIC_FLOOR = -66, MIC_FULL = -30;   // dBFS
const micLevel = rms => Math.min(1, Math.max(0, (20 * Math.log10(rms + 1e-6) - MIC_FLOOR) / (MIC_FULL - MIC_FLOOR)));

const STILL = document.documentElement.classList.contains('still');
const level = { target: 0, value: 0, phase: 0, raf: 0, last: 0, state: '', since: 0, mix: 1 };
const isLive = s => s === 'listening' || s === 'speaking';
function setCorona(state) {
  if (state === level.state) return;
  // morph from what is on screen; a spinning corona is turned by CSS, so carry its angle into the bars
  const m = getComputedStyle($('corona')).transform.match(/matrix\(([^,]+),\s*([^,]+)/);
  const k = m ? Math.round(Math.atan2(+m[2], +m[1]) / (Math.PI * 2) * BARS) : 0;
  for (let i = 0; i < BARS; i++) {
    const j = ((i - k) % BARS + BARS) % BARS;
    from[i * 2] = cur[j * 2]; from[i * 2 + 1] = cur[j * 2 + 1];
  }
  level.state = state;
  level.since = performance.now();
  level.mix = level.last ? 0 : 1;   // the first paint just draws
  if (!isLive(state)) level.target = 0;
  if (STILL) {   // screenshots: one fairly loud, settled frame
    shapeOf(state, isLive(state) ? .7 : 0, 1.2, 9, cur);
    drawBars(cur);
    if (isLive(state)) drawLive(.7, 1.2);
    return;
  }
  if (!level.raf) {
    level.last = performance.now() - 34;
    level.raf = requestAnimationFrame(levelLoop);
  }
}
function levelLoop(now) {
  level.raf = requestAnimationFrame(levelLoop);
  if (now - level.last < 33) return;      // ~30 fps is plenty
  const dt = Math.min(.1, (now - level.last) / 1000);
  level.last = now;
  level.value += (level.target - level.value) * (level.target > level.value ? .55 : .2);
  level.phase += dt * 2.4;
  const live = isLive(level.state);
  shapeOf(level.state, level.value, level.phase, (now - level.since) / 1000, tgt);
  if (level.mix < 1) {
    level.mix = Math.min(1, level.mix + dt / .4);
    const e = 1 - (1 - level.mix) ** 3;
    for (let i = 0; i < tgt.length; i++) cur[i] = from[i] + (tgt[i] - from[i]) * e;
  } else cur.set(tgt);
  drawBars(cur);
  if (live || level.mix < 1) drawLive(level.value, level.phase);   // after live: let the level settle
  else {
    cancelAnimationFrame(level.raf);
    level.raf = 0;
    level.target = level.value = 0;
    $('corona').style.transform = $('core').style.transform = $('micRing').style.transform = $('mouth').style.transform = '';
  }
}
// The whole corona layer grows with the level too (compositor only, no repaint): with the longer bars,
// the tips go from r ≈ 117 px when quiet to ≈ 190 px when loud. Core, mouth, mic ring and the wave follow.
function drawLive(v, p) {
  $('corona').style.transform = `scale(${(1 + v * .16).toFixed(3)})`;
  $('core').style.transform = `scale(${(1 + v * .13).toFixed(3)})`;
  $('mouth').style.transform = `scaleY(${(.55 + v * 1.6).toFixed(3)})`;
  if (level.state === 'listening') $('micRing').style.transform = `scale(${(1 + v * .16).toFixed(3)})`;   // invisible otherwise
  const pending = $('pending');
  if (pending) pending.querySelectorAll('.wave b').forEach((b, i) => { b.style.transform = `scaleY(${(.18 + v * (.5 + .5 * Math.sin(p * 3 + i * 1.3))).toFixed(3)})`; });
}

/* ---- status: orb, title, hint, buttons ---- */
function modelName() {
  const cur = ui.models.current;
  return cur ? cur.label : '模型';
}
const shownState = () => (ui.ptt ? 'listening' : ui.status.state);

function renderStatus() {
  const { state, connected } = ui.status;
  const shown = shownState();
  document.body.dataset.state = shown;
  const text = {
    idle: ['说<em>「小麦小麦」</em>', connected ? '对话还在，唤醒后可以接着聊' : '或者点麦克风；按住可以直接说'],
    connecting: ['正在连接…', '连上小智网关后就开始听'],
    listening: ui.ptt ? ['松开<em>发送</em>', '说完松开手指'] : ['我在听', '说完停一下，我就开始回答'],
    thinking: [`<em>${esc(modelName())}</em> 正在思考`, '复杂的问题可能要想一会儿'],
    speaking: ['正在回答', '喊「小麦小麦」或点打断就能停下'],
  }[shown] || ['', ''];
  if (ui.status.recognising && !ui.ptt) text.splice(0, 2, '正在识别', '你说完了，正在把话转成文字');
  const micOff = ui.status.mic === false;
  document.body.classList.toggle('mic-off', micOff);
  const reports = ui.status.reports || 0;
  const sleeping = !!(ui.status.sleep && ui.status.sleep.active);
  document.body.classList.toggle('has-reports', reports > 0);
  document.body.classList.toggle('sleeping', sleeping);
  $('reportText').textContent = reports > 1 ? `有 ${reports} 条待汇报` : '有一条待汇报';
  if (micOff && shown === 'idle') text.splice(0, 2, '麦克风已关', '拨开机身侧面的开关就能说话');
  else if (reports && shown === 'idle') text[1] = '有待汇报：点右上角收听，或叫一声「小麦小麦」';
  else if (sleeping && shown === 'idle' && !connected) text[1] = '睡眠时段：汇报不会自动念';
  $('title').innerHTML = text[0];
  $('hint').textContent = text[1];
  // recognising, thinking or speaking: the turn can be interrupted (the question is dropped if nothing was said yet)
  $('btnAbort').disabled = !connected || !(state === 'speaking' || state === 'thinking' || (ui.status.recognising && !ui.ptt));
  $('btnEnd').disabled = !connected;
  const link = $('link');
  link.classList.toggle('on', connected);
  link.querySelector('span').textContent = connected ? '对话中' : '待机';
  renderSide();
  renderPending();
  setCorona(shown);
  renderSettings();
  renderBright();
  renderScreenOff();
  renderVol();
  renderUpdate();
}

/* ---- models ---- */
const logoSrc = m => (m && m.logo ? `/static/logos/${m.logo}.svg` : '');

function renderModels() {
  const cur = ui.models.current;
  $('pillLogo').src = logoSrc(cur);
  $('pillLabel').textContent = cur ? cur.label : '选择模型';
  $('pillModel').textContent = cur ? (cur.model || cur.company || '') : '';
  const grid = $('grid');
  grid.textContent = '';
  for (const m of ui.models.options) {
    const on = cur && cur.entry === m.entry;
    const b = document.createElement('button');
    b.className = 'card' + (on ? ' on' : '');
    b.innerHTML = `<img class="tile" src="${esc(logoSrc(m))}" alt="">` + (on ? '<span class="badge">使用中</span>' : '') +
      `<span><b>${esc(m.label)}</b><small>${esc(m.model || '')}</small><small class="co">${esc(m.company || '')}</small></span>`;
    b.addEventListener('click', () => switchModel(m));
    grid.appendChild(b);
  }
  renderHead();
}

function openSheet(on) {
  $('sheet').classList.toggle('on', on);
}

// The page switches at once and the hub catches up; if it fails, back to what the client last said.
// While a switch is on its way, the client's events about the old model don't flip the page back.
const server = { models: null, thread: null };
const seenThreads = {};   // entry -> the client's messages for that model, shown at once when switching to it
let switching = null;

async function switchModel(m) {
  openSheet(false);
  if (ui.models.current && ui.models.current.entry === m.entry) return;
  if (DEMO) return demo.switchTo(m);
  switching = m.entry;
  ui.models = Object.assign({}, ui.models, { current: m });
  ui.thread = { entry: m.entry, messages: seenThreads[m.entry] || [] };
  renderModels(); renderThread(); renderStatus();
  let error = null;
  try {
    const r = await (await fetch('/api/model', { method: 'POST', headers: { 'Content-Type': 'application/json' },
                                                 body: JSON.stringify({ kind: m.kind, vendor: m.vendor, entry: m.entry }) })).json();
    if (r.ok === false) error = r.error || '切换失败';
  } catch (e) {
    error = '切换失败：客户端没有响应';
  }
  if (switching !== m.entry) return;   // another switch since
  switching = null;
  if (server.models) ui.models = server.models;
  if (server.thread) ui.thread = server.thread;
  renderModels(); renderThread(); renderStatus();
  toast(error || `已切换到 ${m.label}`, error ? 'error' : '');
}

/* ---- settings: sleep hours ---- */
const sleepEdit = {};   // changes sent but not yet confirmed by a state event
let sleepTimer = null;
function sleepSetting() {
  return Object.assign({ enabled: false, start: '22:00', end: '07:00', active: false }, ui.status.sleep || {}, sleepEdit);
}
function renderSettings() {
  const s = sleepSetting();
  $('sleepSwitch').setAttribute('aria-checked', String(s.enabled));
  $('sleepTimes').classList.toggle('off', !s.enabled);
  $('sleepStart').textContent = s.start;
  $('sleepEnd').textContent = s.end;
  $('sleepNote').textContent = !s.enabled ? '睡眠时段已关闭：补报一到就念，音量和亮度照常'
    : s.active ? `现在是睡眠时段，到 ${s.end} 结束` : `每天 ${s.start} 到 ${s.end} 是睡眠时段，现在不在`;
}
function sendSleep(changes, delay) {
  Object.assign(sleepEdit, changes);
  renderSettings();
  clearTimeout(sleepTimer);
  sleepTimer = setTimeout(async () => {
    const body = Object.assign({}, sleepEdit);
    if (DEMO) { ui.status.sleep = Object.assign(sleepSetting(), body); for (const k in body) delete sleepEdit[k]; return renderStatus(); }
    try {
      const r = await (await fetch('/api/sleep', { method: 'POST', headers: { 'Content-Type': 'application/json' },
                                                   body: JSON.stringify(body) })).json();
      if (r.ok === false) toast(r.error || '没保存上', 'error');
    } catch (e) {
      toast('没保存上：客户端没有响应', 'error');
    }
    for (const k in body) if (sleepEdit[k] === body[k]) delete sleepEdit[k];
    renderSettings();
  }, delay);
}
function stepTime(hhmm, minutes) {
  const [h, m] = hhmm.split(':').map(Number);
  const t = ((h * 60 + m + minutes) % 1440 + 1440) % 1440;
  return pad(Math.floor(t / 60)) + ':' + pad(t % 60);
}
$('sleepSwitch').addEventListener('click', () => sendSleep({ enabled: !sleepSetting().enabled }, 0));
for (const b of document.querySelectorAll('.stepper button')) {
  b.addEventListener('click', () => sendSleep({ [b.dataset.k]: stepTime(sleepSetting()[b.dataset.k], Number(b.dataset.d)) }, 600));
}
/* ---- settings: screen brightness (the client hints the system's screen blanker) ---- */
let brightEdit = null;   // the slider's value while the finger is on it or the change is on its way
let brightTimer = null, brightSent = 0, brightDrag = false;
function brightSetting() {
  return Object.assign({ level: 100, dimmed: false }, ui.status.brightness || {},
                       brightEdit === null ? {} : { level: brightEdit, dimmed: false });
}
function renderBright() {
  const b = brightSetting();
  if (brightEdit === null) $('brightRange').value = b.level;
  $('brightRange').style.setProperty('--fill', b.level + '%');
  $('brightNum').textContent = b.level + '%';
  $('brightNote').textContent = b.dimmed ? '睡眠时段内屏幕调暗了；拖一下滑条，这次时段就按你调的亮度'
    : '熄屏再亮也保持这个亮度；也可以说「小麦小麦，屏幕亮一点」「调到最亮」';
}
async function sendBright(body) {
  if (DEMO) { ui.status.brightness = { level: body.level, dimmed: false }; return; }
  try {
    const r = await (await fetch('/api/brightness', { method: 'POST', headers: { 'Content-Type': 'application/json' },
                                                       body: JSON.stringify(body) })).json();
    if (r.ok === false) toast(r.error || '没保存上', 'error');
  } catch (e) {
    toast('没保存上：客户端没有响应', 'error');
  }
}
// The slider follows the finger itself (pointer events, like the mic button) instead of relying on
// the browser's own range dragging under touch. While dragging: at most one change every 150 ms
// (the blanker looks every 200 ms); the last one on release.
function dragBright(e) {
  const r = $('brightRange').getBoundingClientRect(), thumb = 48;
  brightEdit = Math.round(Math.max(0, Math.min(1, (e.clientX - r.left - thumb / 2) / (r.width - thumb))) * 100);
  $('brightRange').value = brightEdit;
  renderBright();
  clearTimeout(brightTimer);
  const send = () => { brightSent = Date.now(); sendBright({ level: brightEdit }); };
  if (Date.now() - brightSent > 150) send();
  else brightTimer = setTimeout(send, 150);
}
$('brightRange').addEventListener('pointerdown', e => {
  e.preventDefault();
  brightDrag = true;
  try { $('brightRange').setPointerCapture(e.pointerId); } catch (err) { /* keeps following without capture */ }
  dragBright(e);
});
$('brightRange').addEventListener('pointermove', e => {
  if (brightDrag) dragBright(e);
});
function dropBright() {
  if (!brightDrag) return;
  brightDrag = false;
  clearTimeout(brightTimer);
  const level = brightEdit;
  sendBright({ level }).then(() => { if (brightEdit === level) brightEdit = null; renderStatus(); });
}
$('brightRange').addEventListener('pointerup', dropBright);
$('brightRange').addEventListener('pointercancel', dropBright);

/* ---- settings: auto screen-off (the client hints the system's screen blanker) ---- */
const offEdit = {};   // a change on its way
function offSetting() {
  return Object.assign({ enabled: true, minutes: 5 }, ui.status.screen_off || {}, offEdit);
}
function renderScreenOff() {
  const s = offSetting();
  $('offSwitch').setAttribute('aria-checked', String(s.enabled));
  $('offMinutes').classList.toggle('off', !s.enabled);
  for (const b of $('offMinutes').children) b.classList.toggle('on', Number(b.dataset.m) === s.minutes);
  $('offNote').textContent = s.enabled ? `${s.minutes} 分钟没碰屏幕、也没在对话，就熄屏` : '屏幕一直亮着，不会自动熄屏';
}
async function sendScreenOff(changes) {
  Object.assign(offEdit, changes);
  renderScreenOff();
  if (DEMO) { ui.status.screen_off = offSetting(); for (const k in changes) delete offEdit[k]; return renderStatus(); }
  try {
    const r = await (await fetch('/api/screen-off', { method: 'POST', headers: { 'Content-Type': 'application/json' },
                                                      body: JSON.stringify(changes) })).json();
    if (r.ok === false) toast(r.error || '没保存上', 'error');
  } catch (e) {
    toast('没保存上：客户端没有响应', 'error');
  }
  for (const k in changes) if (offEdit[k] === changes[k]) delete offEdit[k];
  renderScreenOff();
}
$('offSwitch').addEventListener('click', () => sendScreenOff({ enabled: !offSetting().enabled }));
for (const b of $('offMinutes').children) b.addEventListener('click', () => sendScreenOff({ minutes: Number(b.dataset.m) }));

/* ---- settings: volumes (the device's, which the keys and voice change too, and the alarms' own) ---- */
// Same finger-following slider as the brightness: at most one change every 150 ms while dragging, the
// last one on release; what the client says meanwhile doesn't move the thumb under the finger.
function slider(id, numId, get, send) {
  const el = $(id);
  let edit = null, timer = null, sent = 0, drag = false;
  function render() {
    const v = edit === null ? get() : edit;
    if (edit === null && v != null) el.value = v;
    el.style.setProperty('--fill', (v == null ? 0 : v) + '%');
    $(numId).textContent = v == null ? '' : v + '%';
  }
  function move(e) {
    const r = el.getBoundingClientRect(), thumb = 48;
    edit = Math.round(Math.max(0, Math.min(1, (e.clientX - r.left - thumb / 2) / (r.width - thumb))) * 100);
    el.value = edit;
    render();
    clearTimeout(timer);
    const go = () => { sent = Date.now(); send(edit); };
    if (Date.now() - sent > 150) go();
    else timer = setTimeout(go, 150);
  }
  el.addEventListener('pointerdown', e => {
    e.preventDefault();
    drag = true;
    try { el.setPointerCapture(e.pointerId); } catch (err) { /* keeps following without capture */ }
    move(e);
  });
  el.addEventListener('pointermove', e => { if (drag) move(e); });
  function drop() {
    if (!drag) return;
    drag = false;
    clearTimeout(timer);
    const v = edit;
    Promise.resolve(send(v)).then(() => { if (edit === v) edit = null; render(); });
  }
  el.addEventListener('pointerup', drop);
  el.addEventListener('pointercancel', drop);
  return render;
}
async function postJson(path, body) {
  try {
    const r = await (await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' },
                                         body: JSON.stringify(body || {}) })).json();
    if (r.ok === false) toast(r.error || '没保存上', 'error');
    return r;
  } catch (e) {
    toast('没保存上：客户端没有响应', 'error');
    return { ok: false };
  }
}
const renderVol = slider('volRange', 'volNum', () => ui.status.volume,
  v => (DEMO ? (ui.status.volume = v) : postJson('/api/volume', { volume: v })));
const renderAlarmVol = slider('alarmVolRange', 'alarmVolNum', () => ui.alarms.volume,
  v => (DEMO ? (ui.alarms.volume = v) : postJson('/api/alarm-volume', { volume: v })));

/* ---- countdowns, alarms and reminders (alarms.py: the client keeps and rings them) ---- */
const KIND_ICON = { timer: '计时', alarm: '闹钟', reminder: '提醒' };
const now_s = () => Date.now() / 1000;
function hhmm(t) {
  const d = new Date(t * 1000);
  return pad(d.getHours()) + ':' + pad(d.getMinutes());
}
function dayText(t) {
  const d = new Date(t * 1000), today = new Date();
  today.setHours(0, 0, 0, 0);
  const days = Math.round((new Date(d.getFullYear(), d.getMonth(), d.getDate()) - today) / 86400000);
  return { '-1': '昨天', 0: '今天', 1: '明天', 2: '后天' }[days] || `${d.getMonth() + 1}月${d.getDate()}日 星期${WEEK[d.getDay()]}`;
}
function left(t) {
  const s = Math.max(0, Math.round(t - now_s()));
  const h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60);
  return (h ? h + ':' + pad(m) : m) + ':' + pad(s % 60);
}
function alarmRow(v) {
  if (v.kind === 'timer') {
    return [`<span data-left="${v.at}">${left(v.at)}</span>${v.label ? ' ' + esc(v.label) : ''}`,
            `倒计时，${hhmm(v.at)} 响${v.snoozed ? ' · 再睡中' : ''}`];
  }
  const sub = [dayText(v.at)];
  if (v.repeat) sub.push(esc(v.repeat));
  if (v.snoozed) sub.push('再睡中');
  if (v.kind === 'reminder') sub.push(v.spoken ? '到点念出来' : v.spoken === false ? '只响铃（没合成出语音）' : '正在合成语音');
  return [`${hhmm(v.at)}${v.label ? ' ' + esc(v.label) : ''}`, sub.join(' · ')];
}
function renderAlarms() {
  const a = ui.alarms;
  document.body.classList.toggle('alarms-paused', !a.synced);
  document.body.classList.toggle('ringing', !!a.ringing);
  document.body.classList.toggle('has-timer', a.items.some(v => v.kind === 'timer'));
  // home: the running countdowns and the next alarm or reminder
  const timers = a.items.filter(v => v.kind === 'timer').slice(0, 3);
  const next = a.items.find(v => v.kind !== 'timer');
  const chips = timers.map(v => `<div class="na timer">倒计时 <b data-left="${v.at}">${left(v.at)}</b>${v.label ? esc(v.label) : ''}</div>`);
  if (next) chips.push(`<div class="na">${KIND_ICON[next.kind]} <b>${dayText(next.at)} ${hhmm(next.at)}</b>${esc(next.label || '')}</div>`);
  if (!a.synced && a.items.length) chips.unshift('<div class="na paused">时间未同步，闹钟暂停</div>');
  $('nextAlarms').innerHTML = chips.join('');
  // settings: the list, the tones, the missed ones
  $('alarmCount').textContent = a.items.length ? `${a.items.length} 条` : '';
  $('alarmList').innerHTML = a.items.length ? a.items.map(v => {
    const [main, sub] = alarmRow(v);
    return `<div class="al ${v.kind}"><i>${KIND_ICON[v.kind]}</i><div class="al-text"><b>${main}</b><span>${sub}</span></div>` +
      `<button class="al-del" data-id="${v.id}">删除</button></div>`;
  }).join('') : '<div class="alarm-empty">还没有闹钟和提醒</div>';
  $('tones').innerHTML = Object.entries(a.tones || {}).map(([k, name]) =>
    `<button data-tone="${esc(k)}" class="${k === a.tone ? 'on' : ''}">${esc(name)}</button>`).join('');
  // home: the missed ones (newest first, at most 3 shown) until 知道了
  $('missedBox').hidden = !a.missed.length;
  $('missedList').innerHTML = a.missed.slice(0, 3).map(m =>
    `<div class="mh"><b>${dayText(m.at)} ${hhmm(m.at)}</b>${KIND_ICON[m.kind] || ''}${m.label ? ' · ' + esc(m.label) : ''}` +
    `<small>${m.why === 'off' ? '设备关着' : m.kind === 'reminder' ? '提醒了 3 分钟没人停' : '响了 10 分钟没人停'}</small></div>`).join('') +
    (a.missed.length > 3 ? `<div class="mh more">还有 ${a.missed.length - 3} 条</div>` : '');
  renderAlarmVol();
  renderRing();
  tickAlarms();
}
function renderRing() {
  const r = ui.alarms.ringing;
  if (!r) return;
  const items = r.items || [];
  $('ringKind').textContent = [...new Set(items.map(v => v.type))].join('、') || '闹钟';
  $('ringLabel').textContent = items.map(v => v.label).filter(Boolean).join('、');
  $('ringNote').textContent = (r.notes || []).join('；');
}
function tickAlarms() {
  for (const el of document.querySelectorAll('[data-left]')) el.textContent = left(Number(el.dataset.left));
  const timer = ui.alarms.items.find(v => v.kind === 'timer');
  $('timerText').textContent = timer ? left(timer.at) : '';
}
$('alarmList').addEventListener('click', e => {
  const b = e.target.closest('.al-del');
  if (!b) return;
  if (!b.classList.contains('armed')) {
    b.classList.add('armed');
    b.textContent = '确认删除';
    setTimeout(() => { b.classList.remove('armed'); b.textContent = '删除'; }, 4000);
    return;
  }
  if (DEMO) { ui.alarms.items = ui.alarms.items.filter(v => v.id !== Number(b.dataset.id)); return renderAlarms(); }
  postJson('/api/alarms/delete', { id: Number(b.dataset.id) }).then(r => { if (r.ok) toast('已删除'); });
});
$('tones').addEventListener('click', e => {
  const b = e.target.closest('button');
  if (!b) return;
  if (DEMO) { ui.alarms.tone = b.dataset.tone; return renderAlarms(); }
  postJson('/api/alarm-tone', { tone: b.dataset.tone }).then(() => postJson('/api/alarm-tone', { tone: b.dataset.tone, preview: true }));
});
$('missedClear').addEventListener('click', () => {
  if (DEMO) { handlers.alarms(Object.assign({}, ui.alarms, { missed: [] })); return; }
  // hide at once: the client may already have cleared it, and a missed SSE event must not
  // leave the banner on screen
  handlers.alarms(Object.assign({}, ui.alarms, { missed: [] }));
  postJson('/api/alarms/missed/clear').catch(() => {});
});
$('ringStop').addEventListener('click', () => post('/api/alarms/stop'));
$('ringSnooze').addEventListener('click', () => {
  if (DEMO) return post('/api/alarms/snooze');
  postJson('/api/alarms/snooze').then(r => { if (r.ok) toast('好的，10 分钟后再叫你'); });   // postJson shows the error
});

/* ---- settings: software update (update.py: the root updater installs, the page only asks) ---- */
const UPD_STAGE = { preparing: '正在准备', downloading: '正在下载', installing: '正在安装',
                    testing: '正在重启并自检', rolling_back: '自检没通过，正在退回' };
let updArmed = 0;   // first tap on 更新 arms it, a second one within 5 s installs
const mb = n => (n / 1048576).toFixed(n < 10485760 ? 1 : 0) + ' MB';
function ago(t) {
  const m = Math.max(0, Math.round((Date.now() / 1000 - t) / 60));
  return m < 2 ? '刚刚' : m < 60 ? `${m} 分钟前` : m < 1440 ? `${Math.round(m / 60)} 小时前` : `${Math.round(m / 1440)} 天前`;
}
function renderUpdate() {
  const u = ui.update || {}, job = u.job || {}, avail = u.available;
  const busy = job.state in UPD_STAGE;
  const recent = !!job.time && Date.now() / 1000 - job.time < 86400;
  const failed = !busy && recent && (job.state === 'failed' || job.state === 'rolled_back');
  const cur = ui.version ? `当前版本 ${ui.version}` : '';
  let title = '软件更新', text, bad = false, label = '', notes = [];
  if (!u.enabled) text = (cur ? cur + '。' : '') + '这台设备还没装更新服务';
  else if (busy) {
    title = `正在更新到 ${job.version}`;
    const pct = job.state === 'downloading' && job.progress != null ? ` ${Math.round(job.progress * 100)}%` : '';
    text = `${UPD_STAGE[job.state]}${pct}。语音助手会暂停一会儿，请不要断电`;
  } else if (avail) {
    title = `有新版本 ${avail.version}`;
    text = failed ? job.message + '。可以再试一次' : `${cur}，下载约 ${mb(avail.size)}`;
    bad = failed;
    notes = avail.notes || [];
    label = Date.now() - updArmed < 5000 ? '确认更新' : '更新';
  } else {
    text = recent && job.state === 'done' ? `${job.message}，已是最新`
      : failed ? job.message
      : u.check_error ? `${cur}。${u.check_error}` : `${cur}，已是最新` + (u.checked ? `（${ago(u.checked)}检查过）` : '');
    bad = failed || (!!u.check_error && !(recent && job.state === 'done'));
    label = '检查更新';
  }
  $('upd').classList.toggle('new', !!avail && !busy);
  $('gearDot').classList.toggle('on', !!avail && !busy);
  $('updTitle').textContent = title;
  $('updSub').textContent = text;
  $('updSub').classList.toggle('bad', !!bad);   // toggle(x, undefined) would flip it
  $('updNotes').innerHTML = notes.map(n => `<li>${esc(n)}</li>`).join('');
  const btn = $('updBtn');
  btn.hidden = !label;
  btn.textContent = label;
  btn.disabled = !!avail && ui.status.state !== 'idle';   // not in the middle of a conversation
  $('updBar').hidden = !busy;
  $('updBar').classList.toggle('busy', busy && job.state !== 'downloading');
  $('updFill').style.transform = job.state === 'downloading' ? `scaleX(${job.progress || 0})` : '';
}
function updateFinished(job) {
  // once per install, also when the page reloaded because the client restarted with the new version
  if (!job || !(job.state === 'done' || job.state === 'rolled_back' || job.state === 'failed')) return;
  if (Date.now() / 1000 - job.time > 300) return;
  try { if (localStorage.getItem('updShown') === String(job.time)) return; localStorage.setItem('updShown', String(job.time)); } catch (e) { /* no storage */ }
  toast(job.message, job.state === 'done' ? '' : 'error');
}
$('updBtn').addEventListener('click', async () => {
  const avail = (ui.update || {}).available;
  if (!avail) {
    if (DEMO) return toast('正在检查更新…');
    const r = await (await post('/api/update/check'))?.json?.();
    return toast(r && r.ok ? '正在检查更新…' : '这台设备还没装更新服务', r && r.ok ? '' : 'error');
  }
  if (Date.now() - updArmed > 5000) {
    updArmed = Date.now();
    renderUpdate();
    setTimeout(renderUpdate, 5100);
    return toast('更新时语音助手会停一会儿（约 1 分钟），再点一下「确认更新」开始');
  }
  updArmed = 0;
  if (DEMO) return toast('演示模式不会真的安装');
  const r = await (await post('/api/update/install', { version: avail.version }))?.json?.();
  if (!r || !r.ok) toast((r && r.error) || '没能开始更新', 'error');
});
if (DEMO !== null) {
  // ?demo&upd=new|busy|failed: preview the update card (opens the settings sheet)
  const kind = new URLSearchParams(location.search).get('upd');
  const avail = { version: '0.2.0', size: 9.4 * 1048576, notes: ['聊天页的光球加了表情', '修好了睡眠时段跨午夜时不生效'] };
  const now = Date.now() / 1000;
  ui.version = '0.1.0';
  ui.update = { enabled: true, checked: now - 3600, available: kind ? avail : null,
                job: kind === 'busy' ? { state: 'downloading', version: '0.2.0', progress: .42, time: now }
                   : kind === 'failed' ? { state: 'rolled_back', version: '0.2.0', time: now,
                                           message: '0.2.0 自检没通过（新版本连不上小智网关），已退回 0.1.0' } : null };
  if (kind) $('settings').classList.add('on');
}

/* ---- settings: chat history (kept on the hub; clearing also clears the hub's copy) ---- */
let clearArmed = 0, memArmed = 0;   // first tap arms a button, a second one within 5 s clears
function renderClear() {
  $('clearBtn').textContent = Date.now() - clearArmed < 5000 ? '确认清除' : '清除';
  $('clearBtn').classList.toggle('armed', Date.now() - clearArmed < 5000);
  $('clearMemBtn').textContent = Date.now() - memArmed < 5000 ? '确认只清除记忆' : '只清除记忆、保留记录';
  $('clearMemBtn').classList.toggle('armed', Date.now() - memArmed < 5000);
}
function agentNote(r) {
  // Claude Code and Grok Bot keep their own context: clearing here doesn't touch it
  return (r.agents || []).length ? `${r.agents.join('和')}自己那边的对话没有动` : '';
}
$('clearBtn').addEventListener('click', async () => {
  if (Date.now() - clearArmed > 5000) {
    clearArmed = Date.now();
    renderClear();
    setTimeout(renderClear, 5100);
    return toast('清除后所有模型的聊天记录都会删掉，再点一下「确认清除」');
  }
  clearArmed = 0;
  renderClear();
  if (DEMO !== null) { handlers.thread({ entry: ui.thread.entry, messages: [] }); return toast('聊天记录已清除'); }
  const r = await (await post('/api/history/clear', {}))?.json?.();
  if (!r || !r.ok) return toast((r && r.error) || '没能清除', 'error');
  const note = agentNote(r);
  toast('聊天记录已清除' + (note ? '。' + note : ''));
});
$('clearMemBtn').addEventListener('click', async () => {
  if (Date.now() - memArmed > 5000) {
    memArmed = Date.now();
    renderClear();
    setTimeout(renderClear, 5100);
    return toast('模型会忘掉以前聊过的，聊天记录留着；再点一下「确认只清除记忆」');
  }
  memArmed = 0;
  renderClear();
  if (DEMO !== null) return toast('记忆已清除，聊天记录还在');
  const r = await (await post('/api/history/clear', { memory_only: true }))?.json?.();
  toast(r && r.ok ? '记忆已清除，聊天记录还在' : (r && r.error) || '没能清除', r && r.ok ? '' : 'error');
});
renderClear();

// The device's address, read each time the sheet opens (it can change with the WiFi)
async function renderIp() {
  let ip = DEMO !== null ? '192.168.1.23' : null;
  if (DEMO === null) {
    try { ip = (await (await fetch('/api/network')).json()).ip; } catch (e) { ip = null; }
  }
  $('ipNum').textContent = ip || '未联网';
  $('ipSub').textContent = ip ? `在同一网络的电脑上打开 http://${ip}:16688/admin 进网关后台` : '连上 WiFi 后这里显示设备的地址';
}
$('btnSettings').addEventListener('click', () => { $('settings').classList.add('on'); renderIp(); });

/* ---- device status ---- */
function fmtUptime(sec) {
  sec = Math.max(0, Number(sec) || 0);
  const days = Math.floor(sec / 86400), hours = Math.floor((sec % 86400) / 3600), mins = Math.floor((sec % 3600) / 60);
  return days ? `${days} 天 ${hours} 小时` : `${hours} 小时 ${mins} 分`;
}
function statusBar(pct) {
  const value = Math.max(0, Math.min(1, (Number(pct) || 0) / 100));
  return `<div class="bar"><i style="transform:scaleX(${value.toFixed(3)})"></i></div>`;
}
function statusCard(title, body, cls = '') {
  return `<div class="status-card ${cls}"><h3>${title}</h3>${body}</div>`;
}
function serviceRow(name, state) {
  const ok = state === 'active';
  return `<div class="row"><span>${esc(name)}</span><b class="${ok ? '' : 'bad'}"><i></i>${esc(state || 'unknown')}</b></div>`;
}
function demoStatus() {
  return {
    version: '0.1.5', uptime_s: 228000,
    cpu: { cores: 8, used_percent: 7.6, load: [1.5, 1.7, 2.1] },
    memory: { total_mb: 1937, used_mb: 1330, available_mb: 607, swap_used_mb: 64 },
    disk: { total_gb: 6.4, used_gb: 4.4, free_gb: 1.7 },
    temperature_c: 35.8,
    services: { client: 'active', kiosk: 'active', hub: 'active' },
    processes: [
      { name: 'python', rss_mb: 671 }, { name: 'WebKitWebProces', rss_mb: 238 },
      { name: 'python3', rss_mb: 178 }, { name: 'mpv', rss_mb: 88 }, { name: 'weston', rss_mb: 84 },
    ],
    music: null, update: { current: '0.1.5', available: null },
  };
}
function renderDeviceStatus(d) {
  const cpu = d.cpu || {}, mem = d.memory || {}, disk = d.disk || {};
  const svc = d.services || {}, music = d.music || {}, upd = d.update || {};
  const cpuPct = cpu.used_percent == null ? null : Number(cpu.used_percent);
  const memPct = mem.total_mb ? (Number(mem.used_mb) || 0) * 100 / mem.total_mb : 0;
  const diskPct = disk.total_gb ? (Number(disk.used_gb) || 0) * 100 / disk.total_gb : 0;
  const load = (cpu.load || []).map(x => Number(x).toFixed(1)).join(' / ');
  const cpuBody = `<div class="big">${cpuPct == null ? '—' : cpuPct + '%'}</div>` +
    `<small>${cpu.cores || '?'} 核 · 负载 ${load || '—'}</small>${statusBar(cpuPct)}`;
  const memBody = `<div class="big">${mem.used_mb ?? '?'} / ${mem.total_mb ?? '?'} MB</div>` +
    `<small>可用 ${mem.available_mb ?? '?'} MB · swap ${mem.swap_used_mb ?? '?'} MB</small>${statusBar(memPct)}`;
  const diskBody = `<div class="big">${disk.free_gb ?? '?'} GB 可用</div>` +
    `<small>${disk.used_gb ?? '?'} / ${disk.total_gb ?? '?'} GB 已用</small>${statusBar(diskPct)}`;
  const tempBody = `<div class="big">${d.temperature_c ?? '—'} °C</div>` +
    `<small>已运行 ${fmtUptime(d.uptime_s)} · 版本 ${esc(d.version || '?')}</small>`;
  const svcBody = serviceRow('client', svc.client) + serviceRow('kiosk', svc.kiosk) + serviceRow('hub', svc.hub);
  const updBody = `<div class="big">${esc(upd.current || d.version || '—')}</div>` +
    `<small>${upd.available ? '可更新到 ' + esc(upd.available) : '已是最新'}` +
    `${upd.check_error ? ' · ' + esc(upd.check_error) : ''}</small>`;
  let musicBody;
  if (music && music.state !== 'stopped' && music.title) {
    musicBody = `<div class="big">${esc(music.title)}</div>` +
      `<small>${esc((music.artists || []).join(' / '))} · ${fmtTime(music.position)} / ${fmtTime(music.duration)} · 队列 ${music.queue ?? '?'} 首</small>`;
  } else {
    musicBody = '<div class="big">未播放</div><small>当前没有在放歌</small>';
  }
  const rows = (d.processes || []).slice(0, 6).map(p =>
    `<div class="row"><span>${esc(p.name)}</span><b>${p.rss_mb} MB</b></div>`).join('') || '<small>无数据</small>';
  $('statusGrid').innerHTML = [
    statusCard('CPU', cpuBody),
    statusCard('内存', memBody),
    statusCard('磁盘', diskBody),
    statusCard('温度 / 运行', tempBody),
    statusCard('服务', svcBody),
    statusCard('更新', updBody),
    statusCard('正在播放', musicBody, 'wide'),
    statusCard('进程内存', `<div class="rows">${rows}</div>`),
  ].join('');
  $('statusUpdated').textContent = `每 3 秒刷新 · ${new Date().toLocaleTimeString()}`;
  const states = Object.values(svc);
  $('statusDot').className = 'status-dot ' + (states.length && states.every(x => x === 'active') ? 'ok' : 'bad');
}
let statusTimer = null;
async function loadStatus() {
  if (DEMO !== null) { renderDeviceStatus(demoStatus()); return; }
  try {
    const response = await fetch('/api/status', { cache: 'no-store' });
    if (!response.ok) throw new Error('HTTP ' + response.status);
    renderDeviceStatus(await response.json());
  } catch (e) {
    $('statusUpdated').textContent = '读取失败：' + e.message;
    $('statusDot').className = 'status-dot bad';
  }
}
function openStatus() {
  $('settings').classList.remove('on');
  $('sheet').classList.remove('on');
  $('statusSheet').classList.add('on');
  loadStatus();
  clearInterval(statusTimer);
  statusTimer = setInterval(loadStatus, 3000);
}
function closeStatus() {
  $('statusSheet').classList.remove('on');
  clearInterval(statusTimer);
  statusTimer = null;
}
$('btnStatus').addEventListener('click', openStatus);
$('statusClose').addEventListener('click', closeStatus);

// 关机: halts the system (it stays dark with the power cable in), so unplugging can't damage it
let powerArmed = 0;
function renderPower() {
  $('powerBtn').textContent = Date.now() - powerArmed < 5000 ? '确认关机' : '关机';
  $('powerBtn').classList.toggle('armed', Date.now() - powerArmed < 5000);
}
$('powerBtn').addEventListener('click', async () => {
  if (Date.now() - powerArmed > 5000) {
    powerArmed = Date.now();
    renderPower();
    setTimeout(renderPower, 5100);
    return toast('关机后要拔掉电源，等 30 秒再插上才会开机，再点一下「确认关机」');
  }
  powerArmed = 0;
  renderPower();
  if (DEMO !== null) return toast('演示模式不会真的关机');
  const r = await (await post('/api/power-off', {}))?.json?.();
  if (!r || !r.ok) toast((r && r.error) || '没能关机', 'error');
});
$('settingsClose').addEventListener('click', () => {
  $('settings').classList.remove('on');
  if (!DEMO) postJson('/api/alarm-tone', { stop: true });   // a tone being tried stops with the settings
});
$('reportPill').addEventListener('click', () => { post('/api/reports/play'); toast('马上念给你听'); });

/* ---- right side: welcome screen or conversation ---- */
// The welcome screen (clock) when idle with nothing going on: no messages yet, or the conversation
// is over (the hub closed the connection). The hub keeps the history, so the thread is rarely empty;
// it comes back with the chat page on the next wake. While the connection lasts (~2 minutes) the
// chat page stays. A new conversation shows the chat (and its "listening" bubble) from the wake on.
function welcomeShown(messages, state, connected) {
  return ['idle', 'connecting'].includes(state) && (!messages || !connected);
}
function renderSide() {
  document.body.classList.toggle('fresh', welcomeShown(ui.thread.messages.length, shownState(), !!ui.status.connected));
}

function entryModel(entry) {
  return ui.models.options.find(o => o.entry === entry) || ui.models.current;
}

function renderHead() {
  const m = entryModel(ui.thread.entry);
  $('headLogo').src = logoSrc(m);
  $('headTitle').textContent = m ? `与 ${m.label} 的对话` : '对话';
  const n = ui.thread.messages.length;
  $('headMeta').textContent = n ? `${n} 条消息 · ${ui.status.connected ? '对话中' : '记录已保存'}` : '新对话';
}

function fmtTime(t) {
  const d = new Date(t * 1000);
  return pad(d.getHours()) + ':' + pad(d.getMinutes());
}

// A reply grows sentence by sentence; the text just shows as it is (no per-sentence highlight)
function fmtClock(t) {
  const n = Number(t) || 0;
  if (!n) return '--:--';
  const d = new Date(n * 1000);
  return pad(d.getHours()) + ':' + pad(d.getMinutes());
}

function fillMsg(el, m) {
  const html = esc(m.text) + (m.interrupted ? '<span class="cut">已打断</span>' : '') +
    `<span class="ts"><span class="ts-time">${fmtClock(m.time)}</span></span>`;
  if (m.role === 'bot') el.querySelector('.body').innerHTML = html;
  else el.querySelector('.bubble').innerHTML = html;
}

function msgEl(m) {
  const el = document.createElement('div');
  el.className = 'msg ' + m.role;
  el.dataset.id = m.id;
  if (m.role === 'bot') {
    el.innerHTML = `<img class="tile" src="${esc(logoSrc(entryModel(m.entry)))}" alt=""><div class="body"></div>`;
  } else if (m.role === 'user') {
    el.innerHTML = '<div class="bubble"></div>' +
      '<button class="msg-retry" type="button" aria-label="重新发送这条消息" title="重新发送">↻</button>';
  }
  fillMsg(el, m);
  return el;
}

function scrollDown() {
  const box = $('messages');
  box.scrollTop = box.scrollHeight;
}

function renderThread() {
  const box = $('messages');
  box.textContent = '';
  for (const m of ui.thread.messages) {
    const el = msgEl(m);
    el.style.animation = 'none';
    box.appendChild(el);
  }
  markLive();
  renderHead();
  renderSide();
  renderPending();
  scrollDown();
}

function upsertMessage(m) {
  if (m.entry !== ui.thread.entry) return;
  const i = ui.thread.messages.findIndex(x => x.id === m.id);
  const box = $('messages');
  if (i >= 0) {
    ui.thread.messages[i] = m;
    const el = box.querySelector(`[data-id="${m.id}"]`);
    if (el) fillMsg(el, m);
  } else {
    ui.thread.messages.push(m);
    box.insertBefore(msgEl(m), $('pending'));
  }
  markLive();
  renderHead();
  renderSide();
  scrollDown();
}

function markLive() {
  // the reply being spoken right now: its logo gets a ring
  const box = $('messages');
  box.querySelectorAll('.live').forEach(el => el.classList.remove('live'));
  const last = ui.thread.messages[ui.thread.messages.length - 1];
  if (ui.status.state === 'speaking' && last && last.role === 'bot') {
    const el = box.querySelector(`[data-id="${last.id}"]`);
    if (el) el.classList.add('live');
  }
}

// Placeholder at the end of the conversation while the user talks or the model thinks
function renderPending() {
  const shown = shownState();
  // recognising: the user stopped and the hub is turning it into text (it can take a few seconds)
  const kind = ui.status.recognising && !ui.ptt ? 'user recog' : shown === 'listening' ? (ui.ptt ? 'user ptt' : 'user') :
    shown === 'thinking' ? 'bot' : '';
  let el = $('pending');
  if (el && el.dataset.kind === kind) return;
  if (el) el.remove();
  if (!kind) return;
  el = document.createElement('div');
  el.id = 'pending';
  el.dataset.kind = kind;
  el.className = 'msg pending ' + kind;
  if (kind.startsWith('user')) {
    el.innerHTML = `<span class="wave">${'<b></b>'.repeat(5)}</span>${kind === 'user recog' ? '正在识别…' : ui.ptt ? '说完松开' : '正在听…'}`;
  } else {
    el.innerHTML = `<img class="tile" src="${esc(logoSrc(entryModel(ui.thread.entry)))}" alt="">` +
      `<div class="body"><span class="dots"><i></i><i></i><i></i></span><span class="label">正在思考</span></div>`;
  }
  $('messages').appendChild(el);
  scrollDown();
}


function renderNeteaseLogin() {
  const card = $('neteaseLoginCard');
  const data = ui.neteaseLogin;
  if (!data || !data.task) { card.hidden = true; card.textContent = ''; return; }
  const task = data.task;
  card.hidden = false;
  card.textContent = '';
  const title = document.createElement('h3');
  title.textContent = '网易云扫码登录';
  const hasQr = ['waiting_scan', 'scanned'].includes(task.state) &&
    typeof task.qr_data_url === 'string' && task.qr_data_url.startsWith('data:image/png;base64,');
  let image = null;
  if (hasQr) {
    image = document.createElement('img');
    image.className = 'netease-login-qr';
    image.alt = '网易云登录二维码';
    image.src = task.qr_data_url;
  }
  const status = document.createElement('p');
  const labels = { waiting_scan: '请用网易云 App 扫码', scanned: '已扫码，请在手机上确认', succeeded: '登录成功', expired: '二维码已过期', cancelled: '已取消登录', failed: '登录失败' };
  status.textContent = labels[task.state] || '正在准备二维码';
  const account = data.account || {};
  if (task.state === 'succeeded' && account.nickname) status.textContent += `：${account.nickname}`;
  card.append(title);
  if (image) card.append(image);
  card.append(status);
  if (task.state === 'succeeded') {
    const nextStep = document.createElement('p');
    nextStep.textContent = '现在可以说「播放一首歌」或「播放我的歌单」。登录不会自动播放。';
    card.append(nextStep);
  }
  if (task.state === 'waiting_scan' || task.state === 'scanned') {
    const actions = document.createElement('div');
    actions.className = 'netease-login-actions';
    const refresh = document.createElement('button');
    refresh.textContent = '刷新二维码';
    refresh.onclick = () => loginCardAction('refresh', task.id);
    const cancel = document.createElement('button');
    cancel.textContent = '取消';
    cancel.onclick = () => loginCardAction('cancel', task.id);
    actions.append(refresh, cancel);
    card.append(actions);
  }
}

async function loginCardAction(action, taskId) {
  const r = await postJson(`/api/netease/login/${action}`, { action, task_id: taskId });
  if (!r || r.ok === false) toast((r && r.error) || '登录操作失败', 'error');
}
/* ---- overlays ---- */
let toastTimer = null;
function toast(text, kind) {
  const t = $('toast');
  t.textContent = text;
  t.className = 'toast on' + (kind === 'error' ? ' error' : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.className = 'toast' + (kind === 'error' ? ' error' : ''); }, kind === 'error' ? 4500 : 2500);
}

let hudTimer = null;
function showVolume(v) {
  $('hudFill').style.transform = `scaleX(${Math.max(0, Math.min(100, v)) / 100})`;
  $('hudNum').textContent = v;
  $('hud').classList.add('on');
  clearTimeout(hudTimer);
  hudTimer = setTimeout(() => $('hud').classList.remove('on'), 1600);
}


/* ---- now playing ---- */
function fmtTime(sec) {
  sec = Math.max(0, Math.floor(Number(sec) || 0));
  return Math.floor(sec / 60) + ':' + pad(sec % 60);
}
function renderMusic() {
  const m = ui.music;
  const on = !!(m && m.title && m.state !== 'stopped');
  $('player').hidden = !on;
  document.body.classList.toggle('has-player', on);
  if (!on) {
    if (ui.playerOpen) closePlayer();
    return;
  }

  const artists = (m.artists || []).join(' / ');
  const metaKey = [m.id, m.title, artists, m.album, m.paused].join('|');
  if (ui.metaKey !== metaKey) {
    ui.metaKey = metaKey;
    $('playerTitle').textContent = m.title || '';
    $('playerArtist').textContent = artists;
    $('playerToggle').classList.toggle('paused', !!m.paused);
    $('playerToggle').setAttribute('aria-label', m.paused ? '继续' : '暂停');
    if (ui.playerOpen) {
      $('pfTitle').textContent = m.title || '';
      $('pfArtist').textContent = artists;
      $('pfAlbum').textContent = m.album || '';
      $('pfToggle').classList.toggle('paused', !!m.paused);
      $('pfToggle').setAttribute('aria-label', m.paused ? '继续' : '暂停');
    }
  }

  const artKey = [m.id, m.cover || ''].join('|');
  if (ui.barArtKey !== artKey) {
    ui.barArtKey = artKey;
    const bar = $('playerCoverImg');
    if (m.cover) bar.src = m.cover; else bar.removeAttribute('src');
  }
  if (ui.playerOpen && ui.pfArtKey !== artKey) {
    ui.pfArtKey = artKey;
    const img = $('pfCover');
    if (m.cover) img.src = m.cover; else img.removeAttribute('src');
    $('pfBg').style.backgroundImage = m.cover ? 'url("' + m.cover + '")' : '';
  }

  const dur = Number(m.duration) || 0, pos = Number(m.position) || 0;
  const ratio = dur ? Math.min(1, pos / dur) : 0;
  $('playerFill').style.transform = 'scaleX(' + ratio + ')';
  $('playerPos').textContent = fmtTime(pos);
  $('playerDur').textContent = fmtTime(dur);

  if (!ui.playerOpen) return;
  $('pfFill').style.transform = 'scaleX(' + ratio + ')';
  $('pfKnob').style.left = (ratio * 100) + '%';
  $('pfPos').textContent = fmtTime(pos);
  $('pfDur').textContent = fmtTime(dur);
  renderLyrics();
}

/* ---- full-screen player, lyrics and queue/playlist drawer ---- */
let lyricsReq = null;
let playlistsReq = false;
let lastLyricIndex = -1;
let seekDrag = false;

function prefersReducedMotion() {
  return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
}

function animatePlayerIn() {
  if (!window.anime || prefersReducedMotion()) return;
  const A = window.anime;
  try {
    const tl = A.createTimeline({ defaults: { duration: 420, ease: 'out(3)' } });
    tl.add('#pf .pf-art', { scale: [0.88, 1], opacity: [0.7, 1], duration: 520 }, 0)
      .add('#pf .pf-title', { translateY: [18, 0], opacity: [0.6, 1] }, 70)
      .add('#pf .pf-artist', { translateY: [12, 0], opacity: [0.6, 1] }, 120)
      .add('#pf .pf-album', { translateY: [10, 0], opacity: [0.6, 1] }, 150)
      .add('#pf .pf-progress', { translateY: [10, 0], opacity: [0.6, 1] }, 180)
      .add('#pf .pf-times', { opacity: [0.6, 1] }, 210)
      .add('#pf .pf-controls', { translateY: [12, 0], opacity: [0.6, 1] }, 220)
      .add('#pf .pf-right', { translateY: [16, 0], opacity: [0.65, 1], duration: 480 }, 80);
  } catch (_) { /* keep the player visible if the animation engine fails */ }
}

function animateLyricLine() {
  if (!window.anime || prefersReducedMotion() || ui.lyricsFull) return;
  const A = window.anime;
  try {
    A.animate('#pfCurLine', { opacity: [0.45, 1], translateY: [10, 0], duration: 320, ease: 'out(3)' });
    A.animate('#pfTrans', { opacity: [0.45, 1], translateY: [6, 0], duration: 320, ease: 'out(3)' });
  } catch (_) { /* ignore */ }
}

function animateDrawerItems() {
  if (!window.anime || prefersReducedMotion()) return;
  if (!$('pfDrawer').classList.contains('on')) return;
  // only the first screenful: 60+ staggered items is a visible jank on this GPU
  const items = [...document.querySelectorAll('#pfList .pf-item')].slice(0, 12);
  if (!items.length) return;
  try {
    window.anime.animate(items, { opacity: [0.5, 1], translateY: [10, 0],
      delay: window.anime.stagger(24), duration: 220, ease: 'out(3)' });
  } catch (_) { /* ignore */ }
}

function openPlayer() {
  const m = ui.music;
  if (!m || !m.title || m.state === 'stopped') return;
  ui.playerOpen = true;
  document.body.classList.add('player-open');
  ui.metaKey = '';
  ui.pfArtKey = '';
  $('pf').style.display = 'flex';
  void $('pf').offsetHeight;
  $('pf').classList.add('on');
  $('pf').setAttribute('aria-hidden', 'false');
  renderMusic();
  renderLyrics();
  if (!ui.lyrics || ui.lyrics.id !== m.id) requestLyrics();
  animatePlayerIn();
}

function closePlayer() {
  ui.playerOpen = false;
  document.body.classList.remove('player-open');
  ui.lyricsFull = false;
  $('pf').classList.remove('on');
  $('pf').classList.remove('lyrics-full');
  $('pf').setAttribute('aria-hidden', 'true');
  ui.pfArtKey = '';
  closeDrawer();
  setTimeout(() => {
    if (!ui.playerOpen) {
      $('pf').style.display = 'none';
      $('pfBg').style.backgroundImage = '';
      $('pfCover').removeAttribute('src');
    }
  }, 450);
}

function requestLyrics() {
  const m = ui.music;
  if (!m || !m.id) return;
  if (ui.lyrics && ui.lyrics.id === m.id) return;
  if (lyricsReq === m.id) return;
  lyricsReq = m.id;
  post('/api/music', { action: 'lyrics', value: m.id });
  setTimeout(() => { if (lyricsReq === m.id) lyricsReq = null; }, 8000);
}

function parseLrc(text) {
  const out = [];
  for (const raw of String(text || '').split(/\r?\n/)) {
    const stamps = [...raw.matchAll(/\[(\d+):(\d+(?:\.\d+)?)\]/g)];
    if (!stamps.length) continue;
    const body = raw.replace(/\[[^\]]*\]/g, '').trim();
    if (!body) continue;
    for (const st of stamps) out.push({ t: (+st[1]) * 60 + (+st[2]), text: body });
  }
  out.sort((a, b) => a.t - b.t);
  return out;
}

function buildAllLyrics() {
  const lyr = ui.lyrics;
  const box = $('pfAll');
  if (!lyr || !lyr.lines.length) { box.innerHTML = ''; box.dataset.id = ''; return; }
  box.innerHTML = lyr.lines.map((l, i) =>
    '<div class="pf-all-line" data-i="' + i + '">' + esc(l.text || '') +
    (l.tr ? '<small>' + esc(l.tr) + '</small>' : '') + '</div>').join('');
  box.dataset.id = String(lyr.id);
}

function renderLyrics() {
  const m = ui.music;
  const lyr = ui.lyrics;
  if (!m) return;
  if (!lyr || lyr.id !== m.id || !lyr.lines.length) {
    $('pfPrevLine').textContent = '';
    $('pfCurLine').textContent = m.title ? '暂无歌词' : '';
    $('pfNextLine').textContent = '';
    $('pfTrans').textContent = '';
    $('pfAll').innerHTML = '';
    $('pfAll').dataset.id = '';
    lastLyricIndex = -1;
    return;
  }
  const pos = Number(m.position) || 0;
  let i = 0;
  while (i + 1 < lyr.lines.length && lyr.lines[i + 1].t <= pos) i++;
  const cur = lyr.lines[i];
  $('pfPrevLine').textContent = i > 0 ? lyr.lines[i - 1].text : '';
  $('pfCurLine').textContent = cur ? cur.text : '';
  $('pfNextLine').textContent = i + 1 < lyr.lines.length ? lyr.lines[i + 1].text : '';
  $('pfTrans').textContent = (cur && cur.tr) || '';
  if (lastLyricIndex !== i && !ui.lyricsFull) animateLyricLine();
  if (ui.lyricsFull) {
    if ($('pfAll').dataset.id !== String(lyr.id)) buildAllLyrics();
    if (lastLyricIndex !== i) {
      const all = $('pfAll');
      const old = all.querySelector('.pf-all-line.active');
      if (old) old.classList.remove('active');
      const el = all.querySelector('[data-i="' + i + '"]');
      if (el) { el.classList.add('active'); el.scrollIntoView({ block: 'center' }); }
    }
  }
  lastLyricIndex = i;
}

function toggleLyrics() {
  ui.lyricsFull = !ui.lyricsFull;
  $('pf').classList.toggle('lyrics-full', ui.lyricsFull);
  if (ui.lyricsFull) { buildAllLyrics(); lastLyricIndex = -1; renderLyrics(); }
}

function requestPlaylists() {
  if (playlistsReq || ui.playlists !== null) return;
  playlistsReq = true;
  post('/api/music', { action: 'playlists' });
  setTimeout(() => {
    if (ui.playlists === null) {
      ui.playlists = []; playlistsReq = false;
      if (ui.drawerTab === 'playlists') renderDrawer();
    }
  }, 8000);
}

function fillDrawer() {
  const list = $('pfList');
  const m = ui.music || {};
  if (ui.drawerTab === 'queue') {
    const items = m.queue_items || [];
    if (!items.length) { list.innerHTML = '<div class="pf-empty">队列是空的</div>'; return; }
    list.innerHTML = items.map((it, i) =>
      '<button class="pf-item' + (i === m.index ? ' on' : '') + '" data-index="' + i + '">' +
      '<span class="pf-item-i">' + (i + 1) + '</span>' +
      '<span class="pf-item-t">' + esc(it.name || '') + '</span>' +
      '<span class="pf-item-a">' + esc((it.artists || []).join(' / ')) + '</span></button>').join('');
    list.querySelectorAll('.pf-item').forEach(b => b.addEventListener('click', () => {
      post('/api/music', { action: 'play_index', value: Number(b.dataset.index) });
      closeDrawer();
    }));
    return;
  }
  if (ui.playlistView) {
    const p = ui.playlistView, tracks = ui.playlistTracks;
    let html = '<button class="pf-item pf-back" id="pfBack">‹ 返回我的歌单</button>';
    html += '<div class="pf-playlist-head">' +
      (p.cover ? '<img src="' + esc(p.cover) + '" alt="">' : '') +
      '<div><b>' + esc(p.name || '') + '</b><small>' + (p.count || 0) + ' 首</small></div></div>';
    if (tracks === null) html += '<div class="pf-empty">加载中…</div>';
    else if (!tracks.length) html += '<div class="pf-empty">没有歌曲</div>';
    else html += tracks.map((t, i) =>
      '<button class="pf-item" data-i="' + i + '">' +
      '<span class="pf-item-i">' + (i + 1) + '</span>' +
      '<span class="pf-item-t">' + esc(t.name || '') + '</span>' +
      '<span class="pf-item-a">' + esc((t.artists || []).join(' / ')) + '</span></button>').join('');
    list.innerHTML = html;
    $('pfBack').addEventListener('click', () => {
      ui.playlistView = null; ui.playlistTracks = null; renderDrawer();
    });
    list.querySelectorAll('.pf-item[data-i]').forEach(b => b.addEventListener('click', () => {
      post('/api/music', { action: 'play_playlist_track', value: p.id + ':' + Number(b.dataset.i) });
      closeDrawer();
    }));
    return;
  }
  if (ui.playlists === null) { list.innerHTML = '<div class="pf-empty">加载中…</div>'; return; }
  if (!ui.playlists.length) { list.innerHTML = '<div class="pf-empty">没有歌单</div>'; return; }
  list.innerHTML = ui.playlists.map(p =>
    '<button class="pf-item" data-id="' + p.id + '">' +
    (p.cover ? '<img src="' + esc(p.cover) + '" alt="">' : '') +
    '<span class="pf-item-t">' + esc(p.name || '') + '</span>' +
    '<span class="pf-item-a">' + (p.count || 0) + ' 首</span></button>').join('');
  list.querySelectorAll('.pf-item').forEach(b => b.addEventListener('click', () => {
    const p = (ui.playlists || []).find(x => String(x.id) === String(b.dataset.id));
    if (!p) return;
    ui.playlistView = p; ui.playlistTracks = null;
    requestPlaylistTracks();
    renderDrawer();
  }));
}

function requestPlaylistTracks() {
  const p = ui.playlistView;
  if (!p) return;
  post('/api/music', { action: 'playlist_tracks', value: p.id });
  setTimeout(() => {
    if (ui.playlistView === p && ui.playlistTracks === null) {
      ui.playlistTracks = []; renderDrawer();
    }
  }, 8000);
}

function renderDrawer() {
  fillDrawer();
  animateDrawerItems();
}

function openDrawer(tab) {
  const changed = ui.drawerTab !== tab;
  ui.drawerTab = tab || ui.drawerTab || 'queue';
  if (changed && ui.drawerTab === 'playlists') { ui.playlistView = null; ui.playlistTracks = null; }
  $('pfDrawer').classList.add('on');
  document.querySelectorAll('.pf-tabs button').forEach(b =>
    b.classList.toggle('on', b.dataset.tab === ui.drawerTab));
  renderDrawer();
  if (ui.drawerTab === 'playlists') requestPlaylists();
}

function closeDrawer() {
  $('pfDrawer').classList.remove('on');
}

function seekAt(clientX, commit) {
  const m = ui.music;
  if (!m) return;
  const r = $('pfProgress').getBoundingClientRect();
  const ratio = Math.max(0, Math.min(1, (clientX - r.left) / r.width));
  const dur = Number(m.duration) || 0;
  const pos = ratio * dur;
  m.position = pos;
  $('pfFill').style.transform = 'scaleX(' + ratio + ')';
  $('pfKnob').style.left = (ratio * 100) + '%';
  $('pfPos').textContent = fmtTime(pos);
  if (commit) post('/api/music', { action: 'seek', value: Math.round(pos) });
}

/* ---- events from the client ---- */
const handlers = {
  snapshot(s) {
    if (ui.build && s.build && s.build !== ui.build) return location.reload();
    ui.build = s.build;
    ui.status = s.status; ui.models = server.models = s.models; ui.thread = server.thread = s.thread;
    switching = null;
    for (const k in seenThreads) delete seenThreads[k];
    seenThreads[s.thread.entry] = s.thread.messages;
    if (s.update) { ui.version = s.version; ui.update = s.update; }
    if (s.alarms) ui.alarms = s.alarms;
    if (s.music !== undefined) { ui.music = s.music; renderMusic(); }
    if (s.netease_login !== undefined) { ui.neteaseLogin = s.netease_login; renderNeteaseLogin(); }
    renderModels(); renderThread(); renderStatus(); renderAlarms();
    updateFinished((s.update || {}).job);
  },
  netease_login(data) {
    ui.neteaseLogin = data;
    renderNeteaseLogin();
    if (data.task && data.task.state === 'succeeded') toast(`网易云已登录${data.account && data.account.nickname ? '：' + data.account.nickname : ''}`);
    scrollDown();
  },
  power(p) { $('powerOff').classList.toggle('on', p.state === 'off'); },
  update(u) { ui.update = u; renderUpdate(); updateFinished(u.job); },
  state(s) { ui.status = s; renderStatus(); markLive(); renderHead(); },
  model(m) {
    server.models = m;
    if (switching && (!m.current || m.current.entry !== switching)) return;
    ui.models = m; renderModels(); renderStatus();
  },
  thread(t) {
    server.thread = t;
    if (t.reset) for (const k in seenThreads) delete seenThreads[k];
    seenThreads[t.entry] = t.messages;
    if (switching && t.entry !== switching) return;
    ui.thread = t; renderThread();
  },
  message: m => upsertMessage(m),
  toast: t => toast(t.text, t.kind),
  volume(v) {
    if (!v.ring) { ui.status.volume = v.volume; renderVol(); }
    if (v.source !== 'page') showVolume(v.volume);
  },
  alarms(a) { ui.alarms = a; renderAlarms(); },
  music(m) {
    const old = ui.music && ui.music.id;
    ui.music = m;
    if (m.id && m.id !== old) {
      ui.lyrics = null; lyricsReq = null; lastLyricIndex = -1;
      if (ui.playerOpen) requestLyrics();
    }
    renderMusic();
  },
  music_lyrics(m) {
    if (!ui.music || m.id !== ui.music.id) return;
    const lines = parseLrc(m.lrc);
    const tr = new Map(parseLrc(m.tlyric).map(l => [Math.round(l.t * 10), l.text]));
    for (const l of lines) l.tr = tr.get(Math.round(l.t * 10)) || '';
    ui.lyrics = { id: m.id, lines };
    lyricsReq = null; lastLyricIndex = -1;
    if (ui.playerOpen) renderLyrics();
  },
  music_playlists(m) {
    ui.playlists = m.items || []; playlistsReq = false;
    if (ui.drawerTab === 'playlists') renderDrawer();
  },
  music_playlist_tracks(m) {
    if (!ui.playlistView || m.playlist !== ui.playlistView.id) return;
    ui.playlistTracks = m.items || [];
    if (ui.drawerTab === 'playlists') renderDrawer();
  },
  music_error(m) {
    toast(m.message || '操作失败', 'error');
    lyricsReq = null; playlistsReq = false;
    if (ui.playlists === null) ui.playlists = [];
    if (ui.playlistTracks === null) ui.playlistTracks = [];
    if (ui.lyrics === null && ui.music) ui.lyrics = { id: ui.music.id, lines: [] };
    if (ui.drawerTab === 'playlists') renderDrawer();
  },
  level(l) { level.target = ui.status.state === 'speaking' ? Math.min(1, l.out * 6) : micLevel(l.mic); },
};

function connectEvents() {
  const es = new EventSource('/events');
  for (const [name, fn] of Object.entries(handlers)) es.addEventListener(name, e => fn(JSON.parse(e.data)));
}

/* ---- buttons ---- */
$('playerToggle').addEventListener('click', () => post('/api/music', { action: ui.music && ui.music.paused ? 'resume' : 'pause' }));
$('playerPrev').addEventListener('click', () => post('/api/music', { action: 'prev' }));
$('playerNext').addEventListener('click', () => post('/api/music', { action: 'next' }));
let resending = false;
function resendMessage(m) {
  const text = (m.text || '').trim();
  if (!text || resending) return;
  resending = true;
  toast('已重新发送');
  Promise.resolve(post('/api/text', { text })).finally(() => { resending = false; });
}
$('messages').addEventListener('click', e => {
  const btn = e.target.closest('.msg-retry');
  if (!btn) return;
  const el = btn.closest('.msg');
  const m = (ui.thread.messages || []).find(x => String(x.id) === String(el.dataset.id));
  if (m) resendMessage(m);
});
$('player').addEventListener('click', e => { if (!e.target.closest('button')) openPlayer(); });
$('pfClose').addEventListener('click', closePlayer);
$('pfListBtn').addEventListener('click', () => {
  if ($('pfDrawer').classList.contains('on')) closeDrawer(); else openDrawer('queue');
});
$('pfDrawerClose').addEventListener('click', closeDrawer);
document.querySelectorAll('.pf-tabs button').forEach(b =>
  b.addEventListener('click', () => openDrawer(b.dataset.tab)));
$('pfToggle').addEventListener('click', () => post('/api/music', { action: ui.music && ui.music.paused ? 'resume' : 'pause' }));
$('pfPrev').addEventListener('click', () => post('/api/music', { action: 'prev' }));
$('pfNext').addEventListener('click', () => post('/api/music', { action: 'next' }));
$('pfLyrics').addEventListener('click', toggleLyrics);
$('pfAll').addEventListener('click', toggleLyrics);
$('pfProgress').addEventListener('pointerdown', e => {
  seekDrag = true;
  try { $('pfProgress').setPointerCapture(e.pointerId); } catch (_) {}
  seekAt(e.clientX, false);
});
$('pfProgress').addEventListener('pointermove', e => { if (seekDrag) seekAt(e.clientX, false); });
$('pfProgress').addEventListener('pointerup', e => {
  if (!seekDrag) return;
  seekDrag = false;
  seekAt(e.clientX, true);
});
$('pfProgress').addEventListener('pointercancel', () => { seekDrag = false; });
function post(path, body) {
  if (DEMO) return demo.action(path, body);
  const opts = { method: 'POST' };
  if (body) Object.assign(opts, { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return fetch(path, opts).catch(() => toast('客户端没有响应', 'error'));
}

// Mic: a tap wakes (or interrupts a reply and listens); holding it is push-to-talk
let holdTimer = null;
function pttStart() {
  ui.ptt = true;
  $('btnMic').classList.add('hold');
  renderStatus();
}
function pttEnd() {
  ui.ptt = false;
  $('btnMic').classList.remove('hold');
  renderStatus();
}
$('btnMic').addEventListener('pointerdown', e => {
  e.preventDefault();
  holdTimer = setTimeout(() => {
    holdTimer = null;
    pttStart();
    post('/api/ptt/start');
  }, 350);
});
function release() {
  if (holdTimer) {
    clearTimeout(holdTimer);
    holdTimer = null;
    post('/api/wake');
  } else if (ui.ptt) {
    pttEnd();
    post('/api/ptt/stop');
  }
}
$('btnMic').addEventListener('pointerup', release);
$('btnMic').addEventListener('pointercancel', release);
$('btnMic').addEventListener('pointerleave', () => { if (ui.ptt) release(); });
$('btnAbort').addEventListener('click', () => post('/api/abort'));
$('btnEnd').addEventListener('click', () => { post('/api/end'); toast('对话已结束，聊天记录已保存'); });
$('modelPill').addEventListener('click', () => openSheet(true));
$('sheetClose').addEventListener('click', () => openSheet(false));
document.addEventListener('contextmenu', e => e.preventDefault());

for (const [q, bg, fg, icon] of SUGGEST) {
  const b = document.createElement('button');
  b.className = 'chip';
  b.innerHTML = `<i style="background:${bg};color:${fg}"><svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor"
    stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${icon}</svg></i>${esc(q)}`;
  b.addEventListener('click', () => post('/api/text', { text: q }));
  $('chips').appendChild(b);
}

/* ---- demo: fake client for previewing the page on a desktop browser ---- */
const demo = DEMO === null ? null : (() => {
  const M = (label, model, logo, company, vendor) => ({ kind: 'llm', vendor, label, model, logo, company, entry: 'llm:' + vendor });
  const options = [
    M('Claude', 'claude-sonnet-4-5', 'claude-color', 'Anthropic', 'claude'),
    M('DeepSeek', 'deepseek-chat', 'deepseek-color', 'DeepSeek', 'deepseek'),
    M('通义千问', 'qwen-max', 'qwen-color', '阿里通义', 'qwen'),
    M('豆包', 'doubao-1.5-pro', 'doubao-color', '字节豆包', 'doubao'),
    M('Gemini', 'gemini-2.5-flash', 'gemini-color', 'Google', 'gemini'),
    M('Kimi', 'kimi-k2', 'kimi-color', '月之暗面', 'kimi'),
    M('GPT', 'gpt-4.1', 'openai', 'OpenAI', 'openai'),
    M('智谱 GLM', 'glm-4.6', 'zhipu-color', '智谱', 'glm'),
  ];
  let seq = 0, bot = null, timer = null, stopped = false;
  const threads = {};
  const entry = () => ui.models.current.entry;
  const now = () => Date.now() / 1000;
  const state = (s, connected = true) => handlers.state({ state: s, connected, uploading: s === 'listening' });
  const say = (role, text) => {
    const m = { id: ++seq, role, text, time: now(), entry: entry() };
    (threads[m.entry] = threads[m.entry] || []).push(m);
    handlers.message({ ...m });
    return m;
  };
  const sentence = text => {
    if (!bot) { state('speaking'); bot = say('bot', text); return; }
    bot.text += text;
    handlers.message({ ...bot });
  };
  const done = (cut) => {
    if (bot && cut) { bot.interrupted = true; handlers.message({ ...bot }); }
    bot = null;
  };

  // fake microphone / speaker levels: syllable-like bursts
  setInterval(() => {
    const t = performance.now() / 1000;
    const v = Math.max(0, Math.abs(Math.sin(t * 6.3)) * (.55 + .45 * Math.sin(t * 1.7)) + (Math.random() - .5) * .25);
    handlers.level({ mic: v * .07, out: v * .17 });
  }, 100);

  const tones = { coffee: '咖啡时光', morning: '晨曦', bright: '元气早晨', hop: '阳光小跳跃', marimba: '清晨木琴' };
  const alarmsDemo = () => ({
    synced: true, volume: 70, tone: 'coffee', tones, ringing: null,
    items: [
      { id: 3, kind: 'timer', type: '倒计时', label: '煮鸡蛋', at: now() + 271, repeat: '', snoozed: false },
      { id: 1, kind: 'alarm', type: '闹钟', label: '起床', at: now() + 9 * 3600, repeat: '每个工作日（周一到周五）', snoozed: false },
      { id: 2, kind: 'reminder', type: '提醒', label: '晾衣服', at: now() + 26 * 3600, repeat: '', snoozed: false, spoken: true },
    ],
    missed: [{ kind: 'reminder', label: '吃药', at: now() - 3 * 3600, why: 'unanswered', noted: now() - 3 * 3600 },
             { kind: 'alarm', label: '起床', at: now() - 20 * 3600, why: 'off', noted: now() - 20 * 3600 }],
  });
  const steps = [
    ['idle', 4000, () => {
      handlers.snapshot({ status: { state: 'idle', connected: false, uploading: false, volume: 60 }, alarms: alarmsDemo(),
                          models: { current: options[0], options }, thread: { entry: options[0].entry, messages: [] } });
    }],
    ['settings', 3000, () => $('settings').classList.add('on')],
    [null, 300, () => $('settings').classList.remove('on')],
    ['ring', 4000, () => handlers.alarms(Object.assign(alarmsDemo(), {
      ringing: { items: [alarmsDemo().items[1]], notes: [], started: now() } }))],
    [null, 300, () => handlers.alarms(alarmsDemo())],
    ['connecting', 1600, () => state('connecting', false)],
    ['listening', 3200, () => state('listening')],
    [null, 500, () => say('user', '明天北京天气怎么样？适合去爬山吗？')],
    ['thinking', 2600, () => state('thinking')],
    [null, 1700, () => sentence('明天北京晴转多云，气温 9 到 19 度，')],
    [null, 1700, () => sentence('北风二三级，空气质量良。')],
    ['speaking', 2200, () => sentence('这样的天气很适合去爬山，香山的红叶正是最好看的时候。')],
    [null, 2400, () => sentence('早晚温差比较大，记得带一件薄外套。')],
    [null, 2600, () => { done(); state('listening'); }],
    [null, 500, () => say('user', '那推荐一条人少一点的路线吧')],
    [null, 2000, () => state('thinking')],
    [null, 1800, () => sentence('可以试试从北京植物园进山，走樱桃沟到鬼笑石，')],
    ['chat', 2400, () => sentence('人比东门少很多，沿途还有溪水和水杉林。')],
    ['cut', 1400, () => { done(true); state('idle'); }],
    ['models', 3200, () => openSheet(true)],
    [null, 600, () => switchTo(options[1])],
    ['volume', 2400, () => showVolume(60)],
    ['ptt', 2600, () => { pttStart(); state('listening'); }],
    [null, 400, () => { pttEnd(); say('user', '用一句话介绍一下你自己'); state('thinking'); }],
    [null, 1800, () => sentence('我是小麦，住在这块屏幕里的语音助手，有问题随时叫我。')],
    [null, 3200, () => { done(); state('idle'); }],
    [null, 3000, () => { state('idle', false); toast('对话已结束，聊天记录已保存'); }],
  ];

  function switchTo(m) {
    openSheet(false);
    handlers.model({ current: m, options });
    handlers.thread({ entry: m.entry, messages: (threads[m.entry] || []).slice() });
    toast(`已切换到 ${m.label}`);
  }

  function run(i, jump) {
    if (stopped) return;
    const [name, wait, fn] = steps[i % steps.length];
    if (i % steps.length === 0) { seq = 0; for (const k in threads) delete threads[k]; }
    fn();
    if (jump && name === jump) return;          // ?demo=<scene>: stop on that scene
    if (jump) return run(i + 1, jump);
    timer = setTimeout(() => run(i + 1), wait);
  }

  // tapping around stops the script and lets the buttons do something plausible
  function action(path, body) {
    stopped = true;
    clearTimeout(timer);
    const answer = q => {
      say('user', q);
      state('thinking');
      timer = setTimeout(() => {
        sentence('这是演示模式，');
        timer = setTimeout(() => { sentence('真正的回答要连上客户端才有哦。'); timer = setTimeout(() => { done(); state('idle'); }, 2600); }, 1500);
      }, 1600);
    };
    if (path === '/api/wake') state('listening');
    else if (path === '/api/ptt/start') state('listening');
    else if (path === '/api/ptt/stop') answer('（按住说话的内容）');
    else if (path === '/api/text') answer(body.text);
    else if (path === '/api/abort') { done(true); state('idle'); }
    else if (path === '/api/end') { done(); state('idle', false); }
    else if (path.startsWith('/api/alarms/')) handlers.alarms(Object.assign({}, ui.alarms, { ringing: null }));
    return Promise.resolve();
  }

  return { start: () => run(0, DEMO === 'music' ? null : (DEMO || null)), action, switchTo };
})();

tick();
setInterval(tick, 1000);
if (new URLSearchParams(location.search).has('status')) setTimeout(openStatus, 500);
// one-shot blink instead of an infinite compositor animation (the kiosk UI process was
// committing frames at 60 fps around the clock just for a 5 s eye blink)
setInterval(() => {
  if (document.body.dataset.state !== 'idle') return;
  const eyes = document.querySelectorAll('.eye');
  eyes.forEach(el => el.classList.add('blink'));
  setTimeout(() => eyes.forEach(el => el.classList.remove('blink')), 150);
}, 5200);
renderStatus();
renderThread();
function startMusicPreview() {
  const queue = [
    { id: 1, name: '测试歌曲一', artists: ['测试歌手'] },
    { id: 2, name: '测试歌曲二', artists: ['测试歌手'] },
    { id: 3, name: '测试歌曲三', artists: ['测试歌手'] },
  ];
  handlers.music({
    state: 'playing', id: 1, title: '测试歌曲一', artists: ['测试歌手'],
    album: '预览专辑', cover: '', duration: 300, paused: false,
    position: 12, queue: queue.length, index: 0, queue_items: queue,
  });
  handlers.music_lyrics({
    id: 1,
    lrc: '[00:00.00]第一句歌词\n[00:12.00]第二句歌词\n[00:24.00]第三句歌词\n[00:36.00]第四句歌词\n[00:48.00]第五句歌词\n',
    tlyric: '',
  });
  handlers.music_playlists({ items: [
    { id: 11, name: '我喜欢的音乐', cover: '', count: 63 },
    { id: 12, name: '夜间电台', cover: '', count: 28 },
  ] });
  openPlayer();
}

if (demo) {
  if (DEMO === 'music') setTimeout(startMusicPreview, 300);
  demo.start();
} else connectEvents();
