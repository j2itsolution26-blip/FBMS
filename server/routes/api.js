'use strict';
/**
 * REST API surface. Each handler validates input at the boundary (lib/validate)
 * and delegates to a service. Handlers return a plain object that is sent as
 * JSON, or { status, body } for non-200 responses.
 */
const v = require('../lib/validate');
const { unauthorized, forbidden, badRequest } = require('../lib/errors');
const { can, ROLES } = require('../auth/rbac');
const { businessDate } = require('../lib/time');
const { createRateLimiter } = require('../http/rateLimit');

const ORDER_TYPES = ['dine_in', 'take_out', 'drive_thru', 'delivery'];
const PAY_METHODS = ['cash', 'card', 'gcash', 'maya', 'voucher'];
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function registerApi(router, s, opts = {}) {
  const loginLimiter = createRateLimiter({ windowMs: 60_000, max: 10, message: 'Too many login attempts. Wait a minute and try again.' });
  const kioskLimiter = createRateLimiter({ windowMs: 60_000, max: 20, message: 'Too many orders from this kiosk. Please ask a crew member.' });
  const overrideLimiter = createRateLimiter({ windowMs: 60_000, max: 15, message: 'Too many approval attempts' });

  // ---- auth guards ----
  const auth = (capability) => async (ctx) => {
    const header = ctx.req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    const user = await s.users.authenticate(token);
    if (!user) throw unauthorized();
    if (capability && !can(user.role, capability)) throw forbidden();
    ctx.user = { ...user, ip: ctx.ip };
    ctx.token = token;
    // Manager PINs can be brute-forced from any till, so throttle attempts.
    if (ctx.body && ctx.body.manager_pin) overrideLimiter(`${ctx.ip}:${user.id}`);
  };

  const date = (x, name) => { if (x && !DATE_RE.test(x)) throw badRequest(`${name} must be YYYY-MM-DD`); return x; };
  const cents = (x, name, opts = {}) => v.int(x, name, { min: 0, max: 100_000_000, ...opts });

  // ---- health & public ----
  router.get('/api/health', () => ({ ok: true, time: new Date().toISOString(), business_date: businessDate(), database: s.db.kind }));
  router.get('/api/public/config', async () => {
    const st = await s.settings.all();
    return {
      store_name: st.store_name, currency_symbol: st.currency_symbol, kds_warn_minutes: st.kds_warn_minutes, kds_late_minutes: st.kds_late_minutes,
      // false on serverless hosts: clients poll /api/public/changes instead of holding an SSE stream.
      realtime: opts.realtime !== false,
      needs_setup: await s.users.needsSetup(),
    };
  });
  router.get('/api/public/menu', async () => await s.menu.getMenu());
  router.get('/api/public/board', async () => await s.orders.displayBoard());
  router.get('/api/public/events', async (ctx) => {
    // 204 tells EventSource not to reconnect; the client falls back to polling.
    if (opts.realtime === false) return { status: 204, body: null };
    s.bus.subscribe(ctx.req, ctx.res);
    return undefined;
  });
  router.get('/api/public/changes', async (ctx) => {
    const since = ctx.query.since && !Number.isNaN(Date.parse(ctx.query.since)) ? new Date(ctx.query.since).toISOString() : new Date(Date.now() - 60_000).toISOString();
    return { now: new Date().toISOString(), events: await s.orders.changesSince(since) };
  });

  // First-run: create the owner account on an empty database (no demo seed).
  router.post('/api/setup', async (ctx) => {
    loginLimiter(ctx.ip);
    const b = v.obj(ctx.body, 'body');
    const pin = v.str(b.pin, 'pin', { max: 8 });
    s.users.validatePin(pin);
    const owner = await s.users.setupOwner({
      username: v.str(b.username, 'username', { min: 3, max: 30 }), full_name: v.str(b.full_name, 'full_name', { max: 60 }),
      password: v.str(b.password, 'password', { min: 8, max: 200 }), pin,
    });
    if (b.store_name) await s.settings.update({ store_name: v.str(b.store_name, 'store_name', { max: 80 }) });
    await s.audit.log({ ...owner, ip: ctx.ip }, 'setup.owner_created', 'user', owner.id);
    return { status: 201, body: await s.users.loginWithPassword(owner.username, b.password, 'POS-1') };
  });
  router.get('/api/auth/roster', async () => await s.users.loginRoster());

  router.post('/api/kiosk/orders', async (ctx) => {
    kioskLimiter(ctx.ip);
    const b = v.obj(ctx.body, 'body');
    const lines = parseLines(b.lines, 1);
    const order = await s.orders.create(null, {
      type: v.oneOf(b.type, 'type', ['dine_in', 'take_out']),
      customer_name: v.str(b.customer_name, 'customer_name', { max: 40, optional: true }),
      lines,
    }, { source: 'kiosk' });
    return { status: 201, body: { id: order.id, order_no: order.order_no, total: order.total, subtotal: order.subtotal, lines: order.lines.length } };
  });

  // ---- auth ----
  router.post('/api/auth/login', async (ctx) => {
    loginLimiter(ctx.ip);
    const b = v.obj(ctx.body, 'body');
    const terminal = v.str(b.terminal, 'terminal', { max: 40, optional: true });
    let session;
    if (b.pin !== undefined) {
      session = await s.users.loginWithPin(v.int(b.user_id, 'user_id', { min: 1 }), v.str(b.pin, 'pin', { max: 8 }), terminal);
    } else {
      session = await s.users.loginWithPassword(v.str(b.username, 'username', { max: 40 }), v.str(b.password, 'password', { max: 200 }), terminal);
    }
    await s.audit.log({ ...session.user, ip: ctx.ip }, 'auth.login', 'user', session.user.id, { terminal });
    return session;
  });
  router.post('/api/auth/logout', auth(), async (ctx) => { await s.users.logout(ctx.token); return { ok: true }; });
  router.get('/api/auth/me', auth(), async (ctx) => ({ user: ctx.user, shift: await s.shifts.current(ctx.user.id) }));

  // ---- menu ----
  router.get('/api/menu', auth(), async () => await s.menu.getMenu({ includeInactive: true }));
  router.get('/api/menu/modifier-groups', auth('menu.manage'), async () => await s.menu.listModifierGroups());
  router.post('/api/menu/categories', auth('menu.manage'), async (ctx) => {
    const b = v.obj(ctx.body, 'body');
    const c = await s.menu.createCategory({ name: v.str(b.name, 'name', { max: 40 }), icon: v.str(b.icon, 'icon', { max: 8, optional: true }), color: v.str(b.color, 'color', { max: 20, optional: true }), sort: v.int(b.sort, 'sort', { optional: true }) });
    await s.audit.log(ctx.user, 'menu.category_create', 'category', c.id, { name: c.name });
    return { status: 201, body: c };
  });
  router.patch('/api/menu/categories/:id', auth('menu.manage'), async (ctx) => {
    const b = v.obj(ctx.body, 'body');
    const c = await s.menu.updateCategory(v.int(ctx.params.id, 'id'), { name: v.str(b.name, 'name', { max: 40, optional: true }), icon: v.str(b.icon, 'icon', { max: 8, optional: true }), color: v.str(b.color, 'color', { max: 20, optional: true }), sort: v.int(b.sort, 'sort', { optional: true }), active: v.bool(b.active, 'active', { optional: true }) });
    await s.audit.log(ctx.user, 'menu.category_update', 'category', c.id, b);
    return c;
  });
  const itemFields = (b, optional) => ({
    category_id: v.int(b.category_id, 'category_id', { min: 1, optional }),
    sku: v.str(b.sku, 'sku', { max: 30, optional: true }),
    name: v.str(b.name, 'name', { max: 60, optional }),
    description: v.str(b.description, 'description', { max: 200, optional: true }),
    price: cents(b.price, 'price', { optional }),
    icon: v.str(b.icon, 'icon', { max: 8, optional: true }),
    station: v.str(b.station, 'station', { max: 20, optional: true }),
    sort: v.int(b.sort, 'sort', { optional: true }),
    active: v.bool(b.active, 'active', { optional: true }),
    available: v.bool(b.available, 'available', { optional: true }),
    vat_exempt_eligible: v.bool(b.vat_exempt_eligible, 'vat_exempt_eligible', { optional: true }),
    modifier_group_ids: b.modifier_group_ids === undefined ? undefined : v.arr(b.modifier_group_ids, 'modifier_group_ids', { max: 20 }).map((x) => v.int(x, 'modifier group', { min: 1 })),
  });
  router.post('/api/menu/items', auth('menu.manage'), async (ctx) => {
    const item = await s.menu.createItem(itemFields(v.obj(ctx.body, 'body'), false));
    await s.audit.log(ctx.user, 'menu.item_create', 'item', item.id, { name: item.name, price: item.price });
    return { status: 201, body: item };
  });
  router.patch('/api/menu/items/:id', auth('menu.manage'), async (ctx) => {
    const id = v.int(ctx.params.id, 'id');
    const before = await s.menu.getItem(id);
    const item = await s.menu.updateItem(id, itemFields(v.obj(ctx.body, 'body'), true));
    await s.audit.log(ctx.user, 'menu.item_update', 'item', id, { changes: ctx.body, previous_price: before.price });
    return item;
  });
  // Cashiers may 86 an item from the till when the kitchen runs out.
  router.post('/api/menu/items/:id/availability', auth('pos.use'), async (ctx) => {
    const id = v.int(ctx.params.id, 'id');
    const available = v.bool(v.obj(ctx.body, 'body').available, 'available');
    const item = await s.menu.updateItem(id, { available });
    await s.audit.log(ctx.user, available ? 'menu.item_restore' : 'menu.item_86', 'item', id, { name: item.name });
    return item;
  });
  router.get('/api/menu/items/:id/recipe', auth('inventory.manage'), async (ctx) => await s.inventory.getRecipe(v.int(ctx.params.id, 'id')));
  router.put('/api/menu/items/:id/recipe', auth('inventory.manage'), async (ctx) => {
    const comps = v.arr(v.obj(ctx.body, 'body').components, 'components', { max: 50 }).map((c) => ({
      ingredient_id: v.int(c.ingredient_id, 'ingredient_id', { min: 1 }), qty: v.num(c.qty, 'qty', { min: 0.0001, max: 100000 }),
    }));
    const id = v.int(ctx.params.id, 'id');
    const r = await s.inventory.setRecipe(id, comps);
    await s.audit.log(ctx.user, 'inventory.recipe_update', 'item', id, { components: comps });
    return r;
  });

  // ---- tables ----
  router.get('/api/tables', auth('pos.use'), async () => await s.tables.list());
  router.post('/api/tables', auth('menu.manage'), async (ctx) => {
    const b = v.obj(ctx.body, 'body');
    return { status: 201, body: await s.tables.create({ name: v.str(b.name, 'name', { max: 20 }), seats: v.int(b.seats, 'seats', { min: 1, max: 50, optional: true }), area: v.str(b.area, 'area', { max: 30, optional: true }) }) };
  });
  router.patch('/api/tables/:id', auth('menu.manage'), async (ctx) => {
    const b = v.obj(ctx.body, 'body');
    return await s.tables.update(v.int(ctx.params.id, 'id'), { name: v.str(b.name, 'name', { max: 20, optional: true }), seats: v.int(b.seats, 'seats', { min: 1, max: 50, optional: true }), area: v.str(b.area, 'area', { max: 30, optional: true }), active: v.bool(b.active, 'active', { optional: true }) });
  });

  // ---- orders ----
  function parseLines(lines, min = 0) {
    return v.arr(lines, 'lines', { min, max: 200 }).map((l, i) => {
      v.obj(l, `lines[${i}]`);
      return {
        id: v.int(l.id, `lines[${i}].id`, { min: 1, optional: true }) ?? undefined,
        item_id: v.int(l.item_id, `lines[${i}].item_id`, { min: 1 }),
        qty: v.int(l.qty, `lines[${i}].qty`, { min: 1, max: 999 }),
        modifiers: v.arr(l.modifiers ?? [], `lines[${i}].modifiers`, { max: 30 }).map((m) => v.int(m, 'modifier', { min: 1 })),
        notes: v.str(l.notes, `lines[${i}].notes`, { max: 120, optional: true }),
      };
    });
  }
  function parseOrderBody(b, { creating }) {
    const out = {};
    if (b.type !== undefined || creating) out.type = v.oneOf(b.type ?? 'take_out', 'type', ORDER_TYPES);
    if (b.table_id !== undefined) out.table_id = b.table_id === null ? null : v.int(b.table_id, 'table_id', { min: 1 });
    if (b.customer_name !== undefined) out.customer_name = v.str(b.customer_name, 'customer_name', { max: 60, optional: true });
    if (b.notes !== undefined) out.notes = v.str(b.notes, 'notes', { max: 200, optional: true });
    if (b.guest_count !== undefined) out.guest_count = v.int(b.guest_count, 'guest_count', { min: 1, max: 100 });
    if (b.sc_pwd_count !== undefined) {
      out.sc_pwd_count = v.int(b.sc_pwd_count, 'sc_pwd_count', { min: 0, max: 100 });
      out.sc_pwd_ids = v.arr(b.sc_pwd_ids ?? [], 'sc_pwd_ids', { max: 100 }).map((x) => v.str(x, 'ID number', { max: 40 }));
    }
    if (b.discount !== undefined) {
      if (b.discount === null) out.discount = null;
      else {
        const d = v.obj(b.discount, 'discount');
        const type = v.oneOf(d.type, 'discount.type', ['percent', 'amount']);
        out.discount = {
          type,
          value: type === 'percent' ? v.int(d.value, 'discount.value', { min: 1, max: 10000 }) : cents(d.value, 'discount.value', { min: 1 }),
          label: v.str(d.label, 'discount.label', { max: 40, optional: true }),
        };
      }
    }
    if (b.lines !== undefined) out.lines = parseLines(b.lines);
    if (b.manager_pin !== undefined) out.manager_pin = v.str(b.manager_pin, 'manager_pin', { max: 8 });
    if (b.void_reason !== undefined) out.void_reason = v.str(b.void_reason, 'void_reason', { max: 120, optional: true });
    return out;
  }

  router.get('/api/orders', auth('pos.use'), async (ctx) => {
    const q = ctx.query;
    return await s.orders.list({
      status: q.status && /^[a-z,]+$/.test(q.status) ? q.status : undefined,
      date: date(q.date, 'date'), from: date(q.from, 'from'), to: date(q.to, 'to'),
      type: q.type ? v.oneOf(q.type, 'type', ORDER_TYPES) : undefined,
      source: q.source ? v.oneOf(q.source, 'source', ['pos', 'kiosk']) : undefined,
      q: q.q ? v.str(q.q, 'q', { max: 40 }) : undefined,
      limit: v.int(q.limit, 'limit', { min: 1, max: 500, optional: true }) ?? 100,
    });
  });
  router.post('/api/orders', auth('pos.use'), async (ctx) => ({ status: 201, body: await s.orders.create(ctx.user, parseOrderBody(v.obj(ctx.body, 'body'), { creating: true })) }));
  router.get('/api/orders/:id', auth('pos.use'), async (ctx) => await s.orders.get(v.int(ctx.params.id, 'id')));
  router.put('/api/orders/:id', auth('pos.use'), async (ctx) => await s.orders.update(ctx.user, v.int(ctx.params.id, 'id'), parseOrderBody(v.obj(ctx.body, 'body'), { creating: false })));
  router.post('/api/orders/:id/send', auth('pos.use'), async (ctx) => await s.orders.send(ctx.user, v.int(ctx.params.id, 'id')));
  router.post('/api/orders/:id/pay', auth('pos.use'), async (ctx) => {
    const b = v.obj(ctx.body, 'body');
    const payments = v.arr(b.payments, 'payments', { min: 1, max: 10 }).map((p, i) => ({
      method: v.oneOf(p.method, `payments[${i}].method`, PAY_METHODS),
      amount: cents(p.amount, `payments[${i}].amount`),
      reference: v.str(p.reference, `payments[${i}].reference`, { max: 60, optional: true }),
    }));
    return await s.orders.pay(ctx.user, v.int(ctx.params.id, 'id'), { payments });
  });
  router.post('/api/orders/:id/void', auth('pos.use'), async (ctx) => {
    const b = v.obj(ctx.body, 'body');
    return await s.orders.voidOrder(ctx.user, v.int(ctx.params.id, 'id'), { reason: v.str(b.reason, 'reason', { min: 3, max: 120 }), manager_pin: v.str(b.manager_pin, 'manager_pin', { max: 8, optional: true }) });
  });
  router.post('/api/orders/:id/refund', auth('pos.use'), async (ctx) => {
    const b = v.obj(ctx.body, 'body');
    return await s.orders.refund(ctx.user, v.int(ctx.params.id, 'id'), {
      reason: v.str(b.reason, 'reason', { min: 3, max: 120 }), manager_pin: v.str(b.manager_pin, 'manager_pin', { max: 8, optional: true }),
      restock: v.bool(b.restock ?? false, 'restock'),
    });
  });
  router.get('/api/orders/:id/receipt', auth('pos.use'), async (ctx) => await s.orders.receipt(v.int(ctx.params.id, 'id')));

  // ---- kitchen ----
  router.get('/api/kds', auth('kds.use'), async (ctx) => await s.orders.kitchenQueue({ station: ctx.query.station ? v.str(ctx.query.station, 'station', { max: 20 }) : undefined }));
  router.post('/api/kds/:id/status', auth('kds.use'), async (ctx) => await s.orders.setKitchenStatus(ctx.user, v.int(ctx.params.id, 'id'), v.oneOf(v.obj(ctx.body, 'body').status, 'status', ['queued', 'preparing', 'ready', 'served'])));

  // ---- shifts ----
  router.get('/api/shifts/current', auth('pos.use'), async (ctx) => {
    const sh = await s.shifts.current(ctx.user.id);
    return { shift: sh, summary: sh ? await s.shifts.summary(sh.id) : null };
  });
  router.get('/api/shifts', auth('shifts.manage'), async () => await s.shifts.list());
  router.post('/api/shifts', auth('pos.use'), async (ctx) => {
    const b = v.obj(ctx.body, 'body');
    const sh = await s.shifts.open(ctx.user, { opening_float: cents(b.opening_float, 'opening_float'), terminal: v.str(b.terminal, 'terminal', { max: 40, optional: true }) });
    await s.audit.log(ctx.user, 'shift.open', 'shift', sh.id, { opening_float: sh.opening_float });
    return { status: 201, body: sh };
  });
  router.get('/api/shifts/:id', auth('pos.use'), async (ctx) => {
    const sum = await s.shifts.summary(v.int(ctx.params.id, 'id'));
    if (sum.shift.user_id !== ctx.user.id && !can(ctx.user.role, 'shifts.manage')) throw forbidden();
    return sum;
  });
  router.post('/api/shifts/:id/cash', auth('pos.use'), async (ctx) => {
    const b = v.obj(ctx.body, 'body');
    const id = v.int(ctx.params.id, 'id');
    const r = await s.shifts.addCashMovement(ctx.user, id, { type: v.oneOf(b.type, 'type', ['pay_in', 'payout', 'drop']), amount: cents(b.amount, 'amount', { min: 1 }), reason: v.str(b.reason, 'reason', { min: 2, max: 120 }) });
    await s.audit.log(ctx.user, `shift.${b.type}`, 'shift', id, { amount: b.amount, reason: b.reason });
    return r;
  });
  router.post('/api/shifts/:id/close', auth('pos.use'), async (ctx) => {
    const b = v.obj(ctx.body, 'body');
    const id = v.int(ctx.params.id, 'id');
    const r = await s.shifts.close(ctx.user, id, { counted_cash: cents(b.counted_cash, 'counted_cash'), notes: v.str(b.notes, 'notes', { max: 200, optional: true }) });
    await s.audit.log(ctx.user, 'shift.close', 'shift', id, { counted: r.shift.counted_cash, expected: r.shift.expected_cash, variance: r.shift.variance });
    return r;
  });

  // ---- inventory ----
  router.get('/api/inventory', auth('inventory.manage'), async () => await s.inventory.list());
  router.get('/api/inventory/low', auth('pos.use'), async () => await s.inventory.lowStock());
  router.post('/api/inventory', auth('inventory.manage'), async (ctx) => {
    const b = v.obj(ctx.body, 'body');
    const ing = await s.inventory.create({
      name: v.str(b.name, 'name', { max: 60 }), unit: v.str(b.unit, 'unit', { max: 10 }),
      stock: v.num(b.stock ?? 0, 'stock', { min: 0, max: 1e7 }), reorder_level: v.num(b.reorder_level ?? 0, 'reorder_level', { min: 0, max: 1e7 }),
      cost_per_unit: cents(b.cost_per_unit ?? 0, 'cost_per_unit'),
    }, ctx.user);
    await s.audit.log(ctx.user, 'inventory.create', 'ingredient', ing.id, { name: ing.name });
    return { status: 201, body: ing };
  });
  router.patch('/api/inventory/:id', auth('inventory.manage'), async (ctx) => {
    const b = v.obj(ctx.body, 'body');
    return await s.inventory.update(v.int(ctx.params.id, 'id'), {
      name: v.str(b.name, 'name', { max: 60, optional: true }), unit: v.str(b.unit, 'unit', { max: 10, optional: true }),
      reorder_level: v.num(b.reorder_level, 'reorder_level', { min: 0, max: 1e7, optional: true }), cost_per_unit: cents(b.cost_per_unit, 'cost_per_unit', { optional: true }),
    });
  });
  router.post('/api/inventory/:id/adjust', auth('inventory.manage'), async (ctx) => {
    const b = v.obj(ctx.body, 'body');
    const id = v.int(ctx.params.id, 'id');
    const r = await s.inventory.adjust(id, { type: v.oneOf(b.type, 'type', ['receive', 'waste', 'count']), qty: v.num(b.qty, 'qty', { min: 0, max: 1e7 }), note: v.str(b.note, 'note', { max: 120, optional: true }) }, ctx.user);
    await s.audit.log(ctx.user, `inventory.${b.type}`, 'ingredient', id, { qty: b.qty, note: b.note });
    return r;
  });
  router.get('/api/inventory/:id/movements', auth('inventory.manage'), async (ctx) => await s.inventory.movements(v.int(ctx.params.id, 'id')));

  // ---- reports ----
  router.get('/api/reports/summary', auth('reports.view'), async (ctx) => {
    const today = businessDate();
    return await s.reports.summary({ from: date(ctx.query.from, 'from') || today, to: date(ctx.query.to, 'to') || today });
  });
  router.get('/api/reports/z', auth('reports.view'), async () => await s.reports.zReadings());
  router.post('/api/reports/z', auth('reports.view'), async (ctx) => ({ status: 201, body: await s.reports.generateZ(ctx.user, date(v.obj(ctx.body, 'body').date, 'date') || businessDate()) }));

  // ---- users ----
  router.get('/api/users', auth('users.manage'), async () => await s.users.list());
  router.post('/api/users', auth('users.manage'), async (ctx) => {
    const b = v.obj(ctx.body, 'body');
    const pin = v.str(b.pin, 'pin', { max: 8, optional: true });
    await s.users.validatePin(pin);
    const u = await s.users.create({
      username: v.str(b.username, 'username', { min: 3, max: 30 }), full_name: v.str(b.full_name, 'full_name', { max: 60 }),
      role: v.oneOf(b.role, 'role', ROLES), password: v.str(b.password, 'password', { min: 8, max: 200 }), pin,
    });
    await s.audit.log(ctx.user, 'user.create', 'user', u.id, { username: u.username, role: u.role });
    return { status: 201, body: u };
  });
  router.patch('/api/users/:id', auth('users.manage'), async (ctx) => {
    const b = v.obj(ctx.body, 'body');
    const pin = v.str(b.pin, 'pin', { max: 8, optional: true });
    await s.users.validatePin(pin);
    const id = v.int(ctx.params.id, 'id');
    const u = await s.users.update(id, {
      full_name: v.str(b.full_name, 'full_name', { max: 60, optional: true }), role: v.oneOf(b.role, 'role', ROLES, { optional: true }),
      password: v.str(b.password, 'password', { min: 8, max: 200, optional: true }), pin, active: v.bool(b.active, 'active', { optional: true }),
    });
    await s.audit.log(ctx.user, 'user.update', 'user', id, { role: b.role, active: b.active, password_changed: !!b.password, pin_changed: !!pin });
    return u;
  });

  // ---- settings & audit ----
  router.get('/api/settings', auth(), async () => await s.settings.all());
  router.patch('/api/settings', auth('settings.manage'), async (ctx) => {
    const r = await s.settings.update(v.obj(ctx.body, 'body'));
    await s.audit.log(ctx.user, 'settings.update', 'settings', null, ctx.body);
    return r;
  });
  router.get('/api/audit', auth('audit.view'), async (ctx) => await s.audit.list({ limit: v.int(ctx.query.limit, 'limit', { min: 1, max: 1000, optional: true }) ?? 200, before: v.int(ctx.query.before, 'before', { optional: true }) }));
}

module.exports = { registerApi };
