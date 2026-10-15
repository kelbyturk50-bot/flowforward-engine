require('./preload');

// Narrow the search loop for this file only. The upsert path is the real one;
// fewer industries just keeps the smoke test short (discover.js sleeps between queries).
process.env.TARGET_MARKETS = 'Provo UT';
process.env.EXCLUDED_INDUSTRIES = [
  'Roofing', 'Landscaping', 'Plumbing', 'Electrical', 'Pest Control',
  'Cleaning', 'Painting', 'Gutters', 'Windows', 'Construction',
].join(',');
process.env.MIN_RATING = '0';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { runDiscovery } = require('../src/bot/discover');
const { searchPlaces, normalizePplace, _setSearch } = require('../src/bot/google-places');
const { resetDb, closePool, pool } = require('./fixtures');

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

describe('discovery upsert', () => {
  before(async () => {
    await resetDb();
    _setSearch(async () => [
      place(),
      place({
        id: 'test-place-closed',
        displayName: { text: 'Gone Heating' },
        businessStatus: 'CLOSED_PERMANENTLY',
      }),
    ]);
  });

  after(async () => {
    _setSearch(null);
    await closePool();
  });

  it('normalizes a Places result into a prospect row', () => {
    const row = normalizePplace(place(), 'HVAC', 8);
    assert.equal(row.google_place_id, 'test-place-wasatch-heating');
    assert.equal(row.company, 'Wasatch Heating');
    assert.equal(row.city, 'Provo');
    assert.equal(row.state, 'UT');
    assert.equal(row.zip, '84601');
    assert.equal(row.industry, 'HVAC');
    assert.equal(row.stage, 'found');
    assert.equal(row.source, 'google_places');
  });

  it('inserts a new place once and skips duplicates and closed businesses', async () => {
    const first = await runDiscovery();
    assert.ok(first.queriesRun >= 1);
    assert.equal(first.errors, 0);
    assert.equal(first.totalFound, first.queriesRun * 2);
    assert.equal(first.newAdded, 1);

    const { rows } = await pool.query(
      'SELECT company, city, state, zip, phone, website, industry, stage, fit_score, fit_tier FROM prospects ORDER BY id'
    );
    assert.equal(rows.length, 1);
    assert.equal(rows[0].company, 'Wasatch Heating');
    assert.equal(rows[0].city, 'Provo');
    assert.equal(rows[0].state, 'UT');
    assert.equal(rows[0].zip, '84601');
    assert.equal(rows[0].phone, '(801) 555-0100');
    assert.equal(rows[0].website, 'https://wasatchheating.example');
    assert.equal(rows[0].industry, 'HVAC');
    assert.equal(rows[0].stage, 'found');
    assert.equal(rows[0].fit_score, 97);
    assert.equal(rows[0].fit_tier, 'A');

    const second = await runDiscovery();
    assert.equal(second.newAdded, 0);
    assert.equal(second.errors, 0);
    const again = await pool.query('SELECT COUNT(*)::int AS n FROM prospects');
    assert.equal(again.rows[0].n, 1);

    const runs = await pool.query(
      "SELECT status, new_added, errors FROM discovery_runs ORDER BY id"
    );
    assert.equal(runs.rows.length, 2);
    assert.equal(runs.rows[0].status, 'done');
    assert.equal(runs.rows[0].new_added, 1);
    assert.equal(runs.rows[1].status, 'done');
    assert.equal(runs.rows[1].new_added, 0);

    // The mock was used: searchPlaces did not require an API key.
    const mocked = await searchPlaces('HVAC company', 'Provo UT', 5);
    assert.equal(mocked.length, 2);
  });
});
