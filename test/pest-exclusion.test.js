require('./preload');

// The default exclusion list is Pest Control. Set it before discover.js and
// scoring/config.js read it so a local .env cannot change the list.
process.env.EXCLUDED_INDUSTRIES = 'Pest Control';
process.env.TARGET_MARKETS = 'Provo UT';
process.env.MIN_RATING = '0';

// In-memory only: put the removed queries back on the catalog array before
// discover.js filters it. The file on disk is unchanged. A re-added pest
// query must still be skipped, and the mock must not be asked for it.
const catalog = require('../src/bot/industries');
const shippedQueries = catalog.map(row => row.query);
catalog.push(
  { query: 'pest control company', industry: 'Pest Control', score: 9 },
  { query: 'exterminator', industry: 'Pest Control', score: 9 },
);

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { runDiscovery, INDUSTRIES } = require('../src/bot/discover');
const { _setSearch } = require('../src/bot/google-places');
const { computeFit } = require('../src/scoring/fit');
const { EXCLUDED_INDUSTRIES, INDUSTRY_FIT } = require('../src/scoring/config');
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

function isPestQuery(query) {
  return /pest|exterminator/i.test(query);
}

describe('pest control exclusion', { concurrency: false }, () => {
  const queries = [];

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
          websiteUri: 'https://wasatchpest.example',
          nationalPhoneNumber: '(801) 555-0199',
        })];
      }
      if (query === 'HVAC company' || query === 'air conditioning repair' || query === 'heating and cooling') {
        return [place()];
      }
      if (query === 'plumbing company' || query === 'plumber') {
        return [place({
          id: 'test-place-provo-plumbing',
          displayName: { text: 'Provo Plumbing' },
          websiteUri: 'https://provoplumbing.example',
          nationalPhoneNumber: '(801) 555-0140',
        })];
      }
      return [];
    });
  });

  after(async () => {
    _setSearch(null);
    await closePool();
  });

  it('scores Pest Control as out of scope and keeps other home services', () => {
    assert.deepEqual(EXCLUDED_INDUSTRIES, ['Pest Control']);
    assert.equal(Object.hasOwn(INDUSTRY_FIT, 'Pest Control'), false);
    assert.equal(INDUSTRY_FIT.HVAC, 9);
    assert.equal(INDUSTRY_FIT.Plumbing, 8);

    const pest = computeFit({
      ...sweetSpot,
      company: 'Wasatch Pest Control',
      industry: 'Pest Control',
      website: 'https://wasatchpest.example',
    });
    assert.equal(pest.fit_score, 0);
    assert.equal(pest.fit_tier, 'D');
    assert.equal(pest.fit_reasons.length, 1);
    assert.equal(pest.fit_reasons[0].label, 'Industry');
    assert.equal(pest.fit_reasons[0].points, 0);
    assert.equal(pest.fit_reasons[0].detail, 'Pest Control — out of scope');

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
    assert.ok(plumbing.fit_reasons.find(r => r.label === 'Industry').points > 0);
  });

  it('excludes pest-control Places results and keeps non-pest home-service results', async () => {
    assert.equal(shippedQueries.some(isPestQuery), false);
    assert.equal(INDUSTRIES.some(row => row.industry === 'Pest Control' || isPestQuery(row.query)), false);
    assert.equal(INDUSTRIES.some(row => row.industry === 'HVAC'), true);
    assert.equal(INDUSTRIES.some(row => row.industry === 'Plumbing'), true);
    assert.equal(INDUSTRIES.some(row => row.industry === 'Roofing'), true);

    const summary = await runDiscovery();
    assert.equal(summary.errors, 0);
    assert.equal(summary.queriesRun, INDUSTRIES.length);
    assert.equal(summary.newAdded, 2);
    assert.deepEqual(queries.map(q => q.query), INDUSTRIES.map(row => row.query));
    assert.equal(queries.some(q => isPestQuery(q.query)), false);
    assert.ok(queries.every(q => q.location === 'Provo UT'));

    const { rows } = await pool.query(
      `SELECT google_place_id, company, industry, fit_score, fit_tier, fit_reasons
       FROM prospects ORDER BY id`
    );
    assert.equal(rows.some(r => r.google_place_id === PEST_PLACE_ID), false);
    const pestRows = rows.filter(r => r.industry === 'Pest Control');
    assert.equal(pestRows.length, 1);
    assert.equal(pestRows[0].google_place_id, 'test-place-existing-pest');
    assert.equal(pestRows[0].company, 'Existing Pest Co');
    assert.equal(pestRows[0].fit_score, 0);
    assert.equal(pestRows[0].fit_tier, 'D');
    assert.equal(pestRows[0].fit_reasons.length, 1);
    assert.equal(pestRows[0].fit_reasons[0].points, 0);
    assert.equal(pestRows[0].fit_reasons[0].detail, 'Pest Control — out of scope');

    const hvac = rows.find(r => r.google_place_id === 'test-place-wasatch-heating');
    assert.equal(hvac.company, 'Wasatch Heating');
    assert.equal(hvac.industry, 'HVAC');
    assert.equal(hvac.fit_score, 97);
    assert.equal(hvac.fit_tier, 'A');

    const plumbing = rows.find(r => r.google_place_id === 'test-place-provo-plumbing');
    assert.equal(plumbing.company, 'Provo Plumbing');
    assert.equal(plumbing.industry, 'Plumbing');
    assert.equal(plumbing.fit_score, 93);
    assert.equal(plumbing.fit_tier, 'A');
  });
});
