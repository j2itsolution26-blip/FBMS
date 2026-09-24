'use strict';
/**
 * Database access layer with three interchangeable backends behind one async API:
 *
 *   - local:    Node's built-in node:sqlite on a file (in-store server, tests).
 *   - remote:   libSQL / Turso over HTTPS (serverless hosts such as Vercel).
 *   - postgres: PostgreSQL, e.g. Neon (serverless hosts such as Vercel).
 *
 * Services write portable SQL with `?` placeholders; the Postgres backend
 * rewrites them to $1..$n and adds RETURNING id to INSERTs.
 *
 * API: get(sql, ...args) · all(sql, ...args) · run(sql, ...args) →
 * { lastInsertRowid, changes } · batch([{sql, args}]) · exec(sql) ·
 * transaction(async fn) · close().
 *
 * Inside transaction(fn) every call made from fn (however deeply awaited) is
 * routed to that transaction via AsyncLocalStorage, so services don't need to
 * thread a tx handle around. Nested transaction() calls join the outer one.
 */
const fs = require('node:fs');
const path = require('node:path');
const { AsyncLocalStorage } = require('node:async_hooks');

const MIGRATIONS_DIR = path.join(__dirname, 'migrations');
const PG_MIGRATIONS_DIR = path.join(MIGRATIONS_DIR, 'postgres');

/** Split a migration file into statements (our migrations never put ';' inside literals). */
function splitSql(sql) {
  return sql
    .split('\n').filter((l) => !l.trim().startsWith('--')).join('\n')
    .split(/;\s*(?:\n|$)/).map((s) => s.trim()).filter(Boolean);
}

// ---------------- local backend (node:sqlite) ----------------
function createLocal(file) {
  const { DatabaseSync } = require('node:sqlite');
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const conn = new DatabaseSync(file);
  conn.exec('PRAGMA foreign_keys = ON;');
  if (file !== ':memory:') conn.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 5000;');

  // One connection is shared by all requests. A transaction awaits between
  // statements, so every operation takes this lock to stop another request's
  // statements landing inside someone else's open transaction.
  const als = new AsyncLocalStorage();
  let chain = Promise.resolve();
  function withLock(fn) {
    if (als.getStore()) return Promise.resolve().then(fn);
    const run = chain.then(fn);
    chain = run.catch(() => {});
    return run;
  }
  const norm = (args) => args.map((a) => (a === undefined ? null : typeof a === 'boolean' ? (a ? 1 : 0) : a));
  const plain = (row) => (row ? { ...row } : undefined);

  return {
    kind: 'local',
    get: (sql, ...args) => withLock(() => plain(conn.prepare(sql).get(...norm(args)))),
    all: (sql, ...args) => withLock(() => conn.prepare(sql).all(...norm(args)).map(plain)),
    run: (sql, ...args) => withLock(() => {
      const r = conn.prepare(sql).run(...norm(args));
      return { lastInsertRowid: Number(r.lastInsertRowid), changes: Number(r.changes) };
    }),
    exec: (sql) => withLock(() => conn.exec(sql)),
    batch: (stmts) => withLock(() => {
      conn.exec('BEGIN IMMEDIATE');
      try {
        for (const s of stmts) conn.prepare(s.sql).run(...norm(s.args || []));
        conn.exec('COMMIT');
      } catch (e) { conn.exec('ROLLBACK'); throw e; }
    }),
    transaction(fn) {
      if (als.getStore()) return fn();
      return withLock(() => als.run({ tx: true }, async () => {
        conn.exec('BEGIN IMMEDIATE');
        try {
          const result = await fn();
          conn.exec('COMMIT');
          return result;
        } catch (e) {
          conn.exec('ROLLBACK');
          throw e;
        }
      }));
    },
    close: async () => { await chain; conn.close(); },
  };
}

// ---------------- remote backend (libSQL / Turso) ----------------
function createRemote(url, authToken) {
  const { createClient } = require('@libsql/client');
  const client = createClient({ url, authToken, intMode: 'number' });
  const als = new AsyncLocalStorage();
  const target = () => als.getStore() || client;
  const norm = (args) => args.map((a) => (a === undefined ? null : typeof a === 'boolean' ? (a ? 1 : 0) : a));
  const rows = (rs) => rs.rows.map((r) => Object.fromEntries(rs.columns.map((c, i) => [c, r[i]])));

  return {
    kind: 'remote',
    get: async (sql, ...args) => rows(await target().execute({ sql, args: norm(args) }))[0],
    all: async (sql, ...args) => rows(await target().execute({ sql, args: norm(args) })),
    run: async (sql, ...args) => {
      const r = await target().execute({ sql, args: norm(args) });
      return { lastInsertRowid: r.lastInsertRowid === undefined ? 0 : Number(r.lastInsertRowid), changes: r.rowsAffected };
    },
    exec: (sql) => client.executeMultiple(sql),
    batch: async (stmts) => { await client.batch(stmts.map((s) => ({ sql: s.sql, args: norm(s.args || []) })), 'write'); },
    async transaction(fn) {
      if (als.getStore()) return fn();
      const tx = await client.transaction('write');
      try {
        const result = await als.run(tx, fn);
        await tx.commit();
        return result;
      } catch (e) {
        await tx.rollback().catch(() => {});
        throw e;
      } finally {
        tx.close();
      }
    },
    close: async () => client.close(),
  };
}

// ---------------- postgres backend (pg / Neon) ----------------
// Tables whose INSERTs should report the new id (SQLite's lastInsertRowid).
const ID_TABLES = new Set(['users', 'categories', 'items', 'modifier_groups', 'modifier_options', 'ingredients', 'stock_movements',
  'dining_tables', 'shifts', 'cash_movements', 'orders', 'order_lines', 'payments', 'refunds', 'z_readings', 'audit_log']);

/** Rewrite `?` placeholders (outside string literals) to $1..$n. */
function toPgParams(sql) {
  let n = 0;
  let out = '';
  let inStr = false;
  for (const ch of sql) {
    if (ch === "'") inStr = !inStr;
    out += !inStr && ch === '?' ? `$${++n}` : ch;
  }
  return out;
}

function createPostgres(connectionString) {
  const pg = require('pg');
  // COUNT/SUM come back as int8/numeric; they always fit a JS number here.
  pg.types.setTypeParser(20, (v) => Number(v));
  pg.types.setTypeParser(1700, (v) => Number(v));
  const url = new URL(connectionString);
  // node-postgres doesn't understand libpq's channel_binding flag; TLS is still enforced below.
  url.searchParams.delete('channel_binding');
  const local = ['localhost', '127.0.0.1', '::1'].includes(url.hostname) || url.searchParams.get('sslmode') === 'disable';
  url.searchParams.delete('sslmode');
  const pool = new pg.Pool({
    connectionString: url.toString(),
    ssl: local ? false : { rejectUnauthorized: true },
    // Serverless: keep few connections per instance and let idle ones go.
    max: Number(process.env.PG_POOL_MAX || 5),
    idleTimeoutMillis: 10_000,
    connectionTimeoutMillis: 10_000,
  });
  const als = new AsyncLocalStorage();
  const norm = (args) => args.map((a) => (a === undefined ? null : typeof a === 'boolean' ? (a ? 1 : 0) : a));
  const query = (sql, args = []) => (als.getStore() || pool).query(toPgParams(sql), norm(args));

  async function run(sql, ...args) {
    let text = sql;
    const m = /^\s*INSERT\s+INTO\s+(\w+)/i.exec(sql);
    const wantsId = m && ID_TABLES.has(m[1].toLowerCase()) && !/\bRETURNING\b/i.test(sql);
    if (wantsId) text = `${sql} RETURNING id`;
    const r = await query(text, args);
    return { lastInsertRowid: wantsId && r.rows[0] ? Number(r.rows[0].id) : 0, changes: r.rowCount };
  }

  async function transaction(fn) {
    if (als.getStore()) return fn();
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await als.run(client, fn);
      await client.query('COMMIT');
      return result;
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      throw e;
    } finally {
      client.release();
    }
  }

  return {
    kind: 'postgres',
    migrationsDir: PG_MIGRATIONS_DIR,
    get: async (sql, ...args) => (await query(sql, args)).rows[0],
    all: async (sql, ...args) => (await query(sql, args)).rows,
    run,
    exec: (sql) => pool.query(sql),
    batch: (stmts) => transaction(async () => { for (const s of stmts) await query(s.sql, s.args || []); }),
    transaction,
    /** After inserting explicit ids (demo seed), move identity sequences past them. */
    async syncSequences() {
      for (const t of ID_TABLES) {
        await pool.query(`SELECT setval(pg_get_serial_sequence('${t}', 'id'), COALESCE((SELECT MAX(id) FROM ${t}), 0) + 1, false)`);
      }
    },
    close: () => pool.end(),
  };
}

async function migrate(db) {
  await db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)');
  const applied = new Set((await db.all('SELECT name FROM schema_migrations')).map((r) => r.name));
  const dir = db.migrationsDir || MIGRATIONS_DIR;
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
  for (const f of files) {
    if (applied.has(f)) continue;
    const stmts = splitSql(fs.readFileSync(path.join(dir, f), 'utf8')).map((sql) => ({ sql }));
    stmts.push({ sql: 'INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)', args: [f, new Date().toISOString()] });
    try {
      await db.batch(stmts); // atomic: all of the migration or none of it
    } catch (e) {
      // Another serverless instance may have applied it at the same moment.
      if (await db.get('SELECT 1 AS ok FROM schema_migrations WHERE name = ?', f)) continue;
      throw e;
    }
  }
}

/**
 * Open the configured database and bring its schema up to date.
 * @param {{ file?: string, url?: string, authToken?: string, pgUrl?: string }} opts
 *   pgUrl: PostgreSQL connection string · url: libSQL/Turso URL · file: local SQLite file
 */
async function openDatabase({ file, url, authToken, pgUrl }) {
  const db = pgUrl ? createPostgres(pgUrl) : url ? createRemote(url, authToken) : createLocal(file);
  await migrate(db);
  return db;
}

module.exports = { openDatabase, splitSql, toPgParams };
