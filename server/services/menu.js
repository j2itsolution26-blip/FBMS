'use strict';
/**
 * Catalogue: categories, items, modifier groups (sizes, add-ons, combo
 * drink/side choices) and item availability ("86" list).
 */
const { notFound, conflict, badRequest } = require('../lib/errors');

function createMenuService(db) {
  const bool = (x) => !!x;

  function modifierGroupsFor(itemIds) {
    if (itemIds.length === 0) return new Map();
    const rows = db.prepare(`SELECT img.item_id, g.id, g.name, g.min_select, g.max_select, img.sort
      FROM item_modifier_groups img JOIN modifier_groups g ON g.id = img.group_id
      WHERE img.item_id IN (${itemIds.map(() => '?').join(',')}) ORDER BY img.sort, g.id`).all(...itemIds);
    const groupIds = [...new Set(rows.map((r) => r.id))];
    const options = groupIds.length
      ? db.prepare(`SELECT id, group_id, name, price_delta, is_default FROM modifier_options
          WHERE active = 1 AND group_id IN (${groupIds.map(() => '?').join(',')}) ORDER BY sort, id`).all(...groupIds)
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
  function outOfStockItemIds() {
    return new Set(db.prepare(`SELECT DISTINCT r.item_id FROM recipes r JOIN ingredients i ON i.id = r.ingredient_id
      WHERE i.stock < r.qty`).all().map((r) => r.item_id));
  }

  /** Full sellable menu for POS and kiosk. */
  function getMenu({ includeInactive = false } = {}) {
    const cats = db.prepare(`SELECT * FROM categories ${includeInactive ? '' : 'WHERE active = 1'} ORDER BY sort, id`).all();
    const items = db.prepare(`SELECT * FROM items ${includeInactive ? '' : 'WHERE active = 1'} ORDER BY sort, id`).all();
    const groups = modifierGroupsFor(items.map((i) => i.id));
    const oos = outOfStockItemIds();
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

  function getItem(id) {
    const item = db.prepare('SELECT * FROM items WHERE id = ?').get(id);
    if (!item) throw notFound('Item not found');
    return { ...item, modifier_groups: modifierGroupsFor([id]).get(id) || [] };
  }

  function listModifierGroups() {
    const groups = db.prepare('SELECT * FROM modifier_groups ORDER BY name').all();
    const opts = db.prepare('SELECT * FROM modifier_options WHERE active = 1 ORDER BY sort, id').all();
    return groups.map((g) => ({ ...g, options: opts.filter((o) => o.group_id === g.id) }));
  }

  function createCategory({ name, icon, color, sort }) {
    const r = db.prepare('INSERT INTO categories (name, icon, color, sort) VALUES (?, ?, ?, ?)').run(name, icon ?? '🍽️', color ?? '#e11d48', sort ?? 0);
    return db.prepare('SELECT * FROM categories WHERE id = ?').get(Number(r.lastInsertRowid));
  }

  function updateCategory(id, patch) {
    const c = db.prepare('SELECT * FROM categories WHERE id = ?').get(id);
    if (!c) throw notFound('Category not found');
    db.prepare('UPDATE categories SET name = ?, icon = ?, color = ?, sort = ?, active = ? WHERE id = ?').run(
      patch.name ?? c.name, patch.icon ?? c.icon, patch.color ?? c.color, patch.sort ?? c.sort,
      patch.active === undefined || patch.active === null ? c.active : patch.active ? 1 : 0, id);
    return db.prepare('SELECT * FROM categories WHERE id = ?').get(id);
  }

  function assertGroups(groupIds) {
    for (const g of groupIds) {
      if (!db.prepare('SELECT 1 FROM modifier_groups WHERE id = ?').get(g)) throw badRequest(`Modifier group ${g} does not exist`);
    }
  }

  function createItem(data) {
    if (!db.prepare('SELECT 1 FROM categories WHERE id = ?').get(data.category_id)) throw badRequest('Category does not exist');
    if (data.sku && db.prepare('SELECT 1 FROM items WHERE sku = ?').get(data.sku)) throw conflict('SKU already exists');
    assertGroups(data.modifier_group_ids || []);
    const r = db.prepare(`INSERT INTO items (category_id, sku, name, description, price, icon, station, sort, vat_exempt_eligible)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(data.category_id, data.sku ?? null, data.name, data.description ?? '',
      data.price, data.icon ?? '🍽️', data.station ?? 'kitchen', data.sort ?? 0, data.vat_exempt_eligible === false ? 0 : 1);
    const id = Number(r.lastInsertRowid);
    setGroups(id, data.modifier_group_ids || []);
    return getItem(id);
  }

  function setGroups(itemId, groupIds) {
    db.prepare('DELETE FROM item_modifier_groups WHERE item_id = ?').run(itemId);
    const ins = db.prepare('INSERT INTO item_modifier_groups (item_id, group_id, sort) VALUES (?, ?, ?)');
    groupIds.forEach((g, idx) => ins.run(itemId, g, idx));
  }

  function updateItem(id, patch) {
    const i = db.prepare('SELECT * FROM items WHERE id = ?').get(id);
    if (!i) throw notFound('Item not found');
    if (patch.category_id && !db.prepare('SELECT 1 FROM categories WHERE id = ?').get(patch.category_id)) throw badRequest('Category does not exist');
    if (patch.sku && patch.sku !== i.sku && db.prepare('SELECT 1 FROM items WHERE sku = ?').get(patch.sku)) throw conflict('SKU already exists');
    const pick = (k) => (patch[k] === undefined || patch[k] === null ? i[k] : patch[k]);
    const flag = (k) => (patch[k] === undefined || patch[k] === null ? i[k] : patch[k] ? 1 : 0);
    db.prepare(`UPDATE items SET category_id = ?, sku = ?, name = ?, description = ?, price = ?, icon = ?, station = ?, sort = ?,
      active = ?, available = ?, vat_exempt_eligible = ? WHERE id = ?`).run(
      pick('category_id'), pick('sku'), pick('name'), pick('description'), pick('price'), pick('icon'), pick('station'), pick('sort'),
      flag('active'), flag('available'), flag('vat_exempt_eligible'), id);
    if (Array.isArray(patch.modifier_group_ids)) {
      assertGroups(patch.modifier_group_ids);
      setGroups(id, patch.modifier_group_ids);
    }
    return getItem(id);
  }

  return { getMenu, getItem, listModifierGroups, createCategory, updateCategory, createItem, updateItem };
}

module.exports = { createMenuService };
