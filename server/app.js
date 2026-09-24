'use strict';
/**
 * Composition root: wires DB → services → HTTP handler.
 *
 * createHandler() is a plain (req, res) function so the same code runs as a
 * long-lived server (index.js, in-store) or as a serverless function
 * (api/index.js, Vercel). createApp() wraps it in an http.Server for the
 * former and for tests.
 */
const http = require('node:http');
const config = require('./config');
const { openDatabase } = require('./db/database');
const { Router, readJson, sendJson } = require('./http/router');
const { serveStatic } = require('./http/static');
const { createEventBus } = require('./http/events');
const { HttpError } = require('./lib/errors');
const { registerApi } = require('./routes/api');
const { createSettingsService } = require('./services/settings');
const { createAuditService } = require('./services/audit');
const { createUserService } = require('./services/users');
const { createMenuService } = require('./services/menu');
const { createInventoryService } = require('./services/inventory');
const { createShiftService } = require('./services/shifts');
const { createOrderService } = require('./services/orders');
const { createReportService } = require('./services/reports');
const { createTableService } = require('./services/tables');

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
};

function buildServices(db) {
  const bus = createEventBus();
  const settings = createSettingsService(db);
  const audit = createAuditService(db);
  const users = createUserService(db, { sessionTtlHours: config.sessionTtlHours });
  const menu = createMenuService(db);
  const inventory = createInventoryService(db);
  const shifts = createShiftService(db);
  const tables = createTableService(db);
  const orders = createOrderService({ db, settings, users, inventory, shifts, audit, bus });
  const reports = createReportService({ db, audit });
  return { db, bus, settings, audit, users, menu, inventory, shifts, tables, orders, reports };
}

function log(level, msg, extra) {
  const line = JSON.stringify({ t: new Date().toISOString(), level, msg, ...extra });
  (level === 'error' ? process.stderr : process.stdout).write(line + '\n');
}

// Behind Vercel's edge the socket address is the proxy; the platform sets
// x-forwarded-for itself, so it is trustworthy there (and only there).
function clientIp(req) {
  if (config.serverless) {
    const fwd = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
    if (fwd) return fwd;
  }
  return req.socket?.remoteAddress || 'unknown';
}

/**
 * @param {object} services from buildServices()
 * @param {{ publicDir?: string, quiet?: boolean, realtime?: boolean }} opts
 *   publicDir: serve the web clients too (omit on Vercel — its CDN does that).
 *   realtime:  false where SSE can't work (serverless); clients then poll.
 */
function createHandler(services, { publicDir, quiet = false, realtime = true } = {}) {
  const router = new Router();
  registerApi(router, services, { realtime });

  return async function handle(req, res) {
    const started = process.hrtime.bigint();
    for (const [k, val] of Object.entries(SECURITY_HEADERS)) res.setHeader(k, val);
    const url = new URL(req.url, 'http://localhost');
    const ctx = { req, res, ip: clientIp(req), params: {}, query: Object.fromEntries(url.searchParams), body: {}, user: null };

    res.on('finish', () => {
      if (quiet || !url.pathname.startsWith('/api/')) return;
      const ms = Number(process.hrtime.bigint() - started) / 1e6;
      log('info', 'request', { method: req.method, path: url.pathname, status: res.statusCode, ms: Math.round(ms), user: ctx.user?.id });
    });

    try {
      if (!url.pathname.startsWith('/api/')) {
        if (publicDir && (req.method === 'GET' || req.method === 'HEAD') && serveStatic(publicDir, req, res)) return;
        throw new HttpError(404, 'Not found');
      }
      const match = router.match(req.method, url.pathname);
      if (!match) throw new HttpError(404, 'Unknown API endpoint');
      if (match.methodNotAllowed) throw new HttpError(405, 'Method not allowed');
      ctx.params = match.params;
      ctx.body = await readJson(req);
      let result;
      for (const h of match.route.handlers) result = await h(ctx);
      if (res.headersSent) return; // streaming handler (SSE)
      if (result && typeof result === 'object' && 'status' in result && 'body' in result) sendJson(res, result.status, result.body);
      else sendJson(res, 200, result ?? { ok: true });
    } catch (err) {
      if (res.headersSent) return;
      if (err instanceof HttpError) {
        sendJson(res, err.status, { error: err.message, details: err.details });
      } else {
        log('error', 'unhandled', { method: req.method, path: url.pathname, user: ctx.user?.id, err: err.stack });
        sendJson(res, 500, { error: 'Internal server error' });
      }
    }
  };
}

/** Open the database and build a ready-to-listen http.Server. */
async function createApp({ dbPath, dbUrl, dbAuthToken, publicDir, quiet = false, realtime = true }) {
  const db = await openDatabase({ file: dbPath, url: dbUrl, authToken: dbAuthToken });
  const services = buildServices(db);
  const handler = createHandler(services, { publicDir, quiet, realtime });
  const server = http.createServer(handler);

  function close() {
    services.bus.closeAll();
    return new Promise((resolve) => server.close(() => { db.close().then(resolve, resolve); }));
  }

  return { server, services, db, handler, close, log };
}

module.exports = { createApp, createHandler, buildServices, log };
