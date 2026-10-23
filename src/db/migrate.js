#!/usr/bin/env node
// Applies schema.sql to DATABASE_URL, then brand-constraint validation, then
// estimate-constraint validation, then the pilot repair. schema.sql runs on
// one client in one transaction: an advisory lock, then lock_timeout 5s and
// statement_timeout 60s, then the file, then COMMIT. Those two SET LOCAL
// statements are fixed literals. A test override is a positive integer
// millisecond count and applies only when NODE_ENV is exactly test; it is
// passed to set_config as a bound parameter. Any other value uses the
// literals. A lock or statement timeout rolls that transaction back. The
// thrown error's message is the SQLSTATE only. Brand, estimate, and pilot
// steps do not run after that throw. Those three files still run after a
// successful commit, each in its own transaction. SET LOCAL lock_timeout
// and statement_timeout of 5s and 15s apply only there. A brand, estimate,
// or pilot failure cannot roll the main schema back. A brand-check or
// estimate-check failure is logged and does not throw.
//
// schema.sql has no statement that Postgres refuses inside a transaction
// (no CONCURRENTLY, VACUUM, CREATE/DROP DATABASE, or top-level COMMIT).
// The BEGIN tokens in that file are PL/pgSQL bodies.
//
// Run manually: node src/db/migrate.js

const fs = require('fs');
const path = require('path');
const pool = require('./client');

// One fixed id for every process. Held until COMMIT or ROLLBACK so two
// boots do not run schema.sql at the same time. Taken before lock_timeout
// is set, so the wait for this lock is not cut off by the 5s table-lock bound.
const MAIN_SCHEMA_ADVISORY_LOCK = 89089001;
// Positive integer milliseconds, 1..999999. No unit suffix. Anchored so a
// longer string cannot sneak through on a digit prefix.
const POSITIVE_MS = /^\d{1,6}$/;

let testTimeouts = null;

// Returns a canonical millisecond count, or null. Never returns the raw input.
function canonicalMs(value) {
  if (typeof value !== 'string' || !POSITIVE_MS.test(value)) return null;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) return null;
  return String(n);
}

function isBootTimeout(err) {
  const code = err && err.code;
  // 55P03 lock_not_available (lock_timeout), 57014 query_canceled (statement_timeout).
  if (code === '55P03' || code === '57014') return true;
  return /lock timeout|statement timeout|canceling statement due to/i.test(String(err && err.message || ''));
}

function timeoutSqlState(err) {
  const code = err && err.code;
  if (code === '55P03' || code === '57014') return code;
  if (/statement timeout/i.test(String(err && err.message || ''))) return '57014';
  return '55P03';
}

function mainSchemaTimeout(err) {
  const code = timeoutSqlState(err);
  const wrapped = new Error(code);
  wrapped.code = code;
  return wrapped;
}

// null means "use the fixed default". false means the caller supplied a bad value.
function overrideMs(value) {
  if (value == null || value === '') return null;
  const ms = canonicalMs(value);
  return ms == null ? false : ms;
}

// Tests pass a short lock_timeout so a held table lock fails fast.
// Refuses to run outside the test process. A bad value clears any override.
function _setMainSchemaTimeouts(timeouts) {
  if (process.env.NODE_ENV !== 'test') {
    throw new Error('_setMainSchemaTimeouts is only available when NODE_ENV=test');
  }
  if (timeouts == null) {
    testTimeouts = null;
    return;
  }
  const lockTimeout = overrideMs(timeouts.lockTimeout);
  const statementTimeout = overrideMs(timeouts.statementTimeout);
  if (lockTimeout === false || statementTimeout === false) {
    testTimeouts = null;
    throw new Error('invalid schema timeout');
  }
  testTimeouts = { lockTimeout, statementTimeout };
}

function envOverrideMs(name) {
  const raw = process.env[name];
  if (raw == null || raw === '') return null;
  return canonicalMs(raw);
}

// Overrides exist only when NODE_ENV is exactly test. Anywhere else, and for
// any value that is not a positive integer millisecond count, both sides stay
// null and the SQL below uses the fixed literals.
function mainSchemaTimeouts() {
  if (process.env.NODE_ENV !== 'test') return { lockTimeout: null, statementTimeout: null };
  if (testTimeouts) return testTimeouts;
  return {
    lockTimeout: envOverrideMs('FF_MAIN_SCHEMA_LOCK_TIMEOUT'),
    statementTimeout: envOverrideMs('FF_MAIN_SCHEMA_STATEMENT_TIMEOUT'),
  };
}

async function applyMainSchema() {
  const sql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock($1::bigint)', [MAIN_SCHEMA_ADVISORY_LOCK]);
    const timeouts = mainSchemaTimeouts();
    // Re-check at the query. Production never reaches set_config. The bound
    // value is the canonical digit string, not an environment value.
    const lockMs = process.env.NODE_ENV === 'test' ? canonicalMs(timeouts.lockTimeout) : null;
    const statementMs = process.env.NODE_ENV === 'test' ? canonicalMs(timeouts.statementTimeout) : null;
    if (lockMs) {
      await client.query("SELECT set_config('lock_timeout', $1, true)", [lockMs]);
    } else {
      await client.query("SET LOCAL lock_timeout = '5s'");
    }
    if (statementMs) {
      await client.query("SELECT set_config('statement_timeout', $1, true)", [statementMs]);
    } else {
      await client.query("SET LOCAL statement_timeout = '60s'");
    }
    await client.query(sql);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    if (isBootTimeout(err)) throw mainSchemaTimeout(err);
    throw err;
  } finally {
    client.release();
  }
}

async function applyBrandConstraints() {
  const sql = fs.readFileSync(path.join(__dirname, 'brand-constraints.sql'), 'utf8');
  const client = await pool.connect();
  const notices = [];
  function onNotice(msg) {
    const text = msg && typeof msg === 'object' ? String(msg.message || '') : String(msg || '');
    if (text.startsWith('prospect_brands:')) {
      notices.push(text);
      console.warn(`[brand] ${text}`);
    }
  }
  client.on('notice', onNotice);
  let failed = null;
  try {
    // SET LOCAL applies only until this transaction ends. 5s stops a held
    // lock on prospect_brands; 15s stops a validation scan that runs too
    // long. schema.sql has already committed on another connection.
    await client.query('BEGIN');
    await client.query("SET LOCAL lock_timeout = '5s'");
    await client.query("SET LOCAL statement_timeout = '15s'");
    await client.query(sql);
    await client.query('COMMIT');
  } catch (err) {
    failed = err;
    await client.query('ROLLBACK').catch(() => {});
    const message = String(err && err.message || 'brand constraint validation failed');
    console.warn(`[brand] prospect_brands: constraint transaction failed: ${message}`);
    notices.push(message);
  } finally {
    client.removeListener('notice', onNotice);
    client.release();
  }
  return { errors: failed ? [String(failed.message || 'brand constraint validation failed')] : [], notices };
}

async function applyEstimateConstraints() {
  const sql = fs.readFileSync(path.join(__dirname, 'estimate-constraints.sql'), 'utf8');
  const client = await pool.connect();
  const notices = [];
  function onNotice(msg) {
    const text = msg && typeof msg === 'object' ? String(msg.message || '') : String(msg || '');
    if (text.startsWith('pilot_estimates:')) {
      notices.push(text);
      console.warn(`[pilot] ${text}`);
    }
  }
  client.on('notice', onNotice);
  let failed = null;
  try {
    // SET LOCAL applies only until this transaction ends. 5s stops a held
    // lock on the estimate tables; 15s stops a validation scan that runs too
    // long. schema.sql has already committed on another connection.
    await client.query('BEGIN');
    await client.query("SET LOCAL lock_timeout = '5s'");
    await client.query("SET LOCAL statement_timeout = '15s'");
    await client.query(sql);
    await client.query('COMMIT');
  } catch (err) {
    failed = err;
    await client.query('ROLLBACK').catch(() => {});
    const message = String(err && err.message || 'estimate constraint validation failed');
    console.warn(`[pilot] pilot_estimates: constraint transaction failed: ${message}`);
    notices.push(message);
  } finally {
    client.removeListener('notice', onNotice);
    client.release();
  }
  return { errors: failed ? [String(failed.message || 'estimate constraint validation failed')] : [], notices };
}

async function applyPilotSchema() {
  const sql = fs.readFileSync(path.join(__dirname, 'pilot-schema.sql'), 'utf8');
  const client = await pool.connect();
  const notices = [];
  function onNotice(msg) {
    const text = msg && typeof msg === 'object' ? String(msg.message || '') : String(msg || '');
    if (text.startsWith('pilot_tokens:')) notices.push(text);
  }
  client.on('notice', onNotice);
  let failed = null;
  try {
    // SET LOCAL applies only until this transaction ends. 5s stops a held
    // lock on the pilot tables; 15s stops a pilot statement that runs too
    // long. schema.sql has already committed on another connection.
    await client.query('BEGIN');
    await client.query("SET LOCAL lock_timeout = '5s'");
    await client.query("SET LOCAL statement_timeout = '15s'");
    await client.query(sql);
    await client.query('COMMIT');
  } catch (err) {
    failed = err;
    await client.query('ROLLBACK').catch(() => {});
  } finally {
    client.removeListener('notice', onNotice);
    client.release();
  }
  if (failed) {
    const message = String(failed.message || 'pilot schema failed');
    const timedOut = isBootTimeout(failed);
    return {
      errors: [`${timedOut ? 'boot-timeout' : 'pilot-schema'}: ${message}`],
      notices,
      timedOut,
      rolledBack: true,
    };
  }
  let errors = [];
  try {
    const stored = await pool.query(
      'SELECT step, message FROM pilot_boot_errors ORDER BY id'
    );
    errors = stored.rows.map((row) => `${row.step}: ${row.message}`);
  } catch (err) {
    errors = [`pilot_boot_errors: ${err.message}`];
  }
  return { errors, notices, timedOut: false, rolledBack: false };
}

async function applySchema() {
  await applyMainSchema();
  await applyBrandConstraints();
  await applyEstimateConstraints();
  return applyPilotSchema();
}

module.exports = {
  applySchema,
  applyMainSchema,
  applyPilotSchema,
  applyBrandConstraints,
  applyEstimateConstraints,
  _setMainSchemaTimeouts,
  MAIN_SCHEMA_ADVISORY_LOCK,
};

if (require.main === module) {
  console.log('[migrate] Applying schema...');
  applySchema()
    .then(async (report) => {
      const { concludeSchemaBoot } = require('../pilot/schema');
      const result = await concludeSchemaBoot(report);
      if (!result.ok) {
        process.exitCode = 1;
        return;
      }
      console.log('[migrate] ✓ Schema applied successfully');
    })
    .catch(err => {
      if (err && (err.code === '55P03' || err.code === '57014')) console.error(err.code);
      else console.error('[migrate] ✗ Error:', err.message);
      process.exitCode = 1;
    })
    .finally(() => pool.end());
}
