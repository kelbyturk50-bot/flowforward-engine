process.env.CRM_API_KEY = 'test-brand-rubric-key-32chars-ok!!';

require('./preload');

// Brand v1 and the prototype rubric. Disposable Postgres, static TEST fixtures,
// and manual entry. Nothing here fetches a logo or resolves DNS.

const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawn, spawnSync } = require('child_process');
const express = require('express');
const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const { BRAND_FIXTURES } = require('../src/brand/fixtures');
const { validateBrand } = require('../src/brand/validate');
const { RUBRIC, rubricRows } = require('../src/scoring/prototypes.config');
const { FRANCHISE_PATTERNS, EXCLUDED_INDUSTRIES } = require('../src/scoring/config');
const {
  pickPrototypes,
  recommendPrototypes,
  hoursClosedEvenings,
  beachheadRank,
  compareBeachhead,
  comparePrototypeRank,
} = require('../src/scoring/prototypes');
const { loadRubric } = require('../src/scoring/rubric-store');
const { computeFit } = require('../src/scoring/fit');
const { applyMainSchema, applyBrandConstraints } = require('../src/db/migrate');
const { resetDb, insertProspect, seedBrandFixtures, closePool, pool } = require('./fixtures');

const ROOT = path.join(__dirname, '..');

function shop(overrides = {}) {
  return {
    company: 'TEST: Sample Heating',
    industry: 'HVAC',
    website: 'https://sample.example',
    state: 'UT',
    city: 'Provo',
    rating: 4.6,
    review_count: 80,
    fsm_detected: 'none',
    research: {
      signals: {
        mentions: {
          free_estimates: false,
          financing: false,
          maintenance_plan: false,
          emergency_24_7: true,
          online_booking_language: true,
        },
        online_booking: ['Calendly'],
        chat_or_text_widget: ['Podium'],
        reviews_tools: ['NiceJob'],
      },
      reviews: [],
      place: { hours: ['Monday: 8:00 AM – 8:00 PM'] },
    },
    ...overrides,
  };
}

function estimateShop(overrides = {}) {
  return shop({
    research: {
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
    },
    ...overrides,
  });
}

function topAgent(prospect, rubric) {
  const picks = pickPrototypes(prospect, rubric);
  return picks[0] ? picks[0].agent : null;
}

function runBrandGuard(args) {
  return spawnSync(process.execPath, [path.join(__dirname, 'brand-network-guard.js'), ...args], {
    encoding: 'utf8',
    env: process.env,
    timeout: 20000,
  });
}

function request(port, method, reqPath, body) {
  return new Promise((resolve, reject) => {
    const payload = body == null ? null : Buffer.from(JSON.stringify(body));
    const headers = { accept: 'application/json' };
    if (payload) {
      headers['content-type'] = 'application/json';
      headers['content-length'] = String(payload.length);
    }
    if (process.env.CRM_API_KEY) headers['x-api-key'] = process.env.CRM_API_KEY;
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path: reqPath,
      method,
      headers,
    }, (res) => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = text ? JSON.parse(text) : null; } catch { json = { raw: text }; }
        resolve({ status: res.statusCode, json });
      });
    });
    req.on('error', reject);
    if (payload) req.end(payload);
    else req.end();
  });
}

describe('brand extract and prototype rubric', { concurrency: false }, () => {
  after(() => closePool());

  it('rejects bad colors and any logo URL that is not https without userinfo', () => {
    const good = {
      name: 'TEST: Wasatch Heating',
      logoUrl: null,
      colors: ['#1B4F72', '#abc'],
      source: 'manual',
      testTag: 'TEST:wasatch-heating',
    };
    const parsed = validateBrand(good);
    assert.equal(parsed.ok, true);
    assert.deepEqual(parsed.brand.colors, ['#1b4f72', '#aabbcc']);
    assert.equal(parsed.brand.logoUrl, null);

    const badColors = ['red', '#gg0000', '#12345', '#1234', '#1234567', '1b4f72', 'rgb(0,0,0)', '', '#aabbccdd'];
    for (const color of badColors) {
      const result = validateBrand({ ...good, colors: [color] });
      assert.equal(result.ok, false, color);
      assert.equal(result.field, 'colors', color);
    }
    assert.equal(validateBrand({ ...good, colors: ' #1b4f72' }).ok, false);

    const badUrls = [
      'javascript:alert(1)',
      'JavaScript:alert(1)',
      '  javascript:alert(1)',
      'data:text/html,hi',
      'DATA:text/plain,x',
      'file:///tmp/logo.png',
      'ftp://fixtures.example/logo.png',
      'https://user:pass@fixtures.example/logo.png',
      'https://user@fixtures.example/logo.png',
      '//fixtures.example/logo.png',
      'fixtures.example/logo.png',
      'http://',
      'http://fixtures.example/logo.png',
      'HTTP://fixtures.example/logo.png',
      'http://ok.example/a.png',
    ];
    for (const logoUrl of badUrls) {
      const result = validateBrand({ ...good, logoUrl });
      assert.equal(result.ok, false, logoUrl);
      assert.equal(result.field, 'logoUrl', logoUrl);
    }

    const httpsLogo = validateBrand({ ...good, logoUrl: 'HTTPS://Fixtures.Example/test-logo.png' });
    assert.equal(httpsLogo.ok, true);
    assert.equal(httpsLogo.brand.logoUrl, 'https://fixtures.example/test-logo.png');
    const cssBreaks = [
      'https://fixtures.example/);background:url(https://evil.example)',
      'https://fixtures.example/");background:url(https://evil.example)',
      "https://fixtures.example/');background:url(https://evil.example)",
      'https://fixtures.example/logo.png);background:url(https://evil.example)',
      'https://fixtures.example/a b.png',
      'https://fixtures.example/a\\b.png',
      'https://fixtures.example/a;b.png',
      'https://fixtures.example/<logo>.png',
    ];
    for (const logoUrl of cssBreaks) {
      const result = validateBrand({ ...good, logoUrl });
      assert.equal(result.ok, false, logoUrl);
      assert.equal(result.field, 'logoUrl', logoUrl);
    }
    const hostileNames = [
      'TEST: <script>',
      'TEST: >',
      'TEST:\u0000Heating',
      'TEST:\u202Eevil',
      'TEST:\u2066evil',
      'TEST:\u200B\u200B',
      'TEST:\uFEFFHeating',
      'TEST:   ',
      'TEST: \t ',
      'TEST: 801-555-1234',
      'TEST: (801) 555-1234',
      'TEST: 801.555.1234',
    ];
    for (const name of hostileNames) {
      const result = validateBrand({ ...good, name });
      assert.equal(result.ok, false, JSON.stringify(name));
      assert.equal(result.field, 'name', JSON.stringify(name));
    }
    assert.equal(validateBrand({ ...good, name: 'TEST: A' }).ok, true);
    assert.equal(validateBrand({ ...good, name: 'Wasatch Heating' }).ok, false);
    assert.equal(validateBrand({ ...good, name: 'TEST: owner@shop.example' }).ok, false);
    assert.equal(validateBrand({ ...good, testTag: 'wasatch' }).ok, false);
    assert.equal(validateBrand({ ...good, source: 'fetch' }).ok, false);
    for (const fixture of BRAND_FIXTURES) {
      assert.equal(validateBrand(fixture).ok, true, fixture.testTag);
      assert.equal(fixture.name.startsWith('TEST:'), true);
      assert.equal(JSON.stringify(fixture).includes('@'), false);
    }
  });

  it('maps each signal fixture to the agent Scout specified', () => {
    assert.equal(topAgent(estimateShop()), 'estimate_followup');
    const estimate = pickPrototypes(estimateShop());
    assert.equal(estimate[0].score, 95);
    assert.equal(estimate[0].reasons.find(reason => reason.signal === 'free_estimate').gap, false);
    assert.equal(estimate[0].reasons.find(reason => reason.signal === 'rv_slow_quote').gap, true);
    assert.ok(estimate.length <= RUBRIC.maxPicks);

    const speed = pickPrototypes(shop({
      research: {
        signals: {
          mentions: {
            free_estimates: false,
            financing: false,
            maintenance_plan: false,
            emergency_24_7: true,
            online_booking_language: false,
          },
          reviews_tools: ['NiceJob'],
        },
        reviews: [{ text: 'Called twice and got no answer' }],
        place: { hours: ['Monday: 8:00 AM – 8:00 PM'] },
      },
    }));
    assert.equal(speed[0].agent, 'speed_to_lead');
    assert.equal(speed[0].score, 85);
    assert.deepEqual(speed.map(row => row.agent), ['speed_to_lead', 'receptionist']);

    const receptionist = pickPrototypes(shop({
      website: null,
      research: {
        signals: {
          mentions: {
            free_estimates: false,
            financing: false,
            maintenance_plan: false,
            emergency_24_7: false,
            online_booking_language: false,
          },
          reviews_tools: ['NiceJob'],
        },
        reviews: [{ text: 'no answer at the office and then a no-show' }],
        place: { hours: ['Monday: 8:00 AM – 5:00 PM'] },
      },
    }));
    assert.equal(receptionist[0].agent, 'receptionist');
    assert.equal(receptionist[0].score, 90);

    const scheduling = pickPrototypes(shop({
      research: {
        signals: {
          mentions: {
            free_estimates: false,
            financing: false,
            maintenance_plan: false,
            emergency_24_7: true,
            online_booking_language: false,
          },
          chat_or_text_widget: ['Podium'],
          reviews_tools: ['NiceJob'],
        },
        reviews: [{ text: 'It was hard to schedule a visit' }],
        place: { hours: ['Monday: 8:00 AM – 8:00 PM'] },
      },
    }));
    assert.equal(scheduling[0].agent, 'scheduling');
    assert.equal(scheduling[0].score, 75);

    const reviews = pickPrototypes(shop({
      review_count: 50,
      rating: 4.8,
      research: {
        signals: {
          mentions: {
            free_estimates: false,
            financing: false,
            maintenance_plan: false,
            emergency_24_7: true,
            online_booking_language: true,
          },
          online_booking: ['Calendly'],
          chat_or_text_widget: ['Podium'],
        },
        reviews: [],
        place: { hours: ['Monday: 8:00 AM – 8:00 PM'] },
      },
    }));
    assert.equal(reviews[0].agent, 'review_requests');
    assert.equal(reviews[0].score, 65);
    assert.equal(reviews.length, 1);

    const maint = pickPrototypes(shop({
      fsm_detected: 'Jobber',
      research: {
        signals: {
          mentions: {
            free_estimates: false,
            financing: false,
            maintenance_plan: true,
            emergency_24_7: true,
            online_booking_language: true,
          },
          online_booking: ['Calendly'],
          chat_or_text_widget: ['Podium'],
          reviews_tools: ['NiceJob'],
        },
        reviews: [],
        place: { hours: ['Monday: 8:00 AM – 8:00 PM'] },
      },
    }));
    assert.equal(maint[0].agent, 'maint_renewal');
    assert.equal(maint[0].score, 65);

    const dispatch = pickPrototypes(shop({
      review_count: 250,
      rating: 4.0,
      research: {
        signals: {
          mentions: {
            free_estimates: false,
            financing: false,
            maintenance_plan: false,
            emergency_24_7: true,
            online_booking_language: true,
          },
          online_booking: ['Calendly'],
          chat_or_text_widget: ['Podium'],
          reviews_tools: ['NiceJob'],
        },
        reviews: [{ text: 'The tech showed up late and had to reschedule' }],
        place: { hours: ['Monday: 8:00 AM – 8:00 PM'] },
      },
    }));
    assert.equal(dispatch[0].agent, 'dispatch');
    assert.equal(dispatch[0].score, 45);

    const silent = [
      { text: 'On time' },
      { text: 'Fair price' },
      { text: 'Nice crew' },
      { text: 'Would call again' },
      { text: 'Solid install' },
      { text: 'They never followed up on my estimate' },
    ];
    const ignored = pickPrototypes(estimateShop({
      research: {
        ...estimateShop().research,
        reviews: silent,
      },
    }));
    assert.equal(ignored[0].reasons.some(reason => reason.signal === 'rv_slow_quote'), false);

    const lender = pickPrototypes(shop({
      research: {
        signals: {
          mentions: {
            free_estimates: false,
            financing: false,
            maintenance_plan: false,
            emergency_24_7: true,
            online_booking_language: true,
          },
          financing: ['Wisetack'],
          online_booking: ['Calendly'],
          chat_or_text_widget: ['Podium'],
          reviews_tools: ['NiceJob'],
        },
        reviews: [],
        place: { hours: ['Monday: 8:00 AM – 8:00 PM'] },
      },
    }));
    assert.equal(lender[0].agent, 'estimate_followup');
    assert.equal(lender[0].reasons.some(reason => reason.signal === 'financing'), true);
  });

  it('returns no prototype for an empty cache, pest, franchise, ServiceTitan block, or a tie', () => {
    assert.deepEqual(pickPrototypes(null), []);
    assert.deepEqual(pickPrototypes({}), []);
    assert.doesNotThrow(() => recommendPrototypes({ company: 'TEST: Empty Cache', industry: 'HVAC', state: 'UT' }));
    const empty = recommendPrototypes({
      company: 'TEST: Empty Cache',
      industry: 'HVAC',
      state: 'UT',
      review_count: 80,
      research: {},
    });
    assert.deepEqual(empty.picks, []);
    assert.equal(empty.disqualified, 'below_min');

    assert.deepEqual(pickPrototypes(estimateShop({ industry: 'Termite Control' })), []);
    assert.equal(recommendPrototypes(estimateShop({ industry: 'Pest Control' })).disqualified, 'pest');
    assert.equal(
      recommendPrototypes(estimateShop({ company: 'Service Experts Utah' })).disqualified,
      'franchise'
    );
    assert.equal(
      recommendPrototypes(estimateShop({ company: 'TEST: One Hour Heating' })).disqualified,
      'franchise'
    );
    assert.equal(
      recommendPrototypes(estimateShop({ company: 'TEST: Trane Heating' })).disqualified,
      'franchise'
    );
    assert.equal(recommendPrototypes(estimateShop({ company: 'TEST: Constrane Heating' })).disqualified, null);
    assert.equal(topAgent(estimateShop({ company: 'TEST: Constrane Heating' })), 'estimate_followup');
    assert.equal(recommendPrototypes(estimateShop({ company: 'TEST: Carriero HVAC' })).disqualified, null);
    assert.equal(topAgent(estimateShop({ company: 'TEST: Carriero HVAC' })), 'estimate_followup');
    assert.equal(recommendPrototypes(estimateShop({ state: 'CO' })).disqualified, 'out_of_state');
    assert.equal(recommendPrototypes(estimateShop({ state: 'Utah' })).disqualified, null);
    assert.equal(topAgent(estimateShop({ state: 'Utah' })), 'estimate_followup');
    assert.equal(topAgent(estimateShop({ state: 'utah' })), 'estimate_followup');
    assert.equal(recommendPrototypes(estimateShop({ state: '' })).disqualified, 'unknown_state');
    assert.equal(recommendPrototypes(estimateShop({ state: null })).disqualified, 'unknown_state');
    assert.deepEqual(pickPrototypes(estimateShop({ state: '   ' })), []);
    assert.equal(beachheadRank({ industry: 'HVAC' }) < beachheadRank({ industry: 'Plumbing' }), true);
    assert.equal(beachheadRank({ industry: 'Plumbing' }) < beachheadRank({ industry: 'Electrical' }), true);
    assert.ok(compareBeachhead(
      { industry: 'HVAC', company: 'TEST: B' },
      { industry: 'Plumbing', company: 'TEST: A' },
    ) < 0);
    assert.equal(topAgent(estimateShop({ company: 'TEST: Best Heating' })), 'estimate_followup');

    const hvac = pickPrototypes(estimateShop());
    const plumbing = pickPrototypes(estimateShop({
      company: 'TEST: Canyon Plumbing',
      industry: 'Plumbing',
    }));
    assert.equal(plumbing[0].agent, 'estimate_followup');
    assert.equal(hvac[0].score - plumbing[0].score, 10);

    const st = pickPrototypes(shop({
      fsm_detected: 'ServiceTitan',
      research: {
        signals: {
          mentions: {
            free_estimates: true,
            financing: true,
            maintenance_plan: false,
            emergency_24_7: false,
            online_booking_language: false,
          },
        },
        reviews: [{ text: 'no answer, and they never followed up on the quote' }],
        place: { hours: ['Monday: 8:00 AM – 5:00 PM'] },
      },
    }));
    assert.deepEqual(st.map(row => row.agent), ['estimate_followup', 'review_requests']);
    assert.equal(st[0].score, 90);
    assert.equal(st.some(row => row.agent === 'receptionist'), false);

    const flat = estimateShop();
    const nested = estimateShop({
      research: {
        site: { signals: flat.research.signals },
        google: { reviews: flat.research.reviews, hours: flat.research.place.hours },
      },
    });
    assert.deepEqual(pickPrototypes(flat), pickPrototypes(nested));

    const tied = pickPrototypes(shop(), {
      version: 1,
      minScore: 40,
      maxPicks: 2,
      neverAutoPick: ['bookkeeping'],
      serviceTitanAllow: ['estimate_followup', 'review_requests'],
      gapSignals: [],
      agents: {
        speed_to_lead: { tieRank: 1, costTier: 1, points: { hvac: 50 } },
        estimate_followup: { tieRank: 9, costTier: 1, points: { hvac: 50 } },
      },
    });
    assert.deepEqual(tied.map(row => row.agent), ['estimate_followup', 'speed_to_lead']);

    const stSignals = {
      signals: {
        mentions: {
          free_estimates: true,
          financing: true,
          maintenance_plan: false,
          emergency_24_7: false,
          online_booking_language: false,
        },
        field_service_software: ['ServiceTitan'],
        online_booking: ['ServiceTitan Scheduler'],
      },
      reviews: [{ text: 'no answer, and they never followed up on the quote' }],
      place: { hours: ['Monday: 8:00 AM – 5:00 PM'] },
    };
    const columnWins = pickPrototypes(shop({ fsm_detected: 'Jobber', research: stSignals }));
    assert.equal(columnWins[0].agent, 'estimate_followup');
    assert.equal(columnWins[1].agent, 'speed_to_lead');
    const noneWins = pickPrototypes(shop({ fsm_detected: 'none', research: stSignals }));
    assert.equal(noneWins[1].agent, 'speed_to_lead');
    const signalOnly = pickPrototypes(shop({ fsm_detected: null, research: stSignals }));
    assert.deepEqual(signalOnly.map(row => row.agent), ['estimate_followup', 'review_requests']);

    const costTie = pickPrototypes(shop(), {
      version: 1,
      minScore: 40,
      maxPicks: 2,
      neverAutoPick: [],
      serviceTitanAllow: ['estimate_followup', 'review_requests'],
      gapSignals: [],
      agents: {
        receptionist: { tieRank: 1, costTier: 3, points: { hvac: 50 } },
        scheduling: { tieRank: 9, costTier: 2, points: { hvac: 50 } },
      },
    });
    assert.deepEqual(costTie.map(row => row.agent), ['scheduling', 'receptionist']);
    const tieRankOnly = comparePrototypeRank(
      { agent: 'speed_to_lead', score: 50, estimateFirst: 1, costTier: 1, ownIt: 0, tieRank: 2 },
      { agent: 'review_requests', score: 50, estimateFirst: 1, costTier: 1, ownIt: 0, tieRank: 1 },
    );
    assert.ok(tieRankOnly > 0);

    const books = pickPrototypes(shop(), {
      version: 1,
      minScore: 40,
      maxPicks: 2,
      neverAutoPick: ['bookkeeping'],
      serviceTitanAllow: ['estimate_followup', 'review_requests'],
      gapSignals: [],
      agents: {
        bookkeeping: { tieRank: 1, points: { hvac: 100 } },
        estimate_followup: { tieRank: 2, points: { hvac: 40 } },
      },
    });
    assert.deepEqual(books.map(row => row.agent), ['estimate_followup']);

    assert.equal(hoursClosedEvenings(['Monday: 8:00 AM – 5:00 PM']), true);
    assert.equal(hoursClosedEvenings(['Monday: 8:00 AM – 8:00 PM']), false);
    assert.equal(hoursClosedEvenings(['Monday: Open 24 hours']), false);
    assert.equal(hoursClosedEvenings(null), null);

    const catalog = require('../src/bot/industries');
    assert.equal(catalog.length, 16);
    assert.ok(catalog.length <= 20);
    const beachhead = catalog.filter(row => row.industry === 'HVAC' || row.industry === 'Plumbing');
    assert.ok(beachhead.length > catalog.length / 2);
    assert.equal(computeFit({
      company: 'Provo Plumbing',
      industry: 'Plumbing',
      website: 'https://provoplumbing.example',
      phone: '(801) 555-0140',
      city: 'Provo',
      state: 'UT',
      rating: 4.0,
      review_count: 80,
      fit_boost: 0,
    }).fit_score, 97);
  });

  it('applies Scout tie-breaks and config disqualifiers', () => {
    const equal = {
      version: 1,
      minScore: 40,
      maxPicks: 2,
      neverAutoPick: [],
      serviceTitanAllow: ['estimate_followup', 'review_requests'],
      gapSignals: [],
    };
    const prospects = [
      { industry: 'Electrical', company: 'TEST: E' },
      { industry: 'Plumbing', company: 'TEST: P' },
      { industry: 'HVAC', company: 'TEST: H' },
    ].sort(compareBeachhead);
    assert.deepEqual(prospects.map(row => row.industry), ['HVAC', 'Plumbing', 'Electrical']);
    assert.deepEqual(RUBRIC.prospectBeachhead, ['HVAC', 'Plumbing']);

    const ownIt = pickPrototypes(shop({ fsm_detected: 'Jobber' }), {
      ...equal,
      agents: {
        receptionist: { tieRank: 3, costTier: 2, points: { hvac: 50 } },
        scheduling: { tieRank: 3, costTier: 2, points: { hvac: 50 } },
      },
    });
    assert.deepEqual(ownIt.map(row => row.agent), ['scheduling', 'receptionist']);
    const housecall = pickPrototypes(shop({ fsm_detected: 'Housecall Pro' }), {
      ...equal,
      agents: {
        receptionist: { tieRank: 3, costTier: 2, points: { hvac: 50 } },
        scheduling: { tieRank: 3, costTier: 2, points: { hvac: 50 } },
      },
    });
    assert.deepEqual(housecall.map(row => row.agent), ['receptionist', 'scheduling']);
    assert.deepEqual(RUBRIC.ownItBundled.jobber, ['receptionist']);
    assert.deepEqual(
      Object.fromEntries(Object.entries(RUBRIC.agents).map(([name, spec]) => [name, spec.costTier])),
      {
        estimate_followup: 1,
        speed_to_lead: 1,
        review_requests: 1,
        scheduling: 2,
        maint_renewal: 2,
        dispatch: 2,
        bookkeeping: 2,
        receptionist: 3,
      },
    );
    const maintVsReview = pickPrototypes(shop(), {
      ...equal,
      agents: {
        maint_renewal: { tieRank: 1, costTier: 2, points: { hvac: 50 } },
        review_requests: { tieRank: 9, costTier: 1, points: { hvac: 50 } },
      },
    });
    assert.deepEqual(maintVsReview.map(row => row.agent), ['review_requests', 'maint_renewal']);
    const missing = recommendPrototypes(estimateShop({ state: undefined }));
    assert.deepEqual(missing.picks, []);
    assert.equal(missing.disqualified, 'unknown_state');
    for (const state of ['', '  ', '\t', ' \n ']) {
      const blank = recommendPrototypes(estimateShop({ state }));
      assert.deepEqual(blank.picks, [], JSON.stringify(state));
      assert.equal(blank.disqualified, 'unknown_state', JSON.stringify(state));
    }
    const parked = recommendPrototypes(estimateShop({ state: 'CO' }));
    assert.deepEqual(parked.picks, []);
    assert.equal(parked.disqualified, 'out_of_state');

    assert.equal(RUBRIC.disqualify.franchisePatterns, FRANCHISE_PATTERNS);
    assert.equal(RUBRIC.disqualify.industries, EXCLUDED_INDUSTRIES);
    assert.deepEqual(RUBRIC.disqualify.inState, ['UT', 'Utah']);
    assert.equal(
      recommendPrototypes(estimateShop({ company: 'TEST: Carrier Air' })).disqualified,
      'franchise'
    );
    assert.equal(
      recommendPrototypes(estimateShop({ company: 'Mr. Rooter Plumbing' })).disqualified,
      'franchise'
    );

    const moved = {
      ...RUBRIC,
      disqualify: {
        industries: ['Roofing'],
        franchisePatterns: ['acme'],
        inState: ['CO', 'Colorado'],
      },
    };
    assert.equal(recommendPrototypes(estimateShop({ industry: 'Roofing' }), moved).disqualified, 'pest');
    assert.equal(recommendPrototypes(estimateShop({ industry: 'Pest Control', state: 'CO' }), moved).disqualified, null);
    assert.equal(
      recommendPrototypes(estimateShop({ company: 'TEST: Acme Heating', state: 'CO' }), moved).disqualified,
      'franchise'
    );
    assert.equal(
      recommendPrototypes(estimateShop({ company: 'TEST: Trane Heating', state: 'Colorado' }), moved).disqualified,
      null
    );
    assert.equal(recommendPrototypes(estimateShop({ state: 'UT' }), moved).disqualified, 'out_of_state');
    assert.equal(topAgent(estimateShop({ state: 'colorado' }), moved), 'estimate_followup');
  });

  it('seeds TEST fixtures and a rubric table that matches the config', async () => {
    const boot = await pool.query('SELECT COUNT(*)::int AS n FROM prospect_brands');
    assert.equal(boot.rows[0].n, 0);
    await seedBrandFixtures();
    const brands = await pool.query(
      `SELECT name, logo_url, colors, source, test_tag
         FROM prospect_brands
        WHERE source = 'fixture'
        ORDER BY test_tag`
    );
    assert.deepEqual(brands.rows, [
      {
        name: 'TEST: Canyon Plumbing',
        logo_url: 'https://fixtures.example/test-canyon-logo.png',
        colors: ['#0e4d3a', '#e8f0ec'],
        source: 'fixture',
        test_tag: 'TEST:canyon-plumbing',
      },
      {
        name: 'TEST: Wasatch Heating',
        logo_url: null,
        colors: ['#1b4f72', '#f4d03f'],
        source: 'fixture',
        test_tag: 'TEST:wasatch-heating',
      },
    ]);

    const loaded = await loadRubric(pool);
    assert.equal(loaded.version, RUBRIC.version);
    assert.equal(loaded.minScore, 40);
    assert.equal(loaded.maxPicks, 2);
    assert.deepEqual(loaded.neverAutoPick, ['bookkeeping']);
    assert.deepEqual(loaded.serviceTitanAllow, ['estimate_followup', 'review_requests']);
    assert.equal(loaded.spec, 'docs/PROTOTYPE_PLAY.md');
    const expected = rubricRows();
    assert.equal(loaded.rows.length, expected.length);
    const got = new Map(loaded.rows.map(row => [`${row.agent}:${row.signal}`, row]));
    for (const row of expected) {
      const found = got.get(`${row.agent}:${row.signal}`);
      assert.ok(found, `${row.agent}:${row.signal}`);
      assert.equal(found.points, row.points);
      assert.equal(found.tieRank, row.tieRank);
      assert.equal(found.gap, row.gap);
    }
    assert.deepEqual(pickPrototypes(estimateShop(), loaded), pickPrototypes(estimateShop()));
  });

  it('manual entry stores a TEST brand and lookup does not fetch or call DNS', async () => {
    await resetDb();
    const watchedFiles = [
      'src/brand/fixtures.js',
      'src/brand/validate.js',
      'src/api/brands.js',
      'src/api/rubric.js',
      'src/scoring/prototypes.js',
      'src/scoring/prototypes.config.js',
      'src/scoring/rubric-store.js',
    ];
    const banned = /safeFetch|axios|places\.googleapis|api\.anthropic|from\s+['"](?:node:)?dns|require\(['"](?:node:)?(?:dns|https?|net|tls|child_process|undici)|(?:https?|net|tls)\.(?:request|get|connect)|undici|child_process/;
    for (const file of watchedFiles) {
      const text = fs.readFileSync(path.join(ROOT, file), 'utf8');
      assert.equal(banned.test(text), false, file);
    }
    const serverSrc = fs.readFileSync(path.join(ROOT, 'src/server.js'), 'utf8');
    assert.match(serverSrc, /app\.use\('\/api\/brands'/);
    assert.match(serverSrc, /app\.use\('\/api\/rubric'/);

    const app = express();
    app.use(express.json());
    app.use('/api', require('../src/api/auth'));
    app.use('/api/brands', require('../src/api/brands'));
    app.use('/api/rubric', require('../src/api/rubric'));
    const server = http.createServer(app);
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    try {
      await pool.query('SELECT 1');

      const bad = await request(port, 'POST', '/api/brands', {
        name: 'TEST: Rejected Color',
        logoUrl: 'javascript:alert(1)',
        colors: ['#gg0000'],
        testTag: 'TEST:rejected-color',
        source: 'fetch',
      });
      assert.equal(bad.status, 400);
      assert.equal(bad.json.error, 'invalid_brand');

      const userinfo = await request(port, 'POST', '/api/brands', {
        name: 'TEST: Userinfo Logo',
        logoUrl: 'https://user:pass@fixtures.example/logo.png',
        colors: ['#112233'],
        testTag: 'TEST:userinfo-logo',
      });
      assert.equal(userinfo.status, 400);
      assert.equal(userinfo.json.field, 'logoUrl');

      const httpLogo = await request(port, 'POST', '/api/brands', {
        name: 'TEST: Http Logo',
        logoUrl: 'http://fixtures.example/logo.png',
        colors: ['#112233'],
        testTag: 'TEST:http-logo',
      });
      assert.equal(httpLogo.status, 400);
      assert.equal(httpLogo.json.field, 'logoUrl');

      const lead = await insertProspect({
        google_place_id: 'test-place-brand-manual',
        company: 'TEST: Manual Heating',
        industry: 'HVAC',
        website: 'https://manual.example',
        phone: null,
        address: null,
        city: 'Provo',
        state: 'UT',
        rating: 4.6,
        review_count: 80,
        fsm_detected: 'none',
        email: null,
        contact_name: null,
      });
      await pool.query('UPDATE prospects SET research = $2::jsonb WHERE id = $1', [
        lead.id,
        JSON.stringify(estimateShop().research),
      ]);

      const plain = await insertProspect({
        google_place_id: 'test-place-brand-plain',
        company: 'Plain Heating',
        phone: null,
        address: null,
        email: null,
        contact_name: null,
      });

      const created = await request(port, 'POST', '/api/brands', {
        name: 'TEST: Manual Heating',
        logoUrl: 'https://fixtures.example/test-manual-logo.png',
        colors: ['#ABC', '#123456'],
        testTag: 'TEST:manual-heating',
        prospectId: lead.id,
        source: 'fetch',
      });
      assert.equal(created.status, 201);
      assert.equal(created.json.source, 'manual');
      assert.equal(created.json.logoUrl, 'https://fixtures.example/test-manual-logo.png');
      assert.deepEqual(created.json.colors, ['#aabbcc', '#123456']);
      assert.equal(created.json.testTag, 'TEST:manual-heating');
      assert.equal(created.json.name.startsWith('TEST:'), true);

      const again = await request(port, 'POST', '/api/brands', {
        name: 'TEST: Manual Heating',
        logoUrl: null,
        colors: ['#112233'],
        testTag: 'TEST:manual-heating',
      });
      assert.equal(again.status, 409);

      const plainLookup = await request(port, 'POST', '/api/rubric/lookup', { prospectId: plain.id });
      assert.equal(plainLookup.status, 200);
      assert.equal(plainLookup.json.prospectId, plain.id);
      assert.equal(Object.hasOwn(plainLookup.json, 'picks'), true);

      const linked = await request(port, 'POST', '/api/brands', {
        name: 'TEST: Plain Shop',
        colors: ['#112233'],
        testTag: 'TEST:plain-shop',
        prospectId: plain.id,
      });
      assert.equal(linked.status, 400);
      assert.equal(linked.json.field, 'prospectId');

      const missing = await request(port, 'POST', '/api/brands', {
        name: 'TEST: Missing Lead',
        colors: ['#112233'],
        testTag: 'TEST:missing-lead',
        prospectId: 999999,
      });
      assert.equal(missing.status, 404);

      const read = await request(port, 'GET', `/api/brands/${created.json.id}`);
      assert.equal(read.status, 200);
      assert.equal(read.json.testTag, 'TEST:manual-heating');

      const fixtures = await request(port, 'GET', '/api/brands/fixtures');
      assert.equal(fixtures.status, 200);
      assert.equal(fixtures.json.brands.length, BRAND_FIXTURES.length);
      assert.equal(fixtures.json.brands[0].name.startsWith('TEST:'), true);

      const lookup = await request(port, 'POST', '/api/rubric/lookup', { prospectId: lead.id });
      assert.equal(lookup.status, 200);
      assert.equal(lookup.json.recommended.agent, 'estimate_followup');
      assert.equal(lookup.json.recommended.score, 95);
      assert.equal(lookup.json.picks.length <= 2, true);
      const lookupText = JSON.stringify(lookup.json);
      assert.equal(lookupText.includes('never followed up'), false);
      assert.equal(lookupText.includes('Manual Heating'), false);
      assert.equal(Object.hasOwn(lookup.json, 'research'), false);

      const stored = await pool.query('SELECT source, logo_url FROM prospect_brands WHERE test_tag = $1', ['TEST:manual-heating']);
      assert.equal(stored.rows[0].source, 'manual');
      assert.equal(stored.rows[0].logo_url, 'https://fixtures.example/test-manual-logo.png');

      await assert.rejects(
        () => pool.query(
          `INSERT INTO prospect_brands (name, logo_url, colors, source, test_tag)
           VALUES ('TEST: Bad Url', 'javascript:alert(1)', '[]'::jsonb, 'manual', 'TEST:bad-url')`
        ),
        err => err.code === '23514'
      );
      await assert.rejects(
        () => pool.query(
          `INSERT INTO prospect_brands (name, logo_url, colors, source, test_tag)
           VALUES ('TEST: Bad Hex', NULL, '["red"]'::jsonb, 'manual', 'TEST:bad-hex')`
        ),
        err => err.code === '23514'
      );
      await assert.rejects(
        () => pool.query(
          `INSERT INTO prospect_brands (name, logo_url, colors, source, test_tag)
           VALUES ('TEST: Fetch Source', NULL, '[]'::jsonb, 'fetch', 'TEST:fetch-source')`
        ),
        err => err.code === '23514'
      );
      await assert.rejects(
        () => pool.query(
          `INSERT INTO prospect_brands (name, logo_url, colors, source, test_tag)
           VALUES ('TEST: <script>', NULL, '[]'::jsonb, 'manual', 'TEST:script-name')`
        ),
        err => err.code === '23514'
      );
      await assert.rejects(
        () => pool.query(
          `INSERT INTO prospect_brands (name, logo_url, colors, source, test_tag)
           VALUES ('TEST: Css Logo', 'https://fixtures.example/);background:url(https://evil.example)', '[]'::jsonb, 'manual', 'TEST:css-logo')`
        ),
        err => err.code === '23514'
      );

      validateBrand({
        name: 'TEST: No Fetch',
        logoUrl: 'https://fixtures.example/test-logo.png',
        colors: ['#112233'],
        source: 'manual',
        testTag: 'TEST:no-fetch',
      });
      pickPrototypes(estimateShop());
      recommendPrototypes(estimateShop(), await loadRubric(pool));
    } finally {
      await new Promise(resolve => server.close(resolve));
    }
  });

  it('denies outbound I/O before brand modules load', () => {
    const clean = runBrandGuard([]);
    assert.equal(clean.status, 0, `${clean.stdout}\n${clean.stderr}`);
    const mutated = runBrandGuard(['--mutate']);
    assert.equal(mutated.status, 0, `${mutated.stdout}\n${mutated.stderr}`);
    const report = JSON.parse(mutated.stdout);
    const required = [
      'http.request', 'http.get', 'https.request', 'https.get',
      'net.connect', 'net.Socket.connect', 'tls.connect',
      'dns.lookup', 'dns.resolveAny', 'dns.promises.lookup', 'dns.promises.resolveAny',
      'dns.Resolver.resolve4', 'dns.Resolver.resolveAny',
      'child_process.spawnSync', 'child_process.execSync', 'child_process.spawn',
      'fetch', 'undici.fetch', 'undici.request',
      'axios', 'axios.post', 'axios.get',
    ];
    for (const label of required) {
      assert.equal(report.caught.includes(label), true, label);
      assert.equal(report.missed.includes(label), false, label);
    }
    assert.deepEqual(report.missed, []);
    assert.deepEqual(report.silent, []);
  });

  it('boots with the default config and inserts no brand rows', async () => {
    const schema = fs.readFileSync(path.join(ROOT, 'src/db/schema.sql'), 'utf8');
    assert.equal(/INSERT\s+INTO\s+prospect_brands/i.test(schema), false);
    await resetDb();
    await applyMainSchema();
    await applyMainSchema();
    const brands = await pool.query('SELECT COUNT(*)::int AS n FROM prospect_brands');
    assert.equal(brands.rows[0].n, 0);
    const rubric = await pool.query('SELECT COUNT(*)::int AS n FROM prototype_rubric');
    assert.equal(rubric.rows[0].n, rubricRows().length);
    const meta = await pool.query('SELECT COUNT(*)::int AS n FROM prototype_rubric_meta');
    assert.equal(meta.rows[0].n, 1);
  });

  it('commits schema.sql and boots when a 51c459d brand row breaks the tighter checks', async () => {
    const schema = fs.readFileSync(path.join(ROOT, 'src/db/schema.sql'), 'utf8');
    const repair = fs.readFileSync(path.join(ROOT, 'src/db/brand-constraints.sql'), 'utf8');
    const allowedDrops = [
      'ALTER TABLE prospects DROP CONSTRAINT IF EXISTS prospects_do_not_contact_source_check;',
      'ALTER TABLE chat_demo_sessions DROP CONSTRAINT IF EXISTS chat_demo_sessions_tag_check;',
    ];
    let schemaWithoutAllowedDrops = schema;
    for (const statement of allowedDrops) {
      assert.equal(schemaWithoutAllowedDrops.split(statement).length - 1, 1, statement);
      schemaWithoutAllowedDrops = schemaWithoutAllowedDrops.replace(statement, '');
    }
    assert.equal(/DROP\s+CONSTRAINT/i.test(schemaWithoutAllowedDrops), false);
    assert.equal(/DROP\s+CONSTRAINT/i.test(repair), false);
    assert.match(repair, /NOT VALID/);
    assert.match(repair, /VALIDATE CONSTRAINT prospect_brands_name_strict/);
    assert.match(repair, /VALIDATE CONSTRAINT prospect_brands_logo_https/);
    assert.match(repair, /\^https:\/\//);
    const cleanup = [...schema.matchAll(/DELETE\s+FROM\s+prospect_brands[^;]*/gi)]
      .concat([...repair.matchAll(/DELETE\s+FROM\s+prospect_brands[^;]*/gi)]);
    for (const match of cleanup) {
      assert.equal(/\bLIKE\b/i.test(match[0]), false, match[0]);
      assert.match(match[0], /test_tag\s*(=|IN\s*\()/i);
    }

    const stopChild = (proc) => new Promise((resolve) => {
      if (!proc || proc.exitCode != null) {
        resolve();
        return;
      }
      const timer = setTimeout(() => {
        proc.kill('SIGKILL');
        resolve();
      }, 2000);
      proc.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
      proc.kill('SIGTERM');
    });

    let child;
    try {
    await resetDb();
    await applyMainSchema();
    await assert.rejects(
      () => pool.query(
        `INSERT INTO prospect_brands (name, logo_url, colors, source, test_tag)
         VALUES ('TEST: Http Logo', 'http://fixtures.example/logo.png', '[]'::jsonb, 'manual', 'TEST:http-logo')`
      ),
      (err) => err.code === '23514'
    );

    // The checks from 51c459d: TEST: prefix, no @, and an http(s) logo with no userinfo.
    await pool.query(`
      ALTER TABLE prospect_brands DROP CONSTRAINT IF EXISTS prospect_brands_name_strict;
      ALTER TABLE prospect_brands DROP CONSTRAINT IF EXISTS prospect_brands_name_test;
      ALTER TABLE prospect_brands ADD CONSTRAINT prospect_brands_name_test CHECK (
        char_length(name) BETWEEN 6 AND 120
        AND left(name, 5) = 'TEST:'
        AND position('@' IN name) = 0
      );
      ALTER TABLE prospect_brands DROP CONSTRAINT IF EXISTS prospect_brands_logo_https;
      ALTER TABLE prospect_brands DROP CONSTRAINT IF EXISTS prospect_brands_logo_http;
      ALTER TABLE prospect_brands ADD CONSTRAINT prospect_brands_logo_http CHECK (
        logo_url IS NULL OR (
          char_length(logo_url) BETWEEN 8 AND 300
          AND logo_url ~ '^https?://'
          AND logo_url !~ '://[^/?#]*@'
        )
      );
    `);
    await pool.query(
      `INSERT INTO prospect_brands (name, logo_url, colors, source, test_tag)
       VALUES ($1, $2, '[]'::jsonb, 'manual', 'TEST:legacy-markup')`,
      ['TEST: <b>x</b>', 'https://ok.example/a(1).png']
    );

    await applyMainSchema();
    const beforeBoot = await pool.query(
      `SELECT name, logo_url FROM prospect_brands WHERE test_tag = 'TEST:legacy-markup'`
    );
    assert.equal(beforeBoot.rows.length, 1);
    assert.equal(beforeBoot.rows[0].name, 'TEST: <b>x</b>');

    const firstRepair = await applyBrandConstraints();
    const secondRepair = await applyBrandConstraints();
    assert.equal(firstRepair.notices.some(note => note.includes('name check validation failed')), true);
    assert.equal(firstRepair.notices.some(note => note.includes('logo check validation failed')), true);
    assert.equal(secondRepair.notices.some(note => note.includes('name check validation failed')), true);
    assert.equal(secondRepair.errors.length, 0);
    assert.equal(firstRepair.errors.length, 0);

    const checks = await pool.query(
      `SELECT conname, convalidated
         FROM pg_constraint
        WHERE conname IN ('prospect_brands_name_strict', 'prospect_brands_logo_https')
        ORDER BY conname`
    );
    assert.deepEqual(checks.rows, [
      { conname: 'prospect_brands_logo_https', convalidated: false },
      { conname: 'prospect_brands_name_strict', convalidated: false },
    ]);

    const probe = http.createServer();
    const port = await new Promise((resolve, reject) => {
      probe.once('error', reject);
      probe.listen(0, '127.0.0.1', () => resolve(probe.address().port));
    });
    await new Promise((resolve) => probe.close(resolve));

    try {
      child = spawn(process.execPath, [path.join(ROOT, 'src/server.js')], {
        env: {
          ...process.env,
          PORT: String(port),
          NODE_ENV: 'test',
          DISABLE_CRON: '1',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let output = '';
      child.stdout.on('data', (buf) => { output += buf.toString('utf8'); });
      child.stderr.on('data', (buf) => { output += buf.toString('utf8'); });
      const deadline = Date.now() + 20000;
      let health = 0;
      let lastError = null;
      while (Date.now() < deadline && child.exitCode == null) {
        try {
          const res = await request(port, 'GET', '/health');
          health = res.status;
          break;
        } catch (err) {
          lastError = err;
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
      }
      assert.equal(health, 200, `server did not listen (${lastError && lastError.message}): ${output}`);
      assert.equal(output.includes('Startup migration/rescore failed'), false, output);
      assert.match(output, /Fit scores refreshed/);
      assert.match(output, /prospect_brands: name check validation failed/);
      assert.match(output, /prospect_brands: logo check validation failed/);

      const afterBoot = await pool.query(
        `SELECT name, logo_url FROM prospect_brands WHERE test_tag = 'TEST:legacy-markup'`
      );
      assert.equal(afterBoot.rows.length, 1);
      assert.equal(afterBoot.rows[0].logo_url, 'https://ok.example/a(1).png');
      await assert.rejects(
        () => pool.query(
          `INSERT INTO prospect_brands (name, logo_url, colors, source, test_tag)
           VALUES ('TEST: <b>y</b>', 'https://fixtures.example/ok.png', '[]'::jsonb, 'manual', 'TEST:still-markup')`
        ),
        (err) => err.code === '23514'
      );
      await assert.rejects(
        () => pool.query(
          `INSERT INTO prospect_brands (name, logo_url, colors, source, test_tag)
           VALUES ('TEST: Http Again', 'http://fixtures.example/logo.png', '[]'::jsonb, 'manual', 'TEST:http-again')`
        ),
        (err) => err.code === '23514'
      );
      await pool.query(
        `INSERT INTO prospect_brands (name, logo_url, colors, source, test_tag)
         VALUES ('TEST: Strict Ok', 'https://fixtures.example/ok.png', '[]'::jsonb, 'manual', 'TEST:strict-ok')`
      );
    } finally {
      await stopChild(child);
    }
    } finally {
      await stopChild(child);
      await pool.query(
        `DELETE FROM prospect_brands
          WHERE test_tag IN ('TEST:legacy-markup', 'TEST:strict-ok', 'TEST:still-markup', 'TEST:http-again')`
      );
      await pool.query(`
        ALTER TABLE prospect_brands DROP CONSTRAINT IF EXISTS prospect_brands_name_test;
        ALTER TABLE prospect_brands ADD CONSTRAINT prospect_brands_name_test CHECK (
          char_length(name) BETWEEN 6 AND 120
          AND left(name, 5) = 'TEST:'
          AND position('@' IN name) = 0
          AND name !~ U&'[[:cntrl:]<>\\200B-\\200F\\202A-\\202E\\2060-\\2064\\2066-\\2069\\FEFF]'
          AND btrim(substring(name from 6)) ~ '[[:graph:]]'
        );
        ALTER TABLE prospect_brands DROP CONSTRAINT IF EXISTS prospect_brands_logo_http;
      `);
      await applyBrandConstraints();
    }
  });
});
