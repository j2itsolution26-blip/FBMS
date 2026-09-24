'use strict';
const config = require('../config');

/** Business date (YYYY-MM-DD) in the store's timezone. */
function businessDate(d = new Date(), tz = config.businessTz) {
  // en-CA formats as YYYY-MM-DD.
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}

/** Hour of day (0-23) in the store's timezone. */
function businessHour(d = new Date(), tz = config.businessTz) {
  return Number(new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', hourCycle: 'h23' }).format(d));
}

const nowIso = () => new Date().toISOString();

module.exports = { businessDate, businessHour, nowIso };
