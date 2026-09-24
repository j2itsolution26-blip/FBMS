'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { startTestApp } = require('./helpers');
const { computeTotals } = require('../server/services/pricing');

test('browser pricing module is the server module and agrees with it', async () => {
  const t = await startTestApp();
  try {
    const res = await fetch(`${t.base}/js/pricing.js`);
    assert.equal(res.status, 200);
    const mod = await import(`data:text/javascript,${encodeURIComponent(await res.text())}`);
    const input = { lines: [{ line_total: 23400 }, { line_total: 5500 }], guestCount: 3, scPwdCount: 1, discount: { type: 'percent', value: 1000 }, serviceChargeBps: 500 };
    assert.deepEqual(mod.computeTotals(input), computeTotals(input));
  } finally { await t.stop(); }
});

test('demo history seeds and produces consistent Z-readings', async () => {
  const { createApp } = require('../server/app');
  const { seedIfEmpty } = require('../server/db/seed');
  const app = createApp({ dbPath: ':memory:', publicDir: __dirname, quiet: true });
  try {
    seedIfEmpty(app.services);
    const zs = app.services.reports.zReadings();
    assert.ok(zs.length >= 10);
    // Grand totals chain: each Z starts where the previous one ended.
    const asc = [...zs].reverse();
    for (let i = 1; i < asc.length; i++) assert.equal(asc[i].data.grand_total_start, asc[i - 1].data.grand_total_end);
    const paid = app.db.prepare("SELECT SUM(total) AS t FROM orders WHERE status = 'paid'").get().t;
    const pays = app.db.prepare('SELECT SUM(amount) AS t FROM payments').get().t;
    assert.equal(paid, pays, 'payments reconcile to order totals');
  } finally { await app.close(); }
});
