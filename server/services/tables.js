'use strict';
/** Dining tables with live occupancy from open dine-in orders. */
const { conflict, notFound } = require('../lib/errors');

function createTableService(db) {
  function list() {
    return db.all(`SELECT t.*, o.id AS order_id, o.order_no, o.total, o.guest_count, o.created_at AS seated_at, o.kitchen_status
      FROM dining_tables t LEFT JOIN orders o ON o.table_id = t.id AND o.status = 'open'
      WHERE t.active = 1 ORDER BY t.area, t.id`);
  }
  async function create({ name, seats, area }) {
    if (await db.get('SELECT 1 AS x FROM dining_tables WHERE name = ?', name)) throw conflict('Table name already exists');
    const r = await db.run('INSERT INTO dining_tables (name, seats, area) VALUES (?, ?, ?)', name, seats ?? 4, area ?? 'Main');
    return db.get('SELECT * FROM dining_tables WHERE id = ?', r.lastInsertRowid);
  }
  async function update(id, patch) {
    const t = await db.get('SELECT * FROM dining_tables WHERE id = ?', id);
    if (!t) throw notFound('Table not found');
    await db.run('UPDATE dining_tables SET name = ?, seats = ?, area = ?, active = ? WHERE id = ?',
      patch.name ?? t.name, patch.seats ?? t.seats, patch.area ?? t.area, patch.active === undefined || patch.active === null ? t.active : patch.active ? 1 : 0, id);
    return db.get('SELECT * FROM dining_tables WHERE id = ?', id);
  }
  return { list, create, update };
}

module.exports = { createTableService };
