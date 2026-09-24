'use strict';
/** Process entry point: boot, seed on first run, graceful shutdown. */
const config = require('./config');
const { createApp, log } = require('./app');
const { seedIfEmpty } = require('./db/seed');

const app = createApp({ dbPath: config.dbPath, publicDir: config.publicDir });
if (config.seedDemo) {
  const seeded = seedIfEmpty(app.services);
  if (seeded) log('info', 'Seeded demo data', { logins: seeded });
} else if (!app.db.prepare('SELECT 1 FROM users LIMIT 1').get()) {
  log('error', 'Database has no users and SEED_DEMO=false. Create an admin with SEED_DEMO=true once, then change its password.');
}

app.server.listen(config.port, config.host, () => {
  log('info', 'FBMS POS listening', { url: `http://localhost:${config.port}`, db: config.dbPath });
});

function shutdown(sig) {
  log('info', 'Shutting down', { signal: sig });
  app.close().then(() => process.exit(0));
  setTimeout(() => process.exit(1), 5000).unref();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
