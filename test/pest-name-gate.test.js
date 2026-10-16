require('./preload');

// F-005 steps 1 and 2. Cache-only company-name gate. Disposable Postgres.
// No Places, Anthropic, Gmail, or live site.

process.env.EXCLUDED_INDUSTRIES = 'Pest Control';
process.env.CRM_API_KEY = '';

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
    app.use('/api/proposals', require('../src/api/proposals'));
    server = http.createServer(app);
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    apiBase = `http://127.0.0.1:${server.address().port}`;
  });

  after(async () => {
    _setClient(null);
    if (server) await new Promise(resolve => server.close(resolve));
    await closePool();
  });

  it('gates pest names stored as HVAC or plumbing, and keeps word-boundary lookalikes', () => {
    const guard = armNoFetch();
    try {
      for (const name of LOOKALIKES) {
        assert.equal(isPestText(name), false, name);
        assert.equal(isPestCompanyName(name), false, name);
      }
      for (const [company, industry] of GATED) {
        assert.equal(isPestText(company), true, company);
        assert.equal(isPestCompanyName(company), true, company);
        const fit = computeFit({
          ...sweet,
          company,
          industry,
          fit_boost: 20,
          fsm_detected: 'ServiceTitan',
        });
        assert.notEqual(fit.fit_tier, 'A', company);
        assert.equal(fit.fit_tier, 'D', company);
        assert.equal(fit.fit_score, 0, company);
        assert.equal(fit.fit_reasons.length, 1, company);
        assert.equal(fit.fit_reasons[0].label, 'Company', company);
        assert.equal(fit.fit_reasons[0].detail, PEST_NAME_REASON, company);
        assert.match(fit.fit_reasons[0].detail, /pest control/i, company);
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
    assert.doesNotMatch(fitSrc, /axios|fetch\(|searchPlaces|google-places|researchLead/);
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

    await rescore([pest.id]);
    const rescored = await pool.query(
      'SELECT fit_score, fit_tier, fit_reasons FROM prospects WHERE id = $1',
      [pest.id]
    );
    assert.equal(rescored.rows[0].fit_score, 0);
    assert.equal(rescored.rows[0].fit_tier, 'D');
    assert.equal(rescored.rows[0].fit_reasons[0].detail, PEST_NAME_REASON);

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
