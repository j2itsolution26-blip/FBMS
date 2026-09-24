'use strict';
/** Fixed-window in-memory rate limiter (single-node deployment). */
const { HttpError } = require('../lib/errors');

function createRateLimiter({ windowMs, max, message = 'Too many requests, slow down' }) {
  const hits = new Map();
  const timer = setInterval(() => {
    const now = Date.now();
    for (const [k, v] of hits) if (v.reset < now) hits.delete(k);
  }, windowMs);
  timer.unref();
  return function check(key) {
    const now = Date.now();
    let e = hits.get(key);
    if (!e || e.reset < now) { e = { count: 0, reset: now + windowMs }; hits.set(key, e); }
    e.count += 1;
    if (e.count > max) throw new HttpError(429, message);
  };
}

module.exports = { createRateLimiter };
