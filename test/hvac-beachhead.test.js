require('./preload');

// F-002 acceptance. Disposable Postgres, mocked fetches, ServiceTitan cache
// set in-process. Nothing here calls Places, Anthropic, Gmail, or a live site.

const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const axios = require('axios');
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const catalog = require('../src/bot/industries');
const { INDUSTRIES } = require('../src/bot/discover');
const { INDUSTRY_FIT, SERVICETITAN_PENALTY, HOME_CITIES, HOME_STATE } = require('../src/scoring/config');
const { computeFit, rescore, sizePoints, ST_REASON } = require('../src/scoring/fit');
const { isExcludedIndustry } = require('../src/scoring/industry');
const { detectSignals } = require('../src/proposals/research');
const { fsmDetectedFromResearch, htmlHasServiceTitan } = require('../src/proposals/servicetitan');
const { draftProposal, _setClient } = require('../src/proposals/draft');
const { applySchema } = require('../src/db/migrate');
const { resetDb, insertProspect, closePool, pool, fakeClaude } = require('./fixtures');

// Post-F-001 catalog (pest already removed). 20 query types. F-002 reallocates
// this list; it does not add markets or raise RESULTS_PER_QUERY.
const BEFORE_QUERIES = [
  ['HVAC company', 'HVAC'],
  ['air conditioning repair', 'HVAC'],
  ['heating and cooling', 'HVAC'],
  ['roofing contractor', 'Roofing'],
  ['roofing company', 'Roofing'],
  ['landscaping company', 'Landscaping'],
  ['lawn care service', 'Landscaping'],
  ['lawn maintenance', 'Landscaping'],
  ['plumbing company', 'Plumbing'],
  ['plumber', 'Plumbing'],
  ['electrician', 'Electrical'],
  ['electrical contractor', 'Electrical'],
  ['house cleaning service', 'Cleaning'],
  ['commercial cleaning', 'Cleaning'],
  ['painting contractor', 'Painting'],
  ['interior exterior painting', 'Painting'],
  ['gutter cleaning company', 'Gutters'],
  ['window cleaning service', 'Windows'],
  ['general contractor', 'Construction'],
  ['home remodeling', 'Construction'],
];

const SWEET = {
  website: 'https://example.test',
  phone: '(801) 555-0100',
  city: 'Lehi',
  state: 'UT',
  rating: 4.0,
  review_count: 80,
  fit_boost: 0,
};

function lead(industry, extra = {}) {
  return { company: `${industry} Co`, industry, ...SWEET, ...extra };
}

function armNoFetch() {
  const hits = [];
  const saved = [];
  const note = (name) => () => {
    hits.push(name);
    const err = new Error(`unexpected fetch via ${name}`);
    err.code = 'BEACHHEAD_FETCH';
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

// main @ a91c97f (F-001), before this beachhead retune. Same reputation,
// reach, and Lehi location points as the seed below (10 + 15 + 10). No
// ServiceTitan penalty existed.
const MAIN_FIT = {
  HVAC: 9, Plumbing: 8, Roofing: 8, Electrical: 7, Landscaping: 7,
  Construction: 6, Painting: 6, Cleaning: 6, Gutters: 5, Windows: 5,
};

function mainSize(reviews) {
  const n = Number(reviews) || 0;
  if (n === 0) return 2;
  if (n < 10) return 6;
  if (n < 25) return 14;
  if (n <= 150) return 25;
  if (n <= 300) return 18;
  if (n <= 600) return 11;
  if (n <= 1500) return 6;
  return 2;
}

function mainScore(p) {
  if (isExcludedIndustry(p.industry)) return { fit_score: 0, fit_tier: 'D' };
  const ind = MAIN_FIT[p.industry] ?? 5;
  const indPts = Math.round((ind / 10) * 30);
  const base = indPts + mainSize(p.review_count) + 10 + 15 + 10;
  const fit_score = Math.max(0, Math.min(100, Math.round(base * (100 / 90))));
  const fit_tier = fit_score >= 78 ? 'A' : fit_score >= 62 ? 'B' : fit_score >= 47 ? 'C' : 'D';
  return { fit_score, fit_tier };
}

function median(nums) {
  const sorted = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2) return sorted[mid];
  return (sorted[mid - 1] + sorted[mid]) / 2;
}

function aShare(rows, industries) {
  const tierA = rows.filter(row => row.tier === 'A');
  const hit = tierA.filter(row => industries.includes(row.industry));
  return { hit: hit.length, of: tierA.length, pct: tierA.length ? hit.length / tierA.length : 0 };
}

describe('HVAC beachhead', { concurrency: false }, () => {
  before(() => resetDb());
  after(async () => {
    _setClient(null);
    await closePool();
  });

  it('retargets industry weights and keeps pest excluded', () => {
    assert.equal(INDUSTRY_FIT.HVAC, 10);
    assert.equal(INDUSTRY_FIT.Plumbing, 9);
    assert.ok(INDUSTRY_FIT.Electrical <= 5);
    assert.ok(INDUSTRY_FIT.Roofing <= 5);
    for (const name of ['Landscaping', 'Cleaning', 'Painting', 'Gutters', 'Windows', 'Construction']) {
      assert.ok(INDUSTRY_FIT[name] <= 3, `${name} is ${INDUSTRY_FIT[name]}`);
    }
    assert.equal(Object.hasOwn(INDUSTRY_FIT, 'Pest Control'), false);
    assert.equal(SERVICETITAN_PENALTY, -15);
    assert.ok(SERVICETITAN_PENALTY <= -12 && SERVICETITAN_PENALTY >= -18);
  });

  it('gives max size points to 25–200 reviews, the 2–15 truck proxy', () => {
    const pts = (n) => sizePoints(n)[0];
    assert.equal(pts(0), 2);
    assert.equal(pts(1), 6);
    assert.equal(pts(9), 6);
    assert.equal(pts(10), 14);
    assert.equal(pts(24), 14);
    assert.equal(pts(25), 25);
    assert.equal(pts(80), 25);
    assert.equal(pts(150), 25);
    assert.equal(pts(200), 25);
    assert.equal(pts(201), 18);
    assert.equal(pts(400), 18);
    assert.equal(pts(401), 11);
    assert.equal(pts(600), 11);
    assert.equal(pts(601), 6);
    assert.equal(pts(1500), 6);
    assert.equal(pts(1501), 2);
    assert.match(sizePoints(80)[1], /2–15 trucks/);
    // The old max ended at 150. 180 reviews is inside the new sweet spot.
    assert.equal(pts(180), 25);
    assert.equal(mainSize(180), 18);
  });

  it('keeps a Lehi HVAC shop with 80 reviews at tier A, above plumbing and landscaping', () => {
    const hvac = computeFit(lead('HVAC', { company: 'Lehi Heating' }));
    const plumbing = computeFit(lead('Plumbing', { company: 'Lehi Plumbing' }));
    const landscaping = computeFit(lead('Landscaping', { company: 'Lehi Lawns' }));
    const pest = computeFit(lead('Pest Control', { company: 'Lehi Pest' }));

    assert.equal(hvac.fit_tier, 'A');
    assert.equal(hvac.fit_score, 100);
    assert.equal(hvac.fit_reasons.find(r => r.label === 'Size').points, 25);
    assert.equal(hvac.fit_reasons.find(r => r.label === 'Location').detail.includes('Lehi'), true);

    assert.ok(plumbing.fit_tier === 'A' || plumbing.fit_tier === 'B');
    assert.equal(plumbing.fit_tier, 'A');
    assert.equal(plumbing.fit_score, 97);
    assert.ok(plumbing.fit_score < hvac.fit_score);

    assert.ok(landscaping.fit_score < hvac.fit_score);
    assert.equal(landscaping.fit_score, 77);
    assert.equal(landscaping.fit_tier, 'B');

    assert.equal(pest.fit_score, 0);
    assert.equal(pest.fit_tier, 'D');
    assert.equal(pest.fit_reasons[0].detail, 'Pest Control — out of scope');

    console.log('[beachhead] fit_reasons HVAC ' + JSON.stringify(hvac.fit_reasons));
    console.log('[beachhead] fit_reasons Landscaping ' + JSON.stringify(landscaping.fit_reasons));
  });

  it('penalizes cached ServiceTitan only, and does not force tier D', () => {
    const plain = computeFit(lead('HVAC', { company: 'Cache Heating' }));
    const st = computeFit(lead('HVAC', { company: 'Cache Heating', fsm_detected: 'ServiceTitan' }));
    const reason = st.fit_reasons.find(r => r.label === 'ServiceTitan');

    assert.ok(reason);
    assert.equal(reason.points, SERVICETITAN_PENALTY);
    assert.equal(reason.detail, ST_REASON);
    assert.equal(reason.detail, 'ServiceTitan detected — weaker fit for owned build');
    assert.equal(st.fit_score, plain.fit_score + SERVICETITAN_PENALTY);
    assert.equal(st.fit_score, 85);
    assert.equal(st.fit_tier, 'A');
    assert.notEqual(st.fit_tier, 'D');

    const cased = computeFit(lead('HVAC', { fsm_detected: ' servicetitan ' }));
    assert.equal(cased.fit_score, st.fit_score);

    for (const fsm of ['Jobber', 'Housecall Pro', 'none', null, '', 'Workiz']) {
      const fit = computeFit(lead('HVAC', { fsm_detected: fsm }));
      assert.equal(fit.fit_score, plain.fit_score, `no penalty for ${JSON.stringify(fsm)}`);
      assert.equal(fit.fit_reasons.some(r => r.label === 'ServiceTitan'), false, JSON.stringify(fsm));
    }

    // A thinner out-of-market HVAC shop lands in C after the penalty, not D.
    const marginal = computeFit(lead('HVAC', {
      company: 'Denver Heating',
      city: 'Denver',
      state: 'CO',
      review_count: 5,
      fsm_detected: 'ServiceTitan',
    }));
    assert.equal(marginal.fit_score, 55);
    assert.equal(marginal.fit_tier, 'C');
    assert.notEqual(marginal.fit_tier, 'D');

    // Pest stays a hard D even if research also cached ServiceTitan.
    const pest = computeFit(lead('exterminator', { fsm_detected: 'ServiceTitan' }));
    assert.equal(pest.fit_score, 0);
    assert.equal(pest.fit_tier, 'D');

    console.log('[beachhead] fit_reasons ST-HVAC ' + JSON.stringify(st.fit_reasons));
  });

  it('keeps the Places catalog at 20 or fewer, with HVAC and plumbing a majority', () => {
    const hvac = catalog.filter(row => row.industry === 'HVAC');
    const plumbing = catalog.filter(row => row.industry === 'Plumbing');
    assert.ok(catalog.length <= 20);
    assert.ok(catalog.length <= BEFORE_QUERIES.length);
    assert.equal(BEFORE_QUERIES.length, 20);
    assert.ok(hvac.length >= 5 && hvac.length <= 6);
    assert.ok(plumbing.length >= 3 && plumbing.length <= 4);
    assert.ok(hvac.length + plumbing.length > catalog.length / 2);
    assert.equal(catalog.filter(row => row.industry === 'Electrical').length, 1);
    assert.equal(catalog.filter(row => row.industry === 'Roofing').length, 1);
    assert.equal(catalog.filter(row => row.industry === 'Landscaping').length, 1);
    assert.ok(catalog.filter(row => row.industry === 'Cleaning').length <= 1);
    assert.ok(catalog.filter(row => row.industry === 'Painting').length <= 1);
    assert.ok(catalog.filter(row => row.industry === 'Construction').length <= 1);
    assert.equal(catalog.some(row => row.industry === 'Gutters' || row.industry === 'Windows'), false);
    assert.equal(catalog.some(row => /pest|exterminator|termite/i.test(`${row.query} ${row.industry}`)), false);
    assert.equal(INDUSTRIES.some(row => /pest|exterminator|termite/i.test(`${row.query} ${row.industry}`)), false);
    assert.equal(INDUSTRIES.length, catalog.length);

    for (const row of catalog) {
      assert.equal(row.score, INDUSTRY_FIT[row.industry], row.query);
    }

    const discoverSrc = fs.readFileSync(path.join(__dirname, '../src/bot/discover.js'), 'utf8');
    assert.match(discoverSrc, /TARGET_MARKETS \|\| 'Salt Lake City UT'/);
    assert.match(discoverSrc, /RESULTS_PER_QUERY \|\| '20'/);
    const example = fs.readFileSync(path.join(__dirname, '../.env.example'), 'utf8');
    assert.match(example, /TARGET_MARKETS=Salt Lake City UT,Provo UT,Ogden UT,Saratoga Springs UT/);
    assert.match(example, /RESULTS_PER_QUERY=20/);

    const configSrc = fs.readFileSync(path.join(__dirname, '../src/scoring/config.js'), 'utf8');
    assert.match(configSrc, /Saratoga Springs,Lehi,Eagle Mountain/);
    assert.match(configSrc, /Payson,Mapleton,Salem/);
    assert.match(configSrc, /FIT_HOME_STATE \|\| 'UT'/);
    assert.equal(HOME_STATE, 'UT');
    assert.equal(HOME_CITIES.includes('lehi'), true);
    assert.equal(HOME_CITIES.includes('provo'), true);
    assert.equal(HOME_CITIES.length, 35);

    const before = BEFORE_QUERIES.map(([query, industry]) => `${query} (${industry})`).join(' | ');
    const after = catalog.map(row => `${row.query} (${row.industry})`).join(' | ');
    console.log(`[beachhead] places queries before ${BEFORE_QUERIES.length}: ${before}`);
    console.log(`[beachhead] places queries after ${catalog.length}: ${after}`);
  });

  it('computeFit and rescore perform no fetch, including boot rescore', async () => {
    const fitSrc = fs.readFileSync(path.join(__dirname, '../src/scoring/fit.js'), 'utf8');
    const serverSrc = fs.readFileSync(path.join(__dirname, '../src/server.js'), 'utf8');
    assert.doesNotMatch(fitSrc, /axios|fetch\(|researchLead|google-places|https?:\/\//);
    assert.match(serverSrc, /await rescore\(\)/);
    assert.doesNotMatch(serverSrc, /researchLead|axios\.|fetch\(/);
    assert.match(fitSrc, /fsm_detected/);

    const row = await insertProspect({
      google_place_id: 'test-place-beachhead-st',
      company: 'Cached ST Heating',
      city: 'Lehi',
      review_count: 80,
      rating: 4.0,
      fsm_detected: 'ServiceTitan',
    });
    const guard = armNoFetch();
    try {
      const fit = computeFit({ ...row, fsm_detected: 'ServiceTitan' });
      assert.equal(fit.fit_score, 85);
      const n = await rescore([row.id]);
      assert.equal(n, 1);
      assert.deepEqual(guard.hits, []);
    } finally {
      guard.restore();
    }
    const saved = await pool.query(
      'SELECT fit_score, fit_tier, fit_reasons, fsm_detected FROM prospects WHERE id = $1',
      [row.id]
    );
    assert.equal(saved.rows[0].fsm_detected, 'ServiceTitan');
    assert.equal(saved.rows[0].fit_score, 85);
    assert.equal(saved.rows[0].fit_tier, 'A');
    assert.equal(saved.rows[0].fit_reasons.find(r => r.label === 'ServiceTitan').detail, ST_REASON);
  });

  it('persists ServiceTitan from mocked research HTML and ignores Jobber and Housecall Pro', async () => {
    await applySchema();
    await applySchema();
    const cols = await pool.query(
      `SELECT data_type FROM information_schema.columns
        WHERE table_name = 'prospects' AND column_name = 'fsm_detected'`
    );
    assert.equal(cols.rows.length, 1);
    assert.equal(cols.rows[0].data_type, 'text');

    const html = {
      st: '<html><script src="https://static.servicetitan.com/booking.js"></script><div class="st-scheduler"></div></html>',
      scheduler: '<html><div id="st-scheduler"></div></html>',
      jobber: '<html><script src="https://cdn.getjobber.com/widget.js"></script></html>',
      hcp: '<html><p>Powered by housecallpro scheduling</p></html>',
    };
    assert.equal(htmlHasServiceTitan(html.st), true);
    assert.equal(htmlHasServiceTitan(html.scheduler), true);
    assert.equal(htmlHasServiceTitan(html.jobber), false);
    assert.equal(detectSignals(html.scheduler, '').online_booking.includes('ServiceTitan scheduler'), true);
    assert.equal(fsmDetectedFromResearch({ site: { signals: detectSignals(html.st, '') } }), 'ServiceTitan');
    assert.equal(fsmDetectedFromResearch({ site: { signals: detectSignals(html.jobber, '') } }), 'Jobber');
    assert.equal(fsmDetectedFromResearch({ site: { signals: detectSignals(html.hcp, '') } }), 'Housecall Pro');
    assert.equal(fsmDetectedFromResearch({ site: { signals: {} } }), 'none');
    assert.equal(fsmDetectedFromResearch({}), null);

    const pages = {
      'https://st.example/': html.st,
      'https://scheduler.example/': html.scheduler,
      'https://jobber.example/': html.jobber,
      'https://hcp.example/': html.hcp,
    };
    const calls = [];
    const originalGet = axios.get;
    axios.get = async (url) => {
      const key = String(url);
      calls.push(key);
      assert.equal(key.includes('places.googleapis.com'), false);
      assert.equal(key.includes('api.anthropic.com'), false);
      const body = pages[key];
      assert.ok(body, key);
      return {
        data: body,
        headers: { 'content-type': 'text/html' },
        request: { res: { responseUrl: key } },
      };
    };
    _setClient(fakeClaude());
    try {
      const specs = [
        ['test-place-research-st', 'https://st.example/', 'ServiceTitan', 85],
        ['test-place-research-sched', 'https://scheduler.example/', 'ServiceTitan', 85],
        ['test-place-research-jobber', 'https://jobber.example/', 'Jobber', 100],
        ['test-place-research-hcp', 'https://hcp.example/', 'Housecall Pro', 100],
      ];
      for (const [placeId, website, fsm, score] of specs) {
        const row = await insertProspect({
          google_place_id: placeId,
          company: placeId,
          city: 'Lehi',
          website,
          email: null,
          contact_name: null,
          review_count: 80,
          rating: 4.0,
        });
        await draftProposal(row.id);
        const saved = await pool.query(
          'SELECT fsm_detected, fit_score, fit_tier, fit_reasons FROM prospects WHERE id = $1',
          [row.id]
        );
        assert.equal(saved.rows[0].fsm_detected, fsm, placeId);
        assert.equal(saved.rows[0].fit_score, score, placeId);
        assert.notEqual(saved.rows[0].fit_tier, 'D', placeId);
        const tagged = saved.rows[0].fit_reasons.some(r => r.label === 'ServiceTitan');
        assert.equal(tagged, fsm === 'ServiceTitan', placeId);
      }
      assert.equal(calls.length, 4);
    } finally {
      axios.get = originalGet;
      _setClient(null);
    }
  });

  it('raises the tier A HVAC/plumbing share versus main on a disposable seed', async () => {
    await resetDb();
    const sharePlan = [
      ['HVAC', 5],
      ['Plumbing', 5],
      ['Electrical', 2],
      ['Roofing', 2],
      ['Landscaping', 4],
      ['Cleaning', 3],
      ['Painting', 3],
      ['Gutters', 1],
      ['Windows', 1],
      ['Construction', 2],
      ['Pest Control', 2],
    ];
    const shareRows = [];
    let n = 0;
    for (const [industry, count] of sharePlan) {
      for (let i = 0; i < count; i++) {
        n += 1;
        const row = await insertProspect({
          google_place_id: `test-place-gate-${n}`,
          company: `Gate ${industry} ${i}`,
          industry,
          city: 'Lehi',
          state: 'UT',
          website: 'https://gate.example',
          phone: '(801) 555-0190',
          rating: 4.0,
          review_count: 80,
          fsm_detected: null,
        });
        shareRows.push(row);
      }
    }
    const stRows = [];
    for (let i = 0; i < 6; i++) {
      stRows.push(await insertProspect({
        google_place_id: `test-place-gate-st-${i}`,
        company: `Gate ST HVAC ${i}`,
        industry: 'HVAC',
        city: 'Lehi',
        state: 'UT',
        website: 'https://gate-st.example',
        phone: '(801) 555-0191',
        rating: 4.0,
        review_count: 80,
        fsm_detected: 'ServiceTitan',
      }));
    }

    const guard = armNoFetch();
    try {
      await rescore();
      assert.deepEqual(guard.hits, []);
    } finally {
      guard.restore();
    }

    const { rows } = await pool.query(
      'SELECT id, industry, fsm_detected, fit_score, fit_tier FROM prospects ORDER BY id'
    );
    const byId = new Map(rows.map(row => [row.id, row]));

    const scored = shareRows.map(row => {
      const saved = byId.get(row.id);
      const now = computeFit(row);
      const main = mainScore(row);
      assert.equal(saved.fit_score, now.fit_score);
      assert.equal(saved.fit_tier, now.fit_tier);
      assert.equal(saved.fsm_detected, null);
      return { industry: row.industry, tier: now.fit_tier, mainTier: main.fit_tier, now: now.fit_score, main: main.fit_score };
    });

    const beach = ['HVAC', 'Plumbing'];
    const weak = ['Landscaping', 'Cleaning', 'Painting'];
    const nowBeach = aShare(scored.map(row => ({ industry: row.industry, tier: row.tier })), beach);
    const mainBeach = aShare(scored.map(row => ({ industry: row.industry, tier: row.mainTier })), beach);
    const nowWeak = aShare(scored.map(row => ({ industry: row.industry, tier: row.tier })), weak);
    const mainWeak = aShare(scored.map(row => ({ industry: row.industry, tier: row.mainTier })), weak);

    assert.ok(nowBeach.pct > mainBeach.pct);
    assert.ok(nowWeak.pct < mainWeak.pct);
    assert.equal(nowWeak.hit, 0);

    const stNow = stRows.map(row => byId.get(row.id).fit_score);
    const stMain = stRows.map(row => mainScore(row).fit_score);
    assert.ok(median(stNow) < median(stMain));
    assert.equal(median(stMain), 97);
    assert.equal(median(stNow), 85);
    for (const row of stRows) {
      assert.notEqual(byId.get(row.id).fit_tier, 'D');
    }
    const stReasons = await pool.query(
      'SELECT fit_reasons FROM prospects WHERE google_place_id = $1',
      ['test-place-gate-st-0']
    );
    assert.equal(
      stReasons.rows[0].fit_reasons.some(r => r.detail === 'ServiceTitan detected — weaker fit for owned build'),
      true
    );

    const pct = (share) => `${(share.pct * 100).toFixed(1)}% (${share.hit}/${share.of})`;
    console.log(`[beachhead] tier A HVAC+Plumbing share: main ${pct(mainBeach)} -> now ${pct(nowBeach)}`);
    console.log(`[beachhead] tier A Landscaping/Cleaning/Painting share: main ${pct(mainWeak)} -> now ${pct(nowWeak)}`);
    console.log(`[beachhead] cached ServiceTitan median fit_score: main ${median(stMain)} -> now ${median(stNow)}`);
    console.log(`[beachhead] places query_count: ${BEFORE_QUERIES.length} -> ${catalog.length}`);
  });
});
