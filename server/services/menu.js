'use strict';
/**
 * Catalogue: categories, items, modifier groups (sizes, add-ons, combo
 * drink/side choices) and item availability ("86" list).
 */
const { notFound, conflict, badRequest } = require('../lib/errors');

const marks = (n) => Array(n).fill('?').join(',');

function createMenuService(db) {
  const bool = (x) => !!x;

  async function modifierGroupsFor(itemIds) {
    if (itemIds.length === 0) return new Map();
    const rows = await db.all(`SELECT img.item_id, g.id, g.name, g.min_select, g.max_select, img.sort
      FROM item_modifier_groups img JOIN modifier_groups g ON g.id = img.group_id
      WHERE img.item_id IN (${marks(itemIds.length)}) ORDER BY img.sort, g.id`, ...itemIds);
    const groupIds = [...new Set(rows.map((r) => r.id))];
    const options = groupIds.length
      ? await db.all(`SELECT id, group_id, name, price_delta, is_default FROM modifier_options
          WHERE active = 1 AND group_id IN (${marks(groupIds.length)}) ORDER BY sort, id`, ...groupIds)
      : [];
    const byGroup = new Map();
    for (const o of options) {
      if (!byGroup.has(o.group_id)) byGroup.set(o.group_id, []);
      byGroup.get(o.group_id).push({ id: o.id, name: o.name, price_delta: o.price_delta, is_default: bool(o.is_default) });
    }
    const out = new Map();
    for (const r of rows) {
      if (!out.has(r.item_id)) out.set(r.item_id, []);
      out.get(r.item_id).push({ id: r.id, name: r.name, min_select: r.min_select, max_select: r.max_select, options: byGroup.get(r.id) || [] });
    }
    return out;
  }

  /** Items whose recipe cannot be fulfilled from current stock. */
  async function outOfStockItemIds() {
    return new Set((await db.all(`SELECT DISTINCT r.item_id FROM recipes r JOIN ingredients i ON i.id = r.ingredient_id
      WHERE i.stock < r.qty`)).map((r) => r.item_id));
  }

  /** Full sellable menu for POS and kiosk. */
  async function getMenu({ includeInactive = false } = {}) {
    const cats = await db.all(`SELECT * FROM categories ${includeInactive ? '' : 'WHERE active = 1'} ORDER BY sort, id`);
    const items = await db.all(`SELECT * FROM items ${includeInactive ? '' : 'WHERE active = 1'} ORDER BY sort, id`);
    const groups = await modifierGroupsFor(items.map((i) => i.id));
    const oos = await outOfStockItemIds();
    return {
      categories: cats.map((c) => ({ id: c.id, name: c.name, icon: c.icon, color: c.color, sort: c.sort, active: bool(c.active) })),
      items: items.map((i) => ({
        id: i.id, category_id: i.category_id, sku: i.sku, name: i.name, description: i.description,
        price: i.price, icon: i.icon, station: i.station, sort: i.sort,
        active: bool(i.active), available: bool(i.available) && !oos.has(i.id),
        manually_86: !i.available, out_of_stock: oos.has(i.id),
        vat_exempt_eligible: bool(i.vat_exempt_eligible),
        modifier_groups: groups.get(i.id) || [],
      })),
    };
  }

  async function getItem(id) {
    const item = await db.get('SELECT * FROM items WHERE id = ?', id);
    if (!item) throw notFound('Item not found');
    return { ...item, modifier_groups: (await modifierGroupsFor([id])).get(id) || [] };
  }

  async function listModifierGroups() {
    const groups = await db.all('SELECT * FROM modifier_groups ORDER BY name');
    const opts = await db.all('SELECT * FROM modifier_options WHERE active = 1 ORDER BY sort, id');
    return groups.map((g) => ({ ...g, options: opts.filter((o) => o.group_id === g.id) }));
  }

  async function createCategory({ name, icon, color, sort }) {
    const r = await db.run('INSERT INTO categories (name, icon, color, sort) VALUES (?, ?, ?, ?)', name, icon ?? '🍽️', color ?? '#e11d48', sort ?? 0);
    return db.get('SELECT * FROM categories WHERE id = ?', r.lastInsertRowid);
  }

  async function updateCategory(id, patch) {
    const c = await db.get('SELECT * FROM categories WHERE id = ?', id);
    if (!c) throw notFound('Category not found');
    await db.run('UPDATE categories SET name = ?, icon = ?, color = ?, sort = ?, active = ? WHERE id = ?',
      patch.name ?? c.name, patch.icon ?? c.icon, patch.color ?? c.color, patch.sort ?? c.sort,
      patch.active === undefined || patch.active === null ? c.active : patch.active ? 1 : 0, id);
    return db.get('SELECT * FROM categories WHERE id = ?', id);
  }

  async function assertGroups(groupIds) {
    for (const g of groupIds) {
      if (!(await db.get('SELECT 1 AS x FROM modifier_groups WHERE id = ?', g))) throw badRequest(`Modifier group ${g} does not exist`);
    }
  }

  async function setGroups(itemId, groupIds) {
    await db.run('DELETE FROM item_modifier_groups WHERE item_id = ?', itemId);
    for (const [idx, g] of groupIds.entries()) await db.run('INSERT INTO item_modifier_groups (item_id, group_id, sort) VALUES (?, ?, ?)', itemId, g, idx);
  }

  async function createItem(data) {
    return db.transaction(async () => {
      if (!(await db.get('SELECT 1 AS x FROM categories WHERE id = ?', data.category_id))) throw badRequest('Category does not exist');
      if (data.sku && (await db.get('SELECT 1 AS x FROM items WHERE sku = ?', data.sku))) throw conflict('SKU already exists');
      await assertGroups(data.modifier_group_ids || []);
      const r = await db.run(`INSERT INTO items (category_id, sku, name, description, price, icon, station, sort, vat_exempt_eligible)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, data.category_id, data.sku ?? null, data.name, data.description ?? '',
        data.price, data.icon ?? '🍽️', data.station ?? 'kitchen', data.sort ?? 0, data.vat_exempt_eligible === false ? 0 : 1);
      await setGroups(r.lastInsertRowid, data.modifier_group_ids || []);
      return getItem(r.lastInsertRowid);
    });
  }

  async function updateItem(id, patch) {
    return db.transaction(async () => {
      const i = await db.get('SELECT * FROM items WHERE id = ?', id);
      if (!i) throw notFound('Item not found');
      if (patch.category_id && !(await db.get('SELECT 1 AS x FROM categories WHERE id = ?', patch.category_id))) throw badRequest('Category does not exist');
      if (patch.sku && patch.sku !== i.sku && (await db.get('SELECT 1 AS x FROM items WHERE sku = ?', patch.sku))) throw conflict('SKU already exists');
      const pick = (k) => (patch[k] === undefined || patch[k] === null ? i[k] : patch[k]);
      const flag = (k) => (patch[k] === undefined || patch[k] === null ? i[k] : patch[k] ? 1 : 0);
      await db.run(`UPDATE items SET category_id = ?, sku = ?, name = ?, description = ?, price = ?, icon = ?, station = ?, sort = ?,
        active = ?, available = ?, vat_exempt_eligible = ? WHERE id = ?`,
        pick('category_id'), pick('sku'), pick('name'), pick('description'), pick('price'), pick('icon'), pick('station'), pick('sort'),
        flag('active'), flag('available'), flag('vat_exempt_eligible'), id);
      if (Array.isArray(patch.modifier_group_ids)) {
        await assertGroups(patch.modifier_group_ids);
        await setGroups(id, patch.modifier_group_ids);
      }
      return getItem(id);
    });
  }

  return { getMenu, getItem, listModifierGroups, createCategory, updateCategory, createItem, updateItem };
}

module.exports = { createMenuService };
