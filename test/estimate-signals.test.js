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
