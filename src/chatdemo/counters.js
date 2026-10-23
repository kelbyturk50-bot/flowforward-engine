// Express counters (seeded from Postgres) and the cap transaction.
// A failed seed read denies the request. It is never treated as zero.

const crypto = require('crypto');
const { CHAT_CAPS } = require('./caps');
const { zoneDay, FLOWFORWARD_ZONE } = require('./copy');
const { logErr } = require('./log');
const { pool, withChatTx } = require('./tx');

const cache = new Map();
// The map is a hint. Postgres CHECKs stay authoritative. Evict the oldest
// key once the map is past this size so it cannot grow without a bound.
const CACHE_MAX = 1024;

function touch(key, value) {
  if (cache.has(key)) cache.delete(key);
  cache.set(key, value);
  while (cache.size > CACHE_MAX) {
    const oldest = cache.keys().next().value;
    cache.delete(oldest);
  }
}

function utcStamp(date, unit) {
  const d = new Date(date.getTime());
  if (unit === 'minute') d.setUTCSeconds(0, 0);
  else d.setUTCMinutes(0, 0, 0);
  return d.toISOString();
}

async function readCount(sql, params) {
  const { rows } = await pool.query(sql, params);
  if (!rows[0] || rows[0].n == null) return 0;
  return Number(rows[0].n);
}

async function allow(key, max, read) {
  if (!cache.has(key)) {
    const n = await read();
    if (!Number.isFinite(n) || n < 0) {
      const err = new Error('seed');
      err.code = 'seed';
      throw err;
    }
    touch(key, n);
  } else {
    touch(key, cache.get(key));
  }
  return cache.get(key) < max;
}

function bump(key) {
  touch(key, (cache.get(key) || 0) + 1);
}

async function purge(at) {
  const when = at instanceof Date ? at : new Date(at);
  try {
    await pool.query(
      `DELETE FROM chat_demo_ip_hours WHERE hour < $1::timestamptz - interval '48 hours'`,
      [when]
    );
    await pool.query(
      `DELETE FROM chat_demo_rate_minutes WHERE minute < $1::timestamptz - interval '48 hours'`,
      [when]
    );
    await pool.query(
      `DELETE FROM chat_demo_ip_days
        WHERE day < (($1::timestamptz - interval '48 hours') AT TIME ZONE 'America/Denver')::date`,
      [when]
    );
    await pool.query(
      `DELETE FROM chat_demo_ip_day_keys
        WHERE day < (($1::timestamptz - interval '48 hours') AT TIME ZONE 'America/Denver')::date`,
      [when]
    );
    return true;
  } catch (err) {
    logErr('ip_purge_failed', err);
    return false;
  }
}

async function prepareMint({ linkKey, ipHash, at }) {
  const day = zoneDay(at, FLOWFORWARD_ZONE);
  const checks = [
    [`link-sessions\n${linkKey}`, CHAT_CAPS.maxSessionsPerLink,
      () => readCount(`SELECT session_count AS n FROM chat_demo_links WHERE link_key = $1`, [linkKey])],
    [`global\n${day}`, CHAT_CAPS.maxSessionsGlobalDay,
      () => readCount(
        `SELECT session_count AS n FROM chat_demo_global_days WHERE day = ($1::timestamptz AT TIME ZONE 'America/Denver')::date`,
        [at]
      )],
    [`ip-hour\n${ipHash}\n${utcStamp(at, 'hour')}`, CHAT_CAPS.maxMintsPerIpHour,
      () => readCount(
        `SELECT mint_count AS n FROM chat_demo_ip_hours WHERE ip_hash = $1 AND hour = date_trunc('hour', $2::timestamptz)`,
        [ipHash, at]
      )],
    [`ip-day\n${ipHash}\n${day}`, CHAT_CAPS.maxMintsPerIpDay,
      () => readCount(
        `SELECT mint_count AS n FROM chat_demo_ip_days WHERE ip_hash = $1 AND day = ($2::timestamptz AT TIME ZONE 'America/Denver')::date`,
        [ipHash, at]
      )],
  ];
  for (const [key, max, read] of checks) {
    if (!(await allow(key, max, read))) return { ok: false, reason: 'limit', keys: checks.map((item) => item[0]) };
  }
  return { ok: true, keys: checks.map((item) => item[0]) };
}

async function prepareMessage({ sessionId, linkKey, ipHash, at, zone, loadedCount }) {
  const day = zoneDay(at, zone);
  const checks = [
    [`session\n${sessionId}`, CHAT_CAPS.maxMessagesPerSession, async () => loadedCount],
    [`link-messages\n${linkKey}`, CHAT_CAPS.maxMessagesPerLink,
      () => readCount(`SELECT message_count AS n FROM chat_demo_links WHERE link_key = $1`, [linkKey])],
    [`link-day\n${linkKey}\n${day}`, CHAT_CAPS.maxMessagesPerLinkDay,
      () => readCount(
        `SELECT message_count AS n FROM chat_demo_link_days WHERE link_key = $1 AND day = ($2::timestamptz AT TIME ZONE $3)::date`,
        [linkKey, at, zone]
      )],
    [`minute\n${linkKey}\n${ipHash}\n${utcStamp(at, 'minute')}`, CHAT_CAPS.maxMessagesPerTokenIpMinute,
      () => readCount(
        `SELECT count AS n FROM chat_demo_rate_minutes WHERE link_key = $1 AND ip_hash = $2 AND minute = date_trunc('minute', $3::timestamptz)`,
        [linkKey, ipHash, at]
      )],
  ];
  for (const [key, max, read] of checks) {
    if (!(await allow(key, max, read))) return { ok: false, reason: 'limit', keys: checks.map((item) => item[0]) };
  }
  return { ok: true, keys: checks.map((item) => item[0]) };
}

async function commitMint(client, { linkKey, ipHash, at, session }) {
  await client.query(
    `INSERT INTO chat_demo_links (link_key, message_count, session_count)
     VALUES ($1, 0, 1)
     ON CONFLICT (link_key) DO UPDATE
       SET session_count = chat_demo_links.session_count + 1`,
    [linkKey]
  );
  await client.query(
    `INSERT INTO chat_demo_global_days (day, session_count)
     VALUES (($1::timestamptz AT TIME ZONE 'America/Denver')::date, 1)
     ON CONFLICT (day) DO UPDATE
       SET session_count = chat_demo_global_days.session_count + 1`,
    [at]
  );
  await client.query(
    `INSERT INTO chat_demo_ip_hours (ip_hash, hour, mint_count)
     VALUES ($1, date_trunc('hour', $2::timestamptz), 1)
     ON CONFLICT (ip_hash, hour) DO UPDATE
       SET mint_count = chat_demo_ip_hours.mint_count + 1`,
    [ipHash, at]
  );
  await client.query(
    `INSERT INTO chat_demo_ip_days (ip_hash, day, mint_count)
     VALUES ($1, ($2::timestamptz AT TIME ZONE 'America/Denver')::date, 1)
     ON CONFLICT (ip_hash, day) DO UPDATE
       SET mint_count = chat_demo_ip_days.mint_count + 1`,
    [ipHash, at]
  );
  await client.query(
    `INSERT INTO chat_demo_sessions
       (id, prototype_id, link_key, session_hash, message_count, test_tag, created_at, expires_at)
     VALUES ($1, $2, $3, $4, 0, $5, $6, $7)`,
    [session.id, session.prototypeId ?? null, linkKey, session.hash, session.testTag, at, session.expiresAt]
  );
  await client.query(
    `INSERT INTO chat_demo_events
       (id, prototype_id, session_id, event_type, created_at)
     VALUES ($1, $2, $3, 'session_started', $4)`,
    [crypto.randomUUID(), session.prototypeId ?? null, session.id, at]
  );
}

async function commitMessage(client, { sessionId, linkKey, ipHash, at, zone, chars, prototypeId, chipId }) {
  const turnId = crypto.randomUUID();
  await client.query(
    `UPDATE chat_demo_sessions SET message_count = message_count + 1 WHERE id = $1`,
    [sessionId]
  );
  await client.query(
    `INSERT INTO chat_demo_links (link_key, message_count, session_count)
     VALUES ($1, 1, 0)
     ON CONFLICT (link_key) DO UPDATE
       SET message_count = chat_demo_links.message_count + 1`,
    [linkKey]
  );
  await client.query(
    `INSERT INTO chat_demo_link_days (link_key, day, message_count)
     VALUES ($1, ($2::timestamptz AT TIME ZONE $3)::date, 1)
     ON CONFLICT (link_key, day) DO UPDATE
       SET message_count = chat_demo_link_days.message_count + 1`,
    [linkKey, at, zone]
  );
  await client.query(
    `INSERT INTO chat_demo_rate_minutes (link_key, ip_hash, minute, count)
     VALUES ($1, $2, date_trunc('minute', $3::timestamptz), 1)
     ON CONFLICT (link_key, ip_hash, minute) DO UPDATE
       SET count = chat_demo_rate_minutes.count + 1`,
    [linkKey, ipHash, at]
  );
  await client.query(
    `INSERT INTO chat_demo_turns (id, session_id, input_chars, created_at)
     VALUES ($1, $2, $3, $4)`,
    [turnId, sessionId, chars, at]
  );
  await client.query(
    `INSERT INTO chat_demo_events (id, prototype_id, session_id, event_type, chip_id, created_at)
     VALUES ($1, $2, $3, 'message_sent', $4, $5)`,
    [crypto.randomUUID(), prototypeId || null, sessionId, chipId || null, at]
  );
  return turnId;
}

async function runMint(spec) {
  return withChatTx((client) => commitMint(client, spec));
}

async function runMessage(spec) {
  return withChatTx((client) => commitMessage(client, spec));
}

async function finishTurn(turnId, fields) {
  await withChatTx(async (client) => {
    await client.query(
      `UPDATE chat_demo_turns
          SET source = $2,
              output_tokens = $3,
              cost_usd = $4,
              input_bound_tokens = $5
        WHERE id = $1`,
      [turnId, fields.source, fields.outputTokens, fields.costUsd, fields.boundTokens]
    );
  });
}

async function loadSession(hash) {
  const { rows } = await pool.query(
    `SELECT id, prototype_id, link_key, session_hash, message_count, test_tag, created_at, expires_at
       FROM chat_demo_sessions
      WHERE session_hash = $1`,
    [hash]
  );
  return rows[0] || null;
}

function rememberBumps(keys) {
  for (const key of keys) bump(key);
}

function _resetExpressCacheForTests() {
  if (process.env.NODE_ENV !== 'test') throw new Error('test only');
  cache.clear();
}

function _seedExpressCacheForTests(key, value) {
  if (process.env.NODE_ENV !== 'test') throw new Error('test only');
  touch(key, value);
}

function _expressCacheSizeForTests() {
  if (process.env.NODE_ENV !== 'test') throw new Error('test only');
  return cache.size;
}

function _expressCacheHasForTests(key) {
  if (process.env.NODE_ENV !== 'test') throw new Error('test only');
  return cache.has(key);
}

module.exports = {
  CACHE_MAX,
  purge,
  prepareMint,
  prepareMessage,
  runMint,
  runMessage,
  finishTurn,
  loadSession,
  rememberBumps,
  _resetExpressCacheForTests,
  _seedExpressCacheForTests,
  _expressCacheSizeForTests,
  _expressCacheHasForTests,
};
