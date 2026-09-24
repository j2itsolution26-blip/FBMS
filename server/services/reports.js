'use strict';
/**
 * Sales analytics and end-of-day Z-reading. Reports read paid/refunded
 * orders by business date; refunds are reported separately (not netted into
 * gross) so auditors can see both sides.
 */
const { conflict, badRequest } = require('../lib/errors');
const { businessDate, businessHour, nowIso } = require('../lib/time');

function createReportService({ db, audit }) {
  async function summary({ from, to }) {
    if (from > to) throw badRequest('"from" must be on or before "to"');
    const range = [from, to];
    const sales = await db.get(`SELECT COUNT(*) AS orders, COALESCE(SUM(subtotal),0) AS gross, COALESCE(SUM(sc_pwd_discount),0) AS sc_pwd_discount,
        COALESCE(SUM(other_discount),0) AS other_discount, COALESCE(SUM(vatable_sales),0) AS vatable_sales, COALESCE(SUM(vat_amount),0) AS vat_amount,
        COALESCE(SUM(vat_exempt_sales),0) AS vat_exempt_sales, COALESCE(SUM(service_charge),0) AS service_charge, COALESCE(SUM(total),0) AS net_sales,
        COALESCE(SUM(guest_count),0) AS guests
      FROM orders WHERE status IN ('paid','refunded') AND business_date BETWEEN ? AND ?`, ...range);
    const refunds = await db.get(`SELECT COUNT(DISTINCT r.order_id) AS count, COALESCE(SUM(r.amount),0) AS amount FROM refunds r
      JOIN orders o ON o.id = r.order_id WHERE o.business_date BETWEEN ? AND ?`, ...range);
    const voids = await db.get(`SELECT COUNT(*) AS count, COALESCE(SUM(total),0) AS amount FROM orders WHERE status = 'voided' AND business_date BETWEEN ? AND ?`, ...range);
    const payments = await db.all(`SELECT p.method, COUNT(*) AS count, SUM(p.amount) AS amount FROM payments p JOIN orders o ON o.id = p.order_id
      WHERE o.status IN ('paid','refunded') AND o.business_date BETWEEN ? AND ? GROUP BY p.method ORDER BY amount DESC`, ...range);
    const byType = await db.all(`SELECT type, COUNT(*) AS count, SUM(total) AS amount FROM orders WHERE status IN ('paid','refunded')
      AND business_date BETWEEN ? AND ? GROUP BY type ORDER BY amount DESC`, ...range);
    const bySource = await db.all(`SELECT source, COUNT(*) AS count, SUM(total) AS amount FROM orders WHERE status IN ('paid','refunded')
      AND business_date BETWEEN ? AND ? GROUP BY source`, ...range);
    const topItems = await db.all(`SELECT l.item_id, l.name, SUM(l.qty) AS qty, SUM(l.line_total) AS amount FROM order_lines l
      JOIN orders o ON o.id = l.order_id WHERE o.status IN ('paid','refunded') AND o.business_date BETWEEN ? AND ?
      GROUP BY l.item_id, l.name ORDER BY qty DESC LIMIT 10`, ...range);
    const byCategory = await db.all(`SELECT c.name, SUM(l.qty) AS qty, SUM(l.line_total) AS amount FROM order_lines l
      JOIN orders o ON o.id = l.order_id JOIN items i ON i.id = l.item_id JOIN categories c ON c.id = i.category_id
      WHERE o.status IN ('paid','refunded') AND o.business_date BETWEEN ? AND ? GROUP BY c.id, c.name ORDER BY amount DESC`, ...range);
    const daily = await db.all(`SELECT business_date AS date, COUNT(*) AS orders, SUM(total) AS amount FROM orders
      WHERE status IN ('paid','refunded') AND business_date BETWEEN ? AND ? GROUP BY business_date ORDER BY business_date`, ...range);

    const hourly = Array.from({ length: 24 }, (_, h) => ({ hour: h, orders: 0, amount: 0 }));
    for (const r of await db.all(`SELECT paid_at, total FROM orders WHERE status IN ('paid','refunded') AND business_date BETWEEN ? AND ?`, ...range)) {
      const h = businessHour(new Date(r.paid_at));
      hourly[h].orders += 1;
      hourly[h].amount += r.total;
    }
    // Computed in JS rather than with julianday() so the SQL stays portable (SQLite/Postgres).
    const timed = await db.all(`SELECT sent_at, ready_at FROM orders
      WHERE ready_at IS NOT NULL AND sent_at IS NOT NULL AND business_date BETWEEN ? AND ?`, ...range);
    const speedMin = timed.length ? timed.reduce((sum, r) => sum + (Date.parse(r.ready_at) - Date.parse(r.sent_at)), 0) / timed.length / 60000 : null;

    return {
      from, to,
      sales: { ...sales, average_ticket: sales.orders ? Math.round(sales.net_sales / sales.orders) : 0 },
      refunds, voids, payments, by_type: byType, by_source: bySource, top_items: topItems, by_category: byCategory, daily, hourly,
      kitchen_avg_minutes: speedMin != null ? Math.round(speedMin * 10) / 10 : null,
    };
  }

  async function zReadings(limit = 60) {
    return (await db.all(`SELECT z.id, z.z_no, z.business_date, z.created_at, u.full_name AS user_name, z.data FROM z_readings z
      JOIN users u ON u.id = z.user_id ORDER BY z.z_no DESC LIMIT ?`, limit)).map((z) => ({ ...z, data: JSON.parse(z.data) }));
  }

  /** End-of-day Z-reading: one per business date, with accumulated grand total. */
  async function generateZ(actor, date = businessDate()) {
    return db.transaction(async () => {
      if (await db.get('SELECT 1 FROM z_readings WHERE business_date = ?', date)) throw conflict(`Z-reading for ${date} already exists`);
      const { n: open } = await db.get("SELECT COUNT(*) AS n FROM orders WHERE status = 'open' AND business_date = ?", date);
      if (open) throw conflict(`${open} open order(s) must be paid or voided first`);
      const { n: openShifts } = await db.get("SELECT COUNT(*) AS n FROM shifts WHERE status = 'open'");
      if (openShifts) throw conflict(`${openShifts} cashier shift(s) are still open`);
      const s = await summary({ from: date, to: date });
      const orRange = await db.get(`SELECT MIN(or_number) AS first, MAX(or_number) AS last FROM orders WHERE or_number IS NOT NULL AND business_date = ?`, date);
      const prev = await db.get('SELECT z_no, data FROM z_readings ORDER BY z_no DESC LIMIT 1');
      const prevGrand = prev ? JSON.parse(prev.data).grand_total_end : 0;
      const netOfRefunds = s.sales.net_sales - s.refunds.amount;
      const data = {
        ...s,
        or_first: orRange.first, or_last: orRange.last,
        grand_total_start: prevGrand, grand_total_end: prevGrand + netOfRefunds,
      };
      const zNo = (prev?.z_no || 0) + 1;
      await db.run('INSERT INTO z_readings (z_no, business_date, data, user_id, created_at) VALUES (?, ?, ?, ?, ?)', zNo, date, JSON.stringify(data), actor.id, nowIso());
      await audit.log(actor, 'report.z_reading', 'z_reading', zNo, { date, net_sales: s.sales.net_sales });
      return { z_no: zNo, business_date: date, data };
    });
  }

  return { summary, zReadings, generateZ };
}

module.exports = { createReportService };
