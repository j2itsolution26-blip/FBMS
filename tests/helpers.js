'use strict';
const os = require('node:os');
const path = require('node:path');
const { createApp } = require('../server/app');
const { seedIfEmpty } = require('../server/db/seed');

/**
 * Database for a test app. FBMS_TEST_BACKEND=libsql exercises the remote
 * (Turso/Vercel) code path against a throwaway libSQL file.
 */
function testDb() {
  if (process.env.FBMS_TEST_BACKEND !== 'libsql') return { dbPath: ':memory:' };
  const file = path.join(os.tmpdir(), `fbms-test-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  return { dbUrl: `file:${file}` };
}

/** Boot a real server on an in-memory DB with the demo catalogue (no history). */
async function startTestApp() {
  const app = await createApp({ ...testDb(), publicDir: path.join(__dirname, '..', 'public'), quiet: true });
  await seedIfEmpty(app.services, { history: false });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${app.server.address().port}`;

  async function call(method, url, body, token) {
    const res = await fetch(base + url, {
      method,
      headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  }

  const userId = async (username) => (await app.db.get('SELECT id FROM users WHERE username = ?', username)).id;
  async function loginPin(username, pin) {
    const r = await call('POST', '/api/auth/login', { user_id: await userId(username), pin });
    if (r.status !== 200) throw new Error(`login failed ${JSON.stringify(r.body)}`);
    return r.body.token;
  }
  const item = (sku) => app.db.get('SELECT * FROM items WHERE sku = ?', sku);
  const option = (name) => app.db.get('SELECT * FROM modifier_options WHERE name = ?', name);

  return { app, base, call, loginPin, item, option, stop: () => app.close() };
}

module.exports = { startTestApp, testDb };
