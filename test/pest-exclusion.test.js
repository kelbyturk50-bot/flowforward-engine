require('./preload');

// The default exclusion list is Pest Control. Set it before discover.js and
// scoring/config.js read it so a local .env cannot change the list.
process.env.EXCLUDED_INDUSTRIES = 'Pest Control';
process.env.TARGET_MARKETS = 'Provo UT';
process.env.MIN_RATING = '0';

// In-memory only: put the removed queries back on the catalog array before
// discover.js filters it. The file on disk is unchanged. A re-added pest
// query, including a synonym industry, must still be skipped.
const catalog = require('../src/bot/industries');
const shippedQueries = catalog.map(row => row.query);
catalog.push(
  { query: 'pest control company', industry: 'Pest Control', score: 9 },
  { query: 'exterminator', industry: 'Pest Control', score: 9 },
  { query: 'termite control', industry: 'Termite Control', score: 9 },
);

const http = require('http');
const express = require('express');
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { runDiscovery, INDUSTRIES } = require('../src/bot/discover');
const { _setSearch } = require('../src/bot/google-places');
const { computeFit } = require('../src/scoring/fit');
const { EXCLUDED_INDUSTRIES, INDUSTRY_FIT } = require('../src/scoring/config');
const { normalizeIndustry, isPestText, isPestDiscoveryPlace } = require('../src/scoring/industry');
const { pickLeads } = require('../src/proposals/draft');
const { resetDb, insertProspect, closePool, pool } = require('./fixtures');

const sweetSpot = {
  website: 'https://example.test',
  phone: '(801) 555-0100',
  city: 'Provo',
  state: 'UT',
  rating: 4.0,
  review_count: 80,
  fit_boost: 20,
};

const PEST_INDUSTRIES = [
  'pest control',
  'PEST CONTROL',
  'Pest control',
  'Pest Control ',
  'Exterminator',
  'Termite Control',
  'Pest Management',
  'exterminating',
  'termites',
];

const FALSE_POSITIVE_NAMES = ['Pestana Plumbing', 'Compest', 'Best Heating', 'Pestana', 'Best'];

function place(overrides = {}) {
  return {
    id: 'test-place-wasatch-heating',
    displayName: { text: 'Wasatch Heating' },
    formattedAddress: '100 Center St, Provo, UT 84601',
    nationalPhoneNumber: '(801) 555-0100',
    websiteUri: 'https://wasatchheating.example',
    rating: 4.0,
    userRatingCount: 80,
    businessStatus: 'OPERATIONAL',
    addressComponents: [
      { types: ['locality'], longText: 'Provo', shortText: 'Provo' },
      { types: ['administrative_area_level_1'], longText: 'Utah', shortText: 'UT' },
      { types: ['postal_code'], longText: '84601', shortText: '84601' },
    ],
    ...overrides,
  };
}

const PEST_PLACE_ID = 'test-place-wasatch-pest';
const DROPPED_IDS = [
  PEST_PLACE_ID,
  'test-place-valley-air',
  'test-place-canyon-comfort',
  'test-place-acme-exterminators',
];

function isPestQuery(query) {
  return /\bpest\b|exterminator|termite/i.test(query);
}

function leadBody(overrides) {
  return {
    company: 'Sample Co',
    industry: 'HVAC',
    website: 'https://sample.example',
    phone: '(801) 555-0100',
    city: 'Provo',
    state: 'UT',
    rating: 4,
    review_count: 80,
    ...overrides,
  };
}

describe('pest control exclusion', { concurrency: false }, () => {
  const queries = [];
  let server;
  let apiBase;

  before(async () => {
    await resetDb();
    const existing = await insertProspect({
      google_place_id: 'test-place-existing-pest',
      company: 'Existing Pest Co',
      industry: 'Pest Control',
      website: 'https://existingpest.example',
      phone: '(801) 555-0170',
      rating: 4.0,
      review_count: 80,
      score: 9,
    });
    await pool.query('UPDATE prospects SET fit_boost = 20 WHERE id = $1', [existing.id]);

    _setSearch(async (query, location) => {
      queries.push({ query, location });
      if (isPestQuery(query)) {
        return [place({
          id: PEST_PLACE_ID,
          displayName: { text: 'Wasatch Pest Control' },
          primaryType: 'pest_control_service',
        })];
      }
      if (query === 'HVAC company') {
        return [
          place(),
          place({
            id: PEST_PLACE_ID,
            displayName: { text: 'Wasatch Pest Control & Termite' },
            primaryType: 'pest_control_service',
            types: ['pest_control_service', 'point_of_interest'],
          }),
          place({ id: 'test-place-pestana', displayName: { text: 'Pestana Plumbing' } }),
          place({ id: 'test-place-compest', displayName: { text: 'Compest' } }),
          place({ id: 'test-place-best-heating', displayName: { text: 'Best Heating' } }),
        ];
      }
      if (query === 'air conditioning repair' || query === 'heating and cooling') {
        return [place()];
      }
      if (query === 'plumbing company') {
        return [
          place({
            id: 'test-place-provo-plumbing',
            displayName: { text: 'Provo Plumbing' },
            websiteUri: 'https://provoplumbing.example',
            nationalPhoneNumber: '(801) 555-0140',
          }),
          place({
            id: 'test-place-valley-air',
            displayName: { text: 'Valley Air' },
            types: ['pest_control_service', 'point_of_interest'],
          }),
        ];
      }
      if (query === 'plumber') {
        return [place({
          id: 'test-place-canyon-comfort',
          displayName: { text: 'Canyon Comfort' },
          primaryType: 'pest_control_service',
        })];
      }
      if (query === 'general contractor') {
        return [
          place({
            id: 'test-place-summit-builders',
            displayName: { text: 'Summit Builders' },
            websiteUri: 'https://summitbuilders.example',
          }),
          place({
            id: 'test-place-acme-exterminators',
            displayName: { text: 'ACME EXTERMINATORS' },
            types: ['general_contractor'],
          }),
        ];
      }
      return [];
    });

    const app = express();
    app.use(express.json());
    app.use('/api', require('../src/api/auth'));
    app.use('/api/prospects', require('../src/api/prospects'));
    server = http.createServer(app);
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    apiBase = `http://127.0.0.1:${server.address().port}`;
  });

  after(async () => {
    _setSearch(null);
    if (server) await new Promise(resolve => server.close(resolve));
    await closePool();
  });

  it('maps pest synonyms to Pest Control and keeps lookalike names', () => {
    assert.deepEqual(EXCLUDED_INDUSTRIES, ['Pest Control']);
    assert.equal(Object.hasOwn(INDUSTRY_FIT, 'Pest Control'), false);
    assert.equal(INDUSTRY_FIT.HVAC, 9);
    assert.equal(INDUSTRY_FIT.Plumbing, 8);

    for (const name of FALSE_POSITIVE_NAMES) {
      assert.equal(isPestText(name), false, name);
      assert.equal(normalizeIndustry(name), name.trim(), name);
      assert.equal(isPestDiscoveryPlace(place({ displayName: { text: name } })), false, name);
    }
    assert.equal(isPestDiscoveryPlace(place({
      displayName: { text: 'Valley Air' },
      types: ['pest_control_service'],
    })), true);
    assert.equal(isPestDiscoveryPlace(place({
      displayName: { text: 'Canyon Comfort' },
      primaryType: 'pest_control_service',
    })), true);

    for (const industry of PEST_INDUSTRIES) {
      assert.equal(normalizeIndustry(industry), 'Pest Control', industry);
      const fit = computeFit({
        ...sweetSpot,
        company: 'x',
        industry,
        website: 'https://x.example',
      });
      assert.equal(fit.fit_score, 0, industry);
      assert.equal(fit.fit_tier, 'D', industry);
      assert.equal(fit.fit_reasons.length, 1, industry);
      assert.equal(fit.fit_reasons[0].points, 0, industry);
      assert.equal(fit.fit_reasons[0].detail, 'Pest Control — out of scope', industry);
    }

    const hvac = computeFit({
      ...sweetSpot,
      company: 'Wasatch Heating',
      industry: 'HVAC',
      website: 'https://wasatchheating.example',
      fit_boost: 0,
    });
    assert.equal(hvac.fit_score, 97);
    assert.equal(hvac.fit_tier, 'A');
    assert.equal(hvac.fit_reasons.find(r => r.label === 'Industry').points, 27);

    const plumbing = computeFit({
      ...sweetSpot,
      company: 'Provo Plumbing',
      industry: 'Plumbing',
      website: 'https://provoplumbing.example',
      phone: '(801) 555-0140',
      fit_boost: 0,
    });
    assert.equal(plumbing.fit_score, 93);
    assert.equal(plumbing.fit_tier, 'A');
  });

  it('drops pest Places results from other trades and keeps lookalike names', async () => {
    assert.equal(shippedQueries.some(isPestQuery), false);
    assert.equal(INDUSTRIES.some(row => isPestQuery(row.query) || row.industry === 'Pest Control'), false);
    assert.equal(INDUSTRIES.some(row => row.industry === 'Termite Control'), false);
    assert.equal(INDUSTRIES.some(row => row.industry === 'HVAC'), true);
    assert.equal(INDUSTRIES.some(row => row.industry === 'Plumbing'), true);

    const summary = await runDiscovery();
    assert.equal(summary.errors, 0);
    assert.equal(summary.queriesRun, INDUSTRIES.length);
    assert.equal(summary.newAdded, 6);
    assert.deepEqual(queries.map(q => q.query), INDUSTRIES.map(row => row.query));
    assert.equal(queries.some(q => isPestQuery(q.query)), false);

    const { rows } = await pool.query(
      `SELECT google_place_id, company, industry, fit_score, fit_tier, fit_reasons
       FROM prospects ORDER BY id`
    );
    for (const id of DROPPED_IDS) {
      assert.equal(rows.some(r => r.google_place_id === id), false, id);
    }
    const pestRows = rows.filter(r => r.industry === 'Pest Control');
    assert.equal(pestRows.length, 1);
    assert.equal(pestRows[0].google_place_id, 'test-place-existing-pest');
    assert.equal(pestRows[0].fit_score, 0);
    assert.equal(pestRows[0].fit_tier, 'D');
    assert.equal(pestRows[0].fit_reasons[0].detail, 'Pest Control — out of scope');

    const kept = (id) => rows.find(r => r.google_place_id === id);
    const hvac = kept('test-place-wasatch-heating');
    assert.equal(hvac.company, 'Wasatch Heating');
    assert.equal(hvac.industry, 'HVAC');
    assert.equal(hvac.fit_score, 97);
    assert.equal(hvac.fit_tier, 'A');

    for (const [id, company] of [
      ['test-place-pestana', 'Pestana Plumbing'],
      ['test-place-compest', 'Compest'],
      ['test-place-best-heating', 'Best Heating'],
    ]) {
      const row = kept(id);
      assert.equal(row.company, company);
      assert.equal(row.industry, 'HVAC');
      assert.equal(row.fit_score, 97);
      assert.equal(row.fit_tier, 'A');
    }

    const plumbing = kept('test-place-provo-plumbing');
    assert.equal(plumbing.company, 'Provo Plumbing');
    assert.equal(plumbing.industry, 'Plumbing');
    assert.equal(plumbing.fit_score, 93);
    assert.equal(plumbing.fit_tier, 'A');

    const builder = kept('test-place-summit-builders');
    assert.equal(builder.company, 'Summit Builders');
    assert.equal(builder.industry, 'Construction');
    assert.equal(builder.fit_score, 87);
    assert.equal(builder.fit_tier, 'A');
  });

  it('pickLeads skips pest synonyms and keeps other home services', async () => {
    const synonymIds = [];
    for (const industry of PEST_INDUSTRIES) {
      const row = await insertProspect({
        google_place_id: `test-place-synonym-${synonymIds.length}`,
        company: `Synonym ${synonymIds.length}`,
        industry,
        website: 'https://synonym.example',
        phone: '(801) 555-0180',
      });
      await pool.query(
        `UPDATE prospects SET fit_tier = 'A', fit_score = 100, stage = 'found' WHERE id = $1`,
        [row.id]
      );
      synonymIds.push(row.id);
    }

    const picked = await pickLeads(50);
    const pickedIds = new Set(picked.map(row => row.id));
    for (const id of synonymIds) assert.equal(pickedIds.has(id), false, `picked synonym ${id}`);
    for (const placeId of ['test-place-wasatch-heating', 'test-place-pestana', 'test-place-compest', 'test-place-best-heating', 'test-place-provo-plumbing']) {
      const row = picked.find(r => r.google_place_id === placeId);
      assert.ok(row, placeId);
      assert.equal(row.fit_tier, 'A');
    }

    const { rows } = await pool.query(
      'SELECT id, fit_score, fit_tier FROM prospects WHERE id = ANY($1::int[])',
      [synonymIds]
    );
    // Still A/100 in the table; the industry predicate is what excluded them.
    assert.ok(rows.every(r => r.fit_tier === 'A' && r.fit_score === 100));
  });

  it('Add-lead and prospects API store the canonical pest industry', async () => {
    async function send(method, path, body) {
      const res = await fetch(apiBase + path, {
        method,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      const json = await res.json();
      return { status: res.status, json };
    }

    // The CRM Add-lead form posts this shape through createLead.
    for (const industry of ['pest control', '  Exterminator  ', 'Termite Control', 'Pest Management']) {
      const created = await send('POST', '/api/prospects', leadBody({
        company: `Form ${industry.trim()}`,
        industry,
        website: 'https://x.example',
        fit_boost: 20,
      }));
      assert.equal(created.status, 201, JSON.stringify(created.json));
      assert.equal(created.json.industry, 'Pest Control');
      assert.equal(created.json.fit_score, 0);
      assert.equal(created.json.fit_tier, 'D');
      assert.equal(created.json.fit_reasons[0].detail, 'Pest Control — out of scope');
    }

    const hvac = await send('POST', '/api/prospects', leadBody({
      company: 'Form HVAC',
      industry: '  HVAC  ',
    }));
    assert.equal(hvac.status, 201);
    assert.equal(hvac.json.industry, 'HVAC');
    assert.equal(hvac.json.fit_score, 97);
    assert.equal(hvac.json.fit_tier, 'A');

    const lookalikes = [
      ['Pestana Plumbing', 'Plumbing', 93],
      ['Compest', 'HVAC', 97],
      ['Best Heating', 'HVAC', 97],
    ];
    for (const [company, industry, score] of lookalikes) {
      const created = await send('POST', '/api/prospects', leadBody({ company, industry }));
      assert.equal(created.status, 201, company);
      assert.equal(created.json.company, company);
      assert.equal(created.json.industry, industry);
      assert.equal(created.json.fit_score, score);
      assert.equal(created.json.fit_tier, 'A');
    }

    const patched = await send('PATCH', `/api/prospects/${hvac.json.id}`, { industry: ' termite control ' });
    assert.equal(patched.status, 200, JSON.stringify(patched.json));
    assert.equal(patched.json.industry, 'Pest Control');
    assert.equal(patched.json.fit_score, 0);
    assert.equal(patched.json.fit_tier, 'D');

    await pool.query(
      `UPDATE prospects SET fit_tier = 'A', fit_score = 100 WHERE id = $1`,
      [patched.json.id]
    );
    const picked = await pickLeads(50);
    assert.equal(picked.some(row => row.id === patched.json.id), false);
    assert.equal(picked.some(row => row.company === 'Pestana Plumbing' && row.industry === 'Plumbing'), true);
  });
});
