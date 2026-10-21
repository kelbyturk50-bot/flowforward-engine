process.env.CRM_API_KEY = 'test-prototype-email-key-32chars-min!';
process.env.SEND_HOURS = '0,24';
process.env.SEND_DAYS = '0,1,2,3,4,5,6';
process.env.SENDER_ADDRESS = '1 Test Street, Provo, UT 84601';
delete process.env.FF_PROTOTYPE_ON_DRAFT;

require('./preload');

// The prototype link in the first email and follow-up 1. Disposable
// Postgres and the mock mail transport only. Nothing is really sent.

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const send = require('../src/proposals/send');
const store = require('../src/prototypes/store');
const { resetDb, insertProspect, closePool, pool } = require('./fixtures');

const BODY = 'Hi Dana,\n\nNoticed you offer free estimates.\n\nI put a few ideas for Sample Heating on one page here:\n{{ONEPAGER_URL}}\n\nHappy to answer questions.\n\nKelby\nKelby Turk, Founder';
const F1 = 'Hi Dana, one more idea: a text when an estimate goes quiet.\n\nKelby';
const F2 = 'Closing the loop. No worries if now is not the time.\n\nKelby';

let n = 0;
async function draftFor(overrides = {}) {
  n += 1;
  const p = await insertProspect({
    website: null, email: `test+email${n}@sample.test`, company: `TEST: Sample Heating ${n}`, industry: 'HVAC',
    city: 'Lehi', state: 'UT', google_place_id: `test-place-proto-email-${n}`, ...overrides,
  });
  const { rows } = await pool.query(
    `INSERT INTO proposals (prospect_id, version, status, slug, to_email, to_name, subject, body, followup1, followup2)
     VALUES ($1, 1, 'draft', $2, $3, 'Dana', 'ideas for sample heating', $4, $5, $6) RETURNING id`,
    [p.id, `seed-email-${p.id}`, `test+email${n}@sample.test`, BODY, F1, F2]);
  return { prospect: p, proposalId: rows[0].id };
}

describe('prototype link in emails', () => {
  const sent = [];
  before(async () => { await resetDb(); });
  beforeEach(() => {
    sent.length = 0;
    send._setTransport({ async sendMail(m) { sent.push(m); return { messageId: `<t${sent.length}@local>`, threadId: `thr-${sent.length}` }; } });
  });
  after(async () => { send._setTransport(null); await closePool(); });

  it('first email carries the link after the one-pager, and the 14 days restart at send', async () => {
    const { prospect, proposalId } = await draftFor();
    const row = await store.ensurePrototype(prospect.id);
    await pool.query(`UPDATE prototypes SET issued_at = issued_at - INTERVAL '240 hours', expires_at = expires_at - INTERVAL '240 hours' WHERE id = $1`, [row.id]);
    const link = await store.liveLink(prospect.id);
    await send.approveAndSend(proposalId);
    assert.equal(sent.length, 1);
    const text = sent[0].text;
    const onepager = text.indexOf('/p/seed-email-');
    const proto = text.indexOf(link.url);
    assert.ok(onepager > 0 && proto > onepager, 'prototype link comes after the one-pager link');
    assert.ok(text.includes(`I also built a quick clickable prototype of what this could look like for Sample Heating ${n}, on sample data:\n${link.url}`));
    assert.equal(text.includes('TEST:'), false);
    assert.equal(text.includes('{{'), false);
    assert.match(link.url, /^https?:\/\//, 'absolute link');
    assert.ok(sent[0].html.includes(`href="${link.url}"`), 'html part links the prototype');
    assert.ok(sent[0].html.includes('/brand/flowforward-logo.png'), 'html signature has the logo');
    const after = await pool.query('SELECT issued_at, expires_at FROM prototypes WHERE id = $1', [row.id]);
    assert.ok(Date.now() - new Date(after.rows[0].issued_at).getTime() < 60000, 'clock restarted at send');
    assert.equal(new Date(after.rows[0].expires_at) - new Date(after.rows[0].issued_at), 336 * 3600 * 1000);
    console.log('[prototype-email] first email: link after one-pager; expiry restarted to 14 days from send');
  });

  it('follow-up 1 mentions it before the sign-off; follow-up 2 does not', async () => {
    const { prospect, proposalId } = await draftFor();
    await store.ensurePrototype(prospect.id);
    const link = await store.liveLink(prospect.id);
    await send.approveAndSend(proposalId);
    await pool.query(`UPDATE proposals SET followup1_due_at = NOW() - INTERVAL '1 minute' WHERE id = $1`, [proposalId]);
    sent.length = 0;
    await send.sendDueFollowups();
    assert.equal(sent.length, 1);
    assert.ok(sent[0].text.includes(`here's the clickable prototype I put together for Sample Heating ${n}:\n${link.url}\n\nKelby`));
    await pool.query(`UPDATE proposals SET followup2_due_at = NOW() - INTERVAL '1 minute' WHERE id = $1`, [proposalId]);
    sent.length = 0;
    await send.sendDueFollowups();
    assert.equal(sent.length, 1);
    assert.equal(sent[0].text.includes('/demo/prototype/'), false);
    console.log('[prototype-email] follow-up 1 has the link before the sign-off; follow-up 2 has none');
  });

  it('no prototype, a revoked one, or an expired one: emails go out unchanged', async () => {
    const none = await draftFor();
    await send.approveAndSend(none.proposalId);
    assert.equal(sent[0].text.includes('/demo/prototype/'), false);
    assert.equal(sent[0].text.includes('prototype'), false);

    const revoked = await draftFor();
    const r = await store.ensurePrototype(revoked.prospect.id);
    await store.revoke(r.id);
    sent.length = 0;
    await send.approveAndSend(revoked.proposalId);
    assert.equal(sent[0].text.includes('/demo/prototype/'), false);

    const expiring = await draftFor();
    await store.ensurePrototype(expiring.prospect.id);
    await send.approveAndSend(expiring.proposalId);
    await pool.query(`UPDATE prototypes SET issued_at = issued_at - INTERVAL '400 hours', expires_at = expires_at - INTERVAL '400 hours' WHERE prospect_id = $1`, [expiring.prospect.id]);
    await pool.query(`UPDATE proposals SET followup1_due_at = NOW() - INTERVAL '1 minute' WHERE id = $1`, [expiring.proposalId]);
    sent.length = 0;
    await send.sendDueFollowups();
    assert.equal(sent.length, 1);
    assert.equal(sent[0].text.includes('/demo/prototype/'), false);
    console.log('[prototype-email] none, revoked, expired: no prototype line');
  });

  it('a {{PROTOTYPE_URL}} written in the copy is used as-is, or its line is dropped with no link', () => {
    const p = { company: 'Peak Plumbing', slug: 'x', prototype_url: 'https://api.test/demo/prototype/T' };
    const own = 'Hi,\n\nSee it here: {{PROTOTYPE_URL}}\n\nKelby';
    assert.equal(send.withPrototype(own, p, 'first'), 'Hi,\n\nSee it here: https://api.test/demo/prototype/T\n\nKelby');
    assert.equal(send.withPrototype(own, { ...p, prototype_url: null }, 'first'), 'Hi,\n\nKelby');
    assert.equal(send.withPrototype('One line.\nKelby', p, 'followup1'),
      "One line.\n\nIf it's easier to see than read about, here's the clickable prototype I put together for Peak Plumbing:\nhttps://api.test/demo/prototype/T\n\nKelby");
  });
});
