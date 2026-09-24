'use strict';
/** scrypt password/PIN hashing with per-hash salt and constant-time compare. */
const crypto = require('node:crypto');

const N = 16384, R = 8, P = 1, KEYLEN = 32;

function hashSecret(secret) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(secret), salt, KEYLEN, { N, r: R, p: P });
  return `scrypt$${N}$${R}$${P}$${salt.toString('base64')}$${hash.toString('base64')}`;
}

function verifySecret(secret, stored) {
  if (!stored || typeof stored !== 'string') return false;
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, n, r, p, saltB64, hashB64] = parts;
  const expected = Buffer.from(hashB64, 'base64');
  const actual = crypto.scryptSync(String(secret), Buffer.from(saltB64, 'base64'), expected.length, {
    N: Number(n), r: Number(r), p: Number(p),
  });
  return crypto.timingSafeEqual(expected, actual);
}

module.exports = { hashSecret, verifySecret };
