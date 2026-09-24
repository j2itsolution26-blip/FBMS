'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { computeTotals, priceLine } = require('../server/services/pricing');

const L = (...totals) => totals.map((t) => ({ line_total: t }));

test('VAT-inclusive split with no discounts', () => {
  const t = computeTotals({ lines: L(11200) });
  assert.equal(t.subtotal, 11200);
  assert.equal(t.vatable_sales, 10000);
  assert.equal(t.vat_amount, 1200);
  assert.equal(t.total, 11200);
});

test('senior citizen alone: VAT removed then 20% off', () => {
  // ₱112 meal → ₱100 VAT-exempt → ₱20 discount → ₱80 due
  const t = computeTotals({ lines: L(11200), guestCount: 1, scPwdCount: 1 });
  assert.equal(t.vat_exempt_sales, 10000);
  assert.equal(t.sc_pwd_discount, 2000);
  assert.equal(t.vat_amount, 0);
  assert.equal(t.total, 8000);
});

test('senior citizen shares a bill: discount only on their share', () => {
  // ₱448 for 4 guests, 1 SC → SC share ₱112 → pays ₱80; rest ₱336 at full price
  const t = computeTotals({ lines: L(44800), guestCount: 4, scPwdCount: 1 });
  assert.equal(t.sc_pwd_discount, 2000);
  assert.equal(t.total, 33600 + 8000);
  assert.equal(t.vatable_sales + t.vat_amount, 33600);
});

test('promo discount never stacks on the SC/PWD share', () => {
  const t = computeTotals({ lines: L(22400), guestCount: 2, scPwdCount: 1, discount: { type: 'percent', value: 1000 } });
  assert.equal(t.other_discount, 1120); // 10% of the non-SC ₱112
  assert.equal(t.total, 11200 - 1120 + 8000);
});

test('amount discount is capped at the bill', () => {
  const t = computeTotals({ lines: L(5000), discount: { type: 'amount', value: 999999 } });
  assert.equal(t.other_discount, 5000);
  assert.equal(t.total, 0);
});

test('non-eligible lines are excluded from the SC/PWD base', () => {
  const t = computeTotals({ lines: [{ line_total: 11200 }, { line_total: 11200, vat_exempt_eligible: false }], guestCount: 1, scPwdCount: 1 });
  assert.equal(t.sc_pwd_discount, 2000);
  assert.equal(t.total, 8000 + 11200);
});

test('service charge on net-of-VAT sales; non-VAT store', () => {
  const t = computeTotals({ lines: L(11200), serviceChargeBps: 1000 });
  assert.equal(t.service_charge, 1000);
  assert.equal(t.total, 12200);
  const nv = computeTotals({ lines: L(10000), vatBps: 0 });
  assert.equal(nv.vat_amount, 0);
  assert.equal(nv.total, 10000);
});

test('components always reconcile to the total (rounding)', () => {
  for (let i = 0; i < 500; i++) {
    const lines = L(...Array.from({ length: 1 + (i % 5) }, (_, k) => 997 + i * 37 + k * 13));
    const guests = 1 + (i % 6);
    const t = computeTotals({ lines, guestCount: guests, scPwdCount: i % (guests + 1), discount: i % 3 ? { type: 'percent', value: 500 + i } : null, serviceChargeBps: i % 2 ? 500 : 0 });
    assert.equal(t.vatable_sales + t.vat_amount + t.vat_exempt_sales - t.sc_pwd_discount + t.service_charge, t.total);
    assert.ok(t.total >= 0);
  }
});

test('priceLine adds modifier deltas per unit', () => {
  assert.deepEqual(priceLine(18900, [{ price_delta: 3000 }, { price_delta: 2000 }], 2), { unit_price: 23900, line_total: 47800 });
});
