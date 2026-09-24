'use strict';
/** Static build for hosts that serve public/ from a CDN (Vercel): emits public/js/pricing.js. */
const fs = require('node:fs');
const path = require('node:path');
const { sharedPricingModule } = require('../server/http/sharedPricing');

const out = path.join(__dirname, '..', 'public', 'js', 'pricing.js');
fs.writeFileSync(out, sharedPricingModule());
console.log(`Wrote ${path.relative(process.cwd(), out)}`);
