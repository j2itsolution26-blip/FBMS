'use strict';
/**
 * The server's pricing module re-packaged as a browser ES module, so the POS
 * preview and the server compute totals with literally the same code.
 * Served dynamically by http/static.js, and written to public/js/pricing.js
 * at build time (scripts/build.js) for static hosts such as Vercel.
 */
const fs = require('node:fs');
const path = require('node:path');

let cached;
function sharedPricingModule() {
  if (!cached) {
    const src = fs.readFileSync(path.join(__dirname, '..', 'services', 'pricing.js'), 'utf8');
    cached = `// Generated from server/services/pricing.js — do not edit.\nconst shared = (() => {\nconst module = { exports: {} };\n${src}\nreturn module.exports;\n})();\nexport const { computeTotals, priceLine, SC_PWD_DISCOUNT_BPS } = shared;\n`;
  }
  return cached;
}

module.exports = { sharedPricingModule };
