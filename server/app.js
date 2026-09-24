'use strict';
/**
 * Composition root: wires DB → services → HTTP. Kept separate from index.js
 * so tests can boot a fully working app on an in-memory database.
 */
const http = require('node:http');
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
  const users = createUserService(db, { sessionTtlHours: Number(process.env.SESSION_TTL_HOURS || 12) });
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

function createApp({ dbPath, publicDir, quiet = false }) {
  const db = openDatabase(dbPath);
  const services = buildServices(db);
  const router = new Router();
  registerApi(router, services);

  const server = http.createServer(async (req, res) => {
    const started = process.hrtime.bigint();
    for (const [k, val] of Object.entries(SECURITY_HEADERS)) res.setHeader(k, val);
    const url = new URL(req.url, 'http://localhost');
    const ip = req.socket.remoteAddress || 'unknown';
    const ctx = { req, res, ip, params: {}, query: Object.fromEntries(url.searchParams), body: {}, user: null };

    res.on('finish', () => {
      if (quiet || !url.pathname.startsWith('/api/')) return;
      const ms = Number(process.hrtime.bigint() - started) / 1e6;
      log('info', 'request', { method: req.method, path: url.pathname, status: res.statusCode, ms: Math.round(ms), user: ctx.user?.id });
    });

    try {
      if (!url.pathname.startsWith('/api/')) {
        if ((req.method === 'GET' || req.method === 'HEAD') && serveStatic(publicDir, req, res)) return;
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
  });

  function close() {
    services.bus.closeAll();
    return new Promise((resolve) => server.close(() => { db.close(); resolve(); }));
  }

  return { server, services, db, close, log };
}

module.exports = { createApp, buildServices, log };
