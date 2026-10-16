require('./preload');

// Brand v1 and the prototype rubric. Disposable Postgres, static TEST fixtures,
// and manual entry. Nothing here fetches a logo or resolves DNS.

const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const dns = require('dns');
const axios = require('axios');
const express = require('express');
const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const { BRAND_FIXTURES } = require('../src/brand/fixtures');
const { validateBrand } = require('../src/brand/validate');
const { RUBRIC, rubricRows } = require('../src/scoring/prototypes.config');
const { pickPrototypes, recommendPrototypes, hoursClosedEvenings } = require('../src/scoring/prototypes');
const { loadRubric } = require('../src/scoring/rubric-store');
const { computeFit } = require('../src/scoring/fit');
const { applyMainSchema } = require('../src/db/migrate');
const { resetDb, insertProspect, closePool, pool } = require('./fixtures');

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

function describeCall(label, args) {
  if (label.startsWith('dns')) return String(args[0] == null ? '' : args[0]);
  const first = args[0];
  if (typeof first === 'string' || first instanceof URL) return String(first).slice(0, 200);
  if (first && typeof first === 'object') {
    const host = first.hostname || first.host || '';
    const reqPath = first.path || '';
    return `${host}${reqPath}`.slice(0, 200);
  }
  return '';
}

function watchOutbound() {
  const events = [];
  const undo = [];
  function wrap(obj, key, label) {
    const orig = obj[key];
    assert.equal(typeof orig, 'function', label);
    undo.push(() => { obj[key] = orig; });
    obj[key] = function (...args) {
      events.push({ via: label, detail: describeCall(label, args) });
      return orig.apply(this, args);
    };
  }
  wrap(http, 'request', 'http.request');
  wrap(http, 'get', 'http.get');
  wrap(https, 'request', 'https.request');
  wrap(https, 'get', 'https.get');
  wrap(dns, 'lookup', 'dns.lookup');
  wrap(dns, 'resolve', 'dns.resolve');
  wrap(dns, 'resolve4', 'dns.resolve4');
  wrap(dns, 'resolve6', 'dns.resolve6');
  wrap(dns.promises, 'lookup', 'dns.promises.lookup');
  wrap(dns.promises, 'resolve4', 'dns.promises.resolve4');
  wrap(dns.promises, 'resolve6', 'dns.promises.resolve6');
  wrap(axios, 'get', 'axios.get');
  wrap(axios, 'request', 'axios.request');
  const prevFetch = global.fetch;
  undo.push(() => { global.fetch = prevFetch; });
  global.fetch = function (...args) {
    const target = args[0] && args[0].url ? args[0].url : args[0];
    events.push({ via: 'fetch', detail: String(target).slice(0, 200) });
    return prevFetch.apply(this, args);
  };
  return {
    events,
    restore() { while (undo.length) undo.pop()(); },
  };
}

function offenders(events) {
  return events.filter(event => {
    if (event.via.startsWith('dns') || event.via.startsWith('https') || event.via === 'fetch' || event.via.startsWith('axios')) {
      return true;
    }
    if (/fixtures\.example|logo/i.test(event.detail || '')) return true;
    if (event.via.startsWith('http.') && !/127\.0\.0\.1|localhost/.test(event.detail || '')) return true;
    return false;
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

  it('rejects bad colors and any logo URL that is not http(s) without userinfo', () => {
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
    ];
    for (const logoUrl of badUrls) {
      const result = validateBrand({ ...good, logoUrl });
      assert.equal(result.ok, false, logoUrl);
      assert.equal(result.field, 'logoUrl', logoUrl);
    }

    const httpsLogo = validateBrand({ ...good, logoUrl: 'HTTPS://fixtures.example/test-logo.png' });
    assert.equal(httpsLogo.ok, true);
    assert.equal(httpsLogo.brand.logoUrl, 'https://fixtures.example/test-logo.png');
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
    assert.equal(recommendPrototypes(estimateShop({ state: 'CO' })).disqualified, 'out_of_state');
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
        speed_to_lead: { tieRank: 2, points: { hvac: 50 } },
        estimate_followup: { tieRank: 1, points: { hvac: 50 } },
      },
    });
    assert.deepEqual(tied.map(row => row.agent), ['estimate_followup', 'speed_to_lead']);

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

  it('seeds TEST fixtures and a rubric table that matches the config', async () => {
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
    const banned = /safeFetch|axios|places\.googleapis|api\.anthropic|from\s+['"]dns|require\(['"]dns|https\.request|http\.request|undici/;
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
    const watch = watchOutbound();
    try {
      await pool.query('SELECT 1');
      const before = watch.events.length;

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

      validateBrand({
        name: 'TEST: No Fetch',
        logoUrl: 'https://fixtures.example/test-logo.png',
        colors: ['#112233'],
        source: 'manual',
        testTag: 'TEST:no-fetch',
      });
      pickPrototypes(estimateShop());
      recommendPrototypes(estimateShop(), await loadRubric(pool));

      const during = offenders(watch.events.slice(before));
      assert.deepEqual(during, [], JSON.stringify(during));
      assert.equal(watch.events.slice(before).some(event => event.via.startsWith('dns') || event.via === 'fetch'), false);
    } finally {
      watch.restore();
      await new Promise(resolve => server.close(resolve));
    }
  });

  it('re-applies schema.sql without duplicating fixtures or rubric rows', async () => {
    await resetDb();
    const wiped = await pool.query('SELECT COUNT(*)::int AS n FROM prospect_brands');
    assert.equal(wiped.rows[0].n, 0);
    await applyMainSchema();
    await applyMainSchema();
    const brands = await pool.query(
      `SELECT test_tag FROM prospect_brands WHERE source = 'fixture' ORDER BY test_tag`
    );
    assert.deepEqual(brands.rows.map(row => row.test_tag), ['TEST:canyon-plumbing', 'TEST:wasatch-heating']);
    const rubric = await pool.query('SELECT COUNT(*)::int AS n FROM prototype_rubric');
    assert.equal(rubric.rows[0].n, rubricRows().length);
    const meta = await pool.query('SELECT COUNT(*)::int AS n FROM prototype_rubric_meta');
    assert.equal(meta.rows[0].n, 1);
  });
});
