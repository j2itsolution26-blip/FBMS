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
  sessionTtlHours: Number(process.env.SESSION_TTL_HOURS || 12),
  seedDemo: bool(process.env.SEED_DEMO, true),
  businessTz: process.env.TZ_BUSINESS || 'Asia/Manila',
  publicDir: path.join(__dirname, '..', 'public'),
};

module.exports = config;
