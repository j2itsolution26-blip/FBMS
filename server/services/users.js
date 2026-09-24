'use strict';
/**
 * Staff accounts, sessions and manager overrides.
 *
 * Sessions are opaque random tokens; only their SHA-256 is stored, so a DB
 * leak does not yield usable tokens, and logout/deactivation revokes instantly.
 */
const crypto = require('node:crypto');
const { hashSecret, verifySecret } = require('../auth/passwords');
const { can } = require('../auth/rbac');
const { badRequest, unauthorized, forbidden, notFound, conflict } = require('../lib/errors');
const { nowIso } = require('../lib/time');

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const publicUser = (u) => u && ({ id: u.id, username: u.username, full_name: u.full_name, role: u.role, active: !!u.active, has_pin: !!u.pin_hash, created_at: u.created_at });
// Hash compared against when the username doesn't exist, so timing doesn't reveal valid usernames.
const DUMMY_HASH = 'scrypt$16384$8$1$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';

function createUserService(db, { sessionTtlHours }) {
  async function list() {
    return (await db.all('SELECT * FROM users ORDER BY active DESC, role, full_name')).map(publicUser);
  }

  /** Names shown on the terminal's "tap your name" login screen. */
  function loginRoster() {
    return db.all("SELECT id, username, full_name, role FROM users WHERE active = 1 AND pin_hash IS NOT NULL ORDER BY role, full_name");
  }

  async function needsSetup() {
    return !(await db.get('SELECT 1 AS x FROM users LIMIT 1'));
  }

  async function create({ username, full_name, role, password, pin }) {
    if (await db.get('SELECT 1 AS x FROM users WHERE username = ?', username)) throw conflict('Username already exists');
    const r = await db.run(`INSERT INTO users (username, full_name, role, password_hash, pin_hash, active, created_at)
      VALUES (?, ?, ?, ?, ?, 1, ?)`, username, full_name, role, hashSecret(password), pin ? hashSecret(pin) : null, nowIso());
    return get(r.lastInsertRowid);
  }

  /** First-run: create the owner (admin) account. Only allowed while there are no users at all. */
  async function setupOwner(data) {
    return db.transaction(async () => {
      if (!(await needsSetup())) throw conflict('This store is already set up. Sign in instead.');
      return create({ ...data, role: 'admin' });
    });
  }

  async function get(id) {
    const u = await db.get('SELECT * FROM users WHERE id = ?', id);
    if (!u) throw notFound('User not found');
    return publicUser(u);
  }

  async function update(id, { full_name, role, password, pin, active }) {
    return db.transaction(async () => {
      const u = await db.get('SELECT * FROM users WHERE id = ?', id);
      if (!u) throw notFound('User not found');
      if (role && role !== 'admin' && u.role === 'admin') await ensureAnotherAdmin(id);
      if (active === false && u.role === 'admin') await ensureAnotherAdmin(id);
      await db.run(`UPDATE users SET full_name = ?, role = ?, password_hash = ?, pin_hash = ?, active = ? WHERE id = ?`,
        full_name ?? u.full_name,
        role ?? u.role,
        password ? hashSecret(password) : u.password_hash,
        pin ? hashSecret(pin) : u.pin_hash,
        active === undefined || active === null ? u.active : active ? 1 : 0,
        id);
      if (active === false || password || pin) await db.run('DELETE FROM sessions WHERE user_id = ?', id);
      return get(id);
    });
  }

  // Never allow the last active admin to be demoted or disabled (lock-out).
  async function ensureAnotherAdmin(exceptId) {
    const { n } = await db.get("SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND active = 1 AND id != ?", exceptId);
    if (n === 0) throw conflict('At least one active admin is required');
  }

  async function issueSession(user, terminal) {
    const token = crypto.randomBytes(32).toString('base64url');
    const now = new Date();
    const expires = new Date(now.getTime() + sessionTtlHours * 3600_000);
    await db.run('INSERT INTO sessions (token_hash, user_id, terminal, created_at, expires_at) VALUES (?, ?, ?, ?, ?)',
      sha256(token), user.id, terminal ?? null, now.toISOString(), expires.toISOString());
    return { token, expires_at: expires.toISOString(), user: publicUser(user) };
  }

  async function loginWithPassword(username, password, terminal) {
    const u = await db.get('SELECT * FROM users WHERE username = ? AND active = 1', username);
    const ok = verifySecret(password, u ? u.password_hash : DUMMY_HASH);
    if (!u || !ok) throw unauthorized('Invalid username or password');
    return issueSession(u, terminal);
  }

  async function loginWithPin(userId, pin, terminal) {
    const u = await db.get('SELECT * FROM users WHERE id = ? AND active = 1', userId);
    if (!u || !u.pin_hash || !verifySecret(pin, u.pin_hash)) throw unauthorized('Invalid PIN');
    return issueSession(u, terminal);
  }

  async function authenticate(token) {
    if (!token) return null;
    const row = await db.get(`SELECT u.*, s.terminal, s.expires_at FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = ?`, sha256(token));
    if (!row || !row.active) return null;
    if (row.expires_at < nowIso()) {
      await db.run('DELETE FROM sessions WHERE token_hash = ?', sha256(token));
      return null;
    }
    return { ...publicUser(row), terminal: row.terminal };
  }

  async function logout(token) {
    await db.run('DELETE FROM sessions WHERE token_hash = ?', sha256(token));
  }

  /**
   * Manager override: a supervisor keys their PIN on the cashier's terminal.
   * Returns the approving user; throws if no active manager/admin matches.
   */
  async function verifyOverride(pin, capability) {
    if (!pin || typeof pin !== 'string') throw forbidden('Manager approval required');
    const candidates = await db.all("SELECT * FROM users WHERE active = 1 AND pin_hash IS NOT NULL AND role IN ('manager','admin')");
    for (const u of candidates) {
      if (verifySecret(pin, u.pin_hash)) {
        if (!can(u.role, capability)) break;
        return publicUser(u);
      }
    }
    throw forbidden('Manager PIN not recognised');
  }

  /** The actor may approve themselves if their own role allows; else a PIN is needed. */
  async function resolveApprover(actor, pin, capability) {
    if (actor && can(actor.role, capability) && !pin) return actor;
    if (!pin) throw forbidden('Manager approval required');
    return verifyOverride(pin, capability);
  }

  function validatePin(pin) {
    if (pin && !/^\d{4,8}$/.test(pin)) throw badRequest('PIN must be 4 to 8 digits');
  }

  return { list, loginRoster, needsSetup, create, setupOwner, get, update, loginWithPassword, loginWithPin, authenticate, logout, verifyOverride, resolveApprover, validatePin };
}

module.exports = { createUserService };
