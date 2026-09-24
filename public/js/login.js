import { api, session, h, $, toastError, keypad, store, publicConfig } from './core.js';

const HOME = { admin: '/admin', manager: '/admin', cashier: '/pos', kitchen: '/kds' };
const APPS = [
  { href: '/pos', ico: '🧾', name: 'POS Terminal', desc: 'Counter, drive-thru, dine-in', roles: ['cashier', 'manager', 'admin'] },
  { href: '/kds', ico: '👨‍🍳', name: 'Kitchen Display', desc: 'Live tickets & bump bar', roles: ['kitchen', 'cashier', 'manager', 'admin'] },
  { href: '/admin', ico: '📊', name: 'Back Office', desc: 'Sales, menu, inventory, staff', roles: ['manager', 'admin'] },
  { href: '/queue', ico: '📺', name: 'Now Serving Board', desc: 'Customer-facing display', roles: ['kitchen', 'cashier', 'manager', 'admin'] },
  { href: '/kiosk', ico: '🖐️', name: 'Self-Order Kiosk', desc: 'Customer self-service', roles: ['cashier', 'manager', 'admin'] },
];
const next = new URLSearchParams(location.search).get('next');
const termInput = $('#terminal');
termInput.value = store.get('fbms.terminal') || 'POS-1';
termInput.onchange = () => store.set('fbms.terminal', termInput.value.trim() || 'POS-1');


function afterLogin(s) {
  session.set(s);
  if (next && /^\/[a-z]*$/.test(next)) return (location.href = next);
  if (s.user.role === 'cashier' || s.user.role === 'kitchen') return (location.href = HOME[s.user.role]);
  showLauncher();
}

function showLauncher() {
  const u = session.user;
  $('#view-login').classList.add('hidden');
  const v = $('#view-launch');
  v.classList.remove('hidden');
  v.innerHTML = `<div class="row"><div class="avatar">${h(u.full_name[0])}</div><div class="grow"><b>${h(u.full_name)}</b><div class="muted small">${h(u.role)}</div></div><button class="btn sm" id="lo">Sign out</button></div>
    <div class="launch-grid">${APPS.filter((a) => a.roles.includes(u.role)).map((a) => `<a class="tile" href="${a.href}"><span class="ico">${a.ico}</span><b>${a.name}</b><span class="muted small">${a.desc}</span></a>`).join('')}</div>`;
  $('#lo').onclick = async () => { try { await api('POST', '/api/auth/logout'); } catch { /* ignore */ } session.clear(); location.reload(); };
}

// ---- PIN login ----
let selected = null;
let pin = '';
const COLORS = { admin: '#7c3aed', manager: '#0284c7', cashier: '#d7262b', kitchen: '#16a34a' };
async function loadRoster() {
  try {
    const roster = await api('GET', '/api/auth/roster');
    $('#roster').innerHTML = roster.map((u) => `<button class="tile" data-id="${u.id}"><span class="avatar" style="background:${COLORS[u.role]}">${h(u.full_name[0])}</span><b>${h(u.full_name)}</b><span class="badge">${h(u.role)}</span></button>`).join('')
      || '<div class="empty">No PIN users yet. Sign in with a password.</div>';
    $('#roster').onclick = (e) => {
      const b = e.target.closest('[data-id]');
      if (!b) return;
      selected = roster.find((u) => u.id === Number(b.dataset.id));
      pin = '';
      $('#pin-name').textContent = selected.full_name;
      $('#roster').classList.add('hidden');
      $('#pin-entry').classList.remove('hidden');
      drawPin();
    };
  } catch (e) { toastError(e); }
}
function drawPin() { $('#pin-dots').innerHTML = Array.from({ length: Math.max(4, pin.length) }, (_, i) => `<i class="${i < pin.length ? 'on' : ''}"></i>`).join(''); }
async function submitPin() {
  if (pin.length < 4) return;
  try { afterLogin(await api('POST', '/api/auth/login', { user_id: selected.id, pin, terminal: termInput.value.trim() || 'POS-1' })); }
  catch (e) { pin = ''; drawPin(); toastError(e); }
}
function pinKey(k) {
  if (k === '⌫') pin = pin.slice(0, -1); else if (k === 'C') pin = ''; else if (pin.length < 8) pin += k;
  drawPin();
}
$('#pin-pad').append(keypad(pinKey));
const go = document.createElement('button');
go.className = 'btn primary lg block';
go.textContent = 'Sign in';
go.style.marginTop = '8px';
go.onclick = submitPin;
$('#pin-pad').append(go);
document.addEventListener('keydown', (e) => {
  if ($('#pin-entry').classList.contains('hidden')) return;
  if (/^\d$/.test(e.key)) pinKey(e.key); else if (e.key === 'Backspace') pinKey('⌫'); else if (e.key === 'Enter') submitPin();
});
$('#pin-back').onclick = () => { $('#pin-entry').classList.add('hidden'); $('#roster').classList.remove('hidden'); };

// ---- password login ----
$('#mode-toggle').onclick = () => {
  const pw = $('#pw-login').classList.toggle('hidden');
  $('#pin-login').classList.toggle('hidden', !pw);
  $('#mode-toggle').textContent = pw ? 'Use password' : 'Use PIN';
};
$('#pw-login').onsubmit = async (e) => {
  e.preventDefault();
  const f = new FormData(e.target);
  try { afterLogin(await api('POST', '/api/auth/login', { username: f.get('username'), password: f.get('password'), terminal: termInput.value.trim() || 'POS-1' })); }
  catch (err) { toastError(err); }
};

// ---- server status / first-run setup ----
function showServerProblem(e) {
  const el = $('#server-alert');
  el.classList.remove('hidden');
  if (e.details === 'DATABASE_NOT_CONFIGURED' || e.details === 'DATABASE_UNAVAILABLE') {
    el.innerHTML = `<b>The POS database isn't connected yet</b>${h(e.message)}<br>See the README section “Deploy to Vercel”.`;
  } else {
    el.innerHTML = `<b>Can't reach the POS server</b>${h(e.message)}`;
  }
  $('#view-login').classList.add('hidden');
}

function showSetup() {
  $('#view-login').classList.add('hidden');
  $('#view-setup').classList.remove('hidden');
}
$('#view-setup').onsubmit = async (e) => {
  e.preventDefault();
  const f = Object.fromEntries(new FormData(e.target));
  const btn = e.target.querySelector('button');
  btn.disabled = true;
  try {
    const s = await api('POST', '/api/setup', { ...f, store_name: f.store_name.trim() || undefined });
    session.set(s);
    location.href = '/admin';
  } catch (err) { btn.disabled = false; toastError(err); }
};

async function start() {
  let cfg;
  try { cfg = await publicConfig(); } catch (e) { return showServerProblem(e); }
  $('#store-name').textContent = cfg.store_name;
  if (cfg.needs_setup) return showSetup();
  if (session.token) {
    try { await api('GET', '/api/auth/me'); return next ? (location.href = next) : showLauncher(); } catch { session.clear(); }
  }
  loadRoster();
}
start();
