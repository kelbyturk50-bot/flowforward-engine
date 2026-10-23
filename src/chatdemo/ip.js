// IP bucketing and the discarded daily HMAC key.
// The key stays in process memory. It is not derived from the CRM key.

const crypto = require('crypto');
const { bucketAddress } = require('../pilot/rate-limit');
const { zoneDay, FLOWFORWARD_ZONE } = require('./copy');

let dayKey = crypto.randomBytes(32);
let dayKeyDay = zoneDay(new Date(), FLOWFORWARD_ZONE);

function rotate(now) {
  const day = zoneDay(now instanceof Date ? now : new Date(now), FLOWFORWARD_ZONE);
  if (day !== dayKeyDay) {
    dayKey = crypto.randomBytes(32);
    dayKeyDay = day;
  }
  return { key: dayKey, day: dayKeyDay };
}

function bucketIp(ip) {
  return bucketAddress(ip);
}

function ipHash(bucketedIp, now) {
  const { key, day } = rotate(now || new Date());
  return crypto.createHmac('sha256', key).update(`v1|${bucketedIp}|${day}`).digest('hex');
}

function _dayKeyForTests() {
  if (process.env.NODE_ENV !== 'test') throw new Error('test only');
  return Buffer.from(dayKey);
}

function _resetIpKeyForTests() {
  if (process.env.NODE_ENV !== 'test') throw new Error('test only');
  dayKey = crypto.randomBytes(32);
  dayKeyDay = zoneDay(new Date(), FLOWFORWARD_ZONE);
}

module.exports = { bucketIp, ipHash, _dayKeyForTests, _resetIpKeyForTests };
