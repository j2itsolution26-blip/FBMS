'use strict';
/** Dining tables with live occupancy from open dine-in orders. */
const { conflict, notFound } = require('../lib/errors');

function createTableService(db) {
  function list() {
    return db.prepare(`SELECT t.*, o.id AS order_id, o.order_no, o.total, o.guest_count, o.created_at AS seated_at, o.kitchen_status
      FROM dining_tables t LEFT JOIN orders o ON o.table_id = t.id AND o.status = 'open'
      WHERE t.active = 1 ORDER BY t.area, t.id`).all();
  }
  function create({ name, seats, area }) {
    if (db.prepare('SELECT 1 FROM dining_tables WHERE name = ?').get(name)) throw conflict('Table name already exists');
    const r = db.prepare('INSERT INTO dining_tables (name, seats, area) VALUES (?, ?, ?)').run(name, seats ?? 4, area ?? 'Main');
    return db.prepare('SELECT * FROM dining_tables WHERE id = ?').get(Number(r.lastInsertRowid));
  }
  function update(id, patch) {
    const t = db.prepare('SELECT * FROM dining_tables WHERE id = ?').get(id);
    if (!t) throw notFound('Table not found');
    db.prepare('UPDATE dining_tables SET name = ?, seats = ?, area = ?, active = ? WHERE id = ?').run(
      patch.name ?? t.name, patch.seats ?? t.seats, patch.area ?? t.area, patch.active === undefined ? t.active : patch.active ? 1 : 0, id);
    return db.prepare('SELECT * FROM dining_tables WHERE id = ?').get(id);
  }
  return { list, create, update };
}

module.exports = { createTableService };
