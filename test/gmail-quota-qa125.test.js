process.env.SEND_HOURS = '0,24';
process.env.SEND_DAYS = '0,1,2,3,4,5,6';
process.env.SENDER_ADDRESS = '1 Test Street, Provo, UT 84601';
process.env.GOOGLE_CLIENT_ID = 'qa125-client';
process.env.GOOGLE_CLIENT_SECRET = 'qa125-secret';

require('./preload');

// QA probes for PR #125: resume after catch-up, hold safety, forever-hold,
// overlapping scans, and the per-minute read cap. Gmail is faked; nothing
// is sent and no hosted services are touched.

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

function fakeMessage(id, fromEmail) {
  const from = fromEmail || `Owner <owner-${id}@gmail.com>`;
  return {
    id,
    threadId: `t-${id}`,
    internalDate: String(Date.now()),
    payload: {
      mimeType: 'text/plain',
      headers: [{ name: 'From', value: from }, { name: 'Subject', value: `Re: idea ${id}` }],
      body: { data: Buffer.from(`reply ${id}`).toString('base64url') },
    },
  };
}

function countUnits(call) {
  if (call.method === 'post' && call.path === '/messages/send') return 100;
  if (call.path === '/messages') return gmail.COST.list;
  if (call.path && call.path.startsWith('/messages/')) {
    const format = call.params && call.params.format;
    return format === 'full' || format === 'raw' || format === 'html' || !format ? gmail.COST.get : 20;
  }
  return 0;
}

function installApi({ inboxIds = [], failGet = null, onList = null, hangGet = null } = {}) {
  const calls = [];
  const sends = [];
  let ids = inboxIds.slice();
  gmail._setApiForTests(async (method, path, { data, params } = {}) => {
    const call = { method, path, params, data };
    calls.push(call);
    if (method === 'post' && path === '/messages/send') {
      sends.push({ data, params });
      return { id: `sent-${sends.length}`, threadId: `th-sent-${sends.length}` };
    }
    if (path === '/messages') {
      if (onList) {
        const extra = onList(params);
        if (extra) ids = extra;
      }
      if ((params.q || '').includes('in:sent')) return { messages: [] };
      const start = params.pageToken ? Number(params.pageToken) : 0;
      const page = ids.slice(start, start + 100).map((id) => ({ id, threadId: `t-${id}` }));
      const next = start + 100 < ids.length ? String(start + 100) : undefined;
      return { messages: page, nextPageToken: next };
    }
    const id = path.split('/').pop();
    if (hangGet && hangGet(id)) await hangGet(id);
    if (failGet) {
      const err = failGet(id, calls.filter((c) => c.path !== '/messages' && c.path !== '/messages/send').length);
      if (err) throw err;
    }
    if (String(id).startsWith('sent-')) {
      return { id, payload: { headers: [{ name: 'Message-ID', value: `<${id}@mail.gmail.com>` }] } };
    }
    return fakeMessage(id);
  });
  return {
    calls,
    sends,
    units: () => calls.reduce((n, c) => n + countUnits(c), 0),
  };
}

async function connectGmail() {
  process.env.GOOGLE_CLIENT_ID = 'qa125-client';
  process.env.GOOGLE_CLIENT_SECRET = 'qa125-secret';
  await pool.query(
    `INSERT INTO app_settings (key, value) VALUES ('gmail_oauth', $1::jsonb)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [JSON.stringify({ refresh_token: 'qa-refresh', email: 'qa@example.com' })]
  );
}

async function insertDueFollowup(tag, toEmail) {
  const email = toEmail || `test+${tag}@example.com`;
  const p = await insertProspect({
    company: `TEST: QA125 ${tag}`,
    industry: 'HVAC',
    city: 'Lehi',
    state: 'UT',
    google_place_id: `test-place-qa125-${tag}`,
    website: null,
    email,
  });
  const { rows } = await pool.query(
    `INSERT INTO proposals (prospect_id, version, status, slug, to_email, subject, body, followup1, followup2,
                            sent_at, followup1_due_at, followup2_due_at, message_id, thread_id)
     VALUES ($1, 1, 'sent', $2, $3, 'idea', 'Hi', 'Follow up one', 'Follow up two',
             NOW() - INTERVAL '5 days', NOW() - INTERVAL '2 days', NOW() + INTERVAL '5 days',
             $4, $5) RETURNING *`,
    [p.id, `test-qa125-${tag}`, email, `<msg-${tag}@test>`, `thread-${tag}`]
  );
  return { prospect: p, proposal: rows[0], email };
}

function newestFirstIds(n) {
  return Array.from({ length: n }, (_, i) => `m${String(n - i).padStart(4, '0')}`);
}

describe('PR #125 QA probes', () => {
  // The read budget is per minute and shared. A second sweep in these
  // probes is the next cron minute, not a second spend of the same minute.
  let now = Date.parse('2026-11-06T18:00:00Z');
  before(async () => { await resetDb(); });
  beforeEach(async () => {
    await resetDb();
    await pool.query('TRUNCATE gmail_scanned_messages');
    await connectGmail();
    now = Date.parse('2026-11-06T18:00:00Z');
    gmail._setClockForTests(() => now);
    gmail.resetReadBudgetForTests();
    send._resetFollowupHoldForTests();
    gmail._setApiForTests(null);
    send._setTransport(null);
  });
  after(async () => {
    gmail._setApiForTests(null);
    gmail._setClockForTests(null);
    send._setTransport(null);
    await closePool();
  });

  it('(d) READ_BUDGET leaves room for the daily send cap in the same minute', () => {
    const perUserPerMinute = 6000;
    const sendCost = 100;
    const metadataGetCost = 20; // messages.get format=metadata
    assert.ok(
      gmail.READ_BUDGET + 20 * (sendCost + metadataGetCost) <= perUserPerMinute,
      `READ_BUDGET ${gmail.READ_BUDGET} plus 20 sends leaves no room under the 6,000/user/minute cap`
    );
  });

  it('(a) follow-ups resume on the next sweep once the inbox backlog drains, with no manual step', async () => {
    const api = installApi({ inboxIds: newestFirstIds(80) });
    const lead = await insertDueFollowup('resume');
    const first = await send.senderTick();
    assert.equal(first.held, true, 'first tick holds while unread inbox messages remain');
    assert.equal(first.sent, 0);
    assert.equal(api.sends.length, 0);
    const { rows: mid } = await pool.query('SELECT followup1_sent_at FROM proposals WHERE id = $1', [lead.proposal.id]);
    assert.equal(mid[0].followup1_sent_at, null);

    now += 60 * 1000;
    const second = await send.senderTick();
    assert.equal(second && second.held, undefined, 'second tick is not a hold');
    assert.equal(second.sent, 1, 'the due follow-up goes out once the inbox is caught up');
    assert.equal(api.sends.length, 1);
    const { rows: after } = await pool.query('SELECT followup1_sent_at FROM proposals WHERE id = $1', [lead.proposal.id]);
    assert.ok(after[0].followup1_sent_at, 'follow-up marked sent');
  });

  it('(c) a reply sitting in the unread backlog stops the sequence before any follow-up is sent', async () => {
    // Newest message (read last) is the lead's reply. First tick cannot read it.
    const api = installApi({ inboxIds: newestFirstIds(80) });
    const lead = await insertDueFollowup('reply-backlog', 'owner-m0080@gmail.com');
    const first = await send.senderTick();
    assert.equal(first.held, true);
    assert.equal(api.sends.length, 0);
    const { rows: mid } = await pool.query('SELECT status, followup1_sent_at FROM proposals WHERE id = $1', [lead.proposal.id]);
    assert.equal(mid[0].status, 'sent');
    assert.equal(mid[0].followup1_sent_at, null);

    now += 60 * 1000;
    const second = await send.senderTick();
    assert.equal(api.sends.length, 0, 'no follow-up after the reply is read');
    assert.notEqual(second && second.sent, 1);
    const { rows: after } = await pool.query('SELECT status, followup1_sent_at, stop_reason FROM proposals WHERE id = $1', [lead.proposal.id]);
    assert.equal(after[0].status, 'replied');
    assert.equal(after[0].followup1_sent_at, null);
  });

  it('(c) a do-not-contact flip during the hold is rechecked before the follow-up is sent', async () => {
    const api = installApi({ inboxIds: newestFirstIds(80) });
    const lead = await insertDueFollowup('dnc-hold');
    const first = await send.senderTick();
    assert.equal(first.held, true);
    await pool.query('UPDATE prospects SET do_not_contact = TRUE WHERE id = $1', [lead.prospect.id]);
    now += 60 * 1000;
    const second = await send.senderTick();
    assert.equal(api.sends.length, 0, 'DNC set during the hold must stop the send');
    assert.notEqual(second && second.sent, 1);
    const { rows } = await pool.query('SELECT status, followup1_sent_at, stop_reason FROM proposals WHERE id = $1', [lead.proposal.id]);
    assert.equal(rows[0].followup1_sent_at, null);
    assert.equal(rows[0].status, 'stopped');
    assert.match(rows[0].stop_reason, /do-not-contact/i);
  });

  it('(c) a 500 reading a matching reply is not treated as caught up', async () => {
    const api = installApi({
      inboxIds: ['m0001'],
      failGet: (id) => {
        if (id === 'm0001') return Object.assign(new Error('Gmail API: Backend Error'), { status: 500, quota: false });
        return null;
      },
    });
    await insertDueFollowup('get-500', 'owner-m0001@gmail.com');
    const tick = await send.senderTick();
    assert.equal(api.sends.length, 0, 'must not send a follow-up whose reply was not successfully read');
    assert.equal(tick.held, true, 'an unread attempted message must keep the hold');
  });

  it('(b) a concurrent senderTick while a scan is in progress does not send', async () => {
    let release;
    const gate = new Promise((r) => { release = r; });
    let seenGet;
    const started = new Promise((r) => { seenGet = r; });
    const api = installApi({
      inboxIds: ['m0001'],
      hangGet: async (id) => {
        if (id === 'm0001') {
          seenGet();
          await gate;
        }
      },
    });
    await insertDueFollowup('overlap');
    const inflight = send.checkInbox();
    try {
      await started;
      const tick = await send.senderTick();
      assert.equal(api.sends.length, 0, 'overlapping tick must not send while another scan is still reading');
      assert.equal(tick.held, true, 'the overlapping tick should hold, not treat a skipped scan as caught up');
      const later = await send.senderTick();
      assert.equal(api.sends.length, 0, 'a scan still in progress must not leave later ticks free to send');
      assert.equal(later.held, true);
    } finally {
      release();
      await inflight.catch(() => {});
    }
  });

  it('(b) a permanently failing inbox scan cannot silently hold follow-ups forever', async () => {
    let sendAttempts = 0;
    gmail._setApiForTests(async (method, path) => {
      if (method === 'post' && path === '/messages/send') sendAttempts += 1;
      throw Object.assign(new Error('Gmail API: Invalid Credentials'), { status: 401, quota: false });
    });
    await insertDueFollowup('auth-hold');
    const ticks = [];
    for (let i = 0; i < 5; i += 1) ticks.push(await send.senderTick());
    assert.ok(ticks[0] && ticks[0].held === true, 'the first failed inbox check must hold follow-ups');
    const readiness = await send.sendReadiness();
    const visible = readiness.some((p) => /inbox|caught up|unread|check failed|not caught|hold follow/i.test(p));
    const released = ticks.some((t, i) => i > 0 && t && t.held !== true);
    if (!released) assert.equal(sendAttempts, 0, 'must not send while the inbox check keeps failing');
    assert.ok(visible || released, `persistent inbox failure must surface in sendReadiness or release after a max hold (readiness=${JSON.stringify(readiness)})`);
  });

  it('(b) quota on every check cannot silently hold follow-ups forever', async () => {
    const api = installApi({
      inboxIds: newestFirstIds(40),
      failGet: (_id, n) => (n >= 1 ? quotaError() : null),
    });
    await insertDueFollowup('quota-hold');
    const ticks = [];
    for (let i = 0; i < 4; i += 1) ticks.push(await send.senderTick());
    assert.ok(ticks[0] && ticks[0].held === true, 'the first quota-hit check must hold follow-ups');
    const readiness = await send.sendReadiness();
    const visible = readiness.some((p) => /inbox|caught up|unread|quota|not caught|hold follow/i.test(p));
    const released = ticks.some((t, i) => i > 0 && t && t.held !== true);
    if (!released) assert.equal(api.sends.length, 0, 'must not send while quota keeps the inbox behind');
    assert.ok(visible || released, `quota on every check must surface in sendReadiness or release after a max hold (readiness=${JSON.stringify(readiness)})`);
  });

  it('(b) a backlog that never drains cannot silently hold follow-ups forever', async () => {
    let wave = 0;
    const api = installApi({
      inboxIds: [],
      onList: (params) => {
        if ((params.q || '').includes('in:sent')) return null;
        wave += 1;
        return Array.from({ length: 80 }, (_, i) => `w${wave}m${String(i + 1).padStart(4, '0')}`);
      },
    });
    await insertDueFollowup('never-drain');
    const ticks = [];
    for (let i = 0; i < 3; i += 1) ticks.push(await send.senderTick());
    assert.ok(ticks[0] && ticks[0].held === true, 'a backlog that cannot drain must hold at first');
    const readiness = await send.sendReadiness();
    const visible = readiness.some((p) => /inbox|caught up|unread|backlog|not caught|hold follow/i.test(p));
    const released = ticks.some((t, i) => i > 0 && t && t.held !== true);
    if (!released) assert.equal(api.sends.length, 0, 'must not send while the backlog cannot drain');
    assert.ok(visible || released, `never-draining backlog must surface in sendReadiness or release after a max hold (readiness=${JSON.stringify(readiness)})`);
  });

  it('(d) two back-to-back checks stay within Gmail\'s 6,000 units/user/minute', async () => {
    const api = installApi({ inboxIds: newestFirstIds(150) });
    await insertDueFollowup('twocheck');
    await send.checkInbox();
    await send.checkInbox();
    const spent = api.units();
    assert.ok(spent <= 6000, `two sequential checks spent ${spent} units, over the 6,000/user/minute cap`);
  });

  it('(d) finishing a catch-up plus SEND_DAILY_LIMIT follow-ups stays within 6,000 units', async () => {
    // Last unread page (so this check can report caught_up) plus 20 due follow-ups.
    const api = installApi({ inboxIds: newestFirstIds(20) });
    for (let i = 1; i <= 20; i += 1) await insertDueFollowup(`burst-${i}`);
    const tick = await send.senderTick();
    assert.notEqual(tick && tick.held, true, 'small inbox should be caught up');
    const spent = api.units();
    assert.ok(spent <= 6000, `catch-up + ${api.sends.length} sends spent ${spent} units`);
    assert.ok(api.sends.length > 0, 'expected follow-ups to go out');
  });
});
