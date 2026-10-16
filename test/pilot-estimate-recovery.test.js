require('./preload');

// Pin pilot flags off before dotenv (loaded by the db client) can refill them.
process.env.FF_PILOT_ESTIMATE_RECOVERY = '';
process.env.FF_PILOT_LINK_ON_ONEPAGER = '';
process.env.FF_PILOT_ESTIMATE_SMS = '';
process.env.PILOT_DEMO_BASE_URL = '';
process.env.PILOT_DEMO_RATE_MAX = '';
process.env.PILOT_DEMO_RATE_WINDOW_MS = '';
process.env.CRM_API_KEY = 'test-pilot-key-must-be-32-chars-ok';

const { describe, it, before, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const { spawn } = require('child_process');
const path = require('path');
const express = require('express');

const { applySchema } = require('../src/db/migrate');
const { concludeSchemaBoot } = require('../src/pilot/schema');
const { resetDb, insertProspect, closePool, pool } = require('./fixtures');
const flags = require('../src/pilot/flags');
const { EVENT_TYPES } = require('../src/pilot/events');
const { buildDemo, OPEN_TOTAL, RECOVERED } = require('../src/pilot/payload');
const tokens = require('../src/pilot/tokens');
const pilotDemo = require('../src/pilot/demo');
const { _resetForTests, clientIp } = require('../src/pilot/rate-limit');
const send = require('../src/proposals/send');
const draft = require('../src/proposals/draft');
const places = require('../src/bot/google-places');
const gmail = require('../src/proposals/gmail');

const API_KEY = 'test-pilot-key-must-be-32-chars-ok';
const NOT_FOUND = { error: 'Not found' };
const PROSPECT_EMAIL = 'dana@wasatchheating.test';
const PROSPECT_PHONE = '(801) 555-0191';
const PROSPECT_NAME = 'Dana Reyes';

let server;
let base;
let prospect;
let proposal;
const calls = { send: 0, draft: 0, places: 0, gmail: 0, approve: 0 };

async function clearFlags() {
  process.env.FF_PILOT_ESTIMATE_RECOVERY = '';
  process.env.FF_PILOT_LINK_ON_ONEPAGER = '';
  process.env.FF_PILOT_ESTIMATE_SMS = '';
  await pool.query(
    `UPDATE feature_flags
        SET enabled = false, updated_at = NULL, updated_by = NULL
      WHERE name = ANY($1::text[])`,
    [[
      'FF_PILOT_ESTIMATE_RECOVERY',
      'FF_PILOT_LINK_ON_ONEPAGER',
    ]]
  );
}

async function setFlags({ master = false, link = false, sms = false } = {}) {
  process.env.FF_PILOT_ESTIMATE_RECOVERY = '';
  process.env.FF_PILOT_LINK_ON_ONEPAGER = '';
  process.env.FF_PILOT_ESTIMATE_SMS = sms ? 'true' : '';
  await pool.query(
    `UPDATE feature_flags AS f
        SET enabled = v.enabled, updated_at = NOW(), updated_by = 'test'
       FROM (VALUES
         ('FF_PILOT_ESTIMATE_RECOVERY', $1::boolean),
         ('FF_PILOT_LINK_ON_ONEPAGER', $2::boolean)
       ) AS v(name, enabled)
      WHERE f.name = v.name`,
    [master, link]
  );
}

function request(method, reqPath, { headers = {}, body, rawBody, port } = {}) {
  return new Promise((resolve, reject) => {
    const payload = rawBody != null
      ? (Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(rawBody))
      : (body === undefined ? null : Buffer.from(JSON.stringify(body)));
    const req = http.request({
      method,
      hostname: '127.0.0.1',
      port: port || server.address().port,
      path: reqPath,
      headers: {
        'x-forwarded-for': '203.0.113.10',
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

async function tokenStats(proposalId) {
  const { rows } = await pool.query(
    `SELECT COUNT(*)::int AS n,
            COUNT(*) FILTER (WHERE revoked_at IS NULL)::int AS active,
            COALESCE(MAX(id), 0)::int AS max_id
       FROM pilot_tokens WHERE proposal_id = $1`,
    [proposalId]
  );
  return rows[0];
}

const HASH_ONLY_COLUMNS = [
  'created_at', 'derived', 'expires_at', 'generation', 'id', 'proposal_id', 'prospect_id', 'revoked_at', 'token_hash',
];

async function assertHashOnly(proposalId, rawTokens) {
  const secrets = [].concat(rawTokens).filter(Boolean);
  const columns = await pool.query(
    `SELECT column_name, data_type FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'pilot_tokens'
      ORDER BY column_name`
  );
  assert.deepEqual(columns.rows.map((row) => row.column_name), HASH_ONLY_COLUMNS);
  const textCols = HASH_ONLY_COLUMNS.filter((name) => name !== 'token_hash');
  const scanned = await pool.query(
    `SELECT ${textCols.map((name) => `COALESCE(${name}::text, '')`).join(" || '|' || ")} AS blob,
            token_hash
       FROM pilot_tokens WHERE proposal_id = $1`,
    [proposalId]
  );
  assert.ok(scanned.rows.length >= 1);
  for (const row of scanned.rows) {
    const hash = Buffer.from(row.token_hash);
    assert.equal(hash.length, 32);
    for (const secret of secrets) {
      assert.equal(row.blob.includes(secret), false);
      assert.equal(hash.toString('utf8').includes(secret), false);
      assert.equal(hash.toString('hex').includes(secret), false);
      assert.equal(hash.toString('base64').includes(secret), false);
      assert.equal(hash.toString('base64url').includes(secret), false);
    }
  }
}

function assertClosed(res) {
  assert.equal(res.status, 404);
  assert.deepEqual(res.json, NOT_FOUND);
  assert.equal(res.headers['x-robots-tag'], 'noindex, nofollow');
  assert.equal(res.headers['cache-control'], 'no-store');
}

function tokenFromPath(demoPath) {
  const part = String(demoPath || '').split('/demo/estimate-recovery/')[1] || '';
  return decodeURIComponent(part.split('?')[0]);
}

function ctaHref(html) {
  const match = String(html || '').match(/data-pilot="estimate-recovery" href="([^"]*)"/);
  return match ? match[1] : '';
}

async function insertProposal(prospectId, overrides = {}) {
  const slug = overrides.slug || `pilot-${crypto.randomBytes(4).toString('hex')}`;
  const { rows } = await pool.query(
    `INSERT INTO proposals (prospect_id, slug, status, subject, to_email, to_name)
     VALUES ($1, $2, $3, 'Pilot subject', $4, 'Dana') RETURNING *`,
    [prospectId, slug, overrides.status || 'draft', PROSPECT_EMAIL]
  );
  return rows[0];
}

describe('pilot estimate recovery', () => {
  before(async () => {
    await applySchema();
    await applySchema();
    await resetDb();

    const origApprove = send.approveAndSend;
    send.approveAndSend = async (...args) => {
      calls.approve += 1;
      return origApprove(...args);
    };
    send._setTransport({
      async sendMail() {
        calls.send += 1;
        return { messageId: '<pilot-test@localhost>' };
      },
    });
    draft._setClient({
      messages: {
        async create() {
          calls.draft += 1;
          throw new Error('draft should not run on the demo path');
        },
      },
    });
    places._setSearch(async () => {
      calls.places += 1;
      return [];
    });
    const origGmail = gmail.sendMail;
    gmail.sendMail = async (...args) => {
      calls.gmail += 1;
      return origGmail(...args);
    };

    prospect = await insertProspect({
      google_place_id: 'test-place-pilot-wasatch',
      company: 'Wasatch Heating',
      email: PROSPECT_EMAIL,
      contact_name: PROSPECT_NAME,
      phone: PROSPECT_PHONE,
      website: null,
    });
    proposal = await insertProposal(prospect.id, { slug: 'pilot-wasatch-heating' });

    const app = express();
    app.set('trust proxy', 1);
    app.use(express.json({ limit: '1mb' }));
    app.use(pilotDemo.payloadTooLarge);
    app.use('/p', require('../src/proposals/onepager').router);
    app.use('/demo/estimate-recovery', pilotDemo.router);
    app.use('/api', require('../src/api/auth'));
    app.use('/api/proposals', require('../src/api/proposals'));
    server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${server.address().port}`;
    assert.ok(base);
  });

  after(async () => {
    send._setTransport(null);
    draft._setClient(null);
    places._setSearch(null);
    if (server) await new Promise((resolve) => server.close(resolve));
    await closePool();
  });

  afterEach(async () => {
    await clearFlags();
    delete process.env.PILOT_DEMO_RATE_MAX;
    delete process.env.PILOT_DEMO_RATE_WINDOW_MS;
    process.env.PILOT_DEMO_RATE_MAX = '';
    process.env.PILOT_DEMO_RATE_WINDOW_MS = '';
    process.env.PILOT_DEMO_BASE_URL = '';
    _resetForTests();
    tokens._clearCacheForTests();
  });

  it('keeps every pilot flag off unless the database row is on and env is not a kill switch', async () => {
    await clearFlags();
    assert.deepEqual(await flags.flags(), {
      FF_PILOT_ESTIMATE_RECOVERY: false,
      FF_PILOT_LINK_ON_ONEPAGER: false,
      FF_PILOT_ESTIMATE_SMS: false,
    });
    for (const value of ['1', 'TRUE', 'True', 'yes', ' true', 'true ', 'on', '']) {
      process.env.FF_PILOT_ESTIMATE_RECOVERY = value;
      process.env.FF_PILOT_LINK_ON_ONEPAGER = value;
      process.env.FF_PILOT_ESTIMATE_SMS = value;
      assert.equal(await flags.masterOn(), false, value);
      assert.equal(await flags.linkOn(), false, value);
      assert.equal(await flags.smsOn(), false, value);
    }
    process.env.FF_PILOT_ESTIMATE_SMS = 'true';
    assert.equal(await flags.smsOn(), true);
    assert.equal(await flags.masterOn(), false);
    await setFlags({ master: true, link: true, sms: true });
    assert.equal(await flags.masterOn(), true);
    assert.equal(await flags.linkOn(), true);
    assert.equal(await flags.smsOn(), true);
    for (const value of ['false', ' FALSE ', 'off', 'OFF', '0', ' 0 ', 'no', ' NO ']) {
      process.env.FF_PILOT_ESTIMATE_RECOVERY = value;
      process.env.FF_PILOT_LINK_ON_ONEPAGER = value;
      process.env.FF_PILOT_ESTIMATE_SMS = value;
      assert.equal(await flags.masterOn(), false, value);
      assert.equal(await flags.linkOn(), false, value);
      assert.equal(await flags.smsOn(), false, value);
    }
  });

  it('returns 404 with no one-pager CTA when the master flag is off', async () => {
    await clearFlags();
    const page = await request('GET', '/p/pilot-wasatch-heating');
    assert.equal(page.status, 200);
    assert.equal(page.text.includes('Try a live demo'), false);
    assert.equal(page.text.includes('data-pilot'), false);

    const demo = await request('GET', '/demo/estimate-recovery/demo-example-heating-air');
    assertClosed(demo);
    const posted = await request('POST', '/demo/estimate-recovery/demo-example-heating-air/events', {
      body: { type: 'demo_view' },
    });
    assertClosed(posted);

    const { rows } = await pool.query('SELECT COUNT(*)::int AS n FROM pilot_tokens');
    assert.equal(rows[0].n, 0);
    const events = await pool.query('SELECT COUNT(*)::int AS n FROM pilot_events');
    assert.equal(events.rows[0].n, 0);
  });

  it('hides the CTA when only one of the two link flags is on', async () => {
    await setFlags({ master: true, link: false });
    const masterOnly = await request('GET', '/p/pilot-wasatch-heating');
    assert.equal(masterOnly.status, 200);
    assert.equal(masterOnly.text.includes('Try a live demo'), false);

    await clearFlags();
    await setFlags({ master: false, link: true });
    const linkOnly = await request('GET', '/p/pilot-wasatch-heating');
    assert.equal(linkOnly.status, 200);
    assert.equal(linkOnly.text.includes('Try a live demo'), false);
    const closed = await request('GET', `/demo/estimate-recovery/${'a'.repeat(22)}`);
    assertClosed(closed);

    const { rows } = await pool.query('SELECT COUNT(*)::int AS n FROM pilot_tokens');
    assert.equal(rows[0].n, 0);
  });

  it('mints a 32-byte HMAC token, looks it up by hash, and serves the synthetic payload', async () => {
    await setFlags({ master: true, link: true });
    const minted = await request('POST', `/api/proposals/${proposal.id}/demo-token`, {
      headers: { 'x-api-key': API_KEY },
    });

    assert.equal(minted.status, 201);
    assert.equal(minted.headers['cache-control'], 'no-store');
    assert.equal(typeof minted.json.token, 'string');
    assert.equal(minted.json.token, tokens.deriveToken(proposal.id, 1));
    assert.match(minted.json.token, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(Buffer.from(minted.json.token, 'base64url').length, 32);
    assert.equal(minted.json.path, `/demo/estimate-recovery/${minted.json.token}`);
    assert.equal(JSON.stringify(minted.json).includes(PROSPECT_EMAIL), false);

    const stored = await pool.query(
      `SELECT id, proposal_id, prospect_id, generation, token_hash, expires_at, revoked_at
         FROM pilot_tokens WHERE proposal_id = $1 AND revoked_at IS NULL`,
      [proposal.id]
    );
    assert.equal(stored.rows.length, 1);
    assert.equal(Number(stored.rows[0].generation), 1);
    const hash = crypto.createHash('sha256').update(minted.json.token, 'utf8').digest();
    assert.ok(Buffer.from(stored.rows[0].token_hash).equals(hash));
    assert.equal(stored.rows[0].revoked_at, null);
    assert.ok(new Date(stored.rows[0].expires_at).getTime() > Date.now());
    await assertHashOnly(proposal.id, minted.json.token);
    const revokedFlag = await pool.query(
      'SELECT demo_revoked_at FROM proposals WHERE id = $1',
      [proposal.id]
    );
    assert.equal(revokedFlag.rows[0].demo_revoked_at, null);

    await pool.query('ALTER TABLE pilot_tokens ADD COLUMN IF NOT EXISTS token TEXT');
    await pool.query(
      `UPDATE pilot_tokens SET token = $2 WHERE id = $1`,
      [stored.rows[0].id, minted.json.token]
    );
    await applySchema();
    await assertHashOnly(proposal.id, minted.json.token);
    const detail = await request('GET', `/api/proposals/${proposal.id}`, {
      headers: { 'x-api-key': API_KEY },
    });
    assert.equal(detail.status, 200);
    assert.equal(JSON.stringify(detail.json).includes(minted.json.token), false);

    const page = await request('GET', '/p/pilot-wasatch-heating');
    assert.equal(page.status, 200);
    assert.equal(ctaHref(page.text), minted.json.path);
    assert.match(page.text, /Try a live demo/);
    const tokenCount = await pool.query('SELECT COUNT(*)::int AS n FROM pilot_tokens');
    assert.equal(tokenCount.rows[0].n, 1);

    const demo = await request('GET', minted.json.path + '?company=Not%20The%20Prospect');
    assert.equal(demo.status, 200);
    assert.equal(demo.headers['x-robots-tag'], 'noindex, nofollow');
    assert.equal(demo.headers['cache-control'], 'no-store');
    assert.equal(demo.json.company, 'Wasatch Heating');
    assert.equal(demo.json.synthetic, true);
    assert.equal(demo.json.openCount, 3);
    assert.equal(demo.json.openTotal, OPEN_TOTAL);
    assert.equal(demo.json.recovered, RECOVERED);
    assert.equal(demo.json.estimates[0].options[0].tier, 'Good');
    assert.equal(demo.json.estimates[0].options[0].amount, 9800);
    assert.equal(demo.json.estimates[0].options[1].tier, 'Better');
    assert.equal(demo.json.estimates[0].options[1].amount, 14800);
    assert.equal(demo.json.estimates[0].options[2].tier, 'Best');
    assert.equal(demo.json.estimates[0].options[2].amount, 19600);
    assert.equal(demo.json.estimates[1].name, 'AC replacement');
    assert.equal(demo.json.estimates[1].amount, 16400);
    assert.equal(demo.json.estimates[2].name, 'Duct job');
    assert.equal(demo.json.estimates[2].amount, 7200);
    assert.equal(demo.json.estimates.reduce((sum, item) => sum + item.amount, 0), 38400);
    assert.deepEqual(demo.json.timeline.map((step) => step.kind), ['email', 'email', 'task', 'email']);
    assert.equal(demo.json.timeline[0].subject, 'Thanks from Wasatch Heating');
    assert.match(demo.json.timeline[2].body, /No call is placed/);
    assert.match(demo.json.timeline[3].body, /does not send it/);
    assert.equal(demo.json.reply.question, 'Is there financing?');
    assert.match(demo.json.reply.draft, /draft until the owner approves it/);
    assert.match(demo.json.reply.draft, /\$14,800/);
    assert.deepEqual(demo.json, JSON.parse(JSON.stringify(buildDemo({ company: 'Wasatch Heating' }))));

    const leaked = JSON.stringify(demo.json);
    assert.equal(leaked.includes(PROSPECT_EMAIL), false);
    assert.equal(leaked.includes(PROSPECT_PHONE), false);
    assert.equal(leaked.includes(PROSPECT_NAME), false);
    assert.equal(leaked.includes('100 Center St'), false);
    assert.equal(leaked.toLowerCase().includes('sms'), false);

    const beforeEvents = await pool.query('SELECT COUNT(*)::int AS n FROM pilot_events');
    assert.equal(beforeEvents.rows[0].n, 0);
  });

  it('uses one 404 for a bad, unknown, expired, or revoked token', async () => {
    await setFlags({ master: true });
    const minted = await request('POST', `/api/proposals/${proposal.id}/demo-token`, {
      headers: { 'x-api-key': API_KEY, 'x-forwarded-for': '203.0.113.20' },
    });
    assert.equal(minted.status, 201);
    const good = minted.json.path;

    const unknown = await request('GET', `/demo/estimate-recovery/${'b'.repeat(22)}`, {
      headers: { 'x-forwarded-for': '203.0.113.20' },
    });
    const malformed = await request('GET', `/demo/estimate-recovery/${'a'.repeat(21)}`, {
      headers: { 'x-forwarded-for': '203.0.113.20' },
    });
    const tooLong = await request('GET', `/demo/estimate-recovery/${'c'.repeat(65)}`, {
      headers: { 'x-forwarded-for': '203.0.113.20' },
    });
    const padded = await request('GET', `/demo/estimate-recovery/${minted.json.token}%3D`, {
      headers: { 'x-forwarded-for': '203.0.113.20' },
    });
    const preview = await request('GET', '/demo/estimate-recovery/demo-example-heating-air', {
      headers: { 'x-forwarded-for': '203.0.113.20' },
    });
    assertClosed(unknown);
    assertClosed(malformed);
    assertClosed(tooLong);
    assertClosed(padded);
    assertClosed(preview);
    assert.deepEqual(unknown.json, malformed.json);
    assert.deepEqual(unknown.json, preview.json);

    await pool.query(
      `UPDATE pilot_tokens SET expires_at = NOW() - INTERVAL '1 minute' WHERE token_hash = $1`,
      [tokens.hashToken(minted.json.token)]
    );
    tokens._clearCacheForTests();
    const expired = await request('GET', good, { headers: { 'x-forwarded-for': '203.0.113.20' } });
    assertClosed(expired);
    assert.deepEqual(expired.json, unknown.json);

    const fresh = await request('POST', `/api/proposals/${proposal.id}/demo-token`, {
      headers: { 'x-api-key': API_KEY, 'x-forwarded-for': '203.0.113.20' },
    });
    assert.equal(fresh.status, 201);
    const revoke = await request('POST', `/api/proposals/${proposal.id}/demo-token/revoke`, {
      headers: { 'x-api-key': API_KEY, 'x-forwarded-for': '203.0.113.20' },
    });
    assert.equal(revoke.status, 200);
    assert.deepEqual(revoke.json, { ok: true });
    const revoked = await request('GET', fresh.json.path, { headers: { 'x-forwarded-for': '203.0.113.20' } });
    assertClosed(revoked);
    assert.deepEqual(revoked.json, unknown.json);
    assert.equal(revoked.text.includes('expired'), false);
    assert.equal(revoked.text.includes('revoked'), false);
  });

  it('rate limits each IP and keeps noindex on 429', async () => {
    await setFlags({ master: true });
    process.env.PILOT_DEMO_RATE_MAX = '2';
    process.env.PILOT_DEMO_RATE_WINDOW_MS = '60000';
    _resetForTests();
    const minted = await request('POST', `/api/proposals/${proposal.id}/demo-token`, {
      headers: { 'x-api-key': API_KEY, 'x-forwarded-for': '203.0.113.30' },
    });
    assert.equal(minted.status, 201);
    const path = minted.json.path;
    const ip = { 'x-forwarded-for': '203.0.113.31' };
    const first = await request('GET', path, { headers: ip });
    const second = await request('GET', path, { headers: ip });
    const third = await request('GET', path, { headers: ip });
    assert.equal(first.status, 200);
    assert.equal(second.status, 200);
    assert.equal(third.status, 429);
    assert.deepEqual(third.json, { error: 'Too many requests' });
    assert.equal(third.headers['x-robots-tag'], first.headers['x-robots-tag']);
    assert.equal(third.headers['cache-control'], first.headers['cache-control']);
    assert.equal(third.headers['content-type'], first.headers['content-type']);
    assert.equal(third.headers['x-robots-tag'], 'noindex, nofollow');
    assert.equal(third.headers['cache-control'], 'no-store');
    assert.ok(Number(third.headers['retry-after']) >= 1);

    const other = await request('GET', path, { headers: { 'x-forwarded-for': '203.0.113.32' } });
    assert.equal(other.status, 200);
    assert.equal(other.headers['x-robots-tag'], 'noindex, nofollow');
  });

  it('records allowlisted events only, with join ids and no free-text columns', async () => {
    await setFlags({ master: true, sms: true });
    const minted = await request('POST', `/api/proposals/${proposal.id}/demo-token`, {
      headers: { 'x-api-key': API_KEY, 'x-forwarded-for': '203.0.113.40' },
    });
    assert.equal(minted.status, 201);
    const ip = { 'x-forwarded-for': '203.0.113.41' };

    const columns = await pool.query(
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'pilot_events'
        ORDER BY column_name`
    );
    assert.deepEqual(columns.rows.map((r) => r.column_name), [
      'created_at', 'event_type', 'id', 'proposal_id', 'prospect_id', 'token_id',
    ]);
    const constraint = await pool.query(
      `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = 'pilot_events_type_check'`
    );
    for (const type of EVENT_TYPES) assert.match(constraint.rows[0].def, new RegExp(`'${type}'`));

    for (const type of EVENT_TYPES) {
      const res = await request('POST', `${minted.json.path}/events`, {
        headers: ip,
        body: { type, email: PROSPECT_EMAIL, note: 'free text', ip: '198.51.100.8', user_agent: 'spy' },
      });
      assert.equal(res.status, 201, type);
      assert.deepEqual(res.json, { ok: true, type });
      assert.equal(JSON.stringify(res.json).includes(PROSPECT_EMAIL), false);
    }

    const rows = await pool.query(
      `SELECT event_type, token_id, proposal_id, prospect_id FROM pilot_events ORDER BY id`
    );
    assert.deepEqual(rows.rows.map((r) => r.event_type), [...EVENT_TYPES]);
    for (const row of rows.rows) {
      assert.equal(Number(row.proposal_id), proposal.id);
      assert.equal(Number(row.prospect_id), prospect.id);
      assert.ok(row.token_id);
    }

    const rejected = await request('POST', `${minted.json.path}/events`, {
      headers: ip,
      body: { type: 'note', note: 'hello homeowner' },
    });
    assert.equal(rejected.status, 400);
    assert.deepEqual(rejected.json, { error: 'Invalid event type' });
    assert.equal(rejected.headers['x-robots-tag'], 'noindex, nofollow');
    assert.equal(rejected.headers['cache-control'], 'no-store');
    const afterReject = await pool.query('SELECT COUNT(*)::int AS n FROM pilot_events');
    assert.equal(afterReject.rows[0].n, EVENT_TYPES.length);

    const hidden = await request('POST', `/demo/estimate-recovery/${'d'.repeat(22)}/events`, {
      headers: ip,
      body: { type: 'not-a-type', email: PROSPECT_EMAIL },
    });
    assertClosed(hidden);

    await assert.rejects(
      () => pool.query(
        `INSERT INTO pilot_events (event_type, proposal_id, prospect_id) VALUES ('homeowner note', $1, $2)`,
        [proposal.id, prospect.id]
      ),
      /pilot_events_type_check/
    );

    const demo = await request('GET', minted.json.path, { headers: ip });
    assert.equal(demo.json.timeline.some((step) => step.kind === 'sms'), false);
    assert.equal(await flags.smsOn(), true);

    const lead = await pool.query('SELECT stage FROM prospects WHERE id = $1', [prospect.id]);
    const saved = await pool.query('SELECT status, sent_at FROM proposals WHERE id = $1', [proposal.id]);
    assert.equal(lead.rows[0].stage, 'found');
    assert.equal(saved.rows[0].status, 'draft');
    assert.equal(saved.rows[0].sent_at, null);
  });

  it('does not mint on a public route and requires the API key', async () => {
    await setFlags({ master: true, link: true });
    const open = await request('POST', '/demo/estimate-recovery', {
      headers: { 'x-forwarded-for': '203.0.113.50' },
      body: { proposal_id: proposal.id },
    });
    assertClosed(open);
    assert.equal(open.text.includes('"token"'), false);

    const noKey = await request('POST', `/api/proposals/${proposal.id}/demo-token`, {
      headers: { 'x-forwarded-for': '203.0.113.50' },
    });
    assert.equal(noKey.status, 401);

    const wrong = await request('POST', `/api/proposals/${proposal.id}/demo-token`, {
      headers: { 'x-api-key': 'nope', 'x-forwarded-for': '203.0.113.50' },
    });
    assert.equal(wrong.status, 401);

    await clearFlags();
    const flagged = await request('POST', `/api/proposals/${proposal.id}/demo-token`, {
      headers: { 'x-api-key': API_KEY, 'x-forwarded-for': '203.0.113.50' },
    });
    assert.equal(flagged.status, 404);
    assert.deepEqual(flagged.json, NOT_FOUND);

    const other = await insertProposal(prospect.id, { status: 'discarded', slug: 'pilot-discarded' });
    await setFlags({ master: true });
    const discarded = await request('POST', `/api/proposals/${other.id}/demo-token`, {
      headers: { 'x-api-key': API_KEY, 'x-forwarded-for': '203.0.113.50' },
    });
    assert.equal(discarded.status, 404);
    const page = await request('GET', '/p/pilot-discarded', {
      headers: { 'x-forwarded-for': '203.0.113.51' },
    });
    assert.equal(page.status, 404);
    assert.equal(page.text.includes('Try a live demo'), false);
  });

  it('does not call send, draft, Places, or Gmail', async () => {
    const pilotDir = path.join(__dirname, '../src/pilot');
    const sources = fs.readdirSync(pilotDir).filter((name) => name.endsWith('.js'));
    assert.ok(sources.length >= 5);
    for (const name of sources) {
      const src = fs.readFileSync(path.join(pilotDir, name), 'utf8');
      assert.doesNotMatch(src, /require\(['"][^'"]*(twilio|nodemailer|anthropic|googleapis)/i, name);
      assert.doesNotMatch(src, /\b(sendMail|approveAndSend|draftProposal|searchPlaces)\s*\(/, name);
    }
    const tokenSrc = fs.readFileSync(path.join(pilotDir, 'tokens.js'), 'utf8');
    assert.match(tokenSrc, /hkdfSync\(/);
    assert.match(tokenSrc, /createHmac\(/);
    assert.match(tokenSrc, /ff-pilot-demo/);
    assert.match(tokenSrc, /pilot-demo:v1/);
    assert.match(tokenSrc, /timingSafeEqual/);
    assert.doesNotMatch(tokenSrc, /randomBytes\(TOKEN_BYTES\)/);

    await setFlags({ master: true, link: true, sms: true });
    const before = { ...calls };
    const page = await request('GET', '/p/pilot-wasatch-heating', {
      headers: { 'x-forwarded-for': '203.0.113.60' },
    });
    const href = ctaHref(page.text);
    assert.ok(href);
    const demo = await request('GET', href, { headers: { 'x-forwarded-for': '203.0.113.61' } });
    assert.equal(demo.status, 200);
    const event = await request('POST', `${href}/events`, {
      headers: { 'x-forwarded-for': '203.0.113.61' },
      body: { type: 'estimate_recovered' },
    });
    assert.equal(event.status, 201);
    assert.equal(calls.send, before.send);
    assert.equal(calls.draft, before.draft);
    assert.equal(calls.places, before.places);
    assert.equal(calls.gmail, before.gmail);
    assert.equal(calls.approve, before.approve);
    assert.equal(calls.send, 0);
    assert.equal(calls.draft, 0);
    assert.equal(calls.places, 0);
    assert.equal(calls.gmail, 0);
    assert.equal(calls.approve, 0);
  });

  it('returns a generic message when mint or revoke throws', async () => {
    await setFlags({ master: true });
    const secret = 'pilot-secret-db-detail-9f3c';
    const origMint = tokens.mintForProposal;
    const origRevoke = tokens.revokeForProposal;
    const origError = console.error;
    const lines = [];
    console.error = (...args) => {
      lines.push(args.map((part) => String(part)).join(' '));
    };
    const key = { 'x-api-key': API_KEY, 'x-forwarded-for': '203.0.113.70' };
    try {
      tokens.mintForProposal = async () => { throw new Error(secret); };
      const minted = await request('POST', `/api/proposals/${proposal.id}/demo-token`, { headers: key });
      assert.equal(minted.status, 500);
      assert.deepEqual(minted.json, { error: 'Something went wrong.' });
      assert.equal(minted.text.includes(secret), false);
      assert.equal(minted.headers['cache-control'], 'no-store');

      tokens.mintForProposal = origMint;
      tokens.revokeForProposal = async () => { throw new Error(secret); };
      const revoked = await request('POST', `/api/proposals/${proposal.id}/demo-token/revoke`, { headers: key });
      assert.equal(revoked.status, 500);
      assert.deepEqual(revoked.json, { error: 'Something went wrong.' });
      assert.equal(revoked.text.includes(secret), false);
      assert.equal(revoked.headers['cache-control'], 'no-store');
      assert.equal(lines.filter((line) => line.includes(secret)).length, 2);
    } finally {
      tokens.mintForProposal = origMint;
      tokens.revokeForProposal = origRevoke;
      console.error = origError;
    }
  });

  it('closes a discarded proposal token and still revokes it', async () => {
    await setFlags({ master: true });
    const key = { 'x-api-key': API_KEY, 'x-forwarded-for': '203.0.113.71' };
    const live = await insertProposal(prospect.id, { slug: 'pilot-discard-live' });
    const minted = await request('POST', `/api/proposals/${live.id}/demo-token`, { headers: key });
    assert.equal(minted.status, 201);

    await pool.query(`UPDATE proposals SET status = 'discarded' WHERE id = $1`, [live.id]);
    const unrevoked = await pool.query(
      `SELECT revoked_at FROM pilot_tokens WHERE proposal_id = $1`,
      [live.id]
    );
    assert.equal(unrevoked.rows.length, 1);
    assert.equal(unrevoked.rows[0].revoked_at, null);
    const closed = await request('GET', minted.json.path, {
      headers: { 'x-forwarded-for': '203.0.113.72' },
    });
    assertClosed(closed);
    const event = await request('POST', `${minted.json.path}/events`, {
      headers: { 'x-forwarded-for': '203.0.113.72' },
      body: { type: 'demo_view' },
    });
    assertClosed(event);

    const revoke = await request('POST', `/api/proposals/${live.id}/demo-token/revoke`, { headers: key });
    assert.equal(revoke.status, 200);
    assert.deepEqual(revoke.json, { ok: true });
    const revokedRow = await pool.query(
      `SELECT t.revoked_at, pr.demo_revoked_at
         FROM pilot_tokens t JOIN proposals pr ON pr.id = t.proposal_id
        WHERE t.proposal_id = $1`,
      [live.id]
    );
    assert.ok(revokedRow.rows[0].revoked_at);
    assert.ok(revokedRow.rows[0].demo_revoked_at);

    const draft = await insertProposal(prospect.id, { slug: 'pilot-discard-route' });
    const second = await request('POST', `/api/proposals/${draft.id}/demo-token`, { headers: key });
    assert.equal(second.status, 201);
    const dropped = await request('POST', `/api/proposals/${draft.id}/discard`, { headers: key, body: {} });
    assert.equal(dropped.status, 200);
    assert.equal(dropped.json.status, 'discarded');
    const left = await pool.query(
      `SELECT COUNT(*)::int AS n FROM pilot_tokens WHERE proposal_id = $1 AND revoked_at IS NULL`,
      [draft.id]
    );
    assert.equal(left.rows[0].n, 0);
    const marked = await pool.query(
      'SELECT demo_revoked_at FROM proposals WHERE id = $1',
      [draft.id]
    );
    assert.ok(marked.rows[0].demo_revoked_at);
    const demo = await request('GET', second.json.path, {
      headers: { 'x-forwarded-for': '203.0.113.73' },
    });
    assertClosed(demo);

    // Discard sticks after the page is visible again. Restore sets status
    // back to draft and does not clear demo_revoked_at.
    await pool.query(`UPDATE proposals SET status = 'draft' WHERE id = $1`, [draft.id]);
    const before = await tokenStats(draft.id);
    for (let i = 0; i < 5; i += 1) {
      tokens._clearCacheForTests();
      const page = await request('GET', '/p/pilot-discard-route', {
        headers: { 'x-forwarded-for': `203.0.113.${110 + i}` },
      });
      assert.equal(page.status, 200);
      assert.equal(page.text.includes('Try a live demo'), false);
      assert.equal(page.text.includes('data-pilot'), false);
    }
    const after = await tokenStats(draft.id);
    assert.deepEqual(after, before);
    const stillClosed = await request('GET', second.json.path, {
      headers: { 'x-forwarded-for': '203.0.113.74' },
    });
    assertClosed(stillClosed);
  });

  it('recomputes the same token across cold renders and rotates on mint', async () => {
    await setFlags({ master: true, link: true });
    const row = await insertProposal(prospect.id, { slug: 'pilot-stable-link' });
    const key = { 'x-api-key': API_KEY, 'x-forwarded-for': '203.0.113.80' };
    const first = await request('POST', `/api/proposals/${row.id}/demo-token`, { headers: key });
    assert.equal(first.status, 201);
    assert.equal(first.json.token, tokens.deriveToken(row.id, 1));
    const before = await tokenStats(row.id);
    assert.equal(before.active, 1);
    assert.equal(before.n, 1);

    const index = await pool.query(
      `SELECT indexdef FROM pg_indexes WHERE indexname = 'idx_pilot_tokens_one_active'`
    );
    assert.match(index.rows[0].indexdef, /UNIQUE/);
    assert.match(index.rows[0].indexdef, /revoked_at IS NULL/);
    await assert.rejects(
      () => pool.query(
        `INSERT INTO pilot_tokens (proposal_id, prospect_id, generation, token_hash, expires_at)
         VALUES ($1, $2, 99, $3, NOW() + INTERVAL '1 day')`,
        [row.id, prospect.id, crypto.randomBytes(32)]
      ),
      /idx_pilot_tokens_one_active|duplicate key/
    );
    assert.deepEqual(await tokenStats(row.id), before);

    for (let i = 0; i < 50; i += 1) {
      tokens._clearCacheForTests();
      const page = await request('GET', '/p/pilot-stable-link', {
        headers: { 'x-forwarded-for': `198.51.100.${(i % 50) + 1}` },
      });
      assert.equal(page.status, 200, `view ${i}`);
      assert.equal(tokenFromPath(ctaHref(page.text)), first.json.token, `token ${i}`);
    }
    assert.deepEqual(await tokenStats(row.id), before);
    await assertHashOnly(row.id, first.json.token);
    const still = await request('GET', first.json.path, {
      headers: { 'x-forwarded-for': '203.0.113.81' },
    });
    assert.equal(still.status, 200);
    assert.equal(still.json.company, 'Wasatch Heating');

    const rotated = await request('POST', `/api/proposals/${row.id}/demo-token`, { headers: key });
    assert.equal(rotated.status, 201);
    assert.equal(rotated.json.token, tokens.deriveToken(row.id, 2));
    assert.notEqual(rotated.json.token, first.json.token);
    const after = await tokenStats(row.id);
    assert.equal(after.active, 1);
    assert.equal(after.n, 2);
    await assertHashOnly(row.id, [first.json.token, rotated.json.token]);
    const old = await request('GET', first.json.path, {
      headers: { 'x-forwarded-for': '203.0.113.82' },
    });
    assertClosed(old);
    const neu = await request('GET', rotated.json.path, {
      headers: { 'x-forwarded-for': '203.0.113.82' },
    });
    assert.equal(neu.status, 200);
    tokens._clearCacheForTests();
    const page = await request('GET', '/p/pilot-stable-link', {
      headers: { 'x-forwarded-for': '203.0.113.83' },
    });
    assert.equal(tokenFromPath(ctaHref(page.text)), rotated.json.token);
    assert.equal((await tokenStats(row.id)).n, 2);
  });

  it('does not mint again on twenty cold one-pager views after revoke', async () => {
    await setFlags({ master: true, link: true });
    const row = await insertProposal(prospect.id, { slug: 'pilot-revoke-sticks' });
    const key = { 'x-api-key': API_KEY, 'x-forwarded-for': '203.0.113.90' };
    const minted = await request('POST', `/api/proposals/${row.id}/demo-token`, { headers: key });
    assert.equal(minted.status, 201);
    const before = await tokenStats(row.id);
    assert.equal(before.active, 1);

    const revoke = await request('POST', `/api/proposals/${row.id}/demo-token/revoke`, { headers: key });
    assert.equal(revoke.status, 200);
    const revoked = await tokenStats(row.id);
    assert.equal(revoked.n, before.n);
    assert.equal(revoked.active, 0);
    assert.equal(revoked.max_id, before.max_id);
    const flag = await pool.query('SELECT demo_revoked_at FROM proposals WHERE id = $1', [row.id]);
    assert.ok(flag.rows[0].demo_revoked_at);

    for (let i = 0; i < 20; i += 1) {
      tokens._clearCacheForTests();
      const page = await request('GET', '/p/pilot-revoke-sticks', {
        headers: { 'x-forwarded-for': `198.51.100.${i + 1}` },
      });
      assert.equal(page.status, 200, `view ${i}`);
      assert.equal(page.text.includes('Try a live demo'), false, `cta ${i}`);
      assert.equal(page.text.includes('data-pilot'), false, `pilot ${i}`);
    }

    const after = await tokenStats(row.id);
    assert.deepEqual(after, revoked);
    const demo = await request('GET', minted.json.path, {
      headers: { 'x-forwarded-for': '203.0.113.91' },
    });
    assertClosed(demo);
  });

  it('matches the closed 404 shape for a flags-off response and a 429', async () => {
    await clearFlags();
    const off = await request('GET', '/demo/estimate-recovery/demo-example-heating-air', {
      headers: { 'x-forwarded-for': '203.0.113.120' },
    });
    await setFlags({ master: true });
    const missing = await request('GET', `/demo/estimate-recovery/${'d'.repeat(22)}`, {
      headers: { 'x-forwarded-for': '203.0.113.121' },
    });
    assertClosed(off);
    assertClosed(missing);
    assert.equal(off.status, missing.status);
    assert.deepEqual(off.json, missing.json);
    assert.equal(off.headers['x-robots-tag'], missing.headers['x-robots-tag']);
    assert.equal(off.headers['cache-control'], missing.headers['cache-control']);
    assert.equal(off.headers['content-type'], missing.headers['content-type']);

    process.env.PILOT_DEMO_RATE_MAX = '1';
    process.env.PILOT_DEMO_RATE_WINDOW_MS = '60000';
    _resetForTests();
    const ip = { 'x-forwarded-for': '203.0.113.122' };
    const first = await request('GET', `/demo/estimate-recovery/${'e'.repeat(22)}`, { headers: ip });
    const limited = await request('GET', `/demo/estimate-recovery/${'e'.repeat(22)}`, { headers: ip });
    assertClosed(first);
    assert.equal(limited.status, 429);
    assert.deepEqual(limited.json, { error: 'Too many requests' });
    assert.equal(limited.headers['x-robots-tag'], missing.headers['x-robots-tag']);
    assert.equal(limited.headers['cache-control'], missing.headers['cache-control']);
    assert.equal(limited.headers['content-type'], missing.headers['content-type']);
    assert.ok(Number(limited.headers['retry-after']) >= 1);
    assert.equal(limited.text.includes('expired'), false);
    assert.equal(limited.text.includes('revoked'), false);
  });

  it('stamps noindex and no-store on an oversized demo body', async () => {
    await clearFlags();
    const body = Buffer.alloc(1024 * 1024 + 64, 0x61);
    const res = await request('POST', '/demo/estimate-recovery/demo-example-heating-air/events', {
      headers: { 'x-forwarded-for': '203.0.113.130' },
      rawBody: body,
    });
    assert.equal(res.status, 413);
    assert.deepEqual(res.json, { error: 'Payload too large' });
    assert.equal(res.headers['x-robots-tag'], 'noindex, nofollow');
    assert.equal(res.headers['cache-control'], 'no-store');
    assert.equal(res.text.includes('PayloadTooLargeError'), false);
    assert.equal(res.text.includes('entity.too.large'), false);
    assert.ok(res.text.length < 200);
  });

  it('rate limits the right-most trusted hop, not a spoofed left-most address', async () => {
    const app = express();
    app.set('trust proxy', 1);
    const trusted = {
      app,
      headers: { 'x-forwarded-for': '198.51.100.9, 203.0.113.50' },
      socket: { remoteAddress: '10.0.0.8' },
    };
    assert.equal(clientIp(trusted), '203.0.113.50');
    app.set('trust proxy', false);
    assert.equal(clientIp(trusted), '10.0.0.8');
    app.set('trust proxy', 1);

    await setFlags({ master: true });
    process.env.PILOT_DEMO_RATE_MAX = '1';
    process.env.PILOT_DEMO_RATE_WINDOW_MS = '60000';
    _resetForTests();
    const path = `/demo/estimate-recovery/${'f'.repeat(22)}`;
    const first = await request('GET', path, {
      headers: { 'x-forwarded-for': '198.51.100.9, 203.0.113.140' },
    });
    const sameClient = await request('GET', path, {
      headers: { 'x-forwarded-for': '198.51.100.8, 203.0.113.140' },
    });
    const otherClient = await request('GET', path, {
      headers: { 'x-forwarded-for': '203.0.113.140, 203.0.113.141' },
    });
    assertClosed(first);
    assert.equal(sameClient.status, 429);
    assert.equal(sameClient.headers['x-robots-tag'], 'noindex, nofollow');
    assert.equal(sameClient.headers['cache-control'], 'no-store');
    assertClosed(otherClient);
  });

  it('stays closed when CRM_API_KEY is missing', async () => {
    const saved = process.env.CRM_API_KEY;
    const origWarn = console.warn;
    const lines = [];
    console.warn = (...args) => {
      lines.push(args.map((part) => String(part)).join(' '));
    };
    try {
      process.env.CRM_API_KEY = '';
      tokens._clearCacheForTests();
      await setFlags({ master: true, link: true });
      const row = await insertProposal(prospect.id, { slug: 'pilot-no-secret' });
      const before = await pool.query('SELECT COUNT(*)::int AS n FROM pilot_tokens');
      const page = await request('GET', '/p/pilot-no-secret', {
        headers: { 'x-forwarded-for': '203.0.113.150' },
      });
      assert.equal(page.status, 200);
      assert.equal(page.text.includes('Try a live demo'), false);
      assert.equal(page.text.includes('data-pilot'), false);
      const demo = await request('GET', `/demo/estimate-recovery/${'a'.repeat(43)}`, {
        headers: { 'x-forwarded-for': '203.0.113.151' },
      });
      assertClosed(demo);
      const minted = await request('POST', `/api/proposals/${row.id}/demo-token`, {
        headers: { 'x-api-key': API_KEY, 'x-forwarded-for': '203.0.113.152' },
      });
      assert.equal(minted.status, 404);
      assert.deepEqual(minted.json, NOT_FOUND);
      const after = await pool.query('SELECT COUNT(*)::int AS n FROM pilot_tokens');
      assert.equal(after.rows[0].n, before.rows[0].n);
      assert.ok(lines.some((line) => line.includes('CRM_API_KEY') && line.includes('[pilot]')));
      assert.equal(lines.some((line) => line.includes(saved)), false);
    } finally {
      console.warn = origWarn;
      process.env.CRM_API_KEY = saved;
      tokens._clearCacheForTests();
    }
  });

  it('stays closed when CRM_API_KEY is shorter than 32 characters', async () => {
    const saved = process.env.CRM_API_KEY;
    const short = 'short-pilot-key-not-32chars!';
    assert.ok(short.length < 32);
    assert.ok(short.length > 0);
    const origWarn = console.warn;
    const lines = [];
    console.warn = (...args) => {
      lines.push(args.map((part) => String(part)).join(' '));
    };
    try {
      process.env.CRM_API_KEY = 'x'.repeat(31);
      tokens._clearCacheForTests();
      assert.equal(tokens.pilotReady(), false);
      process.env.CRM_API_KEY = 'x'.repeat(32);
      tokens._clearCacheForTests();
      assert.equal(tokens.pilotReady(), true);

      process.env.CRM_API_KEY = short;
      tokens._clearCacheForTests();
      assert.equal(tokens.pilotReady(), false);
      await setFlags({ master: true, link: true });
      const row = await insertProposal(prospect.id, { slug: 'pilot-short-secret' });
      const before = await pool.query('SELECT COUNT(*)::int AS n FROM pilot_tokens');
      const page = await request('GET', '/p/pilot-short-secret', {
        headers: { 'x-forwarded-for': '203.0.113.170' },
      });
      assert.equal(page.status, 200);
      assert.equal(page.text.includes('Try a live demo'), false);
      assert.equal(page.text.includes('data-pilot'), false);
      const demo = await request('GET', `/demo/estimate-recovery/${'b'.repeat(43)}`, {
        headers: { 'x-forwarded-for': '203.0.113.171' },
      });
      assertClosed(demo);
      const minted = await request('POST', `/api/proposals/${row.id}/demo-token`, {
        headers: { 'x-api-key': API_KEY, 'x-forwarded-for': '203.0.113.172' },
      });
      assert.equal(minted.status, 404);
      assert.deepEqual(minted.json, NOT_FOUND);
      const after = await pool.query('SELECT COUNT(*)::int AS n FROM pilot_tokens');
      assert.equal(after.rows[0].n, before.rows[0].n);
      assert.ok(lines.some((line) => line.includes('32') && line.includes('[pilot]')));
      assert.equal(lines.some((line) => line.includes(short)), false);
      assert.equal(lines.some((line) => line.includes(saved)), false);
    } finally {
      console.warn = origWarn;
      process.env.CRM_API_KEY = saved;
      tokens._clearCacheForTests();
    }
  });

  it('closes the pilot when boot repair is blocked, and repairs a healthy boot', async () => {
    const mainSchema = fs.readFileSync(path.join(__dirname, '../src/db/schema.sql'), 'utf8');
    assert.match(mainSchema, /CREATE TABLE IF NOT EXISTS pilot_tokens/);
    assert.match(mainSchema, /CREATE TABLE IF NOT EXISTS pilot_events/);
    assert.match(mainSchema, /CREATE TABLE IF NOT EXISTS pilot_boot_errors/);
    assert.match(mainSchema, /ADD COLUMN IF NOT EXISTS demo_revoked_at/);
    assert.match(mainSchema, /ADD COLUMN IF NOT EXISTS generation/);
    assert.match(mainSchema, /ADD COLUMN IF NOT EXISTS derived/);
    assert.match(mainSchema, /CREATE OR REPLACE FUNCTION pilot_boot_failure/);
    assert.equal(mainSchema.includes('idx_pilot_tokens_one_active'), false);
    assert.equal(mainSchema.includes('lock_timeout'), false);
    assert.equal(mainSchema.includes('statement_timeout'), false);
    const schema = fs.readFileSync(path.join(__dirname, '../src/db/pilot-schema.sql'), 'utf8');
    assert.equal(schema.includes('CREATE TABLE'), false);
    assert.equal(schema.includes('ADD COLUMN'), false);
    const blocks = schema.match(/DO \$\$[\s\S]*?END \$\$;/g) || [];
    const repair = blocks.filter((block) => block.includes('pilot_tokens'));
    assert.ok(repair.length >= 4);
    const repairSql = repair.join('\n');
    assert.match(repairSql, /generation IS NULL/);
    assert.match(repairSql, /n\.id > t\.id/);
    assert.match(repairSql, /COALESCE\(generation, 0\)/);
    assert.match(repairSql, /derived IS NOT TRUE/);
    assert.match(repairSql, /revoked_at = COALESCE\(revoked_at, NOW\(\)\)/);
    assert.match(repairSql, /ALTER COLUMN generation SET NOT NULL/);
    assert.match(repairSql, /idx_pilot_tokens_one_active/);
    assert.match(repairSql, /pilot_boot_failure/);
    assert.equal(repairSql.includes('INSERT INTO pilot_boot_errors'), false);
    assert.match(repairSql, /'55P03'/);
    assert.match(repairSql, /'57014'/);
    const legacyBlock = repair.find((block) => block.includes('revoke-legacy'));
    assert.ok(legacyBlock);
    assert.match(legacyBlock, /COALESCE\(generation, 0\)/);
    assert.match(legacyBlock, /revoked_at = COALESCE\(revoked_at, NOW\(\)\)/);
    for (const block of repair) assert.match(block, /EXCEPTION WHEN OTHERS/);

    async function watchBoot(report) {
      const errors = [];
      const logs = [];
      const origError = console.error;
      const origLog = console.log;
      console.error = (...args) => {
        errors.push(args.map((part) => String(part)).join(' '));
      };
      console.log = (...args) => {
        logs.push(args.map((part) => String(part)).join(' '));
      };
      try {
        const result = await concludeSchemaBoot(report);
        return { result, errors, logs };
      } finally {
        console.error = origError;
        console.log = origLog;
      }
    }

    const beforeBreak = await watchBoot(await applySchema());
    assert.equal(beforeBreak.result.ok, true);
    assert.equal(tokens.pilotReady(), true);
    assert.ok(beforeBreak.logs.some((line) => line.includes('Schema up to date')));
    assert.equal(beforeBreak.errors.some((line) => line.includes('schema is not safe')), false);

    const row = await insertProposal(prospect.id, { slug: 'pilot-boot-repair' });
    const hash = () => crypto.randomBytes(32);
    const legacyA = 'a'.repeat(43);
    const legacyB = 'b'.repeat(43);
    await pool.query('DROP INDEX IF EXISTS idx_pilot_tokens_one_active');
    await pool.query('ALTER TABLE pilot_tokens DROP COLUMN IF EXISTS generation');
    await pool.query('ALTER TABLE pilot_tokens ADD COLUMN IF NOT EXISTS token TEXT');
    await pool.query(
      `INSERT INTO pilot_tokens (proposal_id, prospect_id, token_hash, expires_at, revoked_at, token)
       VALUES
         ($1, $2, $3, NOW() + interval '14 days', NULL, $6),
         ($1, $2, $4, NOW() + interval '14 days', NULL, $7),
         ($1, $2, $5, NOW() + interval '14 days', NOW(), 'raw-legacy-token-revoked')`,
      [row.id, prospect.id, tokens.hashToken(legacyA), tokens.hashToken(legacyB), hash(), legacyA, legacyB]
    );
    await pool.query(`
      CREATE OR REPLACE FUNCTION ff_test_block_pilot_token_update() RETURNS trigger AS $fn$
      BEGIN
        RAISE EXCEPTION 'pilot boot update blocked ${API_KEY} ${legacyA}';
      END $fn$ LANGUAGE plpgsql;
      CREATE TRIGGER ff_test_block_pilot_token_update
        BEFORE UPDATE ON pilot_tokens
        FOR EACH ROW EXECUTE FUNCTION ff_test_block_pilot_token_update();
    `);
    try {
      const blocked = await applySchema();
      assert.ok(blocked.errors.some((line) => line.includes('pilot boot update blocked')));
      assert.ok(blocked.errors.some((line) => line.startsWith('unique-active-index:')));
      assert.ok(blocked.errors.some((line) => /^revoke-legacy: [0-9A-Z]{5}: /.test(line)));
      assert.ok(blocked.errors.some((line) => line.includes('[redacted]')));
      assert.equal(blocked.errors.some((line) => line.includes(API_KEY)), false);
      assert.equal(blocked.errors.some((line) => line.includes(legacyA)), false);
      const closed = await watchBoot(blocked);
      assert.equal(closed.result.ok, false);
      assert.ok(closed.errors.some((line) => line.includes('[pilot]') && line.includes('schema is not safe')));
      assert.ok(closed.errors.some((line) => line.includes('idx_pilot_tokens_one_active is missing')));
      assert.ok(closed.errors.some((line) => line.includes('pilot_tokens.generation is nullable')));
      assert.ok(closed.errors.some((line) => line.includes('more than one active demo token')));
      assert.equal(closed.logs.some((line) => line.includes('Schema up to date')), false);
      assert.equal(closed.errors.some((line) => line.includes(API_KEY)), false);
      assert.equal(closed.errors.some((line) => line.includes(legacyA)), false);
      assert.equal(tokens.pilotReady(), false);
      const during = await pool.query(
        `SELECT column_name, is_nullable
           FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = 'pilot_tokens'
            AND column_name IN ('token', 'generation')`
      );
      const duringCols = Object.fromEntries(during.rows.map((item) => [item.column_name, item.is_nullable]));
      assert.equal(duringCols.token, undefined);
      assert.equal(duringCols.generation, 'YES');
      const blockedIndex = await pool.query(
        `SELECT 1 FROM pg_indexes WHERE indexname = 'idx_pilot_tokens_one_active'`
      );
      assert.equal(blockedIndex.rows.length, 0);
      const stillActive = await pool.query(
        `SELECT COUNT(*)::int AS n FROM pilot_tokens
          WHERE proposal_id = $1 AND revoked_at IS NULL`,
        [row.id]
      );
      assert.equal(stillActive.rows[0].n, 2);

      await setFlags({ master: true, link: true });
      const quietPage = await request('GET', '/p/pilot-boot-repair', {
        headers: { 'x-forwarded-for': '203.0.113.183' },
      });
      assert.equal(quietPage.status, 200);
      assert.equal(ctaHref(quietPage.text), '');
      const quietDemo = await request('GET', `/demo/estimate-recovery/${legacyA}`, {
        headers: { 'x-forwarded-for': '203.0.113.184' },
      });
      assertClosed(quietDemo);
      const quietMint = await request('POST', `/api/proposals/${row.id}/demo-token`, {
        headers: { 'x-api-key': API_KEY, 'x-forwarded-for': '203.0.113.185' },
      });
      assert.equal(quietMint.status, 404);
      assert.deepEqual(quietMint.json, NOT_FOUND);
      const rest = await request('GET', '/api/proposals?view=review', {
        headers: { 'x-api-key': API_KEY, 'x-forwarded-for': '203.0.113.186' },
      });
      assert.equal(rest.status, 200);
      assert.ok(Array.isArray(rest.json.proposals));
      assert.ok(rest.json.proposals.some((item) => item.slug === 'pilot-boot-repair'));

      tokens.openPilot();
      assert.equal(tokens.pilotReady(), true);
      assert.equal(await tokens.resolveToken(legacyA), null);
      assert.equal(await tokens.resolveToken(legacyB), null);
      const dupPage = await request('GET', '/p/pilot-boot-repair', {
        headers: { 'x-forwarded-for': '203.0.113.187' },
      });
      assert.equal(dupPage.status, 200);
      assert.equal(ctaHref(dupPage.text), '');
      const dupDemo = await request('GET', `/demo/estimate-recovery/${legacyB}`, {
        headers: { 'x-forwarded-for': '203.0.113.188' },
      });
      assertClosed(dupDemo);
      tokens.closePilot();

      await pool.query('DROP TRIGGER ff_test_block_pilot_token_update ON pilot_tokens');
      await pool.query('DROP FUNCTION ff_test_block_pilot_token_update()');
      const repaired = await watchBoot(await applySchema());
      assert.equal(repaired.result.ok, true);
      assert.equal(tokens.pilotReady(), true);
      assert.ok(repaired.logs.some((line) => line.includes('Schema up to date')));
      assert.equal(repaired.errors.some((line) => line.includes('schema is not safe')), false);
      const second = await applySchema();
      assert.deepEqual(second.errors, []);
      const again = await watchBoot(second);
      assert.equal(again.result.ok, true);

      const after = await pool.query(
        `SELECT column_name, is_nullable
           FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = 'pilot_tokens'
            AND column_name IN ('token', 'generation')`
      );
      const afterCols = Object.fromEntries(after.rows.map((item) => [item.column_name, item.is_nullable]));
      assert.equal(afterCols.token, undefined);
      assert.equal(afterCols.generation, 'NO');
      const index = await pool.query(
        `SELECT indexdef FROM pg_indexes WHERE indexname = 'idx_pilot_tokens_one_active'`
      );
      assert.match(index.rows[0].indexdef, /UNIQUE/);
      const legacy = await pool.query(
        `SELECT generation, revoked_at IS NOT NULL AS revoked
           FROM pilot_tokens WHERE proposal_id = $1 ORDER BY id`,
        [row.id]
      );
      assert.equal(legacy.rows.length, 3);
      for (const item of legacy.rows) {
        assert.equal(Number(item.generation), 0);
        assert.equal(item.revoked, true);
      }
      const nulls = await pool.query(
        'SELECT COUNT(*)::int AS n FROM pilot_tokens WHERE generation IS NULL'
      );
      assert.equal(nulls.rows[0].n, 0);

      await pool.query('DROP INDEX IF EXISTS idx_pilot_tokens_one_active');
      const older = await pool.query(
        `INSERT INTO pilot_tokens (proposal_id, prospect_id, generation, token_hash, expires_at, derived)
         VALUES ($1, $2, 9, $3, NOW() + interval '14 days', TRUE) RETURNING id`,
        [row.id, prospect.id, hash()]
      );
      const newer = await pool.query(
        `INSERT INTO pilot_tokens (proposal_id, prospect_id, generation, token_hash, expires_at, derived)
         VALUES ($1, $2, 2, $3, NOW() + interval '14 days', TRUE) RETURNING id`,
        [row.id, prospect.id, hash()]
      );
      assert.ok(Number(newer.rows[0].id) > Number(older.rows[0].id));
      await applySchema();
      const active = await pool.query(
        `SELECT id, generation FROM pilot_tokens
          WHERE proposal_id = $1 AND revoked_at IS NULL`,
        [row.id]
      );
      assert.equal(active.rows.length, 1);
      assert.equal(Number(active.rows[0].id), Number(newer.rows[0].id));
      assert.equal(Number(active.rows[0].generation), 2);

      await setFlags({ master: true, link: true });
      const minted = await request('POST', `/api/proposals/${row.id}/demo-token`, {
        headers: { 'x-api-key': API_KEY, 'x-forwarded-for': '203.0.113.180' },
      });
      assert.equal(minted.status, 201);
      assert.equal(minted.json.token, tokens.deriveToken(row.id, 10));
      const page = await request('GET', '/p/pilot-boot-repair', {
        headers: { 'x-forwarded-for': '203.0.113.181' },
      });
      assert.equal(page.status, 200);
      assert.equal(ctaHref(page.text), minted.json.path);
      assert.match(page.text, /Try a live demo/);
      const demo = await request('GET', minted.json.path, {
        headers: { 'x-forwarded-for': '203.0.113.182' },
      });
      assert.equal(demo.status, 200);
      assert.equal(demo.json.company, 'Wasatch Heating');
      assert.equal(demo.json.synthetic, true);
    } finally {
      await pool.query('DROP TRIGGER IF EXISTS ff_test_block_pilot_token_update ON pilot_tokens');
      await pool.query('DROP FUNCTION IF EXISTS ff_test_block_pilot_token_update()');
      await applySchema();
      tokens._clearCacheForTests();
    }
  });

  it('keeps a legacy token closed on a revoke-only failure and on the next boot', async () => {
    async function watchBoot(report) {
      const errors = [];
      const logs = [];
      const origError = console.error;
      const origLog = console.log;
      console.error = (...args) => {
        errors.push(args.map((part) => String(part)).join(' '));
      };
      console.log = (...args) => {
        logs.push(args.map((part) => String(part)).join(' '));
      };
      try {
        const result = await concludeSchemaBoot(report);
        return { result, errors, logs };
      } finally {
        console.error = origError;
        console.log = origLog;
      }
    }

    const row = await insertProposal(prospect.id, { slug: 'pilot-legacy-revoke' });
    const legacy = 'c'.repeat(43);
    await pool.query('DROP INDEX IF EXISTS idx_pilot_tokens_one_active');
    await pool.query('ALTER TABLE pilot_tokens DROP COLUMN IF EXISTS generation');
    await pool.query('ALTER TABLE pilot_tokens DROP COLUMN IF EXISTS derived');
    const inserted = await pool.query(
      `INSERT INTO pilot_tokens (proposal_id, prospect_id, token_hash, expires_at)
       VALUES ($1, $2, $3, NOW() + interval '14 days') RETURNING id`,
      [row.id, prospect.id, tokens.hashToken(legacy)]
    );
    const tokenId = inserted.rows[0].id;
    await pool.query(`
      CREATE OR REPLACE FUNCTION ff_test_block_revoke_only() RETURNS trigger AS $fn$
      BEGIN
        IF NEW.revoked_at IS DISTINCT FROM OLD.revoked_at AND NEW.revoked_at IS NOT NULL THEN
          RAISE EXCEPTION 'revoke blocked';
        END IF;
        RETURN NEW;
      END
      $fn$ LANGUAGE plpgsql;
      CREATE TRIGGER ff_test_block_revoke_only
        BEFORE UPDATE ON pilot_tokens
        FOR EACH ROW EXECUTE FUNCTION ff_test_block_revoke_only();
    `);
    try {
      await setFlags({ master: true, link: true });
      const first = await watchBoot(await applySchema());
      assert.equal(first.result.ok, false);
      assert.ok(first.errors.some((line) => line.includes('revoke blocked')));
      assert.ok(first.errors.some((line) => line.includes('schema is not safe')));
      assert.equal(first.logs.some((line) => line.includes('Schema up to date')), false);
      assert.equal(tokens.pilotReady(), false);
      const liveZero = await pool.query(
        `SELECT COUNT(*)::int AS n FROM pilot_tokens
          WHERE id = $1 AND revoked_at IS NULL AND generation = 0`,
        [tokenId]
      );
      assert.equal(liveZero.rows[0].n, 0);
      const closedDemo = await request('GET', `/demo/estimate-recovery/${legacy}`, {
        headers: { 'x-forwarded-for': '203.0.113.200' },
      });
      assertClosed(closedDemo);
      tokens.openPilot();
      assert.equal(await tokens.resolveToken(legacy), null);
      const stillDemo = await request('GET', `/demo/estimate-recovery/${legacy}`, {
        headers: { 'x-forwarded-for': '203.0.113.201' },
      });
      assertClosed(stillDemo);
      tokens.closePilot();

      await pool.query('DROP TRIGGER ff_test_block_revoke_only ON pilot_tokens');
      await pool.query('DROP FUNCTION ff_test_block_revoke_only()');
      const second = await watchBoot(await applySchema());
      assert.equal(second.result.ok, true);
      assert.equal(tokens.pilotReady(), true);
      assert.ok(second.logs.some((line) => line.includes('Schema up to date')));
      assert.equal(second.errors.some((line) => line.includes('schema is not safe')), false);
      const stored = await pool.query(
        `SELECT generation, derived, revoked_at IS NOT NULL AS revoked
           FROM pilot_tokens WHERE id = $1`,
        [tokenId]
      );
      assert.equal(Number(stored.rows[0].generation), 0);
      assert.equal(stored.rows[0].derived, false);
      assert.equal(stored.rows[0].revoked, true);
      assert.equal(await tokens.resolveToken(legacy), null);
      const openedDemo = await request('GET', `/demo/estimate-recovery/${legacy}`, {
        headers: { 'x-forwarded-for': '203.0.113.202' },
      });
      assertClosed(openedDemo);

      await pool.query(
        `UPDATE pilot_tokens
            SET revoked_at = NULL, derived = TRUE, generation = 1
          WHERE id = $1`,
        [tokenId]
      );
      assert.equal(await tokens.resolveToken(legacy), null);
      const forged = await request('GET', `/demo/estimate-recovery/${legacy}`, {
        headers: { 'x-forwarded-for': '203.0.113.203' },
      });
      assertClosed(forged);
      const real = tokens.deriveToken(row.id, 1);
      await pool.query(
        `UPDATE pilot_tokens
            SET token_hash = $2, generation = 1, derived = TRUE, revoked_at = NULL
          WHERE id = $1`,
        [tokenId, tokens.hashToken(real)]
      );
      const resolved = await tokens.resolveToken(real);
      assert.equal(resolved && resolved.proposal_id, row.id);
      const live = await request('GET', `/demo/estimate-recovery/${real}`, {
        headers: { 'x-forwarded-for': '203.0.113.204' },
      });
      assert.equal(live.status, 200);
    } finally {
      await pool.query('DROP TRIGGER IF EXISTS ff_test_block_revoke_only ON pilot_tokens');
      await pool.query('DROP FUNCTION IF EXISTS ff_test_block_revoke_only()');
      await pool.query('DELETE FROM pilot_tokens WHERE proposal_id = $1', [row.id]);
      await applySchema();
      tokens._clearCacheForTests();
    }
  });

  it('listens within the boot lock timeout and keeps the pilot closed', async () => {
    const migrateSrc = fs.readFileSync(path.join(__dirname, '../src/db/migrate.js'), 'utf8');
    assert.match(migrateSrc, /SET LOCAL lock_timeout = '5s'/);
    assert.match(migrateSrc, /SET LOCAL statement_timeout = '15s'/);

    await setFlags({ master: true, link: true });
    await pool.query(`UPDATE prospects SET stage = 'vetted' WHERE id = $1`, [prospect.id]);
    const row = await insertProposal(prospect.id, { slug: 'pilot-lock-boot' });
    const minted = await request('POST', `/api/proposals/${row.id}/demo-token`, {
      headers: { 'x-api-key': API_KEY, 'x-forwarded-for': '203.0.113.210' },
    });
    assert.equal(minted.status, 201);

    const probe = http.createServer();
    const port = await new Promise((resolve, reject) => {
      probe.once('error', reject);
      probe.listen(0, '127.0.0.1', () => resolve(probe.address().port));
    });
    await new Promise((resolve) => probe.close(resolve));

    const holder = await pool.connect();
    let child;
    try {
      await holder.query('BEGIN');
      await holder.query('LOCK TABLE pilot_tokens IN ACCESS EXCLUSIVE MODE');
      const started = Date.now();
      child = spawn(process.execPath, [path.join(__dirname, '../src/server.js')], {
        env: {
          ...process.env,
          PORT: String(port),
          NODE_ENV: 'test',
          DISABLE_CRON: '1',
          FF_PILOT_ESTIMATE_RECOVERY: 'true',
          FF_PILOT_LINK_ON_ONEPAGER: 'true',
          CRM_API_KEY: API_KEY,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let output = '';
      child.stdout.on('data', (buf) => { output += buf.toString('utf8'); });
      child.stderr.on('data', (buf) => { output += buf.toString('utf8'); });
      const health = await new Promise((resolve, reject) => {
        const deadline = Date.now() + 15000;
        const attempt = () => {
          const req = http.request({
            method: 'GET', hostname: '127.0.0.1', port, path: '/health',
          }, (res) => {
            res.resume();
            res.on('end', () => resolve(res.statusCode));
          });
          req.on('error', () => {
            if (Date.now() > deadline) {
              reject(new Error(`server did not listen: ${JSON.stringify(output).slice(0, 2000)}`));
            }
            else setTimeout(attempt, 100);
          });
          req.end();
        };
        attempt();
      });
      const elapsed = Date.now() - started;
      assert.equal(health, 200);
      assert.ok(elapsed < 15000, `listen took ${elapsed}ms`);
      assert.match(output, /schema is not safe/);
      assert.equal(output.includes('Schema up to date'), false);
      assert.equal(output.includes('Startup migration/rescore failed'), false);
      assert.equal(output.includes(API_KEY), false);
      const stage = await pool.query('SELECT stage FROM prospects WHERE id = $1', [prospect.id]);
      assert.equal(stage.rows[0].stage, 'qualified');
      await holder.query('ROLLBACK');
      const demo = await request('GET', minted.json.path, {
        port,
        headers: { 'x-forwarded-for': '203.0.113.211' },
      });
      assert.equal(demo.status, 404);
      assert.deepEqual(demo.json, NOT_FOUND);
      const page = await request('GET', '/p/pilot-lock-boot', {
        port,
        headers: { 'x-forwarded-for': '203.0.113.212' },
      });
      assert.equal(page.status, 200);
      assert.equal(ctaHref(page.text), '');
      const list = await request('GET', '/api/proposals?view=review', {
        port,
        headers: { 'x-api-key': API_KEY, 'x-forwarded-for': '203.0.113.213' },
      });
      assert.equal(list.status, 200);
      assert.ok(Array.isArray(list.json.proposals));
    } finally {
      if (child && child.exitCode == null) {
        child.kill('SIGTERM');
        await new Promise((resolve) => child.once('exit', resolve));
      }
      await holder.query('ROLLBACK').catch(() => {});
      holder.release();
    }
  });

  it('commits the main schema when a non-pilot update is slow', async () => {
    await pool.query('ALTER TABLE prospects DROP COLUMN IF EXISTS fit_boost');
    await pool.query('DROP TABLE IF EXISTS ff_test_slow_boot');
    await pool.query('CREATE TABLE ff_test_slow_boot (id integer)');
    await pool.query('INSERT INTO ff_test_slow_boot (id) VALUES (1)');
    await pool.query(`UPDATE prospects SET stage = 'vetted' WHERE id = $1`, [prospect.id]);
    await pool.query(`
      CREATE OR REPLACE FUNCTION ff_test_slow_stage() RETURNS trigger AS $fn$
      BEGIN
        IF OLD.stage IS DISTINCT FROM NEW.stage AND NEW.id = ${Number(prospect.id)} THEN
          PERFORM pg_sleep(20);
          INSERT INTO ff_test_slow_boot (id) VALUES (2);
        END IF;
        RETURN NEW;
      END
      $fn$ LANGUAGE plpgsql;
      CREATE TRIGGER ff_test_slow_stage
        BEFORE UPDATE ON prospects
        FOR EACH ROW EXECUTE FUNCTION ff_test_slow_stage();
    `);
    try {
      const started = Date.now();
      const report = await applySchema();
      const elapsed = Date.now() - started;
      assert.ok(elapsed >= 19000, `main schema finished in ${elapsed}ms`);
      assert.equal(report.timedOut, false);
      assert.equal(report.rolledBack, false);
      const column = await pool.query(
        `SELECT 1 FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = 'prospects' AND column_name = 'fit_boost'`
      );
      assert.equal(column.rows.length, 1);
      const stage = await pool.query('SELECT stage FROM prospects WHERE id = $1', [prospect.id]);
      assert.equal(stage.rows[0].stage, 'qualified');
      const side = await pool.query('SELECT COUNT(*)::int AS n FROM ff_test_slow_boot');
      assert.equal(side.rows[0].n, 2);
      const concluded = await concludeSchemaBoot(report);
      assert.equal(concluded.ok, true);
    } finally {
      await pool.query('DROP TRIGGER IF EXISTS ff_test_slow_stage ON prospects');
      await pool.query('DROP FUNCTION IF EXISTS ff_test_slow_stage()');
      await pool.query('DROP TABLE IF EXISTS ff_test_slow_boot');
      await applySchema();
      tokens._clearCacheForTests();
    }
  });

  it('logs a main-schema failure without calling it a closed pilot', async () => {
    await pool.query('ALTER TABLE prospects DROP COLUMN IF EXISTS fit_boost');
    await pool.query(`UPDATE prospects SET stage = 'vetted' WHERE id = $1`, [prospect.id]);
    await pool.query(`
      CREATE OR REPLACE FUNCTION ff_test_block_stage() RETURNS trigger AS $fn$
      BEGIN
        IF OLD.stage IS DISTINCT FROM NEW.stage THEN
          RAISE EXCEPTION 'stage rename blocked';
        END IF;
        RETURN NEW;
      END
      $fn$ LANGUAGE plpgsql;
      CREATE TRIGGER ff_test_block_stage
        BEFORE UPDATE ON prospects
        FOR EACH ROW EXECUTE FUNCTION ff_test_block_stage();
    `);

    const probe = http.createServer();
    const port = await new Promise((resolve, reject) => {
      probe.once('error', reject);
      probe.listen(0, '127.0.0.1', () => resolve(probe.address().port));
    });
    await new Promise((resolve) => probe.close(resolve));

    let child;
    try {
      const started = Date.now();
      child = spawn(process.execPath, [path.join(__dirname, '../src/server.js')], {
        env: {
          ...process.env,
          PORT: String(port),
          NODE_ENV: 'test',
          DISABLE_CRON: '1',
          FF_PILOT_ESTIMATE_RECOVERY: 'true',
          FF_PILOT_LINK_ON_ONEPAGER: 'true',
          CRM_API_KEY: API_KEY,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let output = '';
      child.stdout.on('data', (buf) => { output += buf.toString('utf8'); });
      child.stderr.on('data', (buf) => { output += buf.toString('utf8'); });
      const health = await new Promise((resolve, reject) => {
        const deadline = Date.now() + 15000;
        const attempt = () => {
          const req = http.request({
            method: 'GET', hostname: '127.0.0.1', port, path: '/health',
          }, (res) => {
            res.resume();
            res.on('end', () => resolve(res.statusCode));
          });
          req.on('error', () => {
            if (Date.now() > deadline) {
              reject(new Error(`server did not listen: ${JSON.stringify(output).slice(0, 2000)}`));
            } else setTimeout(attempt, 100);
          });
          req.end();
        };
        attempt();
      });
      const elapsed = Date.now() - started;
      assert.equal(health, 200);
      assert.ok(elapsed < 15000, `listen took ${elapsed}ms`);
      assert.match(output, /Startup migration\/rescore failed/);
      assert.match(output, /stage rename blocked/);
      assert.equal(output.includes('schema is not safe'), false);
      assert.equal(output.includes('Schema up to date'), false);
      assert.equal(output.includes('Fit scores refreshed'), false);
      assert.equal(output.includes(API_KEY), false);
      const column = await pool.query(
        `SELECT 1 FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = 'prospects' AND column_name = 'fit_boost'`
      );
      assert.equal(column.rows.length, 0);
      const stage = await pool.query('SELECT stage FROM prospects WHERE id = $1', [prospect.id]);
      assert.equal(stage.rows[0].stage, 'vetted');
    } finally {
      if (child && child.exitCode == null) {
        child.kill('SIGTERM');
        await new Promise((resolve) => child.once('exit', resolve));
      }
      await pool.query('DROP TRIGGER IF EXISTS ff_test_block_stage ON prospects');
      await pool.query('DROP FUNCTION IF EXISTS ff_test_block_stage()');
      await applySchema();
      tokens._clearCacheForTests();
    }
  });

  it('discards a draft when pilot structures are missing, without echoing the database', async () => {
    await setFlags({ master: true });
    const key = { 'x-api-key': API_KEY, 'x-forwarded-for': '203.0.113.220' };
    const row = await insertProposal(prospect.id, { slug: 'pilot-discard-missing' });
    const minted = await request('POST', `/api/proposals/${row.id}/demo-token`, { headers: key });
    assert.equal(minted.status, 201);
    let renamedTable = false;
    let renamedColumn = false;
    try {
      await pool.query('ALTER TABLE pilot_tokens RENAME TO pilot_tokens_hidden');
      renamedTable = true;
      await pool.query('ALTER TABLE proposals RENAME COLUMN demo_revoked_at TO demo_revoked_at_hidden');
      renamedColumn = true;
      const dropped = await request('POST', `/api/proposals/${row.id}/discard`, { headers: key, body: {} });
      const leaked = ['does not exist', 'column "', 'relation "', 'pilot_tokens', API_KEY, minted.json.token];
      for (const fragment of leaked) assert.equal(dropped.text.includes(fragment), false, fragment);
      const stored = await pool.query(
        'SELECT status, demo_revoked_at_hidden FROM proposals WHERE id = $1',
        [row.id]
      );
      const fixedError = dropped.status === 500
        && dropped.json
        && dropped.json.error === 'Something went wrong.'
        && Object.keys(dropped.json).length === 1;
      if (dropped.status === 200) {
        assert.equal(dropped.json.status, 'discarded');
        assert.equal(stored.rows[0].status, 'discarded');
        assert.equal(stored.rows[0].demo_revoked_at_hidden, null);
      } else {
        assert.equal(fixedError, true, dropped.text);
        assert.equal(stored.rows[0].status, 'draft');
        assert.equal(stored.rows[0].demo_revoked_at_hidden, null);
      }
    } finally {
      if (renamedColumn) {
        await pool.query('ALTER TABLE proposals RENAME COLUMN demo_revoked_at_hidden TO demo_revoked_at');
      }
      if (renamedTable) {
        await pool.query('ALTER TABLE pilot_tokens_hidden RENAME TO pilot_tokens');
      }
      if (renamedTable) {
        const left = await pool.query(
          `SELECT COUNT(*)::int AS n FROM pilot_tokens
            WHERE proposal_id = $1 AND revoked_at IS NULL`,
          [row.id]
        );
        assert.equal(left.rows[0].n, 1);
      }
    }
  });

  it('rolls the discard back when revoking the demo token fails', async () => {
    await setFlags({ master: true });
    const key = { 'x-api-key': API_KEY, 'x-forwarded-for': '203.0.113.221' };
    const row = await insertProposal(prospect.id, { slug: 'pilot-discard-rollback' });
    const minted = await request('POST', `/api/proposals/${row.id}/demo-token`, { headers: key });
    assert.equal(minted.status, 201);
    const secret = `discard revoke blocked ${API_KEY}`;
    await pool.query(`
      CREATE OR REPLACE FUNCTION ff_test_block_discard_revoke() RETURNS trigger AS $fn$
      BEGIN
        RAISE EXCEPTION 'discard revoke blocked ${API_KEY}';
      END
      $fn$ LANGUAGE plpgsql;
      CREATE TRIGGER ff_test_block_discard_revoke
        BEFORE UPDATE ON pilot_tokens
        FOR EACH ROW EXECUTE FUNCTION ff_test_block_discard_revoke();
    `);
    const origError = console.error;
    const lines = [];
    console.error = (...args) => {
      lines.push(args.map((part) => String(part)).join(' '));
    };
    try {
      const dropped = await request('POST', `/api/proposals/${row.id}/discard`, {
        headers: key,
        body: { reason: 'TEST: discard rollback' },
      });
      assert.equal(dropped.status, 500);
      assert.deepEqual(dropped.json, { error: 'Something went wrong.' });
      assert.equal(dropped.text.includes(secret), false);
      assert.equal(dropped.text.includes(API_KEY), false);
      assert.equal(dropped.text.includes('pilot_tokens'), false);
      assert.equal(dropped.text.includes('does not exist'), false);
      const stored = await pool.query(
        'SELECT status, stop_reason, demo_revoked_at FROM proposals WHERE id = $1',
        [row.id]
      );
      assert.equal(stored.rows[0].status, 'draft');
      assert.equal(stored.rows[0].stop_reason, null);
      assert.equal(stored.rows[0].demo_revoked_at, null);
      const active = await pool.query(
        `SELECT COUNT(*)::int AS n FROM pilot_tokens
          WHERE proposal_id = $1 AND revoked_at IS NULL`,
        [row.id]
      );
      assert.equal(active.rows[0].n, 1);
      assert.equal(lines.filter((line) => line.includes('[proposals] discard failed') && line.includes(API_KEY)).length, 1);
      assert.equal(dropped.text.includes('discard revoke blocked'), false);
    } finally {
      console.error = origError;
      await pool.query('DROP TRIGGER IF EXISTS ff_test_block_discard_revoke ON pilot_tokens');
      await pool.query('DROP FUNCTION IF EXISTS ff_test_block_discard_revoke()');
    }
  });

  it('stores a redacted boot error with the step and SQLSTATE', async () => {
    const token = 'b'.repeat(43);
    const step = `redact-${'s'.repeat(90)}`;
    const noise = `boom\u0001\u0007 ${API_KEY} ${token} idx_pilot_tokens_one_active ${'z'.repeat(400)}`;
    try {
      await pool.query('SELECT pilot_boot_failure($1, $2, $3)', [step, 'P0001', noise]);
      await pool.query(
        'SELECT pilot_boot_failure($1, $2, $3)',
        ['keep-index-name', '23505', 'could not create unique index idx_pilot_tokens_one_active']
      );
      const { rows } = await pool.query(
        `SELECT step, message, length(message) AS n
           FROM pilot_boot_errors
          WHERE step = left($1, 80) OR step = 'keep-index-name'
          ORDER BY id`,
        [step]
      );
      assert.equal(rows.length, 2);
      assert.equal(rows[0].step, step.slice(0, 80));
      assert.equal(rows[0].step.length, 80);
      assert.match(rows[0].message, /^P0001: /);
      assert.equal(rows[0].message.includes(API_KEY), false);
      assert.equal(rows[0].message.includes(token), false);
      assert.equal(rows[0].message.includes('\u0001'), false);
      assert.equal(rows[0].message.includes('\u0007'), false);
      assert.match(rows[0].message, /\[redacted\]/);
      assert.match(rows[0].message, /idx_pilot_tokens_one_active/);
      assert.ok(rows[0].n <= 240);
      assert.equal(rows[0].message.includes('z'.repeat(200)), false);
      assert.match(rows[1].message, /^23505: /);
      assert.match(rows[1].message, /idx_pilot_tokens_one_active/);
    } finally {
      await pool.query(
        `DELETE FROM pilot_boot_errors
          WHERE step = left($1, 80) OR step = 'keep-index-name'`,
        [step]
      );
    }
  });

  it('keeps the pilot closed until boot checks finish', async () => {
    const tokensSrc = fs.readFileSync(path.join(__dirname, '../src/pilot/tokens.js'), 'utf8');
    assert.match(tokensSrc, /let schemaClosed = true/);
    const serverSrc = fs.readFileSync(path.join(__dirname, '../src/server.js'), 'utf8');
    const bootSrc = serverSrc.slice(serverSrc.indexOf('async function boot'));
    const concludeAt = bootSrc.indexOf('concludeSchemaBoot');
    const closeAt = bootSrc.indexOf('closePilot');
    const listenAt = bootSrc.indexOf('app.listen');
    assert.ok(concludeAt > 0 && concludeAt < listenAt);
    assert.ok(closeAt > 0 && closeAt < listenAt);

    await setFlags({ master: true, link: true });
    const row = await insertProposal(prospect.id, { slug: 'pilot-closed-until-boot' });
    const script = `
const http = require('http');
const express = require('express');
const tokens = require('./src/pilot/tokens');
const { applySchema } = require('./src/db/migrate');
const { concludeSchemaBoot } = require('./src/pilot/schema');
const pilotDemo = require('./src/pilot/demo');
const pool = require('./src/db/client');

function get(port, reqPath) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      method: 'GET', hostname: '127.0.0.1', port, path: reqPath,
      headers: { 'x-forwarded-for': '203.0.113.230' },
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch (err) { json = null; }
        resolve({
          status: res.statusCode,
          text,
          json,
          robots: res.headers['x-robots-tag'] || '',
          cache: res.headers['cache-control'] || '',
        });
      });
    });
    req.on('error', reject);
    req.end();
  });
}

async function main() {
  const proposalId = Number(process.argv[1]);
  const prospectId = Number(process.argv[2]);
  const beforeReady = tokens.pilotReady();
  const token = tokens.deriveToken(proposalId, 1);
  if (!token) throw new Error('derive failed');
  await pool.query(
    "INSERT INTO pilot_tokens (proposal_id, prospect_id, generation, derived, token_hash, expires_at) VALUES (\$1, \$2, 1, TRUE, \$3, NOW() + interval '14 days')",
    [proposalId, prospectId, tokens.hashToken(token)]
  );
  const app = express();
  app.set('trust proxy', 1);
  app.use('/demo/estimate-recovery', pilotDemo.router);
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const path = '/demo/estimate-recovery/' + encodeURIComponent(token);
  const closed = await get(server.address().port, path);
  const logs = [];
  const origLog = console.log;
  const origError = console.error;
  console.log = (...args) => { logs.push(args.map((part) => String(part)).join(' ')); };
  console.error = (...args) => { logs.push(args.map((part) => String(part)).join(' ')); };
  const result = await concludeSchemaBoot(await applySchema());
  console.log = origLog;
  console.error = origError;
  const opened = await get(server.address().port, path);
  await pool.query('DELETE FROM pilot_tokens WHERE proposal_id = \$1', [proposalId]);
  server.close();
  await pool.end();
  process.stdout.write(JSON.stringify({
    beforeReady,
    closedStatus: closed.status,
    closedText: closed.text,
    closedRobots: closed.robots,
    closedCache: closed.cache,
    bootOk: result.ok,
    logs,
    afterReady: tokens.pilotReady(),
    openStatus: opened.status,
    openCompany: opened.json && opened.json.company,
    openSynthetic: opened.json && opened.json.synthetic,
  }));
  process.exit(0);
}

main().catch(async (err) => {
  const secret = process.env.CRM_API_KEY || '';
  let text = String(err && err.message || err);
  if (secret) text = text.split(secret).join('[redacted]');
  console.error(text);
  try { await require('./src/db/client').end(); } catch (ignore) {}
  process.exit(1);
});
`;
    const child = spawn(process.execPath, ['-e', script, String(row.id), String(prospect.id)], {
      cwd: path.join(__dirname, '..'),
      env: {
        ...process.env,
        NODE_ENV: 'test',
        DISABLE_CRON: '1',
        FF_PILOT_ESTIMATE_RECOVERY: 'true',
        FF_PILOT_LINK_ON_ONEPAGER: 'true',
        CRM_API_KEY: API_KEY,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (buf) => { stdout += buf.toString('utf8'); });
    child.stderr.on('data', (buf) => { stderr += buf.toString('utf8'); });
    const code = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        child.kill('SIGTERM');
        reject(new Error(`closed-latch child hung: ${stderr.slice(0, 500)}`));
      }, 20000);
      child.once('exit', (status) => {
        clearTimeout(timer);
        resolve(status);
      });
    });
    assert.equal(code, 0, stderr.slice(0, 500));
    assert.equal(stderr.includes(API_KEY), false);
    assert.equal(stdout.includes(API_KEY), false);
    const report = JSON.parse(stdout);
    assert.ok(report.logs.some((line) => line.includes('Schema up to date')));
    assert.equal(report.logs.some((line) => line.includes('schema is not safe')), false);
    assert.equal(report.beforeReady, false);
    assert.equal(report.closedStatus, 404);
    assert.equal(report.closedText, JSON.stringify(NOT_FOUND));
    assert.equal(report.closedRobots, 'noindex, nofollow');
    assert.equal(report.closedCache, 'no-store');
    assert.equal(report.bootOk, true);
    assert.equal(report.afterReady, true);
    assert.equal(report.openStatus, 200);
    assert.equal(report.openCompany, 'Wasatch Heating');
    assert.equal(report.openSynthetic, true);
    await pool.query('DELETE FROM pilot_tokens WHERE proposal_id = $1', [row.id]);
  });
});
