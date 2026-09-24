'use strict';
/**
 * Order lifecycle — the heart of the POS.
 *
 *   status:          open ──pay──▶ paid ──refund──▶ refunded
 *                      └──void──▶ voided
 *   kitchen_status:  (null) ──send──▶ queued ▶ preparing ▶ ready ▶ served
 *
 * Quick-service (McDo/Jollibee style): build → pay → auto-sent to kitchen.
 * Full-service: build → send to kitchen (tab stays open) → add rounds → pay.
 *
 * Prices are ALWAYS resolved server-side from the catalogue; client-supplied
 * prices are ignored. Lines already sent to the kitchen count as consumed:
 * removing them needs manager approval and does not restock.
 */
const { computeTotals, priceLine } = require('./pricing');
const { badRequest, notFound, conflict } = require('../lib/errors');
const { businessDate, nowIso } = require('../lib/time');

const KITCHEN_FLOW = { queued: ['preparing', 'ready'], preparing: ['ready', 'queued'], ready: ['served', 'preparing'], served: [] };
const NON_CASH = ['card', 'gcash', 'maya', 'voucher'];

function createOrderService({ db, settings, users, inventory, shifts, audit, bus }) {
  async function nextCounter(name, start = 1) {
    await db.run('INSERT INTO counters (name, value) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET value = counters.value + 1', name, start);
    return (await db.get('SELECT value FROM counters WHERE name = ?', name)).value;
  }

  // ---------- line resolution ----------
  /** Validate an incoming line against the catalogue and price it. */
  async function resolveLine(input) {
    const item = await db.get('SELECT * FROM items WHERE id = ?', input.item_id);
    if (!item || !item.active) throw badRequest(`Item ${input.item_id} is not on the menu`);
    const oos = await db.get('SELECT 1 AS x FROM recipes r JOIN ingredients i ON i.id = r.ingredient_id WHERE r.item_id = ? AND i.stock < r.qty LIMIT 1', item.id);
    if (!item.available || oos) throw conflict(`${item.name} is currently unavailable`);
    const groups = await db.all('SELECT g.* FROM item_modifier_groups img JOIN modifier_groups g ON g.id = img.group_id WHERE img.item_id = ?', item.id);
    const chosen = [];
    const perGroup = new Map(groups.map((g) => [g.id, 0]));
    for (const optId of input.modifiers || []) {
      const opt = await db.get('SELECT * FROM modifier_options WHERE id = ? AND active = 1', optId);
      if (!opt || !perGroup.has(opt.group_id)) throw badRequest(`Option ${optId} is not valid for ${item.name}`);
      perGroup.set(opt.group_id, perGroup.get(opt.group_id) + 1);
      const g = groups.find((x) => x.id === opt.group_id);
      chosen.push({ option_id: opt.id, group_id: g.id, group: g.name, name: opt.name, price_delta: opt.price_delta });
    }
    for (const g of groups) {
      const n = perGroup.get(g.id);
      if (n < g.min_select) throw badRequest(`${item.name}: choose at least ${g.min_select} for "${g.name}"`);
      if (n > g.max_select) throw badRequest(`${item.name}: choose at most ${g.max_select} for "${g.name}"`);
    }
    const { unit_price, line_total } = priceLine(item.price, chosen, input.qty);
    return {
      item_id: item.id, name: item.name, station: item.station, base_price: item.price,
      unit_price, qty: input.qty, line_total, modifiers: chosen, notes: input.notes || null,
      vat_exempt_eligible: !!item.vat_exempt_eligible,
    };
  }

  function addLine(orderId, l) {
    return db.run(`INSERT INTO order_lines (order_id, item_id, name, station, base_price, unit_price, qty, line_total, modifiers, notes, sent, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`,
      orderId, l.item_id, l.name, l.station, l.base_price, l.unit_price, l.qty, l.line_total, JSON.stringify(l.modifiers), l.notes, nowIso());
  }

  // ---------- totals ----------
  async function recalc(orderId) {
    const o = await db.get('SELECT * FROM orders WHERE id = ?', orderId);
    const lines = await db.all(`SELECT l.line_total, i.vat_exempt_eligible FROM order_lines l JOIN items i ON i.id = l.item_id WHERE l.order_id = ?`, orderId);
    const s = await settings.all();
    const scBps = s.dine_in_service_charge_only && o.type !== 'dine_in' ? 0 : s.service_charge_bps;
    const t = computeTotals({
      lines: lines.map((l) => ({ line_total: l.line_total, vat_exempt_eligible: !!l.vat_exempt_eligible })),
      guestCount: o.guest_count,
      scPwdCount: o.sc_pwd_count,
      discount: o.discount_type ? { type: o.discount_type, value: o.discount_value } : null,
      serviceChargeBps: scBps,
      vatBps: settings.vatBps(s),
    });
    await db.run(`UPDATE orders SET subtotal = ?, sc_pwd_discount = ?, other_discount = ?, vatable_sales = ?, vat_amount = ?,
      vat_exempt_sales = ?, service_charge = ?, service_charge_rate = ?, total = ?, updated_at = ? WHERE id = ?`,
      t.subtotal, t.sc_pwd_discount, t.other_discount, t.vatable_sales, t.vat_amount, t.vat_exempt_sales, t.service_charge, scBps, t.total, nowIso(), orderId);
  }

  // ---------- reads ----------
  async function get(id) {
    const o = await db.get(`SELECT o.*, t.name AS table_name, c.full_name AS cashier_name, cb.full_name AS created_by_name
      FROM orders o LEFT JOIN dining_tables t ON t.id = o.table_id LEFT JOIN users c ON c.id = o.cashier_id
      LEFT JOIN users cb ON cb.id = o.created_by WHERE o.id = ?`, id);
    if (!o) throw notFound('Order not found');
    const lines = (await db.all('SELECT * FROM order_lines WHERE order_id = ? ORDER BY id', id))
      .map((l) => ({ ...l, sent: !!l.sent, modifiers: JSON.parse(l.modifiers) }));
    const payments = await db.all('SELECT * FROM payments WHERE order_id = ? ORDER BY id', id);
    const refunds = await db.all('SELECT * FROM refunds WHERE order_id = ? ORDER BY id', id);
    return { ...o, sc_pwd_ids: o.sc_pwd_ids ? JSON.parse(o.sc_pwd_ids) : [], stock_deducted: !!o.stock_deducted, lines, payments, refunds };
  }

  function list({ status, date, from, to, type, source, q, limit = 100 } = {}) {
    const where = [];
    const args = [];
    if (status) { where.push(`o.status IN (${status.split(',').map(() => '?').join(',')})`); args.push(...status.split(',')); }
    if (date) { where.push('o.business_date = ?'); args.push(date); }
    if (from) { where.push('o.business_date >= ?'); args.push(from); }
    if (to) { where.push('o.business_date <= ?'); args.push(to); }
    if (type) { where.push('o.type = ?'); args.push(type); }
    if (source) { where.push('o.source = ?'); args.push(source); }
    if (q) {
      where.push('(CAST(o.order_no AS TEXT) = ? OR CAST(o.or_number AS TEXT) = ? OR lower(o.customer_name) LIKE ?)');
      args.push(q, q, `%${q.toLowerCase()}%`);
    }
    args.push(limit);
    return db.all(`SELECT o.id, o.order_no, o.or_number, o.business_date, o.type, o.source, o.status, o.kitchen_status, o.total,
        o.customer_name, o.guest_count, o.created_at, o.paid_at, t.name AS table_name, c.full_name AS cashier_name,
        (SELECT COALESCE(SUM(qty),0) FROM order_lines l WHERE l.order_id = o.id) AS item_count
      FROM orders o LEFT JOIN dining_tables t ON t.id = o.table_id LEFT JOIN users c ON c.id = o.cashier_id
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY o.id DESC LIMIT ?`, ...args);
  }

  /**
   * Order changes since a timestamp — the polling fallback for hosts that
   * can't hold a live event stream (serverless). Same minimal, non-personal
   * fields as the SSE payload.
   */
  async function changesSince(since) {
    const rows = await db.all(`SELECT id, order_no, status, kitchen_status, source, created_at, ready_at, updated_at FROM orders
      WHERE updated_at > ? ORDER BY updated_at LIMIT 200`, since);
    return rows.map((r) => ({
      type: r.created_at > since ? 'order.created' : r.kitchen_status === 'ready' && r.ready_at > since ? 'order.kitchen' : 'order.updated',
      id: r.id, order_no: r.order_no, status: r.status, kitchen_status: r.kitchen_status, source: r.source, at: r.updated_at,
    }));
  }

  // ---------- writes ----------
  async function applyMeta(actor, order, data, approvals) {
    const m = {};
    if (data.type) m.type = data.type;
    if (data.table_id !== undefined) {
      if (data.table_id !== null && !(await db.get('SELECT 1 AS x FROM dining_tables WHERE id = ? AND active = 1', data.table_id))) throw badRequest('Table does not exist');
      m.table_id = data.table_id;
    }
    if (data.customer_name !== undefined) m.customer_name = data.customer_name;
    if (data.notes !== undefined) m.notes = data.notes;
    if (data.guest_count != null) m.guest_count = data.guest_count;
    if (data.sc_pwd_count != null) {
      const guests = m.guest_count ?? order?.guest_count ?? 1;
      if (data.sc_pwd_count > guests) throw badRequest('Senior/PWD count cannot exceed guest count');
      const ids = data.sc_pwd_ids || [];
      // BIR requires the SC/PWD ID number of each beneficiary on the receipt.
      if (data.sc_pwd_count > 0 && (ids.length !== data.sc_pwd_count || ids.some((x) => !x))) {
        throw badRequest('Enter an ID number for each Senior Citizen / PWD');
      }
      m.sc_pwd_count = data.sc_pwd_count;
      m.sc_pwd_ids = JSON.stringify(ids.slice(0, data.sc_pwd_count));
    }
    if (data.discount !== undefined) {
      const d = data.discount;
      const same = order && d && order.discount_type === d.type && order.discount_value === d.value;
      if (!d) {
        Object.assign(m, { discount_type: null, discount_value: 0, discount_label: null, discount_approved_by: null });
      } else if (!same) {
        const approver = await users.resolveApprover(actor, data.manager_pin, 'discount.approve');
        approvals.push({ action: 'discount.apply', approver, details: d });
        Object.assign(m, { discount_type: d.type, discount_value: d.value, discount_label: d.label || 'Discount', discount_approved_by: approver.id });
      }
    }
    return m;
  }

  async function writeMeta(orderId, m) {
    const keys = Object.keys(m);
    if (!keys.length) return;
    await db.run(`UPDATE orders SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`, ...keys.map((k) => m[k]), orderId);
  }

  async function logApprovals(actor, orderId, approvals) {
    for (const a of approvals) await audit.log(actor, a.action, 'order', orderId, { ...a.details, approved_by: a.approver.id, approved_by_name: a.approver.full_name });
  }

  async function create(actor, data, { source = 'pos' } = {}) {
    const approvals = [];
    const lines = [];
    for (const l of data.lines || []) lines.push(await resolveLine(l));
    const id = await db.transaction(async () => {
      const meta = await applyMeta(actor, null, data, approvals);
      const date = businessDate();
      const now = nowIso();
      const r = await db.run(`INSERT INTO orders (order_no, business_date, type, source, status, created_by, created_at, updated_at)
        VALUES (?, ?, ?, ?, 'open', ?, ?, ?)`, await nextCounter(`order_no:${date}`), date, meta.type || 'take_out', source, actor?.id ?? null, now, now);
      const orderId = r.lastInsertRowid;
      delete meta.type;
      await writeMeta(orderId, meta);
      for (const l of lines) await addLine(orderId, l);
      await recalc(orderId);
      await logApprovals(actor, orderId, approvals);
      return orderId;
    });
    const order = await get(id);
    bus.publish('order.created', order);
    return order;
  }

  async function update(actor, id, data) {
    const approvals = [];
    await db.transaction(async () => {
      const order = await db.get('SELECT * FROM orders WHERE id = ?', id);
      if (!order) throw notFound('Order not found');
      if (order.status !== 'open') throw conflict(`Order is already ${order.status}`);
      const meta = await applyMeta(actor, order, data, approvals);
      await writeMeta(id, meta);

      if (Array.isArray(data.lines)) {
        const existing = new Map((await db.all('SELECT * FROM order_lines WHERE order_id = ?', id)).map((l) => [l.id, l]));
        const keep = new Set();
        const voided = [];
        for (const input of data.lines) {
          if (input.id) {
            const cur = existing.get(input.id);
            if (!cur) throw badRequest(`Line ${input.id} does not belong to this order`);
            keep.add(cur.id);
            if (cur.sent) {
              if (input.qty > cur.qty) throw badRequest('Add a new line to order more of an item already sent to the kitchen');
              if (input.qty < cur.qty) voided.push({ name: cur.name, qty: cur.qty - input.qty, line_id: cur.id });
              await db.run('UPDATE order_lines SET qty = ?, line_total = unit_price * ? WHERE id = ?', input.qty, input.qty, cur.id);
            } else {
              const l = await resolveLine(input);
              await db.run('UPDATE order_lines SET qty = ?, unit_price = ?, base_price = ?, line_total = ?, modifiers = ?, notes = ? WHERE id = ?',
                l.qty, l.unit_price, l.base_price, l.line_total, JSON.stringify(l.modifiers), l.notes, cur.id);
            }
          } else {
            await addLine(id, await resolveLine(input));
          }
        }
        for (const [lid, l] of existing) {
          if (keep.has(lid)) continue;
          if (l.sent) voided.push({ name: l.name, qty: l.qty, line_id: lid });
          await db.run('DELETE FROM order_lines WHERE id = ?', lid);
        }
        if (voided.length) {
          const approver = await users.resolveApprover(actor, data.manager_pin, 'orders.void');
          approvals.push({ action: 'order.line_void', approver, details: { lines: voided, reason: data.void_reason || null } });
        }
      }
      await recalc(id);
      await logApprovals(actor, id, approvals);
    });
    const order = await get(id);
    bus.publish('order.updated', order);
    return order;
  }

  /** Mark unsent lines as sent, deduct their stock, and queue the ticket. */
  async function sendInTx(actor, id) {
    const order = await db.get('SELECT * FROM orders WHERE id = ?', id);
    const unsent = await db.all('SELECT * FROM order_lines WHERE order_id = ? AND sent = 0', id);
    if (!unsent.length) return false;
    await inventory.deductForOrder(order, unsent, actor);
    await db.run('UPDATE order_lines SET sent = 1 WHERE order_id = ? AND sent = 0', id);
    // A new round on a finished ticket re-opens it on the KDS.
    const ks = order.kitchen_status && order.kitchen_status !== 'served' && order.kitchen_status !== 'ready' ? order.kitchen_status : 'queued';
    const now = nowIso();
    await db.run(`UPDATE orders SET kitchen_status = ?, sent_at = COALESCE(sent_at, ?), ready_at = CASE WHEN ? = 'queued' THEN NULL ELSE ready_at END,
      stock_deducted = 1, updated_at = ? WHERE id = ?`, ks, now, ks, now, id);
    return true;
  }

  async function send(actor, id) {
    await db.transaction(async () => {
      const order = await db.get('SELECT * FROM orders WHERE id = ?', id);
      if (!order) throw notFound('Order not found');
      if (order.status !== 'open') throw conflict(`Order is already ${order.status}`);
      if (!(await sendInTx(actor, id))) throw conflict('Nothing new to send to the kitchen');
    });
    const order = await get(id);
    bus.publish('order.sent', order);
    return order;
  }

  async function pay(actor, id, { payments }) {
    const shift = await shifts.current(actor.id);
    if (!shift) throw conflict('Open a cashier shift before taking payments');
    let change = 0;
    await db.transaction(async () => {
      const order = await db.get('SELECT * FROM orders WHERE id = ?', id);
      if (!order) throw notFound('Order not found');
      if (order.status !== 'open') throw conflict(`Order is already ${order.status}`);
      const { n: lineCount } = await db.get('SELECT COUNT(*) AS n FROM order_lines WHERE order_id = ?', id);
      if (!lineCount) throw badRequest('Order has no items');

      const nonCash = payments.filter((p) => NON_CASH.includes(p.method));
      const nonCashTotal = nonCash.reduce((s, p) => s + p.amount, 0);
      if (nonCashTotal > order.total) throw badRequest('Card/e-wallet amounts exceed the amount due');
      for (const p of nonCash) {
        if ((p.method === 'gcash' || p.method === 'maya') && !p.reference) throw badRequest(`${p.method.toUpperCase()} reference number is required`);
      }
      const cashDue = order.total - nonCashTotal;
      const cashTendered = payments.filter((p) => p.method === 'cash').reduce((s, p) => s + p.amount, 0);
      if (cashTendered < cashDue) throw badRequest('Insufficient payment', { due: order.total, short: cashDue - cashTendered });
      change = cashTendered - cashDue;

      const now = nowIso();
      const ins = `INSERT INTO payments (order_id, method, amount, tendered, change_given, reference, shift_id, user_id, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`;
      for (const p of nonCash) {
        if (p.amount > 0) await db.run(ins, id, p.method, p.amount, p.amount, 0, p.reference || null, shift.id, actor.id, now);
      }
      if (cashTendered > 0) await db.run(ins, id, 'cash', cashDue, cashTendered, change, null, shift.id, actor.id, now);

      await sendInTx(actor, id);
      await db.run(`UPDATE orders SET status = 'paid', paid_at = ?, cashier_id = ?, shift_id = ?, or_number = ?, updated_at = ? WHERE id = ?`,
        now, actor.id, shift.id, await nextCounter('or_number', 1), now, id);
      await audit.log(actor, 'order.pay', 'order', id, { total: order.total, methods: payments.map((p) => p.method) });
    });
    const order = await get(id);
    bus.publish('order.paid', order);
    return { order, change };
  }

  async function voidOrder(actor, id, { reason, manager_pin }) {
    await db.transaction(async () => {
      const order = await db.get('SELECT * FROM orders WHERE id = ?', id);
      if (!order) throw notFound('Order not found');
      if (order.status !== 'open') throw conflict('Only open orders can be voided; refund paid orders instead');
      const approver = await users.resolveApprover(actor, manager_pin, 'orders.void');
      await db.run(`UPDATE orders SET status = 'voided', void_reason = ?, voided_by = ?, updated_at = ? WHERE id = ?`, reason, approver.id, nowIso(), id);
      await audit.log(actor, 'order.void', 'order', id, { reason, total: order.total, approved_by: approver.id, approved_by_name: approver.full_name });
    });
    const order = await get(id);
    bus.publish('order.voided', order);
    return order;
  }

  async function refund(actor, id, { reason, manager_pin, restock = false }) {
    const shift = await shifts.current(actor.id);
    await db.transaction(async () => {
      const order = await db.get('SELECT * FROM orders WHERE id = ?', id);
      if (!order) throw notFound('Order not found');
      if (order.status !== 'paid') throw conflict('Only paid orders can be refunded');
      const approver = await users.resolveApprover(actor, manager_pin, 'orders.refund');
      const pays = await db.all('SELECT method, SUM(amount) AS amount FROM payments WHERE order_id = ? GROUP BY method', id);
      // Cash leaving the drawer must be accounted to an open shift.
      if (pays.some((p) => p.method === 'cash') && !shift) throw conflict('Open a cashier shift before refunding cash');
      for (const p of pays) {
        await db.run(`INSERT INTO refunds (order_id, amount, method, reason, restocked, approved_by, user_id, shift_id, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, id, p.amount, p.method, reason, restock ? 1 : 0, approver.id, actor.id, shift?.id ?? null, nowIso());
      }
      if (restock && order.stock_deducted) {
        await inventory.restockForOrder(order, await db.all('SELECT * FROM order_lines WHERE order_id = ?', id), actor);
      }
      await db.run(`UPDATE orders SET status = 'refunded', void_reason = ?, voided_by = ?, updated_at = ? WHERE id = ?`, reason, approver.id, nowIso(), id);
      await audit.log(actor, 'order.refund', 'order', id, { reason, total: order.total, restock, approved_by: approver.id, approved_by_name: approver.full_name });
    });
    const order = await get(id);
    bus.publish('order.refunded', order);
    return order;
  }

  async function setKitchenStatus(actor, id, status) {
    await db.transaction(async () => {
      const order = await db.get('SELECT * FROM orders WHERE id = ?', id);
      if (!order) throw notFound('Order not found');
      if (!order.kitchen_status) throw conflict('Order has not been sent to the kitchen');
      if (order.status === 'voided' || order.status === 'refunded') throw conflict(`Order is ${order.status}`);
      if (!KITCHEN_FLOW[order.kitchen_status].includes(status)) throw conflict(`Cannot move from ${order.kitchen_status} to ${status}`);
      const now = nowIso();
      await db.run(`UPDATE orders SET kitchen_status = ?,
          ready_at = CASE WHEN ? = 'ready' THEN ? WHEN ? IN ('queued','preparing') THEN NULL ELSE ready_at END,
          served_at = CASE WHEN ? = 'served' THEN ? ELSE served_at END, updated_at = ? WHERE id = ?`,
        status, status, now, status, status, now, now, id);
    });
    const order = await get(id);
    bus.publish('order.kitchen', order);
    return order;
  }

  /** Tickets for the kitchen display, oldest first. */
  async function kitchenQueue({ station } = {}) {
    const orders = await db.all(`SELECT o.id, o.order_no, o.type, o.source, o.kitchen_status, o.customer_name, o.notes, o.sent_at, o.ready_at, t.name AS table_name
      FROM orders o LEFT JOIN dining_tables t ON t.id = o.table_id
      WHERE o.kitchen_status IN ('queued','preparing','ready') AND o.status IN ('open','paid')
      ORDER BY o.sent_at, o.id`);
    if (!orders.length) return [];
    const ids = orders.map((o) => o.id);
    const lines = await db.all(`SELECT id, order_id, name, qty, modifiers, notes, station, created_at FROM order_lines
      WHERE sent = 1 AND order_id IN (${ids.map(() => '?').join(',')}) ${station ? 'AND station = ?' : ''} ORDER BY id`, ...ids, ...(station ? [station] : []));
    return orders
      .map((o) => ({ ...o, lines: lines.filter((l) => l.order_id === o.id).map(({ order_id, ...l }) => ({ ...l, modifiers: JSON.parse(l.modifiers) })) }))
      .filter((o) => o.lines.length > 0);
  }

  /** Customer-facing "Now Serving" board: numbers only, no personal data. */
  async function displayBoard() {
    const date = businessDate();
    const rows = await db.all(`SELECT order_no, kitchen_status FROM orders WHERE business_date = ? AND status IN ('open','paid')
      AND kitchen_status IN ('queued','preparing','ready') ORDER BY COALESCE(ready_at, sent_at) DESC`, date);
    return {
      preparing: rows.filter((r) => r.kitchen_status !== 'ready').map((r) => r.order_no).reverse(),
      ready: rows.filter((r) => r.kitchen_status === 'ready').map((r) => r.order_no),
    };
  }

  async function receipt(id) {
    const order = await get(id);
    const s = await settings.all();
    return {
      store: { name: s.store_name, address: s.store_address, tin: s.store_tin, vat_registered: s.vat_registered, permit_no: s.permit_no, footer: s.receipt_footer, currency: s.currency_symbol },
      order,
    };
  }

  return { create, update, send, pay, voidOrder, refund, setKitchenStatus, kitchenQueue, displayBoard, changesSince, get, list, receipt, resolveLine };
}

module.exports = { createOrderService, KITCHEN_FLOW };
