// IP bucketing and the daily HMAC key.
// The key for an America/Denver day is one row in chat_demo_ip_day_keys.
// This process caches that row until the day changes. A restart or another
// instance loads the same row. The key is not derived from CRM_API_KEY and
// is not logged. A missing row is inserted once; a lost race reads the winner.

const crypto = require('crypto');
const { bucketAddress } = require('../pilot/rate-limit');
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

function bucketIp(ip) {
  return bucketAddress(ip);
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
