process.env.SEND_HOURS = '0,24';
process.env.SEND_DAYS = '0,1,2,3,4,5,6';
process.env.SENDER_ADDRESS = '1 Test Street, Provo, UT 84601';

require('./preload');

// Gmail quota: each message is read in full once, reads stay inside a
// per-check budget, a used-up quota stops the scan and the follow-up loop,
// and follow-ups wait while unread inbox messages remain. Disposable
// Postgres; the Gmail API is a fake (_setApiForTests). Nothing is sent.

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const gmail = require('../src/proposals/gmail');
const send = require('../src/proposals/send');
const { resetDb, insertProspect, closePool, pool } = require('./fixtures');

function quotaError() {
  return Object.assign(
    new Error("Gmail API: Quota exceeded for quota metric 'Total Query Cost' and limit 'Units per minute per user'"),
    { status: 429, quota: true }
  );
}

function fakeMessage(id) {
  return {
    id,
    threadId: `t-${id}`,
    internalDate: String(Date.parse('2026-11-01T12:00:00Z')),
    payload: {
      mimeType: 'text/plain',
      headers: [{ name: 'From', value: `Owner <owner-${id}@example.com>` }, { name: 'Subject', value: `Re: idea ${id}` }],
      body: { data: Buffer.from(`reply ${id}`).toString('base64url') },
    },
  };
}

// A fake Gmail with `count` inbox messages. Records every call.
function fakeGmail({ count = 0, failGet = () => null } = {}) {
  const calls = [];
  const ids = Array.from({ length: count }, (_, i) => `m${String(count - i).padStart(4, '0')}`); // newest first, like Gmail
  gmail._setApiForTests(async (method, path, { params } = {}) => {
    calls.push({ method, path, params });
    if (path === '/messages') {
      const start = params.pageToken ? Number(params.pageToken) : 0;
      const page = ids.slice(start, start + 100).map((id) => ({ id, threadId: `t-${id}` }));
      const next = start + 100 < ids.length ? String(start + 100) : undefined;
      return { messages: page, nextPageToken: next };
    }
    const id = path.split('/').pop();
    const err = failGet(id, calls.filter((c) => c.path !== '/messages').length);
    if (err) throw err;
    return fakeMessage(id);
  });
  return { calls, gets: () => calls.filter((c) => c.path !== '/messages').length };
}

describe('gmail quota budget', () => {
  before(async () => { await resetDb(); });
  beforeEach(async () => { await pool.query('TRUNCATE gmail_scanned_messages'); });
  after(async () => { gmail._setApiForTests(null); send._setTransport(null); await closePool(); });

  it('reads within the budget, oldest first, and reads each message only once', async () => {
    const api = fakeGmail({ count: 150 });
    const since = new Date('2026-10-01T00:00:00Z');
    const budget = gmail.readBudget(1000); // 2 list pages (10) + 16 full reads (960)
    const first = await gmail.scanInbox(since, budget);
    assert.equal(first.messages.length, 16);
    assert.equal(first.backlog, 134);
    assert.equal(first.messages[0].id, 'm0001', 'oldest first');
    assert.equal(budget.units, 1000 - 2 * gmail.COST.list - 16 * gmail.COST.get);
    await gmail.markScanned(first.scanned.map((id) => ({ id, box: 'inbox' })));

    const getsBefore = api.gets();
    const second = await gmail.scanInbox(since, gmail.readBudget(1000));
    assert.equal(second.messages[0].id, 'm0017', 'already-read messages are skipped');
    assert.equal(api.gets() - getsBefore, 16);
    await gmail.markScanned(second.scanned.map((id) => ({ id, box: 'inbox' })));

    // The default budget fits the rest of a 150-message backlog in a few checks
    // and never spends more than READ_BUDGET units.
    let backlog = second.backlog;
    let checks = 0;
    while (backlog > 0 && checks < 10) {
      const b = gmail.readBudget();
      const r = await gmail.scanInbox(since, b);
      assert.ok(gmail.READ_BUDGET - b.units <= gmail.READ_BUDGET);
      await gmail.markScanned(r.scanned.map((id) => ({ id, box: 'inbox' })));
      backlog = r.backlog;
      checks++;
    }
    assert.equal(backlog, 0);
    const steady = gmail.readBudget();
    const quiet = await gmail.scanInbox(since, steady);
    assert.equal(quiet.messages.length, 0);
    assert.equal(gmail.READ_BUDGET - steady.units, 2 * gmail.COST.list, 'a caught-up check costs only the list calls');
  });

  it('stops at the first quota error and leaves the rest for later', async () => {
    const api = fakeGmail({ count: 40, failGet: (id, n) => (n >= 3 ? quotaError() : null) });
    const budget = gmail.readBudget();
    const r = await gmail.scanInbox(new Date('2026-10-01T00:00:00Z'), budget);
    assert.equal(api.gets(), 3, 'no request after the quota error');
    assert.equal(r.messages.length, 2);
    assert.equal(r.backlog, 38);
    assert.equal(budget.quotaHit, true);
    assert.equal(budget.units, 0, 'the sent scan gets nothing this check');
    const sent = await gmail.scanSent(new Date('2026-10-01T00:00:00Z'), budget);
    assert.equal(sent.messages.length, 0);
  });

  it('a deleted message is not retried; other errors are retried later', async () => {
    fakeGmail({
      count: 3,
      failGet: (id) => {
        if (id === 'm0001') return Object.assign(new Error('Gmail API: Not Found'), { status: 404, quota: false });
        if (id === 'm0002') return Object.assign(new Error('Gmail API: Backend Error'), { status: 500, quota: false });
        return null;
      },
    });
    const r = await gmail.scanInbox(new Date('2026-10-01T00:00:00Z'), gmail.readBudget());
    assert.deepEqual(r.scanned.sort(), ['m0001', 'm0003']);
    assert.equal(r.backlog, 0, 'an attempted message is not backlog');
    assert.equal(await gmail.markScanned(r.scanned.map((id) => ({ id, box: 'inbox' }))), 2);
    assert.equal(await gmail.markScanned([{ id: 'm0001', box: 'inbox' }, { id: 'x', box: 'trash' }]), 0);
  });

  it('recognizes Google quota answers', () => {
    assert.equal(gmail.isQuotaError(429, {}), true);
    assert.equal(gmail.isQuotaError(403, { error: { errors: [{ reason: 'userRateLimitExceeded' }] } }), true);
    assert.equal(gmail.isQuotaError(403, { error: { message: "Quota exceeded for quota metric 'Total Query Cost'" } }), true);
    assert.equal(gmail.isQuotaError(403, { error: { errors: [{ reason: 'insufficientPermissions' }] } }), false);
    assert.equal(gmail.isQuotaError(404, {}), false);
  });

  it('follow-ups wait while the inbox has unread messages', () => {
    assert.equal(send.holdFollowups({ caught_up: false, backlog: 12 }), true);
    assert.equal(send.holdFollowups({ caught_up: true }), false);
    assert.equal(send.holdFollowups({ checked: 0 }), false);
    assert.equal(send.holdFollowups(null), false);
  });

  it('one quota error stops the follow-up loop; every follow-up stays due', async () => {
    const attempts = [];
    send._setTransport({
      async sendMail(m) { attempts.push(m.to); throw quotaError(); },
    });
    const ids = [];
    for (let i = 1; i <= 3; i += 1) {
      const p = await insertProspect({
        company: `TEST: Quota Heating ${i}`, industry: 'HVAC', city: 'Lehi', state: 'UT',
        google_place_id: `test-place-quota-${i}`, website: null, email: `test+quota${i}@example.com`,
      });
      const { rows } = await pool.query(
        `INSERT INTO proposals (prospect_id, version, status, slug, to_email, subject, body, followup1, followup2,
                                sent_at, followup1_due_at, followup2_due_at)
         VALUES ($1, 1, 'sent', $2, $3, 'idea', 'Hi', 'Follow up one', 'Follow up two',
                 NOW() - INTERVAL '5 days', NOW() - INTERVAL '2 days', NOW() + INTERVAL '5 days') RETURNING id`,
        [p.id, `test-quota-${i}`, `test+quota${i}@example.com`]);
      ids.push(rows[0].id);
    }
    const result = await send.sendDueFollowups();
    assert.equal(result.sent, 0);
    assert.equal(attempts.length, 1, 'stopped after the first quota error');
    const { rows } = await pool.query(
      `SELECT followup1_sent_at, error FROM proposals WHERE id = ANY($1::int[]) ORDER BY id`, [ids]);
    assert.ok(rows.every((r) => r.followup1_sent_at === null), 'all still due');
    assert.match(rows[0].error, /Quota exceeded/);
    console.log('[gmail-quota] follow-up loop stops on quota and keeps every follow-up due');
  });
});
