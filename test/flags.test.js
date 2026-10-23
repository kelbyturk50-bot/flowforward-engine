require('./preload');

// Pin the API key and flag env before the db client loads dotenv.
process.env.CRM_API_KEY = 'test-flags-key-must-be-32-characters';
process.env.FF_PILOT_ESTIMATE_RECOVERY = '';
process.env.FF_PILOT_LINK_ON_ONEPAGER = '';
process.env.FF_PILOT_ESTIMATE_SMS = '';
process.env.FF_PROTOTYPE_GALLERY = '';
process.env.FF_LIVE_CHAT_DEMO = '';
process.env.FF_LIVE_CHAT_MODEL = '';
process.env.FF_CAMPAIGNS = '';
process.env.FF_CAMPAIGN_OPEN_PIXEL = '';
process.env.FF_PROTOTYPE_ON_DRAFT = '';
process.env.FF_PILOT_ESTIMATE_LIVE_SEND = '';
process.env.FF_HIDE_WATERMARK = '';

const { describe, it, before, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const path = require('path');
const express = require('express');

const { applySchema } = require('../src/db/migrate');
const { closePool, pool } = require('./fixtures');
const { DB_NAMES, DEFAULT_ON, ENV_NAMES, NAMES } = require('../src/flags/registry');
const { ACTOR, effective } = require('../src/flags/resolve');
const flags = require('../src/pilot/flags');
const kill = require('../src/pilot/kill-switch');

const API_KEY = 'test-flags-key-must-be-32-characters';
const KEY_HEADER = { 'x-api-key': API_KEY };
const FLAG_RESPONSE_KEYS = [
  'effective', 'enabled', 'env_forced_off', 'name', 'source', 'updated_at', 'updated_by', 'writable',
];

const FLAG_ENVS = [
  ...NAMES,
  'FF_PILOT_ESTIMATE_LIVE_SEND',
  'FF_HIDE_WATERMARK',
];

let server;
let resetCalled = false;

function unsetFlagEnv() {
  for (const name of FLAG_ENVS) delete process.env[name];
}

function scrub(text) {
  let out = String(text || '');
  if (process.env.DATABASE_URL) out = out.split(process.env.DATABASE_URL).join('[database]');
  if (API_KEY) out = out.split(API_KEY).join('[key]');
  return out;
}

function request(method, reqPath, { headers = {}, body, port } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const req = http.request({
      method,
      hostname: '127.0.0.1',
      port: port || server.address().port,
      path: reqPath,
      headers: {
        ...(payload ? { 'content-type': 'application/json', 'content-length': String(payload.length) } : {}),
        ...headers,
      },
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch { json = null; }
        resolve({ status: res.statusCode, headers: res.headers, text, json });
      });
    });
    req.on('error', reject);
    if (payload) req.end(payload);
    else req.end();
  });
}

async function resetRows() {
  resetCalled = true;
  await pool.query('DELETE FROM feature_flag_audit');
  await pool.query(
    `DELETE FROM feature_flags WHERE NOT (name = ANY($1::text[]))`,
    [DB_NAMES]
  );
  // Back to the seed: FF_PROTOTYPE_ON_DRAFT on, every other DB flag off.
  // Later test files share this database and expect the seeded values.
  await pool.query(
    `UPDATE feature_flags
        SET enabled = (name = ANY($1::text[])), updated_at = NULL, updated_by = NULL`,
    [DEFAULT_ON]
  );
}

async function snapshot() {
  const flagsRows = await pool.query(
    `SELECT name, enabled, updated_by, updated_at
       FROM feature_flags
      ORDER BY name`
  );
  const auditRows = await pool.query(
    `SELECT flag, old_value, new_value, actor
       FROM feature_flag_audit
      ORDER BY id`
  );
  return {
    flags: flagsRows.rows.map((row) => ({
      name: row.name,
      enabled: row.enabled,
      updated_by: row.updated_by,
      updated_at: row.updated_at ? new Date(row.updated_at).toISOString() : null,
    })),
    audit: auditRows.rows,
  };
}

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = http.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

async function stopChild(child) {
  if (!child || child.exitCode != null) return;
  child.kill('SIGTERM');
  await new Promise((resolve) => {
    const timer = setTimeout(() => {
      if (child.exitCode == null) child.kill('SIGKILL');
      resolve();
    }, 3000);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

async function waitHealth(port, output) {
  const deadline = Date.now() + 20000;
  for (;;) {
    const status = await new Promise((resolve) => {
      const req = http.request({
        method: 'GET', hostname: '127.0.0.1', port, path: '/health',
      }, (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode));
      });
      req.on('error', () => resolve(0));
      req.end();
    });
    if (status === 200) return;
    if (Date.now() > deadline) {
      throw new Error(`server did not listen: ${scrub(output().slice(-1500))}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

// key === undefined leaves CRM_API_KEY unset. Any string, including '', is set.
async function bootRealServer(key) {
  const port = await freePort();
  const env = {
    ...process.env,
    PORT: String(port),
    NODE_ENV: 'test',
    DISABLE_CRON: '1',
    CORS_ORIGINS: '',
  };
  for (const name of FLAG_ENVS) delete env[name];
  if (key === undefined) delete env.CRM_API_KEY;
  else env.CRM_API_KEY = key;
  const child = spawn(process.execPath, [path.join(__dirname, '../src/server.js')], {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (buf) => { output += buf.toString('utf8'); });
  child.stderr.on('data', (buf) => { output += buf.toString('utf8'); });
  try {
    await waitHealth(port, () => output);
  } catch (err) {
    await stopChild(child);
    throw err;
  }
  return {
    port,
    output: () => output,
    async stop() { await stopChild(child); },
  };
}

function preflightHeaders(origin) {
  return {
    origin,
    'access-control-request-method': 'PUT',
    'access-control-request-headers': 'x-api-key,content-type',
  };
}

describe('feature flags', { concurrency: 1 }, () => {
  before(async () => {
    // Boot the schema only. resetRows() must not run before the seed test.
    await applySchema();
    unsetFlagEnv();
    const app = express();
    const flagsApi = require('../src/api/flags');
    app.use(express.json({ limit: '1mb' }));
    app.use('/api/flags', flagsApi.requireFlagApiKey);
    app.use('/api', require('../src/api/auth'));
    app.use('/api/flags', flagsApi);
    server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  });

  after(async () => {
    if (server) await new Promise((resolve) => server.close(resolve));
    await closePool();
  });

  afterEach(async () => {
    unsetFlagEnv();
    await resetRows();
  });

  it('flags: fresh database seed is off except FF_PROTOTYPE_ON_DRAFT, and the enabled default is false before any reset', async () => {
    assert.equal(resetCalled, false);
    const column = await pool.query(
      `SELECT column_default, is_nullable, data_type
         FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'feature_flags'
          AND column_name = 'enabled'`
    );
    assert.equal(column.rows.length, 1);
    assert.equal(column.rows[0].column_default, 'false');
    assert.equal(column.rows[0].is_nullable, 'NO');
    assert.equal(column.rows[0].data_type, 'boolean');
    const expr = await pool.query(
      `SELECT pg_get_expr(d.adbin, d.adrelid) AS expr
         FROM pg_attrdef d
         JOIN pg_attribute a ON a.attrelid = d.adrelid AND a.attnum = d.adnum
         JOIN pg_class c ON c.oid = a.attrelid
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public'
          AND c.relname = 'feature_flags'
          AND a.attname = 'enabled'`
    );
    assert.equal(expr.rows[0].expr, 'false');
    const { rows } = await pool.query(
      `SELECT name, enabled, updated_at, updated_by
         FROM feature_flags
        ORDER BY name`
    );
    assert.deepEqual(rows.map((row) => row.name), [...DB_NAMES].sort());
    assert.deepEqual([...DEFAULT_ON], ['FF_PROTOTYPE_ON_DRAFT']);
    for (const row of rows) {
      assert.equal(row.enabled, DEFAULT_ON.includes(row.name), row.name);
      assert.equal(row.updated_at, null, row.name);
      assert.equal(row.updated_by, null, row.name);
    }
    const liveChatSeed = rows.find((row) => row.name === 'FF_LIVE_CHAT_DEMO');
    assert.ok(liveChatSeed, 'schema seeds FF_LIVE_CHAT_DEMO');
    assert.equal(liveChatSeed.enabled, false);
    const schemaSql = fs.readFileSync(path.join(__dirname, '../src/db/schema.sql'), 'utf8');
    assert.match(schemaSql, /\('FF_LIVE_CHAT_DEMO',\s*false\)/);
    assert.equal(rows.some((row) => row.name === 'FF_PILOT_ESTIMATE_SMS'), false);
    assert.equal(rows.some((row) => row.name === 'FF_CAMPAIGN_OPEN_PIXEL'), false);
    assert.equal(rows.some((row) => row.name === 'FF_PILOT_ESTIMATE_LIVE_SEND'), false);
    const audit = await pool.query('SELECT COUNT(*)::int AS n FROM feature_flag_audit');
    assert.equal(audit.rows[0].n, 0);
    console.log(`[flags] fresh seed rows=${rows.length} enabled=${rows.filter((row) => row.enabled).map((row) => row.name).join(',')} column_default=false`);
  });

  it('flags: fresh DB + unset env => all OFF except FF_PROTOTYPE_ON_DRAFT', async () => {
    unsetFlagEnv();
    const listed = await request('GET', '/api/flags', { headers: KEY_HEADER });
    assert.equal(listed.status, 200);
    assert.equal(listed.json.flags.length, NAMES.length);
    assert.deepEqual(listed.json.flags.map((flag) => flag.name), [...NAMES]);
    for (const flag of listed.json.flags) {
      const seededOn = DEFAULT_ON.includes(flag.name);
      assert.equal(flag.enabled, seededOn, flag.name);
      assert.equal(flag.effective, seededOn, flag.name);
      assert.equal(flag.env_forced_off, false, flag.name);
      assert.equal(flag.updated_at, null, flag.name);
      assert.equal(flag.updated_by, null, flag.name);
      assert.deepEqual(Object.keys(flag).sort(), FLAG_RESPONSE_KEYS);
      if (ENV_NAMES.includes(flag.name)) {
        assert.equal(flag.writable, false, flag.name);
        assert.equal(flag.source, 'env', flag.name);
      } else {
        assert.equal(flag.writable, true, flag.name);
        assert.equal(flag.source, 'db', flag.name);
      }
    }
    assert.deepEqual(await flags.flags(), {
      FF_PILOT_ESTIMATE_RECOVERY: false,
      FF_PILOT_LINK_ON_ONEPAGER: false,
      FF_PILOT_ESTIMATE_SMS: false,
    });
    assert.equal(await flags.masterOn(), false);
    assert.equal(await flags.linkOn(), false);
    assert.equal(await flags.smsOn(), false);
  });

  it('flags: FF_PROTOTYPE_ON_DRAFT is on by default, follows the row, and env false/off/0/no forces it off', async () => {
    const { prototypeOnDraft } = require('../src/prototypes/flags');
    unsetFlagEnv();
    assert.equal(await prototypeOnDraft(), true);
    for (const value of ['false', ' OFF ', '0', 'No']) {
      process.env.FF_PROTOTYPE_ON_DRAFT = value;
      assert.equal(await prototypeOnDraft(), false, value);
    }
    for (const value of ['true', '1', 'yes', '', '  ']) {
      process.env.FF_PROTOTYPE_ON_DRAFT = value;
      assert.equal(await prototypeOnDraft(), true, JSON.stringify(value));
    }
    unsetFlagEnv();
    const off = await request('PUT', '/api/flags/FF_PROTOTYPE_ON_DRAFT', {
      headers: KEY_HEADER,
      body: { enabled: false },
    });
    assert.equal(off.status, 200);
    assert.equal(off.json.flag.effective, false);
    assert.equal(await prototypeOnDraft(), false);
    process.env.FF_PROTOTYPE_ON_DRAFT = 'true';
    assert.equal(await prototypeOnDraft(), false, 'env never forces it on');
    unsetFlagEnv();
    const on = await request('PUT', '/api/flags/FF_PROTOTYPE_ON_DRAFT', {
      headers: KEY_HEADER,
      body: { enabled: true },
    });
    assert.equal(on.status, 200);
    assert.equal(await prototypeOnDraft(), true);
    try {
      await pool.query(`DELETE FROM feature_flags WHERE name = 'FF_PROTOTYPE_ON_DRAFT'`);
      assert.equal(await prototypeOnDraft(), false, 'a missing row is off');
    } finally {
      await pool.query(
        `INSERT INTO feature_flags (name, enabled) VALUES ('FF_PROTOTYPE_ON_DRAFT', true)
         ON CONFLICT (name) DO NOTHING`
      );
    }
    console.log('[flags] FF_PROTOTYPE_ON_DRAFT default=on row-off=off env-off=off env-true-row-off=off missing-row=off');
  });

  it('flags: trimmed false, off, 0, and no force OFF when the row is true', async () => {
    await pool.query(`UPDATE feature_flags SET enabled = true WHERE name = 'FF_CAMPAIGNS'`);
    const values = [
      'false', 'FALSE', 'False', ' false ', 'false\n',
      'off', 'OFF', ' off ',
      '0', ' 0 ',
      'no', 'NO', ' No ',
    ];
    for (const value of values) {
      process.env.FF_CAMPAIGNS = value;
      const view = await effective('FF_CAMPAIGNS');
      assert.equal(view.enabled, true, value);
      assert.equal(view.effective, false, value);
      assert.equal(view.env_forced_off, true, value);
      assert.equal(view.writable, true, value);
      assert.equal(view.source, 'db', value);
    }
    for (const value of ['falsehood', 'offset', '10', 'nobody', 'nope', 'disabled', 'n', 'f']) {
      process.env.FF_CAMPAIGNS = value;
      const view = await effective('FF_CAMPAIGNS');
      assert.equal(view.env_forced_off, false, value);
      assert.equal(view.effective, true, value);
      assert.equal(view.enabled, true, value);
    }
    process.env.FF_CAMPAIGNS = ' OFF ';
    const stored = await request('PUT', '/api/flags/FF_CAMPAIGNS', {
      headers: KEY_HEADER,
      body: { enabled: true },
    });
    assert.equal(stored.status, 200);
    assert.equal(stored.json.flag.enabled, true);
    assert.equal(stored.json.flag.effective, false);
    assert.equal(stored.json.flag.env_forced_off, true);
    assert.equal(stored.json.flag.writable, true);
    assert.equal(stored.json.flag.source, 'db');
    assert.equal(stored.json.flag.updated_by, ACTOR);
    assert.equal(stored.text.includes(API_KEY), false);
    const row = await pool.query(`SELECT enabled, updated_by FROM feature_flags WHERE name = 'FF_CAMPAIGNS'`);
    assert.equal(row.rows[0].enabled, true);
    assert.equal(row.rows[0].updated_by, 'crm');
  });

  it('flags: empty string and unset env let the database decide', async () => {
    await pool.query(`UPDATE feature_flags SET enabled = true WHERE name = 'FF_PILOT_ESTIMATE_RECOVERY'`);
    delete process.env.FF_PILOT_ESTIMATE_RECOVERY;
    let view = await effective('FF_PILOT_ESTIMATE_RECOVERY');
    assert.equal(view.effective, true);
    assert.equal(view.env_forced_off, false);
    assert.equal(view.source, 'db');
    assert.equal(await flags.masterOn(), true);

    for (const value of ['', '   ', '\n', '\t']) {
      process.env.FF_PILOT_ESTIMATE_RECOVERY = value;
      view = await effective('FF_PILOT_ESTIMATE_RECOVERY');
      assert.equal(view.env_forced_off, false, JSON.stringify(value));
      assert.equal(view.effective, true, JSON.stringify(value));
    }

    await pool.query(`UPDATE feature_flags SET enabled = false WHERE name = 'FF_PILOT_ESTIMATE_RECOVERY'`);
    delete process.env.FF_PILOT_ESTIMATE_RECOVERY;
    view = await effective('FF_PILOT_ESTIMATE_RECOVERY');
    assert.equal(view.effective, false);
    assert.equal(view.env_forced_off, false);
    assert.equal(await flags.masterOn(), false);

    await pool.query(`UPDATE feature_flags SET enabled = false WHERE name = 'FF_CAMPAIGNS'`);
    for (const value of ['true', 'TRUE', '1', 'yes', 'on']) {
      process.env.FF_CAMPAIGNS = value;
      const decided = await effective('FF_CAMPAIGNS');
      assert.equal(decided.env_forced_off, false, value);
      assert.equal(decided.effective, false, value);
      assert.equal(decided.enabled, false, value);
    }

    await pool.query(`UPDATE feature_flags SET enabled = true WHERE name = 'FF_CAMPAIGNS'`);
    for (const value of ['true', 'TRUE', '1', 'yes', 'on', '', '   ']) {
      process.env.FF_CAMPAIGNS = value;
      const decided = await effective('FF_CAMPAIGNS');
      assert.equal(decided.env_forced_off, false, JSON.stringify(value));
      assert.equal(decided.effective, true, JSON.stringify(value));
    }
    delete process.env.FF_CAMPAIGNS;
    const unset = await effective('FF_CAMPAIGNS');
    assert.equal(unset.env_forced_off, false);
    assert.equal(unset.effective, true);
  });

  it('flags: DB error => database flags OFF, env-only flags still follow env', async () => {
    await pool.query('ALTER TABLE feature_flags RENAME TO feature_flags_hidden');
    try {
      process.env.FF_CAMPAIGNS = 'true';
      process.env.FF_PILOT_ESTIMATE_SMS = 'true';
      const view = await effective('FF_CAMPAIGNS');
      assert.equal(view.enabled, false);
      assert.equal(view.effective, false);
      assert.equal(view.source, 'db');
      const sms = await effective('FF_PILOT_ESTIMATE_SMS');
      assert.equal(sms.effective, true);
      assert.equal(sms.source, 'env');
      assert.equal(sms.writable, false);
      assert.equal(await flags.masterOn(), false);
      assert.equal(await flags.linkOn(), false);
      assert.equal(await flags.smsOn(), true);
      const listed = await request('GET', '/api/flags', { headers: KEY_HEADER });
      assert.equal(listed.status, 200);
      for (const flag of listed.json.flags) {
        if (flag.name === 'FF_PILOT_ESTIMATE_SMS') {
          assert.equal(flag.effective, true);
          assert.equal(flag.source, 'env');
        } else if (flag.source === 'db') {
          assert.equal(flag.effective, false, flag.name);
          assert.equal(flag.enabled, false, flag.name);
        } else {
          assert.equal(flag.effective, false, flag.name);
          assert.equal(flag.source, 'env', flag.name);
        }
      }
    } finally {
      await pool.query('ALTER TABLE feature_flags_hidden RENAME TO feature_flags');
    }
  });

  it('flags: missing row => OFF', async () => {
    await pool.query(`DELETE FROM feature_flags WHERE name = 'FF_PROTOTYPE_GALLERY'`);
    try {
      const view = await effective('FF_PROTOTYPE_GALLERY');
      assert.equal(view.enabled, false);
      assert.equal(view.effective, false);
      assert.equal(view.env_forced_off, false);
      assert.equal(view.writable, true);
      assert.equal(view.source, 'db');
    } finally {
      await pool.query(
        `INSERT INTO feature_flags (name, enabled) VALUES ('FF_PROTOTYPE_GALLERY', false)
         ON CONFLICT (name) DO NOTHING`
      );
    }
  });

  it('flags: GET/PUT without key => 401', async () => {
    const getMissing = await request('GET', '/api/flags');
    assert.equal(getMissing.status, 401);
    assert.deepEqual(getMissing.json, { error: 'Missing or invalid API key' });
    const putMissing = await request('PUT', '/api/flags/FF_CAMPAIGNS', { body: { enabled: true } });
    assert.equal(putMissing.status, 401);
    assert.deepEqual(putMissing.json, { error: 'Missing or invalid API key' });
    const putWrong = await request('PUT', '/api/flags/FF_CAMPAIGNS', {
      headers: { 'x-api-key': 'wrong-key-wrong-key-wrong-key-xxxx' },
      body: { enabled: true },
    });
    assert.equal(putWrong.status, 401);
    const row = await pool.query(`SELECT enabled FROM feature_flags WHERE name = 'FF_CAMPAIGNS'`);
    assert.equal(row.rows[0].enabled, false);
    const audit = await pool.query('SELECT COUNT(*)::int AS n FROM feature_flag_audit');
    assert.equal(audit.rows[0].n, 0);
  });

  it('flags: PUT unknown name => 400; PUT FF_PILOT_ESTIMATE_LIVE_SEND => 400; not listed in GET', async () => {
    assert.equal(NAMES.includes('FF_PILOT_ESTIMATE_LIVE_SEND'), false);
    assert.equal(DB_NAMES.includes('FF_PILOT_ESTIMATE_LIVE_SEND'), false);
    assert.equal(ENV_NAMES.includes('FF_PILOT_ESTIMATE_LIVE_SEND'), false);
    assert.equal(ENV_NAMES.includes('FF_PILOT_ESTIMATE_SMS'), true);
    assert.equal(ENV_NAMES.includes('FF_CAMPAIGN_OPEN_PIXEL'), true);
    assert.equal(DB_NAMES.includes('FF_PILOT_ESTIMATE_SMS'), false);
    assert.equal(DB_NAMES.includes('FF_CAMPAIGN_OPEN_PIXEL'), false);
    for (const name of ['FF_NOT_A_FLAG', 'FF_PILOT_ESTIMATE_LIVE_SEND', 'FF_HIDE_WATERMARK', 'ff_campaigns']) {
      const rejected = await request('PUT', `/api/flags/${encodeURIComponent(name)}`, {
        headers: KEY_HEADER,
        body: { enabled: true },
      });
      assert.equal(rejected.status, 400, name);
      assert.deepEqual(rejected.json, { error: 'unknown_flag' });
    }
    const listed = await request('GET', '/api/flags', { headers: KEY_HEADER });
    assert.equal(listed.status, 200);
    const names = listed.json.flags.map((flag) => flag.name);
    assert.deepEqual(names, [...NAMES]);
    assert.equal(names.includes('FF_PILOT_ESTIMATE_LIVE_SEND'), false);
    assert.equal(names.includes('FF_HIDE_WATERMARK'), false);
    const stored = await pool.query('SELECT COUNT(*)::int AS n FROM feature_flags');
    assert.equal(stored.rows[0].n, DB_NAMES.length);
    const killSrc = fs.readFileSync(path.join(__dirname, '../src/pilot/kill-switch.js'), 'utf8');
    assert.equal(killSrc.includes('feature_flags'), false);
    assert.equal(killSrc.includes("!== 'true'"), true);
    assert.equal(kill.globalSendKilled(), true);
    process.env.FF_PILOT_ESTIMATE_LIVE_SEND = 'true';
    assert.equal(kill.globalSendKilled(), false);
  });

  it('flags: PUT invalid body => 400', async () => {
    for (const body of [{}, { enabled: 'true' }, { enabled: 1 }, { enabled: null }, { enabled: 0 }]) {
      const rejected = await request('PUT', '/api/flags/FF_CAMPAIGNS', {
        headers: KEY_HEADER,
        body,
      });
      assert.equal(rejected.status, 400);
      assert.deepEqual(rejected.json, { error: 'invalid_body' });
    }
    const row = await pool.query(`SELECT enabled FROM feature_flags WHERE name = 'FF_CAMPAIGNS'`);
    assert.equal(row.rows[0].enabled, false);
  });

  it('flags: SMS and open pixel are env-only and PUT returns flag_not_writable', async () => {
    await pool.query(
      `INSERT INTO feature_flags (name, enabled)
       VALUES ('FF_PILOT_ESTIMATE_SMS', true), ('FF_CAMPAIGN_OPEN_PIXEL', true), ('FF_LIVE_CHAT_MODEL', true)`
    );
    try {
      for (const name of ENV_NAMES) {
        delete process.env[name];
        let view = await effective(name);
        assert.equal(view.effective, false, name);
        assert.equal(view.enabled, false, name);
        assert.equal(view.writable, false, name);
        assert.equal(view.source, 'env', name);
        assert.equal(view.env_forced_off, false, name);
        assert.equal(view.updated_at, null, name);
        assert.equal(view.updated_by, null, name);
        for (const value of ['TRUE', 'True', ' true', 'true ', '1', 'yes', 'false', 'off', '0', 'no', '']) {
          process.env[name] = value;
          view = await effective(name);
          assert.equal(view.effective, false, `${name} ${JSON.stringify(value)}`);
          assert.equal(view.enabled, false, `${name} ${JSON.stringify(value)}`);
          assert.equal(view.source, 'env', name);
          assert.equal(view.writable, false, name);
        }
        process.env[name] = 'true';
        view = await effective(name);
        assert.equal(view.effective, true, name);
        assert.equal(view.enabled, true, name);
        assert.equal(view.env_forced_off, false, name);
        const rejected = await request('PUT', `/api/flags/${name}`, {
          headers: KEY_HEADER,
          body: { enabled: false },
        });
        assert.equal(rejected.status, 400, name);
        assert.deepEqual(rejected.json, { error: 'flag_not_writable' });
        const row = await pool.query(
          `SELECT enabled FROM feature_flags WHERE name = $1`,
          [name]
        );
        assert.equal(row.rows[0].enabled, true, name);
      }
      assert.equal(await flags.smsOn(), true);
      const audit = await pool.query('SELECT COUNT(*)::int AS n FROM feature_flag_audit');
      assert.equal(audit.rows[0].n, 0);
      const listed = await request('GET', '/api/flags', { headers: KEY_HEADER });
      assert.equal(listed.status, 200);
      for (const flag of listed.json.flags) {
        if (ENV_NAMES.includes(flag.name)) {
          assert.equal(flag.writable, false, flag.name);
          assert.equal(flag.source, 'env', flag.name);
          assert.equal(flag.effective, true, flag.name);
        } else {
          assert.equal(flag.writable, true, flag.name);
          assert.equal(flag.source, 'db', flag.name);
        }
      }
    } finally {
      await pool.query(`DELETE FROM feature_flags WHERE name = ANY($1::text[])`, [ENV_NAMES]);
    }
  });

  it('flags: PUT writes exactly one audit row in same txn (rollback on audit failure leaves flag unchanged)', async () => {
    await pool.query(`
      CREATE OR REPLACE FUNCTION ff_test_flag_audit_fail() RETURNS trigger AS $fn$
      BEGIN
        RAISE EXCEPTION 'audit insert failed';
      END
      $fn$ LANGUAGE plpgsql;
      CREATE TRIGGER ff_test_flag_audit_fail
        BEFORE INSERT ON feature_flag_audit
        FOR EACH ROW EXECUTE FUNCTION ff_test_flag_audit_fail();
    `);
    try {
      const failed = await request('PUT', '/api/flags/FF_PROTOTYPE_ON_DRAFT', {
        headers: KEY_HEADER,
        body: { enabled: false },
      });
      assert.equal(failed.status, 500);
      assert.deepEqual(failed.json, { error: 'server_error' });
      assert.equal(failed.text.includes(API_KEY), false);
      const unchanged = await pool.query(
        `SELECT enabled, updated_at, updated_by FROM feature_flags WHERE name = 'FF_PROTOTYPE_ON_DRAFT'`
      );
      assert.equal(unchanged.rows[0].enabled, true);
      assert.equal(unchanged.rows[0].updated_at, null);
      assert.equal(unchanged.rows[0].updated_by, null);
      const none = await pool.query('SELECT COUNT(*)::int AS n FROM feature_flag_audit');
      assert.equal(none.rows[0].n, 0);
    } finally {
      await pool.query('DROP TRIGGER IF EXISTS ff_test_flag_audit_fail ON feature_flag_audit');
      await pool.query('DROP FUNCTION IF EXISTS ff_test_flag_audit_fail()');
    }

    const saved = await request('PUT', '/api/flags/FF_PROTOTYPE_ON_DRAFT', {
      headers: KEY_HEADER,
      body: { enabled: false },
    });
    assert.equal(saved.status, 200);
    assert.equal(saved.json.flag.name, 'FF_PROTOTYPE_ON_DRAFT');
    assert.equal(saved.json.flag.enabled, false);
    assert.equal(saved.json.flag.effective, false);
    assert.equal(saved.json.flag.env_forced_off, false);
    assert.equal(saved.json.flag.writable, true);
    assert.equal(saved.json.flag.source, 'db');
    assert.equal(saved.json.flag.updated_by, 'crm');
    assert.match(saved.json.flag.updated_at, /^\d{4}-\d{2}-\d{2}T/);
    assert.deepEqual(Object.keys(saved.json.flag).sort(), FLAG_RESPONSE_KEYS);
    const audit = await pool.query(
      `SELECT flag, old_value, new_value, actor FROM feature_flag_audit ORDER BY id`
    );
    assert.equal(audit.rows.length, 1);
    assert.deepEqual(audit.rows[0], {
      flag: 'FF_PROTOTYPE_ON_DRAFT',
      old_value: true,
      new_value: false,
      actor: 'crm',
    });
    const row = await pool.query(
      `SELECT enabled FROM feature_flags WHERE name = 'FF_PROTOTYPE_ON_DRAFT'`
    );
    assert.equal(row.rows[0].enabled, false);
    console.log(`[flags] audit ok actor=${audit.rows[0].actor} old=${audit.rows[0].old_value} new=${audit.rows[0].new_value}`);
  });

  it('flags: schema applied twice => no error, seeded rows not flipped', async () => {
    await applySchema();
    console.log('[flags] schema boot 1 applied');
    await pool.query(
      `UPDATE feature_flags
          SET enabled = true, updated_at = '2026-01-02T03:04:05.000Z', updated_by = 'keeper'
        WHERE name = 'FF_CAMPAIGNS'`
    );
    await pool.query(
      `INSERT INTO feature_flag_audit (flag, old_value, new_value, actor)
       VALUES ('FF_CAMPAIGNS', false, true, 'keeper')`
    );
    const beforeRows = await snapshot();
    console.log(`[flags] before second boot ${JSON.stringify(beforeRows)}`);
    await applySchema();
    console.log('[flags] schema boot 2 applied');
    const afterRows = await snapshot();
    console.log(`[flags] after second boot ${JSON.stringify(afterRows)}`);
    assert.deepEqual(afterRows, beforeRows);
    const campaigns = afterRows.flags.find((row) => row.name === 'FF_CAMPAIGNS');
    assert.equal(campaigns.enabled, true);
    assert.equal(campaigns.updated_by, 'keeper');
    assert.equal(afterRows.audit.length, 1);
    assert.equal(afterRows.flags.length, DB_NAMES.length);
  });

  it('flags: real server.js GET and PUT stay behind auth and a CORS preflight does not bypass them', async () => {
    const serverSrc = fs.readFileSync(path.join(__dirname, '../src/server.js'), 'utf8');
    const authSrc = fs.readFileSync(path.join(__dirname, '../src/api/auth.js'), 'utf8');
    const guardAt = serverSrc.indexOf('flagsApi.requireFlagApiKey');
    const authAt = serverSrc.indexOf("app.use('/api', requireApiKey)");
    const routerAt = serverSrc.indexOf('flagsApi);');
    assert.ok(guardAt !== -1 && authAt > guardAt);
    assert.ok(routerAt > authAt);
    assert.equal(authSrc.includes('api_key_not_configured'), true);
    assert.equal(authSrc.includes('503'), true);
    const app = await bootRealServer(API_KEY);
    try {
      assert.equal(app.output().includes(API_KEY), false);
      const beforeRows = await snapshot();
      const origins = ['https://evil.example', 'https://not-flowforward.example'];
      const getMissing = await request('GET', '/api/flags', { port: app.port });
      assert.equal(getMissing.status, 401);
      assert.deepEqual(getMissing.json, { error: 'Missing or invalid API key' });
      const putMissing = await request('PUT', '/api/flags/FF_CAMPAIGNS', {
        port: app.port,
        body: { enabled: true },
      });
      assert.equal(putMissing.status, 401);
      assert.deepEqual(putMissing.json, { error: 'Missing or invalid API key' });
      assert.deepEqual(await snapshot(), beforeRows);
      for (const origin of origins) {
        const preflight = await request('OPTIONS', '/api/flags/FF_CAMPAIGNS', {
          port: app.port,
          headers: preflightHeaders(origin),
        });
        assert.equal(preflight.status, 204, origin);
        assert.equal(preflight.headers['access-control-allow-origin'], '*', origin);
        assert.match(String(preflight.headers['access-control-allow-methods'] || ''), /PUT/);
        assert.equal(preflight.text, '', origin);
        assert.deepEqual(await snapshot(), beforeRows, origin);
        const putFromOrigin = await request('PUT', '/api/flags/FF_CAMPAIGNS', {
          port: app.port,
          headers: {
            origin,
            'access-control-request-method': 'PUT',
          },
          body: { enabled: true },
        });
        assert.equal(putFromOrigin.status, 401, origin);
        assert.deepEqual(putFromOrigin.json, { error: 'Missing or invalid API key' });
        assert.equal(putFromOrigin.headers['access-control-allow-origin'], '*', origin);
        assert.deepEqual(await snapshot(), beforeRows, origin);
      }
      const putWrong = await request('PUT', '/api/flags/FF_CAMPAIGNS', {
        port: app.port,
        headers: { origin: origins[0], 'x-api-key': 'wrong-key-wrong-key-wrong-key-xxxx' },
        body: { enabled: true },
      });
      assert.equal(putWrong.status, 401);
      assert.deepEqual(await snapshot(), beforeRows);
      const listed = await request('GET', '/api/flags', {
        port: app.port,
        headers: KEY_HEADER,
      });
      assert.equal(listed.status, 200);
      assert.deepEqual(listed.json.flags.map((flag) => flag.name), [...NAMES]);
      const saved = await request('PUT', '/api/flags/FF_CAMPAIGNS', {
        port: app.port,
        headers: { ...KEY_HEADER, origin: origins[0] },
        body: { enabled: true },
      });
      assert.equal(saved.status, 200);
      assert.equal(saved.json.flag.enabled, true);
      assert.equal(saved.json.flag.effective, true);
      assert.equal(saved.json.flag.writable, true);
      assert.equal(saved.json.flag.source, 'db');
      assert.equal(saved.json.flag.updated_by, 'crm');
      const row = await pool.query(`SELECT enabled, updated_by FROM feature_flags WHERE name = 'FF_CAMPAIGNS'`);
      assert.equal(row.rows[0].enabled, true);
      assert.equal(row.rows[0].updated_by, 'crm');
      const audit = await pool.query('SELECT COUNT(*)::int AS n FROM feature_flag_audit');
      assert.equal(audit.rows[0].n, 1);
      const sms = await request('PUT', '/api/flags/FF_PILOT_ESTIMATE_SMS', {
        port: app.port,
        headers: KEY_HEADER,
        body: { enabled: true },
      });
      assert.equal(sms.status, 400);
      assert.deepEqual(sms.json, { error: 'flag_not_writable' });
      console.log('[flags] real server auth held; CORS preflight did not write');
    } finally {
      await app.stop();
    }
  });

  it('flags: real server.js GET and PUT return 503 api_key_not_configured for an unset, empty, spaces-only, short, or inner-space key', { timeout: 120000 }, async () => {
    const innerSpaces = `${'d'.repeat(8)}${' '.repeat(16)}${'d'.repeat(9)}`;
    assert.equal(innerSpaces.length, 33);
    assert.equal(innerSpaces.trim().length, 33);
    assert.equal(innerSpaces.replace(/\s/g, '').length, 17);
    const cases = [
      { label: 'unset', key: undefined },
      { label: 'empty', key: '' },
      { label: 'short', key: 'a'.repeat(31) },
      { label: 'spaces', key: ' '.repeat(32) },
      { label: 'padded', key: `${'b'.repeat(31)} ` },
      { label: 'inner-spaces', key: innerSpaces },
    ];
    for (const item of cases) {
      const app = await bootRealServer(item.key);
      try {
        const beforeRows = await snapshot();
        const origin = 'https://evil.example';
        const preflight = await request('OPTIONS', '/api/flags/FF_PROTOTYPE_GALLERY', {
          port: app.port,
          headers: preflightHeaders(origin),
        });
        assert.equal(preflight.status, 204, item.label);
        assert.equal(preflight.headers['access-control-allow-origin'], '*', item.label);
        assert.deepEqual(await snapshot(), beforeRows, item.label);
        const withKey = item.key ? { 'x-api-key': item.key } : {};
        for (const method of ['PUT', 'GET']) {
          const authed = await request(method, method === 'GET' ? '/api/flags' : '/api/flags/FF_PROTOTYPE_GALLERY', {
            port: app.port,
            headers: { origin, ...withKey },
            body: method === 'PUT' ? { enabled: true } : undefined,
          });
          assert.equal(authed.status, 503, `${item.label} ${method} with key`);
          assert.deepEqual(authed.json, { error: 'api_key_not_configured' });
          assert.equal(authed.headers['access-control-allow-origin'], '*', item.label);
          const bare = await request(method, method === 'GET' ? '/api/flags' : '/api/flags/FF_PROTOTYPE_GALLERY', {
            port: app.port,
            headers: { origin: 'https://not-flowforward.example' },
            body: method === 'PUT' ? { enabled: true } : undefined,
          });
          assert.equal(bare.status, 503, `${item.label} ${method} without key`);
          assert.deepEqual(bare.json, { error: 'api_key_not_configured' });
        }
        assert.equal(app.output().includes('[flags] refused; api key not configured'), true, item.label);
        if (item.key && item.key.trim()) assert.equal(app.output().includes(item.key), false, item.label);
        assert.equal(app.output().includes(API_KEY), false, item.label);
        assert.deepEqual(await snapshot(), beforeRows, item.label);
        const fixturesBare = await request('GET', '/api/brands/fixtures', { port: app.port });
        assert.equal(fixturesBare.status, 503, `${item.label} fixtures`);
        assert.deepEqual(fixturesBare.json, { error: 'api_key_not_configured' });
        const fixturesAuthed = await request('GET', '/api/brands/fixtures', {
          port: app.port,
          headers: withKey,
        });
        assert.equal(fixturesAuthed.status, 503, `${item.label} fixtures with key`);
        assert.deepEqual(fixturesAuthed.json, { error: 'api_key_not_configured' });
        assert.deepEqual(await snapshot(), beforeRows, item.label);
        console.log(`[flags] real server GET/PUT 503 api_key_not_configured key=${item.label}`);
      } finally {
        await app.stop();
      }
    }
  });
});
