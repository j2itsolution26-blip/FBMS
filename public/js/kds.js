// Kitchen display: live tickets with age colouring, station filter, bump flow.
import { api, h, $, pad, toastError, liveEvents, startClock, requireSession, logout, ORDER_TYPES, store } from './core.js';

requireSession(['kitchen', 'cashier', 'manager', 'admin']);
const STATIONS = ['all', 'grill', 'fryer', 'assembly', 'drinks', 'dessert'];
let station = store.get('fbms.kds.station') || 'all';
let tickets = [];
let cfg = { kds_warn_minutes: 5, kds_late_minutes: 10 };
let soundOn = false;
let audio;
const seen = new Set();
const struck = new Set(store.get('fbms.kds.struck') || []);

function beep() {
  if (!soundOn) return;
  audio ||= new AudioContext();
  const o = audio.createOscillator();
  const g = audio.createGain();
  o.frequency.value = 880;
  g.gain.setValueAtTime(0.25, audio.currentTime);
  g.gain.exponentialRampToValueAtTime(0.001, audio.currentTime + 0.4);
  o.connect(g).connect(audio.destination);
  o.start();
  o.stop(audio.currentTime + 0.4);
}

function renderStations() {
  $('#stations').innerHTML = STATIONS.map((s) => `<button data-s="${s}" class="${s === station ? 'on' : ''}">${s}</button>`).join('');
}
$('#stations').onclick = (e) => {
  const b = e.target.closest('[data-s]');
  if (!b) return;
  station = b.dataset.s;
  store.set('fbms.kds.station', station);
  renderStations();
  load();
};

const ageMin = (t) => (Date.now() - new Date(t.sent_at).getTime()) / 60000;
const mmss = (min) => { const s = Math.max(0, Math.floor(min * 60)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };

function render() {
  const board = $('#board');
  if (!tickets.length) { board.innerHTML = '<div class="empty">✨ All caught up — no open tickets</div>'; renderStats(); return; }
  board.innerHTML = tickets.map((t) => {
    const age = ageMin(t);
    const cls = t.kitchen_status === 'ready' ? 'ready' : age >= cfg.kds_late_minutes ? 'late' : age >= cfg.kds_warn_minutes ? 'warn' : 'fresh';
    const action = { queued: ['preparing', '▶ Start'], preparing: ['ready', '✓ Ready'], ready: ['served', '📦 Picked up'] }[t.kitchen_status];
    return `<article class="kt ${cls}" data-id="${t.id}">
      <div class="kt-head"><span class="no">${pad(t.order_no)}</span>
        <span class="meta">${h(ORDER_TYPES[t.type])}${t.table_name ? ` · ${h(t.table_name)}` : ''}${t.source === 'kiosk' ? ' · KIOSK' : ''}<br>${t.customer_name ? h(t.customer_name) : h(t.kitchen_status.toUpperCase())}</span>
        <span class="timer" data-sent="${h(t.sent_at)}">${mmss(age)}</span></div>
      <div class="kt-lines">${t.lines.map((l) => `<div class="kl ${struck.has(l.id) ? 'done' : ''}" data-line="${l.id}"><span class="q">${l.qty}×</span><div><div class="n">${h(l.name)}</div>
        ${l.modifiers.length ? `<div class="m">${l.modifiers.map((m) => h(m.name)).join(' · ')}</div>` : ''}${l.notes ? `<div class="note">⚠ ${h(l.notes)}</div>` : ''}</div></div>`).join('')}</div>
      ${t.notes ? `<div class="kt-note">📝 ${h(t.notes)}</div>` : ''}
      <div class="kt-foot">${t.kitchen_status === 'ready' ? `<button class="btn" data-go="preparing">↺ Recall</button>` : ''}<button class="btn ${t.kitchen_status === 'preparing' ? 'success' : 'warn'}" data-go="${action[0]}">${action[1]}</button></div>
    </article>`;
  }).join('');
  renderStats();
}

function renderStats() {
  const c = (s) => tickets.filter((t) => t.kitchen_status === s).length;
  const late = tickets.filter((t) => t.kitchen_status !== 'ready' && ageMin(t) >= cfg.kds_late_minutes).length;
  $('#kstats').innerHTML = `<span class="badge info">Queued ${c('queued')}</span><span class="badge warn">Cooking ${c('preparing')}</span><span class="badge ok">Ready ${c('ready')}</span>${late ? `<span class="badge bad">Late ${late}</span>` : ''}`;
}

async function load() {
  try {
    tickets = await api('GET', `/api/kds${station === 'all' ? '' : `?station=${station}`}`);
    let fresh = false;
    for (const t of tickets) if (!seen.has(t.id)) { seen.add(t.id); fresh = true; }
    if (fresh) beep();
    render();
  } catch (e) { toastError(e); }
}

$('#board').onclick = async (e) => {
  const go = e.target.closest('[data-go]');
  const card = e.target.closest('[data-id]');
  if (go && card) {
    go.disabled = true;
    try { await api('POST', `/api/kds/${card.dataset.id}/status`, { status: go.dataset.go }); await load(); }
    catch (err) { go.disabled = false; toastError(err); }
    return;
  }
  // Tap a line to strike it through as it's plated (local to this screen).
  const line = e.target.closest('[data-line]');
  if (line) {
    const id = Number(line.dataset.line);
    if (struck.has(id)) struck.delete(id); else struck.add(id);
    store.set('fbms.kds.struck', [...struck].slice(-500));
    line.classList.toggle('done');
  }
};

$('#sound').onclick = () => {
  soundOn = !soundOn;
  $('#sound').textContent = soundOn ? '🔔 Sound on' : '🔇 Sound off';
  if (soundOn) beep();
};
$('#out').onclick = logout;

setInterval(() => {
  for (const el of document.querySelectorAll('[data-sent]')) el.textContent = mmss((Date.now() - new Date(el.dataset.sent).getTime()) / 60000);
}, 1000);
setInterval(render, 30000);
setInterval(load, 20000);

startClock($('#clock'));
renderStations();
api('GET', '/api/public/config').then((c) => { cfg = c; }).catch(() => {});
load();
liveEvents((ev) => { if (ev.type !== 'order.created') load(); }, (ok) => {
  $('#live').className = `badge ${ok ? 'ok' : 'bad'}`;
  $('#live').textContent = ok ? '● live' : '● reconnecting';
});
