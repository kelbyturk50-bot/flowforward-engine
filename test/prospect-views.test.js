process.env.CRM_API_KEY = 'test-prospect-views-key-32chars!!';
process.env.PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || 'http://127.0.0.1:3000';
delete process.env.FF_PROSPECT_VIEWS;
delete process.env.FF_DEMO_VIEW_TASK;

const { describe, it, before, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const path = require('path');
const express = require('express');

const { applyMainSchema } = require('../src/db/migrate');
const { resetDb, closePool, pool, insertProspect } = require('./fixtures');
const { demoViewTaskOn, prospectViewsOn } = require('../src/demo-view/flag');
const { exclusionReason, INTERNAL_COOKIE, REASONS } = require('../src/demo-view/classify');
const store = require('../src/demo-view/store');
const { COUNTING_KEY } = require('../src/demo-view/counts');
const tokens = require('../src/prototypes/tokens');
const { _resetForTests } = require('../src/pilot/rate-limit');

const API_KEY = process.env.CRM_API_KEY;
const BROWSER = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 UniqueAuditTokenZZZ';
const BOT = 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)';
const NEW_KEYS = ['prospect_views', 'last_prospect_view_at', 'internal_views', 'counting_since'];
// Keys GET /api/proposals returns for one row on main, plus onepager_url.
const MAIN_LIST_KEYS = [
  'city', 'company', 'confidence', 'cost_usd', 'created_at', 'error', 'feedback_rating',
  'fit_score', 'fit_tier', 'fit_verdict', 'followup1_due_at', 'followup1_sent_at',
  'followup2_due_at', 'followup2_sent_at', 'id', 'industry', 'last_viewed_at',
  'onepager_url', 'phone', 'prospect_id', 'replied_at', 'reviewed_at', 'sent_at',
  'slug', 'snapshot', 'stage', 'status', 'stop_reason', 'subject', 'to_email',
  'to_name', 'updated_at', 'version', 'views', 'website',
];
// Keys GET /api/proposals/:id returns on main. pr.* then the joined lead
// columns, then the fields the handler adds.
const MAIN_DETAIL_KEYS = [
  'additions', 'ai_original', 'analysis', 'approved_at', 'archived_at', 'archive_reason',
  'body', 'city', 'company', 'contact_name', 'cost_usd', 'created_at', 'demo_revoked_at',
  'do_not_contact', 'error', 'feedback_note', 'feedback_rating', 'first_transient_at',
  'fit_score', 'fit_tier', 'followup1', 'followup1_due_at', 'followup1_sent_at',
  'followup2', 'followup2_due_at', 'followup2_sent_at', 'followup_argument_attempts',
  'followup_transient_attempts', 'id', 'industry', 'input_tokens', 'instructions',
  'last_viewed_at', 'lead_email', 'message_id', 'model', 'next_retry_at', 'onepager',
  'onepager_url', 'output_tokens', 'phone', 'preview', 'prospect_id', 'prototype',
  'prototype_url', 'rating', 'replied_at', 'research', 'review_count', 'reviewed_at',
  'searches', 'send_attempt_key', 'send_attempted_at', 'sent_at', 'slug', 'stage',
  'status', 'stop_reason', 'subject', 'thread_id', 'to_email', 'to_name', 'updated_at',
  'version', 'versions', 'views', 'website',
];

let server;
let ipSeq = 40;

function nextIp() {
  ipSeq += 1;
  return `203.0.113.${(ipSeq % 200) + 1}`;
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
        try { json = text ? JSON.parse(text) : null; } catch { json = null; }
        resolve({ status: res.statusCode, headers: res.headers, text, json });
      });
    });
    req.on('error', reject);
    if (payload) req.end(payload);
    else req.end();
  });
}

function authHeaders(extra = {}) {
  return { 'x-api-key': API_KEY, ...extra };
}

function cookies(res) {
  const raw = res.headers['set-cookie'];
  if (!raw) return [];
  return Array.isArray(raw) ? raw : [String(raw)];
}

async function sentProposal(label, overrides = {}) {
  const lead = await insertProspect({
    google_place_id: `test-place-pv-${label}-${crypto.randomBytes(4).toString('hex')}`,
    company: `TEST: ${label}`,
    email: `test+${label}@example.test`,
    phone: '(801) 555-0142',
    city: overrides.city || 'Provo',
    industry: 'HVAC',
    stage: 'proposal',
  });
  const sentAt = overrides.sentAt === undefined ? new Date(Date.now() - 3 * 24 * 3600 * 1000) : overrides.sentAt;
  const status = overrides.status || 'sent';
  const { rows } = await pool.query(
    `INSERT INTO proposals
       (prospect_id, version, status, slug, sent_at, subject, body, onepager, followup1_due_at, followup2_due_at)
     VALUES ($1, 1, $2, $3, $4, 'Hi', 'Body', '{}'::jsonb, $4, $4)
     RETURNING *`,
    [lead.id, status, `pv-${label}-${crypto.randomBytes(3).toString('hex')}`, sentAt]
  );
  return { lead, proposal: rows[0] };
}

async function liveDemo(prospectId) {
  const minted = tokens.mintToken();
  await pool.query(
    `INSERT INTO prototypes
       (prospect_id, agent_type, brand_name, color_primary, color_secondary,
        token_hash, nonce, issued_at, expires_at)
     SELECT $1, 'estimate_followup', 'TEST: Shop', '#112233', '#445566', $2, $3,
            issued, issued + interval '336 hours'
       FROM (SELECT NOW() AS issued) s`,
    [prospectId, minted.hash, minted.nonce]
  );
  return minted.token;
}

async function openOnePager(slug, { ip, ua = BROWSER, method = 'GET', query = '', headers = {} } = {}) {
  return request(method, `/p/${slug}${query}`, {
    headers: { 'user-agent': ua, 'x-forwarded-for': ip, ...headers },
  });
}

async function openDemo(token, { ip, ua = BROWSER, method = 'GET', query = '', headers = {} } = {}) {
  return request(method, `/demo/prototype/${token}${query}`, {
    headers: { 'user-agent': ua, 'x-forwarded-for': ip, ...headers },
  });
}

async function logs(proposalId) {
  const { rows } = await pool.query(
    `SELECT id, proposal_id, source, excluded_reason, ua_class, client_fp, viewed_at
       FROM proposal_view_log WHERE proposal_id = $1 ORDER BY viewed_at, id`,
    [proposalId]
  );
  return rows;
}

async function tasks(proposalId) {
  const { rows } = await pool.query(
    'SELECT id, status, view_count FROM proposal_view_tasks WHERE proposal_id = $1 ORDER BY id',
    [proposalId]
  );
  return rows;
}

async function viewCount(proposalId) {
  const { rows } = await pool.query('SELECT views FROM proposals WHERE id = $1', [proposalId]);
  return rows[0].views;
}

async function touches(leadId) {
  const { rows } = await pool.query(
    `SELECT type, source, external_ref, channel FROM campaign_touches
      WHERE lead_id = $1 AND type = 'prototype_viewed' ORDER BY id`,
    [leadId]
  );
  return rows;
}

async function setCounting(iso) {
  await pool.query(
    `INSERT INTO app_settings (key, value, updated_at)
     VALUES ($1, jsonb_build_object('at', $2::timestamptz), NOW())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
    [COUNTING_KEY, iso]
  );
}

async function countingRaw() {
  const { rows } = await pool.query('SELECT value FROM app_settings WHERE key = $1', [COUNTING_KEY]);
  return rows[0] ? rows[0].value : null;
}

function withoutNew(value) {
  if (Array.isArray(value)) return value.map(withoutNew);
  if (value && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value)) {
      if (NEW_KEYS.includes(key)) continue;
      out[key] = withoutNew(value[key]);
    }
    return out;
  }
  return value;
}

function assertNoPersonal(rows, ip) {
  const blob = JSON.stringify(rows);
  assert.equal(blob.includes(ip), false);
  assert.equal(blob.includes('UniqueAuditTokenZZZ'), false);
  assert.equal(blob.includes(BROWSER), false);
}

describe('prospect vs team views', { concurrency: false }, () => {
  before(async () => {
    await resetDb();
    await applyMainSchema();
    const first = await countingRaw();
    assert.ok(first && first.at);
    await applyMainSchema();
    assert.deepEqual(await countingRaw(), first);
    await setCounting('2026-01-01T00:00:00.000Z');
    process.env.FF_PROSPECT_VIEWS = 'true';
    process.env.FF_DEMO_VIEW_TASK = 'true';
    _resetForTests();
    const app = express();
    app.set('trust proxy', 1);
    app.use(express.json({ limit: '1mb' }));
    app.use('/p', require('../src/proposals/onepager').router);
    app.use('/demo/prototype', require('../src/prototypes/page').router);
    app.use('/api', require('../src/api/auth'));
    app.use('/api/proposals', require('../src/api/proposals'));
    app.use('/api/demo-view-tasks', require('../src/api/demo-view-tasks'));
    server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  });

  afterEach(() => {
    store._setClockForTests(null);
    process.env.FF_PROSPECT_VIEWS = 'true';
    process.env.FF_DEMO_VIEW_TASK = 'true';
    process.env.CRM_API_KEY = API_KEY;
  });

  after(async () => {
    store._setClockForTests(null);
    delete process.env.FF_PROSPECT_VIEWS;
    delete process.env.FF_DEMO_VIEW_TASK;
    if (server) await new Promise((resolve) => server.close(resolve));
    await resetDb();
    await closePool();
  });

  it('uses the same truthy parser as FF_DEMO_VIEW_TASK', () => {
    for (const value of ['true', 'TRUE', ' true ', '1', 'yes', 'on', 'On']) {
      assert.equal(prospectViewsOn({ FF_PROSPECT_VIEWS: value }), true, value);
      assert.equal(demoViewTaskOn({ FF_DEMO_VIEW_TASK: value }), true, value);
    }
    for (const value of [undefined, '', ' ', 'false', 'off', '0', 'no', 'truee', '2', 'yes please']) {
      const env = {};
      if (value !== undefined) env.FF_PROSPECT_VIEWS = value;
      assert.equal(prospectViewsOn(env), false, String(value));
    }
    assert.equal(REASONS.includes('internal_header'), true);
  });

  it('checks the internal header immediately after preview and only as an exclusion', () => {
    const base = { method: 'GET', ua: BROWSER, cookie: 'ff_internal=1' };
    assert.equal(exclusionReason({ ...base, method: 'HEAD', preview: '1', internalHeader: '1' }), 'head');
    assert.equal(exclusionReason({ ...base, purpose: 'prefetch', preview: '1', internalHeader: '1' }), 'prefetch');
    assert.equal(exclusionReason({ ...base, preview: '1', internalHeader: '1' }), 'preview');
    assert.equal(exclusionReason({ ...base, internalHeader: '1', ua: BOT }), 'internal_header');
    assert.equal(exclusionReason({ ...base, internalHeader: true }), 'internal_header');
    assert.equal(exclusionReason({ ...base, internalHeader: '0' }), 'internal_cookie');
    assert.equal(exclusionReason({ ...base, internalHeader: '1 ' }), 'internal_cookie');
    assert.equal(exclusionReason({ method: 'GET', ua: BROWSER, internalHeader: 'yes' }), null);
    const sentAt = new Date('2026-03-01T15:00:00.000Z');
    assert.equal(exclusionReason({
      method: 'GET', ua: BROWSER, internalHeader: '1', sentAt, at: new Date(sentAt.getTime() + 1000),
    }), 'internal_header');
  });

  it('allows internal_header in the view-log check and does not move counting_since', async () => {
    const { rows } = await pool.query(
      `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
        WHERE conname = 'proposal_view_log_reason_check'`
    );
    assert.match(rows[0].def, /internal_header/);
    const { rows: cols } = await pool.query(
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'proposal_view_log'
        ORDER BY column_name`
    );
    assert.deepEqual(cols.map((row) => row.column_name), [
      'client_fp', 'excluded_reason', 'id', 'proposal_id', 'source', 'ua_class', 'viewed_at',
    ]);
    const frozen = await countingRaw();
    await applyMainSchema();
    assert.deepEqual(await countingRaw(), frozen);
  });

  it('keeps flag-off proposal responses on the main shape and writes no demo touch', async () => {
    delete process.env.FF_PROSPECT_VIEWS;
    const row = await sentProposal('shape');
    const token = await liveDemo(row.lead.id);
    const ip = nextIp();
    const listOff = await request('GET', `/api/proposals?prospect_id=${row.lead.id}`, { headers: authHeaders() });
    const oneOff = await request('GET', `/api/proposals/${row.proposal.id}`, { headers: authHeaders() });
    const listAgain = await request('GET', `/api/proposals?prospect_id=${row.lead.id}`, { headers: authHeaders() });
    const oneAgain = await request('GET', `/api/proposals/${row.proposal.id}`, { headers: authHeaders() });
    assert.equal(listOff.status, 200);
    assert.equal(oneOff.status, 200);
    assert.equal(listOff.text, listAgain.text);
    assert.equal(oneOff.text, oneAgain.text);
    for (const key of NEW_KEYS) {
      assert.equal(listOff.text.includes(`"${key}"`), false, key);
      assert.equal(oneOff.text.includes(`"${key}"`), false, key);
    }
    assert.deepEqual(Object.keys(listOff.json.proposals[0]).sort(), [...MAIN_LIST_KEYS].sort());
    assert.deepEqual(Object.keys(oneOff.json).sort(), [...MAIN_DETAIL_KEYS].sort());
    const plain = await openDemo(token, { ip });
    const preview = await openDemo(token, { ip, query: '?preview=1', headers: { 'x-ff-internal': '1' } });
    assert.equal(plain.status, 200);
    assert.equal(preview.text, plain.text);
    assert.deepEqual(cookies(preview), []);
    assert.equal((await logs(row.proposal.id)).length, 0);
    assert.equal((await touches(row.lead.id)).length, 0);
    assert.equal(await viewCount(row.proposal.id), 0);
    const logged = await store.recordDemoView({
      prospectId: row.lead.id,
      at: new Date(),
      view: { method: 'POST', ua: BROWSER, ip, cookie: '', purpose: '', secPurpose: '', preview: false },
    });
    assert.equal(logged.reason, null);
    assert.equal((await touches(row.lead.id)).length, 0);
    const engine = fs.readFileSync(path.join(__dirname, '../src/chatdemo/engine.js'), 'utf8');
    const fn = engine.slice(engine.indexOf('async function safeTouch'), engine.indexOf('function failPaused'));
    const insertAt = fn.indexOf('INSERT INTO campaign_touches');
    const recordAt = fn.indexOf('await recordDemoView');
    assert.ok(insertAt > 0 && recordAt > insertAt);
    assert.ok(fn.indexOf('prospectViewsOn()') < insertAt);
  });

  it('renders the demo page the same for every visitor and classifies each exclusion', async () => {
    const row = await sentProposal('demo-exclusions');
    const token = await liveDemo(row.lead.id);
    const ip = nextIp();
    delete process.env.FF_PROSPECT_VIEWS;
    const off = await openDemo(token, { ip });
    process.env.FF_PROSPECT_VIEWS = 'true';
    const plain = await openDemo(token, { ip: nextIp() });
    const preview = await openDemo(token, { ip: nextIp(), query: '?preview=1' });
    const header = await openDemo(token, { ip: nextIp(), headers: { 'x-ff-internal': '1' } });
    const bot = await openDemo(token, { ip: nextIp(), ua: BOT });
    assert.equal(off.status, 200);
    assert.equal(plain.text, off.text);
    assert.equal(preview.text, off.text);
    assert.equal(header.text, off.text);
    assert.equal(bot.text, off.text);
    assert.ok(cookies(preview).includes(INTERNAL_COOKIE));
    assert.equal(preview.headers['access-control-allow-origin'], undefined);

    const sent = new Date('2026-04-02T15:00:00.000Z');
    const early = await sentProposal('demo-2m', { sentAt: sent });
    const earlyToken = await liveDemo(early.lead.id);
    const later = await sentProposal('demo-2m-later', { sentAt: sent });
    const laterToken = await liveDemo(later.lead.id);
    store._setClockForTests(() => new Date(sent.getTime() + 2 * 60 * 1000));
    await openDemo(earlyToken, { ip: nextIp() });
    store._setClockForTests(() => new Date(sent.getTime() + 2 * 60 * 1000 + 1));
    const counted = await openDemo(laterToken, { ip: nextIp() });
    assert.equal(counted.status, 200);

    const head = await sentProposal('demo-head');
    const headToken = await liveDemo(head.lead.id);
    store._setClockForTests(null);
    await openDemo(headToken, { ip: nextIp(), method: 'HEAD' });
    const purpose = await sentProposal('demo-purpose');
    const purposeToken = await liveDemo(purpose.lead.id);
    await openDemo(purposeToken, { ip: nextIp(), headers: { purpose: 'prefetch' } });
    const sec = await sentProposal('demo-sec');
    const secToken = await liveDemo(sec.lead.id);
    await openDemo(secToken, { ip: nextIp(), headers: { 'sec-purpose': 'prerender' } });
    const cookieLead = await sentProposal('demo-cookie');
    const cookieToken = await liveDemo(cookieLead.lead.id);
    const cookieIp = nextIp();
    await openDemo(cookieToken, { ip: cookieIp, query: '?preview=1' });
    await openDemo(cookieToken, { ip: cookieIp, headers: { cookie: 'ff_internal=1' } });

    const missing = await openDemo('a'.repeat(43), { ip: nextIp(), query: '?preview=1' });
    assert.equal(missing.status, 404);
    assert.ok(cookies(missing).includes(INTERNAL_COOKIE));

    assert.equal((await logs(early.proposal.id))[0].excluded_reason, 'within_2m');
    assert.equal((await logs(early.proposal.id))[0].source, 'demo');
    assert.equal((await touches(early.lead.id)).length, 0);
    assert.equal((await logs(later.proposal.id))[0].excluded_reason, null);
    assert.equal((await logs(later.proposal.id))[0].source, 'demo');
    assert.equal((await touches(later.lead.id)).length, 1);
    assert.match((await touches(later.lead.id))[0].external_ref, /^prospect-view:[1-9][0-9]*$/);
    assert.equal((await touches(later.lead.id))[0].source, 'system');
    assert.equal((await logs(head.proposal.id))[0].excluded_reason, 'head');
    assert.equal((await logs(purpose.proposal.id))[0].excluded_reason, 'prefetch');
    assert.equal((await logs(sec.proposal.id))[0].excluded_reason, 'prefetch');
    assert.deepEqual((await logs(cookieLead.proposal.id)).map((item) => item.excluded_reason), ['preview', 'internal_cookie']);
    assert.equal((await touches(cookieLead.lead.id)).length, 0);
    assert.equal((await tasks(early.proposal.id)).length, 0);
    assert.equal((await tasks(later.proposal.id)).length, 1);
    assert.equal(await viewCount(later.proposal.id), 0);
    const botLog = (await logs(row.proposal.id)).find((item) => item.excluded_reason === 'bot_ua');
    assert.ok(botLog);
    assert.equal(botLog.ua_class, 'bot');
    assertNoPersonal(await logs(row.proposal.id), ip);
  });

  it('bursts demo views of 3 proposals and drops the touches it had inserted', async () => {
    const ip = nextIp();
    const rows = [];
    for (let i = 0; i < 3; i += 1) {
      const row = await sentProposal(`burst-${i}`);
      row.token = await liveDemo(row.lead.id);
      rows.push(row);
    }
    const start = new Date('2026-06-01T18:00:00.000Z');
    store._setClockForTests(() => start);
    await openDemo(rows[0].token, { ip });
    store._setClockForTests(() => new Date(start.getTime() + 60 * 1000));
    await openDemo(rows[1].token, { ip });
    assert.equal((await logs(rows[0].proposal.id))[0].excluded_reason, null);
    assert.equal((await touches(rows[0].lead.id)).length, 1);
    assert.equal((await touches(rows[1].lead.id)).length, 1);
    store._setClockForTests(() => new Date(start.getTime() + 2 * 60 * 1000));
    await openDemo(rows[2].token, { ip });
    for (const row of rows) {
      assert.equal((await logs(row.proposal.id))[0].excluded_reason, 'burst');
      assert.equal((await touches(row.lead.id)).length, 0);
      assert.equal((await tasks(row.proposal.id)).length, 0);
    }
  });

  it('lets X-FF-Internal: 1 only suppress counts and tasks on /p and the demo', async () => {
    const pager = await sentProposal('header-p');
    const ip = nextIp();
    const marked = await openOnePager(pager.proposal.slug, {
      ip, headers: { 'x-ff-internal': '1' },
    });
    assert.equal(marked.status, 200);
    assert.equal((await logs(pager.proposal.id))[0].excluded_reason, 'internal_header');
    assert.equal((await logs(pager.proposal.id))[0].source, 'onepager');
    assert.equal((await tasks(pager.proposal.id)).length, 0);
    assert.equal(await viewCount(pager.proposal.id), 1);
    const other = await openOnePager(pager.proposal.slug, {
      ip: nextIp(), headers: { 'x-ff-internal': 'true' },
    });
    assert.equal(other.status, 200);
    const reasons = (await logs(pager.proposal.id)).map((item) => item.excluded_reason);
    assert.deepEqual(reasons, ['internal_header', null]);
    assert.equal((await tasks(pager.proposal.id)).length, 1);

    const demo = await sentProposal('header-demo');
    const token = await liveDemo(demo.lead.id);
    await openDemo(token, { ip: nextIp(), headers: { 'X-FF-Internal': '1' } });
    await openDemo(token, {
      ip: nextIp(),
      query: '?preview=1',
      headers: { 'x-ff-internal': '1' },
    });
    await openDemo(token, { ip: nextIp(), ua: BOT, headers: { 'x-ff-internal': '1' } });
    const demoReasons = (await logs(demo.proposal.id)).map((item) => item.excluded_reason);
    assert.deepEqual(demoReasons, ['internal_header', 'preview', 'internal_header']);
    assert.equal((await tasks(demo.proposal.id)).length, 0);
    assert.equal((await touches(demo.lead.id)).length, 0);
    assert.equal(await viewCount(demo.proposal.id), 0);

    delete process.env.FF_PROSPECT_VIEWS;
    const ignored = await sentProposal('header-off');
    await openOnePager(ignored.proposal.slug, {
      ip: nextIp(), headers: { 'x-ff-internal': '1' },
    });
    assert.equal((await logs(ignored.proposal.id))[0].excluded_reason, null);
    assert.equal((await tasks(ignored.proposal.id)).length, 1);
    const hidden = await request('GET', `/api/proposals/${ignored.proposal.id}`, { headers: authHeaders() });
    for (const key of NEW_KEYS) assert.equal(hidden.text.includes(`"${key}"`), false, key);
  });

  it('returns prospect and internal counts, and null before counting_since', async () => {
    const row = await sentProposal('counts');
    const token = await liveDemo(row.lead.id);
    const firstAt = new Date('2026-07-01T16:00:00.000Z');
    const secondAt = new Date('2026-07-01T17:00:00.000Z');
    const botAt = new Date('2026-07-01T18:00:00.000Z');
    store._setClockForTests(() => firstAt);
    await openOnePager(row.proposal.slug, { ip: nextIp() });
    store._setClockForTests(() => secondAt);
    await openDemo(token, { ip: nextIp() });
    store._setClockForTests(() => botAt);
    await openDemo(token, { ip: nextIp(), ua: BOT });
    store._setClockForTests(null);

    const one = await request('GET', `/api/proposals/${row.proposal.id}`, { headers: authHeaders() });
    assert.equal(one.json.prospect_views, 2);
    assert.equal(one.json.internal_views, 1);
    assert.equal(one.json.last_prospect_view_at, secondAt.toISOString());
    assert.equal(one.json.counting_since, '2026-01-01T00:00:00.000Z');
    assert.equal(one.json.views, 1);
    const list = await request('GET', `/api/proposals?view=out`, { headers: authHeaders() });
    const found = list.json.proposals.find((item) => item.id === row.proposal.id);
    assert.equal(found.prospect_views, 2);
    assert.equal(found.internal_views, 1);
    assert.equal(found.last_prospect_view_at, secondAt.toISOString());
    assert.equal(found.counting_since, one.json.counting_since);

    const fresh = await sentProposal('counts-zero');
    const zero = await request('GET', `/api/proposals/${fresh.proposal.id}`, { headers: authHeaders() });
    assert.equal(zero.json.prospect_views, 0);
    assert.equal(zero.json.internal_views, 0);
    assert.equal(zero.json.last_prospect_view_at, null);
    assert.equal(typeof zero.json.counting_since, 'string');

    await pool.query('DELETE FROM app_settings WHERE key = $1', [COUNTING_KEY]);
    const missing = await request('GET', `/api/proposals/${row.proposal.id}`, { headers: authHeaders() });
    assert.equal(missing.json.prospect_views, null);
    assert.equal(missing.json.last_prospect_view_at, null);
    assert.equal(missing.json.internal_views, null);
    assert.equal(missing.json.counting_since, null);

    await setCounting('2099-01-01T00:00:00.000Z');
    const ahead = await request('GET', `/api/proposals/${fresh.proposal.id}`, { headers: authHeaders() });
    assert.equal(ahead.json.prospect_views, null);
    assert.equal(ahead.json.internal_views, null);
    assert.equal(ahead.json.last_prospect_view_at, null);
    assert.equal(ahead.json.counting_since, '2099-01-01T00:00:00.000Z');
    await setCounting('2026-01-01T00:00:00.000Z');

    const summary = await request('GET', '/api/proposals/summary', { headers: authHeaders() });
    assert.equal(summary.status, 200);
    assert.equal(summary.text.includes('"prospect_views"'), false);
    assert.equal(summary.text.includes('"counting_since"'), false);

    delete process.env.FF_PROSPECT_VIEWS;
    const off = await request('GET', `/api/proposals/${row.proposal.id}`, { headers: authHeaders() });
    const byId = await request('GET', `/api/proposals?prospect_id=${row.lead.id}`, { headers: authHeaders() });
    for (const key of NEW_KEYS) {
      assert.equal(off.text.includes(`"${key}"`), false, key);
      assert.equal(byId.text.includes(`"${key}"`), false, key);
    }
    assert.deepEqual(withoutNew(one.json), off.json);
    process.env.FF_PROSPECT_VIEWS = 'true';
    const back = await request('GET', `/api/proposals/${row.proposal.id}`, { headers: authHeaders() });
    assert.deepEqual(withoutNew(back.json), off.json);
    assert.equal(back.json.prospect_views, 2);
  });

  it('scores an Oct 20 audit and a Nov 14 team check at 0, and one real view at 1', async () => {
    const ip = '198.51.100.77';
    const rows = [];
    for (let i = 0; i < 7; i += 1) {
      const row = await sentProposal(`audit-${i}`);
      row.token = await liveDemo(row.lead.id);
      rows.push(row);
    }
    const start = new Date('2026-10-20T22:00:00-06:00');
    for (let i = 0; i < 7; i += 1) {
      const at = new Date(start.getTime() + i * 16 * 60 * 1000);
      store._setClockForTests(() => at);
      const page = await openOnePager(rows[i].proposal.slug, { ip });
      const demo = await openDemo(rows[i].token, { ip });
      assert.equal(page.status, 200);
      assert.equal(demo.status, 200);
    }
    const end = new Date('2026-10-20T23:36:00-06:00');
    assert.equal(end.getTime() - start.getTime(), 6 * 16 * 60 * 1000);

    const team = await sentProposal('nov14');
    team.token = await liveDemo(team.lead.id);
    const teamAt = new Date('2026-11-14T09:32:00-07:00');
    store._setClockForTests(() => teamAt);
    const teamIp = '198.51.100.78';
    await openOnePager(team.proposal.slug, { ip: teamIp, headers: { 'x-ff-internal': '1' } });
    await openDemo(team.token, { ip: teamIp, query: '?preview=1' });

    const real = await sentProposal('real-lead');
    real.token = await liveDemo(real.lead.id);
    store._setClockForTests(() => new Date(real.proposal.sent_at.getTime() + 60 * 60 * 1000));
    await openDemo(real.token, { ip: '198.51.100.79' });
    store._setClockForTests(null);

    const ids = rows.map((row) => row.proposal.id).concat([team.proposal.id, real.proposal.id]);
    const listed = await request('GET', '/api/proposals?view=out', { headers: authHeaders() });
    for (const row of rows) {
      const item = listed.json.proposals.find((proposal) => proposal.id === row.proposal.id);
      assert.equal(item.prospect_views, 0, row.lead.company);
      assert.equal(item.internal_views, 2, row.lead.company);
      const written = await logs(row.proposal.id);
      assert.equal(written.length, 2);
      assert.ok(written.every((item) => item.excluded_reason === 'burst'));
      assert.deepEqual(written.map((item) => item.source).sort(), ['demo', 'onepager']);
      assert.equal((await touches(row.lead.id)).length, 0);
      assertNoPersonal(written, ip);
    }
    const teamItem = listed.json.proposals.find((proposal) => proposal.id === team.proposal.id);
    assert.equal(teamItem.prospect_views, 0);
    assert.equal(teamItem.internal_views, 2);
    assert.deepEqual(
      (await logs(team.proposal.id)).map((item) => item.excluded_reason).sort(),
      ['internal_header', 'preview']
    );
    assert.equal((await tasks(team.proposal.id)).length, 0);
    const realItem = listed.json.proposals.find((proposal) => proposal.id === real.proposal.id);
    assert.equal(realItem.prospect_views, 1);
    assert.equal(realItem.internal_views, 0);
    assert.equal((await logs(real.proposal.id))[0].excluded_reason, null);
    assert.equal((await logs(real.proposal.id))[0].source, 'demo');
    assert.equal((await touches(real.lead.id)).length, 1);
    const detail = await request('GET', `/api/proposals/${real.proposal.id}`, { headers: authHeaders() });
    assert.equal(detail.json.prospect_views, 1);
    assert.equal(detail.json.views, 0);
    console.log(`[prospect-views] replay ids=${ids.length} audit+team prospect_views=0 real=1`);
  });
});
