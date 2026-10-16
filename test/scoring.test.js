require('./preload');

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { computeFit, rescore } = require('../src/scoring/fit');
const { resetDb, insertProspect, closePool } = require('./fixtures');

const sweetSpot = {
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

describe('scoring', () => {
  it('scores a sweet-spot owner-operated HVAC lead as tier A', () => {
    const fit = computeFit(sweetSpot);
    assert.equal(fit.fit_score, 100);
    assert.equal(fit.fit_tier, 'A');
    assert.equal(fit.fit_reasons.find(r => r.label === 'Size').points, 25);
    assert.equal(fit.fit_reasons.find(r => r.label === 'Reputation').points, 10);
    assert.equal(fit.fit_reasons.find(r => r.label === 'Location').points, 10);
  });

  it('penalizes a national brand', () => {
    const fit = computeFit({ ...sweetSpot, company: 'Terminix of Provo' });
    assert.equal(fit.fit_score, 80);
    assert.equal(fit.fit_tier, 'A');
    assert.equal(fit.fit_reasons.find(r => r.label === 'Franchise').points, -20);
  });

  it('scores a tiny out-of-market lead as tier D', () => {
    const fit = computeFit({
      company: 'Quiet Gutters',
      industry: 'Gutters',
      website: null,
      phone: null,
      city: 'Denver',
      state: 'CO',
      rating: null,
      review_count: 0,
    });
    assert.equal(fit.fit_score, 14);
    assert.equal(fit.fit_tier, 'D');
  });

  it('gives a social page fewer reachability points than a real site', () => {
    const real = computeFit(sweetSpot);
    const social = computeFit({ ...sweetSpot, website: 'https://facebook.com/wasatchheating' });
    const reach = (fit) => fit.fit_reasons.find(r => r.label === 'Reachability').points;
    assert.equal(reach(real), 15);
    assert.equal(reach(social), 10);
  });

  describe('rescore', () => {
    before(() => resetDb());
    after(() => closePool());

    it('persists fit_score and fit_tier', async () => {
      const row = await insertProspect();
      const n = await rescore();
      assert.equal(n, 1);
      const { rows } = await require('../src/db/client').query(
        'SELECT fit_score, fit_tier, fit_reasons FROM prospects WHERE id = $1',
        [row.id]
      );
      assert.equal(rows[0].fit_score, 100);
      assert.equal(rows[0].fit_tier, 'A');
      assert.ok(rows[0].fit_reasons.some(r => r.label === 'Industry' && r.points === 30));
    });
  });
});
