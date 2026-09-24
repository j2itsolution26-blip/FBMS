'use strict';
/**
 * Ingredient stock with recipe-based depletion. Every change is written to
 * stock_movements so on-hand quantities are always explainable.
 */
const { notFound, conflict, badRequest } = require('../lib/errors');
const { nowIso } = require('../lib/time');

function createInventoryService(db) {
  async function list() {
    return (await db.all(`SELECT i.*, (i.stock <= i.reorder_level) AS low,
        (SELECT COUNT(*) FROM recipes r WHERE r.ingredient_id = i.id) AS used_by
      FROM ingredients i ORDER BY (i.stock <= i.reorder_level) DESC, i.name`))
      .map((r) => ({ ...r, low: !!r.low }));
  }

  function lowStock() {
    return db.all('SELECT * FROM ingredients WHERE stock <= reorder_level ORDER BY stock / NULLIF(reorder_level, 0)');
  }

  async function create({ name, unit, stock = 0, reorder_level = 0, cost_per_unit = 0 }, actor) {
    return db.transaction(async () => {
      if (await db.get('SELECT 1 AS x FROM ingredients WHERE name = ?', name)) throw conflict('Ingredient already exists');
      const r = await db.run('INSERT INTO ingredients (name, unit, stock, reorder_level, cost_per_unit) VALUES (?, ?, 0, ?, ?)',
        name, unit, reorder_level, cost_per_unit);
      if (stock > 0) await move(r.lastInsertRowid, stock, 'receive', 'opening stock', actor);
      return db.get('SELECT * FROM ingredients WHERE id = ?', r.lastInsertRowid);
    });
  }

  async function update(id, patch) {
    const i = await db.get('SELECT * FROM ingredients WHERE id = ?', id);
    if (!i) throw notFound('Ingredient not found');
    await db.run('UPDATE ingredients SET name = ?, unit = ?, reorder_level = ?, cost_per_unit = ? WHERE id = ?',
      patch.name ?? i.name, patch.unit ?? i.unit, patch.reorder_level ?? i.reorder_level, patch.cost_per_unit ?? i.cost_per_unit, id);
    return db.get('SELECT * FROM ingredients WHERE id = ?', id);
  }

  async function move(ingredientId, qtyChange, reason, ref, actor) {
    await db.run('UPDATE ingredients SET stock = stock + ? WHERE id = ?', qtyChange, ingredientId);
    await db.run('INSERT INTO stock_movements (ingredient_id, qty_change, reason, ref, user_id, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      ingredientId, qtyChange, reason, ref ?? null, actor?.id ?? null, nowIso());
  }

  /**
   * Manual adjustment. 'receive' adds, 'waste' subtracts, 'count' sets the
   * on-hand quantity to a physical count (recorded as an 'adjust' delta).
   */
  async function adjust(id, { type, qty, note }, actor) {
    return db.transaction(async () => {
      const i = await db.get('SELECT * FROM ingredients WHERE id = ?', id);
      if (!i) throw notFound('Ingredient not found');
      if (type === 'receive') await move(id, qty, 'receive', note, actor);
      else if (type === 'waste') await move(id, -qty, 'waste', note, actor);
      else if (type === 'count') await move(id, qty - i.stock, 'adjust', note ?? 'physical count', actor);
      else throw badRequest('Unknown adjustment type');
      return db.get('SELECT * FROM ingredients WHERE id = ?', id);
    });
  }

  function movements(id, limit = 100) {
    return db.all(`SELECT m.*, u.full_name AS user_name FROM stock_movements m LEFT JOIN users u ON u.id = m.user_id
      WHERE m.ingredient_id = ? ORDER BY m.id DESC LIMIT ?`, id, limit);
  }

  /** Ingredient usage for a set of order lines: Map<ingredient_id, qty>. */
  async function usageFor(lines) {
    const usage = new Map();
    const add = (ing, q) => usage.set(ing, (usage.get(ing) || 0) + q);
    for (const l of lines) {
      for (const r of await db.all('SELECT ingredient_id, qty FROM recipes WHERE item_id = ?', l.item_id)) add(r.ingredient_id, r.qty * l.qty);
      const mods = typeof l.modifiers === 'string' ? JSON.parse(l.modifiers) : l.modifiers || [];
      for (const m of mods) {
        for (const r of await db.all('SELECT ingredient_id, qty FROM option_recipes WHERE option_id = ?', m.option_id)) add(r.ingredient_id, r.qty * l.qty);
      }
    }
    return usage;
  }

  // Sales are never blocked by book stock (book stock drifts; the kitchen
  // knows better) — negative on-hand simply surfaces in the low-stock report.
  async function deductForOrder(order, lines, actor) {
    for (const [ing, q] of await usageFor(lines)) await move(ing, -q, 'sale', `order #${order.id}`, actor);
  }

  async function restockForOrder(order, lines, actor) {
    for (const [ing, q] of await usageFor(lines)) await move(ing, q, 'refund', `order #${order.id}`, actor);
  }

  async function setRecipe(itemId, components) {
    await db.transaction(async () => {
      if (!(await db.get('SELECT 1 AS x FROM items WHERE id = ?', itemId))) throw notFound('Item not found');
      await db.run('DELETE FROM recipes WHERE item_id = ?', itemId);
      for (const c of components) {
        if (!(await db.get('SELECT 1 AS x FROM ingredients WHERE id = ?', c.ingredient_id))) throw badRequest(`Ingredient ${c.ingredient_id} does not exist`);
        await db.run('INSERT INTO recipes (item_id, ingredient_id, qty) VALUES (?, ?, ?)', itemId, c.ingredient_id, c.qty);
      }
    });
    return getRecipe(itemId);
  }

  function getRecipe(itemId) {
    return db.all(`SELECT r.ingredient_id, r.qty, i.name, i.unit, i.cost_per_unit FROM recipes r
      JOIN ingredients i ON i.id = r.ingredient_id WHERE r.item_id = ?`, itemId);
  }

  return { list, lowStock, create, update, adjust, movements, deductForOrder, restockForOrder, setRecipe, getRecipe, usageFor };
}

module.exports = { createInventoryService };
