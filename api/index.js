'use strict';
/**
 * Vercel serverless entry point. vercel.json rewrites every /api/* request
 * here; static pages come from public/ via Vercel's CDN.
 *
 * Vercel has no persistent disk, so a hosted libSQL/Turso database is
 * required (TURSO_DATABASE_URL + TURSO_AUTH_TOKEN). Initialisation (migrate,
 * first-boot seed) runs once per warm instance.
 */
const config = require('../server/config');
const { createApp, log } = require('../server/app');
const { seedIfEmpty } = require('../server/db/seed');

let ready;
function init() {
  if (!config.dbUrl) return Promise.resolve(null);
  return (async () => {
    const app = await createApp({ dbUrl: config.dbUrl, dbAuthToken: config.dbAuthToken, realtime: false });
    if (config.seedDemo) await seedIfEmpty(app.services, { history: config.seedHistory });
    return app.handler;
  })();
}

module.exports = async function handler(req, res) {
  ready ||= init().catch((err) => { ready = null; throw err; });
  let handle;
  try {
    handle = await ready;
  } catch (err) {
    log('error', 'Startup failed', { err: err.stack });
    return reply(res, 503, { error: 'The POS database could not be reached. Check TURSO_DATABASE_URL / TURSO_AUTH_TOKEN in Vercel and redeploy.', code: 'DATABASE_UNAVAILABLE' });
  }
  if (!handle) {
    return reply(res, 503, { error: 'No database is configured. Add TURSO_DATABASE_URL and TURSO_AUTH_TOKEN in Vercel → Settings → Environment Variables, then redeploy.', code: 'DATABASE_NOT_CONFIGURED' });
  }
  return handle(req, res);
};

function reply(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(body));
}
