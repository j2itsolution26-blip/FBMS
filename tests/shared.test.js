'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { startTestApp, testDb } = require('./helpers');
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
  const app = await createApp({ ...(await testDb()), publicDir: __dirname, quiet: true });
  try {
    await seedIfEmpty(app.services);
    const zs = await app.services.reports.zReadings();
    assert.ok(zs.length >= 10);
    // Grand totals chain: each Z starts where the previous one ended.
    const asc = [...zs].reverse();
    for (let i = 1; i < asc.length; i++) assert.equal(asc[i].data.grand_total_start, asc[i - 1].data.grand_total_end);
    const paid = (await app.db.get("SELECT SUM(total) AS t FROM orders WHERE status = 'paid'")).t;
    const pays = (await app.db.get('SELECT SUM(amount) AS t FROM payments')).t;
    assert.equal(paid, pays, 'payments reconcile to order totals');
  } finally { await app.close(); }
});

test('first-run setup creates the owner on an empty database', async () => {
  const { createApp } = require('../server/app');
  const app = await createApp({ ...(await testDb()), quiet: true });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const post = (url, body) => fetch(base + url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  try {
    assert.equal((await (await fetch(`${base}/api/public/config`)).json()).needs_setup, true);
    assert.equal((await post('/api/setup', { username: 'owner', full_name: 'Owner', password: 'short', pin: '7777' })).status, 400);
    const ok = await post('/api/setup', { username: 'owner', full_name: 'Store Owner', password: 'Password123', pin: '7777', store_name: 'Kainan ni Aling Nena' });
    assert.equal(ok.status, 201);
    const session = await ok.json();
    assert.equal(session.user.role, 'admin');
    assert.ok(session.token);
    assert.equal((await post('/api/setup', { username: 'second', full_name: 'X', password: 'Password123', pin: '1234' })).status, 409);
    assert.equal((await (await fetch(`${base}/api/public/config`)).json()).store_name, 'Kainan ni Aling Nena');
  } finally { await app.close(); }
});
