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
  async function current(userId) {
    return (await db.get("SELECT * FROM shifts WHERE user_id = ? AND status = 'open'", userId)) || null;
  }

  async function open(actor, { opening_float, terminal }) {
    return db.transaction(async () => {
      if (await current(actor.id)) throw conflict('You already have an open shift');
      const r = await db.run(`INSERT INTO shifts (user_id, terminal, status, opening_float, opened_at) VALUES (?, ?, 'open', ?, ?)`,
        actor.id, terminal || actor.terminal || 'POS-1', opening_float, nowIso());
      return get(r.lastInsertRowid);
    });
  }

  async function get(id) {
    const s = await db.get('SELECT s.*, u.full_name AS user_name FROM shifts s JOIN users u ON u.id = s.user_id WHERE s.id = ?', id);
    if (!s) throw notFound('Shift not found');
    return s;
  }

  function assertAccess(actor, shift) {
    if (shift.user_id !== actor.id && !can(actor.role, 'shifts.manage')) throw forbidden('Not your shift');
  }

  async function addCashMovement(actor, shiftId, { type, amount, reason }) {
    const s = await get(shiftId);
    assertAccess(actor, s);
    if (s.status !== 'open') throw conflict('Shift is closed');
    await db.run('INSERT INTO cash_movements (shift_id, type, amount, reason, user_id, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      shiftId, type, amount, reason, actor.id, nowIso());
    return summary(shiftId);
  }

  /** X-reading: live totals for a shift. */
  async function summary(shiftId) {
    const s = await get(shiftId);
    const byMethod = await db.all(`SELECT method, COUNT(*) AS count, SUM(amount) AS amount FROM payments WHERE shift_id = ? GROUP BY method`, shiftId);
    const refunds = await db.all(`SELECT method, COUNT(*) AS count, SUM(amount) AS amount FROM refunds WHERE shift_id = ? GROUP BY method`, shiftId);
    const moves = await db.all(`SELECT type, SUM(amount) AS amount FROM cash_movements WHERE shift_id = ? GROUP BY type`, shiftId);
    const orders = await db.get(`SELECT COUNT(*) AS count, COALESCE(SUM(total),0) AS total FROM orders WHERE shift_id = ? AND status IN ('paid','refunded')`, shiftId);
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
      movements: await db.all('SELECT * FROM cash_movements WHERE shift_id = ? ORDER BY id', shiftId),
      expected_cash: expected,
    };
  }

  async function close(actor, shiftId, { counted_cash, notes }) {
    await db.transaction(async () => {
      const s = await get(shiftId);
      assertAccess(actor, s);
      if (s.status !== 'open') throw conflict('Shift already closed');
      const { expected_cash } = await summary(shiftId);
      await db.run(`UPDATE shifts SET status = 'closed', closed_at = ?, counted_cash = ?, expected_cash = ?, variance = ?, notes = ? WHERE id = ?`,
        nowIso(), counted_cash, expected_cash, counted_cash - expected_cash, notes ?? null, shiftId);
    });
    return summary(shiftId);
  }

  function list({ limit = 50 } = {}) {
    return db.all('SELECT s.*, u.full_name AS user_name FROM shifts s JOIN users u ON u.id = s.user_id ORDER BY s.id DESC LIMIT ?', limit);
  }

  return { current, open, get, addCashMovement, summary, close, list };
}

module.exports = { createShiftService };
