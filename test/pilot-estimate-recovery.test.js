require('./preload');

// Pin pilot flags off before dotenv (loaded by the db client) can refill them.
process.env.FF_PILOT_ESTIMATE_RECOVERY = '';
process.env.FF_PILOT_LINK_ON_ONEPAGER = '';
process.env.FF_PILOT_ESTIMATE_SMS = '';
process.env.PILOT_DEMO_BASE_URL = '';
process.env.PILOT_DEMO_RATE_MAX = '';
process.env.PILOT_DEMO_RATE_WINDOW_MS = '';
process.env.CRM_API_KEY = 'test-pilot-key';

const { describe, it, before, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const path = require('path');
const express = require('express');

const { applySchema } = require('../src/db/migrate');
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

const API_KEY = 'test-pilot-key';
const NOT_FOUND = { error: 'Not found' };
const PROSPECT_EMAIL = 'dana@wasatchheating.test';
const PROSPECT_PHONE = '(801) 555-0191';
const PROSPECT_NAME = 'Dana Reyes';

let server;
let base;
let prospect;
let proposal;
const calls = { send: 0, draft: 0, places: 0, gmail: 0, approve: 0 };

function clearFlags() {
  process.env.FF_PILOT_ESTIMATE_RECOVERY = '';
  process.env.FF_PILOT_LINK_ON_ONEPAGER = '';
  process.env.FF_PILOT_ESTIMATE_SMS = '';
}

function setFlags({ master = false, link = false, sms = false } = {}) {
  process.env.FF_PILOT_ESTIMATE_RECOVERY = master ? 'true' : '';
  process.env.FF_PILOT_LINK_ON_ONEPAGER = link ? 'true' : '';
  process.env.FF_PILOT_ESTIMATE_SMS = sms ? 'true' : '';
}

function request(method, reqPath, { headers = {}, body, rawBody } = {}) {
  return new Promise((resolve, reject) => {
    const payload = rawBody != null
      ? (Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(rawBody))
      : (body === undefined ? null : Buffer.from(JSON.stringify(body)));
    const req = http.request({
      method,
      hostname: '127.0.0.1',
      port: server.address().port,
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
  'created_at', 'expires_at', 'id', 'proposal_id', 'prospect_id', 'revoked_at', 'token_hash',
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

  afterEach(() => {
    clearFlags();
    delete process.env.PILOT_DEMO_RATE_MAX;
    delete process.env.PILOT_DEMO_RATE_WINDOW_MS;
    process.env.PILOT_DEMO_RATE_MAX = '';
    process.env.PILOT_DEMO_RATE_WINDOW_MS = '';
    process.env.PILOT_DEMO_BASE_URL = '';
    _resetForTests();
    tokens._clearCacheForTests();
  });

  it('keeps every pilot flag off unless the env value is exactly true', () => {
    clearFlags();
    assert.deepEqual(flags.flags(), {
      FF_PILOT_ESTIMATE_RECOVERY: false,
      FF_PILOT_LINK_ON_ONEPAGER: false,
      FF_PILOT_ESTIMATE_SMS: false,
    });
    for (const value of ['1', 'TRUE', 'True', 'yes', ' true', 'true ', 'on']) {
      process.env.FF_PILOT_ESTIMATE_RECOVERY = value;
      process.env.FF_PILOT_LINK_ON_ONEPAGER = value;
      process.env.FF_PILOT_ESTIMATE_SMS = value;
      assert.equal(flags.masterOn(), false, value);
      assert.equal(flags.linkOn(), false, value);
      assert.equal(flags.smsOn(), false, value);
    }
    setFlags({ master: true, link: true, sms: true });
    assert.equal(flags.masterOn(), true);
    assert.equal(flags.linkOn(), true);
    assert.equal(flags.smsOn(), true);
  });

  it('returns 404 with no one-pager CTA when the master flag is off', async () => {
    clearFlags();
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
    setFlags({ master: true, link: false });
    const masterOnly = await request('GET', '/p/pilot-wasatch-heating');
    assert.equal(masterOnly.status, 200);
    assert.equal(masterOnly.text.includes('Try a live demo'), false);

    clearFlags();
    setFlags({ master: false, link: true });
    const linkOnly = await request('GET', '/p/pilot-wasatch-heating');
    assert.equal(linkOnly.status, 200);
    assert.equal(linkOnly.text.includes('Try a live demo'), false);
    const closed = await request('GET', `/demo/estimate-recovery/${'a'.repeat(22)}`);
    assertClosed(closed);

    const { rows } = await pool.query('SELECT COUNT(*)::int AS n FROM pilot_tokens');
    assert.equal(rows[0].n, 0);
  });

  it('mints a 16-byte token, looks it up by hash, and serves the synthetic payload', async () => {
    setFlags({ master: true, link: true });
    const sizes = [];
    const original = crypto.randomBytes;
    crypto.randomBytes = function randomBytes(size, ...rest) {
      sizes.push(size);
      return original.call(this, size, ...rest);
    };
    let minted;
    try {
      minted = await request('POST', `/api/proposals/${proposal.id}/demo-token`, {
        headers: { 'x-api-key': API_KEY },
      });
    } finally {
      crypto.randomBytes = original;
    }

    assert.equal(minted.status, 201);
    assert.equal(minted.headers['cache-control'], 'no-store');
    assert.equal(typeof minted.json.token, 'string');
    assert.match(minted.json.token, /^[A-Za-z0-9_-]{22}$/);
    assert.equal(Buffer.from(minted.json.token, 'base64url').length, 16);
    assert.ok(sizes.some((n) => n >= 16));
    assert.equal(minted.json.path, `/demo/estimate-recovery/${minted.json.token}`);
    assert.equal(JSON.stringify(minted.json).includes(PROSPECT_EMAIL), false);

    const stored = await pool.query(
      `SELECT id, proposal_id, prospect_id, token_hash, expires_at, revoked_at
         FROM pilot_tokens WHERE proposal_id = $1 AND revoked_at IS NULL`,
      [proposal.id]
    );
    assert.equal(stored.rows.length, 1);
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
    setFlags({ master: true });
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
    setFlags({ master: true });
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
    setFlags({ master: true, sms: true });
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
    assert.equal(flags.smsOn(), true);

    const lead = await pool.query('SELECT stage FROM prospects WHERE id = $1', [prospect.id]);
    const saved = await pool.query('SELECT status, sent_at FROM proposals WHERE id = $1', [proposal.id]);
    assert.equal(lead.rows[0].stage, 'found');
    assert.equal(saved.rows[0].status, 'draft');
    assert.equal(saved.rows[0].sent_at, null);
  });

  it('does not mint on a public route and requires the API key', async () => {
    setFlags({ master: true, link: true });
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

    clearFlags();
    const flagged = await request('POST', `/api/proposals/${proposal.id}/demo-token`, {
      headers: { 'x-api-key': API_KEY, 'x-forwarded-for': '203.0.113.50' },
    });
    assert.equal(flagged.status, 404);
    assert.deepEqual(flagged.json, NOT_FOUND);

    const other = await insertProposal(prospect.id, { status: 'discarded', slug: 'pilot-discarded' });
    setFlags({ master: true });
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
    assert.match(tokenSrc, /randomBytes\(TOKEN_BYTES\)/);
    assert.match(tokenSrc, /timingSafeEqual/);

    setFlags({ master: true, link: true, sms: true });
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
    setFlags({ master: true });
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
    setFlags({ master: true });
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

  it('mints one replacement when the one-pager cache is cold', async () => {
    setFlags({ master: true, link: true });
    const row = await insertProposal(prospect.id, { slug: 'pilot-one-active' });
    const key = { 'x-api-key': API_KEY, 'x-forwarded-for': '203.0.113.80' };
    const first = await request('POST', `/api/proposals/${row.id}/demo-token`, { headers: key });
    assert.equal(first.status, 201);
    tokens._clearCacheForTests();

    const page = await request('GET', '/p/pilot-one-active', {
      headers: { 'x-forwarded-for': '203.0.113.81' },
    });
    assert.equal(page.status, 200);
    const href = ctaHref(page.text);
    const fresh = tokenFromPath(href);
    assert.ok(fresh);
    assert.notEqual(fresh, first.json.token);
    const active = await tokenStats(row.id);
    assert.equal(active.active, 1);
    await assertHashOnly(row.id, [first.json.token, fresh]);

    const old = await request('GET', first.json.path, {
      headers: { 'x-forwarded-for': '203.0.113.82' },
    });
    assertClosed(old);
    const current = await request('GET', href, {
      headers: { 'x-forwarded-for': '203.0.113.82' },
    });
    assert.equal(current.status, 200);
    assert.equal(current.json.company, 'Wasatch Heating');

    const again = await request('POST', `/api/proposals/${row.id}/demo-token`, { headers: key });
    assert.equal(again.status, 201);
    assert.notEqual(again.json.token, fresh);
    const stillOne = await tokenStats(row.id);
    assert.equal(stillOne.active, 1);
    await assertHashOnly(row.id, [first.json.token, fresh, again.json.token]);
    const replaced = await request('GET', href, {
      headers: { 'x-forwarded-for': '203.0.113.83' },
    });
    assertClosed(replaced);
    const newest = await request('GET', again.json.path, {
      headers: { 'x-forwarded-for': '203.0.113.83' },
    });
    assert.equal(newest.status, 200);
  });

  it('does not mint again on twenty cold one-pager views after revoke', async () => {
    setFlags({ master: true, link: true });
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
    clearFlags();
    const off = await request('GET', '/demo/estimate-recovery/demo-example-heating-air', {
      headers: { 'x-forwarded-for': '203.0.113.120' },
    });
    setFlags({ master: true });
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
    clearFlags();
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

    setFlags({ master: true });
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
});
