'use strict';
/**
 * Pure bill computation — no I/O, fully unit-tested.
 *
 * Menu prices are VAT-inclusive (standard for PH quick-service). Senior
 * Citizen / PWD handling follows RA 9994 / RA 10754 practice:
 *   - the qualifying share of the bill is (sc_pwd_count / guest_count);
 *   - that share is made VAT-exempt (VAT removed), then
 *   - a 20% discount is applied to the VAT-exclusive amount.
 * Other discounts (promo, employee) apply only to the non-SC/PWD share, so the
 * two are never stacked on the same peso.
 */
// Kept dependency-free: this file is also served to browsers as an ES module
// (see http/static.js) so the POS preview and the server can never disagree.
const roundCents = (x) => (x < 0 ? -Math.round(-x) : Math.round(x));

const SC_PWD_DISCOUNT_BPS = 2000; // 20%

/**
 * @param {object} p
 * @param {{line_total:number, vat_exempt_eligible?:boolean}[]} p.lines
 * @param {number} [p.guestCount=1]
 * @param {number} [p.scPwdCount=0]
 * @param {{type:'percent'|'amount', value:number}|null} [p.discount] percent in basis points, amount in cents
 * @param {number} [p.serviceChargeBps=0]
 * @param {number} [p.vatBps=1200]
 */
function computeTotals({ lines, guestCount = 1, scPwdCount = 0, discount = null, serviceChargeBps = 0, vatBps = 1200 }) {
  const subtotal = lines.reduce((s, l) => s + l.line_total, 0);
  const eligible = lines.reduce((s, l) => s + (l.vat_exempt_eligible === false ? 0 : l.line_total), 0);

  const guests = Math.max(1, guestCount);
  const qualifying = Math.min(Math.max(0, scPwdCount), guests);
  const exemptGross = roundCents((eligible * qualifying) / guests);
  const vatExemptSales = roundCents((exemptGross * 10000) / (10000 + vatBps));
  const scPwdDiscount = roundCents((vatExemptSales * SC_PWD_DISCOUNT_BPS) / 10000);

  const regularGross = subtotal - exemptGross;
  let otherDiscount = 0;
  if (discount && discount.value > 0) {
    otherDiscount = discount.type === 'percent'
      ? roundCents((regularGross * Math.min(discount.value, 10000)) / 10000)
      : Math.min(discount.value, regularGross);
  }
  const regularNet = regularGross - otherDiscount;
  const vatableSales = roundCents((regularNet * 10000) / (10000 + vatBps));
  const vatAmount = regularNet - vatableSales;

  // Service charge is levied on net sales exclusive of VAT.
  const netExVat = vatableSales + vatExemptSales - scPwdDiscount;
  const serviceCharge = roundCents((netExVat * serviceChargeBps) / 10000);

  const total = regularNet + vatExemptSales - scPwdDiscount + serviceCharge;

  return {
    subtotal,
    sc_pwd_discount: scPwdDiscount,
    other_discount: otherDiscount,
    vat_exempt_sales: vatExemptSales,
    vat_removed: exemptGross - vatExemptSales,
    vatable_sales: vatableSales,
    vat_amount: vatAmount,
    service_charge: serviceCharge,
    total,
  };
}

/** Price one line from catalogue data. Returns unit/line totals in cents. */
function priceLine(basePrice, modifiers, qty) {
  const unit = basePrice + modifiers.reduce((s, m) => s + m.price_delta, 0);
  return { unit_price: unit, line_total: unit * qty };
}

module.exports = { computeTotals, priceLine, SC_PWD_DISCOUNT_BPS };
