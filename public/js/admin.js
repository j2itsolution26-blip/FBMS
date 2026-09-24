// Back office: dashboard, orders, menu, inventory, staff, shifts & Z-readings, tables, settings, audit.
import {
  api, h, $, $$, money, toCents, pad, modal, toast, toastError, confirmBox, withApproval, requireSession, logout,
  renderReceipt, setCurrency, ORDER_TYPES, PAY_LABELS, fmtDateTime, fmtTime, today, toggleTheme,
} from './core.js';

const user = requireSession(['manager', 'admin']);
const isAdmin = user.role === 'admin';
let settings = {};

const PAGES = [
  { id: 'dashboard', ico: '📊', name: 'Dashboard', render: dashboard },
  { id: 'orders', ico: '🧾', name: 'Orders', render: orders },
  { id: 'menu', ico: '🍔', name: 'Menu', render: menuPage },
  { id: 'inventory', ico: '📦', name: 'Inventory', render: inventory },
  { id: 'shifts', ico: '💰', name: 'Shifts & Z-reading', render: shifts },
  { id: 'tables', ico: '🍽️', name: 'Tables', render: tablesPage },
  { id: 'staff', ico: '👥', name: 'Staff', render: staff, admin: true },
  { id: 'settings', ico: '⚙️', name: 'Settings', render: settingsPage, admin: true },
  { id: 'audit', ico: '🛡️', name: 'Audit log', render: auditPage },
];

const main = $('#main');
function route() {
  const id = location.hash.slice(1) || 'dashboard';
  const page = PAGES.find((p) => p.id === id && (!p.admin || isAdmin)) || PAGES[0];
  $$('#nav a').forEach((a) => a.classList.toggle('on', a.dataset.id === page.id));
  main.onclick = null;
  hideTip();
  $$('.modal-backdrop').forEach((m) => m.remove());
  main.innerHTML = '<div class="empty">Loading…</div>';
  page.render().catch((e) => { main.innerHTML = `<div class="empty">⚠️ ${h(e.message)}</div>`; });
}
$('#nav').innerHTML = PAGES.filter((p) => !p.admin || isAdmin).map((p) => `<a href="#${p.id}" data-id="${p.id}"><span>${p.ico}</span>${p.name}</a>`).join('');
$('#who').textContent = `${user.full_name} · ${user.role}`;
$('#out').onclick = logout;
$('#theme').onclick = toggleTheme;
window.addEventListener('hashchange', route);

const pct = (n, d) => (d ? `${((n / d) * 100).toFixed(1)}%` : '—');
const shiftDate = (days) => { const d = new Date(); d.setDate(d.getDate() + days); return d.toLocaleDateString('en-CA'); };

// ---------- charts ----------
const tip = $('#tip');
function showTip(e, html) { tip.innerHTML = html; tip.classList.remove('hidden'); const x = Math.min(e.clientX + 14, innerWidth - tip.offsetWidth - 8); tip.style.left = `${x}px`; tip.style.top = `${e.clientY - tip.offsetHeight - 10}px`; }
function hideTip() { tip.classList.add('hidden'); }

/** Single-series vertical bar chart (SVG) with hover tooltips. */
function barChart(el, data, { label, value, fmt, tipLabel }) {
  const W = el.clientWidth || 600; const H = 240; const pl = 56; const pb = 26; const pt = 10; const pr = 8;
  const max = Math.max(1, ...data.map(value));
  const nice = niceMax(max);
  const bw = (W - pl - pr) / Math.max(1, data.length);
  const y = (v) => pt + (H - pt - pb) * (1 - v / nice);
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((t) => t * nice);
  const every = Math.ceil(data.length / Math.max(1, Math.floor((W - pl) / 48)));
  el.innerHTML = `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="${h(tipLabel)} chart">
    <g class="grid">${ticks.map((t) => `<line x1="${pl}" x2="${W - pr}" y1="${y(t)}" y2="${y(t)}"/>`).join('')}</g>
    <g class="axis">${ticks.map((t) => `<text x="${pl - 8}" y="${y(t) + 4}" text-anchor="end">${fmt(t, true)}</text>`).join('')}
      ${data.map((d, i) => (i % every === 0 ? `<text x="${pl + i * bw + bw / 2}" y="${H - 8}" text-anchor="middle">${h(label(d))}</text>` : '')).join('')}</g>
    ${data.map((d, i) => {
      const v = value(d); const bh = Math.max(0, H - pb - y(v)); const w = Math.max(2, bw - 2); const x = pl + i * bw + 1;
      const r = Math.min(4, w / 2, bh);
      const path = bh > 0 ? `M${x},${H - pb} V${y(v) + r} Q${x},${y(v)} ${x + r},${y(v)} H${x + w - r} Q${x + w},${y(v)} ${x + w},${y(v) + r} V${H - pb} Z` : '';
      return `<g class="b" data-i="${i}"><rect class="hit" x="${pl + i * bw}" y="${pt}" width="${bw}" height="${H - pt - pb}"/>${path ? `<path d="${path}" fill="var(--series-1)"/>` : ''}</g>`;
    }).join('')}
  </svg>`;
  const svg = $('svg', el);
  svg.addEventListener('mousemove', (e) => { const g = e.target.closest('[data-i]'); if (!g) return hideTip(); const d = data[Number(g.dataset.i)]; showTip(e, `<b>${h(tipLabel(d))}</b><br>${fmt(value(d))}${d.orders !== undefined ? ` · ${d.orders} orders` : ''}`); });
  svg.addEventListener('mouseleave', hideTip);
}
function niceMax(v) { const p = 10 ** Math.floor(Math.log10(v)); const m = v / p; return (m <= 1 ? 1 : m <= 2 ? 2 : m <= 2.5 ? 2.5 : m <= 5 ? 5 : 10) * p; }
const shortMoney = (c, axis) => { const n = c / 100; if (axis && n === 0) return `${settings.currency_symbol}0`; if (axis && n >= 1000) return `${settings.currency_symbol}${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k`; return money(c); };

function hbars(rows, { name, value, fmt }) {
  const max = Math.max(1, ...rows.map(value));
  return rows.map((r) => `<div class="hbar"><span class="n" title="${h(name(r))}">${h(name(r))}</span><div class="track"><div class="fill" style="width:${(value(r) / max) * 100}%"></div></div><span class="v">${fmt(r)}</span></div>`).join('') || '<div class="empty">No data</div>';
}

// ---------- dashboard ----------
let range = { from: today(), to: today(), key: 'today' };
async function dashboard() {
  const presets = { today: [0, 0, 'Today'], yesterday: [-1, -1, 'Yesterday'], d7: [-6, 0, 'Last 7 days'], d30: [-29, 0, 'Last 30 days'] };
  const [s, low] = await Promise.all([api('GET', `/api/reports/summary?from=${range.from}&to=${range.to}`), api('GET', '/api/inventory/low')]);
  const S = s.sales;
  const kpi = (l, v, sub = '') => `<div class="card kpi"><div class="kl">${l}</div><div class="kv">${v}</div><div class="ks">${sub}</div></div>`;
  main.innerHTML = `<div class="page-head"><h1>Dashboard</h1>
      <div class="filters">${Object.entries(presets).map(([k, p]) => `<button class="btn sm ${range.key === k ? 'active' : ''}" data-r="${k}">${p[2]}</button>`).join('')}
      <input class="input" type="date" id="f" value="${range.from}" style="width:auto"><span class="muted">to</span><input class="input" type="date" id="t" value="${range.to}" style="width:auto"></div></div>
    <div class="kpis">
      ${kpi('Net sales', money(S.net_sales), `${range.from === range.to ? range.from : `${range.from} → ${range.to}`}`)}
      ${kpi('Transactions', S.orders.toLocaleString(), `${S.guests.toLocaleString()} guests`)}
      ${kpi('Average ticket', money(S.average_ticket))}
      ${kpi('Gross sales', money(S.gross), `VAT ${money(S.vat_amount)}`)}
      ${kpi('Discounts', money(S.sc_pwd_discount + S.other_discount), `SC/PWD ${money(S.sc_pwd_discount)} · other ${money(S.other_discount)}`)}
      ${kpi('Refunds', money(s.refunds.amount), `${s.refunds.count} orders · voids ${s.voids.count}`)}
      ${kpi('Kitchen speed', s.kitchen_avg_minutes != null ? `${s.kitchen_avg_minutes} min` : '—', 'avg send → ready')}
      ${kpi('Low stock', `${low.length}`, low.length ? 'ingredients at or below reorder' : 'all good')}
    </div>
    <div class="dash-grid">
      <div class="card panel"><h3>${range.from === range.to ? 'Sales by hour' : 'Daily net sales'}</h3><div class="sub">${settings.currency_symbol} net sales, VAT-inclusive</div><div id="c-main"></div></div>
      <div class="card panel"><h3>Payment mix</h3><div class="sub">Share of collected payments</div>${hbars(s.payments, { name: (r) => PAY_LABELS[r.method], value: (r) => r.amount, fmt: (r) => pct(r.amount, s.payments.reduce((a, b) => a + b.amount, 0)) })}
        <h3 style="margin-top:8px">Order channels</h3>${hbars(s.by_type, { name: (r) => ORDER_TYPES[r.type], value: (r) => r.amount, fmt: (r) => `${r.count}` })}
        ${hbars(s.by_source, { name: (r) => (r.source === 'kiosk' ? 'Self-order kiosk' : 'Counter POS'), value: (r) => r.amount, fmt: (r) => pct(r.amount, S.net_sales) })}</div>
    </div>
    <div class="dash-grid even">
      <div class="card panel"><h3>Top sellers</h3><div class="sub">By quantity sold</div>${hbars(s.top_items, { name: (r) => r.name, value: (r) => r.qty, fmt: (r) => `${r.qty} · ${shortMoney(r.amount, true)}` })}</div>
      <div class="card panel"><h3>Sales by category</h3><div class="sub">Line revenue before bill-level discounts</div>${hbars(s.by_category, { name: (r) => r.name, value: (r) => r.amount, fmt: (r) => shortMoney(r.amount, true) })}
        ${low.length ? `<h3 style="margin-top:8px">⚠️ Reorder soon</h3>${low.slice(0, 6).map((i) => `<div class="row small"><span class="grow">${h(i.name)}</span><span class="badge ${i.stock <= 0 ? 'bad' : 'warn'}">${fmtQty(i.stock)} ${h(i.unit)}</span></div>`).join('')}` : ''}</div>
    </div>`;
  const single = range.from === range.to;
  if (single) {
    const hours = s.hourly.filter((x) => x.hour >= 6 && x.hour <= 23);
    barChart($('#c-main'), hours, { label: (d) => `${d.hour}h`, value: (d) => d.amount, fmt: shortMoney, tipLabel: (d) => `${String(d.hour).padStart(2, '0')}:00–${String(d.hour).padStart(2, '0')}:59` });
  } else {
    const days = fillDays(s.daily, range.from, range.to);
    barChart($('#c-main'), days, { label: (d) => d.date.slice(5), value: (d) => d.amount, fmt: shortMoney, tipLabel: (d) => new Date(`${d.date}T12:00`).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' }) });
  }
  main.querySelector('.filters').onclick = (e) => {
    const b = e.target.closest('[data-r]');
    if (!b) return;
    const p = presets[b.dataset.r];
    range = { from: shiftDate(p[0]), to: shiftDate(p[1]), key: b.dataset.r };
    dashboard().catch(toastError);
  };
  const onDate = () => { const f = $('#f').value; const t = $('#t').value; if (f && t && f <= t) { range = { from: f, to: t, key: 'custom' }; dashboard().catch(toastError); } };
  $('#f').onchange = onDate; $('#t').onchange = onDate;
}
function fillDays(rows, from, to) {
  const map = new Map(rows.map((r) => [r.date, r]));
  const out = [];
  for (let d = new Date(`${from}T12:00`); d <= new Date(`${to}T12:00`); d.setDate(d.getDate() + 1)) {
    const k = d.toLocaleDateString('en-CA');
    out.push(map.get(k) || { date: k, amount: 0, orders: 0 });
  }
  return out;
}
const fmtQty = (n) => (Math.round(n * 100) / 100).toLocaleString();

// ---------- orders ----------
async function orders() {
  main.innerHTML = `<div class="page-head"><h1>Orders</h1><div class="toolbar">
      <input class="input" id="oq" placeholder="Order #, OR # or customer">
      <select class="input" id="os" style="width:auto"><option value="">All statuses</option><option>open</option><option>paid</option><option>refunded</option><option>voided</option></select>
      <input class="input" type="date" id="od" value="${today()}" style="width:auto"></div></div>
    <div class="card table-wrap" id="ot"></div>`;
  const load = async () => {
    const q = new URLSearchParams({ limit: '300' });
    if ($('#oq').value.trim()) q.set('q', $('#oq').value.trim());
    if ($('#os').value) q.set('status', $('#os').value);
    if ($('#od').value && !$('#oq').value.trim()) q.set('date', $('#od').value);
    const rows = await api('GET', `/api/orders?${q}`);
    const badge = { open: 'info', paid: 'ok', refunded: 'bad', voided: 'bad' };
    $('#ot').innerHTML = rows.length ? `<table class="table"><thead><tr><th>Order</th><th>OR #</th><th>Date</th><th>Type</th><th>Source</th><th>Cashier</th><th class="num">Items</th><th class="num">Total</th><th>Status</th></tr></thead><tbody>
      ${rows.map((o) => `<tr data-id="${o.id}" style="cursor:pointer"><td><b>#${pad(o.order_no)}</b></td><td>${o.or_number ? pad(o.or_number, 8) : '—'}</td><td class="small">${fmtDateTime(o.paid_at || o.created_at)}</td>
        <td>${ORDER_TYPES[o.type]}${o.table_name ? ` · ${h(o.table_name)}` : ''}</td><td>${o.source}</td><td>${h(o.cashier_name || '—')}</td><td class="num">${o.item_count}</td><td class="num"><b>${money(o.total)}</b></td>
        <td><span class="badge ${badge[o.status]}">${o.status}</span></td></tr>`).join('')}</tbody></table>` : '<div class="empty">No orders found.</div>';
  };
  $('#oq').oninput = debounce(load, 250); $('#os').onchange = load; $('#od').onchange = load;
  $('#ot').onclick = (e) => { const r = e.target.closest('[data-id]'); if (r) orderDetail(Number(r.dataset.id), load); };
  await load();
}
async function orderDetail(id, reload) {
  const data = await api('GET', `/api/orders/${id}/receipt`);
  const o = data.order;
  const m = modal({
    title: `Order #${pad(o.order_no)} · ${o.status}`, wide: true,
    body: `<div class="grid-2"><div>${renderReceipt(data, { reprint: true })}</div><div class="col small">
      <div><b>Created</b> ${fmtDateTime(o.created_at)} by ${h(o.created_by_name || (o.source === 'kiosk' ? 'Kiosk' : '—'))}</div>
      ${o.sent_at ? `<div><b>Sent to kitchen</b> ${fmtTime(o.sent_at)}</div>` : ''}${o.ready_at ? `<div><b>Ready</b> ${fmtTime(o.ready_at)}</div>` : ''}
      ${o.paid_at ? `<div><b>Paid</b> ${fmtDateTime(o.paid_at)} · ${h(o.cashier_name || '')}</div>` : ''}
      ${o.void_reason ? `<div class="badge bad">${o.status}: ${h(o.void_reason)}</div>` : ''}
      ${o.refunds.map((r) => `<div>Refund ${PAY_LABELS[r.method] || r.method} ${money(r.amount)} ${r.restocked ? '(restocked)' : ''}</div>`).join('')}
    </div></div>`,
    footer: `<button class="btn" data-print>🖨️ Print</button>${o.status === 'paid' ? '<button class="btn danger" data-refund>Refund</button>' : ''}${o.status === 'open' ? '<button class="btn danger" data-void>Void</button>' : ''}<button class="btn primary" data-close>Close</button>`,
  });
  $('[data-print]', m.el).onclick = () => window.print();
  const act = async (kind) => {
    const reason = prompt(`Reason for ${kind}:`);
    if (!reason || reason.trim().length < 3) return;
    const restock = kind === 'refund' ? await confirmBox('Restock?', 'Return this order\'s ingredients to stock (only if the food was not prepared)?', { okText: 'Yes, restock' }) : false;
    try {
      await withApproval((pin) => api('POST', `/api/orders/${id}/${kind}`, { reason: reason.trim(), ...(kind === 'refund' ? { restock } : {}), ...(pin ? { manager_pin: pin } : {}) }));
      m.close(); toast(`Order ${kind === 'void' ? 'voided' : 'refunded'}`, 'ok'); reload?.();
    } catch (e) { toastError(e); }
  };
  $('[data-refund]', m.el)?.addEventListener('click', () => act('refund'));
  $('[data-void]', m.el)?.addEventListener('click', () => act('void'));
}

// ---------- menu ----------
async function menuPage() {
  const [menu, groups] = await Promise.all([api('GET', '/api/menu'), api('GET', '/api/menu/modifier-groups')]);
  const catName = (id) => menu.categories.find((c) => c.id === id)?.name || '—';
  let filter = '';
  main.innerHTML = `<div class="page-head"><h1>Menu</h1><div class="toolbar"><input class="input" id="mq" placeholder="Search items">
    <button class="btn" id="add-cat">+ Category</button><button class="btn primary" id="add-item">+ Menu item</button></div></div>
    <div class="row" style="flex-wrap:wrap">${menu.categories.map((c) => `<button class="btn sm" data-cat="${c.id}">${h(c.icon)} ${h(c.name)} ${c.active ? '' : '<span class="badge">hidden</span>'}</button>`).join('')}</div>
    <div class="card table-wrap" id="mt"></div>`;
  const draw = () => {
    const rows = menu.items.filter((i) => !filter || i.name.toLowerCase().includes(filter) || (i.sku || '').toLowerCase().includes(filter));
    $('#mt').innerHTML = `<table class="table"><thead><tr><th></th><th>SKU</th><th>Item</th><th>Category</th><th>Station</th><th>Options</th><th class="num">Price</th><th>On sale</th><th>In stock</th><th></th></tr></thead><tbody>
      ${rows.map((i) => `<tr><td style="font-size:22px">${h(i.icon)}</td><td class="small muted">${h(i.sku || '')}</td><td><b>${h(i.name)}</b><div class="xs muted">${h(i.description)}</div></td>
      <td>${h(catName(i.category_id))}</td><td><span class="badge">${h(i.station)}</span></td><td class="small">${i.modifier_groups.map((g) => h(g.name)).join(', ') || '—'}</td>
      <td class="num"><b>${money(i.price)}</b></td>
      <td><label class="switch"><input type="checkbox" data-avail="${i.id}" ${i.manually_86 ? '' : 'checked'} ${i.active ? '' : 'disabled'}><span></span></label></td>
      <td>${i.out_of_stock ? '<span class="badge bad">No stock</span>' : '<span class="badge ok">OK</span>'}${i.active ? '' : ' <span class="badge">Inactive</span>'}</td>
      <td class="right"><button class="btn sm" data-edit="${i.id}">Edit</button></td></tr>`).join('')}</tbody></table>`;
  };
  draw();
  $('#mq').oninput = (e) => { filter = e.target.value.trim().toLowerCase(); draw(); };
  $('#mt').onchange = async (e) => {
    const id = e.target.dataset.avail;
    if (!id) return;
    try { await api('POST', `/api/menu/items/${id}/availability`, { available: e.target.checked }); toast('Availability updated', 'ok'); } catch (err) { toastError(err); e.target.checked = !e.target.checked; }
  };
  $('#mt').onclick = (e) => { const b = e.target.closest('[data-edit]'); if (b) itemEditor(menu.items.find((i) => i.id === Number(b.dataset.edit)), menu, groups); };
  $('#add-item').onclick = () => itemEditor(null, menu, groups);
  $('#add-cat').onclick = () => categoryEditor(null);
  main.querySelector('.row').onclick = (e) => { const b = e.target.closest('[data-cat]'); if (b) categoryEditor(menu.categories.find((c) => c.id === Number(b.dataset.cat))); };
}
function categoryEditor(c) {
  const m = modal({
    title: c ? `Edit ${c.name}` : 'New category',
    body: `<div class="grid-3"><label class="field"><span>Name</span><input class="input" id="cn" value="${h(c?.name || '')}" maxlength="40"></label>
      <label class="field"><span>Icon (emoji)</span><input class="input" id="ci" value="${h(c?.icon || '🍽️')}" maxlength="8"></label>
      <label class="field"><span>Color</span><input class="input" id="cc" type="color" value="${h(c?.color || '#d7262b')}"></label></div>
      <div class="grid-2"><label class="field"><span>Sort order</span><input class="input" id="cs" type="number" value="${c?.sort ?? 0}"></label>
      ${c ? `<label class="check"><input type="checkbox" id="ca" ${c.active ? 'checked' : ''}> Visible on POS & kiosk</label>` : ''}</div>`,
    footer: '<button class="btn" data-close>Cancel</button><button class="btn primary" data-ok>Save</button>',
  });
  $('[data-ok]', m.el).onclick = async () => {
    const body = { name: $('#cn', m.el).value.trim(), icon: $('#ci', m.el).value.trim(), color: $('#cc', m.el).value, sort: Number($('#cs', m.el).value) || 0 };
    if (c) body.active = $('#ca', m.el).checked;
    try { await api(c ? 'PATCH' : 'POST', c ? `/api/menu/categories/${c.id}` : '/api/menu/categories', body); m.close(); toast('Saved', 'ok'); menuPage(); } catch (e) { toastError(e); }
  };
}
async function itemEditor(item, menu, groups) {
  const [ingredients, recipe] = await Promise.all([api('GET', '/api/inventory'), item ? api('GET', `/api/menu/items/${item.id}/recipe`) : Promise.resolve([])]);
  const rows = recipe.map((r) => ({ ingredient_id: r.ingredient_id, qty: r.qty }));
  const itemGroups = new Set((item?.modifier_groups || []).map((g) => g.id));
  const body = document.createElement('div');
  body.className = 'col';
  body.innerHTML = `<div class="grid-2">
      <label class="field"><span>Name</span><input class="input" id="in" maxlength="60" value="${h(item?.name || '')}"></label>
      <label class="field"><span>SKU / PLU</span><input class="input" id="is" maxlength="30" value="${h(item?.sku || '')}"></label>
      <label class="field"><span>Category</span><select class="input" id="ic">${menu.categories.map((c) => `<option value="${c.id}" ${c.id === item?.category_id ? 'selected' : ''}>${h(c.name)}</option>`).join('')}</select></label>
      <label class="field"><span>Price (VAT-inclusive)</span><input class="input" id="ip" type="number" min="0" step="0.01" value="${item ? (item.price / 100).toFixed(2) : ''}"></label>
      <label class="field"><span>Icon (emoji)</span><input class="input" id="ii" maxlength="8" value="${h(item?.icon || '🍽️')}"></label>
      <label class="field"><span>Kitchen station</span><select class="input" id="st">${['grill', 'fryer', 'assembly', 'drinks', 'dessert', 'kitchen'].map((s) => `<option ${s === (item?.station || 'kitchen') ? 'selected' : ''}>${s}</option>`).join('')}</select></label></div>
    <label class="field"><span>Description</span><input class="input" id="id" maxlength="200" value="${h(item?.description || '')}"></label>
    <div class="row"><label class="check"><input type="checkbox" id="ia" ${item?.active !== false ? 'checked' : ''}> Active</label>
      <label class="check"><input type="checkbox" id="iv" ${item?.vat_exempt_eligible !== false ? 'checked' : ''}> Eligible for SC/PWD discount</label></div>
    <h4>Modifier groups</h4><div class="checks">${groups.map((g) => `<label class="check"><input type="checkbox" data-g="${g.id}" ${itemGroups.has(g.id) ? 'checked' : ''}> ${h(g.name)} <span class="faint xs">(${g.min_select}-${g.max_select})</span></label>`).join('')}</div>
    <h4>Recipe (per unit) <span class="muted small" id="cost"></span></h4><div class="col" id="recipe"></div><button class="btn sm" id="add-ing" style="align-self:flex-start">+ Ingredient</button>`;
  const drawRecipe = () => {
    $('#recipe', body).innerHTML = rows.map((r, i) => `<div class="recipe-row"><select class="input" data-ri="${i}">${ingredients.map((g) => `<option value="${g.id}" ${g.id === r.ingredient_id ? 'selected' : ''}>${h(g.name)} (${h(g.unit)})</option>`).join('')}</select>
      <input class="input" type="number" min="0" step="0.01" data-rq="${i}" value="${r.qty}"><button class="btn ghost icon-btn" data-rx="${i}">✕</button></div>`).join('') || '<div class="faint small">No recipe — stock will not be tracked for this item.</div>';
    const cost = rows.reduce((s, r) => s + (ingredients.find((g) => g.id === r.ingredient_id)?.cost_per_unit || 0) * r.qty, 0);
    const price = toCents($('#ip', body).value);
    $('#cost', body).textContent = rows.length ? `· food cost ${money(Math.round(cost))}${price ? ` (${((cost / price) * 100).toFixed(0)}% of price)` : ''}` : '';
  };
  drawRecipe();
  body.oninput = (e) => {
    if (e.target.dataset.rq !== undefined) rows[Number(e.target.dataset.rq)].qty = Number(e.target.value);
    if (e.target.dataset.ri !== undefined) rows[Number(e.target.dataset.ri)].ingredient_id = Number(e.target.value);
    if (e.target.id === 'ip' || e.target.dataset.rq !== undefined || e.target.dataset.ri !== undefined) {
      const cost = rows.reduce((s, r) => s + (ingredients.find((g) => g.id === r.ingredient_id)?.cost_per_unit || 0) * r.qty, 0);
      const price = toCents($('#ip', body).value);
      $('#cost', body).textContent = rows.length ? `· food cost ${money(Math.round(cost))}${price ? ` (${((cost / price) * 100).toFixed(0)}% of price)` : ''}` : '';
    }
  };
  body.onclick = (e) => {
    if (e.target.id === 'add-ing') { rows.push({ ingredient_id: ingredients[0]?.id, qty: 1 }); drawRecipe(); }
    const x = e.target.closest('[data-rx]'); if (x) { rows.splice(Number(x.dataset.rx), 1); drawRecipe(); }
  };
  const m = modal({ title: item ? `Edit ${item.name}` : 'New menu item', body, wide: true, footer: '<button class="btn" data-close>Cancel</button><button class="btn primary" data-ok>Save</button>' });
  $('[data-ok]', m.el).onclick = async () => {
    const payload = {
      name: $('#in', body).value.trim(), sku: $('#is', body).value.trim() || null, category_id: Number($('#ic', body).value),
      price: toCents($('#ip', body).value), icon: $('#ii', body).value.trim() || '🍽️', station: $('#st', body).value,
      description: $('#id', body).value.trim(), active: $('#ia', body).checked, vat_exempt_eligible: $('#iv', body).checked,
      modifier_group_ids: $$('[data-g]', body).filter((c) => c.checked).map((c) => Number(c.dataset.g)),
    };
    try {
      const saved = await api(item ? 'PATCH' : 'POST', item ? `/api/menu/items/${item.id}` : '/api/menu/items', payload);
      await api('PUT', `/api/menu/items/${saved.id}/recipe`, { components: rows.filter((r) => r.ingredient_id && r.qty > 0) });
      m.close(); toast('Menu item saved', 'ok'); menuPage();
    } catch (e) { toastError(e); }
  };
}

// ---------- inventory ----------
async function inventory() {
  const rows = await api('GET', '/api/inventory');
  const value = rows.reduce((s, r) => s + Math.max(0, r.stock) * r.cost_per_unit, 0);
  main.innerHTML = `<div class="page-head"><h1>Inventory</h1><div class="toolbar"><span class="badge">${rows.length} ingredients</span><span class="badge info">Stock value ${money(Math.round(value))}</span>
    <span class="badge ${rows.some((r) => r.low) ? 'warn' : 'ok'}">${rows.filter((r) => r.low).length} low</span><button class="btn primary" id="add">+ Ingredient</button></div></div>
    <div class="card table-wrap"><table class="table"><thead><tr><th>Ingredient</th><th class="num">On hand</th><th>Unit</th><th class="num">Reorder at</th><th class="num">Unit cost</th><th>Used by</th><th>Status</th><th></th></tr></thead><tbody>
    ${rows.map((r) => `<tr><td><b>${h(r.name)}</b></td><td class="num"><b>${fmtQty(r.stock)}</b></td><td>${h(r.unit)}</td><td class="num">${fmtQty(r.reorder_level)}</td><td class="num">${money(r.cost_per_unit)}</td>
      <td class="small">${r.used_by} items</td><td>${r.stock <= 0 ? '<span class="badge bad">Out</span>' : r.low ? '<span class="badge warn">Low</span>' : '<span class="badge ok">OK</span>'}</td>
      <td class="right"><button class="btn sm" data-adj="receive" data-id="${r.id}">Receive</button> <button class="btn sm" data-adj="waste" data-id="${r.id}">Waste</button> <button class="btn sm" data-adj="count" data-id="${r.id}">Count</button> <button class="btn sm ghost" data-hist="${r.id}">History</button> <button class="btn sm ghost" data-edit="${r.id}">Edit</button></td></tr>`).join('')}
    </tbody></table></div>`;
  $('#add').onclick = () => ingredientEditor(null);
  main.onclick = async (e) => {
    const a = e.target.closest('[data-adj]');
    const ing = (id) => rows.find((r) => r.id === Number(id));
    if (a) return adjust(ing(a.dataset.id), a.dataset.adj);
    const hi = e.target.closest('[data-hist]');
    if (hi) {
      const mv = await api('GET', `/api/inventory/${hi.dataset.hist}/movements`);
      modal({ title: `${ing(hi.dataset.hist).name} — stock movements`, wide: true,
        body: `<div class="table-wrap"><table class="table"><thead><tr><th>When</th><th>Reason</th><th class="num">Change</th><th>Reference</th><th>By</th></tr></thead><tbody>${mv.map((x) => `<tr><td class="small">${fmtDateTime(x.created_at)}</td><td><span class="badge">${x.reason}</span></td><td class="num" style="color:${x.qty_change < 0 ? 'var(--bad)' : 'var(--ok)'}">${x.qty_change > 0 ? '+' : ''}${fmtQty(x.qty_change)}</td><td class="small">${h(x.ref || '')}</td><td class="small">${h(x.user_name || '')}</td></tr>`).join('')}</tbody></table></div>` });
    }
    const ed = e.target.closest('[data-edit]');
    if (ed) ingredientEditor(ing(ed.dataset.edit));
  };
}
function adjust(ing, type) {
  const label = { receive: 'Receive delivery', waste: 'Record waste', count: 'Physical count' }[type];
  const m = modal({ title: `${label} · ${ing.name}`,
    body: `<p class="muted">On hand: <b>${fmtQty(ing.stock)} ${h(ing.unit)}</b></p>
      <label class="field"><span>${type === 'count' ? 'Counted quantity' : 'Quantity'} (${h(ing.unit)})</span><input class="input" id="q" type="number" min="0" step="0.01"></label>
      <label class="field"><span>Note</span><input class="input" id="n" maxlength="120" placeholder="${type === 'receive' ? 'Supplier / DR number' : type === 'waste' ? 'e.g. expired, dropped' : 'e.g. month-end count'}"></label>`,
    footer: '<button class="btn" data-close>Cancel</button><button class="btn primary" data-ok>Save</button>' });
  $('[data-ok]', m.el).onclick = async () => {
    try { await api('POST', `/api/inventory/${ing.id}/adjust`, { type, qty: Number($('#q', m.el).value), note: $('#n', m.el).value.trim() || null }); m.close(); toast('Stock updated', 'ok'); inventory(); } catch (e) { toastError(e); }
  };
}
function ingredientEditor(ing) {
  const m = modal({ title: ing ? `Edit ${ing.name}` : 'New ingredient',
    body: `<div class="grid-2"><label class="field"><span>Name</span><input class="input" id="n" value="${h(ing?.name || '')}" maxlength="60"></label>
      <label class="field"><span>Unit</span><input class="input" id="u" value="${h(ing?.unit || 'pc')}" maxlength="10"></label>
      ${ing ? '' : '<label class="field"><span>Opening stock</span><input class="input" id="s" type="number" min="0" step="0.01" value="0"></label>'}
      <label class="field"><span>Reorder level</span><input class="input" id="r" type="number" min="0" step="0.01" value="${ing?.reorder_level ?? 0}"></label>
      <label class="field"><span>Cost per unit</span><input class="input" id="c" type="number" min="0" step="0.0001" value="${ing ? ing.cost_per_unit / 100 : 0}"></label></div>`,
    footer: '<button class="btn" data-close>Cancel</button><button class="btn primary" data-ok>Save</button>' });
  $('[data-ok]', m.el).onclick = async () => {
    const body = { name: $('#n', m.el).value.trim(), unit: $('#u', m.el).value.trim(), reorder_level: Number($('#r', m.el).value), cost_per_unit: toCents($('#c', m.el).value) };
    if (!ing) body.stock = Number($('#s', m.el).value);
    try { await api(ing ? 'PATCH' : 'POST', ing ? `/api/inventory/${ing.id}` : '/api/inventory', body); m.close(); toast('Saved', 'ok'); inventory(); } catch (e) { toastError(e); }
  };
}

// ---------- shifts & Z ----------
async function shifts() {
  const [list, zs] = await Promise.all([api('GET', '/api/shifts'), api('GET', '/api/reports/z')]);
  main.innerHTML = `<div class="page-head"><h1>Shifts & Z-reading</h1><div class="toolbar"><input class="input" type="date" id="zd" value="${today()}" style="width:auto"><button class="btn primary" id="gen">Generate Z-reading</button></div></div>
    <div class="dash-grid">
      <div class="card panel"><h3>Cashier shifts</h3><div class="table-wrap"><table class="table"><thead><tr><th>#</th><th>Cashier</th><th>Opened</th><th>Status</th><th class="num">Expected</th><th class="num">Counted</th><th class="num">Over/short</th></tr></thead><tbody>
        ${list.map((s) => `<tr data-shift="${s.id}" style="cursor:pointer"><td>${s.id}</td><td>${h(s.user_name)}<div class="xs muted">${h(s.terminal)}</div></td><td class="small">${fmtDateTime(s.opened_at)}</td>
          <td><span class="badge ${s.status === 'open' ? 'info' : ''}">${s.status}</span></td><td class="num">${s.expected_cash != null ? money(s.expected_cash) : '—'}</td><td class="num">${s.counted_cash != null ? money(s.counted_cash) : '—'}</td>
          <td class="num">${s.variance != null ? `<span class="badge ${s.variance === 0 ? 'ok' : Math.abs(s.variance) <= 2000 ? 'warn' : 'bad'}">${s.variance > 0 ? '+' : ''}${money(s.variance)}</span>` : '—'}</td></tr>`).join('')}</tbody></table></div></div>
      <div class="card panel"><h3>Z-readings (end of day)</h3><div class="table-wrap"><table class="table"><thead><tr><th>Z #</th><th>Date</th><th class="num">Net sales</th><th></th></tr></thead><tbody>
        ${zs.map((z) => `<tr><td><b>${pad(z.z_no, 4)}</b></td><td>${z.business_date}</td><td class="num">${money(z.data.sales.net_sales)}</td><td class="right"><button class="btn sm" data-z="${z.z_no}">View</button></td></tr>`).join('') || '<tr><td colspan="4" class="empty">No Z-readings yet</td></tr>'}</tbody></table></div></div>
    </div>`;
  $('#gen').onclick = async () => {
    const date = $('#zd').value;
    if (!(await confirmBox('Generate Z-reading', `This closes the books for ${date}. It can only be done once per day and requires all shifts to be closed.`, { okText: 'Generate' }))) return;
    try { const z = await api('POST', '/api/reports/z', { date }); showZ(z); shifts(); } catch (e) { toastError(e); }
  };
  main.onclick = async (e) => {
    const zb = e.target.closest('[data-z]');
    if (zb) showZ(zs.find((z) => z.z_no === Number(zb.dataset.z)));
    const sr = e.target.closest('[data-shift]');
    if (sr) {
      const sum = await api('GET', `/api/shifts/${sr.dataset.shift}`);
      modal({ title: `Shift #${sum.shift.id} · ${sum.shift.user_name}`, body: `<div class="kpis">
        <div class="card kpi"><div class="kl">Transactions</div><div class="kv">${sum.orders_count}</div></div>
        <div class="card kpi"><div class="kl">Sales</div><div class="kv">${money(sum.gross_sales)}</div></div>
        <div class="card kpi"><div class="kl">Expected cash</div><div class="kv">${money(sum.expected_cash)}</div></div></div>
        ${hbars(sum.payments, { name: (r) => PAY_LABELS[r.method], value: (r) => r.amount, fmt: (r) => money(r.amount) })}
        <table class="table"><tbody>${sum.movements.map((mv) => `<tr><td>${mv.type}</td><td>${h(mv.reason)}</td><td class="num">${money(mv.amount)}</td><td class="small">${fmtTime(mv.created_at)}</td></tr>`).join('')}</tbody></table>` });
    }
  };
}
function showZ(z) {
  const d = z.data;
  const r = (l, v) => `<div class="r"><span>${l}</span><span>${v}</span></div>`;
  const m2 = (c) => money(c, { sign: false });
  const m = modal({ title: `Z-reading #${pad(z.z_no, 4)}`, body: `<div class="receipt"><div class="c big">Z-READING</div><div class="c">${h(settings.store_name)}</div><div class="c">TIN ${h(settings.store_tin)}</div><div class="c">${h(settings.permit_no)}</div><hr>
    ${r('Z counter', pad(z.z_no, 4))}${r('Business date', z.business_date)}${r('Beginning OR', d.or_first ? pad(d.or_first, 8) : '—')}${r('Ending OR', d.or_last ? pad(d.or_last, 8) : '—')}<hr>
    ${r('Gross sales', m2(d.sales.gross))}${r('Less SC/PWD disc.', m2(d.sales.sc_pwd_discount))}${r('Less other disc.', m2(d.sales.other_discount))}${r('Service charge', m2(d.sales.service_charge))}
    ${r('Net sales', m2(d.sales.net_sales))}${r('Refunds', m2(d.refunds.amount))}${r(`Voids (${d.voids.count})`, m2(d.voids.amount))}<hr>
    ${r('VATable sales', m2(d.sales.vatable_sales))}${r('VAT amount', m2(d.sales.vat_amount))}${r('VAT-exempt sales', m2(d.sales.vat_exempt_sales))}${r('Zero-rated', m2(0))}<hr>
    ${d.payments.map((p) => r(`${PAY_LABELS[p.method]} (${p.count})`, m2(p.amount))).join('')}<hr>
    ${r('Transactions', d.sales.orders)}${r('Guests', d.sales.guests)}<hr>
    ${r('Old grand total', m2(d.grand_total_start))}${r('New grand total', m2(d.grand_total_end))}<hr><div class="c">Generated ${new Date(z.created_at || Date.now()).toLocaleString()}</div></div>`,
    footer: '<button class="btn" data-print>🖨️ Print</button><button class="btn primary" data-close>Close</button>' });
  $('[data-print]', m.el).onclick = () => window.print();
}

// ---------- tables ----------
async function tablesPage() {
  const rows = await api('GET', '/api/tables');
  main.innerHTML = `<div class="page-head"><h1>Tables</h1><button class="btn primary" id="add">+ Table</button></div>
    <div class="card table-wrap"><table class="table"><thead><tr><th>Table</th><th>Area</th><th class="num">Seats</th><th>Status</th><th></th></tr></thead><tbody>
    ${rows.map((t) => `<tr><td><b>${h(t.name)}</b></td><td>${h(t.area)}</td><td class="num">${t.seats}</td><td>${t.order_id ? `<span class="badge brand">Occupied · #${pad(t.order_no)} · ${money(t.total)}</span>` : '<span class="badge ok">Free</span>'}</td>
    <td class="right"><button class="btn sm" data-edit="${t.id}">Edit</button></td></tr>`).join('')}</tbody></table></div>`;
  const editor = (t) => {
    const m = modal({ title: t ? `Edit ${t.name}` : 'New table', body: `<div class="grid-3"><label class="field"><span>Name</span><input class="input" id="n" value="${h(t?.name || '')}" maxlength="20"></label>
      <label class="field"><span>Seats</span><input class="input" id="s" type="number" min="1" max="50" value="${t?.seats || 4}"></label><label class="field"><span>Area</span><input class="input" id="a" value="${h(t?.area || 'Main Dining')}" maxlength="30"></label></div>
      ${t ? '<label class="check"><input type="checkbox" id="rm"> Remove this table from the floor plan</label>' : ''}`,
      footer: '<button class="btn" data-close>Cancel</button><button class="btn primary" data-ok>Save</button>' });
    $('[data-ok]', m.el).onclick = async () => {
      const body = { name: $('#n', m.el).value.trim(), seats: Number($('#s', m.el).value), area: $('#a', m.el).value.trim() };
      if (t && $('#rm', m.el).checked) body.active = false;
      try { await api(t ? 'PATCH' : 'POST', t ? `/api/tables/${t.id}` : '/api/tables', body); m.close(); tablesPage(); } catch (e) { toastError(e); }
    };
  };
  $('#add').onclick = () => editor(null);
  main.onclick = (e) => { const b = e.target.closest('[data-edit]'); if (b) editor(rows.find((t) => t.id === Number(b.dataset.edit))); };
}

// ---------- staff ----------
async function staff() {
  const rows = await api('GET', '/api/users');
  main.innerHTML = `<div class="page-head"><h1>Staff</h1><button class="btn primary" id="add">+ Staff member</button></div>
    <div class="card table-wrap"><table class="table"><thead><tr><th>Name</th><th>Username</th><th>Role</th><th>PIN</th><th>Status</th><th>Since</th><th></th></tr></thead><tbody>
    ${rows.map((u) => `<tr><td><b>${h(u.full_name)}</b></td><td>${h(u.username)}</td><td><span class="badge ${u.role === 'admin' ? 'brand' : u.role === 'manager' ? 'info' : ''}">${u.role}</span></td>
    <td>${u.has_pin ? '✓' : '—'}</td><td>${u.active ? '<span class="badge ok">Active</span>' : '<span class="badge bad">Disabled</span>'}</td><td class="small">${fmtDateTime(u.created_at)}</td>
    <td class="right"><button class="btn sm" data-edit="${u.id}">Edit</button></td></tr>`).join('')}</tbody></table></div>
    <div class="card card-pad small muted">Roles — <b>Cashier</b>: POS, shifts, 86 items. <b>Kitchen</b>: KDS only. <b>Manager</b>: approvals (void/refund/discount), menu, inventory, reports. <b>Admin</b>: everything incl. staff & settings.</div>`;
  const editor = (u) => {
    const m = modal({ title: u ? `Edit ${u.full_name}` : 'New staff member',
      body: `<div class="grid-2"><label class="field"><span>Full name</span><input class="input" id="fn" value="${h(u?.full_name || '')}" maxlength="60"></label>
        <label class="field"><span>Username</span><input class="input" id="un" value="${h(u?.username || '')}" maxlength="30" ${u ? 'disabled' : ''}></label>
        <label class="field"><span>Role</span><select class="input" id="ro">${['cashier', 'kitchen', 'manager', 'admin'].map((r) => `<option ${r === (u?.role || 'cashier') ? 'selected' : ''}>${r}</option>`).join('')}</select></label>
        <label class="field"><span>${u ? 'New PIN (leave blank to keep)' : 'PIN (4–8 digits)'}</span><input class="input" id="pi" inputmode="numeric" maxlength="8" autocomplete="off"></label>
        <label class="field"><span>${u ? 'New password (leave blank to keep)' : 'Password (min 8)'}</span><input class="input" id="pw" type="password" autocomplete="new-password"></label>
        ${u ? `<label class="check"><input type="checkbox" id="ac" ${u.active ? 'checked' : ''}> Active</label>` : ''}</div>`,
      footer: '<button class="btn" data-close>Cancel</button><button class="btn primary" data-ok>Save</button>' });
    $('[data-ok]', m.el).onclick = async () => {
      const body = { full_name: $('#fn', m.el).value.trim(), role: $('#ro', m.el).value };
      const pin = $('#pi', m.el).value.trim(); const pw = $('#pw', m.el).value;
      if (pin) body.pin = pin; if (pw) body.password = pw;
      if (!u) body.username = $('#un', m.el).value.trim(); else body.active = $('#ac', m.el).checked;
      try { await api(u ? 'PATCH' : 'POST', u ? `/api/users/${u.id}` : '/api/users', body); m.close(); toast('Saved', 'ok'); staff(); } catch (e) { toastError(e); }
    };
  };
  $('#add').onclick = () => editor(null);
  main.onclick = (e) => { const b = e.target.closest('[data-edit]'); if (b) editor(rows.find((x) => x.id === Number(b.dataset.edit))); };
}

// ---------- settings ----------
async function settingsPage() {
  const s = await api('GET', '/api/settings');
  const f = (k, label, type = 'text', extra = '') => `<label class="field"><span>${label}</span><input class="input" id="s-${k}" type="${type}" value="${h(s[k])}" ${extra}></label>`;
  main.innerHTML = `<div class="page-head"><h1>Settings</h1><button class="btn primary" id="save">Save changes</button></div>
    <div class="card panel"><h3>Store & receipt</h3><div class="grid-2">${f('store_name', 'Store name')}${f('store_tin', 'TIN')}${f('store_address', 'Address')}${f('permit_no', 'Permit / PTU no.')}${f('currency_symbol', 'Currency symbol')}${f('receipt_footer', 'Receipt footer')}</div></div>
    <div class="card panel"><h3>Tax & charges</h3><div class="grid-2">
      <label class="check"><input type="checkbox" id="s-vat_registered" ${s.vat_registered ? 'checked' : ''}> VAT registered</label>
      <label class="field"><span>VAT rate (%)</span><input class="input" id="s-vat" type="number" min="0" max="30" step="0.01" value="${s.vat_bps / 100}"></label>
      <label class="field"><span>Service charge (%)</span><input class="input" id="s-svc" type="number" min="0" max="20" step="0.01" value="${s.service_charge_bps / 100}"></label>
      <label class="check"><input type="checkbox" id="s-dine_in_service_charge_only" ${s.dine_in_service_charge_only ? 'checked' : ''}> Service charge on dine-in only</label></div></div>
    <div class="card panel"><h3>Kitchen display</h3><div class="grid-2">${f('kds_warn_minutes', 'Ticket turns amber after (min)', 'number', 'min="1"')}${f('kds_late_minutes', 'Ticket turns red after (min)', 'number', 'min="1"')}</div></div>`;
  $('#save').onclick = async () => {
    const body = {};
    for (const k of ['store_name', 'store_tin', 'store_address', 'permit_no', 'currency_symbol', 'receipt_footer']) body[k] = $(`#s-${k}`).value.trim();
    body.vat_registered = $('#s-vat_registered').checked;
    body.dine_in_service_charge_only = $('#s-dine_in_service_charge_only').checked;
    body.vat_bps = Math.round(Number($('#s-vat').value) * 100);
    body.service_charge_bps = Math.round(Number($('#s-svc').value) * 100);
    body.kds_warn_minutes = Number($('#s-kds_warn_minutes').value);
    body.kds_late_minutes = Number($('#s-kds_late_minutes').value);
    try { settings = await api('PATCH', '/api/settings', body); setCurrency(settings.currency_symbol); toast('Settings saved', 'ok'); } catch (e) { toastError(e); }
  };
}

// ---------- audit ----------
async function auditPage() {
  const rows = await api('GET', '/api/audit?limit=300');
  const sev = (a) => (/void|refund|discount|86|settings|user\./.test(a) ? 'warn' : '');
  main.innerHTML = `<div class="page-head"><h1>Audit log</h1><input class="input" id="aq" placeholder="Filter by action or user" style="max-width:280px"></div>
    <div class="card table-wrap" id="at"></div>`;
  const draw = (q) => {
    const list = rows.filter((r) => !q || r.action.includes(q) || (r.user_name || '').toLowerCase().includes(q));
    $('#at').innerHTML = `<table class="table"><thead><tr><th>When</th><th>User</th><th>Action</th><th>Entity</th><th>Details</th></tr></thead><tbody>
      ${list.map((r) => `<tr><td class="small">${fmtDateTime(r.created_at)}</td><td>${h(r.user_name || 'system')}</td><td><span class="badge ${sev(r.action)}">${h(r.action)}</span></td>
      <td class="small">${h(r.entity || '')} ${r.entity_id ?? ''}</td><td class="xs muted" style="max-width:420px;word-break:break-word">${h(r.details ? JSON.stringify(r.details) : '')}</td></tr>`).join('')}</tbody></table>`;
  };
  draw('');
  $('#aq').oninput = (e) => draw(e.target.value.trim().toLowerCase());
}

function debounce(fn, ms) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }

api('GET', '/api/settings').then((s) => { settings = s; setCurrency(s.currency_symbol); route(); }).catch(toastError);
