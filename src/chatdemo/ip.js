// IP bucketing and the discarded daily HMAC key.
// The key stays in process memory. It is not derived from the CRM key.

const crypto = require('crypto');
const net = require('net');
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

function hextet(value) {
  if (!/^[0-9a-f]{1,4}$/.test(value)) return null;
  return parseInt(value, 16).toString(16);
}

function expandIPv6(ip) {
  const halves = ip.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':').filter((part) => part !== '') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':').filter((part) => part !== '') : [];
  if (halves.length === 1 && head.length !== 8) return null;
  const missing = 8 - head.length - tail.length;
  if (missing < 0) return null;
  const parts = halves.length === 1 ? head : [...head, ...Array(missing).fill('0'), ...tail];
  if (parts.length !== 8) return null;
  const parsed = parts.map(hextet);
  if (parsed.some((part) => part == null)) return null;
  return parsed;
}

function compress(parts) {
  let bestStart = -1;
  let bestLen = 0;
  let runStart = -1;
  for (let i = 0; i <= parts.length; i += 1) {
    if (i < parts.length && parts[i] === '0') {
      if (runStart < 0) runStart = i;
    } else if (runStart >= 0) {
      const len = i - runStart;
      if (len > bestLen) {
        bestStart = runStart;
        bestLen = len;
      }
      runStart = -1;
    }
  }
  if (bestLen < 2) return parts.join(':');
  const head = parts.slice(0, bestStart).join(':');
  const tail = parts.slice(bestStart + bestLen).join(':');
  return `${head}::${tail}`;
}

function bucketIp(ip) {
  let value = String(ip || '').trim().toLowerCase();
  if (!value) return 'unknown';
  if (value.startsWith('::ffff:')) {
    const mapped = value.slice('::ffff:'.length);
    if (net.isIP(mapped) === 4) return mapped;
  }
  if (net.isIP(value) === 4) return value;
  if (net.isIP(value) !== 6) return 'unknown';
  const parts = expandIPv6(value);
  if (!parts) return 'unknown';
  const prefix = parts.slice(0, 4).concat(['0', '0', '0', '0']);
  return `${compress(prefix)}/64`;
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
