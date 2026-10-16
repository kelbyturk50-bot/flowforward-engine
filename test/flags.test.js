require('./preload');

// Pin the API key and flag env before the db client loads dotenv.
process.env.CRM_API_KEY = 'test-flags-key-must-be-32-characters';
process.env.FF_PILOT_ESTIMATE_RECOVERY = '';
process.env.FF_PILOT_LINK_ON_ONEPAGER = '';
process.env.FF_PILOT_ESTIMATE_SMS = '';
process.env.FF_PROTOTYPE_GALLERY = '';
process.env.FF_CAMPAIGNS = '';
process.env.FF_CAMPAIGN_OPEN_PIXEL = '';
process.env.FF_PROTOTYPE_ON_DRAFT = '';
process.env.FF_PILOT_ESTIMATE_LIVE_SEND = '';
process.env.FF_HIDE_WATERMARK = '';

const { describe, it, before, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const http = require('http');
const path = require('path');
const express = require('express');

const { applySchema } = require('../src/db/migrate');
const { closePool, pool } = require('./fixtures');
const { NAMES } = require('../src/flags/registry');
const { ACTOR, effective } = require('../src/flags/resolve');
const flags = require('../src/pilot/flags');
const kill = require('../src/pilot/kill-switch');

const API_KEY = 'test-flags-key-must-be-32-characters';
const KEY_HEADER = { 'x-api-key': API_KEY };

const FLAG_ENVS = [
  ...NAMES,
  'FF_PILOT_ESTIMATE_LIVE_SEND',
  'FF_HIDE_WATERMARK',
];

let server;

function unsetFlagEnv() {
  for (const name of FLAG_ENVS) delete process.env[name];
}

function request(method, reqPath, { headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const req = http.request({
      method,
      hostname: '127.0.0.1',
      port: server.address().port,
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
        resolve({ status: res.statusCode, text, json });
      });
    });
    req.on('error', reject);
    if (payload) req.end(payload);
    else req.end();
  });
}

async function resetRows() {
  await pool.query('DELETE FROM feature_flag_audit');
  await pool.query(
    `UPDATE feature_flags
        SET enabled = false, updated_at = NULL, updated_by = NULL`
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

describe('feature flags', { concurrency: 1 }, () => {
  before(async () => {
    await applySchema();
    await resetRows();
    unsetFlagEnv();
    const app = express();
    app.use(express.json({ limit: '1mb' }));
    app.use('/api', require('../src/api/auth'));
    app.use('/api/flags', require('../src/api/flags'));
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

  it('flags: fresh DB + unset env => all OFF', async () => {
    unsetFlagEnv();
    await resetRows();
    const listed = await request('GET', '/api/flags', { headers: KEY_HEADER });
    assert.equal(listed.status, 200);
    assert.equal(listed.json.flags.length, NAMES.length);
    for (const flag of listed.json.flags) {
      assert.equal(flag.enabled, false, flag.name);
      assert.equal(flag.effective, false, flag.name);
      assert.equal(flag.env_forced_off, false, flag.name);
      assert.equal(flag.updated_at, null, flag.name);
      assert.equal(flag.updated_by, null, flag.name);
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

  it('flags: seed includes FF_CAMPAIGNS and FF_CAMPAIGN_OPEN_PIXEL, default false', async () => {
    const { rows } = await pool.query(
      `SELECT name, enabled FROM feature_flags ORDER BY name`
    );
    const byName = new Map(rows.map((row) => [row.name, row.enabled]));
    assert.deepEqual([...byName.keys()].sort(), [...NAMES].sort());
    assert.equal(byName.get('FF_CAMPAIGNS'), false);
    assert.equal(byName.get('FF_CAMPAIGN_OPEN_PIXEL'), false);
    assert.equal(byName.get('FF_PROTOTYPE_ON_DRAFT'), false);
    assert.equal(byName.has('FF_PILOT_ESTIMATE_LIVE_SEND'), false);
    assert.equal(byName.has('FF_HIDE_WATERMARK'), false);
  });

  it('flags: env "false" forces OFF when DB true', async () => {
    await pool.query(`UPDATE feature_flags SET enabled = true WHERE name = 'FF_CAMPAIGNS'`);
    for (const value of ['false', 'FALSE', 'False', ' false ', 'false\n']) {
      process.env.FF_CAMPAIGNS = value;
      const view = await effective('FF_CAMPAIGNS');
      assert.equal(view.enabled, true, value);
      assert.equal(view.effective, false, value);
      assert.equal(view.env_forced_off, true, value);
    }
    const stored = await request('PUT', '/api/flags/FF_CAMPAIGNS', {
      headers: KEY_HEADER,
      body: { enabled: true },
    });
    assert.equal(stored.status, 200);
    assert.equal(stored.json.flag.enabled, true);
    assert.equal(stored.json.flag.effective, false);
    assert.equal(stored.json.flag.env_forced_off, true);
    assert.equal(stored.json.flag.updated_by, ACTOR);
    assert.equal(stored.text.includes(API_KEY), false);
    const row = await pool.query(`SELECT enabled, updated_by FROM feature_flags WHERE name = 'FF_CAMPAIGNS'`);
    assert.equal(row.rows[0].enabled, true);
    assert.equal(row.rows[0].updated_by, 'crm');
  });

  it('flags: env unset => DB decides (true and false)', async () => {
    unsetFlagEnv();
    await pool.query(`UPDATE feature_flags SET enabled = true WHERE name = 'FF_PILOT_ESTIMATE_RECOVERY'`);
    let view = await effective('FF_PILOT_ESTIMATE_RECOVERY');
    assert.equal(view.effective, true);
    assert.equal(view.env_forced_off, false);
    assert.equal(await flags.masterOn(), true);

    await pool.query(`UPDATE feature_flags SET enabled = false WHERE name = 'FF_PILOT_ESTIMATE_RECOVERY'`);
    view = await effective('FF_PILOT_ESTIMATE_RECOVERY');
    assert.equal(view.effective, false);
    assert.equal(view.env_forced_off, false);
    assert.equal(await flags.masterOn(), false);

    await pool.query(`UPDATE feature_flags SET enabled = false`);
    process.env.FF_CAMPAIGNS = 'true';
    process.env.FF_CAMPAIGN_OPEN_PIXEL = '1';
    process.env.FF_PROTOTYPE_ON_DRAFT = 'on';
    assert.equal((await effective('FF_CAMPAIGNS')).effective, false);
    assert.equal((await effective('FF_CAMPAIGN_OPEN_PIXEL')).effective, false);
    assert.equal((await effective('FF_PROTOTYPE_ON_DRAFT')).effective, false);

    await pool.query(`UPDATE feature_flags SET enabled = true`);
    for (const value of ['true', 'TRUE', '1', '0', 'off', 'yes', '']) {
      process.env.FF_CAMPAIGNS = value;
      const decided = await effective('FF_CAMPAIGNS');
      assert.equal(decided.env_forced_off, false, value);
      assert.equal(decided.effective, true, value);
    }
  });

  it('flags: DB error => OFF', async () => {
    await pool.query('ALTER TABLE feature_flags RENAME TO feature_flags_hidden');
    try {
      process.env.FF_CAMPAIGNS = 'true';
      const view = await effective('FF_CAMPAIGNS');
      assert.equal(view.enabled, false);
      assert.equal(view.effective, false);
      assert.equal(await flags.masterOn(), false);
      assert.equal(await flags.linkOn(), false);
      assert.equal(await flags.smsOn(), false);
      const listed = await request('GET', '/api/flags', { headers: KEY_HEADER });
      assert.equal(listed.status, 200);
      assert.equal(listed.json.flags.every((flag) => flag.effective === false && flag.enabled === false), true);
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
    assert.equal(stored.rows[0].n, NAMES.length);
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
      const failed = await request('PUT', '/api/flags/FF_CAMPAIGN_OPEN_PIXEL', {
        headers: KEY_HEADER,
        body: { enabled: true },
      });
      assert.equal(failed.status, 500);
      assert.deepEqual(failed.json, { error: 'server_error' });
      assert.equal(failed.text.includes(API_KEY), false);
      const unchanged = await pool.query(
        `SELECT enabled, updated_at, updated_by FROM feature_flags WHERE name = 'FF_CAMPAIGN_OPEN_PIXEL'`
      );
      assert.equal(unchanged.rows[0].enabled, false);
      assert.equal(unchanged.rows[0].updated_at, null);
      assert.equal(unchanged.rows[0].updated_by, null);
      const none = await pool.query('SELECT COUNT(*)::int AS n FROM feature_flag_audit');
      assert.equal(none.rows[0].n, 0);
    } finally {
      await pool.query('DROP TRIGGER IF EXISTS ff_test_flag_audit_fail ON feature_flag_audit');
      await pool.query('DROP FUNCTION IF EXISTS ff_test_flag_audit_fail()');
    }

    const saved = await request('PUT', '/api/flags/FF_CAMPAIGN_OPEN_PIXEL', {
      headers: KEY_HEADER,
      body: { enabled: true },
    });
    assert.equal(saved.status, 200);
    assert.equal(saved.json.flag.name, 'FF_CAMPAIGN_OPEN_PIXEL');
    assert.equal(saved.json.flag.enabled, true);
    assert.equal(saved.json.flag.effective, true);
    assert.equal(saved.json.flag.env_forced_off, false);
    assert.equal(saved.json.flag.updated_by, 'crm');
    assert.match(saved.json.flag.updated_at, /^\d{4}-\d{2}-\d{2}T/);
    assert.deepEqual(Object.keys(saved.json.flag).sort(), [
      'effective', 'enabled', 'env_forced_off', 'name', 'updated_at', 'updated_by',
    ]);
    const audit = await pool.query(
      `SELECT flag, old_value, new_value, actor FROM feature_flag_audit ORDER BY id`
    );
    assert.equal(audit.rows.length, 1);
    assert.deepEqual(audit.rows[0], {
      flag: 'FF_CAMPAIGN_OPEN_PIXEL',
      old_value: false,
      new_value: true,
      actor: 'crm',
    });
    const row = await pool.query(
      `SELECT enabled FROM feature_flags WHERE name = 'FF_CAMPAIGN_OPEN_PIXEL'`
    );
    assert.equal(row.rows[0].enabled, true);
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
    const before = await snapshot();
    console.log(`[flags] before second boot ${JSON.stringify(before)}`);
    await applySchema();
    console.log('[flags] schema boot 2 applied');
    const after = await snapshot();
    console.log(`[flags] after second boot ${JSON.stringify(after)}`);
    assert.deepEqual(after, before);
    const campaigns = after.flags.find((row) => row.name === 'FF_CAMPAIGNS');
    assert.equal(campaigns.enabled, true);
    assert.equal(campaigns.updated_by, 'keeper');
    assert.equal(after.audit.length, 1);
  });
});
