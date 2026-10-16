#!/usr/bin/env node
// Applies schema.sql to DATABASE_URL. The schema is idempotent, so this also
// runs automatically every time the server boots (see src/server.js).
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

async function applySchema() {
  const sql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  const client = await pool.connect();
  const notices = [];
  function onNotice(msg) {
    const text = msg && typeof msg === 'object' ? String(msg.message || '') : String(msg || '');
    if (text.startsWith('pilot_tokens:')) notices.push(text);
  }
  client.on('notice', onNotice);
  let failed = null;
  try {
    // Own statements, so they commit before schema.sql runs. A SET inside
    // that script would roll back with it, and the next boot query would
    // wait forever on the same lock. 5s stops a held lock; 15s stops a
    // statement that runs too long. RESET before release so the pooled
    // connection does not keep either limit.
    await client.query("SET lock_timeout = '5s'");
    await client.query("SET statement_timeout = '15s'");
    await client.query(sql);
  } catch (err) {
    failed = err;
    await client.query('ROLLBACK').catch(() => {});
  } finally {
    await client.query('RESET lock_timeout').catch(() => {});
    await client.query('RESET statement_timeout').catch(() => {});
    client.removeListener('notice', onNotice);
    client.release();
  }
  if (failed) {
    const message = String(failed.message || 'schema apply failed');
    if (isBootTimeout(failed)) {
      return { errors: [`boot-timeout: ${message}`], notices, timedOut: true };
    }
    throw failed;
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
  return { errors, notices };
}

module.exports = { applySchema };

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
