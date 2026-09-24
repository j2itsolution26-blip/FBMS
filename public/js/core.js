// Shared client core: API client, formatting, escaping, modals, toasts, keypad, live events.
export const store = {
  get(k) { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* storage unavailable */ } },
  del(k) { try { localStorage.removeItem(k); } catch { /* ignore */ } },
};

export const session = {
  get token() { return store.get('fbms.session')?.token || null; },
  get user() { return store.get('fbms.session')?.user || null; },
  set(s) { store.set('fbms.session', s); },
  clear() { store.del('fbms.session'); },
};

export class ApiError extends Error {
  constructor(status, message, details) { super(message); this.status = status; this.details = details; }
}

export async function api(method, url, body) {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (session.token) headers.Authorization = `Bearer ${session.token}`;
  let res;
  try {
    res = await fetch(url, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  } catch {
    throw new ApiError(0, 'Cannot reach the server. Check the network connection.');
  }
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (res.status === 401 && !url.startsWith('/api/auth/login')) {
    session.clear();
    if (!location.pathname.match(/^\/(index\.html)?$/)) location.href = `/?next=${encodeURIComponent(location.pathname)}`;
  }
  if (!res.ok) throw new ApiError(res.status, data?.error || `Request failed (${res.status})`, data?.details);
  return data;
}

/** Escape text for safe interpolation into HTML templates. */
export function h(v) {
  return String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

let currency = '₱';
export function setCurrency(sym) { currency = sym || '₱'; }
export function money(cents, { sign = true } = {}) {
  const n = (cents || 0) / 100;
  const s = n.toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return sign ? `${currency}${s}` : s;
}
export const toCents = (v) => Math.round(Number(v || 0) * 100);
export const pad = (n, w = 3) => String(n).padStart(w, '0');
export const fmtTime = (iso) => (iso ? new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '');
export const fmtDateTime = (iso) => (iso ? new Date(iso).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '');
export const ORDER_TYPES = { dine_in: 'Dine-in', take_out: 'Take-out', drive_thru: 'Drive-thru', delivery: 'Delivery' };
export const PAY_LABELS = { cash: 'Cash', card: 'Card', gcash: 'GCash', maya: 'Maya', voucher: 'Voucher' };
export const today = () => new Date().toLocaleDateString('en-CA');

export function $(sel, root = document) { return root.querySelector(sel); }
export function $$(sel, root = document) { return [...root.querySelectorAll(sel)]; }

export function toast(msg, kind = '') {
  let host = $('.toasts');
  if (!host) { host = document.createElement('div'); host.className = 'toasts'; document.body.append(host); }
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = msg;
  host.append(el);
  setTimeout(() => el.remove(), kind === 'error' ? 4500 : 2500);
}
export const toastError = (e) => toast(e?.message || String(e), 'error');

/**
 * Open a modal. `body` is an HTML string (caller escapes data) or element.
 * Returns { el, close }. `onClose` fires once.
 */
export function modal({ title, body, footer = '', wide = false, onClose } = {}) {
  const back = document.createElement('div');
  back.className = 'modal-backdrop';
  back.innerHTML = `<div class="modal ${wide ? 'wide' : ''}" role="dialog" aria-modal="true" aria-label="${h(title)}">
    <div class="modal-head"><h3>${h(title)}</h3><button class="btn ghost icon-btn" data-close aria-label="Close">✕</button></div>
    <div class="modal-body"></div>${footer ? `<div class="modal-foot">${footer}</div>` : ''}</div>`;
  const bodyEl = $('.modal-body', back);
  if (typeof body === 'string') bodyEl.innerHTML = body; else if (body) bodyEl.append(body);
  let closed = false;
  const close = (result) => {
    if (closed) return;
    closed = true;
    back.remove();
    document.removeEventListener('keydown', onKey);
    onClose?.(result);
  };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  back.addEventListener('click', (e) => { if (e.target === back || e.target.closest('[data-close]')) close(); });
  document.addEventListener('keydown', onKey);
  document.body.append(back);
  setTimeout(() => $('input:not([type=hidden]), select, textarea', back)?.focus(), 30);
  return { el: back, body: bodyEl, close };
}

export function confirmBox(title, message, { okText = 'Confirm', danger = false } = {}) {
  return new Promise((resolve) => {
    const m = modal({
      title, body: `<p>${h(message)}</p>`,
      footer: `<button class="btn" data-close>Cancel</button><button class="btn ${danger ? 'primary' : 'success'}" data-ok>${h(okText)}</button>`,
      onClose: (r) => resolve(!!r),
    });
    $('[data-ok]', m.el).onclick = () => m.close(true);
  });
}

/** Numeric keypad bound to a value string. */
export function keypad(onKey, { dot = false } = {}) {
  const el = document.createElement('div');
  el.className = 'keypad';
  const keys = ['1', '2', '3', '4', '5', '6', '7', '8', '9', dot ? '.' : 'C', '0', '⌫'];
  el.innerHTML = keys.map((k) => `<button type="button" data-k="${k}">${k}</button>`).join('');
  el.addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) onKey(b.dataset.k); });
  return el;
}

/**
 * Manager override prompt. Resolves with the PIN string or null if cancelled.
 */
export function askManagerPin(reasonText = 'This action needs a manager’s approval.') {
  return new Promise((resolve) => {
    let pin = '';
    const wrap = document.createElement('div');
    wrap.className = 'col';
    wrap.innerHTML = `<p class="muted center">${h(reasonText)}</p><div class="pin-dots"></div>`;
    const dots = $('.pin-dots', wrap);
    const draw = () => { dots.innerHTML = Array.from({ length: Math.max(4, pin.length) }, (_, i) => `<i class="${i < pin.length ? 'on' : ''}"></i>`).join(''); };
    draw();
    let done = false;
    const m = modal({ title: '🔐 Manager approval', body: wrap, footer: '<button class="btn" data-close>Cancel</button><button class="btn primary" data-ok>Approve</button>', onClose: () => { if (!done) resolve(null); } });
    const submit = () => { if (pin.length >= 4) { done = true; m.close(); resolve(pin); } };
    wrap.append(keypad((k) => {
      if (k === '⌫') pin = pin.slice(0, -1); else if (k === 'C') pin = ''; else if (pin.length < 8) pin += k;
      draw();
    }));
    $('[data-ok]', m.el).onclick = submit;
    m.el.addEventListener('keydown', (e) => {
      if (/^\d$/.test(e.key) && pin.length < 8) { pin += e.key; draw(); }
      else if (e.key === 'Backspace') { pin = pin.slice(0, -1); draw(); }
      else if (e.key === 'Enter') submit();
    });
    m.el.tabIndex = -1; m.el.focus();
  });
}

/**
 * Run an API call; if the server says approval is needed (403), ask for a
 * manager PIN and retry with it.
 */
export async function withApproval(fn, reason) {
  try {
    return await fn(undefined);
  } catch (e) {
    if (e.status !== 403 || !/approval|Manager/i.test(e.message)) throw e;
    const pin = await askManagerPin(reason);
    if (!pin) return null;
    return fn(pin);
  }
}

/** Subscribe to live order events (Server-Sent Events). */
export function liveEvents(onEvent, onStatus) {
  let es;
  const connect = () => {
    es = new EventSource('/api/public/events');
    es.addEventListener('order', (e) => { try { onEvent(JSON.parse(e.data)); } catch { /* ignore bad frame */ } });
    es.onopen = () => onStatus?.(true);
    es.onerror = () => onStatus?.(false);
  };
  connect();
  return () => es?.close();
}

export function startClock(el) {
  const tick = () => { el.textContent = new Date().toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' }); };
  tick();
  setInterval(tick, 15000);
}

export function applyTheme() {
  const t = store.get('fbms.theme');
  if (t) document.documentElement.dataset.theme = t;
}
export function toggleTheme() {
  const cur = document.documentElement.dataset.theme || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
  const next = cur === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = next;
  store.set('fbms.theme', next);
}

export function requireSession(allowedRoles) {
  const u = session.user;
  if (!session.token || !u || (allowedRoles && !allowedRoles.includes(u.role))) {
    location.href = `/?next=${encodeURIComponent(location.pathname)}`;
    throw new Error('redirecting');
  }
  return u;
}

export async function logout() {
  try { await api('POST', '/api/auth/logout'); } catch { /* already gone */ }
  session.clear();
  location.href = '/';
}

/** Render a BIR-style official receipt from /api/orders/:id/receipt data. */
export function renderReceipt({ store: st, order: o }, { change = null, reprint = false } = {}) {
  const line = (l, r, cls = '') => `<div class="r ${cls}"><span>${l}</span><span>${r}</span></div>`;
  const m = (c) => money(c, { sign: false });
  const paidCash = o.payments.filter((p) => p.method === 'cash');
  const chg = change ?? paidCash.reduce((s, p) => s + p.change_given, 0);
  return `<div class="receipt">
    <div class="c big">${h(st.name)}</div>
    <div class="c">${h(st.address)}</div>
    <div class="c">${st.vat_registered ? 'VAT REG' : 'NON-VAT REG'} TIN: ${h(st.tin)}</div>
    <div class="c">${h(st.permit_no)}</div>
    <hr>
    <div class="c big">${o.status === 'refunded' ? 'REFUND / RETURN' : o.or_number ? 'OFFICIAL RECEIPT' : 'ORDER SLIP (NOT AN OR)'}</div>
    ${reprint ? '<div class="c">*** REPRINT ***</div>' : ''}
    ${o.or_number ? line('OR No.', pad(o.or_number, 8)) : ''}
    ${line('Order #', `<b>${pad(o.order_no)}</b>`)}
    ${line('Type', h(ORDER_TYPES[o.type]) + (o.table_name ? ` · ${h(o.table_name)}` : ''))}
    ${line('Date', h(new Date(o.paid_at || o.created_at).toLocaleString()))}
    ${o.cashier_name ? line('Cashier', h(o.cashier_name)) : ''}
    ${o.customer_name ? line('Customer', h(o.customer_name)) : ''}
    <hr>
    ${o.lines.map((l) => `${line(`${l.qty} ${h(l.name)}`, m(l.line_total))}${l.modifiers.map((md) => `<div class="ind">+ ${h(md.name)}${md.price_delta ? ` (${m(md.price_delta)})` : ''}</div>`).join('')}${l.notes ? `<div class="ind">* ${h(l.notes)}</div>` : ''}`).join('')}
    <hr>
    ${line('Subtotal', m(o.subtotal))}
    ${o.sc_pwd_discount ? line(`Less SC/PWD 20% (${o.sc_pwd_count})`, `-${m(o.sc_pwd_discount)}`) : ''}
    ${o.sc_pwd_count ? line('Less VAT (exempt share)', `-${m(o.subtotal - o.other_discount - o.vatable_sales - o.vat_amount - o.vat_exempt_sales)}`) : ''}
    ${o.other_discount ? line(`Less ${h(o.discount_label || 'Discount')}`, `-${m(o.other_discount)}`) : ''}
    ${o.service_charge ? line('Service charge', m(o.service_charge)) : ''}
    ${line('TOTAL DUE', m(o.total), 'big')}
    ${o.payments.map((p) => line(`${PAY_LABELS[p.method]}${p.reference ? ` #${h(p.reference)}` : ''}`, m(p.tendered))).join('')}
    ${o.payments.length ? line('Change', m(chg)) : ''}
    <hr>
    ${line('VATable Sales', m(o.vatable_sales))}
    ${line('VAT Amount', m(o.vat_amount))}
    ${line('VAT-Exempt Sales', m(o.vat_exempt_sales))}
    ${line('Zero-Rated Sales', m(0))}
    ${o.sc_pwd_ids?.length ? `<hr><div>SC/PWD ID: ${o.sc_pwd_ids.map(h).join(', ')}</div><div>Name: ____________________</div><div>Signature: _______________</div>` : ''}
    <hr>
    <div class="c">${h(st.footer)}</div>
    <div class="c" style="margin-top:6px">Powered by FBMS POS</div>
  </div>`;
}

applyTheme();
