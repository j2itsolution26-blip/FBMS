'use strict';
/**
 * Central runtime configuration. Everything environment-specific comes from
 * env vars (see .env.example) so no secrets or host details live in code.
 */
const path = require('node:path');

function bool(v, dflt) {
  if (v === undefined || v === '') return dflt;
  return ['1', 'true', 'yes', 'on'].includes(String(v).toLowerCase());
}

const config = {
  port: Number(process.env.PORT || 8080),
  host: process.env.HOST || '0.0.0.0',
  dbPath: process.env.DB_PATH || path.join(__dirname, '..', 'data', 'fbms.db'),
  // Hosted libSQL/Turso database. When set it is used instead of DB_PATH —
  // required on serverless hosts (Vercel) that have no persistent disk.
  dbUrl: process.env.TURSO_DATABASE_URL || process.env.LIBSQL_URL || '',
  dbAuthToken: process.env.TURSO_AUTH_TOKEN || process.env.LIBSQL_AUTH_TOKEN || '',
  serverless: !!process.env.VERCEL,
  sessionTtlHours: Number(process.env.SESSION_TTL_HOURS || 12),
  seedDemo: bool(process.env.SEED_DEMO, true),
  // Two weeks of demo sales; thousands of rows, so off by default on serverless.
  seedHistory: bool(process.env.SEED_HISTORY, !process.env.VERCEL),
  businessTz: process.env.TZ_BUSINESS || 'Asia/Manila',
  publicDir: path.join(__dirname, '..', 'public'),
};

module.exports = config;
