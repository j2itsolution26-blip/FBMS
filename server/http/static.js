'use strict';
/** Static file server for the web clients, with path traversal protection. */
const fs = require('node:fs');
const path = require('node:path');

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json',
};
const ALIASES = { '/': '/index.html', '/pos': '/pos.html', '/kds': '/kds.html', '/queue': '/queue.html', '/kiosk': '/kiosk.html', '/admin': '/admin.html' };

// The server's pricing module, re-exported as an ES module for the browser.
let pricingModule;
function sharedPricing() {
  if (!pricingModule) {
    const src = fs.readFileSync(path.join(__dirname, '..', 'services', 'pricing.js'), 'utf8');
    pricingModule = `const shared = (() => {\nconst module = { exports: {} };\n${src}\nreturn module.exports;\n})();\nexport const { computeTotals, priceLine, SC_PWD_DISCOUNT_BPS } = shared;\n`;
  }
  return pricingModule;
}

function serveStatic(root, req, res) {
  let pathname;
  try { pathname = decodeURIComponent(new URL(req.url, 'http://x').pathname); } catch { return false; }
  if (pathname === '/js/pricing.js') {
    const body = sharedPricing();
    res.writeHead(200, { 'Content-Type': TYPES['.js'], 'Content-Length': Buffer.byteLength(body), 'Cache-Control': 'no-cache' });
    return res.end(req.method === 'HEAD' ? undefined : body), true;
  }
  pathname = ALIASES[pathname] || pathname;
  const file = path.normalize(path.join(root, pathname));
  if (!file.startsWith(root + path.sep)) return false;
  let stat;
  try { stat = fs.statSync(file); } catch { return false; }
  if (!stat.isFile()) return false;
  const ext = path.extname(file);
  res.writeHead(200, {
    'Content-Type': TYPES[ext] || 'application/octet-stream',
    'Content-Length': stat.size,
    'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=300',
  });
  if (req.method === 'HEAD') return res.end(), true;
  fs.createReadStream(file).pipe(res);
  return true;
}

module.exports = { serveStatic };
