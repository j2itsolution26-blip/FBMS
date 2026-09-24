'use strict';
/** Store-level settings (receipt header, tax, service charge). Values are JSON. */
const { badRequest } = require('../lib/errors');

const DEFAULTS = {
  store_name: 'FBMS Burger & Chicken',
  store_address: '123 Rizal Avenue, Makati City, Metro Manila',
  store_tin: '000-123-456-00000',
  vat_registered: true,
  vat_bps: 1200,
  service_charge_bps: 0,
  dine_in_service_charge_only: true,
  currency_symbol: '₱',
  permit_no: 'PTU FP012026-000-0000001-00000',
  receipt_footer: 'Thank you and come again! This serves as your OFFICIAL RECEIPT.',
  kds_warn_minutes: 5,
  kds_late_minutes: 10,
};

const VALIDATORS = {
  store_name: (v) => typeof v === 'string' && v.length > 0 && v.length <= 80,
  store_address: (v) => typeof v === 'string' && v.length <= 200,
  store_tin: (v) => typeof v === 'string' && v.length <= 40,
  vat_registered: (v) => typeof v === 'boolean',
  vat_bps: (v) => Number.isInteger(v) && v >= 0 && v <= 3000,
  service_charge_bps: (v) => Number.isInteger(v) && v >= 0 && v <= 2000,
  dine_in_service_charge_only: (v) => typeof v === 'boolean',
  currency_symbol: (v) => typeof v === 'string' && v.length <= 4,
  permit_no: (v) => typeof v === 'string' && v.length <= 80,
  receipt_footer: (v) => typeof v === 'string' && v.length <= 300,
  kds_warn_minutes: (v) => Number.isInteger(v) && v > 0 && v < 120,
  kds_late_minutes: (v) => Number.isInteger(v) && v > 0 && v < 240,
};

function createSettingsService(db) {
  async function all() {
    const out = { ...DEFAULTS };
    for (const row of await db.all('SELECT key, value FROM settings')) {
      if (row.key in DEFAULTS) out[row.key] = JSON.parse(row.value);
    }
    return out;
  }

  async function update(patch) {
    for (const [k, v] of Object.entries(patch)) {
      if (!(k in VALIDATORS)) throw badRequest(`Unknown setting ${k}`);
      if (!VALIDATORS[k](v)) throw badRequest(`Invalid value for ${k}`);
    }
    await db.transaction(async () => {
      for (const [k, v] of Object.entries(patch)) {
        await db.run('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', k, JSON.stringify(v));
      }
    });
    return all();
  }

  /** Effective VAT rate: 0 for non-VAT-registered stores. */
  function vatBps(s) {
    return s.vat_registered ? s.vat_bps : 0;
  }

  return { all, update, vatBps, DEFAULTS };
}

module.exports = { createSettingsService };
