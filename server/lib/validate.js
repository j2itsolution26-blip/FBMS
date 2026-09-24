'use strict';
/**
 * Minimal boundary validation. Every route validates its input with these
 * helpers before calling a service, so services can trust their arguments.
 */
const { badRequest } = require('./errors');

function str(v, name, { min = 0, max = 200, optional = false } = {}) {
  if (v === undefined || v === null || v === '') {
    if (optional) return null;
    throw badRequest(`${name} is required`);
  }
  if (typeof v !== 'string') throw badRequest(`${name} must be text`);
  const s = v.trim();
  if (s.length < min) throw badRequest(`${name} must be at least ${min} characters`);
  if (s.length > max) throw badRequest(`${name} must be at most ${max} characters`);
  return s;
}

function int(v, name, { min = -Infinity, max = Infinity, optional = false } = {}) {
  if (v === undefined || v === null || v === '') {
    if (optional) return null;
    throw badRequest(`${name} is required`);
  }
  const n = typeof v === 'string' ? Number(v) : v;
  if (!Number.isInteger(n)) throw badRequest(`${name} must be a whole number`);
  if (n < min || n > max) throw badRequest(`${name} must be between ${min} and ${max}`);
  return n;
}

function num(v, name, { min = -Infinity, max = Infinity, optional = false } = {}) {
  if (v === undefined || v === null || v === '') {
    if (optional) return null;
    throw badRequest(`${name} is required`);
  }
  const n = typeof v === 'string' ? Number(v) : v;
  if (typeof n !== 'number' || !Number.isFinite(n)) throw badRequest(`${name} must be a number`);
  if (n < min || n > max) throw badRequest(`${name} must be between ${min} and ${max}`);
  return n;
}

function oneOf(v, name, allowed, { optional = false } = {}) {
  if (v === undefined || v === null || v === '') {
    if (optional) return null;
    throw badRequest(`${name} is required`);
  }
  if (!allowed.includes(v)) throw badRequest(`${name} must be one of: ${allowed.join(', ')}`);
  return v;
}

function bool(v, name, { optional = false } = {}) {
  if (v === undefined || v === null) {
    if (optional) return null;
    throw badRequest(`${name} is required`);
  }
  if (typeof v !== 'boolean') throw badRequest(`${name} must be true or false`);
  return v;
}

function arr(v, name, { min = 0, max = 500, optional = false } = {}) {
  if (v === undefined || v === null) {
    if (optional) return null;
    throw badRequest(`${name} is required`);
  }
  if (!Array.isArray(v)) throw badRequest(`${name} must be a list`);
  if (v.length < min) throw badRequest(`${name} must have at least ${min} entries`);
  if (v.length > max) throw badRequest(`${name} must have at most ${max} entries`);
  return v;
}

function obj(v, name, { optional = false } = {}) {
  if (v === undefined || v === null) {
    if (optional) return null;
    throw badRequest(`${name} is required`);
  }
  if (typeof v !== 'object' || Array.isArray(v)) throw badRequest(`${name} must be an object`);
  return v;
}

module.exports = { str, int, num, oneOf, bool, arr, obj };
