// POS terminal: menu → ticket → payment, with holds, tables, discounts, shifts.
import {
  api, h, $, $$, money, toCents, pad, modal, toast, toastError, keypad, confirmBox, withApproval,
  liveEvents, startClock, requireSession, logout, renderReceipt, setCurrency, ORDER_TYPES, PAY_LABELS,
  fmtTime, toggleTheme, store,
} from './core.js';
import { computeTotals } from './pricing.js';

const user = requireSession(['cashier', 'manager', 'admin']);
const isManager = user.role === 'manager' || user.role === 'admin';
const terminal = store.get('fbms.terminal') || 'POS-1';

const state = {
  menu: { categories: [], items: [] },
  settings: {},
  catId: null,
  search: '',
  shift: null,
  mode86: false,
  cart: null,
  busy: false,
};

const newCart = (type = store.get('fbms.lastType') || 'take_out') => ({
  id: null, order_no: null, type, table_id: null, table_name: null, customer_name: '', notes: '',
  guest_count: 1, sc_pwd_count: 0, sc_pwd_ids: [], discount: null, lines: [], source: 'pos',
});
state.cart = newCart();

const itemById = (id) => state.menu.items.find((i) => i.id === id);
const optionIndex = new Map();

// ---------- boot ----------
async function boot() {
  $('#user-name').textContent = user.full_name.split(' ')[0];
  startClock($('#clock'));
  try {
    const [menu, settings, shift] = await Promise.all([api('GET', '/api/menu'), api('GET', '/api/settings'), api('GET', '/api/shifts/current')]);
    state.settings = settings;
    setCurrency(settings.currency_symbol);
    setMenu(menu);
    state.shift = shift.shift;
  } catch (e) { return toastError(e); }
  renderTypes();
  renderShift();
  render();
  refreshOpenCount();
  if (!state.shift) openShiftDialog();
  liveEvents(onLiveEvent);
}

function setMenu(menu) {
  state.menu = { categories: menu.categories.filter((c) => c.active), items: menu.items.filter((i) => i.active) };
  optionIndex.clear();
  for (const it of state.menu.items) for (const g of it.modifier_groups) for (const o of g.options) optionIndex.set(o.id, { ...o, group: g.name });
  if (!state.catId || !state.menu.categories.some((c) => c.id === state.catId)) state.catId = state.menu.categories[0]?.id;
  renderCats();
  renderItems();
}

async function reloadMenu() {
  try { setMenu(await api('GET', '/api/menu')); } catch (e) { toastError(e); }
}

// ---------- header ----------
function renderTypes() {
  $('#order-type').innerHTML = Object.entries(ORDER_TYPES).map(([k, v]) => `<button data-t="${k}" class="${state.cart.type === k ? 'on' : ''}" role="tab">${v}</button>`).join('');
}
$('#order-type').onclick = (e) => {
  const b = e.target.closest('[data-t]');
  if (!b) return;
  state.cart.type = b.dataset.t;
  if (b.dataset.t !== 'dine_in') { state.cart.table_id = null; state.cart.table_name = null; }
  if (!state.cart.id) store.set('fbms.lastType', b.dataset.t);
  renderTypes();
  renderTicket();
};

function renderShift() {
  $('#shift-dot').classList.toggle('on', !!state.shift);
  $('#shift-label').textContent = state.shift ? `Shift #${state.shift.id}` : 'No shift';
}

// ---------- categories & items ----------
function renderCats() {
  $('#cats').innerHTML = state.menu.categories.map((c) => `<button data-c="${c.id}" class="${c.id === state.catId && !state.search ? 'on' : ''}" style="--cat:${h(c.color)}"><span class="ci">${h(c.icon)}</span>${h(c.name)}</button>`).join('');
}
$('#cats').onclick = (e) => {
  const b = e.target.closest('[data-c]');
  if (!b) return;
  state.catId = Number(b.dataset.c);
  state.search = '';
  $('#search').value = '';
  renderCats();
  renderItems();
};

function renderItems() {
  const q = state.search.toLowerCase();
  const list = q
    ? state.menu.items.filter((i) => i.name.toLowerCase().includes(q) || (i.sku || '').toLowerCase() === q)
    : state.menu.items.filter((i) => i.category_id === state.catId);
  const catColor = (id) => state.menu.categories.find((c) => c.id === id)?.color || 'var(--brand)';
  $('#items').innerHTML = list.map((i) => `<button class="tile item ${i.available ? '' : 'off'}" data-i="${i.id}" style="--cat:${h(catColor(i.category_id))}" title="${h(i.description)}">
      <span class="sku">${h(i.sku || '')}</span><span class="ii">${h(i.icon)}</span><span class="in">${h(i.name)}</span>
      ${i.modifier_groups.length ? `<span class="has-mods">${i.modifier_groups.map((g) => h(g.name)).join(' · ')}</span>` : ''}
      <span class="ip">${money(i.price)}</span></button>`).join('') || '<div class="empty">No items match.</div>';
}
$('#items').onclick = async (e) => {
  const b = e.target.closest('[data-i]');
  if (!b) return;
  const item = itemById(Number(b.dataset.i));
  if (state.mode86) return toggle86(item);
  if (!item.available) return toast(`${item.name} is sold out${item.out_of_stock ? ' (no stock)' : ''}`, 'error');
  if (item.modifier_groups.length) openModifierDialog(item);
  else addLine({ item_id: item.id, qty: 1, modifiers: [], notes: '' });
};
$('#search').oninput = (e) => { state.search = e.target.value.trim(); renderCats(); renderItems(); };
document.addEventListener('keydown', (e) => {
  if (e.key === '/' && document.activeElement.tagName !== 'INPUT' && !$('.modal-backdrop')) { e.preventDefault(); $('#search').focus(); }
});

async function toggle86(item) {
  try {
    await api('POST', `/api/menu/items/${item.id}/availability`, { available: item.manually_86 });
    toast(`${item.name} ${item.manually_86 ? 'is back on the menu' : 'marked SOLD OUT'}`);
    await reloadMenu();
  } catch (err) { toastError(err); }
}

// ---------- modifier dialog ----------
function openModifierDialog(item, existing = null, lineIndex = null) {
  const chosen = new Map(item.modifier_groups.map((g) => [g.id, new Set()]));
  if (existing) {
    for (const oid of existing.modifiers) for (const g of item.modifier_groups) if (g.options.some((o) => o.id === oid)) chosen.get(g.id).add(oid);
  } else {
    for (const g of item.modifier_groups) { const d = g.options.find((o) => o.is_default); if (d && g.min_select > 0) chosen.get(g.id).add(d.id); }
  }
  let qty = existing?.qty || 1;
  const notes = existing?.notes || '';
  const sentLocked = existing?.sent;

  const body = document.createElement('div');
  body.className = 'col';
  const draw = () => {
    const unit = item.price + [...chosen.values()].flatMap((s) => [...s]).reduce((a, id) => a + (optionIndex.get(id)?.price_delta || 0), 0);
    body.innerHTML = `<div class="row"><span style="font-size:44px">${h(item.icon)}</span><div class="grow"><b style="font-size:18px">${h(item.name)}</b><div class="muted small">${h(item.description)}</div></div><b class="num" style="font-size:20px">${money(unit * qty)}</b></div>
      ${sentLocked ? '<div class="badge warn">Already sent to kitchen — only quantity can be reduced</div>' : ''}
      ${item.modifier_groups.map((g) => {
        const n = chosen.get(g.id).size;
        const req = g.min_select > 0;
        return `<div class="mod-group"><h4>${h(g.name)} <span class="badge ${req && n < g.min_select ? 'bad' : req ? 'ok' : ''}">${req ? `Required${g.max_select > 1 ? ` · up to ${g.max_select}` : ''}` : `Optional${g.max_select > 1 ? ` · up to ${g.max_select}` : ''}`}</span></h4>
          <div class="opts">${g.options.map((o) => `<button class="opt ${chosen.get(g.id).has(o.id) ? 'on' : ''}" data-g="${g.id}" data-o="${o.id}" ${sentLocked ? 'disabled' : ''}><b>${h(o.name)}</b><small>${o.price_delta ? `+${money(o.price_delta)}` : 'included'}</small></button>`).join('')}</div></div>`;
      }).join('')}
      <label class="field"><span>Kitchen note</span><input class="input" id="mod-notes" maxlength="120" placeholder="e.g. no ice, well done" value="${h($('#mod-notes', body)?.value ?? notes)}" ${sentLocked ? 'disabled' : ''}></label>
      <div class="qty-row"><span class="muted">Quantity</span><button class="btn icon-btn" data-q="-1">−</button><b>${qty}</b><button class="btn icon-btn" data-q="1" ${sentLocked && qty >= existing.qty ? 'disabled' : ''}>+</button></div>`;
  };
  draw();
  body.onclick = (e) => {
    const o = e.target.closest('[data-o]');
    if (o) {
      const g = item.modifier_groups.find((x) => x.id === Number(o.dataset.g));
      const set = chosen.get(g.id);
      const id = Number(o.dataset.o);
      if (set.has(id)) set.delete(id);
      else if (g.max_select === 1) { set.clear(); set.add(id); }
      else if (set.size < g.max_select) set.add(id);
      else toast(`Up to ${g.max_select} for ${g.name}`);
      return draw();
    }
    const q = e.target.closest('[data-q]');
    if (q) { qty = Math.max(1, Math.min(99, qty + Number(q.dataset.q))); draw(); }
  };
  const m = modal({
    title: existing ? 'Edit item' : 'Customize', body,
    footer: `${existing ? '<button class="btn danger" data-remove>Remove</button><span class="spacer"></span>' : ''}<button class="btn" data-close>Cancel</button><button class="btn primary lg" data-ok>${existing ? 'Update' : 'Add to order'}</button>`,
  });
  $('[data-ok]', m.el).onclick = () => {
    for (const g of item.modifier_groups) {
      if (chosen.get(g.id).size < g.min_select) return toast(`Choose ${g.name}`, 'error');
    }
    const line = { item_id: item.id, qty, modifiers: [...chosen.values()].flatMap((s) => [...s]), notes: $('#mod-notes', body).value.trim() };
    m.close();
    if (existing) updateLine(lineIndex, line);
    else addLine(line);
  };
  $('[data-remove]', m.el)?.addEventListener('click', () => { m.close(); removeLine(lineIndex); });
}

// ---------- cart ops ----------
const sameLine = (a, b) => !a.sent && !a.id && a.item_id === b.item_id && (a.notes || '') === (b.notes || '') && a.modifiers.length === b.modifiers.length && a.modifiers.every((m) => b.modifiers.includes(m));

function addLine(line) {
  const hit = state.cart.lines.find((l) => sameLine(l, line));
  if (hit) hit.qty += line.qty; else state.cart.lines.push({ ...line, sent: false });
  renderTicket();
  requestAnimationFrame(() => { const el = $('#lines'); el.scrollTop = el.scrollHeight; });
}
async function updateLine(idx, line) {
  const cur = state.cart.lines[idx];
  if (cur.sent) {
    if (line.qty < cur.qty) return voidSentLine(idx, line.qty);
    return;
  }
  Object.assign(cur, line);
  renderTicket();
}
function removeLine(idx) {
  const cur = state.cart.lines[idx];
  if (cur.sent) return voidSentLine(idx, 0);
  state.cart.lines.splice(idx, 1);
  renderTicket();
}
async function voidSentLine(idx, newQty) {
  const prev = structuredClone(state.cart.lines);
  if (newQty === 0) state.cart.lines.splice(idx, 1); else state.cart.lines[idx].qty = newQty;
  const ok = await sync({ reason: 'Removing items already sent to the kitchen needs a manager.', extra: { void_reason: 'Removed after send' } });
  if (!ok) { state.cart.lines = prev; renderTicket(); }
}

function lineView(l) {
  const it = itemById(l.item_id);
  const mods = l.modifiers.map((id) => optionIndex.get(id)).filter(Boolean);
  const unit = (it?.price ?? l.base_price ?? 0) + mods.reduce((a, m) => a + m.price_delta, 0);
  return { it, mods, unit, total: unit * l.qty, name: it?.name ?? l.name ?? 'Item' };
}

function totals() {
  const s = state.settings;
  const c = state.cart;
  const scBps = s.dine_in_service_charge_only && c.type !== 'dine_in' ? 0 : s.service_charge_bps || 0;
  return computeTotals({
    lines: c.lines.map((l) => ({ line_total: lineView(l).total, vat_exempt_eligible: lineView(l).it?.vat_exempt_eligible !== false })),
    guestCount: c.guest_count, scPwdCount: c.sc_pwd_count, discount: c.discount,
    serviceChargeBps: scBps, vatBps: s.vat_registered ? s.vat_bps : 0,
  });
}

// ---------- ticket ----------
function renderTicket() {
  const c = state.cart;
  $('#ticket-title').textContent = c.id ? `Order #${pad(c.order_no)}` : 'New order';
  const bits = [ORDER_TYPES[c.type]];
  if (c.table_name) bits.push(`Table ${c.table_name}`);
  if (c.customer_name) bits.push(c.customer_name);
  if (c.guest_count > 1) bits.push(`${c.guest_count} guests`);
  if (c.source === 'kiosk') bits.push('Kiosk');
  $('#ticket-sub').textContent = bits.join(' · ');

  $('#lines').innerHTML = c.lines.length ? c.lines.map((l, i) => {
    const v = lineView(l);
    return `<div class="line ${l.sent ? 'sent' : ''}" data-l="${i}">
      <div class="q"><button data-dec="${i}" aria-label="Decrease">−</button><span>${l.qty}</span><button data-inc="${i}" aria-label="Increase" ${l.sent ? 'disabled' : ''}>+</button></div>
      <div><div class="ln">${h(v.name)}</div>${v.mods.length ? `<div class="lm">${v.mods.map((m) => h(m.name)).join(', ')}</div>` : ''}${l.notes ? `<div class="lm">📝 ${h(l.notes)}</div>` : ''}</div>
      <div class="lp">${money(v.total)}</div></div>`;
  }).join('') : '<div class="empty">🛒<br>Tap menu items to start an order</div>';

  const t = totals();
  const r = (label, val, cls = '') => `<div class="r ${cls}"><span>${label}</span><span>${val}</span></div>`;
  $('#totals').innerHTML = [
    r('Subtotal', money(t.subtotal)),
    t.sc_pwd_discount ? r(`SC/PWD 20% (${c.sc_pwd_count})`, `−${money(t.sc_pwd_discount)}`, 'disc') : '',
    t.vat_removed ? r('VAT exemption', `−${money(t.vat_removed)}`, 'disc') : '',
    t.other_discount ? r(h(c.discount?.label || 'Discount'), `−${money(t.other_discount)}`, 'disc') : '',
    t.service_charge ? r('Service charge', money(t.service_charge)) : '',
    r('VAT (incl.)', money(t.vat_amount), 'muted small'),
    r('Total', money(t.total), 'big'),
  ].join('');
  $('#pay-total').textContent = money(t.total);
  const empty = !c.lines.length;
  $('#btn-pay').disabled = empty;
  $('#btn-hold').disabled = empty;
  $('#btn-send').disabled = empty || !c.lines.some((l) => !l.sent);
  $('#btn-discount').classList.toggle('active', !!c.discount);
  $('#btn-sc').classList.toggle('active', c.sc_pwd_count > 0);
}
function render() { renderTypes(); renderTicket(); }

$('#lines').onclick = (e) => {
  const inc = e.target.closest('[data-inc]');
  const dec = e.target.closest('[data-dec]');
  if (inc) { const l = state.cart.lines[Number(inc.dataset.inc)]; l.qty = Math.min(99, l.qty + 1); return renderTicket(); }
  if (dec) {
    const i = Number(dec.dataset.dec);
    const l = state.cart.lines[i];
    if (l.sent) return l.qty > 1 ? voidSentLine(i, l.qty - 1) : voidSentLine(i, 0);
    if (l.qty > 1) { l.qty -= 1; renderTicket(); } else removeLine(i);
    return;
  }
  const row = e.target.closest('[data-l]');
  if (row) {
    const i = Number(row.dataset.l);
    const l = state.cart.lines[i];
    const it = itemById(l.item_id);
    if (!it) return;
    openModifierDialog(it, l, i);
  }
};

// ---------- server sync ----------
function payload() {
  const c = state.cart;
  return {
    type: c.type, table_id: c.table_id, customer_name: c.customer_name || null, notes: c.notes || null,
    guest_count: c.guest_count, sc_pwd_count: c.sc_pwd_count, sc_pwd_ids: c.sc_pwd_ids,
    discount: c.discount ? { type: c.discount.type, value: c.discount.value, label: c.discount.label } : null,
    lines: c.lines.map((l) => ({ ...(l.id ? { id: l.id } : {}), item_id: l.item_id, qty: l.qty, modifiers: l.modifiers, notes: l.notes || null })),
  };
}

function loadOrder(o) {
  state.cart = {
    id: o.id, order_no: o.order_no, type: o.type, table_id: o.table_id, table_name: o.table_name, customer_name: o.customer_name || '',
    notes: o.notes || '', guest_count: o.guest_count, sc_pwd_count: o.sc_pwd_count, sc_pwd_ids: o.sc_pwd_ids || [],
    discount: o.discount_type ? { type: o.discount_type, value: o.discount_value, label: o.discount_label } : null,
    lines: o.lines.map((l) => ({ id: l.id, item_id: l.item_id, qty: l.qty, modifiers: l.modifiers.map((m) => m.option_id), notes: l.notes || '', sent: l.sent, name: l.name, base_price: l.base_price })),
    source: o.source, server_total: o.total,
  };
  render();
}

/** Create or update the order on the server. Returns the saved order or null. */
async function sync({ reason, extra = {} } = {}) {
  if (state.busy) return null;
  state.busy = true;
  try {
    const body = { ...payload(), ...extra };
    const o = await withApproval((pin) => (state.cart.id
      ? api('PUT', `/api/orders/${state.cart.id}`, { ...body, ...(pin ? { manager_pin: pin } : {}) })
      : api('POST', '/api/orders', { ...body, ...(pin ? { manager_pin: pin } : {}) })), reason);
    if (!o) return null;
    loadOrder(o);
    return o;
  } catch (e) {
    toastError(e);
    return null;
  } finally {
    state.busy = false;
  }
}

function resetCart(msg) {
  state.cart = newCart(state.cart.type === 'dine_in' ? store.get('fbms.lastType') || 'take_out' : state.cart.type);
  render();
  if (msg) toast(msg, 'ok');
  refreshOpenCount();
}

// ---------- actions ----------
$('#btn-hold').onclick = async () => {
  const o = await sync({ reason: 'A discount or removed item needs a manager.' });
  if (o) resetCart(`Order #${pad(o.order_no)} held`);
};
$('#btn-send').onclick = async () => {
  const o = await sync({ reason: 'A discount or removed item needs a manager.' });
  if (!o) return;
  try {
    const sent = await api('POST', `/api/orders/${o.id}/send`);
    resetCart(`Order #${pad(sent.order_no)} sent to kitchen 🔥`);
  } catch (e) { toastError(e); }
};
$('#btn-clear').onclick = async () => {
  const c = state.cart;
  if (!c.id) {
    if (c.lines.length && !(await confirmBox('Clear order', 'Remove all items from this order?', { okText: 'Clear', danger: true }))) return;
    return resetCart();
  }
  const m = modal({
    title: `Void order #${pad(c.order_no)}`,
    body: `<p class="muted">Voided orders stay in the audit trail. Items already sent to the kitchen are recorded as waste.</p>
      <label class="field"><span>Reason</span><select class="input" id="void-reason"><option>Customer cancelled</option><option>Wrong order entered</option><option>Duplicate order</option><option>Customer walked out</option><option>Test transaction</option></select></label>`,
    footer: '<button class="btn" data-close>Keep order</button><button class="btn primary" data-ok>Void order</button>',
  });
  $('[data-ok]', m.el).onclick = async () => {
    const reason = $('#void-reason', m.el).value;
    m.close();
    try {
      const r = await withApproval((pin) => api('POST', `/api/orders/${c.id}/void`, { reason, ...(pin ? { manager_pin: pin } : {}) }), 'Voiding an order needs a manager.');
      if (r) resetCart(`Order #${pad(c.order_no)} voided`);
    } catch (e) { toastError(e); }
  };
};

$('#btn-customer').onclick = () => {
  const c = state.cart;
  const m = modal({
    title: 'Order details',
    body: `<label class="field"><span>Customer name (for call-out)</span><input class="input" id="cust" maxlength="60" value="${h(c.customer_name)}"></label>
      <label class="field"><span>Guests</span><input class="input" id="guests" type="number" min="1" max="100" value="${c.guest_count}"></label>
      <label class="field"><span>Order notes</span><textarea class="input" id="onotes" maxlength="200" rows="2">${h(c.notes)}</textarea></label>`,
    footer: '<button class="btn" data-close>Cancel</button><button class="btn primary" data-ok>Save</button>',
  });
  $('[data-ok]', m.el).onclick = () => {
    c.customer_name = $('#cust', m.el).value.trim();
    c.guest_count = Math.max(1, Math.min(100, Number($('#guests', m.el).value) || 1));
    c.sc_pwd_count = Math.min(c.sc_pwd_count, c.guest_count);
    c.sc_pwd_ids = c.sc_pwd_ids.slice(0, c.sc_pwd_count);
    c.notes = $('#onotes', m.el).value.trim();
    m.close();
    renderTicket();
  };
};

$('#btn-sc').onclick = () => {
  const c = state.cart;
  let count = c.sc_pwd_count;
  let guests = Math.max(c.guest_count, count || 1);
  const ids = [...c.sc_pwd_ids];
  const body = document.createElement('div');
  body.className = 'col';
  const draw = () => {
    body.innerHTML = `<p class="muted small">Per RA 9994 / RA 10754: the SC/PWD share of the bill is VAT-exempt and gets 20% off. Record each ID number.</p>
      <div class="grid-2"><label class="field"><span>Total guests</span><input class="input" type="number" id="sc-g" min="1" max="100" value="${guests}"></label>
      <label class="field"><span>Senior / PWD guests</span><input class="input" type="number" id="sc-n" min="0" max="${guests}" value="${count}"></label></div>
      ${Array.from({ length: count }, (_, i) => `<label class="field"><span>SC/PWD ID #${i + 1}</span><input class="input sc-id" data-i="${i}" maxlength="40" value="${h(ids[i] || '')}" placeholder="e.g. SC-0012345"></label>`).join('')}`;
  };
  draw();
  body.onchange = (e) => {
    if (e.target.id === 'sc-g') guests = Math.max(1, Number(e.target.value) || 1);
    if (e.target.id === 'sc-n') count = Math.max(0, Math.min(guests, Number(e.target.value) || 0));
    if (e.target.classList.contains('sc-id')) { ids[Number(e.target.dataset.i)] = e.target.value.trim(); return; }
    count = Math.min(count, guests);
    draw();
  };
  const m = modal({ title: 'Senior Citizen / PWD discount', body, footer: `${c.sc_pwd_count ? '<button class="btn danger" data-rm>Remove</button><span class="spacer"></span>' : ''}<button class="btn" data-close>Cancel</button><button class="btn primary" data-ok>Apply</button>` });
  $('[data-ok]', m.el).onclick = () => {
    $$('.sc-id', body).forEach((x) => { ids[Number(x.dataset.i)] = x.value.trim(); });
    const list = ids.slice(0, count);
    if (list.length < count || list.some((x) => !x)) return toast('Enter every SC/PWD ID number', 'error');
    Object.assign(c, { guest_count: guests, sc_pwd_count: count, sc_pwd_ids: list });
    m.close();
    renderTicket();
  };
  $('[data-rm]', m.el)?.addEventListener('click', () => { Object.assign(c, { sc_pwd_count: 0, sc_pwd_ids: [] }); m.close(); renderTicket(); });
};

$('#btn-discount').onclick = () => {
  const c = state.cart;
  const presets = [
    { label: 'Promo 10%', type: 'percent', value: 1000 }, { label: 'Promo 15%', type: 'percent', value: 1500 },
    { label: 'Employee 20%', type: 'percent', value: 2000 }, { label: 'Loyalty ₱50 off', type: 'amount', value: 5000 },
    { label: 'Service recovery 50%', type: 'percent', value: 5000 }, { label: 'Complimentary', type: 'percent', value: 10000 },
  ];
  const m = modal({
    title: 'Apply discount',
    body: `<p class="muted small">Discounts need manager approval and are written to the audit log. They apply to the non-SC/PWD share only.</p>
      <div class="grid-3">${presets.map((p, i) => `<button class="btn lg" data-p="${i}">${h(p.label)}</button>`).join('')}</div>
      <div class="grid-2"><label class="field"><span>Custom %</span><input class="input" id="d-pct" type="number" min="1" max="100" step="1" placeholder="e.g. 5"></label>
      <label class="field"><span>Custom amount</span><input class="input" id="d-amt" type="number" min="1" step="0.01" placeholder="e.g. 25.00"></label></div>`,
    footer: `${c.discount ? '<button class="btn danger" data-rm>Remove discount</button><span class="spacer"></span>' : ''}<button class="btn" data-close>Cancel</button><button class="btn primary" data-ok>Apply custom</button>`,
  });
  const apply = async (d) => {
    m.close();
    const prev = c.discount;
    c.discount = d;
    if (!c.lines.length) { renderTicket(); return; }
    const o = await sync({ reason: `Approve discount: ${d?.label || 'remove'}` });
    if (!o) { c.discount = prev; renderTicket(); }
  };
  m.body.onclick = (e) => { const b = e.target.closest('[data-p]'); if (b) apply(presets[Number(b.dataset.p)]); };
  $('[data-ok]', m.el).onclick = () => {
    const pct = Number($('#d-pct', m.el).value);
    const amt = Number($('#d-amt', m.el).value);
    if (pct > 0 && pct <= 100) apply({ label: `Discount ${pct}%`, type: 'percent', value: Math.round(pct * 100) });
    else if (amt > 0) apply({ label: `Discount ${money(toCents(amt))}`, type: 'amount', value: toCents(amt) });
    else toast('Enter a percentage or amount', 'error');
  };
  $('[data-rm]', m.el)?.addEventListener('click', () => apply(null));
};

// ---------- payment ----------
$('#btn-pay').onclick = async () => {
  if (!state.shift) return openShiftDialog('Open your shift before taking payments.');
  const o = await sync({ reason: 'A discount or removed item needs a manager.' });
  if (o) openPayment(o);
};

function openPayment(order) {
  const due = order.total;
  const tenders = [];
  let method = 'cash';
  let entry = '';
  let ref = '';
  const paid = () => tenders.reduce((s, t) => s + t.amount, 0);
  const remaining = () => Math.max(0, due - paid());
  const body = document.createElement('div');

  const quickCash = () => {
    const r = remaining();
    const set = new Set([r]);
    for (const step of [2000, 5000, 10000, 50000, 100000]) set.add(Math.ceil(r / step) * step);
    return [...set].filter((x) => x >= r).sort((a, b) => a - b).slice(0, 6);
  };
  const draw = () => {
    const rem = remaining();
    body.innerHTML = `<div class="pay-grid">
      <div class="col">
        <div class="row"><div class="grow"><div class="muted small">Amount due · Order #${pad(order.order_no)}</div><div class="due">${money(due)}</div></div>
          <div class="right"><div class="muted small">Remaining</div><div class="due" style="color:${rem ? 'var(--brand)' : 'var(--ok)'}">${money(rem)}</div></div></div>
        <div class="tenders">${Object.entries(PAY_LABELS).filter(([k]) => k !== 'voucher').map(([k, v]) => `<button class="btn lg ${method === k ? 'active' : ''}" data-m="${k}">${{ cash: '💵', card: '💳', gcash: '📱', maya: '📲' }[k]} ${v}</button>`).join('')}</div>
        ${method === 'cash' ? `<div class="quick">${quickCash().map((v) => `<button class="btn lg" data-quick="${v}">${money(v)}</button>`).join('')}</div>` : `
          <label class="field"><span>${method === 'card' ? 'Approval code (optional)' : 'Reference number (required)'}</span><input class="input" id="pay-ref" maxlength="60" value="${h(ref)}" autocomplete="off"></label>`}
        <div class="paylist">${tenders.map((t, i) => `<div class="r"><span>${PAY_LABELS[t.method]}${t.reference ? ` · ${h(t.reference)}` : ''}</span><span class="row"><b class="num">${money(t.amount)}</b><button class="btn ghost sm" data-rmt="${i}">✕</button></span></div>`).join('')}</div>
      </div>
      <div class="col">
        <div class="amount-display" id="amt">${entry ? money(toCents(entry)) : `<span class="faint">${money(rem)}</span>`}</div>
        <div id="kp"></div>
        <button class="btn lg" data-add ${rem ? '' : 'disabled'}>Add ${PAY_LABELS[method]}</button>
      </div></div>`;
    $('#kp', body).append(keypad((k) => {
      if (k === '⌫') entry = entry.slice(0, -1);
      else if (k === '.') { if (!entry.includes('.')) entry += entry ? '.' : '0.'; }
      else if (/\d/.test(k) && !(entry.includes('.') && entry.split('.')[1].length >= 2) && entry.length < 9) entry += k;
      $('#amt', body).innerHTML = entry ? money(toCents(entry)) : `<span class="faint">${money(remaining())}</span>`;
    }, { dot: true }));
    footerState();
  };
  const addTender = (amount) => {
    if (amount <= 0) return toast('Enter an amount', 'error');
    if (method !== 'cash') {
      ref = $('#pay-ref', body)?.value.trim() || '';
      if ((method === 'gcash' || method === 'maya') && !ref) return toast('Reference number is required', 'error');
      if (amount > remaining()) return toast('Card / e-wallet cannot exceed the remaining amount', 'error');
    }
    tenders.push({ method, amount, reference: method === 'cash' ? undefined : ref || undefined });
    entry = ''; ref = '';
    if (remaining() > 0 && method !== 'cash') method = 'cash';
    draw();
    if (remaining() === 0) complete();
  };
  body.onclick = (e) => {
    const mb = e.target.closest('[data-m]');
    if (mb) { method = mb.dataset.m; entry = ''; return draw(); }
    const q = e.target.closest('[data-quick]');
    if (q) return addTender(Number(q.dataset.quick));
    if (e.target.closest('[data-add]')) return addTender(entry ? toCents(entry) : remaining());
    const rm = e.target.closest('[data-rmt]');
    if (rm) { tenders.splice(Number(rm.dataset.rmt), 1); draw(); }
  };
  body.oninput = (e) => { if (e.target.id === 'pay-ref') ref = e.target.value; };
  const m = modal({ title: 'Payment', body, wide: true, footer: '<button class="btn" data-close>Cancel</button><button class="btn success lg" data-complete>Complete payment</button>' });
  function footerState() { const b = $('[data-complete]', m?.el || document); if (b) b.disabled = remaining() > 0; }
  draw();
  footerState();
  let paying = false;
  async function complete() {
    if (paying || remaining() > 0) return;
    paying = true;
    try {
      const r = await api('POST', `/api/orders/${order.id}/pay`, { payments: tenders.map((t) => ({ method: t.method, amount: t.amount, reference: t.reference })) });
      m.close();
      showReceipt(r.order.id, r.change);
      resetCart();
    } catch (e) { paying = false; toastError(e); }
  }
  $('[data-complete]', m.el).onclick = complete;
}

async function showReceipt(orderId, change = null, { reprint = false } = {}) {
  try {
    const data = await api('GET', `/api/orders/${orderId}/receipt`);
    const o = data.order;
    const m = modal({
      title: reprint ? `Receipt · Order #${pad(o.order_no)}` : `Paid · Order #${pad(o.order_no)}`,
      body: `${change !== null ? `<div class="change-hero">Change due<b class="num">${money(change)}</b></div>` : ''}${renderReceipt(data, { change, reprint })}`,
      footer: `<button class="btn" data-print>🖨️ Print receipt</button><button class="btn primary lg" data-close>${reprint ? 'Close' : 'Next order'}</button>`,
    });
    $('[data-print]', m.el).onclick = () => window.print();
  } catch (e) { toastError(e); }
}

// ---------- open orders & tables ----------
async function refreshOpenCount() {
  try {
    const open = await api('GET', '/api/orders?status=open&limit=200');
    const el = $('#open-count');
    el.textContent = open.length;
    el.classList.toggle('hidden', !open.length);
  } catch { /* offline badge only */ }
}

async function recall(id) {
  if (state.cart.lines.length && !state.cart.id && !(await confirmBox('Replace current order?', 'The current unsaved order will be discarded.', { okText: 'Discard & recall', danger: true }))) return false;
  try { loadOrder(await api('GET', `/api/orders/${id}`)); return true; } catch (e) { toastError(e); return false; }
}

$('#btn-open').onclick = async () => {
  let list;
  try { list = await api('GET', '/api/orders?status=open&limit=200'); } catch (e) { return toastError(e); }
  const ks = { queued: ['info', 'Queued'], preparing: ['warn', 'Preparing'], ready: ['ok', 'Ready'], served: ['', 'Served'] };
  const m = modal({
    title: `Open orders (${list.length})`, wide: true,
    body: list.length ? `<div class="table-wrap"><table class="table"><thead><tr><th>#</th><th>Type</th><th>Source</th><th>Kitchen</th><th>Items</th><th class="num">Total</th><th>Opened</th><th></th></tr></thead><tbody>
      ${list.map((o) => `<tr><td><b>${pad(o.order_no)}</b></td><td>${ORDER_TYPES[o.type]}${o.table_name ? ` · <b>${h(o.table_name)}</b>` : ''}${o.customer_name ? `<div class="xs muted">${h(o.customer_name)}</div>` : ''}</td>
        <td>${o.source === 'kiosk' ? '<span class="badge brand">Kiosk</span>' : '<span class="badge">POS</span>'}</td>
        <td>${o.kitchen_status ? `<span class="badge ${ks[o.kitchen_status][0]}">${ks[o.kitchen_status][1]}</span>` : '<span class="faint small">Not sent</span>'}</td>
        <td class="num">${o.item_count}</td><td class="num"><b>${money(o.total)}</b></td><td class="small">${fmtTime(o.created_at)}</td>
        <td class="right"><button class="btn sm primary" data-recall="${o.id}">Recall</button></td></tr>`).join('')}</tbody></table></div>` : '<div class="empty">No open orders.</div>',
  });
  m.body.onclick = async (e) => { const b = e.target.closest('[data-recall]'); if (b && (await recall(Number(b.dataset.recall)))) m.close(); };
};

$('#btn-tables').onclick = async () => {
  let tables;
  try { tables = await api('GET', '/api/tables'); } catch (e) { return toastError(e); }
  const areas = [...new Set(tables.map((t) => t.area))];
  const m = modal({
    title: 'Floor plan', wide: true,
    body: areas.map((a) => `<h4>${h(a)}</h4><div class="floor">${tables.filter((t) => t.area === a).map((t) => `<button class="tile table-tile ${t.order_id ? 'busy' : ''}" data-t="${t.id}">
      <b>${h(t.name)}</b><span class="muted small">${t.seats} seats</span>
      ${t.order_id ? `<span class="small">#${pad(t.order_no)} · ${money(t.total)}</span><span class="xs muted">since ${fmtTime(t.seated_at)}</span>` : '<span class="badge ok">Free</span>'}</button>`).join('')}</div>`).join(''),
  });
  m.body.onclick = async (e) => {
    const b = e.target.closest('[data-t]');
    if (!b) return;
    const t = tables.find((x) => x.id === Number(b.dataset.t));
    if (t.order_id) { if (await recall(t.order_id)) m.close(); return; }
    if (state.cart.id && state.cart.table_id !== t.id) { toast('Finish or hold the current order first', 'error'); return; }
    Object.assign(state.cart, { type: 'dine_in', table_id: t.id, table_name: t.name, guest_count: Math.max(state.cart.guest_count, 1) });
    m.close();
    render();
    toast(`Seated at ${t.name}`);
  };
};

// ---------- shift ----------
function openShiftDialog(msg = 'Count your opening cash float to start taking orders.') {
  let entry = '';
  const body = document.createElement('div');
  body.className = 'col';
  body.innerHTML = `<p class="muted">${h(msg)}</p><div class="amount-display" id="float-amt"><span class="faint">${money(0)}</span></div><div id="kp"></div>`;
  $('#kp', body).append(keypad((k) => {
    if (k === '⌫') entry = entry.slice(0, -1);
    else if (k === '.') { if (!entry.includes('.')) entry += entry ? '.' : '0.'; }
    else if (entry.length < 9 && !(entry.includes('.') && entry.split('.')[1].length >= 2)) entry += k;
    $('#float-amt', body).textContent = money(toCents(entry));
  }, { dot: true }));
  const m = modal({ title: `Open shift · ${terminal}`, body, footer: '<button class="btn" data-close>Later</button><button class="btn success lg" data-ok>Open shift</button>' });
  $('[data-ok]', m.el).onclick = async () => {
    try {
      state.shift = await api('POST', '/api/shifts', { opening_float: toCents(entry), terminal });
      renderShift();
      m.close();
      toast(`Shift opened with ${money(state.shift.opening_float)} float`, 'ok');
    } catch (e) { toastError(e); }
  };
}

function xReadingHtml(sum) {
  const s = sum.shift;
  const r = (l, v) => `<div class="r"><span>${l}</span><span>${v}</span></div>`;
  return `<div class="receipt"><div class="c big">${s.status === 'closed' ? 'SHIFT CLOSE' : 'X-READING'}</div><div class="c">${h(state.settings.store_name)}</div><hr>
    ${r('Shift #', s.id)}${r('Cashier', h(s.user_name))}${r('Terminal', h(s.terminal))}${r('Opened', new Date(s.opened_at).toLocaleString())}
    ${s.closed_at ? r('Closed', new Date(s.closed_at).toLocaleString()) : ''}<hr>
    ${r('Transactions', sum.orders_count)}${r('Gross sales', money(sum.gross_sales, { sign: false }))}<hr>
    ${sum.payments.map((p) => r(`${PAY_LABELS[p.method]} (${p.count})`, money(p.amount, { sign: false }))).join('') || r('No payments', '')}
    ${sum.refunds.map((p) => r(`Refund ${PAY_LABELS[p.method]}`, `-${money(p.amount, { sign: false })}`)).join('')}<hr>
    ${r('Opening float', money(s.opening_float, { sign: false }))}${r('Pay-ins', money(sum.cash_movements.pay_in, { sign: false }))}
    ${r('Payouts', `-${money(sum.cash_movements.payout, { sign: false })}`)}${r('Cash drops', `-${money(sum.cash_movements.drop, { sign: false })}`)}
    <div class="r big"><span>Expected cash</span><span>${money(sum.expected_cash, { sign: false })}</span></div>
    ${s.status === 'closed' ? `${r('Counted cash', money(s.counted_cash, { sign: false }))}<div class="r big"><span>${s.variance < 0 ? 'SHORT' : s.variance > 0 ? 'OVER' : 'BALANCED'}</span><span>${money(s.variance, { sign: false })}</span></div>` : ''}
    <hr><div class="c">Printed ${new Date().toLocaleString()}</div></div>`;
}

async function shiftMenu() {
  if (!state.shift) return openShiftDialog();
  let sum;
  try { sum = await api('GET', `/api/shifts/${state.shift.id}`); } catch (e) { return toastError(e); }
  const m = modal({
    title: `Shift #${state.shift.id}`, wide: true,
    body: `<div class="grid-2"><div>${xReadingHtml(sum)}</div><div class="col">
      <button class="btn lg" data-cash="pay_in">➕ Cash pay-in</button><button class="btn lg" data-cash="payout">➖ Cash payout</button>
      <button class="btn lg" data-cash="drop">🏦 Safe drop</button><button class="btn lg" data-print>🖨️ Print X-reading</button>
      <button class="btn primary lg" data-close-shift>🔒 Close shift</button></div></div>`,
  });
  m.body.onclick = (e) => {
    const c = e.target.closest('[data-cash]');
    if (c) { m.close(); return cashMovement(c.dataset.cash); }
    if (e.target.closest('[data-print]')) return window.print();
    if (e.target.closest('[data-close-shift]')) { m.close(); closeShift(sum); }
  };
}
$('#btn-shift').onclick = shiftMenu;

function cashMovement(type) {
  const label = { pay_in: 'Cash pay-in', payout: 'Cash payout', drop: 'Safe drop' }[type];
  const m = modal({
    title: label,
    body: `<label class="field"><span>Amount</span><input class="input" id="cm-amt" type="number" min="0.01" step="0.01"></label>
      <label class="field"><span>Reason</span><input class="input" id="cm-reason" maxlength="120" placeholder="${type === 'payout' ? 'e.g. Ice delivery' : type === 'drop' ? 'e.g. Excess cash to safe' : 'e.g. Change fund top-up'}"></label>`,
    footer: '<button class="btn" data-close>Cancel</button><button class="btn primary" data-ok>Record</button>',
  });
  $('[data-ok]', m.el).onclick = async () => {
    try {
      await api('POST', `/api/shifts/${state.shift.id}/cash`, { type, amount: toCents($('#cm-amt', m.el).value), reason: $('#cm-reason', m.el).value.trim() });
      m.close();
      toast(`${label} recorded`, 'ok');
    } catch (e) { toastError(e); }
  };
}

function closeShift() {
  const m = modal({
    title: 'Close shift — blind count',
    body: `<p class="muted">Count all cash in the drawer, including the opening float. The system will compare it to the expected amount.</p>
      <label class="field"><span>Counted cash</span><input class="input" id="cc" type="number" min="0" step="0.01" style="font-size:24px"></label>
      <label class="field"><span>Notes</span><input class="input" id="cn" maxlength="200"></label>`,
    footer: '<button class="btn" data-close>Cancel</button><button class="btn primary lg" data-ok>Close shift</button>',
  });
  $('[data-ok]', m.el).onclick = async () => {
    const v = $('#cc', m.el).value;
    if (v === '') return toast('Enter the counted cash', 'error');
    try {
      const sum = await api('POST', `/api/shifts/${state.shift.id}/close`, { counted_cash: toCents(v), notes: $('#cn', m.el).value.trim() || null });
      m.close();
      state.shift = null;
      renderShift();
      const r = modal({ title: 'Shift closed', body: xReadingHtml(sum), footer: '<button class="btn" data-print>🖨️ Print</button><button class="btn primary" data-close>Done</button>' });
      $('[data-print]', r.el).onclick = () => window.print();
    } catch (e) { toastError(e); }
  };
}

// ---------- recent / reprint / refund ----------
async function recentOrders() {
  let list;
  try { list = await api('GET', '/api/orders?status=paid,refunded,voided&limit=60'); } catch (e) { return toastError(e); }
  const m = modal({
    title: 'Recent transactions', wide: true,
    body: `<input class="input" id="rq" placeholder="Search order #, OR # or customer">
      <div class="table-wrap" id="rt"></div>`,
  });
  const draw = (rows) => {
    $('#rt', m.el).innerHTML = `<table class="table"><thead><tr><th>Order</th><th>OR #</th><th>Type</th><th>Status</th><th class="num">Total</th><th>Time</th><th></th></tr></thead><tbody>
      ${rows.map((o) => `<tr><td><b>#${pad(o.order_no)}</b></td><td>${o.or_number ? pad(o.or_number, 8) : '—'}</td><td>${ORDER_TYPES[o.type]}</td>
      <td><span class="badge ${o.status === 'paid' ? 'ok' : 'bad'}">${o.status}</span></td><td class="num">${money(o.total)}</td><td class="small">${fmtTime(o.paid_at || o.created_at)}</td>
      <td class="right">${o.status !== 'voided' ? `<button class="btn sm" data-rp="${o.id}">Receipt</button>` : ''} ${o.status === 'paid' ? `<button class="btn sm danger" data-rf="${o.id}">Refund</button>` : ''}</td></tr>`).join('')}</tbody></table>`;
  };
  draw(list);
  $('#rq', m.el).oninput = async (e) => {
    const q = e.target.value.trim();
    try { draw(q ? await api('GET', `/api/orders?q=${encodeURIComponent(q)}&limit=60`) : list); } catch { /* ignore */ }
  };
  m.body.onclick = async (e) => {
    const rp = e.target.closest('[data-rp]');
    if (rp) return showReceipt(Number(rp.dataset.rp), null, { reprint: true });
    const rf = e.target.closest('[data-rf]');
    if (rf) { m.close(); refund(Number(rf.dataset.rf)); }
  };
}

function refund(id) {
  const m = modal({
    title: 'Refund order',
    body: `<label class="field"><span>Reason</span><select class="input" id="rf-reason"><option>Wrong item served</option><option>Food quality complaint</option><option>Order not received</option><option>Duplicate charge</option><option>Other</option></select></label>
      <label class="check"><input type="checkbox" id="rf-restock"> Return ingredients to stock (item was not prepared)</label>`,
    footer: '<button class="btn" data-close>Cancel</button><button class="btn primary" data-ok>Refund</button>',
  });
  $('[data-ok]', m.el).onclick = async () => {
    const body = { reason: $('#rf-reason', m.el).value, restock: $('#rf-restock', m.el).checked };
    m.close();
    try {
      const r = await withApproval((pin) => api('POST', `/api/orders/${id}/refund`, { ...body, ...(pin ? { manager_pin: pin } : {}) }), 'Refunds need a manager.');
      if (r) toast(`Order #${pad(r.order_no)} refunded ${money(r.total)}`, 'ok');
    } catch (e) { toastError(e); }
  };
}

// ---------- main menu ----------
$('#btn-menu').onclick = () => {
  const m = modal({
    title: `${user.full_name} · ${user.role}`,
    body: `<div class="menu-sheet">
      <button class="btn lg" data-a="recent">🧾 Recent transactions / reprint / refund</button>
      <button class="btn lg" data-a="shift">💰 Shift & cash drawer</button>
      <button class="btn lg" data-a="86">🚫 ${state.mode86 ? 'Exit' : 'Enter'} 86 mode (sold-out items)</button>
      <a class="btn lg" href="/kds" target="_blank">👨‍🍳 Open kitchen display</a>
      <a class="btn lg" href="/queue" target="_blank">📺 Open Now Serving board</a>
      ${isManager ? '<a class="btn lg" href="/admin">📊 Back office</a>' : ''}
      <button class="btn lg" data-a="theme">🌓 Toggle light / dark</button>
      <button class="btn lg" data-a="logout">🚪 Sign out</button></div>`,
  });
  m.body.onclick = (e) => {
    const a = e.target.closest('[data-a]')?.dataset.a;
    if (!a) return;
    m.close();
    if (a === 'recent') recentOrders();
    if (a === 'shift') shiftMenu();
    if (a === '86') { state.mode86 = !state.mode86; $('#mode-86').classList.toggle('hidden', !state.mode86); }
    if (a === 'theme') toggleTheme();
    if (a === 'logout') logout();
  };
};

// ---------- live ----------
function onLiveEvent(ev) {
  if (ev.type === 'order.created' && ev.source === 'kiosk') toast(`🖐️ New kiosk order #${pad(ev.order_no)} — awaiting payment`);
  if (ev.type === 'order.kitchen' && ev.kitchen_status === 'ready') toast(`✅ Order #${pad(ev.order_no)} is ready`);
  if (['order.created', 'order.updated', 'order.paid', 'order.voided', 'order.sent'].includes(ev.type)) refreshOpenCountSoon();
  if (ev.type === 'order.paid') reloadMenuSoon();
}
let countTimer;
function refreshOpenCountSoon() { clearTimeout(countTimer); countTimer = setTimeout(refreshOpenCount, 300); }
let menuTimer;
function reloadMenuSoon() { clearTimeout(menuTimer); menuTimer = setTimeout(reloadMenu, 1500); }

boot();
