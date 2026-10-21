process.env.CRM_API_KEY = 'test-prototype-palette-key-32chars-m!';
require('./preload');

// Brand colors read from a shop's own site for the prototype page.
// The site is served by the in-process mock transport; no real fetch.

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { _setResolver, _setTransport } = require('../src/net/safeFetch');
const { mockTransport, requestedUrl } = require('./mock-transport');
const { extractPalette, detectBrandColors } = require('../src/prototypes/palette');
const store = require('../src/prototypes/store');
const { resetDb, insertProspect, closePool, pool } = require('./fixtures');

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
  before(async () => {
    await resetDb();
    _setResolver({ async resolve4() { return ['8.8.8.8']; }, async resolve6() { return []; } });
    _setTransport(mockTransport((options) => {
      const url = requestedUrl(options);
      calls.push(url);
      if (url === 'https://ericsplumbing.example/') return { status: 200, headers: { 'content-type': 'text/html' }, body: HOME };
      if (url.startsWith('https://ericsplumbing.example/wp-content/themes/plumbpro/style.css')) return { status: 200, headers: { 'content-type': 'text/css' }, body: CSS };
      if (url === 'https://nocolor.example/') return { status: 200, headers: { 'content-type': 'text/html' }, body: '<html><body style="color:#222;background:#fafafa">Hi</body></html>' };
      return { status: 404, headers: {}, body: '' };
    }));
  });
  after(async () => { _setResolver(null); _setTransport(null); await closePool(); });

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

  it('a new prototype uses the colors found on the site; Match their website updates an existing one', async () => {
    const p = await insertProspect({ company: 'TEST: Erics Plumbing', industry: 'Plumbing', city: 'Spanish Fork', state: 'UT', website: 'https://ericsplumbing.example/', google_place_id: 'test-place-palette-1' });
    const row = await store.ensurePrototype(p.id);
    assert.equal(row.color_primary, '#0a3d7a');
    assert.equal(row.color_secondary, '#ffc20e');
    const cached = await pool.query(`SELECT research->'site'->'brand_colors'->>'primary' AS c FROM prospects WHERE id = $1`, [p.id]);
    assert.equal(cached.rows[0].c, '#0a3d7a');

    await store.setColors(row.id, { primary: '#2f6b57', secondary: '#1e2a2f' });
    const matched = await store.matchSiteColors(row.id);
    assert.equal(matched.row.color_primary, '#0a3d7a');
    assert.ok(matched.swatches.length >= 2);

    const q = await insertProspect({ company: 'TEST: No Color Co', industry: 'Plumbing', state: 'UT', website: 'https://nocolor.example/', google_place_id: 'test-place-palette-2' });
    const plain = await store.ensurePrototype(q.id);
    assert.equal(plain.color_primary, '#2f6b57');
    await assert.rejects(() => store.matchSiteColors(plain.id), (err) => err.status === 422);
    console.log('[prototype-palette] new prototype took site colors; match-site restored them; no-color site falls back');
  });
});
