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

// Swaps pool.connect for a recording client. No database.
async function withStubClient(fail, fn) {
  const calls = [];
  const params = [];
  let released = 0;
  const original = pool.connect;
  pool.connect = async () => ({
    async query(text, values) {
      calls.push(String(text));
      params.push(values == null ? [] : [].concat(values));
      if (fail && String(text).length > 1000) throw fail;
      return { rows: [] };
    },
    release() { released += 1; },
  });
  try {
    return await fn(calls, () => released, params);
  } finally {
    pool.connect = original;
  }
}

// Records the delays applyMainSchema sleeps between advisory-lock tries.
// The fake client below never calls setTimeout, so only the backoff does.
function spySleeps() {
  const original = global.setTimeout;
  const delays = [];
  global.setTimeout = (fn, ms, ...rest) => {
    delays.push(ms);
    return original(fn, ms, ...rest);
  };
  return { delays, restore() { global.setTimeout = original; } };
}

function pgError(code, message) {
  const err = new Error(message);
  if (code) err.code = code;
  err.where = 'SQL statement "ALTER TABLE prototypes ADD COLUMN secret_marker text"';
  return err;
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
    assert.ok(timeoutAt > 0 && timeoutAt < statementAt && statementAt < lockAt && lockAt < schemaAt);
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

  it('gives up on the advisory lock inside the test lock_timeout', async () => {
    _setMainSchemaTimeouts({ lockTimeout: '200', statementTimeout: '60000' });
    const holder = await pool.connect();
    const origExit = process.exit;
    const origError = console.error;
    const logged = [];
    let exitCode = null;
    console.error = (...args) => { logged.push(args.map(String).join(' ')); };
    process.exit = (code) => {
      exitCode = code;
      throw new Error('process.exit');
    };
    try {
      await holder.query('BEGIN');
      await holder.query('SELECT pg_advisory_xact_lock($1::bigint)', [MAIN_SCHEMA_ADVISORY_LOCK]);
      const started = Date.now();
      await assert.rejects(applyMainSchema(), (err) => err && err.message === 'process.exit');
      const elapsed = Date.now() - started;
      assert.equal(exitCode, 1);
      assert.deepEqual(logged, ['55P03']);
      assert.ok(elapsed < 4000, `advisory wait took ${elapsed}ms`);
      assert.ok(elapsed >= 500, `advisory wait returned in ${elapsed}ms`);
      await holder.query('SELECT 1');
      console.log(`[schema-boot] advisory lock wait gave up in ${elapsed}ms with 55P03`);
    } finally {
      process.exit = origExit;
      console.error = origError;
      await holder.query('ROLLBACK').catch(() => {});
      holder.release();
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
          FF_MAIN_SCHEMA_LOCK_TIMEOUT: String(LOCK_TIMEOUT_MS),
          FF_MAIN_SCHEMA_STATEMENT_TIMEOUT: '30000',
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

  it('runs BEGIN, SET LOCAL timeouts, lock, schema, COMMIT in that order', async () => {
    _setMainSchemaTimeouts(null);
    await withStubClient(null, async (calls, released) => {
      await applyMainSchema();
      const head = calls.slice(0, 4);
      assert.deepEqual(head, [
        'BEGIN',
        "SET LOCAL lock_timeout = '5s'",
        "SET LOCAL statement_timeout = '60s'",
        'SELECT pg_advisory_xact_lock($1::bigint)',
      ]);
      assert.ok(calls[4].length > 1000);
      assert.equal(calls[5], 'COMMIT');
      assert.equal(calls.length, 6);
      assert.equal(released(), 1);
    });
    _setMainSchemaTimeouts({ lockTimeout: '200', statementTimeout: '2000' });
    try {
      await withStubClient(null, async (calls, released, params) => {
        await applyMainSchema();
        assert.deepEqual(calls.slice(0, 4), [
          'BEGIN',
          "SELECT set_config('lock_timeout', $1, true)",
          "SELECT set_config('statement_timeout', $1, true)",
          'SELECT pg_advisory_xact_lock($1::bigint)',
        ]);
        assert.deepEqual(params[1], ['200']);
        assert.deepEqual(params[2], ['2000']);
        assert.equal(calls[5], 'COMMIT');
        assert.equal(released(), 1);
      });
    } finally {
      _setMainSchemaTimeouts(null);
    }
  });

  it('rolls back and throws a bare SQLSTATE on 55P03 and 57014', async () => {
    _setMainSchemaTimeouts(null);
    const cases = [
      [pgError('57014', 'canceling statement due to statement timeout'), '57014'],
      [pgError('55P03', 'canceling statement due to lock timeout'), '55P03'],
      [pgError(null, 'canceling statement due to statement timeout'), '57014'],
      [pgError(null, 'canceling statement due to lock timeout'), '55P03'],
    ];
    for (const [fail, code] of cases) {
      await withStubClient(fail, async (calls, released) => {
        let thrown = null;
        try { await applyMainSchema(); } catch (err) { thrown = err; }
        assert.ok(thrown, code);
        assert.equal(thrown.message, code);
        assert.equal(thrown.code, code);
        assert.equal(thrown.where, undefined);
        assert.equal(calls[calls.length - 1], 'ROLLBACK');
        assert.equal(calls.includes('COMMIT'), false);
        assert.equal(released(), 1);
      });
    }
    const other = pgError('42P01', 'relation does not exist');
    await withStubClient(other, async (calls) => {
      await assert.rejects(applyMainSchema(), (err) => err === other);
      assert.equal(calls[calls.length - 1], 'ROLLBACK');
    });
  });

  it('keeps test timeouts out of other NODE_ENV values and checks the literal', async () => {
    _setMainSchemaTimeouts(null);
    assert.throws(
      () => _setMainSchemaTimeouts({ lockTimeout: "1'; DROP TABLE prospects; --" }),
      /invalid schema timeout/
    );
    await withStubClient(null, async (calls, released, params) => {
      await applyMainSchema();
      assert.equal(calls[1], "SET LOCAL lock_timeout = '5s'");
      assert.equal(calls[2], "SET LOCAL statement_timeout = '60s'");
      assert.equal(calls.some((text) => text.includes('DROP TABLE')), false);
      assert.equal(params.some((row) => row.some((item) => String(item).includes('DROP'))), false);
    });
    const savedEnv = process.env.NODE_ENV;
    const savedLock = process.env.FF_MAIN_SCHEMA_LOCK_TIMEOUT;
    const savedStatement = process.env.FF_MAIN_SCHEMA_STATEMENT_TIMEOUT;
    _setMainSchemaTimeouts(null);
    try {
      process.env.FF_MAIN_SCHEMA_LOCK_TIMEOUT = "5'; SELECT 1; --";
      process.env.FF_MAIN_SCHEMA_STATEMENT_TIMEOUT = '1ms';
      await withStubClient(null, async (calls, released, params) => {
        await applyMainSchema();
        assert.equal(calls[1], "SET LOCAL lock_timeout = '5s'");
        assert.equal(calls[2], "SET LOCAL statement_timeout = '60s'");
        assert.equal(calls.some((text) => text.includes('SELECT 1;')), false);
        assert.equal(params.some((row) => row.some((item) => String(item).includes('SELECT 1'))), false);
      });
      _setMainSchemaTimeouts({ lockTimeout: '200', statementTimeout: '1000' });
      process.env.FF_MAIN_SCHEMA_LOCK_TIMEOUT = '200';
      process.env.FF_MAIN_SCHEMA_STATEMENT_TIMEOUT = '1000';
      for (const env of ['production', 'development', '', 'TEST']) {
        process.env.NODE_ENV = env;
        assert.throws(
          () => _setMainSchemaTimeouts({ lockTimeout: '200' }),
          /only available when NODE_ENV=test/,
          env
        );
        await withStubClient(null, async (calls) => {
          await applyMainSchema();
          assert.equal(calls[1], "SET LOCAL lock_timeout = '5s'", env);
          assert.equal(calls[2], "SET LOCAL statement_timeout = '60s'", env);
        });
      }
    } finally {
      process.env.NODE_ENV = savedEnv;
      if (savedLock == null) delete process.env.FF_MAIN_SCHEMA_LOCK_TIMEOUT;
      else process.env.FF_MAIN_SCHEMA_LOCK_TIMEOUT = savedLock;
      if (savedStatement == null) delete process.env.FF_MAIN_SCHEMA_STATEMENT_TIMEOUT;
      else process.env.FF_MAIN_SCHEMA_STATEMENT_TIMEOUT = savedStatement;
      _setMainSchemaTimeouts(null);
    }
  });

  it('rejects non-integer timeout overrides and uses the fixed defaults', async () => {
    const bad = [
      '200ms', '2s', '1ms', '0', '000000', '-1', '1.5', '1e3',
      ' 200', '200 ', '+200', '9999999', "5'; SELECT 1; --",
    ];
    const savedLock = process.env.FF_MAIN_SCHEMA_LOCK_TIMEOUT;
    const savedStatement = process.env.FF_MAIN_SCHEMA_STATEMENT_TIMEOUT;
    _setMainSchemaTimeouts(null);
    try {
      for (const value of bad) {
        assert.throws(
          () => _setMainSchemaTimeouts({ lockTimeout: value, statementTimeout: '2000' }),
          /invalid schema timeout/,
          value
        );
        process.env.FF_MAIN_SCHEMA_LOCK_TIMEOUT = value;
        process.env.FF_MAIN_SCHEMA_STATEMENT_TIMEOUT = value;
        await withStubClient(null, async (calls, released, params) => {
          await applyMainSchema();
          assert.equal(calls[1], "SET LOCAL lock_timeout = '5s'", value);
          assert.equal(calls[2], "SET LOCAL statement_timeout = '60s'", value);
          const sent = params.slice(1, 3).flat().map((item) => String(item));
          assert.equal(sent.some((item) => item.includes(value)), false, value);
        });
      }
    } finally {
      if (savedLock == null) delete process.env.FF_MAIN_SCHEMA_LOCK_TIMEOUT;
      else process.env.FF_MAIN_SCHEMA_LOCK_TIMEOUT = savedLock;
      if (savedStatement == null) delete process.env.FF_MAIN_SCHEMA_STATEMENT_TIMEOUT;
      else process.env.FF_MAIN_SCHEMA_STATEMENT_TIMEOUT = savedStatement;
      _setMainSchemaTimeouts(null);
    }
  });

  it('logs only 57014 when the main schema hits statement_timeout, and still listens', async () => {
    const port = await freePort();
    let output = '';
    const child = spawn(process.execPath, [path.join(__dirname, '../src/server.js')], {
      env: {
        ...process.env,
        PORT: String(port),
        NODE_ENV: 'test',
        DISABLE_CRON: '1',
        CRM_API_KEY: '',
        FF_MAIN_SCHEMA_LOCK_TIMEOUT: '5000',
        FF_MAIN_SCHEMA_STATEMENT_TIMEOUT: '1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.on('data', (buf) => { output += buf.toString('utf8'); });
    child.stderr.on('data', (buf) => { output += buf.toString('utf8'); });
    try {
      const deadline = Date.now() + 10000;
      let health = null;
      while (Date.now() < deadline && !health) {
        try { health = await get(port, '/health'); } catch {
          if (child.exitCode != null) break;
          await new Promise((resolve) => setTimeout(resolve, 40));
        }
      }
      assert.ok(health, scrub(output).slice(0, 500));
      assert.equal(health.status, 200);
      const gate = await get(port, '/api/prospects');
      assert.equal(gate.status, 503);
      const lines = output.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
      assert.ok(lines.includes('57014'), scrub(output).slice(0, 800));
      assert.equal(output.includes('canceling statement'), false);
      assert.equal(output.includes('Startup migration/rescore failed'), false);
      assert.equal(output.includes('Fit scores refreshed'), false);
      assert.equal(output.includes('ALTER TABLE'), false);
    } finally {
      if (child.exitCode == null) {
        child.kill('SIGTERM');
        await new Promise((resolve) => child.once('exit', resolve));
      }
    }
  });

  it('applies one-sided and 6-digit overrides, and a bad value clears the override', async () => {
    _setMainSchemaTimeouts(null);
    try {
      _setMainSchemaTimeouts({ lockTimeout: '999999' });
      await withStubClient(null, async (calls, released, params) => {
        await applyMainSchema();
        assert.equal(calls[1], "SELECT set_config('lock_timeout', $1, true)");
        assert.deepEqual(params[1], ['999999']);
        assert.equal(calls[2], "SET LOCAL statement_timeout = '60s'");
      });
      _setMainSchemaTimeouts({ statementTimeout: '100000' });
      await withStubClient(null, async (calls, released, params) => {
        await applyMainSchema();
        assert.equal(calls[1], "SET LOCAL lock_timeout = '5s'");
        assert.equal(calls[2], "SELECT set_config('statement_timeout', $1, true)");
        assert.deepEqual(params[2], ['100000']);
      });
      _setMainSchemaTimeouts({ lockTimeout: '200', statementTimeout: '2000' });
      assert.throws(() => _setMainSchemaTimeouts({ lockTimeout: '1.5' }), /invalid schema timeout/);
      await withStubClient(null, async (calls) => {
        await applyMainSchema();
        assert.equal(calls[1], "SET LOCAL lock_timeout = '5s'");
        assert.equal(calls[2], "SET LOCAL statement_timeout = '60s'");
      });
    } finally {
      _setMainSchemaTimeouts(null);
    }
  });

  it('logs only 55P03 and exits non-zero when the advisory lock fails three times', async () => {
    const port = await freePort();
    const holder = await pool.connect();
    let child;
    let output = '';
    try {
      await holder.query('BEGIN');
      await holder.query('SELECT pg_advisory_xact_lock($1::bigint)', [MAIN_SCHEMA_ADVISORY_LOCK]);
      const started = Date.now();
      child = spawn(process.execPath, [path.join(__dirname, '../src/server.js')], {
        env: {
          ...process.env,
          PORT: String(port),
          NODE_ENV: 'test',
          DISABLE_CRON: '1',
          CRM_API_KEY: '',
          FF_MAIN_SCHEMA_LOCK_TIMEOUT: '200',
          FF_MAIN_SCHEMA_STATEMENT_TIMEOUT: '30000',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      child.stdout.on('data', (buf) => { output += buf.toString('utf8'); });
      child.stderr.on('data', (buf) => { output += buf.toString('utf8'); });
      const code = await new Promise((resolve) => {
        const timer = setTimeout(() => resolve('timeout'), 8000);
        child.once('close', (status) => {
          clearTimeout(timer);
          resolve(status);
        });
      });
      const elapsed = Date.now() - started;
      assert.equal(code, 1, scrub(output).slice(0, 800));
      assert.ok(elapsed < 8000, `boot took ${elapsed}ms`);
      await assert.rejects(get(port, '/health'));
      const lines = output.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
      assert.ok(lines.includes('55P03'), scrub(output).slice(0, 800));
      assert.equal(output.includes('canceling statement'), false);
      assert.equal(output.includes('Startup migration/rescore failed'), false);
      assert.equal(output.includes('Fit scores refreshed'), false);
      assert.equal(output.includes('FlowForward Engine running'), false);
      await holder.query('SELECT 1');
      console.log(`[schema-boot] advisory-lock boot ${elapsed}ms exit=1 code=55P03`);
    } finally {
      if (child && child.exitCode == null) {
        child.kill('SIGTERM');
        await new Promise((resolve) => child.once('exit', resolve));
      }
      await holder.query('ROLLBACK').catch(() => {});
      holder.release();
    }
  });

  it('retries the advisory lock and then applies the schema', async () => {
    const calls = [];
    let locks = 0;
    let released = 0;
    const original = pool.connect;
    pool.connect = async () => ({
      async query(text) {
        const sql = String(text);
        calls.push(sql);
        if (sql.includes('pg_advisory_xact_lock')) {
          locks += 1;
          if (locks < 3) throw pgError('55P03', 'canceling statement due to lock timeout');
        }
        return { rows: [] };
      },
      release() { released += 1; },
    });
    const origExit = process.exit;
    let exited = false;
    process.exit = () => { exited = true; throw new Error('process.exit'); };
    const sleeps = spySleeps();
    try {
      await applyMainSchema();
      sleeps.restore();
      assert.deepEqual(sleeps.delays, [100, 200], 'backoff is 100ms, then 200ms');
      assert.equal(exited, false);
      assert.equal(locks, 3);
      assert.equal(calls.filter((sql) => sql === 'COMMIT').length, 1);
      assert.equal(calls.filter((sql) => sql === 'ROLLBACK').length, 2);
      assert.equal(calls.filter((sql) => sql.length > 1000).length, 1);
      assert.equal(released, 3);
    } finally {
      sleeps.restore();
      process.exit = origExit;
      pool.connect = original;
    }
  });

  it('exits non-zero after three advisory-lock failures and logs only the SQLSTATE', async () => {
    const calls = [];
    let released = 0;
    const original = pool.connect;
    pool.connect = async () => ({
      async query(text) {
        const sql = String(text);
        calls.push(sql);
        if (sql.includes('pg_advisory_xact_lock')) throw pgError('55P03', 'canceling statement due to lock timeout');
        return { rows: [] };
      },
      release() { released += 1; },
    });
    const origExit = process.exit;
    const origError = console.error;
    const logged = [];
    let exitCode = null;
    console.error = (...args) => { logged.push(args.map(String).join(' ')); };
    process.exit = (code) => {
      exitCode = code;
      throw new Error('process.exit');
    };
    const sleeps = spySleeps();
    try {
      await assert.rejects(applyMainSchema(), (err) => err && err.message === 'process.exit');
      sleeps.restore();
      assert.deepEqual(sleeps.delays, [100, 200], 'no pause after the last try');
      assert.equal(exitCode, 1);
      assert.deepEqual(logged, ['55P03']);
      assert.equal(logged.some((line) => /canceling|lock timeout|statement/i.test(line)), false);
      assert.equal(calls.filter((sql) => sql.includes('pg_advisory_xact_lock')).length, 3);
      assert.equal(calls.some((sql) => sql.length > 1000), false);
      assert.equal(calls.includes('COMMIT'), false);
      assert.equal(calls.filter((sql) => sql === 'ROLLBACK').length, 3);
      assert.equal(released, 3);
    } finally {
      sleeps.restore();
      process.exit = origExit;
      console.error = origError;
      pool.connect = original;
    }
  });

  it('does not retry or exit on an advisory-lock error other than 55P03', async () => {
    const cases = [
      [pgError('57014', 'canceling statement due to statement timeout'), (err) => err.code === '57014' && err.message === '57014'],
      [pgError('08006', 'connection failure'), (err) => err.code === '08006' && err.message === 'connection failure'],
    ];
    const original = pool.connect;
    const origExit = process.exit;
    let exited = false;
    process.exit = () => { exited = true; throw new Error('process.exit'); };
    try {
      for (const [lockErr, check] of cases) {
        const calls = [];
        let released = 0;
        pool.connect = async () => ({
          async query(text) {
            const sql = String(text);
            calls.push(sql);
            if (sql.includes('pg_advisory_xact_lock')) throw lockErr;
            return { rows: [] };
          },
          release() { released += 1; },
        });
        const sleeps = spySleeps();
        try {
          await assert.rejects(applyMainSchema(), (err) => {
            assert.notEqual(err.message, 'process.exit', `${lockErr.code} exited`);
            assert.ok(check(err), `${lockErr.code} rethrown as ${err.code} ${err.message}`);
            return true;
          });
        } finally {
          sleeps.restore();
        }
        assert.equal(exited, false, `${lockErr.code} exited`);
        assert.deepEqual(sleeps.delays, [], `${lockErr.code} slept`);
        assert.equal(calls.filter((sql) => sql.includes('pg_advisory_xact_lock')).length, 1, `${lockErr.code} retried`);
        assert.equal(calls.filter((sql) => sql === 'ROLLBACK').length, 1);
        assert.equal(released, 1);
      }
    } finally {
      process.exit = origExit;
      pool.connect = original;
    }
  });
});
