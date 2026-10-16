process.env.CRM_API_KEY = 'test-prototype-key-32chars-minimum!!';
delete process.env.FF_PROTOTYPE_ON_DRAFT;

require('./preload');

// Prototype rows created from draftProposal. Disposable Postgres, Anthropic
// mock, no live fetch, no mail transport. The public read is loopback HTTP.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const http = require('http');
const express = require('express');
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { draftProposal, _setClient } = require('../src/proposals/draft');
const { _setTransport } = require('../src/proposals/send');
const jobs = require('../src/proposals/jobs');
const scoring = require('../src/scoring/prototypes');
const { recommendPrototypes } = scoring;
const { deriveToken, hashToken } = require('../src/prototypes/tokens');
const { applySchema } = require('../src/db/migrate');
const { clientIp, consume, _resetForTests } = require('../src/pilot/rate-limit');
const { resetDb, insertProspect, fakeClaude, closePool, pool } = require('./fixtures');

const ROOT = path.join(__dirname, '..');

function estimateResearch() {
  return {
    signals: {
      mentions: {
        free_estimates: true,
        financing: true,
        maintenance_plan: false,
        emergency_24_7: true,
        online_booking_language: true,
      },
      online_booking: ['Calendly'],
      chat_or_text_widget: ['Podium'],
      reviews_tools: ['NiceJob'],
    },
    reviews: [{ text: 'They never followed up on my estimate' }],
    place: { hours: ['Monday: 8:00 AM – 8:00 PM'] },
  };
}

function tieResearch() {
  return {
    signals: {
      mentions: {
        free_estimates: false,
        financing: false,
        maintenance_plan: false,
        emergency_24_7: false,
        online_booking_language: false,
      },
    },
    reviews: [],
    place: { hours: ['Monday: 8:00 AM – 5:00 PM'] },
  };
}

function stResearch() {
  return {
    signals: {
      mentions: {
        free_estimates: false,
        financing: false,
        maintenance_plan: false,
        emergency_24_7: false,
        online_booking_language: false,
      },
      online_booking: [],
      chat_or_text_widget: [],
      reviews_tools: ['NiceJob'],
    },
    reviews: [{ text: 'no answer and they never called back' }],
    place: { hours: ['Monday: 8:00 AM – 5:00 PM'] },
  };
}

function request(port, method, reqPath, { body = undefined, key = process.env.CRM_API_KEY } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body == null ? null : Buffer.from(JSON.stringify(body));
    const headers = { accept: 'application/json' };
    if (payload) {
      headers['content-type'] = 'application/json';
      headers['content-length'] = String(payload.length);
    }
    if (key) headers['x-api-key'] = key;
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path: reqPath,
      method,
      headers,
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = text ? JSON.parse(text) : null; } catch { json = { raw: text }; }
        resolve({ status: res.statusCode, json, headers: res.headers });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function seedLead(overrides = {}, research = estimateResearch()) {
  const prospect = await insertProspect({
    website: null,
    email: 'test+prototype@wasatchheating.test',
    contact_name: null,
    company: 'TEST: Wasatch Heating',
    industry: 'HVAC',
    state: 'UT',
    rating: 4.6,
    review_count: 80,
    fsm_detected: 'none',
    ...overrides,
  });
  const slug = `seed-prototype-${prospect.id}-${Date.now()}`;
  await pool.query(
    `INSERT INTO proposals (prospect_id, version, status, slug, research, subject, body)
     VALUES ($1, 1, 'draft', $2, $3::jsonb, 'seed', 'seed')`,
    [prospect.id, slug, JSON.stringify(research)]
  );
  return prospect;
}

async function prototypeRows(prospectId) {
  const params = [];
  let where = '';
  if (prospectId != null) {
    params.push(prospectId);
    where = 'WHERE prospect_id = $1';
  }
  const { rows } = await pool.query(
    `SELECT id, prospect_id, agent_type, brand_name, color_primary, color_secondary,
            token_hash, issued_at, expires_at, revoked_at
       FROM prototypes ${where} ORDER BY id`,
    params
  );
  return rows;
}

function tokenOf(url) {
  const parts = String(url || '').split('/');
  return parts[parts.length - 1];
}

function hasLogoKey(value) {
  if (!value || typeof value !== 'object') return false;
  return Object.keys(value).some((key) => /logo/i.test(key) || hasLogoKey(value[key]));
}

describe('prototype on draft', () => {
  let server;
  let port;
  const originalRecommend = scoring.recommendPrototypes;

  before(async () => {
    await resetDb();
    _setClient(fakeClaude());
    const app = express();
    app.set('trust proxy', 1);
    app.use(express.json());
    app.use('/api/public/prototypes', require('../src/prototypes/public').router);
    app.use('/api', require('../src/api/auth'));
    app.use('/api/proposals', require('../src/api/proposals'));
    app.use('/api/prototypes', require('../src/api/prototypes'));
    server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = server.address().port;
  });

  after(async () => {
    scoring.recommendPrototypes = originalRecommend;
    _setClient(null);
    _setTransport(null);
    delete process.env.FF_PROTOTYPE_ON_DRAFT;
    if (server) await new Promise((resolve) => server.close(resolve));
    await closePool();
  });

  it('prototype: flag off => draftProposal unchanged, no prototype row', async () => {
    const lead = await seedLead({ google_place_id: 'test-place-proto-flag-off' });
    for (const value of [undefined, 'TRUE', '1', ' true', 'false']) {
      if (value === undefined) delete process.env.FF_PROTOTYPE_ON_DRAFT;
      else process.env.FF_PROTOTYPE_ON_DRAFT = value;
      const proposal = await draftProposal(lead.id);
      assert.equal(proposal.status, 'draft');
      assert.equal(proposal.subject, 'Quick idea for Wasatch Heating');
      assert.equal(proposal.to_email, 'dana@wasatchheating.test');
      assert.equal(await prototypeRows(lead.id).then((rows) => rows.length), 0);
    }
    const latest = await pool.query(
      'SELECT id FROM proposals WHERE prospect_id = $1 ORDER BY version DESC LIMIT 1',
      [lead.id]
    );
    const body = await request(port, 'GET', `/api/proposals/${latest.rows[0].id}`);
    assert.equal(body.status, 200);
    assert.equal(body.json.prototype, null);
    console.log('[prototype] flag off: draft saved, prototypes=0, GET prototype=null');
  });

  it('prototype: flag on + rubric pick => one row keyed to prospect_id', async () => {
    process.env.FF_PROTOTYPE_ON_DRAFT = 'true';
    const lead = await seedLead({ google_place_id: 'test-place-proto-pick' });
    await pool.query(
      `INSERT INTO prospect_brands (prospect_id, name, logo_url, colors, source, test_tag)
       VALUES ($1, $2, $3, $4::jsonb, 'manual', $5)`,
      [
        lead.id,
        'TEST: Wasatch Heating',
        'https://fixtures.example/test-wasatch-logo.png',
        JSON.stringify(['#1b4f72', '#f4d03f']),
        'TEST:wasatch-proto-pick',
      ]
    );
    const proposal = await draftProposal(lead.id);
    assert.equal(proposal.status, 'draft');
    const rows = await prototypeRows(lead.id);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].prospect_id, lead.id);
    assert.equal(rows[0].agent_type, 'estimate_followup');
    assert.equal(rows[0].brand_name, 'TEST: Wasatch Heating');
    assert.equal(rows[0].color_primary, '#1b4f72');
    assert.equal(rows[0].color_secondary, '#f4d03f');
    assert.equal(rows[0].revoked_at, null);

    const got = await request(port, 'GET', `/api/proposals/${proposal.id}`);
    assert.equal(got.status, 200);
    assert.equal(got.json.prototype.agent_type, 'estimate_followup');
    assert.match(got.json.prototype.url, /^\/demo\/prototype\/[A-Za-z0-9_-]{43}$/);
    assert.ok(got.json.prototype.issued_at);
    assert.ok(got.json.prototype.expires_at);
    const open = await request(port, 'GET', `/api/public/prototypes/${tokenOf(got.json.prototype.url)}`, { key: 'wrong-key' });
    assert.equal(open.status, 200);
    const anon = await request(port, 'GET', `/api/public/prototypes/${tokenOf(got.json.prototype.url)}`, { key: '' });
    assert.equal(anon.status, 200);
    console.log(`[prototype] flag on: prospect ${lead.id} prototype ${rows[0].id} agent ${rows[0].agent_type}`);
  });

  it('prototype: no pick (pest/franchise/ST/tie) => no row', async () => {
    process.env.FF_PROTOTYPE_ON_DRAFT = 'true';
    const pest = await seedLead({
      google_place_id: 'test-place-proto-pest',
      company: 'TEST: Sample Heating',
      industry: 'Pest Control',
    });
    assert.equal(recommendPrototypes({ ...pest, research: estimateResearch() }).disqualified, 'pest');
    await draftProposal(pest.id);
    assert.equal((await prototypeRows(pest.id)).length, 0);

    const franchise = await seedLead({
      google_place_id: 'test-place-proto-franchise',
      company: 'TEST: One Hour Heating',
    });
    assert.equal(recommendPrototypes({ ...franchise, research: estimateResearch() }).disqualified, 'franchise');
    await draftProposal(franchise.id);
    assert.equal((await prototypeRows(franchise.id)).length, 0);

    const stLead = await seedLead({
      google_place_id: 'test-place-proto-st',
      company: 'TEST: Sample Heating',
      fsm_detected: 'ServiceTitan',
    }, stResearch());
    const stPick = recommendPrototypes({ ...stLead, research: stResearch() });
    assert.deepEqual(stPick.picks, []);
    await draftProposal(stLead.id);
    assert.equal((await prototypeRows(stLead.id)).length, 0);

    const tiedLead = await seedLead({
      google_place_id: 'test-place-proto-tie',
      company: 'TEST: Sample Heating',
      fsm_detected: 'Jobber',
      rating: 4.2,
      review_count: 80,
    }, tieResearch());
    const tied = recommendPrototypes({ ...tiedLead, research: tieResearch() });
    assert.ok(tied.picks.length >= 2);
    assert.equal(tied.picks[0].score, tied.picks[1].score);
    await draftProposal(tiedLead.id);
    assert.equal((await prototypeRows(tiedLead.id)).length, 0);
    console.log('[prototype] no pick: pest, franchise, servicetitan, tie each left prototypes empty');
  });

  it('prototype: regenerate reuses active prototype for same prospect', async () => {
    process.env.FF_PROTOTYPE_ON_DRAFT = 'true';
    const lead = await seedLead({ google_place_id: 'test-place-proto-reuse' });
    const first = await draftProposal(lead.id);
    const second = await draftProposal(lead.id);
    assert.ok(second.version > first.version);
    const rows = await prototypeRows(lead.id);
    assert.equal(rows.length, 1);
    const again = await pool.query(
      `INSERT INTO prototypes (
         prospect_id, agent_type, brand_name, color_primary, color_secondary, token_hash, issued_at, expires_at
       )
       SELECT prospect_id, agent_type, brand_name, color_primary, color_secondary,
              $2, issued_at, expires_at
         FROM prototypes WHERE id = $1`,
      [rows[0].id, crypto.randomBytes(32)]
    ).then(() => null).catch((err) => err);
    assert.equal(again.code, '23505');
    assert.equal((await prototypeRows(lead.id)).length, 1);
    console.log(`[prototype] regenerate reused prototype ${rows[0].id} for prospect ${lead.id}`);
  });

  it('prototype: no logo field in schema, payload, or input', async () => {
    process.env.FF_PROTOTYPE_ON_DRAFT = 'true';
    const cols = await pool.query(
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'prototypes'`
    );
    const names = cols.rows.map((row) => row.column_name);
    assert.equal(names.some((name) => /logo/i.test(name)), false);
    assert.deepEqual(names.sort(), [
      'agent_type', 'brand_name', 'color_primary', 'color_secondary', 'created_at',
      'expires_at', 'id', 'issued_at', 'prospect_id', 'revoked_at', 'token_hash',
    ]);
    const watched = [
      'src/prototypes/flags.js',
      'src/prototypes/tokens.js',
      'src/prototypes/store.js',
      'src/prototypes/public.js',
      'src/api/prototypes.js',
    ];
    for (const file of watched) {
      const text = fs.readFileSync(path.join(ROOT, file), 'utf8');
      assert.equal(/logo/i.test(text), false, file);
    }
    const lead = await seedLead({ google_place_id: 'test-place-proto-nologo' });
    const proposal = await draftProposal(lead.id);
    const got = await request(port, 'GET', `/api/proposals/${proposal.id}`);
    assert.equal(hasLogoKey(got.json.prototype), false);
    const pub = await request(port, 'GET', `/api/public/prototypes/${tokenOf(got.json.prototype.url)}?watermark=0`, { key: '' });
    assert.equal(pub.status, 200);
    assert.equal(hasLogoKey(pub.json), false);
    assert.equal(Object.hasOwn(pub.json, 'logo'), false);
    console.log('[prototype] schema, source, and payloads have no logo field');
  });

  it('prototype: expiry boundary — 14d minus 1s => 200; at 14d => 410 link_expired with expires_at', async () => {
    process.env.FF_PROTOTYPE_ON_DRAFT = 'true';
    const lead = await seedLead({ google_place_id: 'test-place-proto-expiry' });
    const proposal = await draftProposal(lead.id);
    const created = await request(port, 'GET', `/api/proposals/${proposal.id}`);
    const id = (await prototypeRows(lead.id))[0].id;

    async function shift(issuedSql) {
      const { rows } = await pool.query(
        `UPDATE prototypes
            SET issued_at = ${issuedSql},
                expires_at = (${issuedSql}) + INTERVAL '14 days'
          WHERE id = $1
          RETURNING prospect_id, issued_at, expires_at`,
        [id]
      );
      const token = deriveToken(rows[0].prospect_id, rows[0].issued_at);
      await pool.query('UPDATE prototypes SET token_hash = $2 WHERE id = $1', [id, hashToken(token)]);
      return { token, expires_at: new Date(rows[0].expires_at).toISOString() };
    }

    const early = await shift("NOW() - INTERVAL '14 days' + INTERVAL '1 second'");
    const earlyRes = await request(port, 'GET', `/api/public/prototypes/${early.token}`, { key: '' });
    assert.equal(earlyRes.status, 200);
    assert.equal(earlyRes.json.expires_at, early.expires_at);

    const due = await shift("NOW() - INTERVAL '14 days'");
    const dueRes = await request(port, 'GET', `/api/public/prototypes/${due.token}`, { key: '' });
    assert.equal(dueRes.status, 410);
    assert.deepEqual(dueRes.json, { error: 'link_expired', expires_at: due.expires_at });
    console.log(`[prototype] expiry 14d-1s => ${earlyRes.status}; at 14d => ${dueRes.status} ${dueRes.json.error} ${dueRes.json.expires_at}`);
  });

  it('prototype: payload includes issued_at and expires_at = issued_at + 14d', async () => {
    process.env.FF_PROTOTYPE_ON_DRAFT = 'true';
    process.env.FF_HIDE_WATERMARK = 'true';
    const lead = await seedLead({ google_place_id: 'test-place-proto-payload' });
    try {
      const proposal = await draftProposal(lead.id);
      const got = await request(port, 'GET', `/api/proposals/${proposal.id}`);
      const link = got.json.prototype;
      const span = await pool.query(
        `SELECT (expires_at = issued_at + INTERVAL '14 days') AS exact,
                EXTRACT(EPOCH FROM (expires_at - issued_at))::int AS seconds
           FROM prototypes WHERE prospect_id = $1 AND revoked_at IS NULL`,
        [lead.id]
      );
      assert.equal(span.rows[0].exact, true);
      assert.equal(span.rows[0].seconds, 14 * 24 * 60 * 60);
      assert.equal(new Date(link.expires_at).getTime() - new Date(link.issued_at).getTime(), 14 * 24 * 60 * 60 * 1000);
      const pub = await request(port, 'GET', `/api/public/prototypes/${tokenOf(link.url)}?watermark=0`, {
        key: '',
        body: { watermark: false },
      });
      assert.equal(pub.status, 200);
      assert.equal(pub.json.watermark, true);
      assert.equal(pub.json.issued_at, new Date(link.issued_at).toISOString());
      assert.equal(pub.json.expires_at, new Date(link.expires_at).toISOString());
      assert.equal(pub.json.brand_name, 'TEST: Wasatch Heating');
      assert.deepEqual(Object.keys(pub.json).sort(), [
        'agent_type', 'brand_name', 'colors', 'expires_at', 'issued_at', 'watermark',
      ]);
      console.log(`[prototype] payload issued_at ${pub.json.issued_at} expires_at ${pub.json.expires_at} watermark ${pub.json.watermark}`);
    } finally {
      delete process.env.FF_HIDE_WATERMARK;
    }
  });

  it('prototype: revoked => 404; unknown token => 404; only token hash stored', async () => {
    process.env.FF_PROTOTYPE_ON_DRAFT = 'true';
    const lead = await seedLead({ google_place_id: 'test-place-proto-revoke' });
    const proposal = await draftProposal(lead.id);
    const row = (await prototypeRows(lead.id))[0];
    const link = await request(port, 'GET', `/api/proposals/${proposal.id}`);
    const token = tokenOf(link.json.prototype.url);
    assert.equal(Buffer.from(token, 'base64url').length, 32);
    const stored = Buffer.from(row.token_hash);
    assert.equal(stored.length, 32);
    const dumped = JSON.stringify({
      ...row,
      token_hash: stored.toString('hex'),
    });
    assert.equal(dumped.includes(token), false);
    const textCols = await pool.query(
      `SELECT brand_name, agent_type, color_primary, color_secondary
         FROM prototypes WHERE id = $1`,
      [row.id]
    );
    assert.equal(JSON.stringify(textCols.rows[0]).includes(token), false);
    assert.equal(stored.equals(hashToken(token)), true);

    const missingKey = await request(port, 'POST', `/api/prototypes/${row.id}/revoke`, { key: '' });
    assert.equal(missingKey.status, 401);
    const bad = await request(port, 'POST', '/api/prototypes/nope/revoke');
    assert.equal(bad.status, 404);
    assert.equal(bad.json.error, 'not_found');
    const revoked = await request(port, 'POST', `/api/prototypes/${row.id}/revoke`);
    assert.equal(revoked.status, 200);
    assert.equal(revoked.json.id, row.id);
    assert.ok(revoked.json.revoked_at);
    const after = await request(port, 'GET', `/api/public/prototypes/${token}`, { key: '' });
    assert.equal(after.status, 404);
    assert.deepEqual(after.json, { error: 'not_found' });
    const unknown = await request(port, 'GET', `/api/public/prototypes/${'a'.repeat(43)}`, { key: '' });
    assert.equal(unknown.status, 404);
    assert.deepEqual(unknown.json, { error: 'not_found' });
    const malformed = await request(port, 'GET', '/api/public/prototypes/not-a-token', { key: '' });
    assert.equal(malformed.status, 404);
    const hidden = await request(port, 'GET', `/api/proposals/${proposal.id}`);
    assert.equal(hidden.json.prototype, null);
    console.log(`[prototype] revoked prototype ${row.id} => 404; unknown token => 404; hash bytes ${stored.length}`);
  });

  it('prototype: hook failure does not fail the draft', async () => {
    process.env.FF_PROTOTYPE_ON_DRAFT = 'true';
    const lead = await seedLead({ google_place_id: 'test-place-proto-hook-fail' });
    scoring.recommendPrototypes = () => {
      throw new Error('rubric exploded');
    };
    try {
      const proposal = await draftProposal(lead.id);
      assert.equal(proposal.status, 'draft');
      assert.equal(proposal.subject, 'Quick idea for Wasatch Heating');
      assert.equal((await prototypeRows(lead.id)).length, 0);
      console.log(`[prototype] hook failure kept draft ${proposal.id} status ${proposal.status}`);
    } finally {
      scoring.recommendPrototypes = originalRecommend;
    }
  });

  it('prototype: no network, no send transport call, no sequence enqueue (Anthropic via draft._setClient)', async () => {
    process.env.FF_PROTOTYPE_ON_DRAFT = 'true';
    const watched = [
      'src/prototypes/flags.js',
      'src/prototypes/tokens.js',
      'src/prototypes/store.js',
      'src/prototypes/public.js',
      'src/api/prototypes.js',
    ];
    const banned = /safeFetch|axios|nodemailer|places\.googleapis|api\.anthropic|from\s+['"](?:node:)?dns|require\(['"](?:node:)?(?:dns|https?|net|tls|undici)|jobs\.enqueue|approveAndSend/;
    for (const file of watched) {
      const text = fs.readFileSync(path.join(ROOT, file), 'utf8');
      assert.equal(banned.test(text), false, file);
    }
    let claudeCalls = 0;
    _setClient({
      messages: {
        async create() {
          claudeCalls += 1;
          return fakeClaude().messages.create();
        },
      },
    });
    const sent = [];
    _setTransport({
      async sendMail(mail) {
        sent.push(mail);
        return { messageId: '<should-not-send@localhost>' };
      },
    });
    const originalEnqueue = jobs.enqueue;
    let enqueued = 0;
    jobs.enqueue = async (...args) => {
      enqueued += 1;
      return originalEnqueue(...args);
    };
    try {
      const lead = await seedLead({ google_place_id: 'test-place-proto-quiet' });
      const beforeJobs = await pool.query('SELECT COUNT(*)::int AS n FROM proposal_jobs');
      const proposal = await draftProposal(lead.id);
      assert.equal(proposal.status, 'draft');
      assert.equal(proposal.followup1_due_at, null);
      assert.equal(proposal.sent_at, null);
      assert.equal(claudeCalls, 1);
      assert.equal(sent.length, 0);
      assert.equal(enqueued, 0);
      const afterJobs = await pool.query('SELECT COUNT(*)::int AS n FROM proposal_jobs');
      assert.equal(afterJobs.rows[0].n, beforeJobs.rows[0].n);
      assert.equal((await prototypeRows(lead.id)).length, 1);
      console.log(`[prototype] quiet draft: claude ${claudeCalls}, transport ${sent.length}, enqueue ${enqueued}, jobs ${afterJobs.rows[0].n}`);
    } finally {
      jobs.enqueue = originalEnqueue;
      _setClient(fakeClaude());
      _setTransport(null);
    }
  });

  it('prototype: schema applied twice is idempotent', async () => {
    process.env.FF_PROTOTYPE_ON_DRAFT = 'true';
    const lead = await seedLead({ google_place_id: 'test-place-proto-schema' });
    await draftProposal(lead.id);
    const before = await pool.query(
      `SELECT id, prospect_id, agent_type, brand_name, color_primary, color_secondary,
              encode(token_hash, 'hex') AS token_hash,
              issued_at, expires_at, revoked_at, created_at
         FROM prototypes ORDER BY id`
    );
    const beforeJson = JSON.stringify(before.rows);
    await applySchema();
    console.log('[prototype] schema boot 1: applySchema ok');
    await applySchema();
    console.log('[prototype] schema boot 2: applySchema ok');
    const after = await pool.query(
      `SELECT id, prospect_id, agent_type, brand_name, color_primary, color_secondary,
              encode(token_hash, 'hex') AS token_hash,
              issued_at, expires_at, revoked_at, created_at
         FROM prototypes ORDER BY id`
    );
    assert.equal(JSON.stringify(after.rows), beforeJson);
    const index = await pool.query(
      `SELECT indexdef FROM pg_indexes WHERE indexname = 'idx_prototypes_one_active'`
    );
    assert.match(index.rows[0].indexdef, /UNIQUE/);
    assert.match(index.rows[0].indexdef, /revoked_at IS NULL/);
    console.log(`[prototype] schema boot 2 row check: prototypes ${before.rows.length} -> ${after.rows.length} (unchanged)`);
  });

  it('prototype: public read is rate limited with the demo limiter', async () => {
    const previousMax = process.env.PILOT_DEMO_RATE_MAX;
    process.env.PILOT_DEMO_RATE_MAX = '2';
    _resetForTests();
    try {
      const first = await request(port, 'GET', `/api/public/prototypes/${'b'.repeat(43)}`, { key: '' });
      const second = await request(port, 'GET', `/api/public/prototypes/${'c'.repeat(43)}`, { key: '' });
      const third = await request(port, 'GET', `/api/public/prototypes/${'d'.repeat(43)}`, { key: '' });
      assert.equal(first.status, 404);
      assert.equal(second.status, 404);
      assert.equal(third.status, 429);
      assert.equal(third.json.error, 'Too many requests');
      assert.ok(third.headers['retry-after']);
      console.log(`[prototype] rate limit third request => ${third.status} retry-after ${third.headers['retry-after']}`);
    } finally {
      if (previousMax == null) delete process.env.PILOT_DEMO_RATE_MAX;
      else process.env.PILOT_DEMO_RATE_MAX = previousMax;
      _resetForTests();
    }
    assert.equal(typeof clientIp, 'function');
    assert.equal(typeof consume, 'function');
    const serverSrc = fs.readFileSync(path.join(ROOT, 'src/server.js'), 'utf8');
    const publicAt = serverSrc.indexOf("app.use('/api/public/prototypes'");
    const guardAt = serverSrc.indexOf("app.use('/api', requireApiKey)");
    const revokeAt = serverSrc.indexOf("app.use('/api/prototypes'");
    assert.ok(publicAt > -1 && publicAt < guardAt);
    assert.ok(revokeAt > guardAt);
  });
});
