require('./preload');

// F-004. Cap ServiceTitan and franchise leads at tier B after penalties and
// fit_boost. Disposable Postgres, no Places, no live fetch.

const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const axios = require('axios');
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const catalog = require('../src/bot/industries');
const { INDUSTRIES } = require('../src/bot/discover');
const { _setSearch } = require('../src/bot/google-places');
const {
  INDUSTRY_FIT, SERVICETITAN_PENALTY, TIER_CAP_FOR, TIERS, FRANCHISE_PATTERNS,
} = require('../src/scoring/config');
const { computeFit, rescore } = require('../src/scoring/fit');
const { isFranchise } = require('../src/scoring/prototypes');
const { resetDb, insertProspect, closePool, pool } = require('./fixtures');

// Post-F-002 Places catalog. F-004 must not add a query type.
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

// Scores these fixtures had before the tier cap. None of them is a franchise
// name, except the pest row, which is excluded before scoring.
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
  ['pest stays excluded', {
    ...sweet,
    company: 'Terminix',
    industry: 'Pest Control',
    fsm_detected: 'ServiceTitan',
    fit_boost: 20,
  }, 0, 'D'],
];

function armNoFetch() {
  const hits = [];
  const saved = [];
  const note = (name) => () => {
    hits.push(name);
    const err = new Error(`unexpected fetch via ${name}`);
    err.code = 'TIER_CAP_FETCH';
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

function labelIndex(fit, label) {
  return fit.fit_reasons.findIndex(r => r.label === label);
}

describe('F-004 tier cap', () => {
  it('documents TIER_CAP_FOR and leaves weights, penalties, and thresholds alone', () => {
    assert.deepEqual(TIER_CAP_FOR, { servicetitan: 'B', franchise: 'B' });
    assert.equal(SERVICETITAN_PENALTY, -15);
    assert.deepEqual(TIERS, [
      { tier: 'A', min: 78 },
      { tier: 'B', min: 62 },
      { tier: 'C', min: 47 },
      { tier: 'D', min: 0 },
    ]);
    assert.equal(TIERS.find(t => t.tier === 'A').min - 1, 77);
    assert.equal(INDUSTRY_FIT.HVAC, 10);
    assert.equal(INDUSTRY_FIT.Plumbing, 9);
    assert.equal(INDUSTRY_FIT.Electrical, 5);
    assert.equal(INDUSTRY_FIT.Roofing, 5);
    assert.equal(INDUSTRY_FIT.Landscaping, 3);
    assert.equal(INDUSTRY_FIT.Construction, 3);
    assert.equal(INDUSTRY_FIT.Painting, 3);
    assert.equal(INDUSTRY_FIT.Cleaning, 2);
    assert.equal(INDUSTRY_FIT.Gutters, 2);
    assert.equal(INDUSTRY_FIT.Windows, 2);
    assert.equal(Object.hasOwn(INDUSTRY_FIT, 'Pest Control'), false);
    assert.equal(FRANCHISE_PATTERNS.includes('terminix'), true);
    assert.equal(catalog.length, PLACES_QUERY_COUNT);
    assert.equal(INDUSTRIES.length, PLACES_QUERY_COUNT);

    const fitSrc = fs.readFileSync(path.join(__dirname, '../src/scoring/fit.js'), 'utf8');
    assert.doesNotMatch(fitSrc, /axios|fetch\(|searchPlaces|google-places|researchLead|https?:\/\//);
    const configSrc = fs.readFileSync(path.join(__dirname, '../src/scoring/config.js'), 'utf8');
    assert.match(configSrc, /TIER_CAP_FOR = \{/);
    assert.match(configSrc, /servicetitan: 'B'/);
    assert.match(configSrc, /franchise: 'B'/);
  });

  it('caps the 85/A ServiceTitan fixture at 77/B, after a positive boost too', () => {
    const plain = computeFit(sweet);
    assert.equal(plain.fit_score, 100);

    for (const fsm of ['ServiceTitan', 'servicetitan', ' SERVICETITAN ']) {
      const fit = computeFit({ ...sweet, fsm_detected: fsm });
      assert.equal(fit.fit_reasons.find(r => r.label === 'ServiceTitan').points, -15, fsm);
      assert.equal(plain.fit_score + SERVICETITAN_PENALTY, 85);
      assert.ok(fit.fit_score <= 77, fsm);
      assert.equal(fit.fit_score, 77, fsm);
      assert.equal(fit.fit_tier, 'B', fsm);
      assert.notEqual(fit.fit_tier, 'A', fsm);
      const cap = fit.fit_reasons.find(r => r.label === 'Tier cap');
      assert.ok(cap, fsm);
      assert.equal(cap.points, 77 - 85, fsm);
      assert.equal(cap.detail, 'Capped at tier B (77) — ServiceTitan leads are not tier A buyers');
      assert.ok(labelIndex(fit, 'ServiceTitan') < labelIndex(fit, 'Tier cap'));
    }

    const boosted = computeFit({ ...sweet, fsm_detected: 'ServiceTitan', fit_boost: 20 });
    assert.equal(boosted.fit_reasons.find(r => r.label === 'Your boost').points, 20);
    assert.equal(boosted.fit_reasons.find(r => r.label === 'ServiceTitan').points, -15);
    assert.ok(boosted.fit_score <= 77);
    assert.equal(boosted.fit_score, 77);
    assert.equal(boosted.fit_tier, 'B');
    const cap = boosted.fit_reasons.find(r => r.label === 'Tier cap');
    assert.equal(cap.points, 77 - 100);
    assert.ok(labelIndex(boosted, 'Your boost') < labelIndex(boosted, 'Tier cap'));
    assert.ok(labelIndex(boosted, 'ServiceTitan') < labelIndex(boosted, 'Tier cap'));
  });

  it('caps the franchise HVAC fixture (was 80/A) at 77/B', () => {
    const fit = computeFit({ ...sweet, company: 'Terminix of Provo' });
    assert.equal(fit.fit_reasons.find(r => r.label === 'Franchise').points, -20);
    assert.equal(fit.fit_reasons.some(r => r.label === 'ServiceTitan'), false);
    assert.ok(fit.fit_score <= 77);
    assert.equal(fit.fit_score, 77);
    assert.equal(fit.fit_tier, 'B');
    const cap = fit.fit_reasons.find(r => r.label === 'Tier cap');
    assert.ok(cap);
    assert.equal(cap.points, 77 - 80);
    assert.equal(cap.detail, 'Capped at tier B (77) — franchise leads are not tier A buyers');
    assert.ok(labelIndex(fit, 'Franchise') < labelIndex(fit, 'Tier cap'));

    const boosted = computeFit({ ...sweet, company: 'One Hour Heating of Provo', fit_boost: 20 });
    assert.equal(boosted.fit_reasons.find(r => r.label === 'Franchise').points, -20);
    assert.equal(boosted.fit_reasons.find(r => r.label === 'Your boost').points, 20);
    assert.equal(boosted.fit_score, 77);
    assert.equal(boosted.fit_tier, 'B');
    assert.ok(labelIndex(boosted, 'Your boost') < labelIndex(boosted, 'Tier cap'));

    const under = computeFit({ ...sweet, company: 'Trugreen of Provo', industry: 'Landscaping' });
    assert.equal(under.fit_reasons.find(r => r.label === 'Franchise').points, -20);
    assert.equal(under.fit_score, 57);
    assert.equal(under.fit_tier, 'C');
    assert.equal(under.fit_reasons.some(r => r.label === 'Tier cap'), false);
  });

  it('does not cap substring lookalikes, and still caps whole-word franchise names', () => {
    assert.equal(isFranchise('TEST: Constrane Heating', FRANCHISE_PATTERNS), false);
    assert.equal(isFranchise('TEST: Carriero HVAC', FRANCHISE_PATTERNS), false);
    assert.equal(isFranchise('TEST: Trane Heating', FRANCHISE_PATTERNS), true);
    assert.equal(isFranchise('TEST: Carrier HVAC', FRANCHISE_PATTERNS), true);

    for (const company of ['TEST: Constrane Heating', 'TEST: Carriero HVAC']) {
      const fit = computeFit({ ...sweet, company });
      assert.equal(fit.fit_reasons.find(r => r.label === 'Franchise').points, -20, company);
      assert.equal(fit.fit_reasons.some(r => r.label === 'Tier cap'), false, company);
      assert.equal(fit.fit_score, 80, company);
      assert.equal(fit.fit_tier, 'A', company);
    }

    for (const company of ['TEST: Trane Heating', 'TEST: Carrier HVAC', 'Terminix of Provo', 'Service Experts Utah']) {
      const fit = computeFit({ ...sweet, company });
      assert.equal(fit.fit_reasons.find(r => r.label === 'Franchise').points, -20, company);
      assert.equal(fit.fit_score, 77, company);
      assert.equal(fit.fit_tier, 'B', company);
      assert.match(fit.fit_reasons.find(r => r.label === 'Tier cap').detail, /franchise/);
    }
  });

  it('keeps ServiceTitan plus franchise at or below 77', () => {
    const both = computeFit({
      ...sweet,
      company: 'Terminix of Provo',
      fsm_detected: 'ServiceTitan',
    });
    assert.equal(both.fit_reasons.find(r => r.label === 'Franchise').points, -20);
    assert.equal(both.fit_reasons.find(r => r.label === 'ServiceTitan').points, -15);
    assert.ok(both.fit_score <= 77);
    assert.equal(both.fit_score, 65);
    assert.equal(both.fit_tier, 'B');
    assert.equal(both.fit_reasons.some(r => r.label === 'Tier cap'), false);

    const boosted = computeFit({
      ...sweet,
      company: 'Terminix of Provo',
      fsm_detected: ' servicetitan ',
      fit_boost: 20,
    });
    assert.equal(boosted.fit_reasons.find(r => r.label === 'Your boost').points, 20);
    assert.ok(boosted.fit_score <= 77);
    assert.equal(boosted.fit_score, 77);
    assert.equal(boosted.fit_tier, 'B');
    const cap = boosted.fit_reasons.find(r => r.label === 'Tier cap');
    assert.equal(cap.points, 77 - 85);
    assert.equal(cap.detail, 'Capped at tier B (77) — ServiceTitan and franchise leads are not tier A buyers');
    assert.ok(labelIndex(boosted, 'Franchise') < labelIndex(boosted, 'Tier cap'));
    assert.ok(labelIndex(boosted, 'ServiceTitan') < labelIndex(boosted, 'Tier cap'));
    assert.ok(labelIndex(boosted, 'Your boost') < labelIndex(boosted, 'Tier cap'));
  });

  it('does not cap null or unknown fsm_detected', () => {
    for (const fsm of [null, undefined, '', '   ', 'none', 'None', 'Jobber', 'Housecall Pro', 'Workiz', 'service titan']) {
      const fit = computeFit({ ...sweet, fsm_detected: fsm });
      assert.equal(fit.fit_score, 100, JSON.stringify(fsm));
      assert.equal(fit.fit_tier, 'A', JSON.stringify(fsm));
      assert.equal(fit.fit_reasons.some(r => r.label === 'Tier cap'), false, JSON.stringify(fsm));
      assert.equal(fit.fit_reasons.some(r => r.label === 'ServiceTitan'), false, JSON.stringify(fsm));
    }
  });

  it('leaves other fixtures at their existing scores', () => {
    for (const [name, row, score, tier] of SNAPSHOT) {
      const fit = computeFit(row);
      assert.equal(fit.fit_score, score, name);
      assert.equal(fit.fit_tier, tier, name);
      assert.equal(fit.fit_reasons.some(r => r.label === 'Tier cap'), false, name);
    }
  });

  describe('cache only', () => {
    before(() => resetDb());
    after(async () => {
      _setSearch(null);
      await closePool();
    });

    it('computeFit and rescore do no HTTP and do not call Places', async () => {
      const st = await insertProspect({
        google_place_id: 'test-place-f004-st',
        company: 'Cache Heating',
        fsm_detected: 'ServiceTitan',
      });
      const plain = await insertProspect({
        google_place_id: 'test-place-f004-plain',
        company: 'Wasatch Heating',
        fsm_detected: null,
      });
      const franchise = await insertProspect({
        google_place_id: 'test-place-f004-franchise',
        company: 'Terminix of Provo',
        fsm_detected: 'Jobber',
      });
      await pool.query('UPDATE prospects SET fit_boost = 20 WHERE id = $1', [st.id]);

      let placesCalls = 0;
      _setSearch(() => {
        placesCalls += 1;
        throw new Error('Places must not be called from scoring');
      });
      const guard = armNoFetch();
      try {
        const mem = computeFit({ ...sweet, fsm_detected: 'ServiceTitan', fit_boost: 20 });
        assert.equal(mem.fit_score, 77);
        const n = await rescore();
        assert.equal(n, 3);
        assert.equal(placesCalls, 0);
        assert.deepEqual(guard.hits, []);
        assert.equal(catalog.length, PLACES_QUERY_COUNT);
      } finally {
        guard.restore();
        _setSearch(null);
      }

      const saved = await pool.query(
        'SELECT id, fit_score, fit_tier, fit_reasons, fsm_detected FROM prospects ORDER BY id'
      );
      const byId = new Map(saved.rows.map(row => [row.id, row]));
      assert.equal(byId.get(st.id).fit_score, 77);
      assert.equal(byId.get(st.id).fit_tier, 'B');
      assert.equal(byId.get(st.id).fsm_detected, 'ServiceTitan');
      assert.equal(
        byId.get(st.id).fit_reasons.find(r => r.label === 'Tier cap').detail,
        'Capped at tier B (77) — ServiceTitan leads are not tier A buyers'
      );
      assert.equal(byId.get(plain.id).fit_score, 100);
      assert.equal(byId.get(plain.id).fit_tier, 'A');
      assert.equal(byId.get(plain.id).fit_reasons.some(r => r.label === 'Tier cap'), false);
      assert.equal(byId.get(franchise.id).fit_score, 77);
      assert.equal(byId.get(franchise.id).fit_tier, 'B');
      assert.equal(byId.get(franchise.id).fsm_detected, 'Jobber');
      assert.match(byId.get(franchise.id).fit_reasons.find(r => r.label === 'Tier cap').detail, /franchise/);
      assert.equal(byId.get(franchise.id).fit_reasons.some(r => r.label === 'ServiceTitan'), false);
    });
  });
});
