'use strict';
/**
 * Ingredient stock with recipe-based depletion. Every change is written to
 * stock_movements so on-hand quantities are always explainable.
 */
const { notFound, conflict, badRequest } = require('../lib/errors');
const { nowIso } = require('../lib/time');

function createInventoryService(db) {
  function list() {
    return db.prepare(`SELECT i.*, (i.stock <= i.reorder_level) AS low,
        (SELECT COUNT(*) FROM recipes r WHERE r.ingredient_id = i.id) AS used_by
      FROM ingredients i ORDER BY (i.stock <= i.reorder_level) DESC, i.name`).all()
      .map((r) => ({ ...r, low: !!r.low }));
  }

  function lowStock() {
    return db.prepare('SELECT * FROM ingredients WHERE stock <= reorder_level ORDER BY stock / NULLIF(reorder_level, 0)').all();
  }

  function create({ name, unit, stock = 0, reorder_level = 0, cost_per_unit = 0 }, actor) {
    if (db.prepare('SELECT 1 FROM ingredients WHERE name = ?').get(name)) throw conflict('Ingredient already exists');
    const r = db.prepare('INSERT INTO ingredients (name, unit, stock, reorder_level, cost_per_unit) VALUES (?, ?, 0, ?, ?)')
      .run(name, unit, reorder_level, cost_per_unit);
    const id = Number(r.lastInsertRowid);
    if (stock > 0) move(id, stock, 'receive', 'opening stock', actor);
    return db.prepare('SELECT * FROM ingredients WHERE id = ?').get(id);
  }

  function update(id, patch) {
    const i = db.prepare('SELECT * FROM ingredients WHERE id = ?').get(id);
    if (!i) throw notFound('Ingredient not found');
    db.prepare('UPDATE ingredients SET name = ?, unit = ?, reorder_level = ?, cost_per_unit = ? WHERE id = ?').run(
      patch.name ?? i.name, patch.unit ?? i.unit, patch.reorder_level ?? i.reorder_level, patch.cost_per_unit ?? i.cost_per_unit, id);
    return db.prepare('SELECT * FROM ingredients WHERE id = ?').get(id);
  }

  function move(ingredientId, qtyChange, reason, ref, actor) {
    db.prepare('UPDATE ingredients SET stock = stock + ? WHERE id = ?').run(qtyChange, ingredientId);
    db.prepare('INSERT INTO stock_movements (ingredient_id, qty_change, reason, ref, user_id, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(ingredientId, qtyChange, reason, ref ?? null, actor?.id ?? null, nowIso());
  }

  /**
   * Manual adjustment. 'receive' adds, 'waste' subtracts, 'count' sets the
   * on-hand quantity to a physical count (recorded as an 'adjust' delta).
   */
  function adjust(id, { type, qty, note }, actor) {
    const i = db.prepare('SELECT * FROM ingredients WHERE id = ?').get(id);
    if (!i) throw notFound('Ingredient not found');
    if (type === 'receive') move(id, qty, 'receive', note, actor);
    else if (type === 'waste') move(id, -qty, 'waste', note, actor);
    else if (type === 'count') move(id, qty - i.stock, 'adjust', note ?? 'physical count', actor);
    else throw badRequest('Unknown adjustment type');
    return db.prepare('SELECT * FROM ingredients WHERE id = ?').get(id);
  }

  function movements(id, limit = 100) {
    return db.prepare(`SELECT m.*, u.full_name AS user_name FROM stock_movements m LEFT JOIN users u ON u.id = m.user_id
      WHERE m.ingredient_id = ? ORDER BY m.id DESC LIMIT ?`).all(id, limit);
  }

  /** Ingredient usage for a set of order lines: Map<ingredient_id, qty>. */
  function usageFor(lines) {
    const itemRecipe = db.prepare('SELECT ingredient_id, qty FROM recipes WHERE item_id = ?');
    const optRecipe = db.prepare('SELECT ingredient_id, qty FROM option_recipes WHERE option_id = ?');
    const usage = new Map();
    const add = (ing, q) => usage.set(ing, (usage.get(ing) || 0) + q);
    for (const l of lines) {
      for (const r of itemRecipe.all(l.item_id)) add(r.ingredient_id, r.qty * l.qty);
      const mods = typeof l.modifiers === 'string' ? JSON.parse(l.modifiers) : l.modifiers || [];
      for (const m of mods) for (const r of optRecipe.all(m.option_id)) add(r.ingredient_id, r.qty * l.qty);
    }
    return usage;
  }

  // Sales are never blocked by book stock (book stock drifts; the kitchen
  // knows better) — negative on-hand simply surfaces in the low-stock report.
  function deductForOrder(order, lines, actor) {
    for (const [ing, q] of usageFor(lines)) move(ing, -q, 'sale', `order #${order.id}`, actor);
  }

  function restockForOrder(order, lines, actor) {
    for (const [ing, q] of usageFor(lines)) move(ing, q, 'refund', `order #${order.id}`, actor);
  }

  function setRecipe(itemId, components) {
    if (!db.prepare('SELECT 1 FROM items WHERE id = ?').get(itemId)) throw notFound('Item not found');
    db.prepare('DELETE FROM recipes WHERE item_id = ?').run(itemId);
    const ins = db.prepare('INSERT INTO recipes (item_id, ingredient_id, qty) VALUES (?, ?, ?)');
    for (const c of components) {
      if (!db.prepare('SELECT 1 FROM ingredients WHERE id = ?').get(c.ingredient_id)) throw badRequest(`Ingredient ${c.ingredient_id} does not exist`);
      ins.run(itemId, c.ingredient_id, c.qty);
    }
    return getRecipe(itemId);
  }

  function getRecipe(itemId) {
    return db.prepare(`SELECT r.ingredient_id, r.qty, i.name, i.unit, i.cost_per_unit FROM recipes r
      JOIN ingredients i ON i.id = r.ingredient_id WHERE r.item_id = ?`).all(itemId);
  }

  return { list, lowStock, create, update, adjust, movements, deductForOrder, restockForOrder, setRecipe, getRecipe, usageFor };
}

module.exports = { createInventoryService };
