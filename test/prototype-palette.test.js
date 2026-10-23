process.env.CRM_API_KEY = 'test-prototype-palette-key-32chars-m!';
require('./preload');

// Brand colors read from a shop's own site for the prototype page.
// The site is served by the in-process mock transport; no real fetch.

const http = require('http');
const express = require('express');
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { _setResolver, _setTransport } = require('../src/net/safeFetch');
const { mockTransport, requestedUrl } = require('./mock-transport');
const palette = require('../src/prototypes/palette');
const { extractPalette, detectBrandColors } = palette;
const { resetDb, insertProspect, closePool, pool } = require('./fixtures');

const FALLBACK_PRIMARY = '#2f6b57';
const FALLBACK_SECONDARY = '#1e2a2f';
const detectCalls = [];
const realDetect = palette.detectBrandColors;
let budgetNow = 0;
let advanceMs = 0;

function call(port, method, path, body) {
  return new Promise((resolve, reject) => {
    const payload = body == null ? null : Buffer.from(JSON.stringify(body));
    const headers = { 'x-api-key': process.env.CRM_API_KEY };
    if (payload) {
      headers['content-type'] = 'application/json';
      headers['content-length'] = String(payload.length);
    }
    const req = http.request({ hostname: '127.0.0.1', port, path, method, headers }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch { /* html or empty */ }
        resolve({ status: res.statusCode, json, text });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

// A WordPress-style plumbing site: navy/blue brand with a yellow accent,
// plus the usual neutrals and a WordPress admin blue that must be ignored.
const HOME = `<!doctype html><html><head>
<meta name="theme-color" content="#0a3d7a">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Roboto">
<link rel="stylesheet" href="/wp-content/themes/plumbpro/style.css?ver=3">
<style>:root{--brand-primary:#0a3d7a;--brand-accent:#ffc20e}</style>
</head><body><header class="site-header">Sample</header><a href="#" style="color:#2271b1">x</a></body></html>`;
const CSS = `body{color:#333;background:#fff}.site-header{background:#0a3d7a;color:#fff}
.btn-primary,.cta-button{background-color:#ffc20e;color:#0a3d7a}.top-bar{background:#062a55}
footer{background:#1b1b1b;color:#ccc}a{color:#0a3d7a}.wp-admin{color:#2271b1}`;

describe('prototype brand colors', () => {
  const calls = [];
  let server;
  let port;
  before(async () => {
    await resetDb();
    palette.detectBrandColors = async (website, opts) => {
      detectCalls.push(website);
      return realDetect(website, opts);
    };
    _setResolver({ async resolve4() { return ['8.8.8.8']; }, async resolve6() { return []; } });
    _setTransport(mockTransport((options) => {
      const url = requestedUrl(options);
      calls.push(url);
      if (url === 'https://ericsplumbing.example/') return { status: 200, headers: { 'content-type': 'text/html' }, body: HOME };
      if (url.startsWith('https://ericsplumbing.example/wp-content/themes/plumbpro/style.css')) return { status: 200, headers: { 'content-type': 'text/css' }, body: CSS };
      if (url === 'https://nocolor.example/') return { status: 200, headers: { 'content-type': 'text/html' }, body: '<html><body style="color:#222;background:#fafafa">Hi</body></html>' };
      if (url === 'https://jsonhome.example/') return { status: 200, headers: { 'content-type': 'application/json' }, body: '{"theme":"#0a3d7a"}' };
      if (url.startsWith('https://budget.example/')) {
        budgetNow += advanceMs;
        if (url.endsWith('.css')) return { status: 200, headers: { 'content-type': 'text/css' }, body: '.btn{background:#123456}' };
        return {
          status: 200,
          headers: { 'content-type': 'text/html' },
          body: `<html><head>
            <link rel="stylesheet" href="/a.css">
            <link rel="stylesheet" href="/b.css">
            <link rel="stylesheet" href="/c.css">
            <link rel="stylesheet" href="/d.css">
            </head><body></body></html>`,
        };
      }
      return { status: 404, headers: {}, body: '' };
    }));
    const app = express();
    app.use('/api', require('../src/api/auth'));
    app.use('/api/prototypes', require('../src/api/prototypes'));
    server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = server.address().port;
  });
  after(async () => {
    palette.detectBrandColors = realDetect;
    _setResolver(null);
    _setTransport(null);
    if (server) await new Promise((resolve) => server.close(resolve));
    await closePool();
  });

  it('scores theme-color, brand variables, and header/button colors; ignores neutrals and vendor blues', () => {
    const got = extractPalette(HOME, [CSS]);
    assert.equal(got.primary, '#0a3d7a');
    assert.equal(got.secondary, '#ffc20e');
    assert.equal(got.confident, true);
    assert.equal(got.swatches.some(s => s.hex === '#2271b1'), false);
    assert.equal(got.swatches.some(s => ['#333333', '#ffffff', '#1b1b1b', '#cccccc'].includes(s.hex)), false);
    const none = extractPalette('<p>plain</p>', ['body{color:#222;background:#fafafa}']);
    assert.equal(none.primary, null);
    const wix = extractPalette('<style>:root{--color_11:255,255,255;--wix-color-primary:rgb(200, 16, 46)}</style>', ['.header{background:rgb(200,16,46)}']);
    assert.equal(wix.primary, '#c8102e');
  });

  it('page theme: navy keeps navy with dark text on yellow; red brands get a charcoal hero; light colors are darkened', () => {
    const { theme } = require('../src/prototypes/page');
    const navy = theme('#0a3d7a', '#ffc20e');
    assert.equal(navy.brand, '#0A3D7A');
    assert.equal(navy.heroBg, '#0A3D7A');
    assert.equal(navy.accent, '#FFC20E');
    assert.equal(navy.onAccent, '#1C2430');
    const red = theme('#c8102e', '#1e2a2f');
    assert.equal(red.warm, true);
    assert.equal(red.heroBg, '#1C2430');
    assert.equal(red.accent, '#C8102E');
    const lone = theme('#1565c0', null);
    assert.equal(lone.accent, '#FFC845');
    const pale = theme('#9ad0ff', null);
    assert.notEqual(pale.brand, '#9AD0FF');
  });

  it('reads the homepage and its theme stylesheet through safeFetch, skipping font CSS', async () => {
    calls.length = 0;
    const got = await detectBrandColors('ericsplumbing.example');
    assert.equal(got.primary, '#0a3d7a');
    assert.equal(got.secondary, '#ffc20e');
    assert.equal(got.sheets, 1);
    assert.equal(calls.some(u => u.includes('fonts.googleapis')), false);
    const bad = await detectBrandColors('https://nowhere.example/');
    assert.ok(bad.error);
    console.log(`[prototype-palette] detected ${got.primary} / ${got.secondary} from ${calls.length} requests`);
  });

  it('CRM create uses fallback colors and does not call detectBrandColors; match-site calls it once', async () => {
    detectCalls.length = 0;
    const transportBefore = calls.length;
    const p = await insertProspect({ company: 'TEST: Erics Plumbing', industry: 'Plumbing', city: 'Spanish Fork', state: 'UT', website: 'https://ericsplumbing.example/', google_place_id: 'test-place-palette-1' });
    const stored = await pool.query(
      `SELECT p.research, (SELECT COUNT(*)::int FROM prospect_brands b WHERE b.prospect_id = p.id) AS brands
         FROM prospects p WHERE p.id = $1`,
      [p.id]
    );
    assert.equal(stored.rows[0].research, null);
    assert.equal(stored.rows[0].brands, 0);

    const made = await call(port, 'POST', '/api/prototypes', { prospect_id: p.id });
    assert.equal(made.status, 200);
    assert.equal(detectCalls.length, 0);
    assert.equal(calls.length, transportBefore);
    assert.equal(made.json.prototype.colors.primary, FALLBACK_PRIMARY);
    assert.equal(made.json.prototype.colors.secondary, FALLBACK_SECONDARY);
    const cached = await pool.query(`SELECT research->'site'->'brand_colors'->>'primary' AS c FROM prospects WHERE id = $1`, [p.id]);
    assert.equal(cached.rows[0].c, null);

    const matched = await call(port, 'POST', `/api/prototypes/${made.json.prototype.id}/match-site`);
    assert.equal(matched.status, 200);
    assert.equal(detectCalls.length, 1);
    assert.equal(detectCalls[0], 'https://ericsplumbing.example/');
    assert.ok(calls.length > transportBefore);
    assert.equal(matched.json.prototype.colors.primary, '#0a3d7a');
    assert.equal(matched.json.prototype.colors.secondary, '#ffc20e');
    assert.ok(matched.json.swatches.length >= 2);

    detectCalls.length = 0;
    const q = await insertProspect({ company: 'TEST: No Color Co', industry: 'Plumbing', state: 'UT', website: 'https://nocolor.example/', google_place_id: 'test-place-palette-2' });
    const plain = await call(port, 'POST', '/api/prototypes', { prospect_id: q.id });
    assert.equal(plain.status, 200);
    assert.equal(detectCalls.length, 0);
    assert.equal(plain.json.prototype.colors.primary, FALLBACK_PRIMARY);
    const missed = await call(port, 'POST', `/api/prototypes/${plain.json.prototype.id}/match-site`);
    assert.equal(missed.status, 422);
    assert.equal(missed.json.code, 'no_colors');
    assert.equal(detectCalls.length, 1);
    assert.equal(detectCalls[0], 'https://nocolor.example/');
    console.log('[prototype-palette] CRM create did not fetch; match-site called detectBrandColors once');
  });

  it('create uses cached research colors in primary then secondary order, and a brand row wins', async () => {
    const cached = await insertProspect({
      company: 'TEST: Cached Colors',
      industry: 'Plumbing',
      state: 'UT',
      website: 'https://cached.example/',
      google_place_id: 'test-place-palette-cached',
    });
    await pool.query(
      `UPDATE prospects SET research = $2::jsonb WHERE id = $1`,
      [cached.id, JSON.stringify({ site: { brand_colors: { primary: '#123456', secondary: '#abcdef' } } })]
    );
    const made = await call(port, 'POST', '/api/prototypes', { prospect_id: cached.id });
    assert.equal(made.status, 200);
    assert.equal(made.json.prototype.colors.primary, '#123456');
    assert.equal(made.json.prototype.colors.secondary, '#abcdef');
    assert.equal(detectCalls.includes('https://cached.example/'), false);

    const partial = await insertProspect({
      company: 'TEST: Partial Cache',
      industry: 'Plumbing',
      state: 'UT',
      google_place_id: 'test-place-palette-partial',
    });
    await pool.query(
      `UPDATE prospects SET research = $2::jsonb WHERE id = $1`,
      [partial.id, JSON.stringify({ site: { brand_colors: { primary: '#654321' } } })]
    );
    const partialMade = await call(port, 'POST', '/api/prototypes', { prospect_id: partial.id });
    assert.equal(partialMade.json.prototype.colors.primary, '#654321');
    assert.equal(partialMade.json.prototype.colors.secondary, FALLBACK_SECONDARY);

    const branded = await insertProspect({
      company: 'TEST: Brand Wins',
      industry: 'Plumbing',
      state: 'UT',
      google_place_id: 'test-place-palette-brand',
    });
    await pool.query(
      `UPDATE prospects SET research = $2::jsonb WHERE id = $1`,
      [branded.id, JSON.stringify({ site: { brand_colors: { primary: '#123456', secondary: '#abcdef' } } })]
    );
    await pool.query(
      `INSERT INTO prospect_brands (prospect_id, name, logo_url, colors, source, test_tag)
       VALUES ($1, 'TEST: Brand Wins', NULL, $2::jsonb, 'manual', 'TEST:brand-wins')`,
      [branded.id, JSON.stringify(['#111111', '#222222'])]
    );
    const brandMade = await call(port, 'POST', '/api/prototypes', { prospect_id: branded.id });
    assert.equal(brandMade.json.prototype.colors.primary, '#111111');
    assert.equal(brandMade.json.prototype.colors.secondary, '#222222');
    console.log('[prototype-palette] cached colors keep primary then secondary; a brand row wins');
  });

  it('match-site refuses a non-http scheme, a non-html homepage, and stacks fetches under one budget', async () => {
    const before = calls.length;
    const js = await detectBrandColors('javascript:alert(1)');
    const ftp = await detectBrandColors('ftp://files.example/a');
    const file = await detectBrandColors('file:///etc/passwd');
    assert.ok(js.error);
    assert.ok(ftp.error);
    assert.ok(file.error);
    assert.equal(calls.length, before);

    const jsonHome = await detectBrandColors('https://jsonhome.example/');
    assert.ok(jsonHome.error);
    assert.equal(jsonHome.primary, undefined);

    advanceMs = 5000;
    budgetNow = 1_000_000;
    const timeouts = [];
    const budgeted = await detectBrandColors('https://budget.example/', {
      now: () => budgetNow,
      timeouts,
    });
    advanceMs = 0;
    assert.deepEqual(timeouts, [12000, 7000, 2000]);
    assert.equal(timeouts.every((ms) => ms <= palette.TOTAL_BUDGET_MS), true);
    assert.ok(budgeted.primary || budgeted.error || budgeted.sheets >= 0);
    console.log(`[prototype-palette] scheme and content-type refused before a parse; budget timeouts ${timeouts.join(',')}`);
  });

  it('match-site rate limit stops further fetches, and the 502 message is one sentence', async () => {
    const { _setMatchLimitForTests, _resetMatchLimitForTests } = require('../src/prototypes/match-limit');
    _setMatchLimitForTests({ max: 2, windowMs: 60_000 });
    try {
      const p = await insertProspect({
        company: 'TEST: Rate Limit Co',
        industry: 'Plumbing',
        state: 'UT',
        website: 'https://ericsplumbing.example/',
        google_place_id: 'test-place-palette-limit',
      });
      const made = await call(port, 'POST', '/api/prototypes', { prospect_id: p.id });
      detectCalls.length = 0;
      const first = await call(port, 'POST', `/api/prototypes/${made.json.prototype.id}/match-site`);
      const second = await call(port, 'POST', `/api/prototypes/${made.json.prototype.id}/match-site`);
      assert.equal(first.status, 200);
      assert.equal(second.status, 200);
      assert.equal(detectCalls.length, 2);
      const third = await call(port, 'POST', `/api/prototypes/${made.json.prototype.id}/match-site`);
      assert.equal(third.status, 429);
      assert.equal(third.json.code, 'match_limited');
      assert.equal(detectCalls.length, 2);

      const dead = await insertProspect({
        company: 'TEST: Unreadable Site',
        industry: 'Plumbing',
        state: 'UT',
        website: 'https://nowhere.example/',
        google_place_id: 'test-place-palette-502',
      });
      const deadProto = await call(port, 'POST', '/api/prototypes', { prospect_id: dead.id });
      const failed = await call(port, 'POST', `/api/prototypes/${deadProto.json.prototype.id}/match-site`);
      assert.equal(failed.status, 502);
      assert.equal(failed.json.error, "Couldn't read their site.");
      assert.equal(failed.json.code, 'fetch_failed');
      console.log('[prototype-palette] match-site limited at 2; 502 message is one sentence');
    } finally {
      _resetMatchLimitForTests();
    }
  });
});
