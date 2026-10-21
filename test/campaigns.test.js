process.env.CRM_API_KEY = 'test-campaigns-key-not-a-secret-0001';
delete process.env.FF_CAMPAIGNS;

const { describe, it, before, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const path = require('path');
const express = require('express');

const { applySchema } = require('../src/db/migrate');
const { resetDb, closePool, pool, insertProspect } = require('./fixtures');
const { attributeConversion } = require('../src/campaigns/attribution');

const API_KEY = 'test-campaigns-key-not-a-secret-0001';
const OPEN_LABEL = 'Approximate, unreliable (Apple MPP)';
const DAY_MS = 24 * 60 * 60 * 1000;
const DAY0 = Date.parse('2026-09-24T16:00:00.000Z');

let server;
let fixture;

function atDay(day) {
  return new Date(DAY0 + day * DAY_MS).toISOString();
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
        resolve({ status: res.statusCode, headers: res.headers, text, json });
      });
    });
    req.on('error', reject);
    if (payload) req.end(payload);
    else req.end();
  });
}

function authHeaders() {
  return { 'x-api-key': API_KEY };
}

// FF_CAMPAIGNS is a feature_flags row (#63). Env can only force it off.
async function campaignsFlag(on) {
  const res = await pool.query(
    `UPDATE feature_flags SET enabled = $1 WHERE name = 'FF_CAMPAIGNS'`,
    [on === true]
  );
  assert.equal(res.rowCount, 1);
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

function rawGet(port, reqPath, headers = {}) {
  return new Promise((resolve) => {
    const req = http.request({ method: 'GET', hostname: '127.0.0.1', port, path: reqPath, headers }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch { json = null; }
        resolve({ status: res.statusCode, text, json, headers: res.headers });
      });
    });
    req.on('error', () => resolve({ status: 0, text: '', json: null, headers: {} }));
    req.end();
  });
}

// Boots the real src/server.js (the production mount order) against this
// test database. key === undefined leaves CRM_API_KEY unset.
async function bootRealServer(key) {
  const port = await freePort();
  const env = { ...process.env, PORT: String(port), NODE_ENV: 'test', DISABLE_CRON: '1', CORS_ORIGINS: '' };
  delete env.FF_CAMPAIGNS;
  if (key === undefined) delete env.CRM_API_KEY;
  else env.CRM_API_KEY = key;
  const child = spawn(process.execPath, [path.join(__dirname, '../src/server.js')], {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (buf) => { output += buf.toString('utf8'); });
  child.stderr.on('data', (buf) => { output += buf.toString('utf8'); });
  const deadline = Date.now() + 20000;
  for (;;) {
    const health = await rawGet(port, '/health');
    if (health.status === 200) break;
    if (Date.now() > deadline) {
      await stopChild(child);
      throw new Error('server did not listen');
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return { port, output: () => output, stop: () => stopChild(child) };
}

function metricsPath(query) {
  return `/api/campaigns/metrics${query || ''}`;
}

function normalize404(text) {
  return text.replace(/Cannot [A-Z]+ \S+/, 'Cannot METHOD /PATH');
}

async function insertCampaign({ name, channel, segment, offerHook, startDate, status, costCents }) {
  const { rows } = await pool.query(
    `INSERT INTO campaigns
       (name, channel, segment, offer_hook, start_date, status, cost_cents, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,'test')
     RETURNING id`,
    [name, channel, segment || null, offerHook || null, startDate || null, status || 'active', costCents ?? null]
  );
  return rows[0].id;
}

async function insertVariant(campaignId, label, hook) {
  const { rows } = await pool.query(
    `INSERT INTO campaign_variants (campaign_id, label, hook_summary)
     VALUES ($1,$2,$3)
     RETURNING id`,
    [campaignId, label, hook || null]
  );
  return rows[0].id;
}

async function insertTouch({
  leadId, campaignId, variantId, type, day, occurredAt, channel, source, machineOpen, revenueCents,
}) {
  const { rows } = await pool.query(
    `INSERT INTO campaign_touches
       (lead_id, campaign_id, variant_id, type, channel, occurred_at, source, machine_open, revenue_cents)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     RETURNING id, occurred_at, channel`,
    [
      leadId,
      campaignId,
      variantId ?? null,
      type,
      channel === undefined ? 'email' : channel,
      occurredAt || atDay(day || 0),
      source || 'manual',
      machineOpen === true,
      revenueCents ?? null,
    ]
  );
  return rows[0];
}

async function enroll(leadId, campaignId, variantId, day = 0) {
  await pool.query(
    `INSERT INTO campaign_leads (lead_id, campaign_id, variant_id, enrolled_at)
     VALUES ($1,$2,$3,$4)`,
    [leadId, campaignId, variantId, atDay(day)]
  );
}

async function seedFixture() {
  const hvacId = await insertCampaign({
    name: 'TEST:HVAC-Oct',
    channel: 'email',
    segment: 'hvac',
    offerHook: 'fall tune-up',
    startDate: '2026-09-24',
    status: 'active',
    costCents: 6000,
  });
  const protoId = await insertCampaign({
    name: 'TEST:Proto-Oct',
    channel: 'prototype_link',
    segment: 'hvac',
    status: 'active',
  });
  const variantA = await insertVariant(hvacId, 'A', 'tune-up');
  const variantB = await insertVariant(hvacId, 'B', 'replacement');
  const leads = [];
  for (let n = 1; n <= 8; n += 1) {
    const lead = await insertProspect({
      google_place_id: `test-campaign-hvac-l${n}`,
      company: `TEST: HVAC-Oct L${n}`,
      email: `test+hvac-oct-l${n}@example.com`,
      phone: `(801) 555-01${String(n).padStart(2, '0')}`,
      industry: 'HVAC',
    });
    const variantId = n <= 4 ? variantA : variantB;
    await enroll(lead.id, hvacId, variantId);
    await insertTouch({
      leadId: lead.id, campaignId: hvacId, variantId, type: 'sent', day: 0, channel: 'email',
    });
    leads.push({ ...lead, variantId });
  }
  const variantOf = (n) => leads[n - 1].variantId;
  await insertTouch({ leadId: leads[0].id, campaignId: hvacId, variantId: variantOf(1), type: 'replied', day: 2 });
  await insertTouch({ leadId: leads[1].id, campaignId: hvacId, variantId: variantOf(2), type: 'replied', day: 4 });
  await insertTouch({ leadId: leads[4].id, campaignId: hvacId, variantId: variantOf(5), type: 'replied', day: 6 });
  await insertTouch({
    leadId: leads[0].id, campaignId: hvacId, variantId: variantOf(1), type: 'call_booked', day: 5, channel: 'phone',
  });
  await insertTouch({
    leadId: leads[4].id, campaignId: hvacId, variantId: variantOf(5), type: 'call_booked', day: 8, channel: 'phone',
  });
  await insertTouch({
    leadId: leads[0].id,
    campaignId: hvacId,
    variantId: variantOf(1),
    type: 'mvp_sold',
    day: 20,
    channel: 'email',
    revenueCents: 150000,
  });
  await insertTouch({
    leadId: leads[2].id,
    campaignId: hvacId,
    variantId: variantOf(3),
    type: 'opened',
    day: 1,
    channel: 'email',
    machineOpen: false,
  });
  await insertTouch({
    leadId: leads[5].id,
    campaignId: hvacId,
    variantId: variantOf(6),
    type: 'opened',
    day: 1,
    channel: 'email',
    source: 'pixel',
    machineOpen: true,
  });
  await insertTouch({
    leadId: leads[1].id,
    campaignId: protoId,
    variantId: null,
    type: 'prototype_viewed',
    day: 3,
    channel: 'prototype_link',
    source: 'system',
  });
  return { hvacId, protoId, variantA, variantB, leads };
}

async function tableHash(table) {
  const allowed = new Set(['proposals', 'pilot_events', 'campaign_touches', 'prospects']);
  if (!allowed.has(table)) throw new Error('unexpected table');
  const { rows } = await pool.query(
    `SELECT COUNT(*)::int AS n,
            md5(COALESCE(string_agg(md5(row_to_json(t)::text), ',' ORDER BY t.id), '')) AS hash
       FROM ${table} t`
  );
  return rows[0];
}

async function snapshot() {
  return {
    proposals: await tableHash('proposals'),
    pilot_events: await tableHash('pilot_events'),
    campaign_touches: await tableHash('campaign_touches'),
    prospects: await tableHash('prospects'),
  };
}

function campaignsSql() {
  const sql = fs.readFileSync(path.join(__dirname, '../src/db/schema.sql'), 'utf8');
  const at = sql.indexOf('Campaigns slice 1');
  assert.ok(at > 0);
  return sql.slice(at).replace(/--[^\n]*/g, '');
}

function campaignModules() {
  const root = path.join(__dirname, '../src/campaigns');
  const files = fs.readdirSync(root)
    .filter((name) => name.endsWith('.js'))
    .map((name) => path.join(root, name));
  files.push(path.join(__dirname, '../src/api/campaigns.js'));
  return files;
}

describe('campaigns', { concurrency: 1 }, () => {
  before(async () => {
    await applySchema();
    await resetDb();
    fixture = await seedFixture();

    const campaigns = require('../src/api/campaigns');
    const app = express();
    app.use(express.json({ limit: '1mb' }));
    app.use('/api/campaigns', campaigns.flagGate);
    app.use('/api', require('../src/api/auth'));
    app.use('/api/campaigns', campaigns.router);
    server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  });

  after(async () => {
    if (server) await new Promise((resolve) => server.close(resolve));
    await closePool();
  });

  afterEach(async () => {
    delete process.env.FF_CAMPAIGNS;
    await campaignsFlag(false);
  });

  it('campaigns: FF_CAMPAIGNS off => all campaign routes 404', async () => {
    const unknown = await request('GET', '/api/not-a-real-route', { headers: authHeaders() });
    assert.equal(unknown.status, 404);
    const paths = ['/api/campaigns/metrics', '/api/campaigns', '/api/campaigns/nope'];
    // Row off: no env value turns it on. Row on: false/off/0/no force it off.
    const cases = [
      [false, undefined], [false, ''], [false, '1'], [false, 'TRUE'], [false, 'yes'], [false, 'true'],
      [true, 'false'], [true, ' OFF '], [true, '0'], [true, 'No'],
    ];
    for (const [rowOn, value] of cases) {
      await campaignsFlag(rowOn);
      if (value === undefined) delete process.env.FF_CAMPAIGNS;
      else process.env.FF_CAMPAIGNS = value;
      for (const reqPath of paths) {
        const withKey = await request('GET', reqPath, { headers: authHeaders() });
        const noKey = await request('GET', reqPath);
        assert.equal(withKey.status, 404, `${rowOn} ${value} ${reqPath}`);
        assert.equal(noKey.status, 404, `no key ${rowOn} ${value} ${reqPath}`);
        assert.equal(withKey.json, null);
        assert.equal(normalize404(withKey.text), normalize404(unknown.text));
        assert.equal(normalize404(noKey.text), normalize404(unknown.text));
        assert.equal(withKey.headers['content-type'], unknown.headers['content-type']);
      }
    }
  });

  it('campaigns: route enumeration => every campaigns route requires API key (401)', async () => {
    const serverSrc = fs.readFileSync(path.join(__dirname, '../src/server.js'), 'utf8');
    const gateAt = serverSrc.indexOf("app.use('/api/campaigns', campaignsApi.flagGate)");
    const authAt = serverSrc.indexOf("app.use('/api', requireApiKey)");
    assert.ok(gateAt !== -1 && authAt !== -1 && gateAt < authAt);
    assert.equal(serverSrc.includes('/o/'), false);
    assert.equal(serverSrc.includes('campaign_pixel_tokens'), false);

    const campaigns = require('../src/api/campaigns');
    const routes = [];
    for (const layer of campaigns.router.stack) {
      if (!layer.route) continue;
      const methods = Object.keys(layer.route.methods).filter((method) => layer.route.methods[method]);
      routes.push({ path: layer.route.path, methods: methods.sort() });
    }
    assert.deepEqual(routes, [
      { path: '/', methods: ['get'] },
      { path: '/metrics', methods: ['get'] },
    ]);

    await campaignsFlag(true);
    for (const route of routes) {
      for (const method of route.methods) {
        const res = await request(method.toUpperCase(), `/api/campaigns${route.path}`);
        assert.equal(res.status, 401, `${method} ${route.path}`);
        assert.deepEqual(res.json, { error: 'Missing or invalid API key' });
      }
    }
  });

  it('campaigns: fixture Responded 3/8, Converted 1/8, Opened-no-response 1/8', async () => {
    await campaignsFlag(true);
    const res = await request('GET', metricsPath(`?campaign_id=${fixture.hvacId}`), { headers: authHeaders() });
    assert.equal(res.status, 200, res.text);
    const body = res.json;
    console.log('[campaigns] metrics fixture', JSON.stringify(body));
    assert.equal(body.touched, 8);
    assert.equal(body.include_machine_opens, false);
    assert.deepEqual(body.responded, { count: 3, n: 8, rate: 0.375, directional: true });
    assert.deepEqual(body.converted, { count: 1, n: 8, rate: 0.125, directional: true });
    assert.deepEqual(body.opened_no_response, {
      count: 1, n: 8, rate: 0.125, directional: true, label: OPEN_LABEL,
    });
    const variantA = body.by_variant.find((row) => row.label === 'A');
    const variantB = body.by_variant.find((row) => row.label === 'B');
    assert.equal(variantA.touched, 4);
    assert.deepEqual(variantA.responded, { count: 2, n: 4, rate: 0.5, directional: true });
    assert.deepEqual(variantA.converted, { count: 1, n: 4, rate: 0.25, directional: true });
    assert.equal(variantA.opened_no_response.count, 1);
    assert.equal(variantB.touched, 4);
    assert.deepEqual(variantB.responded, { count: 1, n: 4, rate: 0.25, directional: true });
    assert.deepEqual(variantB.converted, { count: 0, n: 4, rate: 0, directional: true });
    assert.equal(variantB.opened_no_response.count, 0);
    assert.equal(body.by_channel.length, 1);
    assert.equal(body.by_channel[0].channel, 'email');
    assert.equal(body.by_channel[0].touched, 8);
    assert.equal(body.by_channel[0].responded.count, 3);

    const open = await request('GET', metricsPath(''), { headers: authHeaders() });
    assert.equal(open.status, 200, open.text);
    console.log('[campaigns] metrics unfiltered', JSON.stringify(open.json));
    assert.equal(open.json.touched, 8);
    assert.deepEqual(open.json.event_counts, { prototype_viewed: 1 });
    const blank = await request('GET', metricsPath('?campaign_id='), { headers: authHeaders() });
    assert.equal(blank.json.touched, 8);
  });

  it('campaigns: include_machine_opens => Opened-no-response 2/8; Responded/Converted unchanged', async () => {
    await campaignsFlag(true);
    const res = await request(
      'GET',
      metricsPath(`?campaign_id=${fixture.hvacId}&include_machine_opens=true`),
      { headers: authHeaders() }
    );
    assert.equal(res.status, 200, res.text);
    console.log('[campaigns] metrics machine opens', JSON.stringify({
      opened_no_response: res.json.opened_no_response,
      responded: res.json.responded,
      converted: res.json.converted,
    }));
    assert.equal(res.json.include_machine_opens, true);
    assert.deepEqual(res.json.responded, { count: 3, n: 8, rate: 0.375, directional: true });
    assert.deepEqual(res.json.converted, { count: 1, n: 8, rate: 0.125, directional: true });
    assert.deepEqual(res.json.opened_no_response, {
      count: 2, n: 8, rate: 0.25, directional: true, label: OPEN_LABEL,
    });
    const variantB = res.json.by_variant.find((row) => row.label === 'B');
    assert.equal(variantB.opened_no_response.count, 1);
    assert.equal(variantB.opened_no_response.n, 4);
    assert.equal(variantB.responded.count, 1);
    assert.equal(variantB.converted.count, 0);
  });

  it('campaigns: reply on different channel still counts as Responded', async () => {
    await campaignsFlag(true);
    const campaignId = await insertCampaign({ name: 'TEST:Cross-Channel', channel: 'email', status: 'active' });
    const lead = await insertProspect({
      google_place_id: 'test-campaign-cross-channel',
      company: 'TEST: Cross Channel Heating',
      email: 'test+cross-channel@example.com',
      industry: 'HVAC',
    });
    try {
      const variantId = await insertVariant(campaignId, 'A', 'hook');
      await enroll(lead.id, campaignId, variantId);
      await insertTouch({
        leadId: lead.id, campaignId, variantId, type: 'sent', day: 0, channel: 'email',
      });
      await insertTouch({
        leadId: lead.id, campaignId, variantId, type: 'replied', day: 1, channel: 'phone',
      });
      const res = await request('GET', metricsPath(`?campaign_id=${campaignId}`), { headers: authHeaders() });
      assert.equal(res.status, 200, res.text);
      assert.equal(res.json.touched, 1);
      assert.deepEqual(res.json.responded, { count: 1, n: 1, rate: 1, directional: true });
      const email = res.json.by_channel.find((row) => row.channel === 'email');
      assert.equal(email.responded.count, 0);
    } finally {
      await pool.query('DELETE FROM campaign_touches WHERE lead_id = $1', [lead.id]);
      await pool.query('DELETE FROM campaign_leads WHERE lead_id = $1', [lead.id]);
      await pool.query('DELETE FROM campaigns WHERE id = $1', [campaignId]);
      await pool.query('DELETE FROM prospects WHERE id = $1', [lead.id]);
    }
  });

  it('campaigns: mvp_sold counts as Converted', async () => {
    await campaignsFlag(true);
    const { rows } = await pool.query(
      `SELECT type, revenue_cents FROM campaign_touches
        WHERE lead_id = $1 AND type IN ('won', 'mvp_sold')`,
      [fixture.leads[0].id]
    );
    assert.deepEqual(rows, [{ type: 'mvp_sold', revenue_cents: 150000 }]);
    const res = await request('GET', metricsPath(`?campaign_id=${fixture.hvacId}`), { headers: authHeaders() });
    assert.equal(res.json.converted.count, 1);
    assert.equal(res.json.converted.n, 8);
  });

  it('campaigns: TEST:Proto-Oct has 0 touched leads, 1 prototype view event', async () => {
    await campaignsFlag(true);
    const res = await request('GET', metricsPath(`?campaign_id=${fixture.protoId}`), { headers: authHeaders() });
    assert.equal(res.status, 200, res.text);
    console.log('[campaigns] metrics proto', JSON.stringify(res.json));
    assert.equal(res.json.touched, 0);
    assert.deepEqual(res.json.responded, { count: 0, n: 0, rate: null, directional: true });
    assert.deepEqual(res.json.converted, { count: 0, n: 0, rate: null, directional: true });
    assert.equal(res.json.opened_no_response.count, 0);
    assert.equal(res.json.opened_no_response.n, 0);
    assert.deepEqual(res.json.by_variant, []);
    assert.deepEqual(res.json.event_counts, { prototype_viewed: 1 });
  });

  it('campaigns: adding/removing opened touches never changes any attribution result', async () => {
    const lead = fixture.leads[0];
    const { rows } = await pool.query(
      `SELECT id, occurred_at FROM campaign_touches
        WHERE lead_id = $1 AND type = 'mvp_sold'`,
      [lead.id]
    );
    const conversion = rows[0];
    async function snap(model) {
      const row = await attributeConversion({
        leadId: lead.id,
        occurredAt: conversion.occurred_at,
        origin: 'touch',
        sourceId: conversion.id,
        model,
      });
      return {
        origin: row.origin,
        source_id: row.source_id == null ? null : String(row.source_id),
        campaign_id: row.campaign_id,
        variant_id: row.variant_id,
        channel: row.channel,
        unattributed: row.unattributed,
      };
    }
    const beforeLast = await snap('last');
    const beforeFirst = await snap('first');
    assert.equal(beforeLast.unattributed, false);
    assert.notEqual(beforeLast.source_id, String(conversion.id));
    const opened = await insertTouch({
      leadId: lead.id,
      campaignId: fixture.hvacId,
      variantId: lead.variantId,
      type: 'opened',
      day: 9,
      channel: 'email',
      machineOpen: false,
    });
    try {
      assert.deepEqual(await snap('last'), beforeLast);
      assert.deepEqual(await snap('first'), beforeFirst);
    } finally {
      await pool.query('DELETE FROM campaign_touches WHERE id = $1', [opened.id]);
    }
    assert.deepEqual(await snap('last'), beforeLast);
    assert.deepEqual(await snap('first'), beforeFirst);
  });

  it('campaigns: conversion touch never credits itself', async () => {
    const campaignId = await insertCampaign({ name: 'TEST:Self-Credit', channel: 'email', status: 'active' });
    const lead = await insertProspect({
      google_place_id: 'test-campaign-self-credit',
      company: 'TEST: Self Credit Heating',
      email: 'test+self-credit@example.com',
      industry: 'HVAC',
    });
    try {
      const booked = await insertTouch({
        leadId: lead.id, campaignId, variantId: null, type: 'call_booked', day: 5, channel: 'phone',
      });
      const alone = await attributeConversion({
        leadId: lead.id,
        occurredAt: booked.occurred_at,
        origin: 'touch',
        sourceId: booked.id,
        model: 'last',
      });
      assert.equal(alone.unattributed, true);
      assert.equal(alone.source_id, null);

      const sent = await insertTouch({
        leadId: lead.id, campaignId, variantId: null, type: 'sent', day: 0, channel: 'email',
      });
      const credited = await attributeConversion({
        leadId: lead.id,
        occurredAt: booked.occurred_at,
        origin: 'touch',
        sourceId: booked.id,
        model: 'last',
      });
      assert.equal(credited.unattributed, false);
      assert.equal(String(credited.source_id), String(sent.id));
      assert.notEqual(String(credited.source_id), String(booked.id));

      const sold = await insertTouch({
        leadId: lead.id, campaignId, variantId: null, type: 'mvp_sold', day: 20, revenueCents: 150000,
      });
      const win = await attributeConversion({
        leadId: lead.id,
        occurredAt: sold.occurred_at,
        origin: 'touch',
        sourceId: sold.id,
        model: 'last',
      });
      assert.equal(String(win.source_id), String(booked.id));
      assert.notEqual(String(win.source_id), String(sold.id));
    } finally {
      await pool.query('DELETE FROM campaign_touches WHERE lead_id = $1', [lead.id]);
      await pool.query('DELETE FROM campaigns WHERE id = $1', [campaignId]);
      await pool.query('DELETE FROM prospects WHERE id = $1', [lead.id]);
    }
  });

  it('campaigns: attribution tie order and 90-day window', async () => {
    const campaignId = await insertCampaign({ name: 'TEST:Tie-Order', channel: 'email', status: 'active' });
    const lead = await insertProspect({
      google_place_id: 'test-campaign-tie-order',
      company: 'TEST: Tie Order Heating',
      email: 'test+tie-order@example.com',
      industry: 'HVAC',
    });
    try {
      const when = atDay(10);
      const sent = await insertTouch({
        leadId: lead.id, campaignId, variantId: null, type: 'sent', occurredAt: when, channel: 'email',
      });
      const replied = await insertTouch({
        leadId: lead.id, campaignId, variantId: null, type: 'replied', occurredAt: when, channel: 'email',
      });
      const tiedSale = await insertTouch({
        leadId: lead.id,
        campaignId,
        variantId: null,
        type: 'mvp_sold',
        occurredAt: when,
        revenueCents: 150000,
      });
      const tied = await attributeConversion({
        leadId: lead.id, occurredAt: tiedSale.occurred_at, origin: 'touch', sourceId: tiedSale.id, model: 'last',
      });
      assert.equal(String(tied.source_id), String(replied.id));
      assert.notEqual(String(tied.source_id), String(sent.id));
      assert.notEqual(String(tied.source_id), String(tiedSale.id));

      const convAt = new Date('2026-10-14T16:00:00.000Z');
      const inside = new Date(convAt.getTime() - 90 * DAY_MS);
      const outside = new Date(inside.getTime() - 1000);
      const windowLead = await insertProspect({
        google_place_id: 'test-campaign-window',
        company: 'TEST: Window Heating',
        email: 'test+window@example.com',
        industry: 'HVAC',
      });
      try {
        const edge = await insertTouch({
          leadId: windowLead.id, campaignId, variantId: null, type: 'sent', occurredAt: inside.toISOString(),
        });
        const sold = await insertTouch({
          leadId: windowLead.id,
          campaignId,
          variantId: null,
          type: 'mvp_sold',
          occurredAt: convAt.toISOString(),
          revenueCents: 150000,
        });
        const onEdge = await attributeConversion({
          leadId: windowLead.id,
          occurredAt: sold.occurred_at,
          origin: 'touch',
          sourceId: sold.id,
          model: 'last',
        });
        assert.equal(String(onEdge.source_id), String(edge.id));
        await pool.query('UPDATE campaign_touches SET occurred_at = $2 WHERE id = $1', [edge.id, outside.toISOString()]);
        const past = await attributeConversion({
          leadId: windowLead.id,
          occurredAt: sold.occurred_at,
          origin: 'touch',
          sourceId: sold.id,
          model: 'last',
        });
        assert.equal(past.unattributed, true);
        assert.equal(past.source_id, null);
      } finally {
        await pool.query('DELETE FROM campaign_touches WHERE lead_id = $1', [windowLead.id]);
        await pool.query('DELETE FROM prospects WHERE id = $1', [windowLead.id]);
      }
    } finally {
      await pool.query('DELETE FROM campaign_touches WHERE lead_id = $1', [lead.id]);
      await pool.query('DELETE FROM campaigns WHERE id = $1', [campaignId]);
      await pool.query('DELETE FROM prospects WHERE id = $1', [lead.id]);
    }
  });

  it('campaigns: from/to window limits the touched base', async () => {
    await campaignsFlag(true);
    const inside = await request(
      'GET',
      metricsPath(`?campaign_id=${fixture.hvacId}&from=2026-09-24&to=2026-10-14`),
      { headers: authHeaders() }
    );
    assert.equal(inside.json.touched, 8);
    assert.equal(inside.json.converted.count, 1);
    const late = await request(
      'GET',
      metricsPath(`?campaign_id=${fixture.hvacId}&from=2026-10-14&to=2026-10-14`),
      { headers: authHeaders() }
    );
    assert.equal(late.json.touched, 0);
    assert.equal(late.json.converted.count, 0);
    const bad = await request(
      'GET',
      metricsPath('?channel=fax&include_machine_opens=1&from=yesterday&campaign_id=0'),
      { headers: authHeaders() }
    );
    assert.equal(bad.status, 400);
    assert.deepEqual(bad.json, { error: 'invalid_param' });
  });

  it('campaigns: machine_open CHECK rejects true on non-opened; source accepts pixel', async () => {
    await assert.rejects(
      () => insertTouch({
        leadId: fixture.leads[3].id,
        campaignId: fixture.hvacId,
        variantId: fixture.leads[3].variantId,
        type: 'sent',
        day: 0,
        machineOpen: true,
      }),
      (err) => {
        assert.equal(err.code, '23514');
        return true;
      }
    );
    const pixel = await insertTouch({
      leadId: fixture.leads[3].id,
      campaignId: fixture.hvacId,
      variantId: fixture.leads[3].variantId,
      type: 'opened',
      day: 2,
      source: 'pixel',
      machineOpen: true,
    });
    try {
      const { rows } = await pool.query(
        'SELECT source, machine_open, type FROM campaign_touches WHERE id = $1',
        [pixel.id]
      );
      assert.deepEqual(rows, [{ source: 'pixel', machine_open: true, type: 'opened' }]);
    } finally {
      await pool.query('DELETE FROM campaign_touches WHERE id = $1', [pixel.id]);
    }
    await assert.rejects(
      () => insertTouch({
        leadId: fixture.leads[3].id,
        campaignId: fixture.hvacId,
        variantId: fixture.leads[3].variantId,
        type: 'sent',
        day: 0,
        revenueCents: 100,
      }),
      (err) => {
        assert.equal(err.code, '23514');
        return true;
      }
    );
  });

  it('campaigns: no free-text column on campaign_touches', async () => {
    const { rows } = await pool.query(
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'campaign_touches'
        ORDER BY ordinal_position`
    );
    assert.deepEqual(rows.map((row) => row.column_name), [
      'id', 'lead_id', 'campaign_id', 'variant_id', 'type', 'channel', 'occurred_at',
      'source', 'machine_open', 'external_ref', 'revenue_cents', 'created_at',
    ]);
    const banned = ['body', 'note', 'notes', 'text', 'message', 'comment', 'content', 'description', 'subject'];
    for (const name of rows.map((row) => row.column_name)) {
      assert.equal(banned.includes(name), false, name);
    }
  });

  it('campaigns: backfill views are read-only; existing proposals/pilot_events rows unchanged (row hash before/after)', async () => {
    const section = campaignsSql();
    assert.equal(/\b(INSERT|UPDATE|DELETE)\s+(INTO\s+)?(proposals|pilot_events|prospects)\b/i.test(section), false);
    assert.equal(section.includes('TODO'), false);
    assert.equal(section.includes("left(s.company, 5)"), false);

    const { rows: checkRows } = await pool.query(
      `SELECT pg_get_constraintdef(oid) AS def
         FROM pg_constraint WHERE conname = 'pilot_events_type_check'`
    );
    assert.match(checkRows[0].def, /demo_view/);
    assert.match(checkRows[0].def, /estimate_recovered/);
    assert.doesNotMatch(checkRows[0].def, /prototype_viewed/);

    await campaignsFlag(true);
    const beforeMetrics = await request('GET', metricsPath(''), { headers: authHeaders() });
    const lead = await insertProspect({
      google_place_id: 'test-campaign-backfill-real',
      company: 'Northwind Heating',
      email: 'test+backfill-real@example.com',
      industry: 'HVAC',
    });
    assert.equal(lead.company.startsWith('TEST:'), false);
    const sentAt = atDay(0);
    const follow1 = atDay(3);
    const follow2 = atDay(10);
    const repliedAt = atDay(4);
    let proposalId;
    try {
      const inserted = await pool.query(
        `INSERT INTO proposals
           (prospect_id, slug, status, to_email, sent_at, followup1_sent_at, followup2_sent_at, replied_at)
         VALUES ($1, 'test-campaign-backfill-real', 'replied', $2, $3, $4, $5, $6)
         RETURNING id`,
        [lead.id, 'test+backfill-real@example.com', sentAt, follow1, follow2, repliedAt]
      );
      proposalId = inserted.rows[0].id;
      await pool.query(
        `INSERT INTO pilot_events (event_type, prospect_id) VALUES ('estimate_recovered', $1), ('demo_view', $1)`,
        [lead.id]
      );

      const before = {
        proposals: await tableHash('proposals'),
        pilot_events: await tableHash('pilot_events'),
      };
      const projected = await pool.query(
        `SELECT type, source_id, channel, source, campaign_id
           FROM v_campaign_backfill_touches
          WHERE lead_id = $1
          ORDER BY source_id`,
        [lead.id]
      );
      assert.deepEqual(projected.rows.map((row) => row.type), ['sent', 'sent', 'sent', 'replied']);
      assert.deepEqual(
        projected.rows.map((row) => String(row.source_id)),
        [1, 2, 3, 4].map((slot) => String(proposalId * 10 + slot))
      );
      assert.equal(projected.rows.every((row) => row.channel === 'email' && row.source === 'system'), true);
      assert.equal(projected.rows.every((row) => row.campaign_id == null), true);

      const pilot = await pool.query(
        `SELECT type FROM v_campaign_pilot_event_touches WHERE lead_id = $1`,
        [lead.id]
      );
      assert.deepEqual(pilot.rows.map((row) => row.type), ['estimate_recovered']);

      const writes = [
        `INSERT INTO v_campaign_backfill_touches
           (origin, source_id, lead_id, campaign_id, variant_id, type, channel, occurred_at, source, machine_open, external_ref, revenue_cents)
         VALUES ('proposal', 1, ${lead.id}, NULL, NULL, 'sent', 'email', NOW(), 'system', false, NULL, NULL)`,
        'UPDATE v_campaign_backfill_touches SET type = \'lost\'',
        'DELETE FROM v_campaign_backfill_touches',
        'UPDATE v_campaign_pilot_event_touches SET type = \'lost\'',
        'DELETE FROM v_campaign_pilot_event_touches',
        'DELETE FROM v_campaign_effective_touches',
      ];
      for (const sql of writes) {
        await assert.rejects(() => pool.query(sql), (err) => {
          assert.match(err.message, /cannot|not updatable|read-only/i);
          return true;
        });
      }

      const after = {
        proposals: await tableHash('proposals'),
        pilot_events: await tableHash('pilot_events'),
      };
      assert.deepEqual(after, before);
      console.log('[campaigns] backfill row hashes unchanged', JSON.stringify(after));

      const afterMetrics = await request('GET', metricsPath(''), { headers: authHeaders() });
      assert.equal(afterMetrics.json.touched, beforeMetrics.json.touched + 1);
      assert.equal(afterMetrics.json.responded.count, beforeMetrics.json.responded.count + 1);
      assert.equal(afterMetrics.json.converted.count, beforeMetrics.json.converted.count);
      const still = {
        proposals: await tableHash('proposals'),
        pilot_events: await tableHash('pilot_events'),
      };
      assert.deepEqual(still, before);
    } finally {
      await pool.query('DELETE FROM prospects WHERE id = $1', [lead.id]);
    }
  });

  it('campaigns: modules do not import send.js/gmail send', () => {
    const banned = [
      /require\((['"])[^'"]*proposals\/send(?:\.js)?\1\)/,
      /require\((['"])[^'"]*proposals\/gmail(?:\.js)?\1\)/,
      /\bsendMail\b/,
      /\bsenderTick\b/,
    ];
    const files = campaignModules();
    assert.ok(files.length >= 4);
    for (const file of files) {
      const source = fs.readFileSync(file, 'utf8');
      for (const pattern of banned) {
        assert.equal(pattern.test(source), false, `${file} matched ${pattern}`);
      }
    }
  });

  it('campaigns: real server.js => flag off 404, unset or weak key 503, missing or wrong key 401, good key 200', async () => {
    const paths = ['/api/campaigns', '/api/campaigns/metrics'];
    await campaignsFlag(true);
    const weakKeys = [
      ['unset', undefined],
      ['empty', ''],
      ['spaces', ' '.repeat(40)],
      ['short', 'short-key'],
      ['31 chars', 'x'.repeat(31)],
      ['inner spaces', `${'x'.repeat(16)}${' '.repeat(16)}y`],
    ];
    for (const [label, key] of weakKeys) {
      const app = await bootRealServer(key);
      try {
        for (const reqPath of paths) {
          for (const headers of [{}, key ? { 'x-api-key': key } : {}]) {
            const res = await rawGet(app.port, reqPath, headers);
            assert.equal(res.status, 503, `${label} ${reqPath}`);
            assert.deepEqual(res.json, { error: 'api_key_not_configured' });
          }
        }
        if (key && key.trim()) assert.equal(app.output().includes(key), false, `${label} key in logs`);
      } finally {
        await app.stop();
      }
    }

    const app = await bootRealServer(API_KEY);
    try {
      for (const reqPath of paths) {
        const missing = await rawGet(app.port, reqPath);
        assert.equal(missing.status, 401, `missing ${reqPath}`);
        assert.deepEqual(missing.json, { error: 'Missing or invalid API key' });
        const wrong = await rawGet(app.port, reqPath, { 'x-api-key': `${API_KEY}x` });
        assert.equal(wrong.status, 401, `wrong ${reqPath}`);
        const good = await rawGet(app.port, reqPath, authHeaders());
        assert.equal(good.status, 200, `good ${reqPath} ${good.text}`);
        assert.equal(good.text.includes('test+hvac-oct'), false, 'no lead emails in campaign responses');
      }
      await campaignsFlag(false);
      const unknown = await rawGet(app.port, '/api/not-a-real-route', authHeaders());
      for (const reqPath of paths) {
        for (const headers of [{}, authHeaders()]) {
          const off = await rawGet(app.port, reqPath, headers);
          assert.equal(off.status, 404, `off ${reqPath}`);
          assert.equal(normalize404(off.text), normalize404(unknown.text));
        }
      }
      assert.equal(app.output().includes(API_KEY), false);
    } finally {
      await app.stop();
    }
    console.log('[campaigns] real server: off=404 weak/unset key=503 missing/wrong key=401 good key=200');
  });

  it('campaigns: GET /api/campaigns lists each campaign with lead counts (#67 Oct 18 contract)', async () => {
    await campaignsFlag(true);
    const res = await request('GET', '/api/campaigns', { headers: authHeaders() });
    assert.equal(res.status, 200, res.text);
    console.log('[campaigns] list', JSON.stringify(res.json));
    assert.deepEqual(res.json.range, { from: null, to: null });
    assert.deepEqual(res.json.attribution, { model: 'any' });
    const hvac = res.json.campaigns.find((row) => row.id === fixture.hvacId);
    const proto = res.json.campaigns.find((row) => row.id === fixture.protoId);
    assert.deepEqual(Object.keys(hvac).sort(), [
      'channel', 'converted', 'cost_cents', 'end_date', 'enrolled', 'id', 'machine_opens', 'name',
      'opened_no_response_human', 'opened_no_response_incl_machine', 'prototype_views', 'responded',
      'segment', 'start_date', 'status', 'touched',
    ]);
    assert.deepEqual(hvac, {
      id: fixture.hvacId,
      name: 'TEST:HVAC-Oct',
      status: 'active',
      channel: 'email',
      start_date: '2026-09-24',
      end_date: null,
      segment: 'hvac',
      enrolled: 8,
      touched: 8,
      responded: 3,
      converted: 1,
      opened_no_response_human: 1,
      opened_no_response_incl_machine: 2,
      machine_opens: 1,
      prototype_views: 0,
      cost_cents: 6000,
    });
    assert.equal(proto.touched, 0);
    assert.equal(proto.responded, 0);
    assert.equal(proto.enrolled, 0);
    assert.equal(proto.prototype_views, 1);

    // Touch-dependent counts only use touches inside the range.
    const sendDay = await request('GET', '/api/campaigns?from=2026-09-24&to=2026-09-24', { headers: authHeaders() });
    assert.equal(sendDay.status, 200);
    assert.deepEqual(sendDay.json.range, { from: '2026-09-24', to: '2026-09-24' });
    const hvacSendDay = sendDay.json.campaigns.find((row) => row.id === fixture.hvacId);
    assert.equal(hvacSendDay.touched, 8);
    assert.equal(hvacSendDay.responded, 0);
    assert.equal(hvacSendDay.converted, 0);
    assert.equal(hvacSendDay.enrolled, 8);
    const late = await request('GET', '/api/campaigns?from=2026-10-20', { headers: authHeaders() });
    const hvacLate = late.json.campaigns.find((row) => row.id === fixture.hvacId);
    assert.equal(hvacLate.touched, 0);
    assert.equal(hvacLate.responded, 0);

    for (const query of [
      '?from=2026-02-30', '?from=2026-10-01T00:00:00Z', '?x=1', '?from=2026-10-02&to=2026-10-01',
      '?from=2026-10-01&from=2026-10-02', '?campaign_id=1', '?to=yesterday',
    ]) {
      const bad = await request('GET', `/api/campaigns${query}`, { headers: authHeaders() });
      assert.equal(bad.status, 400, query);
      assert.deepEqual(bad.json, { error: 'invalid_param' });
    }
  });

  it('campaigns: archived leads are left out of the list and the metrics', async () => {
    await campaignsFlag(true);
    const l4 = fixture.leads[3];
    const l1 = fixture.leads[0];
    await pool.query(
      `UPDATE prospects SET archived_at = NOW(), archive_reason = 'TEST: campaigns archive'
        WHERE id = ANY($1::int[])`,
      [[l4.id, l1.id]]
    );
    try {
      const metrics = await request('GET', metricsPath(`?campaign_id=${fixture.hvacId}`), { headers: authHeaders() });
      assert.equal(metrics.json.touched, 6);
      assert.deepEqual(metrics.json.responded, { count: 2, n: 6, rate: 2 / 6, directional: true });
      assert.equal(metrics.json.converted.count, 0);
      const list = await request('GET', '/api/campaigns', { headers: authHeaders() });
      const hvac = list.json.campaigns.find((row) => row.id === fixture.hvacId);
      assert.equal(hvac.enrolled, 6);
      assert.equal(hvac.touched, 6);
      assert.equal(hvac.responded, 2);
      assert.equal(hvac.converted, 0);
    } finally {
      await pool.query(
        `UPDATE prospects SET archived_at = NULL, archive_reason = NULL WHERE id = ANY($1::int[])`,
        [[l4.id, l1.id]]
      );
    }
    const restored = await request('GET', metricsPath(`?campaign_id=${fixture.hvacId}`), { headers: authHeaders() });
    assert.equal(restored.json.touched, 8);
  });

  it('campaigns: an open alone is not a touch, call_logged alone is, and a replier is never opened-no-response', async () => {
    await campaignsFlag(true);
    const campaignId = await insertCampaign({ name: 'TEST:Edge-Leads', channel: 'email', status: 'active' });
    const made = [];
    const lead = async (key) => {
      const row = await insertProspect({
        google_place_id: `test-campaign-edge-${key}`,
        company: `TEST: Edge ${key}`,
        email: `test+edge-${key}@example.com`,
        industry: 'HVAC',
      });
      made.push(row.id);
      await enroll(row.id, campaignId, null);
      return row;
    };
    try {
      const openOnly = await lead('open-only');
      await insertTouch({ leadId: openOnly.id, campaignId, type: 'opened', day: 1, machineOpen: false });
      const callOnly = await lead('call-only');
      await insertTouch({ leadId: callOnly.id, campaignId, type: 'call_logged', day: 1, channel: 'phone' });
      const openReply = await lead('open-reply');
      await insertTouch({ leadId: openReply.id, campaignId, type: 'sent', day: 0 });
      await insertTouch({ leadId: openReply.id, campaignId, type: 'opened', day: 1, machineOpen: false });
      await insertTouch({ leadId: openReply.id, campaignId, type: 'opened', day: 1, machineOpen: true });
      await insertTouch({ leadId: openReply.id, campaignId, type: 'replied', day: 2 });

      for (const include of ['false', 'true']) {
        const res = await request(
          'GET',
          metricsPath(`?campaign_id=${campaignId}&include_machine_opens=${include}`),
          { headers: authHeaders() }
        );
        assert.equal(res.json.touched, 2, include);
        assert.equal(res.json.responded.count, 1, include);
        assert.equal(res.json.opened_no_response.count, 0, include);
      }
      const list = await request('GET', '/api/campaigns', { headers: authHeaders() });
      const row = list.json.campaigns.find((item) => item.id === campaignId);
      assert.equal(row.enrolled, 3);
      assert.equal(row.touched, 2);
      assert.equal(row.responded, 1);
      assert.equal(row.opened_no_response_human, 0);
      assert.equal(row.opened_no_response_incl_machine, 0);
      assert.equal(row.machine_opens, 0);
    } finally {
      await pool.query('DELETE FROM campaign_touches WHERE campaign_id = $1', [campaignId]);
      await pool.query('DELETE FROM campaigns WHERE id = $1', [campaignId]);
      await pool.query('DELETE FROM prospects WHERE id = ANY($1::int[])', [made]);
    }
  });

  it('campaigns: directional is true below n=30 and false at n=30', async () => {
    await campaignsFlag(true);
    const campaignId = await insertCampaign({ name: 'TEST:Thirty', channel: 'email', status: 'active' });
    const variantId = await insertVariant(campaignId, 'A');
    const made = [];
    try {
      for (let n = 1; n <= 30; n += 1) {
        const row = await insertProspect({
          google_place_id: `test-campaign-thirty-${n}`,
          company: `TEST: Thirty ${n}`,
          email: `test+thirty-${n}@example.com`,
          industry: 'HVAC',
        });
        made.push(row.id);
        await insertTouch({ leadId: row.id, campaignId, variantId, type: 'sent', day: 0 });
        if (n === 29 || n === 30) {
          const res = await request('GET', metricsPath(`?campaign_id=${campaignId}`), { headers: authHeaders() });
          assert.equal(res.json.touched, n);
          const expected = n < 30;
          assert.equal(res.json.responded.directional, expected, `n=${n}`);
          assert.equal(res.json.converted.directional, expected, `n=${n}`);
          assert.equal(res.json.opened_no_response.directional, expected, `n=${n}`);
          assert.equal(res.json.by_variant[0].responded.directional, expected, `variant n=${n}`);
        }
      }
    } finally {
      await pool.query('DELETE FROM campaign_touches WHERE campaign_id = $1', [campaignId]);
      await pool.query('DELETE FROM campaigns WHERE id = $1', [campaignId]);
      await pool.query('DELETE FROM prospects WHERE id = ANY($1::int[])', [made]);
    }
  });

  it('campaigns: at the same timestamp a touch with a campaign beats one without (tie rule 1)', async () => {
    const first = await insertCampaign({ name: 'TEST:Tie-One-A', channel: 'email', status: 'active' });
    const second = await insertCampaign({ name: 'TEST:Tie-One-B', channel: 'email', status: 'active' });
    const lead = await insertProspect({
      google_place_id: 'test-campaign-tie-one',
      company: 'TEST: Tie One Heating',
      email: 'test+tie-one@example.com',
      industry: 'HVAC',
    });
    try {
      // Enrolled in two active email campaigns, so a campaign-less touch
      // falls back to nothing (unattributed) instead of to a campaign.
      await enroll(lead.id, first, null);
      await enroll(lead.id, second, null);
      const when = atDay(10);
      await insertTouch({ leadId: lead.id, campaignId: null, type: 'sent', occurredAt: when });
      const withCampaign = await insertTouch({ leadId: lead.id, campaignId: first, type: 'sent', occurredAt: when });
      const sold = await insertTouch({
        leadId: lead.id, campaignId: null, type: 'won', occurredAt: atDay(12), revenueCents: 0,
      });
      for (const model of ['last', 'first']) {
        const row = await attributeConversion({
          leadId: lead.id, occurredAt: sold.occurred_at, origin: 'touch', sourceId: sold.id, model,
        });
        assert.equal(row.unattributed, false, model);
        assert.equal(row.campaign_id, first, model);
        assert.equal(String(row.source_id), String(withCampaign.id), model);
      }
    } finally {
      await pool.query('DELETE FROM campaign_touches WHERE lead_id = $1', [lead.id]);
      await pool.query('DELETE FROM campaign_leads WHERE lead_id = $1', [lead.id]);
      await pool.query('DELETE FROM campaigns WHERE id = ANY($1::int[])', [[first, second]]);
      await pool.query('DELETE FROM prospects WHERE id = $1', [lead.id]);
    }
  });

  it('campaigns: manual source is refused for prototype views and CTA clicks', async () => {
    const lead = fixture.leads[2];
    for (const type of ['prototype_viewed', 'prototype_cta_clicked']) {
      await assert.rejects(
        insertTouch({ leadId: lead.id, campaignId: fixture.protoId, type, day: 3, channel: 'prototype_link', source: 'manual' }),
        (err) => err.code === '23514' && /campaign_touches_manual_type_check/.test(err.message),
        type
      );
      const ok = await insertTouch({
        leadId: lead.id, campaignId: fixture.protoId, type, day: 3, channel: 'prototype_link', source: 'system',
      });
      await pool.query('DELETE FROM campaign_touches WHERE id = $1', [ok.id]);
    }
    const manualOpen = await insertTouch({ leadId: lead.id, campaignId: fixture.hvacId, type: 'opened', day: 1, source: 'manual' });
    await pool.query('DELETE FROM campaign_touches WHERE id = $1', [manualOpen.id]);
  });

  it('campaigns: schema applied twice is idempotent', async () => {
    const before = await snapshot();
    await applySchema();
    const mid = await snapshot();
    await applySchema();
    const after = await snapshot();
    assert.deepEqual(mid, before);
    assert.deepEqual(after, before);
    const pixel = await pool.query(`SELECT to_regclass('public.campaign_pixel_tokens') AS name`);
    assert.equal(pixel.rows[0].name, null);
    console.log('[campaigns] schema applied twice; row hashes unchanged', JSON.stringify(after));
  });
});
