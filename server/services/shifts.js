'use strict';
/**
 * Cashier shifts / cash drawer accountability.
 * A cashier opens a shift with a counted float, takes payments against it,
 * records pay-ins/payouts/drops, and closes with a blind count. Expected cash
 * and over/short are computed server-side (X-reading).
 */
const { conflict, notFound, forbidden } = require('../lib/errors');
const { can } = require('../auth/rbac');
const { nowIso } = require('../lib/time');

function createShiftService(db) {
  function current(userId) {
    return db.prepare("SELECT * FROM shifts WHERE user_id = ? AND status = 'open'").get(userId) || null;
  }

  function open(actor, { opening_float, terminal }) {
    if (current(actor.id)) throw conflict('You already have an open shift');
    const r = db.prepare(`INSERT INTO shifts (user_id, terminal, status, opening_float, opened_at) VALUES (?, ?, 'open', ?, ?)`)
      .run(actor.id, terminal || actor.terminal || 'POS-1', opening_float, nowIso());
    return get(Number(r.lastInsertRowid));
  }

  function get(id) {
    const s = db.prepare('SELECT s.*, u.full_name AS user_name FROM shifts s JOIN users u ON u.id = s.user_id WHERE s.id = ?').get(id);
    if (!s) throw notFound('Shift not found');
    return s;
  }

  function assertAccess(actor, shift) {
    if (shift.user_id !== actor.id && !can(actor.role, 'shifts.manage')) throw forbidden('Not your shift');
  }

  function addCashMovement(actor, shiftId, { type, amount, reason }) {
    const s = get(shiftId);
    assertAccess(actor, s);
    if (s.status !== 'open') throw conflict('Shift is closed');
    db.prepare('INSERT INTO cash_movements (shift_id, type, amount, reason, user_id, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(shiftId, type, amount, reason, actor.id, nowIso());
    return summary(shiftId);
  }

  /** X-reading: live totals for a shift. */
  function summary(shiftId) {
    const s = get(shiftId);
    const byMethod = db.prepare(`SELECT method, COUNT(*) AS count, SUM(amount) AS amount FROM payments WHERE shift_id = ? GROUP BY method`).all(shiftId);
    const refunds = db.prepare(`SELECT method, COUNT(*) AS count, SUM(amount) AS amount FROM refunds WHERE shift_id = ? GROUP BY method`).all(shiftId);
    const moves = db.prepare(`SELECT type, SUM(amount) AS amount FROM cash_movements WHERE shift_id = ? GROUP BY type`).all(shiftId);
    const orders = db.prepare(`SELECT COUNT(*) AS count, COALESCE(SUM(total),0) AS total FROM orders WHERE shift_id = ? AND status IN ('paid','refunded')`).get(shiftId);
    const m = Object.fromEntries(moves.map((x) => [x.type, x.amount]));
    const cashSales = byMethod.find((x) => x.method === 'cash')?.amount || 0;
    const cashRefunds = refunds.find((x) => x.method === 'cash')?.amount || 0;
    const expected = s.opening_float + cashSales - cashRefunds + (m.pay_in || 0) - (m.payout || 0) - (m.drop || 0);
    return {
      shift: s,
      orders_count: orders.count,
      gross_sales: orders.total,
      payments: byMethod,
      refunds,
      cash_movements: { pay_in: m.pay_in || 0, payout: m.payout || 0, drop: m.drop || 0 },
      movements: db.prepare('SELECT * FROM cash_movements WHERE shift_id = ? ORDER BY id').all(shiftId),
      expected_cash: expected,
    };
  }

  function close(actor, shiftId, { counted_cash, notes }) {
    const s = get(shiftId);
    assertAccess(actor, s);
    if (s.status !== 'open') throw conflict('Shift already closed');
    const { expected_cash } = summary(shiftId);
    db.prepare(`UPDATE shifts SET status = 'closed', closed_at = ?, counted_cash = ?, expected_cash = ?, variance = ?, notes = ? WHERE id = ?`)
      .run(nowIso(), counted_cash, expected_cash, counted_cash - expected_cash, notes ?? null, shiftId);
    return summary(shiftId);
  }

  function list({ limit = 50 } = {}) {
    return db.prepare('SELECT s.*, u.full_name AS user_name FROM shifts s JOIN users u ON u.id = s.user_id ORDER BY s.id DESC LIMIT ?').all(limit);
  }

  return { current, open, get, addCashMovement, summary, close, list };
}

module.exports = { createShiftService };
