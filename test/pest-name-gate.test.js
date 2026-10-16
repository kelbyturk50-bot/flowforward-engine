require('./preload');

// F-005 steps 1 and 2. Cache-only company-name gate. Disposable Postgres.
// No Places, Anthropic, Gmail, or live site.

process.env.EXCLUDED_INDUSTRIES = 'Pest Control';
process.env.CRM_API_KEY = '';
// Follow-ups send only inside the Denver window. Open it in this process so
// the skip can be tested at any hour. Set before proposals/config loads.
process.env.SEND_HOURS = '0,24';
process.env.SEND_DAYS = '0,1,2,3,4,5,6';

const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const { spawnSync } = require('child_process');
const express = require('express');
const axios = require('axios');
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const catalog = require('../src/bot/industries');
const { INDUSTRIES } = require('../src/bot/discover');
const { computeFit, rescore } = require('../src/scoring/fit');
const { isFranchise } = require('../src/scoring/prototypes');
const {
  PEST_NAME_REASON,
  PEST_TEXT_PATTERN,
  isPestCompanyName,
  isPestText,
  legacyPestNameCountQuery,
} = require('../src/scoring/industry');
const { FRANCHISE_PATTERNS } = require('../src/scoring/config');
const { draftProposal, pickLeads, _setClient } = require('../src/proposals/draft');
const { sendDueFollowups, _setTransport } = require('../src/proposals/send');
const { buildProspectListQuery } = require('../src/api/prospect-query');
const { resetDb, insertProspect, closePool, pool, fakeClaude } = require('./fixtures');

// Post-F-004 Places catalog. This gate must not add a query type.
const PLACES_QUERY_COUNT = 16;

const sweet = {
  company: 'Wasatch Heating',
  industry: 'HVAC',
  website: 'https://wasatchheating.example',
  phone: '(801) 555-0100',
  city: 'Provo',
  state: 'UT',
  rating: 4.0,
  review_count: 80,
  fit_boost: 0,
};

// Scores from before this gate. None of these names match the pest pattern.
const SNAPSHOT = [
  ['HVAC sweet spot', sweet, 100, 'A'],
  ['Plumbing', { ...sweet, company: 'Provo Plumbing', industry: 'Plumbing' }, 97, 'A'],
  ['Electrical', { ...sweet, company: 'Provo Electric', industry: 'Electrical' }, 83, 'A'],
  ['Roofing', { ...sweet, company: 'Provo Roofing', industry: 'Roofing' }, 83, 'A'],
  ['Landscaping', { ...sweet, company: 'Provo Lawns', industry: 'Landscaping' }, 77, 'B'],
  ['Painting', { ...sweet, company: 'Provo Paint', industry: 'Painting' }, 77, 'B'],
  ['Construction', { ...sweet, company: 'Provo Builders', industry: 'Construction' }, 77, 'B'],
  ['Cleaning', { ...sweet, company: 'Provo Clean', industry: 'Cleaning' }, 73, 'B'],
  ['Gutters out of market', {
    company: 'Quiet Gutters',
    industry: 'Gutters',
    website: null,
    phone: null,
    city: 'Denver',
    state: 'CO',
    rating: null,
    review_count: 0,
  }, 14, 'D'],
  ['Windows', { ...sweet, company: 'Provo Windows', industry: 'Windows' }, 73, 'B'],
  ['social HVAC', { ...sweet, website: 'https://facebook.com/wasatchheating' }, 94, 'A'],
  ['Landscaping with a positive boost', { ...sweet, company: 'Provo Lawns', industry: 'Landscaping', fit_boost: 10 }, 87, 'A'],
  ['Cleaning with a positive boost', { ...sweet, company: 'Provo Clean', industry: 'Cleaning', fit_boost: 20 }, 93, 'A'],
  ['Jobber', { ...sweet, fsm_detected: 'Jobber' }, 100, 'A'],
  ['Housecall Pro', { ...sweet, fsm_detected: 'Housecall Pro' }, 100, 'A'],
  ['marginal HVAC, no fsm', { ...sweet, company: 'Denver Heating', city: 'Denver', state: 'CO', review_count: 5 }, 70, 'B'],
  ['marginal HVAC ServiceTitan already under the ceiling', {
    ...sweet,
    company: 'Denver Heating',
    city: 'Denver',
    state: 'CO',
    review_count: 5,
    fsm_detected: 'ServiceTitan',
  }, 55, 'C'],
  ['pest industry stays excluded', {
    ...sweet,
    company: 'Terminix',
    industry: 'Pest Control',
    fsm_detected: 'ServiceTitan',
    fit_boost: 20,
  }, 0, 'D'],
  ['franchise substring lookalike still 80', { ...sweet, company: 'TEST: Constrane Heating' }, 80, 'A'],
  ['word-boundary franchise still capped', { ...sweet, company: 'TEST: Trane Heating' }, 77, 'B'],
  ['Pestana Plumbing', { ...sweet, company: 'Pestana Plumbing', industry: 'Plumbing' }, 97, 'A'],
  ['Compest', { ...sweet, company: 'Compest', industry: 'HVAC' }, 100, 'A'],
  ['Best Heating', { ...sweet, company: 'Best Heating', industry: 'HVAC' }, 100, 'A'],
  ['Best', { ...sweet, company: 'Best', industry: 'Plumbing' }, 97, 'A'],
  ['Pestana', { ...sweet, company: 'Pestana', industry: 'HVAC' }, 100, 'A'],
  ['Pesticide Solutions', { ...sweet, company: 'Pesticide Solutions', industry: 'HVAC' }, 100, 'A'],
  ['pest name under HVAC scores like HVAC', { ...sweet, company: 'Wasatch Pest Control', industry: 'HVAC' }, 100, 'A'],
  ['pest name under plumbing scores like plumbing', { ...sweet, company: 'ACME EXTERMINATORS', industry: 'Plumbing' }, 97, 'A'],
  ['termite name under HVAC', { ...sweet, company: 'Valley Termite', industry: 'HVAC' }, 100, 'A'],
  ['exterminating name under plumbing', { ...sweet, company: 'Provo Exterminating', industry: 'Plumbing' }, 97, 'A'],
];

const GATED = [
  ['Wasatch Pest Control', 'HVAC'],
  ['ACME EXTERMINATORS', 'Plumbing'],
  ['Valley Termite', 'HVAC'],
  ['Provo Exterminating', 'Plumbing'],
  ['  The Pests  ', 'HVAC'],
];

const LOOKALIKES = ['Pestana Plumbing', 'Compest', 'Best Heating', 'Best', 'Pestana', 'Pesticide Solutions'];

function armNoFetch() {
  const hits = [];
  const saved = [];
  const note = (name) => () => {
    hits.push(name);
    const err = new Error(`unexpected fetch via ${name}`);
    err.code = 'PEST_NAME_FETCH';
    throw err;
  };
  function patch(obj, key, name) {
    saved.push([obj, key, obj[key]]);
    obj[key] = note(name);
  }
  patch(http, 'request', 'http.request');
  patch(http, 'get', 'http.get');
  patch(https, 'request', 'https.request');
  patch(https, 'get', 'https.get');
  patch(axios, 'request', 'axios.request');
  patch(axios, 'get', 'axios.get');
  const prevFetch = global.fetch;
  global.fetch = note('fetch');
  return {
    hits,
    restore() {
      for (const [obj, key, fn] of saved) obj[key] = fn;
      global.fetch = prevFetch;
    },
  };
}

describe('pest company-name gate', { concurrency: false }, () => {
  let claudeCalls = 0;
  let server;
  let apiBase;

  before(async () => {
    await resetDb();
    _setClient({
      messages: {
        async create() {
          claudeCalls += 1;
          return fakeClaude().messages.create();
        },
      },
    });
    const app = express();
    app.use(express.json());
    app.use('/api', require('../src/api/auth'));
    app.use('/api/prospects', require('../src/api/prospects'));
    app.use('/api/focus', require('../src/api/focus'));
    app.use('/api/proposals', require('../src/api/proposals'));
    server = http.createServer(app);
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    apiBase = `http://127.0.0.1:${server.address().port}`;
  });

  after(async () => {
    _setClient(null);
    _setTransport(null);
    if (server) await new Promise(resolve => server.close(resolve));
    await closePool();
  });

  it('matches pest names on a word boundary and does not change their score', () => {
    const guard = armNoFetch();
    try {
      for (const name of LOOKALIKES) {
        assert.equal(isPestText(name), false, name);
        assert.equal(isPestCompanyName(name), false, name);
      }
      for (const [company, industry] of GATED) {
        assert.equal(isPestText(company), true, company);
        assert.equal(isPestCompanyName(company), true, company);
        const fields = { ...sweet, industry, fit_boost: 20, fsm_detected: 'ServiceTitan' };
        const fit = computeFit({ ...fields, company });
        const twin = computeFit({
          ...fields,
          company: industry === 'Plumbing' ? 'Provo Plumbing' : 'Wasatch Heating',
        });
        assert.equal(fit.fit_score, twin.fit_score, company);
        assert.equal(fit.fit_tier, twin.fit_tier, company);
        assert.equal(JSON.stringify(fit.fit_reasons), JSON.stringify(twin.fit_reasons), company);
        assert.equal(fit.fit_reasons.some(r => r.detail === PEST_NAME_REASON), false, company);
      }

      const industryFirst = computeFit({
        ...sweet,
        company: 'Lehi Pest',
        industry: 'Pest Control',
      });
      assert.equal(industryFirst.fit_score, 0);
      assert.equal(industryFirst.fit_tier, 'D');
      assert.equal(industryFirst.fit_reasons[0].detail, 'Pest Control — out of scope');
    } finally {
      guard.restore();
    }
    assert.deepEqual(guard.hits, []);
  });

  it('leaves every other scored fixture unchanged', () => {
    const guard = armNoFetch();
    try {
      for (const [name, row, score, tier] of SNAPSHOT) {
        const fit = computeFit(row);
        assert.equal(fit.fit_score, score, name);
        assert.equal(fit.fit_tier, tier, name);
        assert.equal(fit.fit_reasons.some(r => r.label === 'Company'), false, name);
      }
      assert.equal(isFranchise('TEST: Trane Heating', FRANCHISE_PATTERNS), true);
      assert.equal(isFranchise('TEST: Constrane Heating', FRANCHISE_PATTERNS), false);
      assert.equal(isFranchise('Pestana Plumbing', FRANCHISE_PATTERNS), false);
    } finally {
      guard.restore();
    }
    assert.deepEqual(guard.hits, []);
  });

  it('does not add a Places query and does not fetch from the score path', () => {
    assert.equal(catalog.length, PLACES_QUERY_COUNT);
    assert.equal(INDUSTRIES.length, PLACES_QUERY_COUNT);
    assert.equal(catalog.some(row => /pest|exterminator|termite/i.test(`${row.query} ${row.industry}`)), false);
    const fitSrc = fs.readFileSync(path.join(__dirname, '../src/scoring/fit.js'), 'utf8');
    assert.doesNotMatch(fitSrc, /axios|fetch\(|searchPlaces|google-places|researchLead|isPestCompanyName|PEST_NAME_REASON/);
    const schema = fs.readFileSync(path.join(__dirname, '../src/db/schema.sql'), 'utf8');
    const pilot = fs.readFileSync(path.join(__dirname, '../src/db/pilot-schema.sql'), 'utf8');
    assert.doesNotMatch(schema, /PEST_NAME_REASON|legacy pest/);
    assert.doesNotMatch(pilot, /PEST_NAME_REASON|legacy pest/);
  });

  it('refuses to draft a gated row even when the stored tier is still A', async () => {
    const pest = await insertProspect({
      google_place_id: 'test-place-wasatch-pest-hvac',
      company: 'Wasatch Pest Control',
      industry: 'HVAC',
      website: 'https://wasatch-pest.example',
      email: 'test+pest@example.com',
    });
    const lookalike = await insertProspect({
      google_place_id: 'test-place-pestana',
      company: 'Pestana Plumbing',
      industry: 'Plumbing',
      website: null,
      email: 'test+pestana@example.com',
    });
    const exterminator = await insertProspect({
      google_place_id: 'test-place-acme-exterminators',
      company: 'ACME EXTERMINATORS',
      industry: 'Plumbing',
      website: 'https://acme-exterminators.example',
      email: 'test+exterminator@example.com',
    });
    await pool.query(
      `UPDATE prospects SET fit_tier = 'A', fit_score = 100, stage = 'found' WHERE id = ANY($1::int[])`,
      [[pest.id, lookalike.id, exterminator.id]]
    );

    const picked = await pickLeads(50);
    const pickedIds = new Set(picked.map(row => row.id));
    assert.equal(pickedIds.has(pest.id), false);
    assert.equal(pickedIds.has(exterminator.id), false);
    assert.equal(pickedIds.has(lookalike.id), true);

    const before = claudeCalls;
    const guard = armNoFetch();
    try {
      await assert.rejects(
        () => draftProposal(pest.id),
        (err) => {
          assert.equal(err.status, 409);
          assert.equal(err.message, `${PEST_NAME_REASON}.`);
          assert.doesNotMatch(err.message, /Wasatch|Pest Control Co|example\.com/i);
          return true;
        }
      );
      await assert.rejects(() => draftProposal(exterminator.id), (err) => {
        assert.equal(err.status, 409);
        assert.equal(err.message, `${PEST_NAME_REASON}.`);
        return true;
      });
    } finally {
      guard.restore();
    }
    assert.deepEqual(guard.hits, []);
    assert.equal(claudeCalls, before);

    const stored = await pool.query(
      'SELECT fit_tier, fit_score FROM prospects WHERE id = ANY($1::int[])',
      [[pest.id, exterminator.id]]
    );
    assert.ok(stored.rows.every(row => row.fit_tier === 'A' && row.fit_score === 100));

    const proposals = await pool.query(
      'SELECT id FROM proposals WHERE prospect_id = ANY($1::int[])',
      [[pest.id, exterminator.id]]
    );
    assert.equal(proposals.rows.length, 0);

    const drafted = await draftProposal(lookalike.id);
    assert.equal(drafted.status, 'draft');
    assert.equal(claudeCalls, before + 1);

    const res = await fetch(apiBase + '/api/proposals', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prospect_id: exterminator.id }),
    });
    const json = await res.json();
    assert.equal(res.status, 409);
    assert.deepEqual(json, { error: `${PEST_NAME_REASON}.` });
    const jobs = await pool.query('SELECT id FROM proposal_jobs WHERE prospect_id = $1', [exterminator.id]);
    assert.equal(jobs.rows.length, 0);
    assert.equal(claudeCalls, before + 1);
  });

  it('a boot-shaped rescore leaves pest-name rows byte-identical to main', async () => {
    await resetDb();
    const pest = await insertProspect({
      google_place_id: 'test-place-boot-pest',
      company: 'Wasatch Pest Control',
      industry: 'HVAC',
      website: 'https://wasatch-pest.example',
      email: 'test+bootpest@example.com',
    });
    const twin = await insertProspect({
      google_place_id: 'test-place-boot-twin',
      company: 'Wasatch Heating',
      industry: 'HVAC',
      website: 'https://wasatchheating.example',
      email: 'test+boottwin@example.com',
    });
    const low = await insertProspect({
      google_place_id: 'test-place-boot-b',
      company: 'Valley Termite',
      industry: 'HVAC',
      website: null,
      email: 'test+bootb@example.com',
      review_count: 0,
      rating: null,
      city: 'Denver',
      state: 'CO',
    });
    const lookalike = await insertProspect({
      google_place_id: 'test-place-boot-pestana',
      company: 'Pestana Plumbing',
      industry: 'Plumbing',
      website: null,
      email: 'test+bootpestana@example.com',
    });

    const mainPest = computeFit({ ...sweet, company: 'Wasatch Pest Control' });
    const mainTwin = computeFit(sweet);
    assert.equal(mainPest.fit_score, 100);
    assert.equal(mainPest.fit_tier, 'A');
    assert.equal(JSON.stringify(mainPest.fit_reasons), JSON.stringify(mainTwin.fit_reasons));

    await rescore();
    const read = () => pool.query(
      `SELECT id, fit_score, fit_tier, fit_reasons::text AS reasons, updated_at
         FROM prospects ORDER BY id`
    );
    const before = await read();
    const byId = (rows, id) => rows.find(row => row.id === id);
    const pestBefore = byId(before.rows, pest.id);
    const twinBefore = byId(before.rows, twin.id);
    assert.equal(pestBefore.fit_score, twinBefore.fit_score);
    assert.equal(pestBefore.fit_tier, twinBefore.fit_tier);
    assert.equal(pestBefore.reasons, twinBefore.reasons);
    assert.equal(pestBefore.fit_score, 100);
    assert.equal(pestBefore.fit_tier, 'A');

    await rescore();
    const after = await read();
    for (const row of before.rows) {
      const next = byId(after.rows, row.id);
      assert.equal(next.fit_score, row.fit_score, row.id);
      assert.equal(next.fit_tier, row.fit_tier, row.id);
      assert.equal(next.reasons, row.reasons, row.id);
      assert.equal(new Date(next.updated_at).toISOString(), new Date(row.updated_at).toISOString(), row.id);
    }

    // A stored B is not the A-tier queue. The read filter must leave it visible.
    await pool.query(`UPDATE prospects SET fit_tier = 'B' WHERE id = $1`, [low.id]);

    const aOnly = buildProspectListQuery({ tier: 'A' });
    assert.match(aOnly.listSql, /fit_tier = 'A'/);
    assert.equal(aOnly.params.includes(PEST_TEXT_PATTERN), true);
    const anyTier = buildProspectListQuery({});
    const bOnly = buildProspectListQuery({ tier: 'B' });
    assert.equal(anyTier.params.includes(PEST_TEXT_PATTERN), false);
    assert.equal(bOnly.params.includes(PEST_TEXT_PATTERN), false);

    const stamp = await read();
    async function get(path) {
      const res = await fetch(apiBase + path);
      const json = await res.json();
      assert.equal(res.status, 200, path + ' ' + JSON.stringify(json));
      return json;
    }
    const tierA = await get('/api/prospects?tier=A');
    const tierAB = await get('/api/prospects?tier=A,B');
    const tierB = await get('/api/prospects?tier=B');
    const all = await get('/api/prospects');
    const one = await get(`/api/prospects/${pest.id}`);
    const focus = await get('/api/focus');
    const summary = await get('/api/proposals/summary');

    const ids = (body) => new Set((body.prospects || []).map(row => row.id));
    assert.equal(ids(tierA).has(pest.id), false);
    assert.equal(ids(tierA).has(twin.id), true);
    assert.equal(ids(tierA).has(lookalike.id), true);
    assert.equal(ids(tierAB).has(pest.id), false);
    assert.equal(ids(tierAB).has(twin.id), true);
    assert.equal(ids(tierB).has(low.id), true);
    assert.equal(ids(tierAB).has(low.id), true);
    assert.equal(ids(all).has(pest.id), true);
    const listed = all.prospects.find(row => row.id === pest.id);
    assert.equal(listed.fit_score, 100);
    assert.equal(listed.fit_tier, 'A');
    assert.equal(one.fit_score, 100);
    assert.equal(one.fit_tier, 'A');
    assert.deepEqual(one.fit_reasons, mainPest.fit_reasons);

    assert.equal(focus.top_new_leads.some(row => row.id === pest.id), false);
    assert.equal(focus.top_new_leads.some(row => row.id === twin.id), true);
    assert.equal(focus.counts.a_tier_open, tierA.total);

    const eligibleIds = new Set((await pickLeads(50)).map(row => row.id));
    assert.equal(eligibleIds.has(pest.id), false);
    assert.equal(eligibleIds.has(twin.id), true);
    assert.equal(summary.eligible_leads, eligibleIds.size);

    const untouched = await read();
    for (const row of stamp.rows) {
      const next = byId(untouched.rows, row.id);
      assert.equal(next.fit_score, row.fit_score);
      assert.equal(next.fit_tier, row.fit_tier);
      assert.equal(next.reasons, row.reasons);
      assert.equal(new Date(next.updated_at).toISOString(), new Date(row.updated_at).toISOString());
    }
  });

  it('refuses send, follow-up, and restore for a pest name and still sends other rows', async () => {
    await resetDb();
    const sentMail = [];
    _setTransport({
      async sendMail(mail) {
        sentMail.push(mail);
        return { messageId: '<pest-gate@localhost>', threadId: 'thr-pest-gate' };
      },
    });

    const heating = await insertProspect({
      google_place_id: 'test-place-send-heating',
      company: 'Wasatch Heating',
      industry: 'HVAC',
      website: null,
      email: 'test+heating-send@example.com',
    });
    const lookalike = await insertProspect({
      google_place_id: 'test-place-send-pestana',
      company: 'Pestana Plumbing',
      industry: 'Plumbing',
      website: null,
      email: 'test+pestana-send@example.com',
    });
    const clean = await insertProspect({
      google_place_id: 'test-place-send-clean',
      company: 'Provo Heating',
      industry: 'HVAC',
      website: null,
      email: 'test+clean-send@example.com',
    });
    const restoreLead = await insertProspect({
      google_place_id: 'test-place-send-restore',
      company: 'Best Heating',
      industry: 'HVAC',
      website: null,
      email: 'test+restore-send@example.com',
    });

    async function insertProposal(prospectId, slug, status, extra = {}) {
      const { rows } = await pool.query(
        `INSERT INTO proposals (
           prospect_id, version, status, slug, to_email, to_name, subject, body, followup1, followup2,
           sent_at, followup1_due_at, message_id
         ) VALUES (
           $1, 1, $2, $3, $4, 'Dana', 'A note', 'Hello from the draft.', 'Checking back.', 'Last note.',
           $5, $6, $7
         ) RETURNING id`,
        [
          prospectId,
          status,
          slug,
          extra.to_email,
          extra.sent_at || null,
          extra.followup1_due_at || null,
          extra.message_id || null,
        ]
      );
      return rows[0].id;
    }

    const pestDraft = await insertProposal(heating.id, 'wasatch-heating-send', 'draft', {
      to_email: 'test+pestsend@example.com',
    });
    await pool.query(`UPDATE prospects SET company = 'Wasatch Pest Control' WHERE id = $1`, [heating.id]);
    const lookalikeDraft = await insertProposal(lookalike.id, 'pestana-send', 'draft', {
      to_email: 'test+pestana-send@example.com',
    });
    const pestFollow = await insertProposal(heating.id, 'wasatch-pest-followup', 'sent', {
      to_email: 'test+pestsend@example.com',
      sent_at: new Date(),
      followup1_due_at: new Date(Date.now() - 60 * 60 * 1000),
      message_id: '<pest-first@localhost>',
    });
    const cleanFollow = await insertProposal(clean.id, 'provo-heating-followup', 'sent', {
      to_email: 'test+clean-fu@example.com',
      sent_at: new Date(),
      followup1_due_at: new Date(Date.now() - 60 * 60 * 1000),
      message_id: '<clean-first@localhost>',
    });
    const cleanDiscarded = await insertProposal(restoreLead.id, 'best-heating-discarded', 'discarded', {
      to_email: 'test+clean-restore@example.com',
    });

    async function proposalState(id) {
      const { rows } = await pool.query(
        `SELECT status, approved_at, sent_at, followup1_sent_at, followup2_sent_at, error, stop_reason, updated_at
           FROM proposals WHERE id = $1`,
        [id]
      );
      return rows[0];
    }
    async function prospectState(id) {
      const { rows } = await pool.query(
        `SELECT fit_score, fit_tier, fit_reasons::text AS reasons, stage, updated_at
           FROM prospects WHERE id = $1`,
        [id]
      );
      return rows[0];
    }
    function sameTime(a, b) {
      if (a == null && b == null) return;
      assert.equal(new Date(a).toISOString(), new Date(b).toISOString());
    }

    const pestDraftBefore = await proposalState(pestDraft);
    const pestLeadBefore = await prospectState(heating.id);
    const pestFollowBefore = await proposalState(pestFollow);

    const sendRes = await fetch(`${apiBase}/api/proposals/${pestDraft}/send`, { method: 'POST' });
    const sendJson = await sendRes.json();
    assert.equal(sendRes.status, 409);
    assert.deepEqual(sendJson, { error: `${PEST_NAME_REASON}.` });
    assert.equal(sentMail.length, 0);
    const pestDraftAfter = await proposalState(pestDraft);
    assert.equal(pestDraftAfter.status, 'draft');
    assert.equal(pestDraftAfter.approved_at, null);
    sameTime(pestDraftAfter.updated_at, pestDraftBefore.updated_at);
    const pestLeadAfter = await prospectState(heating.id);
    assert.equal(pestLeadAfter.fit_score, pestLeadBefore.fit_score);
    assert.equal(pestLeadAfter.fit_tier, pestLeadBefore.fit_tier);
    assert.equal(pestLeadAfter.reasons, pestLeadBefore.reasons);
    assert.equal(pestLeadAfter.stage, pestLeadBefore.stage);

    const okSend = await fetch(`${apiBase}/api/proposals/${lookalikeDraft}/send`, { method: 'POST' });
    const okJson = await okSend.json();
    assert.equal(okSend.status, 200, JSON.stringify(okJson));
    assert.equal(okJson.status, 'sent');
    assert.equal(sentMail.length, 1);
    assert.equal(sentMail[0].to.address, 'test+pestana-send@example.com');

    const logs = [];
    const origError = console.error;
    console.error = (...args) => { logs.push(args.map(String).join(' ')); };
    let followResult;
    try {
      followResult = await sendDueFollowups();
    } finally {
      console.error = origError;
    }
    assert.equal(followResult.sent, 1);
    assert.equal(sentMail.length, 2);
    assert.equal(sentMail.some(mail => mail.to.address === 'test+pestsend@example.com'), false);
    assert.equal(sentMail[1].to.address, 'test+clean-fu@example.com');
    const logged = logs.join('\n');
    assert.match(logged, /skipped follow-up: company name matches pest control/);
    assert.equal(logged.includes('Wasatch'), false);
    assert.equal(logged.includes('test+'), false);
    assert.equal(logged.includes('@'), false);

    const pestFollowAfter = await proposalState(pestFollow);
    assert.equal(pestFollowAfter.status, 'sent');
    assert.equal(pestFollowAfter.followup1_sent_at, null);
    assert.equal(pestFollowAfter.error, null);
    sameTime(pestFollowAfter.updated_at, pestFollowBefore.updated_at);
    sameTime(pestFollowAfter.sent_at, pestFollowBefore.sent_at);
    const cleanFollowAfter = await proposalState(cleanFollow);
    assert.ok(cleanFollowAfter.followup1_sent_at);

    await pool.query(`UPDATE proposals SET status = 'discarded' WHERE id = $1`, [pestDraft]);
    const discardedBefore = await proposalState(pestDraft);
    const restoreRes = await fetch(`${apiBase}/api/proposals/${pestDraft}/restore`, { method: 'POST' });
    const restoreJson = await restoreRes.json();
    assert.equal(restoreRes.status, 409);
    assert.deepEqual(restoreJson, { error: `${PEST_NAME_REASON}.` });
    const discardedAfter = await proposalState(pestDraft);
    assert.equal(discardedAfter.status, 'discarded');
    sameTime(discardedAfter.updated_at, discardedBefore.updated_at);
    const pestLeadFinal = await prospectState(heating.id);
    assert.equal(pestLeadFinal.fit_score, pestLeadBefore.fit_score);
    assert.equal(pestLeadFinal.fit_tier, pestLeadBefore.fit_tier);
    assert.equal(pestLeadFinal.reasons, pestLeadBefore.reasons);

    const cleanRestore = await fetch(`${apiBase}/api/proposals/${cleanDiscarded}/restore`, { method: 'POST' });
    const cleanJson = await cleanRestore.json();
    assert.equal(cleanRestore.status, 200, JSON.stringify(cleanJson));
    assert.equal(cleanJson.status, 'draft');
  });

  it('count script prints only the number of legacy rows', async () => {
    await resetDb();
    const rows = [
      ['Wasatch Pest Control', 'HVAC', true],
      ['ACME Exterminators', 'Plumbing', true],
      ['Valley Termite', 'Electrical', true],
      ['Pestana Plumbing', 'Plumbing', false],
      ['Compest', 'HVAC', false],
      ['Best Heating', 'HVAC', false],
      ['Existing Pest Co', 'Pest Control', false],
      ['Termite Control Co', 'Termite Control', false],
      ['Wasatch Heating', 'HVAC', false],
    ];
    for (let i = 0; i < rows.length; i++) {
      const [company, industry] = rows[i];
      await insertProspect({
        google_place_id: `test-place-count-${i}`,
        company,
        industry,
        website: null,
        email: `test+count${i}@example.com`,
      });
    }

    const query = legacyPestNameCountQuery();
    assert.match(query.text, /SELECT COUNT\(\*\)::int AS n/);
    assert.equal(query.values.includes(PEST_TEXT_PATTERN), true);
    const counted = await pool.query(query.text, query.values);
    assert.equal(counted.rows[0].n, 3);
    assert.equal(Object.keys(counted.rows[0]).join(','), 'n');

    const script = fs.readFileSync(path.join(__dirname, '../scripts/count-legacy-pest-names.js'), 'utf8');
    assert.match(script, /stdout\.write\(String\(n\)/);
    assert.match(script, /BEGIN READ ONLY/);
    assert.doesNotMatch(script, /console\.log/);

    const result = spawnSync(process.execPath, [path.join(__dirname, '../scripts/count-legacy-pest-names.js')], {
      encoding: 'utf8',
      env: process.env,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, '');
    assert.match(result.stdout, /^\d+\n$/);
    assert.equal(result.stdout, '3\n');
    for (const [company] of rows) {
      assert.equal(result.stdout.includes(company), false, company);
    }
  });
});
