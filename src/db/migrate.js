#!/usr/bin/env node
// Applies schema.sql to DATABASE_URL, then brand-constraint validation, then
// estimate-constraint validation, then the pilot repair. schema.sql runs on
// one client in one transaction: an advisory lock, then lock_timeout 5s and
// statement_timeout 60s, then the file, then COMMIT. A lock or statement
// timeout rolls that transaction back. The thrown error's message is the
// SQLSTATE only. Brand, estimate, and pilot steps do not run after that
// throw. Those three files still run after a successful commit, each in its
// own transaction. SET LOCAL lock_timeout and statement_timeout of 5s and
// 15s apply only there. A brand, estimate, or pilot failure cannot roll the
// main schema back. A brand-check or estimate-check failure is logged and
// does not throw.
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
const MAIN_SCHEMA_LOCK_TIMEOUT = '5s';
const MAIN_SCHEMA_STATEMENT_TIMEOUT = '60s';
const TIMEOUT_LITERAL = /^[1-9][0-9]{0,6}(ms|s|min|h)$/;

let testTimeouts = null;

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

function checkedTimeout(value, fallback) {
  if (value == null || value === '') return fallback;
  if (!TIMEOUT_LITERAL.test(value)) throw new Error('invalid schema timeout');
  return value;
}

// Tests pass a short lock_timeout so a held table lock fails fast.
// Refuses to run outside the test process. Production always uses 5s and 60s.
function _setMainSchemaTimeouts(timeouts) {
  if (process.env.NODE_ENV !== 'test') {
    throw new Error('_setMainSchemaTimeouts is only available when NODE_ENV=test');
  }
  if (timeouts == null) {
    testTimeouts = null;
    return;
  }
  testTimeouts = {
    lockTimeout: checkedTimeout(timeouts.lockTimeout, MAIN_SCHEMA_LOCK_TIMEOUT),
    statementTimeout: checkedTimeout(timeouts.statementTimeout, MAIN_SCHEMA_STATEMENT_TIMEOUT),
  };
}

function mainSchemaTimeouts() {
  if (testTimeouts) return testTimeouts;
  // A spawned test server cannot call the setter. NODE_ENV=test may pass
  // the same literals through the environment. Any other environment ignores them.
  if (process.env.NODE_ENV === 'test') {
    const lock = process.env.FF_MAIN_SCHEMA_LOCK_TIMEOUT;
    const statement = process.env.FF_MAIN_SCHEMA_STATEMENT_TIMEOUT;
    if (lock || statement) {
      return {
        lockTimeout: checkedTimeout(lock, MAIN_SCHEMA_LOCK_TIMEOUT),
        statementTimeout: checkedTimeout(statement, MAIN_SCHEMA_STATEMENT_TIMEOUT),
      };
    }
  }
  return {
    lockTimeout: MAIN_SCHEMA_LOCK_TIMEOUT,
    statementTimeout: MAIN_SCHEMA_STATEMENT_TIMEOUT,
  };
}

async function applyMainSchema() {
  const sql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock($1::bigint)', [MAIN_SCHEMA_ADVISORY_LOCK]);
    const timeouts = mainSchemaTimeouts();
    if (timeouts.lockTimeout === '5s' && timeouts.statementTimeout === '60s') {
      await client.query("SET LOCAL lock_timeout = '5s'");
      await client.query("SET LOCAL statement_timeout = '60s'");
    } else {
      await client.query(`SET LOCAL lock_timeout = '${timeouts.lockTimeout}'`);
      await client.query(`SET LOCAL statement_timeout = '${timeouts.statementTimeout}'`);
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
