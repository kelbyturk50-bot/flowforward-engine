process.env.SENDER_ADDRESS = '1 Test Street, Provo, UT 84601';
require('./preload');

// HTML part of outgoing emails: short link text, logo signature, escaping.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const cfg = require('../src/proposals/config');
const send = require('../src/proposals/send');
const { renderHtml } = require('../src/proposals/email-html');

const BASE = cfg.PUBLIC_BASE_URL;
const proto = `${BASE}/demo/prototype/${'a'.repeat(43)}`;
const p = {
  company: 'TEST: Beehive House Cleaning', slug: 'beehive-3fb2', prototype_url: proto,
  body: "Hi Beehive team,\n\nI put a few ideas for Beehive on one page here:\n\n{{ONEPAGER_URL}}\n\nReply with any questions.\n\nKelby\nKelby Turk, Process Engineer & Founder\nFlowForward · Saratoga Springs, Utah",
  followup1: 'One more idea for you.\n\nKelby',
};

describe('email html', () => {
  it('links read as short text, every href is absolute, and the signature carries the logo', () => {
    const html = send.renderMessageHtml(p, 'first');
    assert.match(html, new RegExp(`<a href="${BASE}/p/beehive-3fb2"[^>]*>See the one-pager &rarr;</a>`));
    assert.match(html, new RegExp(`<a href="${proto}"[^>]*>Open the prototype &rarr;</a>`));
    assert.match(html, /here: <a href=/, 'intro line and its link are one line');
    const hrefs = [...html.matchAll(/href="([^"]+)"/g)].map(m => m[1]);
    assert.ok(hrefs.every(h => /^(https?:|mailto:)/.test(h)), hrefs.join(' '));
    assert.ok(html.includes(`<img src="${BASE}/brand/flowforward-logo.png"`));
    assert.ok(html.includes('<strong>Kelby Turk</strong>'));
    assert.equal(html.includes('Kelby Turk, Process Engineer &amp; Founder<br>'), false, 'typed signature replaced, not duplicated');
    assert.ok(html.includes('Not interested? Reply'));
    assert.ok(html.includes('1 Test Street, Provo, UT 84601'));
    const text = send.renderMessage(p, 'first');
    assert.ok(text.includes(proto), 'plain text keeps the absolute URL');
  });

  it('escapes draft text and keeps unknown links as their host', () => {
    const html = renderHtml('Hi <b>there</b> & see https://example.com/x?a=1&b=2\n\nKelby', {});
    assert.ok(html.includes('Hi &lt;b&gt;there&lt;/b&gt; &amp; see'));
    assert.ok(html.includes('href="https://example.com/x?a=1&amp;b=2"'));
    assert.ok(html.includes('>example.com</a>'));
  });

  it('prototype links in emails are absolute even without PUBLIC_BASE_URL', () => {
    const store = require('../src/prototypes/store');
    const link = store.linkFor({ id: 1, revoked_at: null, nonce: null, token_hash: null, agent_type: 'scheduling', color_primary: '#000000', color_secondary: '#000000', issued_at: new Date(), expires_at: new Date(Date.now() + 1e6) });
    assert.equal(link.url, null);
    const src = require('fs').readFileSync(require('path').join(__dirname, '../src/prototypes/store.js'), 'utf8');
    assert.equal(/process\.env\.PUBLIC_BASE_URL/.test(src), false, 'store uses config.PUBLIC_BASE_URL (with the Railway fallback)');
  });
});
