'use strict';
/**
 * Role-based access control. Roles are ordered by privilege for the common
 * "at least X" check; capability lists keep kitchen staff out of the till.
 */
const ROLES = ['kitchen', 'cashier', 'manager', 'admin'];

const CAPABILITIES = {
  'pos.use':        ['cashier', 'manager', 'admin'],
  'kds.use':        ['kitchen', 'cashier', 'manager', 'admin'],
  'orders.void':    ['manager', 'admin'],
  'orders.refund':  ['manager', 'admin'],
  'discount.approve': ['manager', 'admin'],
  'menu.manage':    ['manager', 'admin'],
  'inventory.manage': ['manager', 'admin'],
  'reports.view':   ['manager', 'admin'],
  'shifts.manage':  ['manager', 'admin'],
  'users.manage':   ['admin'],
  'settings.manage': ['admin'],
  'audit.view':     ['manager', 'admin'],
};

function can(role, capability) {
  const allowed = CAPABILITIES[capability];
  if (!allowed) throw new Error(`Unknown capability ${capability}`);
  return allowed.includes(role);
}

module.exports = { ROLES, CAPABILITIES, can };
