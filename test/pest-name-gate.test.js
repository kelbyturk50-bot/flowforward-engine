require('./preload');

// F-005 steps 1 and 2. Cache-only company-name gate. Disposable Postgres.
// No Places, Anthropic, Gmail, or live site.

process.env.EXCLUDED_INDUSTRIES = 'Pest Control';
process.env.CRM_API_KEY = 'test-pest-name-gate-key-32chars-ok!';
const realFetch = global.fetch;
global.fetch = (input, init) => {
  const url = typeof input === 'string' ? input : (input && input.url) || '';
  if (!url.includes('/api/')) return realFetch(input, init);
  const headers = new Headers((init && init.headers) || undefined);
  if (!headers.has('x-api-key')) headers.set('x-api-key', process.env.CRM_API_KEY);
  return realFetch(input, { ...init, headers });
};
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
const { Client } = require('pg');
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const catalog = require('../src/bot/industries');
const { INDUSTRIES } = require('../src/bot/discover');
const { computeFit, rescore } = require('../src/scoring/fit');
const { isFranchise } = require('../src/scoring/prototypes');
const {
  PEST_NAME_REASON,
  PEST_TEXT_PATTERN,
  PEST_COMPANY_PATTERN,
  STREET_BRAND_PATTERN,
  COMPANY_SPACE_PATTERN,
  COMPANY_NAME_LIMIT,
  isPestCompanyName,
  isPestText,
  isPestDiscoveryPlace,
  normalizeIndustry,
  legacyPestNameCountQuery,
  appendCompanyPestExclusion,
  appendDraftExclusion,
  appendATierPestHide,
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

// Names the company gate refuses. computeFit still uses the franchise rules.
const BRANDS = [
  'Terminix',
  'Orkin',
  'Rentokil',
  'Truly Nolen',
  'TrulyNolen',
  'Rollins Inc',
  'Rollins, Inc.',
  'Ecolab Pest',
  'Arrow Exterminators',
  'Western Exterminator',
  'Massey Services',
  'Moxie Pest',
  'Bulwark Exterminating',
];

// Already capped at 77/B by the word-boundary franchise list. TrulyNolen has
// no space, so that list does not cap it.
const FRANCHISE_BRANDS = new Set(['Terminix', 'Orkin', 'Rentokil', 'Truly Nolen', 'Rollins Inc', 'Rollins, Inc.']);

// Surname-style tokens stay in scope unless the name also has pest context.
// A franchise cap, when one already applies, is unchanged.
const ALLOWED_NAMES = [
  ['Rollins Heating', true],
  ['Rollins Plumbing', true],
  ['Rollins HVAC', true],
  ['Aptive Electric', true],
  ['Hawx Heating', false],
  ['Massey Plumbing', false],
  ['Western Heating', false],
  ['Orkin Street Landscaping', true],
];

const BRAND_HITS = [
  ...BRANDS,
  'Terminix of Provo',
  '  TERMINIX  ',
  "Orkin's",
  'Orkin LLC',
  'Orkin Pest Control',
  'Rentokil Initial',
  'Rentokil-Initial',
  'Aptive Environmental Pest',
  'Truly   Nolen',
  'Truly-Nolen',
  'Truly - Nolen',
  'TRULYNOLEN',
  'Ecolab-Pest',
  'Arrow  Exterminators',
  'Western-Exterminator',
  'Massey - Services',
  'Hawx Pest Control',
  'Hawx Mosquito',
  'Hawx Mosquitoes',
  'Rollins Bug Control',
  'Aptive Rodent',
  'Mosquito Hawx',
  'Moxie  Pest',
  'Bulwark-Exterminating',
  'Orkin Street Pest Control',
  'Truly\u00A0Nolen',
  'Rollins\u00A0Inc',
  'Massey\u00A0Services',
  'Truly\u2007Nolen',
  'Rollins\u202FInc',
  'Massey\u3000Services',
  'Truly\u200BNolen',
  'Orkin\u00A0Street Pest Control',
];

const BRAND_MISSES = [
  ...ALLOWED_NAMES.map(([company]) => company),
  'Aptive',
  'Aptive Environmental',
  'Hawx',
  'Rollins',
  'Massey',
  'Massey Heating',
  'Massey Service',
  'MasseyServices',
  'Arrow',
  'Arrow Plumbing',
  'Western',
  'Ecolab',
  'Ecolab Cleaning',
  'Ecolaboratory',
  'Bulwark',
  'Bulwark Heating',
  'Moxie',
  'Moxie HVAC',
  'Nolen Roofing',
  'Truly Clean',
  'Truly Heating',
  'Nolen Plumbing',
  'Truly Nolan',
  'TrulyNolan',
  'Morkin HVAC',
  'Terminix Drive',
  'Terminix Dr',
  'Terminix Street Heating',
  'Terminix Ave',
  'Terminix Avenue Shop',
  'Orkin St Plumbing',
  'Orkin\u00A0St',
  'Orkin\u2007St',
  'Orkin\u202FSt',
  'Orkin\u3000St',
  'Orkin\u200BSt',
  'Orkin\u00A0St Plumbing',
  'Orkin Road',
  'Orkin Rd Landscaping',
  'Captive Heating',
  'Adaptive Comfort',
  'Dorkin Plumbing',
  'Orkins',
  'Working Plumbing',
  'Rollinson HVAC',
  'Rollinson Plumbing',
  'Trollins Air',
  'Hawxley Air',
  'Shawx Heating',
  'Thawx Heating',
  'Mosquito Joe',
  'Bug Heating',
  'Rodent Pros',
  'Pestana Plumbing',
  'Compest',
  'Best Heating',
  'Best',
  'Pestana',
  'Pesticide Solutions',
  'Tempest Heating',
  'Preterminix',
  'Terminixing',
  'Terminixx',
  'Untruly Nolen',
  'Services Inc',
  'Wasatch Heating',
  "'; DROP TABLE prospects; --",
];

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
    assert.equal(aOnly.params.includes(PEST_COMPANY_PATTERN), true);
    assert.equal(aOnly.params.includes(COMPANY_SPACE_PATTERN), true);
    assert.equal(aOnly.params.includes(STREET_BRAND_PATTERN), true);
    assert.equal(aOnly.params.includes(PEST_TEXT_PATTERN), false);
    assert.match(aOnly.listSql, /char_length\(btrim\(regexp_replace\(translate\(COALESCE\(company, ''\)/);
    assert.equal(aOnly.listSql.includes('lower('), false);
    const anyTier = buildProspectListQuery({});
    const bOnly = buildProspectListQuery({ tier: 'B' });
    assert.equal(anyTier.params.includes(PEST_TEXT_PATTERN), false);
    assert.equal(bOnly.params.includes(PEST_TEXT_PATTERN), false);
    assert.equal(anyTier.params.includes(PEST_COMPANY_PATTERN), false);
    assert.equal(bOnly.params.includes(PEST_COMPANY_PATTERN), false);

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
    // The due query excludes the pest name, so this row is not selected and the
    // JS skip does not run. Nothing about the lead is logged.
    const logged = logs.join('\n');
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

  it('sends normal follow-ups when 30 due pest sequences are older', async () => {
    await resetDb();
    const sentMail = [];
    _setTransport({
      async sendMail(mail) {
        sentMail.push(mail);
        return { messageId: '<batch@localhost>', threadId: 'thr-batch' };
      },
    });

    const due = new Date(Date.now() - 30 * 60 * 1000);
    // Yesterday, so these first sends do not fill today's daily cap. They are
    // still older than the normal rows, which is what used to fill LIMIT 25.
    const pestSentAt = new Date(Date.now() - 26 * 60 * 60 * 1000);
    const pestProposalIds = [];
    const pestLeadIds = [];
    for (let i = 0; i < 30; i++) {
      const lead = await insertProspect({
        google_place_id: `test-place-batch-pest-${i}`,
        company: `Shop ${i} Pest Control`,
        industry: 'HVAC',
        website: null,
        email: `test+batchpest${i}@example.com`,
      });
      pestLeadIds.push(lead.id);
      const { rows } = await pool.query(
        `INSERT INTO proposals (
           prospect_id, version, status, slug, to_email, to_name, subject, body, followup1, followup2,
           sent_at, followup1_due_at, message_id
         ) VALUES (
           $1, 1, 'sent', $2, $3, 'Dana', 'A note', 'Hello from the draft.', 'Checking back.', 'Last note.',
           $4, $5, $6
         ) RETURNING id`,
        [lead.id, `batch-pest-${i}`, `test+batchpest${i}@example.com`, pestSentAt, due, `<pest-${i}@localhost>`]
      );
      pestProposalIds.push(rows[0].id);
    }

    const normals = [
      ['Provo Heating', 'HVAC', 'test+batch-provo@example.com', 'batch-provo'],
      ['Pestana Plumbing', 'Plumbing', 'test+batch-pestana@example.com', 'batch-pestana'],
      ['Tempest Heating', 'HVAC', 'test+batch-tempest@example.com', 'batch-tempest'],
    ];
    const normalSentAt = new Date(Date.now() - 25 * 60 * 60 * 1000);
    const normalIds = [];
    for (let i = 0; i < normals.length; i++) {
      const [company, industry, email, slug] = normals[i];
      const lead = await insertProspect({
        google_place_id: `test-place-batch-ok-${i}`,
        company,
        industry,
        website: null,
        email,
      });
      const { rows } = await pool.query(
        `INSERT INTO proposals (
           prospect_id, version, status, slug, to_email, to_name, subject, body, followup1, followup2,
           sent_at, followup1_due_at, message_id
         ) VALUES (
           $1, 1, 'sent', $2, $3, 'Dana', 'A note', 'Hello from the draft.', 'Checking back.', 'Last note.',
           $4, $5, $6
         ) RETURNING id`,
        [lead.id, slug, email, normalSentAt, due, `<ok-${i}@localhost>`]
      );
      normalIds.push(rows[0].id);
    }

    const proposalsBefore = await pool.query(
      `SELECT id, status, followup1_sent_at, followup2_sent_at, error, stop_reason, updated_at
         FROM proposals WHERE id = ANY($1::int[]) ORDER BY id`,
      [pestProposalIds]
    );
    const leadsBefore = await pool.query(
      `SELECT id, fit_score, fit_tier, fit_reasons::text AS reasons, stage, last_contacted_at, updated_at
         FROM prospects WHERE id = ANY($1::int[]) ORDER BY id`,
      [pestLeadIds]
    );

    const result = await sendDueFollowups();
    assert.equal(result.sent, normals.length);
    assert.equal(sentMail.length, normals.length);
    const sentTo = sentMail.map(mail => mail.to.address).sort();
    assert.deepEqual(sentTo, normals.map(([, , email]) => email).sort());

    const proposalsAfter = await pool.query(
      `SELECT id, status, followup1_sent_at, followup2_sent_at, error, stop_reason, updated_at
         FROM proposals WHERE id = ANY($1::int[]) ORDER BY id`,
      [pestProposalIds]
    );
    assert.equal(proposalsAfter.rows.length, 30);
    for (let i = 0; i < proposalsBefore.rows.length; i++) {
      const before = proposalsBefore.rows[i];
      const after = proposalsAfter.rows[i];
      assert.equal(after.status, 'sent');
      assert.equal(after.followup1_sent_at, null);
      assert.equal(after.followup2_sent_at, null);
      assert.equal(after.error, before.error);
      assert.equal(after.stop_reason, before.stop_reason);
      assert.equal(new Date(after.updated_at).toISOString(), new Date(before.updated_at).toISOString());
    }
    const leadsAfter = await pool.query(
      `SELECT id, fit_score, fit_tier, fit_reasons::text AS reasons, stage, last_contacted_at, updated_at
         FROM prospects WHERE id = ANY($1::int[]) ORDER BY id`,
      [pestLeadIds]
    );
    for (let i = 0; i < leadsBefore.rows.length; i++) {
      const before = leadsBefore.rows[i];
      const after = leadsAfter.rows[i];
      assert.equal(after.fit_score, before.fit_score);
      assert.equal(after.fit_tier, before.fit_tier);
      assert.equal(after.reasons, before.reasons);
      assert.equal(after.stage, before.stage);
      assert.equal(after.last_contacted_at, before.last_contacted_at);
      assert.equal(new Date(after.updated_at).toISOString(), new Date(before.updated_at).toISOString());
    }

    const normalAfter = await pool.query(
      'SELECT followup1_sent_at FROM proposals WHERE id = ANY($1::int[])',
      [normalIds]
    );
    assert.equal(normalAfter.rows.length, normals.length);
    assert.ok(normalAfter.rows.every(row => row.followup1_sent_at));

    const sendSrc = fs.readFileSync(path.join(__dirname, '../src/proposals/send.js'), 'utf8');
    assert.match(sendSrc, /appendCompanyPestExclusion\(params\)/);
    assert.match(sendSrc, /isPestCompanyName\(p\.company\)/);
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

  it('matches national brands in JS and SQL and leaves computeFit on the old snapshot', async () => {
    const guard = armNoFetch();
    try {
      const twin = computeFit(sweet);
      assert.equal(twin.fit_score, 100);
      assert.equal(twin.fit_tier, 'A');
      for (const company of BRANDS) {
        assert.equal(isPestCompanyName(company), true, company);
        const fit = computeFit({ ...sweet, company, industry: 'HVAC' });
        assert.equal(fit.fit_reasons.some(r => r.detail === PEST_NAME_REASON), false, company);
        assert.equal(fit.fit_reasons.some(r => /out of scope/.test(r.detail)), false, company);
        if (FRANCHISE_BRANDS.has(company)) {
          assert.equal(isFranchise(company, FRANCHISE_PATTERNS), true, company);
          assert.equal(fit.fit_score, 77, company);
          assert.equal(fit.fit_tier, 'B', company);
          assert.equal(fit.fit_reasons.find(r => r.label === 'Franchise').points, -20, company);
        } else {
          assert.equal(fit.fit_score, twin.fit_score, company);
          assert.equal(fit.fit_tier, twin.fit_tier, company);
          assert.equal(JSON.stringify(fit.fit_reasons), JSON.stringify(twin.fit_reasons), company);
        }
      }
      // Brands are not industry synonyms. Discovery and scoring stay on the
      // pest, exterminator, and termite words.
      for (const [company, franchise] of ALLOWED_NAMES) {
        assert.equal(isPestCompanyName(company), false, company);
        const fit = computeFit({ ...sweet, company, industry: 'HVAC' });
        assert.equal(fit.fit_reasons.some(r => r.detail === PEST_NAME_REASON), false, company);
        assert.equal(fit.fit_reasons.some(r => /out of scope/.test(r.detail)), false, company);
        if (franchise) {
          assert.equal(isFranchise(company, FRANCHISE_PATTERNS), true, company);
          assert.equal(fit.fit_score, 77, company);
          assert.equal(fit.fit_tier, 'B', company);
        } else {
          assert.equal(fit.fit_score, twin.fit_score, company);
          assert.equal(fit.fit_tier, twin.fit_tier, company);
          assert.equal(JSON.stringify(fit.fit_reasons), JSON.stringify(twin.fit_reasons), company);
        }
      }
      for (const company of ['Terminix', 'Orkin', 'Rentokil', 'Aptive', 'Truly Nolen', 'TrulyNolen', 'Rollins', 'Massey Services', 'Hawx']) {
        assert.equal(isPestText(company), false, company);
        assert.equal(normalizeIndustry(company), company, company);
        assert.equal(isPestDiscoveryPlace({ displayName: { text: company } }), false, company);
      }
      const asIndustry = computeFit({ ...sweet, company: 'Wasatch Heating', industry: 'Terminix' });
      assert.equal(asIndustry.fit_reasons.some(r => /out of scope/.test(r.detail)), false);
      assert.notEqual(asIndustry.fit_score, 0);

      for (const company of BRAND_HITS) assert.equal(isPestCompanyName(company), true, company);
      for (const company of BRAND_MISSES) {
        assert.equal(isPestCompanyName(company), false, company);
        assert.equal(isPestText(company), false, company);
      }
      for (const [name, row, score, tier] of SNAPSHOT) {
        const fit = computeFit(row);
        assert.equal(fit.fit_score, score, name);
        assert.equal(fit.fit_tier, tier, name);
      }
    } finally {
      guard.restore();
    }
    assert.deepEqual(guard.hits, []);

    const bound = [];
    const fragment = appendCompanyPestExclusion(bound);
    assert.deepEqual(bound, [COMPANY_SPACE_PATTERN, STREET_BRAND_PATTERN, PEST_COMPANY_PATTERN]);
    assert.equal(fragment.includes(PEST_COMPANY_PATTERN), false);
    assert.equal(fragment.includes(STREET_BRAND_PATTERN), false);
    assert.equal(fragment.includes(COMPANY_SPACE_PATTERN), false);
    assert.equal(COMPANY_SPACE_PATTERN.includes('\\s'), false);
    assert.equal(COMPANY_SPACE_PATTERN.includes('\\u'), false);
    assert.equal(COMPANY_NAME_LIMIT, 200);
    assert.match(fragment, /left\(btrim\(regexp_replace\(translate\(COALESCE\(p\.company, ''\), 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'\), \$1, ' ', 'g'\)\), 200\)/);
    assert.match(fragment, /char_length\(btrim\(regexp_replace\(translate\(COALESCE\(p\.company, ''\), 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'\), \$1, ' ', 'g'\)\)\) <= 200 AND /);
    assert.equal(fragment.includes('lower('), false);
    assert.equal(fragment.includes('~*'), false);
    assert.match(fragment, /!~ \$3/);
    const aliased = [];
    const aliasedHide = appendATierPestHide(aliased, 'p');
    assert.equal(aliasedHide, `NOT (p.fit_tier = 'A' AND NOT (${fragment}))`);
    assert.deepEqual(aliased, bound);
    assert.notEqual(PEST_COMPANY_PATTERN, PEST_TEXT_PATTERN);

    async function keptBy(build, company) {
      const params = [];
      const sql = build(params);
      const companyIndex = params.push(company);
      const industryIndex = params.push('HVAC');
      const { rows } = await pool.query(
        `SELECT (${sql}) AS kept
           FROM (SELECT $${industryIndex}::text AS industry, $${companyIndex}::text AS company) p`,
        params
      );
      return rows[0].kept;
    }

    for (const company of BRAND_HITS) {
      assert.equal(await keptBy(appendCompanyPestExclusion, company), false, company);
      assert.equal(await keptBy(appendDraftExclusion, company), false, company);
      assert.equal(await keptBy(appendCompanyPestExclusion, company), !isPestCompanyName(company), company);
    }
    for (const company of BRAND_MISSES) {
      assert.equal(await keptBy(appendCompanyPestExclusion, company), true, company);
      assert.equal(await keptBy(appendDraftExclusion, company), true, company);
    }
    assert.equal(await keptBy(appendCompanyPestExclusion, null), true);
    assert.equal(isPestCompanyName(null), false);
    const stillThere = await pool.query('SELECT COUNT(*)::int AS n FROM prospects');
    assert.equal(typeof stillThere.rows[0].n, 'number');
  });

  it('folds the same whitespace in JS and SQL and caps a long name before the match', async () => {
    for (let cp = 0; cp <= 0xffff; cp++) {
      const ch = String.fromCharCode(cp);
      if (/\s/.test(ch) || cp === 0x200b) {
        assert.equal(COMPANY_SPACE_PATTERN.includes(ch), true, cp.toString(16));
      }
    }

    async function kept(company) {
      const params = [];
      const sql = appendCompanyPestExclusion(params);
      const companyIndex = params.push(company);
      const { rows } = await pool.query(
        `SELECT (${sql}) AS kept FROM (SELECT $${companyIndex}::text AS company) p`,
        params
      );
      return rows[0].kept;
    }

    const blocked = ['Truly\u00A0Nolen', 'Rollins\u00A0Inc', 'Massey\u00A0Services'];
    const allowed = ['Orkin\u00A0St'];
    for (const company of blocked) {
      assert.equal(isPestCompanyName(company), true, JSON.stringify(company));
      assert.equal(await kept(company), false, JSON.stringify(company));
    }
    for (const company of allowed) {
      assert.equal(isPestCompanyName(company), false, JSON.stringify(company));
      assert.equal(await kept(company), true, JSON.stringify(company));
    }
    for (const company of [...BRAND_HITS, ...BRAND_MISSES, ...blocked, ...allowed]) {
      assert.equal(await kept(company), !isPestCompanyName(company), JSON.stringify(company));
    }

    const longName = 'rollins '.repeat(10000);
    assert.equal(longName.length, 80000);
    const started = process.hrtime.bigint();
    const matched = isPestCompanyName(longName);
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
    assert.equal(matched, true);
    assert.ok(elapsedMs < 50, `js ${elapsedMs}ms`);

    const sqlStarted = process.hrtime.bigint();
    assert.equal(await kept(longName), false);
    const sqlMs = Number(process.hrtime.bigint() - sqlStarted) / 1e6;
    assert.ok(sqlMs < 50, `sql ${sqlMs}ms`);

    const past = `${'x'.repeat(COMPANY_NAME_LIMIT)}Terminix`;
    assert.equal(isPestCompanyName(past), true);
    assert.equal(await kept(past), false);

    const inside = `Terminix ${'x'.repeat(80000)}`;
    const insideStarted = process.hrtime.bigint();
    assert.equal(isPestCompanyName(inside), true);
    const insideMs = Number(process.hrtime.bigint() - insideStarted) / 1e6;
    assert.ok(insideMs < 50, `js prefix ${insideMs}ms`);
    assert.equal(await kept(inside), false);
  });

  it('treats a folded name longer than 200 code points as pest in JS and SQL', async () => {
    async function kept(company) {
      const params = [];
      const sql = appendCompanyPestExclusion(params);
      const companyIndex = params.push(company);
      const { rows } = await pool.query(
        `SELECT (${sql}) AS kept FROM (SELECT $${companyIndex}::text AS company) p`,
        params
      );
      return rows[0].kept;
    }

    const blocked = [
      `TEST: ${'x'.repeat(300)} Pest Control`,
      `TEST: ${'x'.repeat(300)} Terminix`,
      `Rollins ${'x'.repeat(250)} Pest`,
      `${'x'.repeat(194)} Pest`,
    ];
    const benign200 = 'x'.repeat(200);
    const benign201 = 'x'.repeat(201);
    const codePoints200 = `${'x'.repeat(199)}\u{1F600}`;
    const codePoints201 = `${'x'.repeat(200)}\u{1F600}`;
    assert.equal([...benign200].length, 200);
    assert.equal([...benign201].length, 201);
    assert.equal([...codePoints200].length, 200);
    assert.equal(codePoints200.length, 201);
    assert.equal([...codePoints201].length, 201);

    for (const company of blocked) {
      assert.equal(isPestCompanyName(company), true, company.slice(0, 24));
      assert.equal(await kept(company), false, company.slice(0, 24));
    }
    assert.equal(isPestCompanyName(benign200), false);
    assert.equal(await kept(benign200), true);
    assert.equal(isPestCompanyName(benign201), true);
    assert.equal(await kept(benign201), false);
    assert.equal(isPestCompanyName(codePoints200), false);
    assert.equal(await kept(codePoints200), true);
    assert.equal(isPestCompanyName(codePoints201), true);
    assert.equal(await kept(codePoints201), false);
  });

  it('hides brand names that still score A from the tier A list and Today', async () => {
    await resetDb();
    const names = ['TrulyNolen', 'Massey Services', 'Hawx Mosquito'];
    const hidden = [];
    for (let i = 0; i < names.length; i++) {
      const company = names[i];
      const fit = computeFit({ ...sweet, company });
      assert.equal(fit.fit_score, 100, company);
      assert.equal(fit.fit_tier, 'A', company);
      assert.equal(isPestCompanyName(company), true, company);
      const lead = await insertProspect({
        google_place_id: `test-place-a-hide-${i}`,
        company,
        industry: 'HVAC',
        email: `test+ahide${i}@example.com`,
      });
      hidden.push(lead);
    }
    const benignFit = computeFit(sweet);
    assert.equal(benignFit.fit_score, 100);
    assert.equal(benignFit.fit_tier, 'A');
    assert.equal(isPestCompanyName(sweet.company), false);
    const benign = await insertProspect({
      google_place_id: 'test-place-a-hide-benign',
      company: 'Wasatch Heating',
      industry: 'HVAC',
      email: 'test+ahide-benign@example.com',
    });
    const ids = hidden.map(row => row.id).concat(benign.id);
    const before = await pool.query(
      `SELECT id, fit_score, fit_tier, fit_reasons::text AS reasons, stage, updated_at
         FROM prospects WHERE id = ANY($1::int[])`,
      [ids]
    );
    await pool.query(
      `UPDATE prospects SET fit_tier = 'A', fit_score = 100, stage = 'found' WHERE id = ANY($1::int[])`,
      [ids]
    );
    const stamp = await pool.query(
      `SELECT id, fit_score, fit_tier, fit_reasons::text AS reasons, stage, updated_at
         FROM prospects WHERE id = ANY($1::int[]) ORDER BY id`,
      [ids]
    );

    async function get(path) {
      const res = await fetch(apiBase + path);
      const json = await res.json();
      assert.equal(res.status, 200, `${path} ${JSON.stringify(json)}`);
      return json;
    }
    const tierA = await get('/api/prospects?tier=A');
    const focus = await get('/api/focus');
    const listed = new Set((tierA.prospects || []).map(row => row.id));
    for (const lead of hidden) {
      assert.equal(listed.has(lead.id), false, lead.company);
      assert.equal(focus.top_new_leads.some(row => row.id === lead.id), false, lead.company);
    }
    assert.equal(listed.has(benign.id), true);
    assert.equal(focus.top_new_leads.some(row => row.id === benign.id), true);
    assert.equal(tierA.total, 1);
    assert.equal(focus.counts.a_tier_open, 1);

    const after = await pool.query(
      `SELECT id, fit_score, fit_tier, fit_reasons::text AS reasons, stage, updated_at
         FROM prospects WHERE id = ANY($1::int[]) ORDER BY id`,
      [ids]
    );
    assert.equal(after.rows.length, stamp.rows.length);
    for (let i = 0; i < stamp.rows.length; i++) {
      assert.equal(after.rows[i].fit_score, stamp.rows[i].fit_score);
      assert.equal(after.rows[i].fit_tier, 'A');
      assert.equal(after.rows[i].reasons, stamp.rows[i].reasons);
      assert.equal(after.rows[i].stage, stamp.rows[i].stage);
      assert.equal(new Date(after.rows[i].updated_at).toISOString(), new Date(stamp.rows[i].updated_at).toISOString());
    }
    assert.equal(before.rows.length, ids.length);
  });

  it('folds only ASCII A-Z and agrees on C and en_US.utf8', async () => {
    const src = fs.readFileSync(path.join(__dirname, '../src/scoring/industry.js'), 'utf8');
    const keyFn = src.slice(src.indexOf('function companyNameKey'), src.indexOf('function industryKey'));
    assert.match(keyFn, /replace\(\/\[A-Z\]\/g, c => String\.fromCharCode\(c\.charCodeAt\(0\) \+ 32\)\)/);
    assert.equal(keyFn.includes('toLowerCase'), false);
    const sqlFn = src.slice(src.indexOf('function companyNameKeptSql'), src.indexOf('function appendDraftExclusion'));
    assert.match(sqlFn, /translate\(COALESCE\(\$\{companyExpr\}, ''\), 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'\)/);
    assert.match(sqlFn, /'p\.company'/);
    assert.equal(sqlFn.includes('lower('), false);
    assert.equal(sqlFn.includes('~*'), false);
    assert.match(sqlFn, /char_length\(\$\{normalized\}\) <= \$\{COMPANY_NAME_LIMIT\}/);
    assert.match(sqlFn, /left\(\$\{normalized\}, \$\{COMPANY_NAME_LIMIT\}\)/);
    const hideFn = src.slice(src.indexOf('function appendATierPestHide'), src.indexOf('function legacyPestNameCountQuery'));
    assert.match(hideFn, /companyNameKeptSql\(params, `\$\{prefix\}company`, excluded\)/);
    assert.equal(hideFn.includes('PEST_TEXT_PATTERN'), false);
    assert.equal(hideFn.includes('lower('), false);

    const kelvin = 'OR\u212AIN';
    const dotted = `${'İ'.repeat(195)} pest`;
    const sharp = `${'ß'.repeat(195)} pest`;
    assert.equal([...dotted].length, 200);
    assert.equal([...sharp].length, 200);
    assert.equal(isPestCompanyName(kelvin), false, JSON.stringify(kelvin));
    assert.equal(isPestCompanyName(dotted), true, JSON.stringify(dotted));
    assert.equal(isPestCompanyName(sharp), true, JSON.stringify(sharp));

    function databaseUrl(name) {
      const url = new URL(process.env.DATABASE_URL);
      url.pathname = `/${name}`;
      return url.toString();
    }

    async function keptOn(client, company) {
      const params = [];
      const sql = appendCompanyPestExclusion(params);
      const companyIndex = params.push(company);
      const { rows } = await client.query(
        `SELECT (${sql}) AS kept FROM (SELECT $${companyIndex}::text AS company) p`,
        params
      );
      return rows[0].kept;
    }

    const names = [kelvin, dotted, sharp, ...BRAND_HITS, ...BRAND_MISSES];
    const locales = [
      ['ff_gate_c', 'C'],
      ['ff_gate_en', 'en_US.utf8'],
    ];
    const created = [];
    const clients = [];
    try {
      for (const [name, locale] of locales) {
        await pool.query(`DROP DATABASE IF EXISTS ${name}`);
        await pool.query(
          `CREATE DATABASE ${name} WITH TEMPLATE template0 ENCODING 'UTF8' LC_COLLATE '${locale}' LC_CTYPE '${locale}'`
        );
        created.push(name);
        const client = new Client({ connectionString: databaseUrl(name) });
        clients.push(client);
        await client.connect();
        const meta = await client.query(
          `SELECT datcollate AS collate, datctype AS ctype FROM pg_database WHERE datname = current_database()`
        );
        assert.equal(meta.rows[0].collate, locale, name);
        assert.equal(meta.rows[0].ctype, locale, name);
        for (const company of names) {
          assert.equal(await keptOn(client, company), !isPestCompanyName(company), `${locale} ${JSON.stringify(company)}`);
        }
      }
    } finally {
      for (const client of clients) await client.end().catch(() => {});
      for (const name of created) await pool.query(`DROP DATABASE IF EXISTS ${name}`);
    }
  });

  it('refuses mark-sent, draft, send, and restore for each brand and writes nothing', async () => {
    await resetDb();
    const sentMail = [];
    _setTransport({
      async sendMail(mail) {
        sentMail.push(mail);
        return { messageId: '<brand-gate@localhost>', threadId: 'thr-brand-gate' };
      },
    });

    const brands = [];
    for (let i = 0; i < BRANDS.length; i++) {
      const company = BRANDS[i];
      const lead = await insertProspect({
        google_place_id: `test-place-brand-${i}`,
        company,
        industry: 'HVAC',
        website: 'https://brand.example',
        email: `test+brand${i}@example.com`,
      });
      brands.push({ company, lead });
    }
    const lookalike = await insertProspect({
      google_place_id: 'test-place-brand-pestana',
      company: 'Pestana Plumbing',
      industry: 'Plumbing',
      website: null,
      email: 'test+brand-pestana@example.com',
    });
    const captive = await insertProspect({
      google_place_id: 'test-place-brand-captive',
      company: 'Captive Heating',
      industry: 'HVAC',
      website: null,
      email: 'test+brand-captive@example.com',
    });
    const allowed = [];
    for (let i = 0; i < ALLOWED_NAMES.length; i++) {
      const [company] = ALLOWED_NAMES[i];
      const lead = await insertProspect({
        google_place_id: `test-place-allowed-${i}`,
        company,
        industry: 'HVAC',
        website: null,
        email: `test+allowed${i}@example.com`,
      });
      allowed.push({ company, lead });
    }
    const ids = brands.map(row => row.lead.id).concat(lookalike.id, captive.id, allowed.map(row => row.lead.id));
    await pool.query(
      `UPDATE prospects SET fit_tier = 'A', fit_score = 100, stage = 'found' WHERE id = ANY($1::int[])`,
      [ids]
    );

    const picked = new Set((await pickLeads(50)).map(row => row.id));
    for (const row of brands) assert.equal(picked.has(row.lead.id), false, row.company);
    assert.equal(picked.has(lookalike.id), true);
    assert.equal(picked.has(captive.id), true);
    for (const row of allowed) assert.equal(picked.has(row.lead.id), true, row.company);
    const summaryRes = await fetch(apiBase + '/api/proposals/summary');
    const summary = await summaryRes.json();
    assert.equal(summaryRes.status, 200);
    assert.equal(summary.eligible_leads, picked.size);

    async function prospectStamp(id) {
      const { rows } = await pool.query(
        `SELECT stage, last_contacted_at, fit_score, fit_tier, fit_reasons::text AS reasons, updated_at
           FROM prospects WHERE id = $1`,
        [id]
      );
      return rows[0];
    }
    function sameTime(a, b, label) {
      if (a == null && b == null) return;
      assert.equal(new Date(a).toISOString(), new Date(b).toISOString(), label);
    }
    function assertProspectUntouched(before, after, label) {
      assert.equal(after.stage, before.stage, label);
      assert.equal(after.last_contacted_at, before.last_contacted_at, label);
      assert.equal(after.fit_score, before.fit_score, label);
      assert.equal(after.fit_tier, before.fit_tier, label);
      assert.equal(after.reasons, before.reasons, label);
      sameTime(after.updated_at, before.updated_at, label);
    }

    const stamps = new Map();
    for (const row of brands) stamps.set(row.lead.id, await prospectStamp(row.lead.id));
    const callsBefore = claudeCalls;
    const guard = armNoFetch();
    try {
      for (const row of brands) {
        await assert.rejects(
          () => draftProposal(row.lead.id),
          (err) => {
            assert.equal(err.status, 409, row.company);
            assert.equal(err.message, `${PEST_NAME_REASON}.`, row.company);
            assert.equal(err.message.includes(row.company), false, row.company);
            return true;
          }
        );
      }
    } finally {
      guard.restore();
    }
    assert.deepEqual(guard.hits, []);
    for (const row of brands) {
      const res = await fetch(apiBase + '/api/proposals', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ prospect_id: row.lead.id, force: true, industry: 'Plumbing' }),
      });
      const json = await res.json();
      assert.equal(res.status, 409, row.company);
      assert.deepEqual(json, { error: `${PEST_NAME_REASON}.` });
    }
    assert.equal(claudeCalls, callsBefore);
    const proposals = await pool.query('SELECT id FROM proposals WHERE prospect_id = ANY($1::int[])', [brands.map(row => row.lead.id)]);
    assert.equal(proposals.rows.length, 0);
    const jobs = await pool.query('SELECT id FROM proposal_jobs WHERE prospect_id = ANY($1::int[])', [brands.map(row => row.lead.id)]);
    assert.equal(jobs.rows.length, 0);
    for (const row of brands) {
      assertProspectUntouched(stamps.get(row.lead.id), await prospectStamp(row.lead.id), row.company);
    }

    async function insertDraft(prospectId, slug, email) {
      const { rows } = await pool.query(
        `INSERT INTO proposals (
           prospect_id, version, status, slug, to_email, to_name, subject, body, followup1, followup2
         ) VALUES (
           $1, 1, 'draft', $2, $3, 'Dana', 'A note', 'Hello from the draft.', 'Checking back.', 'Last note.'
         ) RETURNING id`,
        [prospectId, slug, email]
      );
      return rows[0].id;
    }
    async function proposalStamp(id) {
      const { rows } = await pool.query(
        `SELECT status, approved_at, sent_at, followup1_due_at, followup1_sent_at,
                followup2_due_at, followup2_sent_at, error, stop_reason, updated_at
           FROM proposals WHERE id = $1`,
        [id]
      );
      return rows[0];
    }
    async function activityCount(prospectId) {
      const { rows } = await pool.query(
        'SELECT COUNT(*)::int AS n FROM prospect_activities WHERE prospect_id = $1',
        [prospectId]
      );
      return rows[0].n;
    }
    function assertProposalUntouched(before, after, label) {
      assert.equal(after.status, before.status, label);
      assert.equal(after.approved_at, before.approved_at, label);
      assert.equal(after.sent_at, before.sent_at, label);
      assert.equal(after.followup1_due_at, before.followup1_due_at, label);
      assert.equal(after.followup1_sent_at, before.followup1_sent_at, label);
      assert.equal(after.followup2_due_at, before.followup2_due_at, label);
      assert.equal(after.followup2_sent_at, before.followup2_sent_at, label);
      assert.equal(after.error, before.error, label);
      assert.equal(after.stop_reason, before.stop_reason, label);
      sameTime(after.updated_at, before.updated_at, label);
    }

    const pestWord = await insertProspect({
      google_place_id: 'test-place-brand-pest-word',
      company: 'Wasatch Pest Control',
      industry: 'HVAC',
      website: null,
      email: 'test+brand-pestword@example.com',
    });
    const marked = brands.concat([{ company: pestWord.company, lead: pestWord }]);
    for (let i = 0; i < marked.length; i++) {
      const row = marked[i];
      const proposalId = await insertDraft(row.lead.id, `brand-draft-${i}`, `test+brand-draft${i}@example.com`);
      const activitiesBefore = await activityCount(row.lead.id);
      const proposalBefore = await proposalStamp(proposalId);
      const leadBefore = await prospectStamp(row.lead.id);

      const mark = await fetch(`${apiBase}/api/proposals/${proposalId}/mark-sent`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ note: `called ${row.company}` }),
      });
      const markJson = await mark.json();
      assert.equal(mark.status, 409, row.company);
      assert.deepEqual(markJson, { error: `${PEST_NAME_REASON}.` });
      assert.equal(markJson.error.includes(row.company), false, row.company);
      assertProposalUntouched(proposalBefore, await proposalStamp(proposalId), `mark-sent ${row.company}`);
      assertProspectUntouched(leadBefore, await prospectStamp(row.lead.id), `mark-sent ${row.company}`);
      assert.equal(await activityCount(row.lead.id), activitiesBefore, row.company);
      assert.equal(proposalBefore.followup1_due_at, null, row.company);
      assert.equal(proposalBefore.followup2_due_at, null, row.company);

      const sendRes = await fetch(`${apiBase}/api/proposals/${proposalId}/send`, { method: 'POST' });
      const sendJson = await sendRes.json();
      assert.equal(sendRes.status, 409, row.company);
      assert.deepEqual(sendJson, { error: `${PEST_NAME_REASON}.` });
      assert.equal(sentMail.length, 0, row.company);
      assertProposalUntouched(proposalBefore, await proposalStamp(proposalId), `send ${row.company}`);
      assertProspectUntouched(leadBefore, await prospectStamp(row.lead.id), `send ${row.company}`);

      await pool.query(`UPDATE proposals SET status = 'discarded' WHERE id = $1`, [proposalId]);
      const discardedBefore = await proposalStamp(proposalId);
      const leadDiscarded = await prospectStamp(row.lead.id);
      const restore = await fetch(`${apiBase}/api/proposals/${proposalId}/restore`, { method: 'POST' });
      const restoreJson = await restore.json();
      assert.equal(restore.status, 409, row.company);
      assert.deepEqual(restoreJson, { error: `${PEST_NAME_REASON}.` });
      assertProposalUntouched(discardedBefore, await proposalStamp(proposalId), `restore ${row.company}`);
      assertProspectUntouched(leadDiscarded, await prospectStamp(row.lead.id), `restore ${row.company}`);
      assert.equal(await activityCount(row.lead.id), activitiesBefore, row.company);
    }

    const rollins = allowed.find(row => row.company === 'Rollins Heating');
    const rollinsId = await insertDraft(rollins.lead.id, 'rollins-heating-mark-sent', 'test+rollins-heating@example.com');
    const rollinsRes = await fetch(`${apiBase}/api/proposals/${rollinsId}/mark-sent`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ note: 'left a voicemail' }),
    });
    const rollinsJson = await rollinsRes.json();
    assert.equal(rollinsRes.status, 200, JSON.stringify(rollinsJson));
    assert.equal(rollinsJson.status, 'sent');
    assert.ok(rollinsJson.followup1_due_at);
    const rollinsLead = await prospectStamp(rollins.lead.id);
    assert.equal(rollinsLead.stage, 'contacted');

    const okId = await insertDraft(lookalike.id, 'pestana-mark-sent', 'test+brand-pestana@example.com');
    const ok = await fetch(`${apiBase}/api/proposals/${okId}/mark-sent`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ note: 'left a voicemail' }),
    });
    const okJson = await ok.json();
    assert.equal(ok.status, 200, JSON.stringify(okJson));
    assert.equal(okJson.status, 'sent');
    assert.ok(okJson.sent_at);
    assert.ok(okJson.followup1_due_at);
    assert.ok(okJson.followup2_due_at);
    const okLead = await prospectStamp(lookalike.id);
    assert.equal(okLead.stage, 'contacted');
    assert.ok(okLead.last_contacted_at);
    const notes = await pool.query(
      `SELECT body FROM prospect_activities WHERE prospect_id = $1 AND type = 'note'`,
      [lookalike.id]
    );
    assert.equal(notes.rows.some(row => row.body.includes('left a voicemail')), true);
    assert.equal(sentMail.length, 0);

    const markSrc = fs.readFileSync(path.join(__dirname, '../src/api/proposals.js'), 'utf8');
    const markFn = markSrc.slice(markSrc.indexOf("router.post('/:id/mark-sent'"), markSrc.indexOf("async function revokeDemoOnDiscard"));
    const pestAt = markFn.indexOf('isPestCompanyName(p.company)');
    const updateAt = markFn.indexOf('UPDATE proposals');
    assert.ok(pestAt > 0 && updateAt > pestAt);
  });

  it('excludes every national brand from the follow-up batch and still sends lookalikes', async () => {
    await resetDb();
    const sentMail = [];
    _setTransport({
      async sendMail(mail) {
        sentMail.push(mail);
        return { messageId: '<brand-batch@localhost>', threadId: 'thr-brand-batch' };
      },
    });

    const due = new Date(Date.now() - 30 * 60 * 1000);
    const brandSentAt = new Date(Date.now() - 26 * 60 * 60 * 1000);
    const brandProposalIds = [];
    const brandLeadIds = [];
    const blockedRows = Math.max(28, BRANDS.length * 2);
    for (let i = 0; i < blockedRows; i++) {
      const company = BRANDS[i % BRANDS.length];
      const lead = await insertProspect({
        google_place_id: `test-place-brand-fu-${i}`,
        company,
        industry: 'HVAC',
        website: null,
        email: `test+brandfu${i}@example.com`,
      });
      brandLeadIds.push(lead.id);
      const { rows } = await pool.query(
        `INSERT INTO proposals (
           prospect_id, version, status, slug, to_email, to_name, subject, body, followup1, followup2,
           sent_at, followup1_due_at, message_id
         ) VALUES (
           $1, 1, 'sent', $2, $3, 'Dana', 'A note', 'Hello from the draft.', 'Checking back.', 'Last note.',
           $4, $5, $6
         ) RETURNING id`,
        [lead.id, `brand-fu-${i}`, `test+brandfu${i}@example.com`, brandSentAt, due, `<brand-fu-${i}@localhost>`]
      );
      brandProposalIds.push(rows[0].id);
    }

    const normals = [
      ['Provo Heating', 'HVAC', 'test+brand-provo@example.com', 'brand-provo'],
      ['Pestana Plumbing', 'Plumbing', 'test+brand-pestana-fu@example.com', 'brand-pestana-fu'],
      ['Rollins Heating', 'HVAC', 'test+rollins-heating-fu@example.com', 'rollins-heating-fu'],
      ['Aptive Electric', 'Electrical', 'test+aptive-electric-fu@example.com', 'aptive-electric-fu'],
      ['Hawx Heating', 'HVAC', 'test+hawx-heating-fu@example.com', 'hawx-heating-fu'],
      ['Orkin Street Landscaping', 'Landscaping', 'test+orkin-st-fu@example.com', 'orkin-st-fu'],
    ];
    const normalSentAt = new Date(Date.now() - 25 * 60 * 60 * 1000);
    for (let i = 0; i < normals.length; i++) {
      const [company, industry, email, slug] = normals[i];
      const lead = await insertProspect({
        google_place_id: `test-place-brand-ok-${i}`,
        company,
        industry,
        website: null,
        email,
      });
      await pool.query(
        `INSERT INTO proposals (
           prospect_id, version, status, slug, to_email, to_name, subject, body, followup1, followup2,
           sent_at, followup1_due_at, message_id
         ) VALUES (
           $1, 1, 'sent', $2, $3, 'Dana', 'A note', 'Hello from the draft.', 'Checking back.', 'Last note.',
           $4, $5, $6
         )`,
        [lead.id, slug, email, normalSentAt, due, `<brand-ok-${i}@localhost>`]
      );
    }

    const proposalsBefore = await pool.query(
      `SELECT id, status, followup1_sent_at, followup2_sent_at, error, stop_reason, updated_at
         FROM proposals WHERE id = ANY($1::int[]) ORDER BY id`,
      [brandProposalIds]
    );
    const leadsBefore = await pool.query(
      `SELECT id, fit_score, fit_tier, fit_reasons::text AS reasons, stage, last_contacted_at, updated_at
         FROM prospects WHERE id = ANY($1::int[]) ORDER BY id`,
      [brandLeadIds]
    );

    const result = await sendDueFollowups();
    assert.equal(result.sent, normals.length);
    assert.equal(sentMail.length, normals.length);
    assert.deepEqual(sentMail.map(mail => mail.to.address).sort(), normals.map(([, , email]) => email).sort());
    for (const brand of BRANDS) {
      assert.equal(sentMail.some(mail => String(mail.to.address).includes('brandfu')), false, brand);
    }

    const proposalsAfter = await pool.query(
      `SELECT id, status, followup1_sent_at, followup2_sent_at, error, stop_reason, updated_at
         FROM proposals WHERE id = ANY($1::int[]) ORDER BY id`,
      [brandProposalIds]
    );
    assert.equal(proposalsAfter.rows.length, blockedRows);
    for (let i = 0; i < proposalsBefore.rows.length; i++) {
      const before = proposalsBefore.rows[i];
      const after = proposalsAfter.rows[i];
      assert.equal(after.status, 'sent');
      assert.equal(after.followup1_sent_at, null);
      assert.equal(after.followup2_sent_at, null);
      assert.equal(after.error, before.error);
      assert.equal(after.stop_reason, before.stop_reason);
      assert.equal(new Date(after.updated_at).toISOString(), new Date(before.updated_at).toISOString());
    }
    const leadsAfter = await pool.query(
      `SELECT id, fit_score, fit_tier, fit_reasons::text AS reasons, stage, last_contacted_at, updated_at
         FROM prospects WHERE id = ANY($1::int[]) ORDER BY id`,
      [brandLeadIds]
    );
    for (let i = 0; i < leadsBefore.rows.length; i++) {
      const before = leadsBefore.rows[i];
      const after = leadsAfter.rows[i];
      assert.equal(after.fit_score, before.fit_score);
      assert.equal(after.fit_tier, before.fit_tier);
      assert.equal(after.reasons, before.reasons);
      assert.equal(after.stage, before.stage);
      assert.equal(after.last_contacted_at, before.last_contacted_at);
      assert.equal(new Date(after.updated_at).toISOString(), new Date(before.updated_at).toISOString());
    }
  });
});
