'use strict';
/** Process entry point for a long-running server: boot, seed on first run, graceful shutdown. */
const config = require('./config');
const { createApp, log } = require('./app');
const { seedIfEmpty } = require('./db/seed');

async function main() {
  const app = await createApp({ dbPath: config.dbPath, dbUrl: config.dbUrl, dbAuthToken: config.dbAuthToken, pgUrl: config.pgUrl, publicDir: config.publicDir });
  if (config.seedDemo) {
    const seeded = await seedIfEmpty(app.services, { history: config.seedHistory });
    if (seeded) log('info', 'Seeded demo data', { logins: seeded });
  } else if (await app.services.users.needsSetup()) {
    log('info', 'No users yet: open the app in a browser to create the owner account.');
  }

  app.server.listen(config.port, config.host, () => {
    log('info', 'FBMS POS listening', { url: `http://localhost:${config.port}`, db: app.db.kind === 'local' ? config.dbPath : app.db.kind });
  });

  function shutdown(sig) {
    log('info', 'Shutting down', { signal: sig });
    app.close().then(() => process.exit(0));
    setTimeout(() => process.exit(1), 5000).unref();
  }
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err) => {
  log('error', 'Failed to start', { err: err.stack });
  process.exit(1);
});
