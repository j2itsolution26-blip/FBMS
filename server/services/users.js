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

function createUserService(db, { sessionTtlHours }) {
  function list() {
    return db.prepare('SELECT * FROM users ORDER BY active DESC, role, full_name').all().map(publicUser);
  }

  /** Names shown on the terminal's "tap your name" login screen. */
  function loginRoster() {
    return db.prepare("SELECT id, username, full_name, role FROM users WHERE active = 1 AND pin_hash IS NOT NULL ORDER BY role, full_name").all();
  }

  function create({ username, full_name, role, password, pin }) {
    if (db.prepare('SELECT 1 FROM users WHERE username = ?').get(username)) throw conflict('Username already exists');
    const r = db.prepare(`INSERT INTO users (username, full_name, role, password_hash, pin_hash, active, created_at)
      VALUES (?, ?, ?, ?, ?, 1, ?)`).run(username, full_name, role, hashSecret(password), pin ? hashSecret(pin) : null, nowIso());
    return get(Number(r.lastInsertRowid));
  }

  function get(id) {
    const u = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
    if (!u) throw notFound('User not found');
    return publicUser(u);
  }

  function update(id, { full_name, role, password, pin, active }) {
    const u = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
    if (!u) throw notFound('User not found');
    if (role && role !== 'admin' && u.role === 'admin') ensureAnotherAdmin(id);
    if (active === false && u.role === 'admin') ensureAnotherAdmin(id);
    db.prepare(`UPDATE users SET full_name = ?, role = ?, password_hash = ?, pin_hash = ?, active = ? WHERE id = ?`).run(
      full_name ?? u.full_name,
      role ?? u.role,
      password ? hashSecret(password) : u.password_hash,
      pin ? hashSecret(pin) : u.pin_hash,
      active === undefined || active === null ? u.active : active ? 1 : 0,
      id,
    );
    if (active === false || password || pin) db.prepare('DELETE FROM sessions WHERE user_id = ?').run(id);
    return get(id);
  }

  // Never allow the last active admin to be demoted or disabled (lock-out).
  function ensureAnotherAdmin(exceptId) {
    const n = db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND active = 1 AND id != ?").get(exceptId).n;
    if (n === 0) throw conflict('At least one active admin is required');
  }

  function issueSession(user, terminal) {
    const token = crypto.randomBytes(32).toString('base64url');
    const now = new Date();
    const expires = new Date(now.getTime() + sessionTtlHours * 3600_000);
    db.prepare('INSERT INTO sessions (token_hash, user_id, terminal, created_at, expires_at) VALUES (?, ?, ?, ?, ?)')
      .run(sha256(token), user.id, terminal ?? null, now.toISOString(), expires.toISOString());
    return { token, expires_at: expires.toISOString(), user: publicUser(user) };
  }

  function loginWithPassword(username, password, terminal) {
    const u = db.prepare('SELECT * FROM users WHERE username = ? AND active = 1').get(username);
    // Always run a hash to keep timing similar for unknown users.
    const ok = verifySecret(password, u ? u.password_hash : 'scrypt$16384$8$1$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=');
    if (!u || !ok) throw unauthorized('Invalid username or password');
    return issueSession(u, terminal);
  }

  function loginWithPin(userId, pin, terminal) {
    const u = db.prepare('SELECT * FROM users WHERE id = ? AND active = 1').get(userId);
    if (!u || !u.pin_hash || !verifySecret(pin, u.pin_hash)) throw unauthorized('Invalid PIN');
    return issueSession(u, terminal);
  }

  function authenticate(token) {
    if (!token) return null;
    const row = db.prepare(`SELECT u.*, s.terminal, s.expires_at FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = ?`).get(sha256(token));
    if (!row || !row.active) return null;
    if (row.expires_at < nowIso()) {
      db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha256(token));
      return null;
    }
    return { ...publicUser(row), terminal: row.terminal };
  }

  function logout(token) {
    db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha256(token));
  }

  /**
   * Manager override: a supervisor keys their PIN on the cashier's terminal.
   * Returns the approving user; throws if no active manager/admin matches.
   */
  function verifyOverride(pin, capability) {
    if (!pin || typeof pin !== 'string') throw forbidden('Manager approval required');
    const candidates = db.prepare("SELECT * FROM users WHERE active = 1 AND pin_hash IS NOT NULL AND role IN ('manager','admin')").all();
    for (const u of candidates) {
      if (verifySecret(pin, u.pin_hash)) {
        if (!can(u.role, capability)) break;
        return publicUser(u);
      }
    }
    throw forbidden('Manager PIN not recognised');
  }

  /** The actor may approve themselves if their own role allows; else a PIN is needed. */
  function resolveApprover(actor, pin, capability) {
    if (can(actor.role, capability) && !pin) return actor;
    if (!pin) throw forbidden('Manager approval required');
    return verifyOverride(pin, capability);
  }

  function validatePin(pin) {
    if (pin && !/^\d{4,8}$/.test(pin)) throw badRequest('PIN must be 4 to 8 digits');
  }

  return { list, loginRoster, create, get, update, loginWithPassword, loginWithPin, authenticate, logout, verifyOverride, resolveApprover, validatePin };
}

module.exports = { createUserService };
