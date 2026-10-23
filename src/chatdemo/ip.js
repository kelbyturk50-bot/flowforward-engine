// IP bucketing and the daily HMAC key.
// The key for an America/Denver day is one row in chat_demo_ip_day_keys.
// This process caches that row until the day changes. A restart or another
// instance loads the same row. The key is not derived from CRM_API_KEY and
// is not logged. A missing row is inserted once; a lost race reads the winner.

const crypto = require('crypto');
const net = require('net');
const { zoneDay, FLOWFORWARD_ZONE } = require('./copy');
const { pool } = require('./tx');

let dayKey = null;
let dayKeyDay = null;

function asDate(now) {
  if (now instanceof Date) return now;
  if (now == null || now === '') return new Date();
  return new Date(now);
}

function denverDay(now) {
  return zoneDay(asDate(now), FLOWFORWARD_ZONE);
}

function asKey(value) {
  if (!value) return null;
  const buf = Buffer.isBuffer(value) ? value : Buffer.from(value);
  return buf.length === 32 ? buf : null;
}

async function loadDayKey(now) {
  const day = denverDay(now);
  if (dayKey && dayKeyDay === day) return dayKey;
  const found = await pool.query(
    'SELECT key_bytes FROM chat_demo_ip_day_keys WHERE day = $1::date',
    [day]
  );
  let stored = asKey(found.rows[0] && found.rows[0].key_bytes);
  if (!stored) {
    const fresh = crypto.randomBytes(32);
    const inserted = await pool.query(
      `INSERT INTO chat_demo_ip_day_keys (day, key_bytes)
       VALUES ($1::date, $2)
       ON CONFLICT (day) DO NOTHING
       RETURNING key_bytes`,
      [day, fresh]
    );
    stored = asKey(inserted.rows[0] && inserted.rows[0].key_bytes);
    if (!stored) {
      const again = await pool.query(
        'SELECT key_bytes FROM chat_demo_ip_day_keys WHERE day = $1::date',
        [day]
      );
      stored = asKey(again.rows[0] && again.rows[0].key_bytes);
    }
  }
  if (!stored) {
    const err = new Error('ip_key');
    err.code = 'ip_key';
    throw err;
  }
  dayKey = Buffer.from(stored);
  dayKeyDay = day;
  return dayKey;
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

async function ipHash(bucketedIp, now) {
  const at = asDate(now);
  const day = denverDay(at);
  const key = await loadDayKey(at);
  return crypto.createHmac('sha256', key).update(`v1|${bucketedIp}|${day}`).digest('hex');
}

function _dayKeyForTests() {
  if (process.env.NODE_ENV !== 'test') throw new Error('test only');
  return dayKey ? Buffer.from(dayKey) : null;
}

function _resetIpKeyForTests() {
  if (process.env.NODE_ENV !== 'test') throw new Error('test only');
  dayKey = null;
  dayKeyDay = null;
}

module.exports = { bucketIp, ipHash, _dayKeyForTests, _resetIpKeyForTests };
