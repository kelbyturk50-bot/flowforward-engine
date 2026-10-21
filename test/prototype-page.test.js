const STRONG_KEY = 'test-prototype-page-key-32chars-min!!';
process.env.CRM_API_KEY = STRONG_KEY;
delete process.env.FF_PROTOTYPE_ON_DRAFT;

require('./preload');

// The prototype page (sample homepage + agent click-throughs), the CRM
// create/restyle routes, and the one-pager link. Disposable Postgres,
// Anthropic mock, loopback HTTP only. Nothing is sent.

const http = require('http');
const express = require('express');
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { draftProposal, _setClient } = require('../src/proposals/draft');
const { WATERMARK_TEXT } = require('../src/prototypes/page');
const { _resetForTests } = require('../src/pilot/rate-limit');
const { resetDb, insertProspect, fakeClaude, closePool, pool } = require('./fixtures');

function research() {
  return {
    signals: { mentions: { free_estimates: true, financing: true }, online_booking: [], chat_or_text_widget: [], reviews_tools: [] },
    reviews: [{ text: 'They never followed up on my estimate' }],
  };
}

function call(port, method, path, { body, key = STRONG_KEY } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body == null ? null : Buffer.from(JSON.stringify(body));
    const headers = {};
    if (payload) { headers['content-type'] = 'application/json'; headers['content-length'] = String(payload.length); }
    if (key) headers['x-api-key'] = key;
    const req = http.request({ hostname: '127.0.0.1', port, path, method, headers }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch { /* html */ }
        resolve({ status: res.statusCode, headers: res.headers, text, json });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

let n = 0;
async function lead(overrides = {}, res = research()) {
  n += 1;
  const p = await insertProspect({
    website: null, email: `test+page${n}@sample.test`, company: `TEST: Sample Heating ${n}`,
    industry: 'HVAC', city: 'Lehi', state: 'UT', rating: 4.6, review_count: 80, fsm_detected: 'none',
    google_place_id: `test-place-proto-page-${n}`, ...overrides,
  });
  await pool.query(`INSERT INTO proposals (prospect_id, version, status, slug, research, subject, body)
    VALUES ($1, 1, 'draft', $2, $3::jsonb, 'seed', 'seed')`, [p.id, `seed-page-${p.id}`, JSON.stringify(res)]);
  return p;
}

const tokenOf = (url) => String(url).split('/').pop();
const pathOf = (url) => new URL(url).pathname;

describe('prototype page', () => {
  let server; let port;

  before(async () => {
    await resetDb();
    _setClient(fakeClaude());
    const app = express();
    app.set('trust proxy', 1);
    app.use(express.json());
    app.use('/p', require('../src/proposals/onepager').router);
    app.use('/demo/prototype-assets', require('../src/prototypes/page').assets);
    app.use('/demo/prototype', require('../src/prototypes/page').router);
    app.use('/api', require('../src/api/auth'));
    app.use('/api/proposals', require('../src/api/proposals'));
    app.use('/api/prototypes', require('../src/api/prototypes'));
    server = http.createServer(app);
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    port = server.address().port;
  });

  after(async () => {
    _setClient(null);
    if (server) await new Promise(r => server.close(r));
    await closePool();
  });

  it('is on by default: a draft makes a prototype with an absolute link', async () => {
    delete process.env.FF_PROTOTYPE_ON_DRAFT;
    const p = await lead();
    const proposal = await draftProposal(p.id);
    const got = await call(port, 'GET', `/api/proposals/${proposal.id}`);
    assert.equal(got.status, 200);
    assert.match(got.json.prototype.url, /^http:\/\/127\.0\.0\.1:3000\/demo\/prototype\/[A-Za-z0-9_-]{43}$/);
    assert.equal(got.json.prototype.agent_type, 'estimate_followup');
    assert.equal(got.json.prototype.expired, false);
    assert.equal(got.json.prototype.link_problem, null);
    console.log(`[prototype-page] default on: ${pathOf(got.json.prototype.url).slice(0, 24)}…`);
  });

  it('renders the sample site and four agents with the watermark, CTA, and no outside requests', async () => {
    _resetForTests();
    const p = await lead({ company: 'TEST: Yellow Heating', industry: 'HVAC' });
    const made = await call(port, 'POST', '/api/prototypes', { body: { prospect_id: p.id } });
    assert.equal(made.status, 200);
    await call(port, 'PATCH', `/api/prototypes/${made.json.prototype.id}`, { body: { colors: { primary: '#F5E050', secondary: '#14213D' } } });
    const page = await call(port, 'GET', `${pathOf(made.json.prototype.url)}?watermark=0&flags=FF_HIDE_WATERMARK`, { key: '' });
    assert.equal(page.status, 200);
    assert.match(page.headers['content-type'], /text\/html/);
    assert.equal(page.headers['x-robots-tag'], 'noindex, nofollow');
    assert.match(page.headers['content-security-policy'], /default-src 'none'/);
    assert.equal(page.headers['cache-control'], 'no-store');
    const html = page.text;
    assert.ok(html.includes(`<p class="pt-ribbon" role="note" data-prototype-watermark="true">${WATERMARK_TEXT}</p>`));
    assert.ok(html.includes('data-prototype-tile="true"'));
    assert.ok(html.includes('Concept by FlowForward, sample data, not affiliated with or endorsed by'));
    assert.ok(html.includes('This preview link expires 14 days after it was shared'));
    for (const id of ['site', 'estimate', 'lead', 'missed', 'booking']) assert.ok(html.includes(`data-panel="${id}"`), id);
    for (const anchor of ['$0', 'typically $1.5–3.5K', 'typically $150–400/mo', 'typically $125–200/hr', 'Typical starting ranges; final scope after a call.']) {
      assert.ok(html.includes(anchor), anchor);
    }
    assert.match(html, /<a class="pt-btn pt-talk" href="https:\/\/calendly\.com\//);
    // Yellow is darkened for contrast (prototype-system.md §2).
    assert.ok(html.includes('--a:#7D7000'));
    // Only Kelby's booking link and email leave the page; fonts are self-hosted.
    const urls = html.match(/https?:\/\/[^"'\s)<]+/g) || [];
    const outside = urls.filter(u => !/^https:\/\/calendly\.com\//.test(u) && !/^http:\/\/www\.w3\.org\/2000\/svg/.test(u));
    assert.deepEqual(outside, []);
    assert.equal(/<img|<iframe|fetch\(|XMLHttpRequest|sendBeacon|<form[^>]*action=/i.test(html), false);
    assert.equal(/logo/i.test(html), false);
    const font = await call(port, 'GET', '/demo/prototype-assets/barlow-latin-600-normal.woff2', { key: '' });
    assert.equal(font.status, 200);
    console.log(`[prototype-page] page ${html.length} bytes, 5 panels, watermark present with ?watermark=0, outside urls 0`);
  });

  it('escapes a hostile business name and the watermark stays', async () => {
    const p = await lead({ company: 'TEST: <style>.pt-ribbon{display:none}</style></div><script>alert(1)</script>' });
    const made = await call(port, 'POST', '/api/prototypes', { body: { prospect_id: p.id } });
    const page = await call(port, 'GET', pathOf(made.json.prototype.url), { key: '' });
    assert.equal(page.status, 200);
    assert.equal(page.text.includes('<style>.pt-ribbon{display:none}</style>'), false);
    assert.equal(page.text.includes('<script>alert(1)</script>'), false);
    assert.ok(page.text.includes('&lt;style&gt;.pt-ribbon{display:none}&lt;/style&gt;'));
    assert.ok(page.text.includes(WATERMARK_TEXT));
    console.log('[prototype-page] hostile name escaped; ribbon intact');
  });

  it('CRM: manual create falls back to estimate follow-up, refuses pest and franchise, and fresh revokes the old link', async () => {
    const weak = await lead({ industry: 'Plumbing', review_count: 3, rating: 3.1 }, { signals: {} });
    const made = await call(port, 'POST', '/api/prototypes', { body: { prospect_id: weak.id } });
    assert.equal(made.status, 200);
    assert.equal(made.json.prototype.agent_type, 'estimate_followup');
    const again = await call(port, 'POST', '/api/prototypes', { body: { prospect_id: weak.id } });
    assert.equal(again.json.prototype.id, made.json.prototype.id);
    const fresh = await call(port, 'POST', '/api/prototypes', { body: { prospect_id: weak.id, fresh: true } });
    assert.notEqual(fresh.json.prototype.id, made.json.prototype.id);
    assert.equal((await call(port, 'GET', pathOf(made.json.prototype.url), { key: '' })).status, 404);
    assert.equal((await call(port, 'GET', pathOf(fresh.json.prototype.url), { key: '' })).status, 200);

    const pest = await lead({ industry: 'Pest Control' });
    const refusedPest = await call(port, 'POST', '/api/prototypes', { body: { prospect_id: pest.id } });
    assert.equal(refusedPest.status, 409);
    const franchise = await lead({ company: 'TEST: One Hour Heating' });
    const refusedFranchise = await call(port, 'POST', '/api/prototypes', { body: { prospect_id: franchise.id } });
    assert.equal(refusedFranchise.status, 409);
    assert.equal((await pool.query('SELECT COUNT(*)::int n FROM prototypes WHERE prospect_id = ANY($1)', [[pest.id, franchise.id]])).rows[0].n, 0);

    const bad = await call(port, 'PATCH', `/api/prototypes/${fresh.json.prototype.id}`, { body: { colors: { primary: 'red; }', secondary: '#000000' } } });
    assert.equal(bad.status, 400);
    const agent = await call(port, 'PATCH', `/api/prototypes/${fresh.json.prototype.id}`, { body: { agent_type: 'receptionist' } });
    assert.equal(agent.json.prototype.agent_type, 'receptionist');
    const badAgent = await call(port, 'PATCH', `/api/prototypes/${fresh.json.prototype.id}`, { body: { agent_type: 'bookkeeping' } });
    assert.equal(badAgent.status, 400);
    const noKey = await call(port, 'POST', '/api/prototypes', { body: { prospect_id: weak.id }, key: '' });
    assert.equal(noKey.status, 401);
    console.log('[prototype-page] manual create, reuse, fresh, pest 409, franchise 409, color 400, agent change, no key 401');
  });

  it('expired is 410 with an expired page; archived lead is 404', async () => {
    const p = await lead();
    const made = await call(port, 'POST', '/api/prototypes', { body: { prospect_id: p.id } });
    const path = pathOf(made.json.prototype.url);
    await pool.query(`UPDATE prototypes SET issued_at = issued_at - INTERVAL '360 hours', expires_at = expires_at - INTERVAL '360 hours' WHERE id = $1`, [made.json.prototype.id]);
    const gone = await call(port, 'GET', path, { key: '' });
    assert.equal(gone.status, 410);
    assert.ok(gone.text.includes('This preview link has expired'));
    assert.ok(gone.text.includes(WATERMARK_TEXT));
    const listed = await call(port, 'GET', `/api/proposals/${(await pool.query('SELECT id FROM proposals WHERE prospect_id = $1', [p.id])).rows[0].id}`);
    assert.equal(listed.json.prototype.expired, true);

    const q = await lead();
    const live = await call(port, 'POST', '/api/prototypes', { body: { prospect_id: q.id } });
    await pool.query(`UPDATE prospects SET archived_at = NOW(), archive_reason = 'test' WHERE id = $1`, [q.id]);
    assert.equal((await call(port, 'GET', pathOf(live.json.prototype.url), { key: '' })).status, 404);
    assert.equal((await call(port, 'GET', '/demo/prototype/not-a-token', { key: '' })).status, 404);
    console.log('[prototype-page] expired 410 page, archived 404, malformed 404');
  });

  it('one-pager shows the prototype link only while it is live', async () => {
    const p = await lead();
    const { rows } = await pool.query('SELECT slug FROM proposals WHERE prospect_id = $1', [p.id]);
    const before = await call(port, 'GET', `/p/${rows[0].slug}?preview=1`, { key: '' });
    assert.equal(before.text.includes('data-prototype-link'), false);
    const made = await call(port, 'POST', '/api/prototypes', { body: { prospect_id: p.id } });
    const withLink = await call(port, 'GET', `/p/${rows[0].slug}?preview=1`, { key: '' });
    assert.ok(withLink.text.includes('data-prototype-link'));
    assert.ok(withLink.text.includes(pathOf(made.json.prototype.url)));
    await call(port, 'POST', `/api/prototypes/${made.json.prototype.id}/revoke`);
    const after = await call(port, 'GET', `/p/${rows[0].slug}?preview=1`, { key: '' });
    assert.equal(after.text.includes('data-prototype-link'), false);
    console.log('[prototype-page] one-pager link: absent, shown while live, gone after revoke');
  });
});
