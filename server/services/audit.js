'use strict';
/** Append-only audit trail for every sensitive action (voids, refunds, discounts, config). */
const { nowIso } = require('../lib/time');

function createAuditService(db) {
  const insert = db.prepare(`INSERT INTO audit_log (user_id, action, entity, entity_id, details, ip, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)`);

  function log(actor, action, entity = null, entityId = null, details = null) {
    insert.run(actor?.id ?? null, action, entity, entityId, details ? JSON.stringify(details) : null, actor?.ip ?? null, nowIso());
  }

  function list({ limit = 200, before = null } = {}) {
    const rows = before
      ? db.prepare(`SELECT a.*, u.full_name AS user_name FROM audit_log a LEFT JOIN users u ON u.id = a.user_id
          WHERE a.id < ? ORDER BY a.id DESC LIMIT ?`).all(before, limit)
      : db.prepare(`SELECT a.*, u.full_name AS user_name FROM audit_log a LEFT JOIN users u ON u.id = a.user_id
          ORDER BY a.id DESC LIMIT ?`).all(limit);
    return rows.map((r) => ({ ...r, details: r.details ? JSON.parse(r.details) : null }));
  }

  return { log, list };
}

module.exports = { createAuditService };
