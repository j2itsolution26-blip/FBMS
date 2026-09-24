'use strict';
const path = require('node:path');
const { createApp } = require('../server/app');
const { seedIfEmpty } = require('../server/db/seed');

/** Boot a real server on an in-memory DB with the demo catalogue (no history). */
async function startTestApp() {
  const app = createApp({ dbPath: ':memory:', publicDir: path.join(__dirname, '..', 'public'), quiet: true });
  seedIfEmpty(app.services, { history: false });
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

  const userId = (username) => app.db.prepare('SELECT id FROM users WHERE username = ?').get(username).id;
  async function loginPin(username, pin) {
    const r = await call('POST', '/api/auth/login', { user_id: userId(username), pin });
    if (r.status !== 200) throw new Error(`login failed ${JSON.stringify(r.body)}`);
    return r.body.token;
  }
  const item = (sku) => app.db.prepare('SELECT * FROM items WHERE sku = ?').get(sku);
  const option = (name) => app.db.prepare('SELECT * FROM modifier_options WHERE name = ?').get(name);

  return { app, base, call, loginPin, item, option, stop: () => app.close() };
}

module.exports = { startTestApp };
