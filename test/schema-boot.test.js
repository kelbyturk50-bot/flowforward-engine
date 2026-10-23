require('./preload');

const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { spawn } = require('child_process');
const pool = require('../src/db/client');
const {
  applySchema,
  applyMainSchema,
  _setMainSchemaTimeouts,
  MAIN_SCHEMA_ADVISORY_LOCK,
} = require('../src/db/migrate');
const { insertProspect, closePool } = require('./fixtures');

const PLACE = 'test-place-schema-boot-89';
const LOCK_TIMEOUT_MS = 200;
// Under the 5s default. A boot that ignores the injected timeout and waits
// out the real lock_timeout does not finish inside this bound while the
// share lock is still held. Startup plus the statements before prototypes
// still fit.
const BOOT_BOUND_MS = 4000;

function scrub(text) {
  let out = String(text || '');
  const url = process.env.DATABASE_URL || '';
  if (url) out = out.split(url).join('[redacted]');
  return out;
}

function get(port, reqPath) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      method: 'GET', hostname: '127.0.0.1', port, path: reqPath,
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch { json = null; }
        resolve({ status: res.statusCode, text, json });
      });
    });
    req.on('error', reject);
    req.end();
  });
}

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = http.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const port = probe.address().port;
      probe.close(() => resolve(port));
    });
  });
}

describe('schema boot lock', () => {
  after(async () => {
    _setMainSchemaTimeouts(null);
    await pool.query('DELETE FROM prospects WHERE google_place_id = $1', [PLACE]).catch(() => {});
    await closePool();
  });

  it('keeps schema.sql runnable inside one transaction', () => {
    const schema = fs.readFileSync(path.join(__dirname, '../src/db/schema.sql'), 'utf8');
    const blocked = [
      'CONCURRENTLY', 'VACUUM', 'CLUSTER', 'REINDEX', 'ALTER SYSTEM',
      'CREATE DATABASE', 'DROP DATABASE', 'CREATE TABLESPACE', 'DROP TABLESPACE',
      'CREATE SUBSCRIPTION', 'PREPARE TRANSACTION', 'COMMIT PREPARED', 'DISCARD',
    ];
    for (const word of blocked) assert.equal(schema.includes(word), false, word);
    assert.equal(schema.includes('lock_timeout'), false);
    assert.equal(schema.includes('statement_timeout'), false);
    assert.equal(/^\s*COMMIT\b/m.test(schema), false);
    assert.equal(/^\s*ROLLBACK\b/m.test(schema), false);

    const migrate = fs.readFileSync(path.join(__dirname, '../src/db/migrate.js'), 'utf8');
    const fn = migrate.slice(
      migrate.indexOf('async function applyMainSchema'),
      migrate.indexOf('async function applyBrandConstraints')
    );
    assert.match(fn, /SELECT pg_advisory_xact_lock\(\$1::bigint\)/);
    assert.match(fn, /BEGIN/);
    assert.match(fn, /SET LOCAL lock_timeout = '5s'/);
    assert.match(fn, /SET LOCAL statement_timeout = '60s'/);
    assert.match(fn, /COMMIT/);
    assert.match(fn, /ROLLBACK/);
    const lockAt = fn.indexOf('pg_advisory_xact_lock');
    const timeoutAt = fn.indexOf("SET LOCAL lock_timeout = '5s'");
    const statementAt = fn.indexOf("SET LOCAL statement_timeout = '60s'");
    const schemaAt = fn.indexOf('client.query(sql)');
    assert.ok(lockAt > 0 && lockAt < timeoutAt && timeoutAt < statementAt && statementAt < schemaAt);
  });

  it('applies schema idempotently on two normal boots', async () => {
    _setMainSchemaTimeouts(null);
    const prospect = await insertProspect({
      google_place_id: PLACE,
      company: 'TEST: Schema Boot Heating',
      email: 'test+schema-boot@example.com',
    });
    const tokenHash = crypto.randomBytes(32);
    await pool.query(
      `INSERT INTO prototypes
         (prospect_id, agent_type, brand_name, color_primary, color_secondary,
          token_hash, issued_at, expires_at)
       VALUES ($1, 'estimate_followup', 'TEST: Schema Boot Heating', '#112233', '#445566',
               $2, NOW(), NOW() + INTERVAL '336 hours')`,
      [prospect.id, tokenHash]
    );
    const prior = await pool.query(
      `SELECT enabled FROM feature_flags WHERE name = 'FF_PROTOTYPE_ON_DRAFT'`
    );
    const was = prior.rows[0].enabled;
    try {
      await pool.query(
        `UPDATE feature_flags SET enabled = false WHERE name = 'FF_PROTOTYPE_ON_DRAFT'`
      );
      const before = await pool.query('SELECT COUNT(*)::int AS n FROM prototypes');
      await applySchema();
      await applySchema();
      const after = await pool.query('SELECT COUNT(*)::int AS n FROM prototypes');
      const flag = await pool.query(
        `SELECT enabled FROM feature_flags WHERE name = 'FF_PROTOTYPE_ON_DRAFT'`
      );
      const row = await pool.query(
        `SELECT brand_name, token_hash FROM prototypes WHERE prospect_id = $1`,
        [prospect.id]
      );
      assert.equal(after.rows[0].n, before.rows[0].n);
      assert.equal(flag.rows[0].enabled, false);
      assert.equal(row.rows.length, 1);
      assert.equal(row.rows[0].brand_name, 'TEST: Schema Boot Heating');
      assert.equal(Buffer.compare(row.rows[0].token_hash, tokenHash), 0);
      console.log('[schema-boot] applySchema twice: prototype count unchanged, FF_PROTOTYPE_ON_DRAFT stayed false');
    } finally {
      await pool.query(
        `UPDATE feature_flags SET enabled = $1 WHERE name = 'FF_PROTOTYPE_ON_DRAFT'`,
        [was]
      );
      await pool.query('DELETE FROM prospects WHERE id = $1', [prospect.id]);
    }
  });

  it('lets two concurrent applyMainSchema calls both succeed', async () => {
    _setMainSchemaTimeouts(null);
    await Promise.all([applyMainSchema(), applyMainSchema()]);
    const flag = await pool.query(
      `SELECT name FROM feature_flags WHERE name = 'FF_PROTOTYPE_ON_DRAFT'`
    );
    assert.equal(flag.rows.length, 1);
    console.log('[schema-boot] concurrent applyMainSchema: both succeeded');
  });

  it('takes the advisory lock before lock_timeout, so a short timeout still waits', async () => {
    _setMainSchemaTimeouts({ lockTimeout: '200ms', statementTimeout: '60s' });
    const holder = await pool.connect();
    let pending = Promise.resolve();
    try {
      await holder.query('BEGIN');
      await holder.query('SELECT pg_advisory_xact_lock($1::bigint)', [MAIN_SCHEMA_ADVISORY_LOCK]);
      let settled = false;
      let failure = null;
      pending = applyMainSchema().then(() => { settled = true; }, (err) => {
        settled = true;
        failure = err;
      });
      await new Promise((resolve) => setTimeout(resolve, 350));
      assert.equal(settled, false);
      await holder.query('COMMIT');
      await pending;
      assert.equal(failure, null);
      console.log('[schema-boot] advisory lock serialized a second applyMainSchema past a 200ms lock_timeout');
    } finally {
      await holder.query('ROLLBACK').catch(() => {});
      holder.release();
      await pending.catch(() => {});
      _setMainSchemaTimeouts(null);
    }
  });

  it('boots within the lock bound and answers /health and the 503 gates', async () => {
    const before = await pool.query('SELECT COUNT(*)::int AS n FROM prototypes');
    const port = await freePort();
    const holder = await pool.connect();
    let child;
    let output = '';
    try {
      await holder.query('BEGIN');
      await holder.query('LOCK TABLE prototypes IN ACCESS SHARE MODE');
      const started = Date.now();
      child = spawn(process.execPath, [path.join(__dirname, '../src/server.js')], {
        env: {
          ...process.env,
          PORT: String(port),
          NODE_ENV: 'test',
          DISABLE_CRON: '1',
          CRM_API_KEY: '',
          FF_MAIN_SCHEMA_LOCK_TIMEOUT: `${LOCK_TIMEOUT_MS}ms`,
          FF_MAIN_SCHEMA_STATEMENT_TIMEOUT: '30s',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      child.stdout.on('data', (buf) => { output += buf.toString('utf8'); });
      child.stderr.on('data', (buf) => { output += buf.toString('utf8'); });
      const deadline = started + BOOT_BOUND_MS;
      let health = null;
      let lastErr = '';
      while (Date.now() < deadline) {
        try {
          health = await get(port, '/health');
          break;
        } catch (err) {
          lastErr = err.code || err.message || '';
          if (child.exitCode != null) break;
          await new Promise((resolve) => setTimeout(resolve, 40));
        }
      }
      const elapsed = Date.now() - started;
      assert.ok(health, `server did not listen in ${elapsed}ms (${lastErr}) ${scrub(output).slice(0, 500)}`);
      assert.equal(health.status, 200);
      assert.equal(health.json && health.json.status, 'ok');
      assert.ok(elapsed < BOOT_BOUND_MS, `boot took ${elapsed}ms`);
      const prospects = await get(port, '/api/prospects');
      const flags = await get(port, '/api/flags');
      const campaigns = await get(port, '/api/campaigns');
      for (const gated of [prospects, flags, campaigns]) {
        assert.equal(gated.status, 503);
        assert.deepEqual(gated.json, { error: 'api_key_not_configured' });
      }
      const lines = output.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
      assert.ok(lines.includes('55P03'), scrub(output).slice(0, 800));
      assert.equal(output.includes('canceling statement'), false);
      assert.equal(output.includes('Startup migration/rescore failed'), false);
      assert.equal(output.includes('Schema up to date'), false);
      assert.equal(output.includes('schema is not safe'), false);
      assert.equal(output.includes('Fit scores refreshed'), false);
      assert.equal(output.includes('ALTER TABLE'), false);
      assert.equal(output.includes('ADD COLUMN'), false);
      assert.equal(/postgres(ql)?:\/\//i.test(output), false);
      const after = await pool.query('SELECT COUNT(*)::int AS n FROM prototypes');
      assert.equal(after.rows[0].n, before.rows[0].n);
      console.log(`[schema-boot] timeout boot ${elapsed}ms health=200 gate=503 code=55P03`);
    } finally {
      if (child && child.exitCode == null) {
        child.kill('SIGTERM');
        await new Promise((resolve) => child.once('exit', resolve));
      }
      await holder.query('ROLLBACK').catch(() => {});
      holder.release();
    }
  });
});
