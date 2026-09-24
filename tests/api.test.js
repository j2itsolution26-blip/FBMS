'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { startTestApp } = require('./helpers');

let t;
let cashier, manager, kitchen, admin;

test.before(async () => {
  t = await startTestApp();
  cashier = await t.loginPin('juan', '1111');
  manager = await t.loginPin('maria', '2222');
  kitchen = await t.loginPin('pedro', '4444');
  admin = (await t.call('POST', '/api/auth/login', { username: 'admin', password: 'Admin@12345' })).body.token;
});
test.after(() => t.stop());

const meal = () => ({
  item_id: t.item('VM2').id, qty: 2,
  modifiers: [t.option('Large Fries').id, t.option('Cola (Reg)').id, t.option('Extra Cheese').id],
});

test('auth: bad PIN and missing token are rejected', async () => {
  const id = t.app.db.prepare("SELECT id FROM users WHERE username='juan'").get().id;
  assert.equal((await t.call('POST', '/api/auth/login', { user_id: id, pin: '0000' })).status, 401);
  assert.equal((await t.call('GET', '/api/orders')).status, 401);
});

test('rbac: kitchen staff cannot use the till or see reports', async () => {
  assert.equal((await t.call('POST', '/api/orders', { lines: [] }, kitchen)).status, 403);
  assert.equal((await t.call('GET', '/api/reports/summary', null, cashier)).status, 403);
});

test('quick-service flow: combo priced server-side → cash payment → KDS → served', async () => {
  const created = await t.call('POST', '/api/orders', { type: 'take_out', lines: [{ ...meal(), unit_price: 1 }] }, cashier);
  assert.equal(created.status, 201);
  const o = created.body;
  // ₱189 + ₱30 large fries + ₱15 cheese = ₱234 each, x2. Client price ignored.
  assert.equal(o.lines[0].unit_price, 23400);
  assert.equal(o.total, 46800);

  const noShift = await t.call('POST', `/api/orders/${o.id}/pay`, { payments: [{ method: 'cash', amount: 50000 }] }, cashier);
  assert.equal(noShift.status, 409, 'payments need an open shift');

  assert.equal((await t.call('POST', '/api/shifts', { opening_float: 200000 }, cashier)).status, 201);
  const short = await t.call('POST', `/api/orders/${o.id}/pay`, { payments: [{ method: 'cash', amount: 40000 }] }, cashier);
  assert.equal(short.status, 400);

  const bunsBefore = t.app.db.prepare("SELECT stock FROM ingredients WHERE name='Burger Bun'").get().stock;
  const paid = await t.call('POST', `/api/orders/${o.id}/pay`, { payments: [{ method: 'cash', amount: 50000 }] }, cashier);
  assert.equal(paid.status, 200);
  assert.equal(paid.body.change, 3200);
  assert.equal(paid.body.order.status, 'paid');
  assert.equal(paid.body.order.kitchen_status, 'queued', 'QSR orders auto-fire to the kitchen on payment');
  assert.ok(paid.body.order.or_number >= 1);
  const bunsAfter = t.app.db.prepare("SELECT stock FROM ingredients WHERE name='Burger Bun'").get().stock;
  assert.equal(bunsBefore - bunsAfter, 2, 'recipe stock deducted');

  const kds = await t.call('GET', '/api/kds', null, kitchen);
  assert.ok(kds.body.some((k) => k.id === o.id));
  assert.equal((await t.call('POST', `/api/kds/${o.id}/status`, { status: 'served' }, kitchen)).status, 409, 'cannot skip to served');
  for (const st of ['preparing', 'ready']) assert.equal((await t.call('POST', `/api/kds/${o.id}/status`, { status: st }, kitchen)).status, 200);
  const board = await t.call('GET', '/api/public/board');
  assert.ok(board.body.ready.includes(o.order_no));
  assert.equal((await t.call('POST', `/api/kds/${o.id}/status`, { status: 'served' }, kitchen)).status, 200);
});

test('modifier rules are enforced', async () => {
  const missing = await t.call('POST', '/api/orders', { lines: [{ item_id: t.item('VM2').id, qty: 1, modifiers: [] }] }, cashier);
  assert.equal(missing.status, 400);
  assert.match(missing.body.error, /choose at least 1/);
  const foreign = await t.call('POST', '/api/orders', { lines: [{ item_id: t.item('B1').id, qty: 1, modifiers: [t.option('Hot Fudge').id] }] }, cashier);
  assert.equal(foreign.status, 400);
});

test('86 an item blocks new sales of it', async () => {
  const id = t.item('E3').id;
  assert.equal((await t.call('POST', `/api/menu/items/${id}/availability`, { available: false }, cashier)).status, 200);
  const r = await t.call('POST', '/api/orders', { lines: [{ item_id: id, qty: 1 }] }, cashier);
  assert.equal(r.status, 409);
  await t.call('POST', `/api/menu/items/${id}/availability`, { available: true }, cashier);
});

test('full-service: send rounds, sent lines need manager to remove, split tender', async () => {
  const tbl = (await t.call('GET', '/api/tables', null, cashier)).body[0];
  const o = (await t.call('POST', '/api/orders', { type: 'dine_in', table_id: tbl.id, guest_count: 2, lines: [{ item_id: t.item('C2').id, qty: 1, modifiers: [t.option('Spicy').id] }] }, cashier)).body;
  assert.equal((await t.call('POST', `/api/orders/${o.id}/send`, null, cashier)).body.kitchen_status, 'queued');
  const tables = (await t.call('GET', '/api/tables', null, cashier)).body;
  assert.equal(tables.find((x) => x.id === tbl.id).order_id, o.id, 'table shows as occupied');

  const cur = (await t.call('GET', `/api/orders/${o.id}`, null, cashier)).body;
  const round2 = [{ id: cur.lines[0].id, item_id: cur.lines[0].item_id, qty: 1, modifiers: [t.option('Spicy').id] }, { item_id: t.item('D1').id, qty: 2, modifiers: [t.option('Regular').id] }];
  const upd = await t.call('PUT', `/api/orders/${o.id}`, { lines: round2 }, cashier);
  assert.equal(upd.status, 200);
  assert.equal(upd.body.lines.length, 2);

  const removeSent = await t.call('PUT', `/api/orders/${o.id}`, { lines: [round2[1]].map((l) => ({ ...l, id: upd.body.lines[1].id })) }, cashier);
  assert.equal(removeSent.status, 403, 'removing a sent line needs approval');
  const approved = await t.call('PUT', `/api/orders/${o.id}`, { lines: [{ ...round2[1], id: upd.body.lines[1].id }], manager_pin: '2222', void_reason: 'Customer changed mind' }, cashier);
  assert.equal(approved.status, 200);
  assert.equal(approved.body.lines.length, 1);

  const total = approved.body.total;
  const gcashNoRef = await t.call('POST', `/api/orders/${o.id}/pay`, { payments: [{ method: 'gcash', amount: 5000 }, { method: 'cash', amount: total }] }, cashier);
  assert.equal(gcashNoRef.status, 400);
  const paid = await t.call('POST', `/api/orders/${o.id}/pay`, { payments: [{ method: 'gcash', amount: 5000, reference: 'GC123' }, { method: 'cash', amount: 10000 }] }, cashier);
  assert.equal(paid.status, 200);
  assert.equal(paid.body.change, 10000 - (total - 5000));
  const audit = (await t.call('GET', '/api/audit', null, manager)).body;
  assert.ok(audit.some((a) => a.action === 'order.line_void' && a.entity_id === o.id));
});

test('senior citizen discount needs ID numbers and applies to share', async () => {
  const body = { type: 'dine_in', guest_count: 2, sc_pwd_count: 1, lines: [{ item_id: t.item('R4').id, qty: 2 }] };
  assert.equal((await t.call('POST', '/api/orders', body, cashier)).status, 400);
  const o = (await t.call('POST', '/api/orders', { ...body, sc_pwd_ids: ['SC-1234'] }, cashier)).body;
  // ₱50: SC share ₱25 → 22.32 exempt → 4.46 off; other ₱25 full.
  assert.equal(o.vat_exempt_sales, 2232);
  assert.equal(o.sc_pwd_discount, 446);
  assert.equal(o.total, 2500 + 2232 - 446);
});

test('manual discount requires manager approval', async () => {
  const o = (await t.call('POST', '/api/orders', { lines: [{ item_id: t.item('B2').id, qty: 1 }] }, cashier)).body;
  const disc = { type: 'percent', value: 1000, label: 'Promo 10%' };
  assert.equal((await t.call('PUT', `/api/orders/${o.id}`, { discount: disc }, cashier)).status, 403);
  assert.equal((await t.call('PUT', `/api/orders/${o.id}`, { discount: disc, manager_pin: '1111' }, cashier)).status, 403, 'cashier PIN is not a manager PIN');
  const ok = await t.call('PUT', `/api/orders/${o.id}`, { discount: disc, manager_pin: '2222' }, cashier);
  assert.equal(ok.status, 200);
  assert.equal(ok.body.other_discount, 790);
});

test('void open order and refund paid order require approval', async () => {
  const o = (await t.call('POST', '/api/orders', { lines: [{ item_id: t.item('S1').id, qty: 1 }] }, cashier)).body;
  assert.equal((await t.call('POST', `/api/orders/${o.id}/void`, { reason: 'Test void' }, cashier)).status, 403);
  const v = await t.call('POST', `/api/orders/${o.id}/void`, { reason: 'Test void', manager_pin: '2222' }, cashier);
  assert.equal(v.body.status, 'voided');
  assert.equal((await t.call('POST', `/api/orders/${o.id}/pay`, { payments: [{ method: 'cash', amount: 10000 }] }, cashier)).status, 409);

  const p = (await t.call('POST', '/api/orders', { lines: [{ item_id: t.item('S1').id, qty: 1 }] }, cashier)).body;
  await t.call('POST', `/api/orders/${p.id}/pay`, { payments: [{ method: 'cash', amount: 10000 }] }, cashier);
  const fries = () => t.app.db.prepare("SELECT stock FROM ingredients WHERE name='Potato Fries'").get().stock;
  const before = fries();
  const r = await t.call('POST', `/api/orders/${p.id}/refund`, { reason: 'Wrong order', manager_pin: '2222', restock: true }, cashier);
  assert.equal(r.status, 200);
  assert.equal(r.body.status, 'refunded');
  assert.equal(fries() - before, 100);
});

test('shift close computes expected cash and variance', async () => {
  const cur = (await t.call('GET', '/api/shifts/current', null, cashier)).body;
  await t.call('POST', `/api/shifts/${cur.shift.id}/cash`, { type: 'drop', amount: 100000, reason: 'Safe drop' }, cashier);
  const sum = (await t.call('GET', `/api/shifts/${cur.shift.id}`, null, cashier)).body;
  const closed = await t.call('POST', `/api/shifts/${cur.shift.id}/close`, { counted_cash: sum.expected_cash - 500 }, cashier);
  assert.equal(closed.body.shift.variance, -500);
  assert.equal(closed.body.shift.status, 'closed');
});

test('kiosk order is priced server-side and lands as open for the cashier', async () => {
  const r = await t.call('POST', '/api/kiosk/orders', { type: 'dine_in', lines: [meal()] });
  assert.equal(r.status, 201);
  assert.equal(r.body.total, 46800);
  const open = (await t.call('GET', '/api/orders?status=open&source=kiosk', null, cashier)).body;
  assert.ok(open.some((o) => o.id === r.body.id));
  assert.equal((await t.call('POST', '/api/kiosk/orders', { type: 'dine_in', lines: [] })).status, 400);
});

test('reports and Z-reading', async () => {
  const s = await t.call('GET', '/api/reports/summary', null, manager);
  assert.equal(s.status, 200);
  assert.ok(s.body.sales.orders >= 3);
  assert.equal(s.body.hourly.length, 24);
  const z = await t.call('POST', '/api/reports/z', {}, manager);
  assert.equal(z.status, 409, 'open orders block the Z-reading');
});

test('users: admin can create staff, last admin cannot be disabled', async () => {
  const u = await t.call('POST', '/api/users', { username: 'rico', full_name: 'Rico Tan', role: 'cashier', password: 'Password123', pin: '5555' }, admin);
  assert.equal(u.status, 201);
  assert.equal((await t.call('POST', '/api/users', { username: 'x', full_name: 'X', role: 'cashier', password: 'short' }, admin)).status, 400);
  const adminId = t.app.db.prepare("SELECT id FROM users WHERE username='admin'").get().id;
  assert.equal((await t.call('PATCH', `/api/users/${adminId}`, { active: false }, admin)).status, 409);
  assert.equal((await t.call('GET', '/api/users', null, manager)).status, 403);
});

test('input validation and unknown routes', async () => {
  assert.equal((await t.call('POST', '/api/orders', { type: 'teleport', lines: [] }, cashier)).status, 400);
  assert.equal((await t.call('GET', '/api/nope', null, cashier)).status, 404);
  const res = await fetch(`${t.base}/../../etc/passwd`);
  assert.equal(res.status, 404);
});
