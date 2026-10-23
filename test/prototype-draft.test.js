const STRONG_KEY = 'test-prototype-key-32chars-minimum!!';
process.env.CRM_API_KEY = STRONG_KEY;
delete process.env.FF_PROTOTYPE_ON_DRAFT;

require('./preload');

// Prototype rows created from draftProposal. Disposable Postgres, Anthropic
// mock, no live fetch, no mail transport. The public read is loopback HTTP.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const express = require('express');
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { draftProposal, _setClient } = require('../src/proposals/draft');
const { _setTransport } = require('../src/proposals/send');
const jobs = require('../src/proposals/jobs');
const scoring = require('../src/scoring/prototypes');
const { recommendPrototypes } = scoring;
const { hashToken } = require('../src/prototypes/tokens');
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

function request(port, method, reqPath, { body = undefined, key = process.env.CRM_API_KEY, headers: extra } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body == null ? null : Buffer.from(JSON.stringify(body));
    const headers = { accept: 'application/json' };
    if (payload) {
      headers['content-type'] = 'application/json';
      headers['content-length'] = String(payload.length);
    }
    if (key) headers['x-api-key'] = key;
    if (extra) Object.assign(headers, extra);
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
    const { prototypeChatRouter } = require('../src/chatdemo/public');
    app.use('/api/public/prototypes/:token/chat', prototypeChatRouter);
    app.use(express.json());
    app.use('/api/public/prototypes', require('../src/prototypes/public').router);
    app.use('/demo/prototype', require('../src/prototypes/page').router);
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

  it('prototype: flag set to false/off/0/no => draftProposal unchanged, no prototype row', async () => {
    const lead = await seedLead({ google_place_id: 'test-place-proto-flag-off' });
    for (const value of ['false', 'OFF', ' 0 ', 'no']) {
      process.env.FF_PROTOTYPE_ON_DRAFT = value;
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

  it('prototype: feature_flags row off (CRM toggle) => draft saved, no prototype row; env true does not override', async () => {
    const lead = await seedLead({ google_place_id: 'test-place-proto-row-off' });
    await pool.query(`UPDATE feature_flags SET enabled = false WHERE name = 'FF_PROTOTYPE_ON_DRAFT'`);
    try {
      for (const value of [undefined, 'true']) {
        if (value === undefined) delete process.env.FF_PROTOTYPE_ON_DRAFT;
        else process.env.FF_PROTOTYPE_ON_DRAFT = value;
        const proposal = await draftProposal(lead.id);
        assert.equal(proposal.status, 'draft');
        assert.equal(await prototypeRows(lead.id).then((rows) => rows.length), 0);
      }
    } finally {
      await pool.query(`UPDATE feature_flags SET enabled = true WHERE name = 'FF_PROTOTYPE_ON_DRAFT'`);
    }
    delete process.env.FF_PROTOTYPE_ON_DRAFT;
    const proposal = await draftProposal(lead.id);
    assert.equal(proposal.status, 'draft');
    assert.equal(await prototypeRows(lead.id).then((rows) => rows.length), 1);
    console.log('[prototype] row off: prototypes=0 (env unset and env true); row back on with env unset: prototypes=1');
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
    assert.match(got.json.prototype.url, /\/demo\/prototype\/[A-Za-z0-9_-]{43}$/);
    assert.ok(got.json.prototype.issued_at);
    assert.ok(got.json.prototype.expires_at);
    const open = await request(port, 'GET', `/api/public/prototypes/${tokenOf(got.json.prototype.url)}`, { key: 'wrong-key' });
    assert.equal(open.status, 200);
    const anon = await request(port, 'GET', `/api/public/prototypes/${tokenOf(got.json.prototype.url)}`, { key: '' });
    assert.equal(anon.status, 200);
    console.log(`[prototype] flag on: prospect ${lead.id} prototype ${rows[0].id} agent ${rows[0].agent_type}`);
  });

  it('prototype: no pick (pest/franchise/ST) => no row; tie uses rubric order', async () => {
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
    // A tied top score is ordered by the rubric's tie-breaks (PROTOTYPE_PLAY), so it still gets one.
    await draftProposal(tiedLead.id);
    const tiedRows = await prototypeRows(tiedLead.id);
    assert.equal(tiedRows.length, 1);
    console.log(`[prototype] no pick: pest, franchise, servicetitan left prototypes empty; tie resolved to ${tiedRows[0].agent_type}`);
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
      'expires_at', 'id', 'issued_at', 'nonce', 'prospect_id', 'revoked_at', 'token_hash',
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

  it('prototype: expiry boundary — 60s early => 200; at expiry and 60s late => 410 link_expired', async () => {
    process.env.FF_PROTOTYPE_ON_DRAFT = 'true';
    const lead = await seedLead({ google_place_id: 'test-place-proto-expiry' });
    const proposal = await draftProposal(lead.id);
    const created = await request(port, 'GET', `/api/proposals/${proposal.id}`);
    const token = tokenOf(created.json.prototype.url);
    const id = (await prototypeRows(lead.id))[0].id;
    assert.equal(Buffer.from(token, 'base64url').length, 32);

    async function shift(expiresAt) {
      const { rows } = await pool.query(
        `UPDATE prototypes
            SET issued_at = $2::timestamptz - INTERVAL '14 days',
                expires_at = $2::timestamptz
          WHERE id = $1
          RETURNING expires_at`,
        [id, expiresAt]
      );
      return { token, expires_at: new Date(rows[0].expires_at).toISOString() };
    }

    // Millisecond clocks: SQL NOW() carries microseconds, so a same-millisecond
    // read can land before that instant. Anchor both sides to a JS date.
    const early = await shift(new Date(Date.now() + 60 * 1000));
    const earlyRes = await request(port, 'GET', `/api/public/prototypes/${early.token}`, { key: '' });
    assert.equal(earlyRes.status, 200);
    assert.equal(earlyRes.json.expires_at, early.expires_at);
    assert.equal(earlyRes.headers['x-content-type-options'], 'nosniff');

    const due = await shift(new Date());
    const dueRes = await request(port, 'GET', `/api/public/prototypes/${due.token}`, { key: '' });
    assert.equal(dueRes.status, 410);
    assert.deepEqual(dueRes.json, { error: 'link_expired' });
    assert.equal(Object.hasOwn(dueRes.json, 'expires_at'), false);
    assert.equal(dueRes.headers['x-content-type-options'], 'nosniff');

    const late = await shift(new Date(Date.now() - 60 * 1000));
    const lateRes = await request(port, 'GET', `/api/public/prototypes/${late.token}`, { key: '' });
    assert.equal(lateRes.status, 410);
    assert.deepEqual(lateRes.json, { error: 'link_expired' });
    for (const [res, expiresAt] of [[dueRes, due.expires_at], [lateRes, late.expires_at]]) {
      const at = new Date(expiresAt);
      const forms = [at.toISOString(), at.toUTCString(), String(at.getTime()), String(Math.floor(at.getTime() / 1000))];
      for (const [name, value] of Object.entries(res.headers)) {
        assert.equal(/expir/i.test(name), false, `410 header ${name}`);
        if (name === 'date') continue;
        for (const form of forms) assert.equal(String(value).includes(form), false, `410 header ${name} carries the expiry`);
      }
    }
    console.log(`[prototype] expiry 60s early => ${earlyRes.status}; at expiry and 60s late => ${dueRes.status} ${lateRes.status} ${dueRes.json.error}`);
  });

  it('tokensEqual compares one opaque token, and an unknown token still runs one HMAC', async () => {
    const tokens = require('../src/prototypes/tokens');
    const store = require('../src/prototypes/store');
    const a = 'A'.repeat(43);
    // The link token is one opaque value. It is not an id, a nonce, and a mac.
    assert.equal(a.includes('.'), false);
    assert.equal(tokens.tokensEqual(a, a), true);
    assert.equal(tokens.tokensEqual(a, 'B'.repeat(43)), false);
    assert.equal(tokens.tokensEqual(a, a.slice(0, 42)), false);
    assert.equal(tokens.tokensEqual(a, `${a}x`), false);
    assert.equal(tokens.tokensEqual(a, null), false);
    assert.equal(tokens.tokensEqual(null, null), false);
    assert.equal(tokens.tokensEqual('', ''), false);
    assert.equal(tokens.tokensEqual(1, 1), false);
    let calls = 0;
    const orig = tokens.tokenFor;
    tokens.tokenFor = (nonce) => {
      calls += 1;
      return orig(nonce);
    };
    try {
      const miss = await store.lookupToken('C'.repeat(43), new Date());
      assert.equal(miss.status, 404);
      assert.equal(calls, 1);
    } finally {
      tokens.tokenFor = orig;
    }
    console.log('[prototype] tokensEqual is length-safe; a well-formed miss still runs one HMAC');
  });

  it('a prototype link minted before the #101 check (nonce row, same key) is 200', async () => {
    const tokens = require('../src/prototypes/tokens');
    const lead = await seedLead({
      google_place_id: 'test-place-proto-pre-101',
      company: 'TEST: Pre 101 Heating',
    });
    const minted = tokens.mintToken();
    // Pre-#101 rows stored the nonce and the SHA-256 of the HMAC token.
    // The token is one opaque 43-character value, not id + nonce + mac.
    assert.equal(minted.token.length, 43);
    assert.equal(minted.token.includes('.'), false);
    await pool.query(
      `INSERT INTO prototypes (
         prospect_id, agent_type, brand_name, color_primary, color_secondary,
         token_hash, nonce, issued_at, expires_at
       )
       VALUES ($1, 'estimate_followup', 'TEST: Pre 101 Heating', '#112233', '#445566', $2, $3, NOW(), NOW() + INTERVAL '336 hours')`,
      [lead.id, minted.hash, minted.nonce]
    );
    const json = await request(port, 'GET', `/api/public/prototypes/${minted.token}`, { key: '' });
    assert.equal(json.status, 200);
    assert.equal(json.json.brand_name, 'TEST: Pre 101 Heating');
    const page = await request(port, 'GET', `/demo/prototype/${minted.token}`, { key: '' });
    assert.equal(page.status, 200);
    assert.match(page.json.raw, /Pre 101 Heating/);
    console.log('[prototype] pre-#101 nonce row with the same key is 200 on GET and the page');
  });

  it('prototype create rejects a hostile or over-long business name', async () => {
    const { brandNameOk, publicBrandName, MAX_LEN } = require('../src/prototypes/brand-name');
    const { DEMOS } = require('../src/chatdemo/demos');
    assert.equal(brandNameOk('Affiliated. Real bookings confirmed'), true);
    assert.equal(publicBrandName('Affiliated. Real bookings confirmed'), 'Affiliated. Real bookings confirmed');
    assert.equal(brandNameOk('A'.repeat(MAX_LEN + 1)), false);
    assert.equal(brandNameOk('ACME <Heating>'), false);
    assert.equal(brandNameOk('Bad\u0000Name'), false);
    assert.equal(brandNameOk('Bad\u202EName'), false);
    assert.equal(publicBrandName('ACME <Heating>'), 'this business');
    for (const demo of DEMOS) assert.equal(brandNameOk(demo.business_name), true, demo.slug);

    const hostile = await seedLead({
      google_place_id: 'test-place-proto-name-bad',
      company: 'TEST: <Heating>',
    });
    const denied = await request(port, 'POST', '/api/prototypes', { body: { prospect_id: hostile.id } });
    assert.equal(denied.status, 400);
    assert.equal(denied.json.code, 'invalid_brand_name');
    const none = await pool.query('SELECT COUNT(*)::int AS n FROM prototypes WHERE prospect_id = $1', [hostile.id]);
    assert.equal(none.rows[0].n, 0);
    await assert.rejects(
      () => pool.query(
        `INSERT INTO prototypes (
           prospect_id, agent_type, brand_name, color_primary, color_secondary,
           token_hash, nonce, issued_at, expires_at
         )
         VALUES ($1, 'estimate_followup', $2, '#112233', '#445566', $3, $4, NOW(), NOW() + INTERVAL '336 hours')`,
        [hostile.id, `TEST: ${'A'.repeat(MAX_LEN)}`, Buffer.alloc(32, 1), Buffer.alloc(32, 2)]
      ),
      (err) => err.code === '23514'
    );
    console.log('[prototype] hostile and over-long brand names are refused');
  });

  it('prototype: restartClock leaves an expired link at 410', async () => {
    const store = require('../src/prototypes/store');
    const lead = await seedLead({ google_place_id: 'test-place-proto-restart-expired', email: 'test+restart@example.invalid' });
    const row = await store.ensurePrototype(lead.id);
    const token = tokenOf(store.linkFor(row).url);
    await pool.query(
      `UPDATE prototypes
          SET issued_at = stamp.issued_at,
              expires_at = stamp.issued_at + INTERVAL '336 hours'
         FROM (SELECT NOW() - INTERVAL '400 hours' AS issued_at) AS stamp
        WHERE prototypes.id = $1`,
      [row.id]
    );
    const before = await pool.query('SELECT issued_at, expires_at FROM prototypes WHERE id = $1', [row.id]);
    const gone = await request(port, 'GET', `/api/public/prototypes/${token}`, {
      key: '',
      headers: { 'x-forwarded-for': '198.51.100.21' },
    });
    assert.equal(gone.status, 410);
    assert.equal(gone.json.error, 'link_expired');
    const restarted = await store.restartClock(lead.id);
    assert.equal(restarted, null);
    const after = await pool.query('SELECT issued_at, expires_at FROM prototypes WHERE id = $1', [row.id]);
    assert.equal(new Date(after.rows[0].expires_at).toISOString(), new Date(before.rows[0].expires_at).toISOString());
    assert.equal(new Date(after.rows[0].issued_at).toISOString(), new Date(before.rows[0].issued_at).toISOString());
    const still = await request(port, 'GET', `/api/public/prototypes/${token}`, {
      key: '',
      headers: { 'x-forwarded-for': '198.51.100.22' },
    });
    assert.equal(still.status, 410);
    assert.equal(still.json.error, 'link_expired');

    // Expired one minute ago: still 410, and restartClock leaves it alone.
    const recentLead = await seedLead({ google_place_id: 'test-place-proto-restart-recent', email: 'test+restartrecent@example.invalid' });
    const recent = await store.ensurePrototype(recentLead.id);
    await pool.query(
      `UPDATE prototypes SET issued_at = NOW() - INTERVAL '336 hours 1 minute',
                             expires_at = NOW() - INTERVAL '1 minute'
        WHERE id = $1`,
      [recent.id]
    );
    const recentBefore = await pool.query('SELECT expires_at FROM prototypes WHERE id = $1', [recent.id]);
    assert.equal(await store.restartClock(recentLead.id), null);
    const recentAfter = await pool.query('SELECT expires_at FROM prototypes WHERE id = $1', [recent.id]);
    assert.equal(new Date(recentAfter.rows[0].expires_at).toISOString(), new Date(recentBefore.rows[0].expires_at).toISOString());

    // A revoked, unexpired row is not restarted either.
    const revokedLead = await seedLead({ google_place_id: 'test-place-proto-restart-revoked', email: 'test+restartrevoked@example.invalid' });
    const revokedRow = await store.ensurePrototype(revokedLead.id);
    await pool.query(`UPDATE prototypes SET revoked_at = NOW() WHERE id = $1`, [revokedRow.id]);
    const revokedBefore = await pool.query('SELECT issued_at FROM prototypes WHERE id = $1', [revokedRow.id]);
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(await store.restartClock(revokedLead.id), null);
    const revokedAfter = await pool.query('SELECT issued_at FROM prototypes WHERE id = $1', [revokedRow.id]);
    assert.equal(new Date(revokedAfter.rows[0].issued_at).toISOString(), new Date(revokedBefore.rows[0].issued_at).toISOString());

    const liveLead = await seedLead({ google_place_id: 'test-place-proto-restart-live', email: 'test+restartlive@example.invalid' });
    const live = await store.ensurePrototype(liveLead.id);
    const liveBefore = await pool.query('SELECT issued_at FROM prototypes WHERE id = $1', [live.id]);
    await new Promise((resolve) => setTimeout(resolve, 30));
    const moved = await store.restartClock(liveLead.id);
    assert.ok(moved);
    assert.ok(new Date(moved.issued_at).getTime() >= new Date(liveBefore.rows[0].issued_at).getTime());
    assert.equal(new Date(moved.expires_at).getTime() - new Date(moved.issued_at).getTime(), 336 * 3600 * 1000);
    console.log('[prototype] expired link stayed 410 after restartClock; a live link still restarts');
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
        `SELECT (expires_at = issued_at + INTERVAL '336 hours') AS exact,
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
        'agent_type', 'brand_name', 'city', 'colors', 'expires_at', 'industry', 'issued_at', 'watermark',
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
    await pool.query(
      `UPDATE prototypes
          SET issued_at = NOW() - INTERVAL '14 days',
              expires_at = NOW() - INTERVAL '14 days' + INTERVAL '14 days'
        WHERE id = $1`,
      [row.id]
    );
    const expiredRevoked = await request(port, 'GET', `/api/public/prototypes/${token}`, { key: '' });
    assert.equal(expiredRevoked.status, 404);
    assert.deepEqual(expiredRevoked.json, { error: 'not_found' });
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
    const storeSrc = fs.readFileSync(path.join(ROOT, 'src/prototypes/store.js'), 'utf8');
    const beforeMatch = storeSrc.split('async function matchSiteColors')[0];
    assert.equal(beforeMatch.includes('detectBrandColors'), false);
    assert.equal(storeSrc.includes('palette.detectBrandColors'), true);
    const agents = fs.readFileSync(path.join(ROOT, 'AGENTS.md'), 'utf8');
    assert.match(agents, /only prototype route that re-reads the site/);
    assert.match(agents, /fresh research also crawls/);
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

  it('prototype: public read uses its own rate-limit bucket', async () => {
    const previousMax = process.env.PILOT_DEMO_RATE_MAX;
    process.env.PILOT_DEMO_RATE_MAX = '2';
    _resetForTests();
    try {
      const ip = '203.0.113.77';
      assert.equal(consume(ip, 'demo').limited, false);
      assert.equal(consume(ip, 'demo').limited, false);
      assert.equal(consume(ip, 'demo').limited, true);
      const forwarded = { 'x-forwarded-for': ip };
      const first = await request(port, 'GET', `/api/public/prototypes/${'b'.repeat(43)}`, { key: '', headers: forwarded });
      const second = await request(port, 'GET', `/api/public/prototypes/${'c'.repeat(43)}`, { key: '', headers: forwarded });
      const third = await request(port, 'GET', `/api/public/prototypes/${'d'.repeat(43)}`, { key: '', headers: forwarded });
      assert.equal(first.status, 404);
      assert.equal(second.status, 404);
      assert.equal(third.status, 429);
      assert.equal(third.json.error, 'Too many requests');
      assert.equal(third.headers['x-content-type-options'], 'nosniff');
      assert.ok(third.headers['retry-after']);
      const other = await request(port, 'GET', `/api/public/prototypes/${'e'.repeat(43)}`, {
        key: '',
        headers: { 'x-forwarded-for': '203.0.113.78' },
      });
      assert.equal(other.status, 404);
      assert.equal(consume(ip, 'demo').limited, true);
      const publicSrc = fs.readFileSync(path.join(ROOT, 'src/prototypes/public.js'), 'utf8');
      assert.match(publicSrc, /consume\(clientIp\(req\), 'prototype'\)/);
      assert.equal(publicSrc.includes("'demo'"), false);
      console.log(`[prototype] rate limit third request => ${third.status} retry-after ${third.headers['retry-after']} (prototype bucket)`);

      const probe = express();
      probe.set('trust proxy', 1);
      const asReq = (xff) => ({
        app: probe,
        headers: { 'x-forwarded-for': xff },
        socket: { remoteAddress: '10.0.0.8' },
      });
      assert.equal(clientIp(asReq('::ffff:198.51.100.50')), '198.51.100.50');
      assert.equal(clientIp(asReq('198.51.100.50')), clientIp(asReq('::ffff:198.51.100.50')));
      assert.equal(clientIp(asReq('2001:db8:1:2::1')), '2001:db8:1:2::/64');
      assert.equal(clientIp(asReq('2001:db8:1:2::1')), clientIp(asReq('2001:db8:1:2:ffff::9')));
      assert.notEqual(clientIp(asReq('2001:db8:1:3::1')), clientIp(asReq('2001:db8:1:2::1')));
      assert.equal(clientIp(asReq('198.51.100.9, 203.0.113.50')), '203.0.113.50');
      const { bucketIp } = require('../src/chatdemo/ip');
      assert.equal(bucketIp(clientIp(asReq('2001:db8:1:2::1'))), '2001:db8:1:2::/64');
      assert.equal(bucketIp('::ffff:198.51.100.50'), '198.51.100.50');

      _resetForTests();
      process.env.PILOT_DEMO_RATE_MAX = '1';
      const unknown = 'a'.repeat(43);
      const hit = (ip) => request(port, 'GET', `/api/public/prototypes/${unknown}`, {
        key: '',
        headers: { 'x-forwarded-for': ip },
      });
      const v4 = await hit('198.51.100.50');
      const mapped = await hit('::ffff:198.51.100.50');
      assert.equal(v4.status, 404);
      assert.equal(mapped.status, 429);
      assert.equal(mapped.headers['retry-after'] != null, true);
      const v6 = await hit('2001:db8:1:2::1');
      const v6same = await hit('2001:db8:1:2:ffff::9');
      const v6other = await hit('2001:db8:1:3::1');
      assert.equal(v6.status, 404);
      assert.equal(v6same.status, 429);
      assert.equal(v6other.status, 404);
      const pageMapped = await request(port, 'GET', `/demo/prototype/${unknown}`, {
        key: '',
        headers: { 'x-forwarded-for': '::ffff:198.51.100.50' },
      });
      assert.equal(pageMapped.status, 429);
      console.log('[prototype] ::ffff: folds onto the IPv4 key; IPv6 shares a /64; the next /64 does not');
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

  it('prototype: token is an HMAC of a stored nonce; creation needs a strong CRM_API_KEY', async () => {
    process.env.FF_PROTOTYPE_ON_DRAFT = 'true';
    const saved = process.env.CRM_API_KEY;
    const tokens = require('../src/prototypes/tokens');
    try {
      const lead = await seedLead({ google_place_id: 'test-place-proto-hmac' });
      const proposal = await draftProposal(lead.id);
      const { rows } = await pool.query('SELECT nonce, token_hash FROM prototypes WHERE prospect_id = $1', [lead.id]);
      assert.equal(rows.length, 1);
      assert.equal(Buffer.from(rows[0].nonce).length, 32);
      const got = await request(port, 'GET', `/api/proposals/${proposal.id}`, { key: STRONG_KEY });
      const token = tokenOf(got.json.prototype.url);
      assert.equal(Buffer.from(token, 'base64url').length, 32);
      assert.equal(token, tokens.tokenFor(Buffer.from(rows[0].nonce)));
      assert.equal(Buffer.from(rows[0].token_hash).equals(hashToken(token)), true);
      const cols = await pool.query(`SELECT column_name FROM information_schema.columns WHERE table_name = 'prototypes'`);
      assert.equal(cols.rows.some(r => /^token$/.test(r.column_name)), false);

      for (const weak of [undefined, ' '.repeat(40), 'short-key']) {
        if (weak === undefined) delete process.env.CRM_API_KEY; else process.env.CRM_API_KEY = weak;
        const other = await seedLead({ google_place_id: `test-place-proto-weak-${String(weak).length}-${Math.random().toString(36).slice(2)}` });
        await draftProposal(other.id);
        assert.equal((await prototypeRows(other.id)).length, 0);
      }
      console.log('[prototype] token = HMAC(nonce); no row when CRM_API_KEY is unset, blank, or short');
    } finally {
      process.env.CRM_API_KEY = saved;
    }
  });

  it('prototype: url is recomputed after a restart; a rotated key makes old links 404', async () => {
    process.env.FF_PROTOTYPE_ON_DRAFT = 'true';
    const saved = process.env.CRM_API_KEY;
    const lead = await seedLead({ google_place_id: 'test-place-proto-forget' });
    const proposal = await draftProposal(lead.id);
    const got = await request(port, 'GET', `/api/proposals/${proposal.id}`);
    const token = tokenOf(got.json.prototype.url);
    // A fresh module load stands in for a restart: nothing is held in memory.
    for (const k of Object.keys(require.cache)) if (k.includes('/src/prototypes/')) delete require.cache[k];
    const fresh = require('../src/prototypes/store');
    const again = await fresh.prototypeForProposal(lead.id);
    assert.equal(tokenOf(again.url), token);
    const pub = await request(port, 'GET', `/api/public/prototypes/${token}`, { key: '' });
    assert.equal(pub.status, 200);
    try {
      process.env.CRM_API_KEY = 'rotated-prototype-key-32chars-minimum!!';
      const rotated = await fresh.prototypeForProposal(lead.id);
      assert.equal(rotated.url, null);
      assert.equal(rotated.link_problem, 'key_changed');
    } finally {
      process.env.CRM_API_KEY = saved;
    }
    console.log('[prototype] restart: same url recomputed; rotated key: url null, link_problem key_changed');
  });

  it('prototype: rotating or unsetting the key returns 404; the same key stays 200', async () => {
    process.env.FF_PROTOTYPE_ON_DRAFT = 'true';
    const saved = process.env.CRM_API_KEY;
    const keyB = 'rotated-prototype-key-32chars-minimum!!';
    const fwd = (ip) => ({ 'x-forwarded-for': ip });
    try {
      await pool.query(
        `UPDATE feature_flags
            SET enabled = true, updated_at = NULL, updated_by = NULL
          WHERE name = ANY($1::text[])`,
        [['FF_PROTOTYPE_GALLERY', 'FF_LIVE_CHAT_DEMO']]
      );
      const lead = await seedLead({ google_place_id: 'test-place-proto-key-rotate' });
      const proposal = await draftProposal(lead.id);
      const got = await request(port, 'GET', `/api/proposals/${proposal.id}`);
      const token = tokenOf(got.json.prototype.url);
      assert.equal(token.length, 43);

      const liveJson = await request(port, 'GET', `/api/public/prototypes/${token}`, { key: '', headers: fwd('203.0.113.87') });
      assert.equal(liveJson.status, 200);
      const livePage = await request(port, 'GET', `/demo/prototype/${token}`, { key: '', headers: fwd('203.0.113.87') });
      assert.equal(livePage.status, 200);
      const liveChat = await request(port, 'POST', `/api/public/prototypes/${token}/chat/session`, {
        key: '', headers: fwd('203.0.113.87'), body: {},
      });
      assert.equal(liveChat.status, 201);

      const store = require('../src/prototypes/store');
      const future = new Date(Date.now() + 400 * 3600 * 1000);
      assert.equal((await store.lookupToken(token, future)).status, 410);
      assert.equal((await store.lookupToken(token, new Date(Date.now() - 60 * 1000))).status, 200);

      for (const k of Object.keys(require.cache)) if (k.includes('/src/prototypes/')) delete require.cache[k];
      process.env.CRM_API_KEY = keyB;
      const fresh = require('../src/prototypes/store');
      assert.equal((await fresh.lookupToken(token, future)).status, 404);

      const jsonB = await request(port, 'GET', `/api/public/prototypes/${token}`, { key: '', headers: fwd('203.0.113.88') });
      assert.equal(jsonB.status, 404);
      assert.equal(jsonB.json.error, 'not_found');
      const pageB = await request(port, 'GET', `/demo/prototype/${token}`, { key: '', headers: fwd('203.0.113.89') });
      assert.equal(pageB.status, 404);
      const chatB = await request(port, 'POST', `/api/public/prototypes/${token}/chat/session`, {
        key: '', headers: fwd('203.0.113.70'), body: {},
      });
      assert.equal(chatB.status, 404);
      assert.equal(chatB.json.error, 'not_found');

      delete process.env.CRM_API_KEY;
      assert.equal((await store.lookupToken(token, future)).status, 404);
      const jsonUnset = await request(port, 'GET', `/api/public/prototypes/${token}`, { key: '', headers: fwd('203.0.113.71') });
      assert.equal(jsonUnset.status, 404);
      const pageUnset = await request(port, 'GET', `/demo/prototype/${token}`, { key: '', headers: fwd('203.0.113.72') });
      assert.equal(pageUnset.status, 404);
      const chatUnset = await request(port, 'POST', `/api/public/prototypes/${token}/chat/session`, {
        key: '', headers: fwd('203.0.113.73'), body: {},
      });
      assert.equal(chatUnset.status, 404);

      process.env.CRM_API_KEY = saved;
      const jsonA = await request(port, 'GET', `/api/public/prototypes/${token}`, { key: '', headers: fwd('203.0.113.74') });
      assert.equal(jsonA.status, 200);
      const pageA = await request(port, 'GET', `/demo/prototype/${token}`, { key: '', headers: fwd('203.0.113.75') });
      assert.equal(pageA.status, 200);
      console.log('[prototype] key A 200; key B and unset key 404 on public, page, and chat; expiry stays 410 only under the same key');
    } finally {
      process.env.CRM_API_KEY = saved;
      await pool.query(
        `UPDATE feature_flags
            SET enabled = false, updated_at = NULL, updated_by = NULL
          WHERE name = ANY($1::text[])`,
        [['FF_PROTOTYPE_GALLERY', 'FF_LIVE_CHAT_DEMO']]
      );
    }
  });

  it('prototype: revoke fails closed unless the API key has 32 non-whitespace characters', async () => {
    process.env.FF_PROTOTYPE_ON_DRAFT = 'true';
    const saved = process.env.CRM_API_KEY;
    const lead = await seedLead({ google_place_id: 'test-place-proto-writes-off' });
    await draftProposal(lead.id);
    const row = (await prototypeRows(lead.id))[0];
    const weak = [undefined, '', 'short', 'x'.repeat(31), ' '.repeat(32), `${'x'.repeat(31)} `];
    try {
      for (const value of weak) {
        if (value === undefined) delete process.env.CRM_API_KEY;
        else process.env.CRM_API_KEY = value;
        const res = await request(port, 'POST', `/api/prototypes/${row.id}/revoke`, { key: STRONG_KEY });
        assert.equal(res.status, 503, `value ${JSON.stringify(value)}`);
        assert.deepEqual(res.json, { error: 'api_key_not_configured' });
        const nope = await request(port, 'POST', '/api/prototypes/nope/revoke', { key: STRONG_KEY });
        assert.equal(nope.status, 503);
        assert.deepEqual(nope.json, { error: 'api_key_not_configured' });
      }
      const still = await pool.query('SELECT revoked_at FROM prototypes WHERE id = $1', [row.id]);
      assert.equal(still.rows[0].revoked_at, null);
      process.env.CRM_API_KEY = 'y'.repeat(32);
      const stale = await request(port, 'POST', `/api/prototypes/${row.id}/revoke`, { key: STRONG_KEY });
      assert.equal(stale.status, 401);
      assert.deepEqual(stale.json, { error: 'Missing or invalid API key' });
      process.env.CRM_API_KEY = STRONG_KEY;
      const missing = await request(port, 'POST', `/api/prototypes/${row.id}/revoke`, { key: '' });
      assert.equal(missing.status, 401);
      const wrong = await request(port, 'POST', `/api/prototypes/${row.id}/revoke`, { key: 'not-the-key' });
      assert.equal(wrong.status, 401);
      const still2 = await pool.query('SELECT revoked_at FROM prototypes WHERE id = $1', [row.id]);
      assert.equal(still2.rows[0].revoked_at, null);
      console.log(`[prototype] revoke closed for weak keys; prototype ${row.id} stayed active`);
    } finally {
      process.env.CRM_API_KEY = saved;
    }
  });

  it('prototype: public responses set X-Content-Type-Options nosniff', async () => {
    process.env.FF_PROTOTYPE_ON_DRAFT = 'true';
    const previousMax = process.env.PILOT_DEMO_RATE_MAX;
    process.env.PILOT_DEMO_RATE_MAX = '1';
    _resetForTests();
    try {
      const lead = await seedLead({ google_place_id: 'test-place-proto-nosniff' });
      const proposal = await draftProposal(lead.id);
      const link = await request(port, 'GET', `/api/proposals/${proposal.id}`);
      const token = tokenOf(link.json.prototype.url);
      const ip = '203.0.113.90';
      const ok = await request(port, 'GET', `/api/public/prototypes/${token}`, {
        key: '',
        headers: { 'x-forwarded-for': ip },
      });
      assert.equal(ok.status, 200);
      assert.equal(ok.headers['x-content-type-options'], 'nosniff');
      const missing = await request(port, 'GET', `/api/public/prototypes/${'f'.repeat(43)}`, {
        key: '',
        headers: { 'x-forwarded-for': '203.0.113.91' },
      });
      assert.equal(missing.status, 404);
      assert.equal(missing.headers['x-content-type-options'], 'nosniff');
      const limited = await request(port, 'GET', `/api/public/prototypes/${token}`, {
        key: '',
        headers: { 'x-forwarded-for': ip },
      });
      assert.equal(limited.status, 429);
      assert.equal(limited.headers['x-content-type-options'], 'nosniff');
      console.log('[prototype] nosniff on 200, 404, and 429');
    } finally {
      if (previousMax == null) delete process.env.PILOT_DEMO_RATE_MAX;
      else process.env.PILOT_DEMO_RATE_MAX = previousMax;
      _resetForTests();
    }
  });

  it('prototype: errors log err.code and not err.message', async () => {
    process.env.FF_PROTOTYPE_ON_DRAFT = 'true';
    const watched = [
      'src/prototypes/store.js',
      'src/prototypes/public.js',
      'src/api/prototypes.js',
    ];
    for (const file of watched) {
      const text = fs.readFileSync(path.join(ROOT, file), 'utf8');
      assert.equal(text.includes('err.message'), false, file);
    }
    const draftSrc = fs.readFileSync(path.join(ROOT, 'src/proposals/draft.js'), 'utf8');
    assert.equal(draftSrc.includes("[prototype] hook failed:', err.message"), false);
    assert.match(draftSrc, /\[prototype\] hook failed:', err && err\.code/);

    const sentinel = 'LEAK_SENTINEL_do_not_log';
    const lines = [];
    const originalError = console.error;
    const originalQuery = pool.query.bind(pool);
    console.error = (...args) => { lines.push(args.map((part) => String(part)).join(' ')); };
    pool.query = async () => {
      const err = new Error(sentinel);
      err.code = 'PTEST';
      throw err;
    };
    try {
      const pub = await request(port, 'GET', `/api/public/prototypes/${'a'.repeat(43)}`, { key: '' });
      assert.equal(pub.status, 500);
      const revoked = await request(port, 'POST', '/api/prototypes/1/revoke', { key: STRONG_KEY });
      assert.equal(revoked.status, 500);
      pool.query = originalQuery;
      const lead = await seedLead({ google_place_id: 'test-place-proto-log-code' });
      scoring.recommendPrototypes = () => {
        const err = new Error(sentinel);
        err.code = 'PTEST';
        throw err;
      };
      console.error = (...args) => { lines.push(args.map((part) => String(part)).join(' ')); };
      const proposal = await draftProposal(lead.id);
      assert.equal(proposal.status, 'draft');
    } finally {
      console.error = originalError;
      pool.query = originalQuery;
      scoring.recommendPrototypes = originalRecommend;
    }
    assert.ok(lines.some((line) => line.includes('PTEST')));
    assert.equal(lines.some((line) => line.includes(sentinel)), false);
    console.log(`[prototype] error logs include code; message absent (${lines.length} lines)`);
  });

  it('prototype: revoke on the server.js mount fails closed when CRM_API_KEY is weak or unset', { timeout: 180000 }, async () => {
    process.env.FF_PROTOTYPE_ON_DRAFT = 'true';
    const saved = process.env.CRM_API_KEY;
    process.env.CRM_API_KEY = STRONG_KEY;
    const lead = await seedLead({ google_place_id: 'test-place-proto-mount-weak' });
    await draftProposal(lead.id);
    const weakRow = (await prototypeRows(lead.id))[0];
    const strongLead = await seedLead({ google_place_id: 'test-place-proto-mount-strong' });
    await draftProposal(strongLead.id);
    const strongRow = (await prototypeRows(strongLead.id))[0];
    const padded = `  ${'y'.repeat(32)}  `;
    const paddedLead = await seedLead({ google_place_id: 'test-place-proto-mount-padded' });
    await draftProposal(paddedLead.id);
    const paddedRow = (await prototypeRows(paddedLead.id))[0];

    async function freePort() {
      return new Promise((resolve, reject) => {
        const probe = http.createServer();
        probe.once('error', reject);
        probe.listen(0, '127.0.0.1', () => {
          const chosen = probe.address().port;
          probe.close(() => resolve(chosen));
        });
      });
    }

    async function boot(key) {
      const listenPort = await freePort();
      const env = { ...process.env, PORT: String(listenPort), NODE_ENV: 'test', DISABLE_CRON: '1' };
      if (key === undefined) delete env.CRM_API_KEY;
      else env.CRM_API_KEY = key;
      let output = '';
      const child = spawn(process.execPath, [path.join(ROOT, 'src/server.js')], {
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      child.stdout.on('data', (buf) => { output += buf.toString('utf8'); });
      child.stderr.on('data', (buf) => { output += buf.toString('utf8'); });
      const getOutput = () => output;
      try {
        await new Promise((resolve, reject) => {
          const deadline = Date.now() + 20000;
          const attempt = () => {
            if (child.exitCode != null) {
              reject(new Error(`server exited ${child.exitCode}: ${getOutput().slice(0, 500)}`));
              return;
            }
            const req = http.request({
              method: 'GET', hostname: '127.0.0.1', port: listenPort, path: '/health',
            }, (res) => {
              res.resume();
              res.on('end', () => resolve(res.statusCode));
            });
            req.on('error', () => {
              if (Date.now() > deadline) reject(new Error(`server did not listen: ${getOutput().slice(0, 500)}`));
              else setTimeout(attempt, 100);
            });
            req.end();
          };
          attempt();
        });
        return { listenPort, child, output: getOutput };
      } catch (err) {
        child.kill('SIGKILL');
        throw err;
      }
    }

    async function stop(child) {
      if (!child || child.exitCode != null) return;
      child.kill('SIGTERM');
      await new Promise((resolve) => {
        const timer = setTimeout(() => { child.kill('SIGKILL'); }, 2000);
        child.once('exit', () => { clearTimeout(timer); resolve(); });
      });
    }

    const cases = [
      { name: 'unset', key: undefined, header: '' },
      { name: 'empty', key: '', header: '' },
      { name: 'short', key: 'short', header: 'short' },
      { name: '31', key: 'x'.repeat(31), header: 'x'.repeat(31) },
      { name: 'spaces', key: ' '.repeat(32), header: ' '.repeat(32) },
      // 17 non-whitespace characters with inner spaces. #90 item 6 measured
      // 401 or writes_disabled here. #91 already answers 503 api_key_not_configured.
      { name: 'inner-17', key: `${'n'.repeat(8)}${' '.repeat(20)}${'n'.repeat(9)}`, header: '' },
    ];
    try {
      for (const item of cases) {
        const started = await boot(item.key);
        try {
          const res = await request(started.listenPort, 'POST', `/api/prototypes/${weakRow.id}/revoke`, { key: item.header });
          assert.equal(res.status, 503, item.name);
          assert.deepEqual(res.json, { error: 'api_key_not_configured' });
          assert.notEqual(res.json.error, 'writes_disabled', item.name);
          const missingHeader = await request(started.listenPort, 'POST', '/api/prototypes', {
            key: '',
            body: { prospect_id: weakRow.prospect_id },
          });
          assert.equal(missingHeader.status, 503, `${item.name} missing header`);
          assert.deepEqual(missingHeader.json, { error: 'api_key_not_configured' });
          const secret = String(item.header || item.key || '').trim();
          if (secret) assert.equal(started.output().includes(secret), false, item.name);
        } finally {
          await stop(started.child);
        }
      }
      const untouched = await pool.query('SELECT revoked_at FROM prototypes WHERE id = $1', [weakRow.id]);
      assert.equal(untouched.rows[0].revoked_at, null);

      const strong = await boot(STRONG_KEY);
      try {
        const missing = await request(strong.listenPort, 'POST', `/api/prototypes/${strongRow.id}/revoke`, { key: '' });
        assert.equal(missing.status, 401);
        const wrong = await request(strong.listenPort, 'POST', `/api/prototypes/${strongRow.id}/revoke`, { key: 'short' });
        assert.equal(wrong.status, 401);
        const ok = await request(strong.listenPort, 'POST', `/api/prototypes/${strongRow.id}/revoke`, { key: STRONG_KEY });
        assert.equal(ok.status, 200);
        assert.equal(ok.json.id, strongRow.id);
        assert.ok(ok.json.revoked_at);
      } finally {
        await stop(strong.child);
      }
      const revoked = await pool.query('SELECT revoked_at FROM prototypes WHERE id = $1', [strongRow.id]);
      assert.ok(revoked.rows[0].revoked_at);

      const paddedBoot = await boot(padded);
      try {
        // Node drops leading and trailing spaces on the header, so the raw
        // padded key cannot be presented. The route is open (not 503) and
        // still refuses the trimmed header.
        const trimmed = await request(paddedBoot.listenPort, 'POST', `/api/prototypes/${paddedRow.id}/revoke`, { key: padded });
        assert.equal(trimmed.status, 401);
        assert.notEqual(trimmed.json.error, 'writes_disabled');
      } finally {
        await stop(paddedBoot.child);
      }
      const paddedStill = await pool.query('SELECT revoked_at FROM prototypes WHERE id = $1', [paddedRow.id]);
      assert.equal(paddedStill.rows[0].revoked_at, null);
      console.log(`[prototype] server.js mount: weak/unset => 503; strong key required; prototype ${weakRow.id} stayed active`);
    } finally {
      process.env.CRM_API_KEY = saved;
    }
  });
});
