require('./preload');

// F-003. Soft positive fit signals from cached research only.
// Disposable Postgres. No Places, no live fetch, no discovery.

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
  INDUSTRY_FIT, SERVICETITAN_PENALTY, TIER_CAP_FOR, TIERS, ESTIMATE_SIGNAL_POINTS,
  ESTIMATE_SIGNAL_HVAC_WORDS,
} = require('../src/scoring/config');
const { computeFit, rescore, ST_REASON } = require('../src/scoring/fit');
const { resetDb, insertProspect, closePool, pool } = require('./fixtures');

// Post-F-002 catalog. This PR must not add a query type.
const PLACES_QUERIES = [
  ['HVAC company', 'HVAC'],
  ['air conditioning repair', 'HVAC'],
  ['heating and cooling', 'HVAC'],
  ['furnace repair', 'HVAC'],
  ['AC installation', 'HVAC'],
  ['heating and air conditioning', 'HVAC'],
  ['plumbing company', 'Plumbing'],
  ['plumber', 'Plumbing'],
  ['drain cleaning', 'Plumbing'],
  ['water heater repair', 'Plumbing'],
  ['electrician', 'Electrical'],
  ['roofing contractor', 'Roofing'],
  ['landscaping company', 'Landscaping'],
  ['house cleaning service', 'Cleaning'],
  ['painting contractor', 'Painting'],
  ['general contractor', 'Construction'],
];

// Scores these fixtures had before F-003. None of them carries research.
const BEFORE = [
  ['HVAC sweet spot', {
    company: 'Wasatch Heating', industry: 'HVAC', website: 'https://wasatchheating.example',
    phone: '(801) 555-0100', city: 'Provo', state: 'UT', rating: 4.0, review_count: 80, fit_boost: 0,
  }, 100, 'A'],
  ['Plumbing', {
    company: 'Provo Plumbing', industry: 'Plumbing', website: 'https://wasatchheating.example',
    phone: '(801) 555-0100', city: 'Provo', state: 'UT', rating: 4.0, review_count: 80, fit_boost: 0,
  }, 97, 'A'],
  ['Electrical', {
    company: 'Provo Electric', industry: 'Electrical', website: 'https://wasatchheating.example',
    phone: '(801) 555-0100', city: 'Provo', state: 'UT', rating: 4.0, review_count: 80, fit_boost: 0,
  }, 83, 'A'],
  ['Roofing', {
    company: 'Provo Roofing', industry: 'Roofing', website: 'https://wasatchheating.example',
    phone: '(801) 555-0100', city: 'Provo', state: 'UT', rating: 4.0, review_count: 80, fit_boost: 0,
  }, 83, 'A'],
  ['Landscaping', {
    company: 'Provo Lawns', industry: 'Landscaping', website: 'https://wasatchheating.example',
    phone: '(801) 555-0100', city: 'Provo', state: 'UT', rating: 4.0, review_count: 80, fit_boost: 0,
  }, 77, 'B'],
  ['Painting', {
    company: 'Provo Paint', industry: 'Painting', website: 'https://wasatchheating.example',
    phone: '(801) 555-0100', city: 'Provo', state: 'UT', rating: 4.0, review_count: 80, fit_boost: 0,
  }, 77, 'B'],
  ['Construction', {
    company: 'Provo Builders', industry: 'Construction', website: 'https://wasatchheating.example',
    phone: '(801) 555-0100', city: 'Provo', state: 'UT', rating: 4.0, review_count: 80, fit_boost: 0,
  }, 77, 'B'],
  ['Cleaning', {
    company: 'Provo Clean', industry: 'Cleaning', website: 'https://wasatchheating.example',
    phone: '(801) 555-0100', city: 'Provo', state: 'UT', rating: 4.0, review_count: 80, fit_boost: 0,
  }, 73, 'B'],
  ['Gutters out of market', {
    company: 'Quiet Gutters', industry: 'Gutters', website: null, phone: null,
    city: 'Denver', state: 'CO', rating: null, review_count: 0,
  }, 14, 'D'],
  ['Windows', {
    company: 'Provo Windows', industry: 'Windows', website: 'https://wasatchheating.example',
    phone: '(801) 555-0100', city: 'Provo', state: 'UT', rating: 4.0, review_count: 80, fit_boost: 0,
  }, 73, 'B'],
  ['social HVAC', {
    company: 'Wasatch Heating', industry: 'HVAC', website: 'https://facebook.com/wasatchheating',
    phone: '(801) 555-0100', city: 'Provo', state: 'UT', rating: 4.0, review_count: 80, fit_boost: 0,
  }, 94, 'A'],
  ['Landscaping with a positive boost', {
    company: 'Provo Lawns', industry: 'Landscaping', website: 'https://wasatchheating.example',
    phone: '(801) 555-0100', city: 'Provo', state: 'UT', rating: 4.0, review_count: 80, fit_boost: 10,
  }, 87, 'A'],
  ['Cleaning with a positive boost', {
    company: 'Provo Clean', industry: 'Cleaning', website: 'https://wasatchheating.example',
    phone: '(801) 555-0100', city: 'Provo', state: 'UT', rating: 4.0, review_count: 80, fit_boost: 20,
  }, 93, 'A'],
  ['Jobber', {
    company: 'Wasatch Heating', industry: 'HVAC', website: 'https://wasatchheating.example',
    phone: '(801) 555-0100', city: 'Provo', state: 'UT', rating: 4.0, review_count: 80, fit_boost: 0,
    fsm_detected: 'Jobber',
  }, 100, 'A'],
  ['Housecall Pro', {
    company: 'Wasatch Heating', industry: 'HVAC', website: 'https://wasatchheating.example',
    phone: '(801) 555-0100', city: 'Provo', state: 'UT', rating: 4.0, review_count: 80, fit_boost: 0,
    fsm_detected: 'Housecall Pro',
  }, 100, 'A'],
  ['marginal HVAC, no fsm', {
    company: 'Denver Heating', industry: 'HVAC', website: 'https://wasatchheating.example',
    phone: '(801) 555-0100', city: 'Denver', state: 'CO', rating: 4.0, review_count: 5, fit_boost: 0,
  }, 70, 'B'],
  ['marginal HVAC ServiceTitan already under the ceiling', {
    company: 'Denver Heating', industry: 'HVAC', website: 'https://wasatchheating.example',
    phone: '(801) 555-0100', city: 'Denver', state: 'CO', rating: 4.0, review_count: 5, fit_boost: 0,
    fsm_detected: 'ServiceTitan',
  }, 55, 'C'],
  ['pest stays excluded', {
    company: 'Terminix', industry: 'Pest Control', website: 'https://wasatchheating.example',
    phone: '(801) 555-0100', city: 'Provo', state: 'UT', rating: 4.0, review_count: 80, fit_boost: 20,
    fsm_detected: 'ServiceTitan',
  }, 0, 'D'],
];

// Same review count, below the 100 clamp, so a boost can change the rank.
// Denver, 20 reviews, rating 4.0, site and phone: HVAC 79, landscaping 56, plumbing 76.
const peer = {
  company: 'Wasatch Heating',
  industry: 'HVAC',
  website: 'https://wasatchheating.example',
  phone: '(801) 555-0100',
  city: 'Denver',
  state: 'CO',
  rating: 4.0,
  review_count: 20,
  fit_boost: 0,
};

const REPLACEMENT_TEXT = [
  'Furnace replacement and AC installation.',
  'Ask for a free estimate. We offer financing.',
  'Send the quote form.',
  'Now hiring a comfort advisor and a sales consultant.',
  'We run Google Ads and Local Services Ads.',
].join(' ');

const SUBSTRING_TEXT = [
  'Our preplacement program covers reinstallation.',
  'Ask about refinancing and a freeestimate or a free estimated visit.',
  'Hire a comfortadvisor. Buy googleads.',
  'Sales tax and a salesperson on the truck.',
].join(' ');

function research(text, extra = {}) {
  const site = {
    pages: [{
      url: extra.url || 'https://shop.example/',
      title: extra.title || 'Home',
      description: extra.description || '',
      text: text || '',
    }],
    signals: extra.signals || {},
  };
  if (Object.hasOwn(extra, 'form')) site.has_contact_form = extra.form;
  return { site };
}

function replacementResearch() {
  return research(REPLACEMENT_TEXT);
}

function armNoFetch() {
  const hits = [];
  const saved = [];
  const note = (name) => () => {
    hits.push(name);
    const err = new Error(`unexpected fetch via ${name}`);
    err.code = 'ESTIMATE_SIGNAL_FETCH';
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

function signalPoints(fit) {
  const labels = new Set(['Replacement', 'Installation', 'Free estimate', 'Financing', 'Quote form', 'Job ad', 'Search ads']);
  return fit.fit_reasons.filter(row => labels.has(row.label)).reduce((sum, row) => sum + row.points, 0);
}

function labelIndex(fit, label) {
  return fit.fit_reasons.findIndex(row => row.label === label);
}

describe('F-003 estimate signals', () => {
  it('documents each signal weight and leaves plumbing, industries, and tiers alone', () => {
    assert.deepEqual(ESTIMATE_SIGNAL_POINTS, {
      replacement: 4,
      installation: 3,
      free_estimate: 4,
      financing: 3,
      quote_form: 3,
      job_ad: 2,
      search_ads: 2,
    });
    assert.deepEqual(ESTIMATE_SIGNAL_HVAC_WORDS, ['hvac', 'heating', 'cooling', 'furnace', 'ac', 'a/c']);
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
    assert.equal(SERVICETITAN_PENALTY, -15);
    assert.deepEqual(TIER_CAP_FOR, { servicetitan: 'B', franchise: 'B' });
    assert.deepEqual(TIERS, [
      { tier: 'A', min: 78 },
      { tier: 'B', min: 62 },
      { tier: 'C', min: 47 },
      { tier: 'D', min: 0 },
    ]);

    const configSrc = fs.readFileSync(path.join(__dirname, '../src/scoring/config.js'), 'utf8');
    assert.match(configSrc, /replacement \(\+4\)/);
    assert.match(configSrc, /installation \(\+3\)/);
    assert.match(configSrc, /free_estimate \(\+4\)/);
    assert.match(configSrc, /financing \(\+3\)/);
    assert.match(configSrc, /quote_form \(\+3\)/);
    assert.match(configSrc, /job_ad \(\+2\)/);
    assert.match(configSrc, /search_ads \(\+2\)/);
    assert.match(configSrc, /Unsold-Estimate Recovery/);
    assert.match(configSrc, /no plumbing score change/);

    const fitSrc = fs.readFileSync(path.join(__dirname, '../src/scoring/fit.js'), 'utf8');
    const signalSrc = fs.readFileSync(path.join(__dirname, '../src/scoring/estimate-signals.js'), 'utf8');
    assert.doesNotMatch(fitSrc, /axios|fetch\(|searchPlaces|google-places|researchLead|https?:\/\//);
    assert.doesNotMatch(signalSrc, /axios|fetch\(|searchPlaces|google-places|researchLead|https?:\/\//);
    assert.match(fitSrc, /fsm_detected/);
    assert.match(fitSrc, /research/);
    assert.equal(catalog.length, PLACES_QUERIES.length);
    assert.equal(INDUSTRIES.length, PLACES_QUERIES.length);
    assert.deepEqual(catalog.map(row => [row.query, row.industry]), PLACES_QUERIES);
    assert.deepEqual(INDUSTRIES.map(row => [row.query, row.industry]), PLACES_QUERIES);
  });

  it('ranks a replacement HVAC shop above a service-only and a landscaping peer', () => {
    const serviceOnly = computeFit(peer);
    const landscaping = computeFit({ ...peer, company: 'Denver Lawns', industry: 'Landscaping' });
    const sameCacheLandscaping = computeFit({
      ...peer,
      company: 'Denver Lawns',
      industry: 'Landscaping',
      research: replacementResearch(),
    });
    const replacement = computeFit({ ...peer, research: replacementResearch() });

    assert.equal(serviceOnly.fit_score, 79);
    assert.equal(serviceOnly.fit_tier, 'A');
    assert.equal(signalPoints(serviceOnly), 0);
    assert.equal(landscaping.fit_score, 56);
    assert.equal(landscaping.fit_tier, 'C');
    assert.equal(sameCacheLandscaping.fit_score, 56);
    assert.equal(sameCacheLandscaping.fit_tier, 'C');
    assert.equal(signalPoints(sameCacheLandscaping), 0);
    assert.equal(replacement.fit_score, 100);
    assert.equal(replacement.fit_tier, 'A');
    assert.equal(signalPoints(replacement), 21);
    assert.ok(replacement.fit_score > serviceOnly.fit_score);
    assert.ok(replacement.fit_score > landscaping.fit_score);
    assert.ok(replacement.fit_score > sameCacheLandscaping.fit_score);
    assert.equal(replacement.fit_reasons.find(row => row.label === 'Replacement').points, 4);
    assert.equal(replacement.fit_reasons.find(row => row.label === 'Installation').points, 3);
    assert.equal(replacement.fit_reasons.find(row => row.label === 'Free estimate').points, 4);
    assert.equal(replacement.fit_reasons.find(row => row.label === 'Financing').points, 3);
    assert.equal(replacement.fit_reasons.find(row => row.label === 'Quote form').points, 3);
    assert.equal(replacement.fit_reasons.find(row => row.label === 'Job ad').points, 2);
    assert.equal(replacement.fit_reasons.find(row => row.label === 'Search ads').points, 2);

    console.log(`[f-003] HVAC replacement ${replacement.fit_score}/${replacement.fit_tier} vs service-only ${serviceOnly.fit_score}/${serviceOnly.fit_tier} vs landscaping ${landscaping.fit_score}/${landscaping.fit_tier} (review_count ${peer.review_count})`);
  });

  it('adds each cached signal on its own and ignores non-matching substrings', () => {
    const plain = computeFit(peer);
    assert.equal(plain.fit_score, 79);

    const cases = [
      ['replacement word', research('Furnace replacement'), 4],
      ['replacements plural', research('Replacements for older furnaces'), 4],
      ['installation word', research('AC installation'), 3],
      ['free estimate', research('Ask for a Free Estimate today'), 4],
      ['free estimates plural', research('free   estimates this month'), 4],
      ['financing word', research('0% financing on equipment'), 3],
      ['lender signature', research('', { signals: { financing: ['GreenSky'] } }), 3],
      ['free_estimates mention', { signals: { mentions: { free_estimates: true } } }, 4],
      ['contact form flag', research('', { form: true }), 3],
      ['contact path', research('', { url: 'https://shop.example/contact-us' }), 3],
      ['quote form words', research('Fill out the quote form'), 3],
      ['comfort advisor', research('Now hiring comfort advisors'), 2],
      ['sales consultant', research('We need a sales consultant'), 2],
      ['sales advisor', research('Now hiring a sales advisor'), 2],
      ['job title cache', research('', { signals: { job_ads: ['Comfort Advisor'] } }), 2],
      ['sales advisor title', research('', { signals: { job_ads: ['Sales Advisor'] } }), 2],
      ['google ads signature', research('', { signals: { analytics_ads: ['Google Ads conversion'] } }), 2],
      ['LSA phrase', research('We buy LSA leads'), 2],
      ['local services ads', research('Local Services Ads'), 2],
    ];
    for (const [name, cache, weight] of cases) {
      const fit = computeFit({ ...peer, research: cache });
      assert.equal(fit.fit_score - plain.fit_score, weight, name);
      assert.equal(signalPoints(fit), weight, name);
    }

    const misses = [
      research(SUBSTRING_TEXT, {
        form: false,
        url: 'https://shop.example/preplacement',
        signals: {
          mentions: { free_estimates: false, financing: false, hiring: true },
          financing: [],
          analytics_ads: ['Google Analytics', 'Meta Pixel', 'CallRail'],
          job_ads: ['Technician'],
        },
      }),
      research('free estimated visit and a salesperson'),
      research('', { signals: { job_ads: ['Comfort Technician'] } }),
      research('', { signals: { job_ads: ['Parts Sales Clerk'] } }),
      research('Now hiring a comfort technician and a parts sales clerk'),
      research('', { form: false, url: 'https://shop.example/contact' }),
      research('Contact form. We\'ll follow up tomorrow. Furnace replacement'),
      { signals: { mentions: { hiring: true, free_estimates: false, financing: false } } },
      {},
    ];
    const followUp = computeFit({ ...peer, research: misses[6] });
    assert.equal(followUp.fit_score - plain.fit_score, 4);
    assert.equal(followUp.fit_reasons.some(row => row.label === 'Quote form'), false);
    assert.equal(followUp.fit_reasons.find(row => row.label === 'Replacement').points, 4);

    for (const cache of misses.filter((_, index) => index !== 6)) {
      const fit = computeFit({ ...peer, research: cache });
      assert.equal(fit.fit_score, plain.fit_score);
      assert.equal(signalPoints(fit), 0);
    }
  });

  it('gives no boost when research is missing', () => {
    const plain = computeFit(peer);
    for (const researchValue of [null, undefined, { site: null }, { signals: null }]) {
      const fit = computeFit({ ...peer, research: researchValue });
      assert.equal(fit.fit_score, plain.fit_score);
      assert.equal(fit.fit_tier, plain.fit_tier);
      assert.equal(signalPoints(fit), 0);
    }
    const absent = computeFit(peer);
    assert.equal(Object.hasOwn(peer, 'research'), false);
    assert.equal(absent.fit_score, 79);
  });

  it('does not change a plumbing score, with or without the same cache', () => {
    const plumbing = { ...peer, company: 'Denver Plumbing', industry: 'Plumbing' };
    const plain = computeFit(plumbing);
    const cached = computeFit({ ...plumbing, research: replacementResearch() });
    const lower = { ...plumbing, industry: 'plumbing' };
    const lowerPlain = computeFit(lower);
    const cased = computeFit({ ...lower, research: replacementResearch() });
    assert.equal(plain.fit_score, 76);
    assert.equal(cached.fit_score, plain.fit_score);
    assert.equal(cached.fit_tier, plain.fit_tier);
    assert.equal(signalPoints(cached), 0);
    assert.equal(cased.fit_score, lowerPlain.fit_score);
    assert.equal(cased.fit_tier, lowerPlain.fit_tier);
    assert.equal(signalPoints(cased), 0);

    const sweet = computeFit({
      company: 'Provo Plumbing',
      industry: 'Plumbing',
      website: 'https://provoplumbing.example',
      phone: '(801) 555-0140',
      city: 'Provo',
      state: 'UT',
      rating: 4.0,
      review_count: 80,
      fit_boost: 0,
      research: replacementResearch(),
    });
    assert.equal(sweet.fit_score, 97);
    assert.equal(sweet.fit_tier, 'A');
    assert.equal(signalPoints(sweet), 0);

    const plumber = computeFit({
      ...peer,
      company: 'City Plumber',
      industry: 'Plumber',
      research: replacementResearch(),
    });
    const plumberPlain = computeFit({ ...peer, company: 'City Plumber', industry: 'Plumber' });
    assert.equal(signalPoints(plumber), 0);
    assert.equal(plumber.fit_score, plumberPlain.fit_score);

    const namedRow = {
      ...peer,
      company: 'Plumbing & Heating',
      industry: 'Plumbing',
      category: 'HVAC',
    };
    const named = computeFit({ ...namedRow, research: replacementResearch() });
    assert.equal(signalPoints(named), 0);
    assert.equal(named.fit_score, computeFit(namedRow).fit_score);

    const labeled = computeFit({
      ...peer,
      company: 'City Services',
      industry: 'Plumbing & Heating',
      research: replacementResearch(),
    });
    assert.equal(signalPoints(labeled), 21);

    const byCategory = computeFit({
      ...peer,
      company: 'City Electric',
      industry: 'Electrical',
      category: 'HVAC',
      research: replacementResearch(),
    });
    assert.equal(signalPoints(byCategory), 0);

    const electrical = computeFit({
      ...peer,
      company: 'City Electric',
      industry: 'Electrical',
      research: replacementResearch(),
    });
    assert.equal(signalPoints(electrical), 0);
  });

  it('uses the stored industry before the company name or category', () => {
    const neutral = { ...peer, company: 'City Services' };
    const hvacIndustries = [
      'HVAC', 'hvac', ' HVAC ', 'Heating', 'heating & cooling', 'Heating & Cooling',
      'Plumbing & Heating', 'HVAC & Plumbing', 'Heating and Air', 'AC', 'A/C',
      'Air Conditioning', 'air-conditioning',
    ];
    for (const industry of hvacIndustries) {
      const fit = computeFit({ ...neutral, industry, research: replacementResearch() });
      assert.equal(signalPoints(fit), 21, industry);
    }

    const blocked = [
      'Face Painting', 'A.C. Painting', 'Plumbing', 'plumbing', ' PLUMBING ',
      'Plumber', 'Landscaping', 'Electrical', 'Roofing', 'Pool',
      'Heating Oil Delivery', 'Pool Heating',
    ];
    for (const industry of blocked) {
      const fit = computeFit({
        ...peer,
        company: 'AC Cooling Heating',
        category: 'HVAC',
        industry,
        research: replacementResearch(),
      });
      assert.equal(signalPoints(fit), 0, industry);
    }

    for (const industry of [null, '']) {
      const fit = computeFit({
        ...neutral,
        industry,
        category: 'Landscaping',
        research: replacementResearch(),
      });
      assert.equal(signalPoints(fit), 0, String(industry));
    }

    const nameWins = [
      ['AC Lawn Care', 'Landscaping'],
      ['Cooling Shade Trees', 'Landscaping'],
      ['AC/DC Electric', 'Electrical'],
    ];
    for (const [company, industry] of nameWins) {
      const row = { ...peer, company, industry, category: 'HVAC' };
      const fit = computeFit({ ...row, research: replacementResearch() });
      assert.equal(signalPoints(fit), 0, company);
      assert.equal(fit.fit_score, computeFit(row).fit_score, company);
    }

    const lawnCategory = computeFit({
      ...peer,
      company: 'Denver Lawns',
      industry: 'Landscaping',
      category: 'HVAC',
      research: replacementResearch(),
    });
    assert.equal(signalPoints(lawnCategory), 0);

    const emptyName = computeFit({
      ...neutral,
      industry: '',
      company: 'Cooling Shade Trees',
      research: replacementResearch(),
    });
    assert.equal(signalPoints(emptyName), 0);

    const emptyMixed = [
      ['AC Lawn Care', null],
      ['AC Lawn Care', ''],
      ['AC/DC Electric', null],
      ['AC/DC Electric', '   '],
    ];
    for (const [company, industry] of emptyMixed) {
      const fit = computeFit({
        ...neutral,
        company,
        industry,
        category: undefined,
        research: replacementResearch(),
      });
      assert.equal(signalPoints(fit), 0, company);
    }

    const smith = computeFit({
      ...neutral,
      industry: '',
      company: 'Smith Heating & Air',
      research: replacementResearch(),
    });
    assert.equal(signalPoints(smith), 21);

    const emptyCategory = computeFit({
      ...neutral,
      industry: '',
      category: 'HVAC',
      research: replacementResearch(),
    });
    assert.equal(signalPoints(emptyCategory), 21);

    const emptyCombo = computeFit({
      ...neutral,
      industry: null,
      categories: ['Heating and Air'],
      research: replacementResearch(),
    });
    assert.equal(signalPoints(emptyCombo), 21);
  });

  it('gives landscaping with every signal no boost and keeps it at or below 77/B', () => {
    const sweet = {
      company: 'Provo Lawns',
      industry: 'Landscaping',
      website: 'https://provolawns.example',
      phone: '(801) 555-0140',
      city: 'Provo',
      state: 'UT',
      rating: 4.0,
      review_count: 80,
      fit_boost: 0,
      research: replacementResearch(),
    };
    const fit = computeFit(sweet);
    assert.equal(signalPoints(fit), 0);
    assert.equal(fit.fit_score, 77);
    assert.equal(fit.fit_tier, 'B');
    assert.ok(fit.fit_score <= 77);

    const outOfMarket = computeFit({
      ...peer,
      company: 'Denver Lawns',
      industry: 'Landscaping',
      research: replacementResearch(),
    });
    assert.equal(signalPoints(outOfMarket), 0);
    assert.equal(outOfMarket.fit_score, 56);
    assert.ok(outOfMarket.fit_score <= 77);
    assert.notEqual(outOfMarket.fit_tier, 'A');
  });

  it('ignores negated phrases and still counts an affirmative one', () => {
    const plain = computeFit(peer);
    const negated = [
      ['no free estimates', research('No free estimates')],
      ['do not offer financing', research('We do not offer financing')],
      ['dont offer financing', research("We don't offer financing")],
      ['not offering installation', research('We are not offering installation')],
      ['no replacement', research('No replacement work here')],
      ['mention contradicted', {
        signals: { mentions: { free_estimates: true } },
        site: { pages: [{ url: 'https://shop.example/', title: 'Home', text: 'No free estimates' }], signals: {} },
      }],
      ['financing not available', research('Financing not available.')],
      ['estimates are not available', research('Free estimates are not available.')],
      ['curly dont', research('We don\u2019t offer free estimates.')],
      ['curly doesnt', research('This doesn\u2019t include financing.')],
      ['comma clause', research('We do not offer, at this time, any kind of financing')],
      ['financing none', research('Financing: none')],
      ['estimates question no', research('free estimates? no.')],
      ['financing unavailable', research('Financing unavailable.')],
      ['never replacement', research('We never do replacement')],
      ['no longer offer', research('no longer offer financing')],
      ['we no longer offer', research('We no longer offer financing')],
      ['no longer offering estimates', research('No longer offering free estimates')],
      ['no more financing', research('no more financing')],
      ['without financing', research('Pay without financing today')],
      ['cannot installation', research('We cannot offer installation')],
      ['shouted no estimates', research('NO  FREE ESTIMATES')],
      ['dont offer free estimates', research("We don't offer free estimates")],
      ['unfortunately aside', research('We do not, unfortunately, offer financing')],
      ['clearly aside', research('We do not, clearly, offer financing')],
      ['frankly aside', research('We do not, frankly, offer financing')],
      ['our financing', research('We do not offer, at this time, our financing')],
      ['our free estimates', research('We do not offer, at this time, our free estimates')],
      ['our customers financing', research('We do not offer, at this time, our customers financing')],
      ['accept our financing', research('We do not accept, at this time, our financing')],
      ['utah replacement financing', research('We do not offer, in Utah, our replacement financing')],
      ['yet in your area', research('We do not yet offer, in your area, any kind of financing')],
      ['yet in utah', research('We do not yet offer, in Utah, any kind of financing')],
      ['currently at this time', research('We do not currently offer, at this time, any kind of financing')],
      ['currently offering', research('We are not currently offering, in Utah, any kind of financing')],
      ['really for now', research('We do not really offer, for now, any kind of financing')],
      ['unfortunately our financing', research('We do not offer, unfortunately, our financing')],
      ['sadly our financing', research('We do not offer, sadly, our financing')],
      ['your free estimate', research('We cannot provide, for now, your free estimate')],
      ['your financing options', research('We do not offer, for a limited time, your financing options')],
      ['and will not', research('We do not, and will not, offer financing')],
      ['and do not estimates', research('We cannot, and do not, offer free estimates')],
      ['call after aside', research('We do not offer, at this time, call for a free estimate')],
      ['sorry but have', research("We don't offer, sorry, but we have financing")],
      ['dangling hyphen', research('We do not -offer financing')],
      ['dont offer call', research("Don't offer, call for a free estimate")],
      ['do not provide call', research('Do not provide, call for a free estimate')],
      ['dont accept our', research("Don't accept, our financing")],
      ['dont do this call', research("Don't do this, call for a free estimate")],
      ['dont extend call', research("Don't extend, call for a free estimate")],
      ['dont have call', research("Don't have, call for a free estimate")],
      ['dont carry call', research("Don't carry, call for a free estimate")],
      ['we dont wait', research("We don't wait, call for a free estimate")],
      ['please dont wait', research("Please don't wait, call for a free estimate")],
      ['dont yet wait', research("Don't yet wait, call for a free estimate")],
      ['hesitate without break', research("Don't hesitate to call for a free estimate")],
      ['do not miss our', research('Do not miss our free estimates')],
      ['dont wait no break', research("Don't wait call for a free estimate")],
      ['later dont still negates', research("Don't wait, we don't, call for a free estimate")],
      ['dont comma without verb', research("Don't, at this time, call for a free estimate")],
      ['comma then negator', research('Sure, we do not offer financing')],
      ['semicolon then negator', research('Never mind; we do not offer financing')],
      ['colon then negator', research('Remember: we do not offer financing')],
      ['hyphen then negator', research('Wait - we do not offer financing')],
      ['double hyphen then negator', research('Wait -- we do not offer financing')],
      ['en dash then negator', research('Wait \u2013 we do not offer financing')],
      ['em dash then negator', research('Wait \u2014 we do not offer financing')],
      ['last break wins', research('Remember, please; we do not offer financing')],
      ['compound hyphen', research('We do not offer in-home financing')],
      ['financing mention after', {
        signals: { mentions: { financing: true } },
        site: { pages: [{ url: 'https://shop.example/', title: 'Home', text: 'Financing not available.' }], signals: {} },
      }],
    ];
    for (const [name, cache] of negated) {
      const fit = computeFit({ ...peer, research: cache });
      assert.equal(fit.fit_score, plain.fit_score, name);
      assert.equal(signalPoints(fit), 0, name);
    }

    const mixed = computeFit({
      ...peer,
      research: research('Furnace replacement. We do not offer financing.'),
    });
    assert.equal(mixed.fit_score - plain.fit_score, 4);
    assert.equal(mixed.fit_reasons.some(row => row.label === 'Financing'), false);
    assert.equal(mixed.fit_reasons.find(row => row.label === 'Replacement').points, 4);

    const notOnly = computeFit({
      ...peer,
      research: research('Not only installation, we also do replacement.'),
    });
    assert.equal(notOnly.fit_score - plain.fit_score, 7);
    assert.equal(notOnly.fit_reasons.find(row => row.label === 'Installation').points, 3);
    assert.equal(notOnly.fit_reasons.find(row => row.label === 'Replacement').points, 4);

    const hyphenCost = computeFit({ ...peer, research: research('Ask about no-cost financing.') });
    assert.equal(hyphenCost.fit_score - plain.fit_score, 3);
    assert.equal(hyphenCost.fit_reasons.find(row => row.label === 'Financing').points, 3);

    const spacedCost = computeFit({ ...peer, research: research('Ask about no cost financing.') });
    assert.equal(spacedCost.fit_score - plain.fit_score, 3);
    assert.equal(spacedCost.fit_reasons.find(row => row.label === 'Financing').points, 3);

    const available = computeFit({ ...peer, research: research('Financing available') });
    assert.equal(available.fit_score - plain.fit_score, 3);
    assert.equal(available.fit_reasons.find(row => row.label === 'Financing').points, 3);

    const nonetheless = computeFit({ ...peer, research: research('Financing nonetheless is offered') });
    assert.equal(nonetheless.fit_reasons.find(row => row.label === 'Financing').points, 3);

    const obligation = computeFit({ ...peer, research: research('Free estimates, no obligation') });
    assert.equal(obligation.fit_score - plain.fit_score, 4);
    assert.equal(obligation.fit_reasons.find(row => row.label === 'Free estimate').points, 4);
    assert.equal(signalPoints(obligation), 4);

    const obligationFirst = computeFit({ ...peer, research: research('No obligation free estimates') });
    assert.equal(obligationFirst.fit_score - plain.fit_score, 4);
    assert.equal(obligationFirst.fit_reasons.find(row => row.label === 'Free estimate').points, 4);
    assert.equal(signalPoints(obligationFirst), 4);

    const hiddenFees = computeFit({ ...peer, research: research('No hidden fees, plus free estimates!') });
    assert.equal(hiddenFees.fit_score - plain.fit_score, 4);
    assert.equal(hiddenFees.fit_reasons.find(row => row.label === 'Free estimate').points, 4);

    const withoutDoubt = computeFit({ ...peer, research: research('Without a doubt the best financing') });
    assert.equal(withoutDoubt.fit_score - plain.fit_score, 3);
    assert.equal(withoutDoubt.fit_reasons.find(row => row.label === 'Financing').points, 3);

    const withoutAny = computeFit({ ...peer, research: research('Service without any financing') });
    assert.equal(withoutAny.fit_score, plain.fit_score);
    assert.equal(signalPoints(withoutAny), 0);

    const stillOn = [
      ['no-hassle free estimates', 4, 'Free estimate'],
      ['No hassle free estimates', 4, 'Free estimate'],
      ['No pressure free estimates', 4, 'Free estimate'],
      ['no hassle, free estimates', 4, 'Free estimate'],
      ['No, free estimates', 4, 'Free estimate'],
      ['No more breakdowns with a new installation', 3, 'Installation'],
      ['No more high bills with financing', 3, 'Financing'],
      ['No more sweaty nights with our AC replacement', 4, 'Replacement'],
      ['No more waiting for free estimates', 4, 'Free estimate'],
      ['No more waiting and free estimates', 4, 'Free estimate'],
      ['No interest financing', 3, 'Financing'],
      ['no-interest financing', 3, 'Financing'],
      ['No risk financing', 3, 'Financing'],
    ];
    for (const [text, weight, label] of stillOn) {
      const fit = computeFit({ ...peer, research: research(text) });
      assert.equal(fit.fit_score - plain.fit_score, weight, text);
      assert.equal(fit.fit_reasons.find(row => row.label === label).points, weight, text);
      assert.equal(signalPoints(fit), weight, text);
    }

    const dontWaitComma = computeFit({
      ...peer,
      research: research("Don't wait, call for a free estimate"),
    });
    assert.equal(dontWaitComma.fit_score - plain.fit_score, 4, "Don't wait, call for a free estimate");
    assert.equal(dontWaitComma.fit_reasons.find(row => row.label === 'Free estimate').points, 4);
    assert.equal(signalPoints(dontWaitComma), 4);

    const dontWaitDash = computeFit({
      ...peer,
      research: research("Don't wait - call today for a free estimate"),
    });
    assert.equal(dontWaitDash.fit_score - plain.fit_score, 4, "Don't wait - call today for a free estimate");
    assert.equal(dontWaitDash.fit_reasons.find(row => row.label === 'Free estimate').points, 4);
    assert.equal(signalPoints(dontWaitDash), 4);

    const seriously = computeFit({
      ...peer,
      research: research("Don't wait, seriously, call for a free estimate"),
    });
    assert.equal(seriously.fit_score - plain.fit_score, 4, "Don't wait, seriously, call for a free estimate");
    assert.equal(seriously.fit_reasons.find(row => row.label === 'Free estimate').points, 4);
    assert.equal(signalPoints(seriously), 4);

    // The comma is flush against the phrase, so main's wide window does not
    // reach it. This stays +3, the same score as main.
    const sadly = computeFit({
      ...peer,
      research: research('We do not offer, sadly, financing'),
    });
    assert.equal(sadly.fit_score - plain.fit_score, 3, 'We do not offer, sadly, financing');
    assert.equal(sadly.fit_reasons.find(row => row.label === 'Financing').points, 3);
    assert.equal(signalPoints(sadly), 3);

    const sorry = computeFit({
      ...peer,
      research: research("We don't offer, sorry, financing"),
    });
    assert.equal(sorry.fit_score - plain.fit_score, 3, "We don't offer, sorry, financing");
    assert.equal(sorry.fit_reasons.find(row => row.label === 'Financing').points, 3);
    assert.equal(signalPoints(sorry), 3);

    const callToday = computeFit({
      ...peer,
      research: research("Don't wait, call today, for a free estimate"),
    });
    assert.equal(callToday.fit_score - plain.fit_score, 4, "Don't wait, call today, for a free estimate");
    assert.equal(callToday.fit_reasons.find(row => row.label === 'Free estimate').points, 4);
    assert.equal(signalPoints(callToday), 4);

    const imperativeBreaks = [
      ["Don't wait; call for a free estimate", 4, 'Free estimate'],
      ["Don't wait -- call for a free estimate", 4, 'Free estimate'],
      ["Don't wait: call for a free estimate", 4, 'Free estimate'],
      ['Do not wait, call for a free estimate', 4, 'Free estimate'],
      ['Don\u2019t wait, call for a free estimate', 4, 'Free estimate'],
      ['Don\u2018t wait, call for a free estimate', 4, 'Free estimate'],
      ["DON'T WAIT, CALL FOR A FREE ESTIMATE", 4, 'Free estimate'],
      ["Don't miss out, call for a free estimate", 4, 'Free estimate'],
      ["Don't hesitate, call for a free estimate", 4, 'Free estimate'],
      ["Don't delay, call for a free estimate", 4, 'Free estimate'],
      ["Don't forget, call for a free estimate", 4, 'Free estimate'],
      ["Don't worry, call for a free estimate", 4, 'Free estimate'],
      ["Don't sweat, call for a free estimate", 4, 'Free estimate'],
      ['Call now. Don\'t wait, call for a free estimate', 4, 'Free estimate'],
      ["Don't wait, at this time, our free estimates", 4, 'Free estimate'],
      ['Don\u2019t wait \u2013 call for a free estimate', 4, 'Free estimate'],
      ['Don\u2019t wait \u2014 call for a free estimate', 4, 'Free estimate'],
    ];
    for (const [text, weight, label] of imperativeBreaks) {
      const fit = computeFit({ ...peer, research: research(text) });
      assert.equal(fit.fit_score - plain.fit_score, weight, text);
      assert.equal(fit.fit_reasons.find(row => row.label === label).points, weight, text);
      assert.equal(signalPoints(fit), weight, text);
    }

    // Main already scores these. The imperative cut does not zero them.
    const ctaAsides = [
      ["Don't settle, family owned, free estimates", 4, 'Free estimate'],
      ["Don't settle, family-owned, free estimates", 4, 'Free estimate'],
      ["Don't overpay, family owned, financing available", 3, 'Financing'],
      ["Don't wait, family owned and operated, financing available", 3, 'Financing'],
      ["Don't wait, apply today, financing available", 3, 'Financing'],
      ["Don't pay more, apply today, financing", 3, 'Financing'],
      ["Don't wait, apply online, free estimates", 4, 'Free estimate'],
      ["Don't wait, only $49, free estimates", 4, 'Free estimate'],
      ["Don't sweat, locally owned, free estimates", 4, 'Free estimate'],
      ["Don't overpay, friendly service, free estimates", 4, 'Free estimate'],
      ["Don't wait, daily specials, financing available", 3, 'Financing'],
      ["Don't wait, monthly payments, financing available", 3, 'Financing'],
      ["Don't wait, July only, free estimates", 4, 'Free estimate'],
      ["Don't wait, early, free estimates", 4, 'Free estimate'],
      ["Don't wait, supply chain ready, replacement available", 4, 'Replacement'],
      ["Don't wait, honestly, financing available", 3, 'Financing'],
      ["Don't wait, really, free estimates", 4, 'Free estimate'],
    ];
    for (const [text, weight, label] of ctaAsides) {
      const fit = computeFit({ ...peer, research: research(text) });
      assert.equal(fit.fit_score - plain.fit_score, weight, text);
      assert.equal(fit.fit_reasons.find(row => row.label === label).points, weight, text);
      assert.equal(signalPoints(fit), weight, text);
    }

    const afterSentence = computeFit({
      ...peer,
      research: research('No. We offer financing on replacements.'),
    });
    assert.equal(afterSentence.fit_reasons.find(row => row.label === 'Financing').points, 3);
    assert.equal(afterSentence.fit_reasons.find(row => row.label === 'Replacement').points, 4);

    const lender = computeFit({
      ...peer,
      research: research('We do not offer financing.', { signals: { financing: ['GreenSky'] } }),
    });
    assert.equal(lender.fit_reasons.find(row => row.label === 'Financing').points, 3);
  });

  it('does not cut a CTA through a negator, a newline, or a title join', () => {
    const plain = computeFit(peer);
    // pageText joins a heading to the next paragraph with spaces. The first
    // comma is inside the refusal, so the CTA cut must not throw that negator away.
    const joinedHeading = [
      ["Don't wait We do not offer, at this time, any kind of financing", 'do not offer'],
      ["Don't wait We do not, unfortunately, offer financing", 'unfortunately'],
      ["Don't delay We do not yet offer, in your area, any kind of financing", 'do not yet'],
      ["Don't wait We cannot provide, for now, your free estimate", 'cannot provide'],
      ["Don't Sweat It We cannot provide, for now, your free estimate", 'sweat it cannot'],
      ["Don't Forget We do not offer, at this time, any kind of financing", 'forget'],
      ["Don't Miss Out We do not offer, at this time, any kind of financing", 'miss out'],
      ["Don't wait We do not offer, at this time, our financing", 'our financing'],
      ["Don't wait We do not have, at this time, a quote form", 'quote form'],
      ["Don't Sweat It We do not offer, for now, a contact form", 'contact form'],
      ["Don't wait--we do not offer, at this time, any kind of financing", 'unspaced double hyphen'],
      ["Don't wait-we do not offer, at this time, any kind of financing", 'unspaced hyphen'],
      ["Don't wait--we do not, unfortunately, offer financing", 'unspaced unfortunately'],
      ["Don't wait--we do not yet offer, in your area, any kind of financing", 'unspaced do not yet'],
      ["Don't wait-we cannot provide, for now, your free estimate", 'unspaced cannot'],
      ["Don't wait--we do not have, at this time, a quote form", 'unspaced quote form'],
      ["Don't wait-we do not offer, for now, a contact form", 'unspaced contact form'],
    ];
    for (const [text, name] of joinedHeading) {
      const fit = computeFit({ ...peer, research: research(text) });
      assert.equal(fit.fit_score, plain.fit_score, name);
      assert.equal(signalPoints(fit), 0, name);
    }

    const fields = [
      ['title pipe', "Don't Wait | Wasatch Heating", '', 'We do not offer, at this time, any kind of financing'],
      ['title pipe long', "Don't Wait | Wasatch Heating and Air", '', 'We do not offer, at this time, any kind of financing'],
      ['meta description', 'Acme Heating', "Don't wait", 'We do not offer, at this time, any kind of financing'],
      ['title unfortunately', "Don't Wait | Wasatch Heating", '', 'We do not, unfortunately, offer financing'],
      ['meta unfortunately', 'Acme Heating', "Don't wait", 'We do not, unfortunately, offer financing'],
      ['title do not yet', "Don't Delay | Wasatch Heating", '', 'We do not yet offer, in your area, any kind of financing'],
      ['meta do not yet', 'Acme Heating', "Don't delay", 'We do not yet offer, in your area, any kind of financing'],
      ['title cannot', "Don't Sweat It | Acme Heating", '', 'We cannot provide, for now, your free estimate'],
      ['meta cannot', 'Acme Heating', "Don't sweat it", 'We cannot provide, for now, your free estimate'],
      ['title our financing', "Don't Forget | Wasatch Heating", '', 'We do not offer, at this time, our financing'],
      ['title quote form', "Don't Wait | Wasatch Heating", '', 'We do not have, at this time, a quote form'],
      ['meta quote form', 'Acme Heating', "Don't wait", 'We do not have, at this time, a quote form'],
      ['title contact form', "Don't Sweat It | Acme Heating", '', 'We do not offer, for now, a contact form'],
      ['meta contact form', 'Acme Heating', "Don't Miss Out", 'We do not offer, for now, a contact form'],
      ['pipe in the body', 'Home', '', "Don't Wait | Wasatch Heating We do not offer, at this time, any kind of financing"],
    ];
    for (const [name, title, description, text] of fields) {
      const fit = computeFit({ ...peer, research: research(text, { title, description }) });
      assert.equal(fit.fit_score, plain.fit_score, name);
      assert.equal(signalPoints(fit), 0, name);
    }

    const afterPeriod = computeFit({
      ...peer,
      research: research("Don't wait We do not offer, at this time, any kind of financing. Call for a free estimate."),
    });
    assert.equal(afterPeriod.fit_score - plain.fit_score, 4, 'heading refusal then a real estimate');
    assert.equal(signalPoints(afterPeriod), 4, 'heading refusal then a real estimate');
    assert.equal(afterPeriod.fit_reasons.some(row => row.label === 'Financing'), false);
    assert.equal(afterPeriod.fit_reasons.find(row => row.label === 'Free estimate').points, 4);

    const titledPeriod = computeFit({
      ...peer,
      research: research(
        'We do not offer, at this time, any kind of financing. Call for a free estimate.',
        { title: "Don't Wait | Wasatch Heating" },
      ),
    });
    assert.equal(titledPeriod.fit_score - plain.fit_score, 4, 'title CTA then a refusal and an estimate');
    assert.equal(signalPoints(titledPeriod), 4, 'title CTA then a refusal and an estimate');
    assert.equal(titledPeriod.fit_reasons.some(row => row.label === 'Financing'), false);

    const stillCalls = [
      ["Don't wait, call for a free estimate", 4, 'Free estimate'],
      ["Don't wait - call today for a free estimate", 4, 'Free estimate'],
      ["Don't wait, seriously, call for a free estimate", 4, 'Free estimate'],
      ["Don't sweat it, call for a free estimate", 4, 'Free estimate'],
      ["Don't miss out, call for a free estimate", 4, 'Free estimate'],
      // "charge" is not a negator. Main scores this 0. The comma after wait is the cut.
      ["Don't wait, we charge for free estimates", 4, 'Free estimate'],
    ];
    for (const [text, weight, label] of stillCalls) {
      const fit = computeFit({ ...peer, research: research(text) });
      assert.equal(fit.fit_score - plain.fit_score, weight, text);
      assert.equal(fit.fit_reasons.find(row => row.label === label).points, weight, text);
      assert.equal(signalPoints(fit), weight, text);
    }

    const bodyCta = computeFit({
      ...peer,
      research: research("Don't wait, call for a free estimate", {
        title: "Don't Wait | Wasatch Heating",
        description: "Don't wait",
      }),
    });
    assert.equal(bodyCta.fit_score - plain.fit_score, 4, 'body CTA after a titled don\'t');
    assert.equal(signalPoints(bodyCta), 4, 'body CTA after a titled don\'t');

    const metaCta = computeFit({
      ...peer,
      research: research('', {
        title: 'Acme Heating',
        description: "Don't wait, call for a free estimate",
      }),
    });
    assert.equal(metaCta.fit_score - plain.fit_score, 4, 'meta description CTA');
    assert.equal(signalPoints(metaCta), 4, 'meta description CTA');
  });

  it('keeps none, nor, neither, unable, and the negator-list guards at main', () => {
    const plain = computeFit(peer);
    const blocked = [
      ["Don't wait, unable to offer financing", 'unable'],
      ["Don't wait None of our plans, sadly, include financing", 'none'],
      ["Don't wait - Neither financing nor free estimates", 'neither nor'],
      ["Don't wait, We are unable to provide financing, sorry", 'unable after comma'],
      ["Don't wait; Neither financing nor free estimates", 'neither after semicolon'],
      ["Don't wait, unavailable financing", 'unavailable'],
      // Bare "no" is in the list. Dropping it lets the cut score financing.
      ["Don't wait, no hassle financing", 'bare no'],
      ["Don't wait no more, call for a free estimate", 'no more'],
      // The n't forms are in the list. Dropping them lets the cut score the estimate.
      ["Don't wait we don't offer, call for a free estimate", 'dont'],
      ['Don\'t wait we don\u2019t offer, call for a free estimate', 'curly dont'],
      ["Don't wait we doesn't offer, call for a free estimate", 'doesnt'],
      ["Don't wait we didn't offer, call for a free estimate", 'didnt'],
      ["Don't wait we isn't offering, call for a free estimate", 'isnt'],
      ["Don't wait we aren't offering, call for a free estimate", 'arent'],
      ["Don't wait we wasn't offering, call for a free estimate", 'wasnt'],
      ["Don't wait we weren't offering, call for a free estimate", 'werent'],
      ["Don't wait we won't offer, call for a free estimate", 'wont'],
      ["Don't wait we can't offer, call for a free estimate", 'cant'],
    ];
    for (const [text, name] of blocked) {
      const fit = computeFit({ ...peer, research: research(text) });
      assert.equal(fit.fit_score, plain.fit_score, name);
      assert.equal(signalPoints(fit), 0, name);
    }

    // The "|" fence is its own boundary. Without it, the first Don't sees the
    // second and the estimate stays 0. With it, the CTA after the bar scores.
    const piped = computeFit({
      ...peer,
      research: research("Don't wait | Don't delay, call for a free estimate"),
    });
    assert.equal(piped.fit_score - plain.fit_score, 4, 'pipe boundary');
    assert.equal(signalPoints(piped), 4, 'pipe boundary');
    assert.equal(piped.fit_reasons.find(row => row.label === 'Free estimate').points, 4);

    // First break, not the last. The comma after "seriously" is later, and the
    // estimate still scores. The source guard fails if the cut walks to the last break.
    const firstBreak = computeFit({
      ...peer,
      research: research("Don't wait, seriously, call for a free estimate"),
    });
    assert.equal(firstBreak.fit_score - plain.fit_score, 4, 'first break');
    assert.equal(signalPoints(firstBreak), 4, 'first break');

    const signalSrc = fs.readFileSync(path.join(__dirname, '../src/scoring/estimate-signals.js'), 'utf8');
    const cutStart = signalSrc.indexOf('function cutImperativeNegation');
    const cutSrc = signalSrc.slice(cutStart, signalSrc.indexOf('function isNegated'));
    assert.match(cutSrc, /const brk = after\.match\(IMPERATIVE_BREAK_RE\)/);
    assert.match(cutSrc, /mainNegatesBefore\(tail\)/);
    assert.match(cutSrc, /SPAN_NEGATOR_RE\.test\(tail\)/);
    assert.match(cutSrc, /isSentenceStart\(/);
    assert.match(cutSrc, /lastIndexOf\('\|'\)/);
    assert.doesNotMatch(cutSrc, /matchAll|length - 1|\.pop\(\)/);
  });

  it('keeps n\'t, no-words, except, only, hardly, and a mid-sentence Don\'t at main', () => {
    const plain = computeFit(peer);
    const blocked = [
      ["Don't wait, you shouldn't ask for a free estimate", 'shouldnt'],
      ['Don\'t wait, you shouldn\u2019t ask for a free estimate', 'curly shouldnt'],
      ["Don't delay, we wouldn't offer financing", 'wouldnt'],
      ["Don't settle, we haven't offered free estimates", 'havent'],
      ["Don't wait, nobody gets a free estimate", 'nobody'],
      ["Don't worry, nothing covers a free estimate", 'nothing'],
      ["Don't settle, we do everything except free estimates", 'except'],
      ["Don't wait, only paid free estimates", 'only'],
      ["Don't wait, we hardly offer a free estimate", 'hardly'],
      [
        'Please remember that Don\'t wait, absolutely positively definitely certainly completely seriously now free estimate',
        'mid-sentence',
      ],
    ];
    for (const [text, name] of blocked) {
      const fit = computeFit({ ...peer, research: research(text) });
      assert.equal(fit.fit_score, plain.fit_score, name);
      assert.equal(signalPoints(fit), 0, name);
    }

    // The 80-character slice starts on Don't. The prefix is still in the
    // sentence, and the tail has none of the span negators, so only a real
    // sentence start would let the estimate score.
    const core = "Don't wait, call for a ";
    const aligned = `Please remember that ${core}${' '.repeat(80 - core.length)}free estimate`;
    const mid = computeFit({ ...peer, research: research(aligned) });
    assert.equal(mid.fit_score, plain.fit_score, 'aligned mid-sentence');
    assert.equal(signalPoints(mid), 0, 'aligned mid-sentence');
  });

  it('still penalizes ServiceTitan and caps it after the new boost', () => {
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
    const st = computeFit({ ...sweet, fsm_detected: 'ServiceTitan', research: replacementResearch() });
    assert.equal(st.fit_reasons.find(row => row.label === 'ServiceTitan').points, SERVICETITAN_PENALTY);
    assert.equal(st.fit_reasons.find(row => row.label === 'ServiceTitan').detail, ST_REASON);
    assert.equal(signalPoints(st), 21);
    assert.equal(st.fit_score, 77);
    assert.equal(st.fit_tier, 'B');
    assert.notEqual(st.fit_tier, 'A');
    const cap = st.fit_reasons.find(row => row.label === 'Tier cap');
    assert.ok(cap);
    assert.equal(cap.points, 77 - 100);
    assert.match(cap.detail, /ServiceTitan/);
    assert.ok(labelIndex(st, 'ServiceTitan') < labelIndex(st, 'Tier cap'));
    assert.ok(labelIndex(st, 'Replacement') < labelIndex(st, 'Tier cap'));

    const franchise = computeFit({ ...sweet, company: 'Terminix of Provo', research: replacementResearch() });
    assert.equal(franchise.fit_reasons.find(row => row.label === 'Franchise').points, -20);
    assert.equal(signalPoints(franchise), 21);
    assert.equal(franchise.fit_score, 77);
    assert.equal(franchise.fit_tier, 'B');
    assert.match(franchise.fit_reasons.find(row => row.label === 'Tier cap').detail, /franchise/);
    assert.ok(labelIndex(franchise, 'Franchise') < labelIndex(franchise, 'Tier cap'));

    const both = computeFit({
      ...sweet,
      company: 'Terminix of Provo',
      fsm_detected: ' servicetitan ',
      research: replacementResearch(),
    });
    assert.equal(both.fit_reasons.find(row => row.label === 'Franchise').points, -20);
    assert.equal(both.fit_reasons.find(row => row.label === 'ServiceTitan').points, -15);
    assert.equal(signalPoints(both), 21);
    assert.equal(both.fit_score, 77);
    assert.equal(both.fit_tier, 'B');
    assert.equal(both.fit_reasons.find(row => row.label === 'Tier cap').points, 77 - 86);
  });

  it('leaves existing fixtures on their previous tier', () => {
    let up = 0;
    let down = 0;
    let scoreChanges = 0;
    const rank = { A: 4, B: 3, C: 2, D: 1 };
    for (const [name, row, score, tier] of BEFORE) {
      const fit = computeFit(row);
      assert.equal(fit.fit_score, score, name);
      assert.equal(fit.fit_tier, tier, name);
      assert.equal(signalPoints(fit), 0, name);
      if (fit.fit_score !== score) scoreChanges += 1;
      if (rank[fit.fit_tier] > rank[tier]) up += 1;
      if (rank[fit.fit_tier] < rank[tier]) down += 1;
    }
    assert.equal(up, 0);
    assert.equal(down, 0);
    assert.equal(scoreChanges, 0);
    console.log(`[f-003] existing fixtures: ${BEFORE.length} scored, tier changes ${up + down} (up ${up}, down ${down}), score changes ${scoreChanges}`);
  });

  describe('cache only', () => {
    before(() => resetDb());
    after(async () => {
      _setSearch(null);
      await closePool();
    });

    it('computeFit and rescore do no HTTP and do not add Places queries', async () => {
      const row = await insertProspect({
        google_place_id: 'test-place-f003-replacement',
        company: 'TEST: Denver Heating',
        city: 'Denver',
        state: 'CO',
        review_count: 20,
        rating: 4.0,
      });
      const plumbing = await insertProspect({
        google_place_id: 'test-place-f003-plumbing',
        company: 'TEST: Denver Plumbing',
        industry: 'Plumbing',
        city: 'Denver',
        state: 'CO',
        review_count: 20,
        rating: 4.0,
      });
      const cache = replacementResearch();
      await pool.query('UPDATE prospects SET research = $2::jsonb WHERE id = ANY($1::int[])', [
        [row.id, plumbing.id], JSON.stringify(cache),
      ]);

      let placesCalls = 0;
      _setSearch(() => {
        placesCalls += 1;
        throw new Error('Places must not be called from scoring');
      });
      const guard = armNoFetch();
      try {
        const mem = computeFit({ ...peer, research: cache });
        assert.equal(mem.fit_score, 100);
        const n = await rescore();
        assert.equal(n, 2);
        assert.equal(placesCalls, 0);
        assert.deepEqual(guard.hits, []);
        assert.equal(catalog.length, PLACES_QUERIES.length);
        assert.equal(INDUSTRIES.length, PLACES_QUERIES.length);
      } finally {
        guard.restore();
        _setSearch(null);
      }

      const saved = await pool.query(
        'SELECT id, fit_score, fit_tier, fit_reasons, industry FROM prospects ORDER BY id'
      );
      const byId = new Map(saved.rows.map(item => [item.id, item]));
      assert.equal(byId.get(row.id).fit_score, 100);
      assert.equal(byId.get(row.id).fit_tier, 'A');
      assert.equal(byId.get(row.id).fit_reasons.find(item => item.label === 'Replacement').points, 4);
      assert.equal(byId.get(plumbing.id).fit_score, 76);
      assert.equal(byId.get(plumbing.id).fit_reasons.some(item => item.label === 'Replacement'), false);
    });
  });
});
