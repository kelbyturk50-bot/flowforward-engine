#!/usr/bin/env node
// Applies schema.sql to DATABASE_URL, then brand-constraint validation, then
// the pilot repair. schema.sql is one implicit transaction with no
// lock_timeout and no statement_timeout. brand-constraints.sql and
// pilot-schema.sql each run after that commit, in their own transaction.
// SET LOCAL lock_timeout and statement_timeout apply only there. A brand or
// pilot failure cannot roll the main schema back. A brand-check failure is
// logged and does not throw.
//
// Run manually: node src/db/migrate.js

const fs = require('fs');
const path = require('path');
const pool = require('./client');

function isBootTimeout(err) {
  const code = err && err.code;
  // 55P03 lock_not_available (lock_timeout), 57014 query_canceled (statement_timeout).
  if (code === '55P03' || code === '57014') return true;
  return /lock timeout|statement timeout|canceling statement due to/i.test(String(err && err.message || ''));
}

async function applyMainSchema() {
  const sql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  await pool.query(sql);
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
  return applyPilotSchema();
}

module.exports = { applySchema, applyMainSchema, applyPilotSchema, applyBrandConstraints };

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
    .catch(err => { console.error('[migrate] ✗ Error:', err.message); process.exitCode = 1; })
    .finally(() => pool.end());
}
