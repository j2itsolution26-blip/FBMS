'use strict';
/**
 * Demo data: a quick-service burger & chicken menu with value meals,
 * staff with PINs, recipes/inventory, tables and ~2 weeks of sales history so
 * the dashboard is meaningful on first boot.
 *
 * Runs only against an EMPTY database (seedIfEmpty). `npm run seed` wipes
 * and reseeds, and asks for confirmation because it destroys all data.
 */
const { hashSecret } = require('../auth/passwords');
const { computeTotals } = require('../services/pricing');
const { transaction } = require('./database');
const { businessDate } = require('../lib/time');

const P = (pesos) => Math.round(pesos * 100);

const STAFF = [
  { username: 'admin', full_name: 'Store Admin', role: 'admin', password: 'Admin@12345', pin: '9999' },
  { username: 'maria', full_name: 'Maria Santos', role: 'manager', password: 'Manager@123', pin: '2222' },
  { username: 'juan', full_name: 'Juan Dela Cruz', role: 'cashier', password: 'Cashier@123', pin: '1111' },
  { username: 'ana', full_name: 'Ana Reyes', role: 'cashier', password: 'Cashier@123', pin: '3333' },
  { username: 'pedro', full_name: 'Pedro Garcia', role: 'kitchen', password: 'Kitchen@123', pin: '4444' },
];

function seedIfEmpty(s, { history = true } = {}) {
  const { db } = s;
  if (db.prepare('SELECT 1 FROM users LIMIT 1').get()) return null;
  transaction(db, () => seedCatalogue(db));
  if (history) seedHistory(s);
  return STAFF.map((u) => `${u.role}: ${u.username} / ${u.password} (PIN ${u.pin})`);
}

function seedCatalogue(db) {
  const now = new Date().toISOString();
  const insUser = db.prepare('INSERT INTO users (username, full_name, role, password_hash, pin_hash, active, created_at) VALUES (?, ?, ?, ?, ?, 1, ?)');
  for (const u of STAFF) insUser.run(u.username, u.full_name, u.role, hashSecret(u.password), hashSecret(u.pin), now);

  // ---- ingredients ----
  const ING = {};
  const insIng = db.prepare('INSERT INTO ingredients (name, unit, stock, reorder_level, cost_per_unit) VALUES (?, ?, ?, ?, ?)');
  const ingredients = [
    ['Burger Bun', 'pc', 400, 80, P(4)], ['Beef Patty', 'pc', 350, 80, P(14)], ['Cheese Slice', 'pc', 500, 100, P(5)],
    ['Bacon Strip', 'pc', 120, 40, P(14)], ['Chicken Piece (raw)', 'pc', 600, 120, P(26)], ['Chicken Fillet', 'pc', 200, 50, P(22)],
    ['Rice', 'cup', 800, 150, P(8)], ['Potato Fries', 'g', 40000, 8000, P(0.12)], ['Spaghetti Noodles', 'g', 12000, 3000, P(0.1)],
    ['Sweet Sauce', 'ml', 15000, 3000, P(0.08)], ['Hotdog', 'pc', 250, 60, P(9)], ['Gravy', 'ml', 20000, 4000, P(0.04)],
    ['Cup 16oz', 'pc', 900, 200, P(3)], ['Cup 22oz', 'pc', 600, 150, P(4)], ['Iced Tea Mix', 'ml', 30000, 6000, P(0.03)],
    ['Cola Syrup', 'ml', 25000, 5000, P(0.05)], ['Soft Serve Mix', 'ml', 18000, 4000, P(0.06)], ['Coffee Beans', 'g', 3000, 600, P(1.2)],
    ['Egg', 'pc', 300, 60, P(8)], ['Longganisa', 'pc', 200, 50, P(12)], ['Peach Mango Filling', 'g', 6000, 1500, P(0.25)], ['Pie Crust', 'pc', 180, 50, P(7)],
  ];
  for (const [name, unit, stock, reorder, cost] of ingredients) ING[name] = Number(insIng.run(name, unit, stock, reorder, cost).lastInsertRowid);

  // ---- modifier groups ----
  const insGroup = db.prepare('INSERT INTO modifier_groups (name, min_select, max_select) VALUES (?, ?, ?)');
  const insOpt = db.prepare('INSERT INTO modifier_options (group_id, name, price_delta, is_default, sort) VALUES (?, ?, ?, ?, ?)');
  const insOptRecipe = db.prepare('INSERT INTO option_recipes (option_id, ingredient_id, qty) VALUES (?, ?, ?)');
  const G = {};
  function group(key, name, min, max, options) {
    const gid = Number(insGroup.run(name, min, max).lastInsertRowid);
    G[key] = gid;
    options.forEach(([oname, delta, isDefault, recipe], i) => {
      const oid = Number(insOpt.run(gid, oname, P(delta), isDefault ? 1 : 0, i).lastInsertRowid);
      for (const [ing, qty] of recipe || []) insOptRecipe.run(oid, ING[ing], qty);
    });
  }
  const regDrink = [['Cup 16oz', 1]];
  const lgDrink = [['Cup 22oz', 1]];
  group('mealDrink', 'Meal Drink', 1, 1, [
    ['Iced Tea (Reg)', 0, true, [...regDrink, ['Iced Tea Mix', 60]]], ['Cola (Reg)', 0, false, [...regDrink, ['Cola Syrup', 50]]],
    ['Iced Tea (Large)', 20, false, [...lgDrink, ['Iced Tea Mix', 90]]], ['Cola (Large)', 20, false, [...lgDrink, ['Cola Syrup', 75]]],
    ['Hot Coffee', 0, false, [['Coffee Beans', 12]]], ['Pineapple Juice', 25, false, regDrink],
  ]);
  group('mealSide', 'Meal Side', 1, 1, [
    ['Regular Fries', 0, true, [['Potato Fries', 100]]], ['Large Fries', 30, false, [['Potato Fries', 160]]],
    ['Plain Rice', 0, false, [['Rice', 1]]], ['Mashed Potato', 15, false, []], ['Buttered Corn', 20, false, []],
  ]);
  group('burgerAdd', 'Burger Add-ons', 0, 5, [
    ['Extra Cheese', 15, false, [['Cheese Slice', 1]]], ['Add Bacon', 35, false, [['Bacon Strip', 2]]], ['Extra Patty', 50, false, [['Beef Patty', 1]]],
    ['No Onions', 0, false, []], ['No Pickles', 0, false, []],
  ]);
  group('chickenPart', 'Chicken Part', 1, 1, [['Drumstick', 0, true], ['Thigh', 0], ['Breast', 10], ['Wing', 0]]);
  group('chickenFlavor', 'Flavor', 1, 1, [['Original Crispy', 0, true], ['Spicy', 0]]);
  group('drinkSize', 'Size', 1, 1, [['Regular', 0, true, regDrink], ['Large', 20, false, lgDrink]]);
  group('ice', 'Ice', 0, 1, [['Less Ice', 0], ['No Ice', 0]]);
  group('riceExtras', 'Extras', 0, 3, [['Extra Rice', 25, false, [['Rice', 1]]], ['Extra Gravy', 10, false, [['Gravy', 40]]], ['Add Egg', 20, false, [['Egg', 1]]]]);
  group('sundae', 'Topping', 1, 1, [['Hot Fudge', 0, true], ['Caramel', 0], ['Strawberry', 0]]);
  group('pastaAdd', 'Pasta Add-ons', 0, 2, [['Extra Cheese', 15, false, [['Cheese Slice', 1]]], ['Extra Hotdog', 25, false, [['Hotdog', 1]]]]);

  // ---- categories & items ----
  const insCat = db.prepare('INSERT INTO categories (name, icon, color, sort) VALUES (?, ?, ?, ?)');
  const insItem = db.prepare(`INSERT INTO items (category_id, sku, name, description, price, icon, station, sort) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
  const insIMG = db.prepare('INSERT INTO item_modifier_groups (item_id, group_id, sort) VALUES (?, ?, ?)');
  const insRecipe = db.prepare('INSERT INTO recipes (item_id, ingredient_id, qty) VALUES (?, ?, ?)');

  const menu = [
    ['Value Meals', '🍱', '#dc2626', [
      ['VM1', 'Burger Steak Meal', 'Beef patty with mushroom gravy, rice, side & drink', 149, '🍛', 'assembly', ['mealDrink', 'riceExtras'], [['Beef Patty', 1], ['Rice', 1], ['Gravy', 60]]],
      ['VM2', 'Cheeseburger Meal', 'Quarter-pound cheeseburger, fries & drink', 189, '🍔', 'grill', ['mealSide', 'mealDrink', 'burgerAdd'], [['Burger Bun', 1], ['Beef Patty', 1], ['Cheese Slice', 1]]],
      ['VM3', '1-pc Chicken Meal', 'Crispy fried chicken with rice & drink', 169, '🍗', 'fryer', ['chickenPart', 'chickenFlavor', 'mealDrink', 'riceExtras'], [['Chicken Piece (raw)', 1], ['Rice', 1], ['Gravy', 40]]],
      ['VM4', '2-pc Chicken Meal', 'Two pieces crispy chicken, rice & drink', 259, '🍗', 'fryer', ['chickenFlavor', 'mealDrink', 'riceExtras'], [['Chicken Piece (raw)', 2], ['Rice', 1], ['Gravy', 60]]],
      ['VM5', 'Chicken Sandwich Meal', 'Crispy fillet sandwich, fries & drink', 179, '🥪', 'fryer', ['mealSide', 'mealDrink'], [['Burger Bun', 1], ['Chicken Fillet', 1]]],
      ['VM6', 'Spaghetti & Chicken Meal', 'Sweet-style spaghetti with 1-pc chicken & drink', 219, '🍝', 'assembly', ['chickenFlavor', 'mealDrink'], [['Spaghetti Noodles', 150], ['Sweet Sauce', 120], ['Hotdog', 1], ['Chicken Piece (raw)', 1]]],
    ]],
    ['Burgers', '🍔', '#ea580c', [
      ['B1', 'Classic Burger', 'Beef patty, onions, pickles, ketchup', 59, '🍔', 'grill', ['burgerAdd'], [['Burger Bun', 1], ['Beef Patty', 1]]],
      ['B2', 'Cheeseburger', 'Classic burger with melted cheese', 79, '🍔', 'grill', ['burgerAdd'], [['Burger Bun', 1], ['Beef Patty', 1], ['Cheese Slice', 1]]],
      ['B3', 'Double Cheeseburger', 'Two patties, two slices of cheese', 139, '🍔', 'grill', ['burgerAdd'], [['Burger Bun', 1], ['Beef Patty', 2], ['Cheese Slice', 2]]],
      ['B4', 'Bacon Quarter Pounder', 'Quarter-pound beef, bacon, cheese', 199, '🥓', 'grill', ['burgerAdd'], [['Burger Bun', 1], ['Beef Patty', 2], ['Cheese Slice', 1], ['Bacon Strip', 2]]],
      ['B5', 'Crispy Chicken Sandwich', 'Crispy fillet, lettuce, mayo', 119, '🥪', 'fryer', [], [['Burger Bun', 1], ['Chicken Fillet', 1]]],
    ]],
    ['Chicken', '🍗', '#b45309', [
      ['C1', '1-pc Fried Chicken', 'Ala carte, no rice', 99, '🍗', 'fryer', ['chickenPart', 'chickenFlavor'], [['Chicken Piece (raw)', 1]]],
      ['C2', '2-pc Fried Chicken', 'Ala carte, no rice', 189, '🍗', 'fryer', ['chickenFlavor'], [['Chicken Piece (raw)', 2]]],
      ['C3', '6-pc Chicken Bucket', 'Share box of six pieces', 499, '🪣', 'fryer', ['chickenFlavor'], [['Chicken Piece (raw)', 6]]],
      ['C4', 'Chicken Nuggets (6)', 'With sweet & sour dip', 109, '🍤', 'fryer', [], [['Chicken Fillet', 1]]],
    ]],
    ['Rice & Pasta', '🍝', '#ca8a04', [
      ['R1', 'Spaghetti', 'Sweet-style with hotdog and cheese', 79, '🍝', 'assembly', ['pastaAdd'], [['Spaghetti Noodles', 150], ['Sweet Sauce', 120], ['Hotdog', 1]]],
      ['R2', 'Burger Steak (1-pc)', 'With rice and mushroom gravy', 89, '🍛', 'assembly', ['riceExtras'], [['Beef Patty', 1], ['Rice', 1], ['Gravy', 60]]],
      ['R3', 'Longganisa Breakfast', 'Sweet sausage, egg & garlic rice', 129, '🍳', 'grill', ['riceExtras'], [['Longganisa', 2], ['Egg', 1], ['Rice', 1]]],
      ['R4', 'Plain Rice', 'Steamed rice', 25, '🍚', 'assembly', [], [['Rice', 1]]],
    ]],
    ['Sides', '🍟', '#16a34a', [
      ['S1', 'Fries (Regular)', 'Golden crispy fries', 55, '🍟', 'fryer', [], [['Potato Fries', 100]]],
      ['S2', 'Fries (Large)', 'Golden crispy fries', 85, '🍟', 'fryer', [], [['Potato Fries', 160]]],
      ['S3', 'Mashed Potato', 'With gravy', 45, '🥔', 'assembly', [], [['Gravy', 40]]],
      ['S4', 'Buttered Corn', 'Sweet corn cup', 49, '🌽', 'assembly', [], []],
    ]],
    ['Drinks', '🥤', '#0284c7', [
      ['D1', 'Iced Tea', 'House-brewed', 45, '🧋', 'drinks', ['drinkSize', 'ice'], [['Iced Tea Mix', 60]]],
      ['D2', 'Cola', 'Fountain soda', 49, '🥤', 'drinks', ['drinkSize', 'ice'], [['Cola Syrup', 50]]],
      ['D3', 'Pineapple Juice', 'Chilled', 59, '🍍', 'drinks', ['ice'], [['Cup 16oz', 1]]],
      ['D4', 'Brewed Coffee', 'Hot, freshly brewed', 55, '☕', 'drinks', [], [['Coffee Beans', 12]]],
      ['D5', 'Bottled Water', '500 ml', 30, '💧', 'drinks', [], []],
    ]],
    ['Desserts', '🍦', '#db2777', [
      ['E1', 'Soft Serve Cone', 'Vanilla twist', 25, '🍦', 'dessert', [], [['Soft Serve Mix', 90]]],
      ['E2', 'Sundae', 'Vanilla soft serve with topping', 59, '🍨', 'dessert', ['sundae'], [['Soft Serve Mix', 150]]],
      ['E3', 'Peach Mango Pie', 'Crispy pie with real fruit', 45, '🥧', 'fryer', [], [['Pie Crust', 1], ['Peach Mango Filling', 60]]],
      ['E4', 'Cookie Crumble Float', 'Iced coffee float', 69, '🥛', 'dessert', [], [['Soft Serve Mix', 80], ['Cup 16oz', 1]]],
    ]],
    ['Family Bundles', '👨‍👩‍👧', '#7c3aed', [
      ['F1', 'Family Bucket Bundle', '6-pc chicken, 4 rice, 1 large spaghetti, 4 drinks', 999, '🎉', 'fryer', ['chickenFlavor'], [['Chicken Piece (raw)', 6], ['Rice', 4], ['Spaghetti Noodles', 450], ['Sweet Sauce', 300], ['Hotdog', 3], ['Cup 16oz', 4]]],
      ['F2', 'Burger Party Pack', '6 cheeseburgers, 3 large fries', 649, '🎁', 'grill', [], [['Burger Bun', 6], ['Beef Patty', 6], ['Cheese Slice', 6], ['Potato Fries', 480]]],
    ]],
  ];
  menu.forEach(([cname, cicon, color, items], ci) => {
    const cid = Number(insCat.run(cname, cicon, color, ci).lastInsertRowid);
    items.forEach(([sku, name, desc, price, icon, station, groups, recipe], ii) => {
      const iid = Number(insItem.run(cid, sku, name, desc, P(price), icon, station, ii).lastInsertRowid);
      groups.forEach((g, gi) => insIMG.run(iid, G[g], gi));
      for (const [ing, qty] of recipe) insRecipe.run(iid, ING[ing], qty);
    });
  });

  const insTable = db.prepare('INSERT INTO dining_tables (name, seats, area) VALUES (?, ?, ?)');
  for (let i = 1; i <= 12; i++) insTable.run(`T${i}`, i <= 8 ? 4 : 6, 'Main Dining');
  for (let i = 1; i <= 4; i++) insTable.run(`P${i}`, 2, 'Patio');
}

/** Deterministic PRNG so demo data is reproducible. */
function rng(seed) {
  let x = seed;
  return () => { x = (x * 1664525 + 1013904223) % 4294967296; return x / 4294967296; };
}

// Lunch and dinner rush weighting, 7am–10pm.
const HOUR_WEIGHTS = { 7: 3, 8: 5, 9: 4, 10: 4, 11: 9, 12: 14, 13: 11, 14: 5, 15: 5, 16: 6, 17: 9, 18: 13, 19: 12, 20: 7, 21: 4 };

function seedHistory(s, days = 14) {
  const { db } = s;
  const rand = rng(42);
  const pick = (arr) => arr[Math.floor(rand() * arr.length)];
  const weighted = Object.entries(HOUR_WEIGHTS).flatMap(([h, w]) => Array(w).fill(Number(h)));
  const items = db.prepare('SELECT * FROM items').all();
  const popular = items.flatMap((i) => Array(i.category_id === 1 ? 5 : i.category_id <= 3 ? 3 : 2).fill(i));
  const groupsOf = db.prepare('SELECT g.* FROM item_modifier_groups img JOIN modifier_groups g ON g.id = img.group_id WHERE img.item_id = ? ORDER BY img.sort');
  const optsOf = db.prepare('SELECT * FROM modifier_options WHERE group_id = ?');
  const cashiers = db.prepare("SELECT id FROM users WHERE role = 'cashier'").all().map((u) => u.id);
  const admin = db.prepare("SELECT * FROM users WHERE role = 'admin'").get();
  const vatBps = s.settings.vatBps();
  const today = businessDate();

  const insOrder = db.prepare(`INSERT INTO orders (order_no, business_date, type, source, status, kitchen_status, guest_count, sc_pwd_count, sc_pwd_ids,
      subtotal, sc_pwd_discount, other_discount, vatable_sales, vat_amount, vat_exempt_sales, service_charge, total, or_number,
      created_by, cashier_id, shift_id, stock_deducted, created_at, updated_at, sent_at, ready_at, served_at, paid_at)
    VALUES (?, ?, ?, ?, 'paid', 'served', ?, ?, ?, ?, ?, 0, ?, ?, ?, 0, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?)`);
  const insLine = db.prepare(`INSERT INTO order_lines (order_id, item_id, name, station, base_price, unit_price, qty, line_total, modifiers, sent, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`);
  const insPay = db.prepare(`INSERT INTO payments (order_id, method, amount, tendered, change_given, reference, shift_id, user_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const insShift = db.prepare(`INSERT INTO shifts (user_id, terminal, status, opening_float, opened_at) VALUES (?, 'POS-1', 'open', 300000, ?)`);
  let orNo = 0;

  for (let d = days; d >= 1; d--) {
    const date = businessDate(new Date(Date.now() - d * 86400_000));
    if (date >= today) continue;
    transaction(db, () => {
      const shiftByCashier = new Map(cashiers.map((c) => [c, Number(insShift.run(c, new Date(`${date}T06:30:00+08:00`).toISOString()).lastInsertRowid)]));
      const weekend = [0, 6].includes(new Date(`${date}T12:00:00+08:00`).getUTCDay());
      const count = Math.floor((weekend ? 95 : 70) + rand() * 30);
      const times = Array.from({ length: count }, () => {
        const h = pick(weighted);
        return new Date(`${date}T${String(h).padStart(2, '0')}:${String(Math.floor(rand() * 60)).padStart(2, '0')}:${String(Math.floor(rand() * 60)).padStart(2, '0')}+08:00`);
      }).sort((a, b) => a - b);
      times.forEach((t, idx) => {
        const lines = [];
        const n = 1 + Math.floor(rand() * 3.2);
        for (let k = 0; k < n; k++) {
          const item = pick(popular);
          const mods = [];
          for (const g of groupsOf.all(item.id)) {
            const opts = optsOf.all(g.id);
            if (g.min_select > 0 || rand() < 0.2) {
              const o = rand() < 0.6 ? (opts.find((x) => x.is_default) || opts[0]) : pick(opts);
              mods.push({ option_id: o.id, group_id: g.id, group: g.name, name: o.name, price_delta: o.price_delta });
            }
          }
          const qty = rand() < 0.85 ? 1 : 2;
          const unit = item.price + mods.reduce((a, m) => a + m.price_delta, 0);
          lines.push({ item, mods, qty, unit, line_total: unit * qty, vat_exempt_eligible: true });
        }
        const guests = 1 + Math.floor(rand() * 3);
        const sc = rand() < 0.12 ? 1 : 0;
        const tot = computeTotals({ lines, guestCount: guests, scPwdCount: sc, vatBps });
        const type = pick(['dine_in', 'dine_in', 'take_out', 'take_out', 'drive_thru', 'delivery']);
        const source = rand() < 0.22 ? 'kiosk' : 'pos';
        const cashier = pick(cashiers);
        const sent = new Date(t.getTime() + 30_000);
        const ready = new Date(sent.getTime() + (3 + rand() * 7) * 60_000);
        const served = new Date(ready.getTime() + 60_000);
        orNo += 1;
        const oid = Number(insOrder.run(idx + 1, date, type, source, guests, sc, sc ? JSON.stringify([`SC-${Math.floor(100000 + rand() * 899999)}`]) : null,
          tot.subtotal, tot.sc_pwd_discount, tot.vatable_sales, tot.vat_amount, tot.vat_exempt_sales, tot.total, orNo,
          cashier, cashier, shiftByCashier.get(cashier), t.toISOString(), t.toISOString(), sent.toISOString(), ready.toISOString(), served.toISOString(), t.toISOString()).lastInsertRowid);
        for (const l of lines) insLine.run(oid, l.item.id, l.item.name, l.item.station, l.item.price, l.unit, l.qty, l.line_total, JSON.stringify(l.mods), t.toISOString());
        const r = rand();
        const method = r < 0.55 ? 'cash' : r < 0.75 ? 'gcash' : r < 0.9 ? 'card' : 'maya';
        if (method === 'cash') {
          const tendered = Math.ceil(tot.total / 10000) * 10000 + (rand() < 0.3 ? 10000 : 0);
          insPay.run(oid, 'cash', tot.total, tendered, tendered - tot.total, null, shiftByCashier.get(cashier), cashier, t.toISOString());
        } else {
          insPay.run(oid, method, tot.total, tot.total, 0, method === 'card' ? null : `REF${Math.floor(rand() * 1e10)}`, shiftByCashier.get(cashier), cashier, t.toISOString());
        }
      });
      db.prepare('INSERT INTO counters (name, value) VALUES (?, ?)').run(`order_no:${date}`, count);
      // Close the day's shifts exactly on expected cash (a clean demo drawer).
      for (const [, sid] of shiftByCashier) {
        const { expected_cash } = s.shifts.summary(sid);
        db.prepare(`UPDATE shifts SET status = 'closed', closed_at = ?, expected_cash = ?, counted_cash = ?, variance = 0 WHERE id = ?`)
          
          .run(new Date(`${date}T22:30:00+08:00`).toISOString(), expected_cash, expected_cash, sid);
      }
    });
    s.reports.generateZ({ ...admin, ip: 'seed' }, date);
  }
  db.prepare("INSERT INTO counters (name, value) VALUES ('or_number', ?) ON CONFLICT(name) DO UPDATE SET value = excluded.value").run(orNo);
}

module.exports = { seedIfEmpty, STAFF };

// CLI: `npm run seed` — destructive reset, requires explicit confirmation.
if (require.main === module) {
  const fs = require('node:fs');
  const readline = require('node:readline');
  const config = require('../config');
  const { buildServices } = require('../app');
  const { openDatabase } = require('./database');
  const run = () => {
    for (const suffix of ['', '-wal', '-shm']) fs.rmSync(config.dbPath + suffix, { force: true });
    const db = openDatabase(config.dbPath);
    const logins = seedIfEmpty(buildServices(db));
    db.close();
    console.log('Database reset and seeded. Demo logins:\n  ' + logins.join('\n  '));
  };
  if (process.argv.includes('--yes') || !fs.existsSync(config.dbPath)) run();
  else {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(`This DELETES ALL DATA in ${config.dbPath}. Type RESET to continue: `, (a) => {
      rl.close();
      if (a.trim() === 'RESET') run(); else console.log('Aborted.');
    });
  }
}
