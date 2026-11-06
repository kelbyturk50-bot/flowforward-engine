process.env.SEND_HOURS = '0,24';
process.env.SEND_DAYS = '0,1,2,3,4,5,6';
process.env.SENDER_ADDRESS = '1 Test Street, Provo, UT 84601';
process.env.GOOGLE_CLIENT_ID = 'fix125-client';
process.env.GOOGLE_CLIENT_SECRET = 'fix125-secret';

require('./preload');

// Follow-up hold fixes for PR #125. Gmail is faked. Nothing is sent.

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const axios = require('axios');
const gmail = require('../src/proposals/gmail');
const send = require('../src/proposals/send');
const { resetDb, insertProspect, closePool, pool } = require('./fixtures');

function quotaError() {
  return Object.assign(
    new Error("Gmail API: Quota exceeded for quota metric 'Total Query Cost' and limit 'Units per minute per user'"),
    { status: 429, quota: true }
  );
}

function fakeMessage(id, text) {
  return {
    id,
    threadId: `t-${id}`,
    internalDate: String(Date.now()),
    payload: {
      mimeType: 'text/plain',
      headers: [
        { name: 'From', value: `Owner <owner-${id}@gmail.com>` },
        { name: 'Subject', value: `Re: idea ${id}` },
      ],
      body: { data: Buffer.from(text || `reply ${id}`).toString('base64url') },
    },
  };
}

function newestFirstIds(n, prefix = 'm') {
  return Array.from({ length: n }, (_, i) => `${prefix}${String(n - i).padStart(4, '0')}`);
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

function installApi({ inboxIds = [], sentIds = [], failGet = null, hangGet = null, onList = null, bodies = {} } = {}) {
  const calls = [];
  const sends = [];
  let inbox = inboxIds.slice();
  let sent = sentIds.slice();
  gmail._setApiForTests(async (method, path, { data, params } = {}) => {
    const call = { method, path, params, data, at: gmail.clockNow() };
    calls.push(call);
    if (method === 'post' && path === '/messages/send') {
      sends.push({ data, params });
      return { id: `sent-${sends.length}`, threadId: `th-sent-${sends.length}` };
    }
    if (path === '/messages') {
      const q = params.q || '';
      if (onList) {
        const extra = onList(params);
        if (extra) {
          if (q.includes('in:sent')) sent = extra;
          else inbox = extra;
        }
      }
      const ids = q.includes('in:sent') ? sent : inbox;
      const start = params.pageToken ? Number(params.pageToken) : 0;
      const page = ids.slice(start, start + 100).map((id) => ({ id, threadId: `t-${id}` }));
      const next = start + 100 < ids.length ? String(start + 100) : undefined;
      return { messages: page, nextPageToken: next };
    }
    const id = path.split('/').pop();
    if (hangGet && hangGet(id)) await hangGet(id);
    if (failGet) {
      const gets = calls.filter((c) => c.path !== '/messages' && !(c.method === 'post' && c.path === '/messages/send'));
      const err = failGet(id, gets.length);
      if (err) throw err;
    }
    if (String(id).startsWith('sent-')) {
      return { id, payload: { headers: [{ name: 'Message-ID', value: `<${id}@mail.gmail.com>` }] } };
    }
    return fakeMessage(id, bodies[id]);
  });
  return {
    calls,
    sends,
    units: () => calls.reduce((n, c) => n + countUnits(c), 0),
    setInbox(ids) { inbox = ids.slice(); },
  };
}

async function connectGmail() {
  await pool.query(
    `INSERT INTO app_settings (key, value) VALUES ('gmail_oauth', $1::jsonb)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [JSON.stringify({ refresh_token: 'fix125-refresh', email: 'qa@example.com' })]
  );
}

async function insertDueFollowup(tag, toEmail) {
  const email = toEmail || `test+${tag}@example.com`;
  const p = await insertProspect({
    company: `TEST: Fix125 ${tag}`,
    industry: 'HVAC',
    city: 'Lehi',
    state: 'UT',
    google_place_id: `test-place-fix125-${tag}`,
    website: null,
    email,
  });
  const { rows } = await pool.query(
    `INSERT INTO proposals (prospect_id, version, status, slug, to_email, subject, body, followup1, followup2,
                            sent_at, followup1_due_at, followup2_due_at, message_id, thread_id)
     VALUES ($1, 1, 'sent', $2, $3, 'idea', 'Hi', 'Follow up one', 'Follow up two',
             NOW() - INTERVAL '5 days', NOW() - INTERVAL '2 days', NOW() + INTERVAL '5 days',
             $4, $5) RETURNING *`,
    [p.id, `test-fix125-${tag}-${Date.now()}`, email, `<msg-${tag}@test>`, `thread-${tag}`]
  );
  return { prospect: p, proposal: rows[0], email };
}

describe('gmail quota fix round', () => {
  let now = Date.parse('2026-11-06T18:00:00Z');

  before(async () => { await resetDb(); });
  beforeEach(async () => {
    await resetDb();
    now = Date.parse('2026-11-06T18:00:00Z');
    gmail._setClockForTests(() => now);
    gmail.resetReadBudgetForTests();
    gmail._setApiForTests(null);
    send._resetFollowupHoldForTests();
    send._setTransport(null);
    await connectGmail();
  });
  after(async () => {
    gmail._setApiForTests(null);
    gmail._setClockForTests(null);
    send._setTransport(null);
    await closePool();
  });

  it('B1 301 inbox ids are read oldest-first before the check is caught up', async () => {
    const ids = newestFirstIds(301);
    installApi({ inboxIds: ids });
    const since = new Date('2026-10-01T00:00:00Z');
    const first = await gmail.scanInbox(since, gmail.readBudget());
    assert.equal(first.messages[0].id, 'm0001', 'the oldest id is read, not dropped past a 300 window');
    assert.ok(first.backlog > 0);
    await gmail.markScanned(first.scanned.map((id) => ({ id, box: 'inbox' })));
    let backlog = first.backlog;
    for (let i = 0; backlog > 0 && i < 20; i += 1) {
      const r = await gmail.scanInbox(since, gmail.readBudget());
      assert.ok(r.backlog > 0 || r.messages.length > 0);
      await gmail.markScanned(r.scanned.map((id) => ({ id, box: 'inbox' })));
      backlog = r.backlog;
    }
    assert.equal(backlog, 0);
    const { rows } = await pool.query('SELECT COUNT(*)::int AS n FROM gmail_scanned_messages');
    assert.equal(rows[0].n, 301);
    const oldest = await pool.query(`SELECT 1 FROM gmail_scanned_messages WHERE gmail_id = 'm0001'`);
    assert.equal(oldest.rows.length, 1);
  });

  it('B1 sent ids past the old 100 ceiling are still read', async () => {
    installApi({ sentIds: newestFirstIds(101, 's') });
    const since = new Date('2026-10-01T00:00:00Z');
    const first = await gmail.scanSent(since, gmail.readBudget());
    assert.equal(first.messages[0].id, 's0101', 'the newest Sent id is read first');
    assert.ok(first.backlog > 0);
    await gmail.markScanned(first.scanned.map((id) => ({ id, box: 'sent' })));
    let sawOldest = false;
    let backlog = first.backlog;
    for (let i = 0; backlog > 0 && i < 5; i += 1) {
      const r = await gmail.scanSent(since, gmail.readBudget());
      if (r.messages.some((m) => m.id === 's0001') || r.scanned.includes('s0001')) sawOldest = true;
      await gmail.markScanned(r.scanned.map((id) => ({ id, box: 'sent' })));
      backlog = r.backlog;
    }
    assert.equal(sawOldest, true, 'the id past the old 100 ceiling is still read');
  });

  it('B1 a list that stops because the read budget is spent is not caught up', async () => {
    installApi({ inboxIds: newestFirstIds(250) });
    const budget = gmail.readBudget(10); // two list pages, then the budget is gone
    const r = await gmail.scanInbox(new Date('2026-10-01T00:00:00Z'), budget);
    assert.equal(r.listIncomplete, true);
    assert.ok(r.backlog > 0, 'budget ran out while listing, so backlog stays above 0');
  });

  it('B1 new mail sliding in mid-catch-up does not drop an older unread opt-out', async () => {
    const bodies = { m0060: 'please unsubscribe' };
    const api = installApi({ inboxIds: newestFirstIds(300), bodies });
    await insertDueFollowup('slide', 'owner-m0060@gmail.com');
    const first = await send.senderTick();
    assert.equal(first.held, true);
    assert.equal(api.sends.length, 0);
    api.setInbox(newestFirstIds(380));
    let dnc = false;
    for (let i = 0; i < 12 && !dnc; i += 1) {
      now += 60 * 1000;
      const tick = await send.senderTick();
      assert.notEqual(tick && tick.sent, 1);
      assert.equal(api.sends.length, 0);
      const row = await pool.query('SELECT do_not_contact FROM prospects WHERE email = $1', ['owner-m0060@gmail.com']);
      dnc = row.rows[0] && row.rows[0].do_not_contact === true;
    }
    assert.equal(dnc, true, 'the opt-out that would have slid out of a 300 window is applied');
    assert.equal(api.sends.length, 0);
    const scanned = await pool.query(`SELECT 1 FROM gmail_scanned_messages WHERE gmail_id = 'm0060'`);
    assert.equal(scanned.rows.length, 1);
  });

  it('B2 a concurrent second check plus sendDueFollowups sends 0', async () => {
    let release;
    const gate = new Promise((r) => { release = r; });
    let seen;
    const started = new Promise((r) => { seen = r; });
    const api = installApi({
      inboxIds: ['m0001'],
      hangGet: async (id) => {
        if (id === 'm0001') { seen(); await gate; }
      },
    });
    await insertDueFollowup('overlap');
    const inflight = send.checkInbox();
    try {
      await started;
      const second = await send.checkInbox();
      assert.equal(second.caught_up, false);
      assert.equal(second.scanning, true);
      const followups = await send.followupsAfterInbox(second);
      assert.equal(followups.sent, 0);
      assert.equal(followups.held, true);
      assert.equal(api.sends.length, 0);
    } finally {
      release();
      await inflight.catch(() => {});
    }

    send._resetFollowupHoldForTests();
    gmail.resetReadBudgetForTests();
    now += 60 * 1000;
    const orig = pool.query.bind(pool);
    let nested = null;
    pool.query = async (sql, params) => {
      if (!nested && String(sql).includes('INSERT INTO gmail_scanned_messages')) {
        const again = await send.checkInbox();
        const followups = await send.followupsAfterInbox(again);
        nested = { caught_up: again.caught_up, scanning: again.scanning, sent: followups.sent };
      }
      return orig(sql, params);
    };
    installApi({ inboxIds: ['m0009'] });
    try {
      await send.checkInbox();
    } finally {
      pool.query = orig;
    }
    assert.ok(nested, 'markScanned ran');
    assert.equal(nested.caught_up, false);
    assert.equal(nested.scanning, true);
    assert.equal(nested.sent, 0);
  });

  it('B3 a 500 reading an opt-out holds follow-ups', async () => {
    const api = installApi({
      inboxIds: ['m0001'],
      bodies: { m0001: 'please unsubscribe' },
      failGet: (id) => (id === 'm0001'
        ? Object.assign(new Error('Gmail API: Backend Error'), { status: 500, quota: false })
        : null),
    });
    const lead = await insertDueFollowup('opt500', 'owner-m0001@gmail.com');
    const tick = await send.senderTick();
    assert.equal(tick.held, true);
    assert.equal(api.sends.length, 0);
    const row = await pool.query(
      'SELECT p.do_not_contact, pr.followup1_sent_at FROM prospects p JOIN proposals pr ON pr.prospect_id = p.id WHERE pr.id = $1',
      [lead.proposal.id]
    );
    assert.equal(row.rows[0].do_not_contact, false);
    assert.equal(row.rows[0].followup1_sent_at, null);
  });

  it('B4 a quota error in the sent scan holds follow-ups', async () => {
    const api = installApi({
      inboxIds: [],
      sentIds: ['s0001'],
      failGet: (id) => (id === 's0001' ? quotaError() : null),
    });
    await insertDueFollowup('sent-quota');
    const tick = await send.senderTick();
    assert.equal(tick.held, true);
    assert.equal(api.sends.length, 0);
    const row = await pool.query(`SELECT followup1_sent_at FROM proposals WHERE slug LIKE 'test-fix125-sent-quota%'`);
    assert.equal(row.rows[0].followup1_sent_at, null);
  });

  it('B4 an error in the sent scan holds follow-ups', async () => {
    const api = installApi({
      inboxIds: [],
      sentIds: ['s0001'],
      failGet: (id) => (id === 's0001'
        ? Object.assign(new Error('Gmail API: Backend Error'), { status: 500, quota: false })
        : null),
    });
    await insertDueFollowup('sent-500');
    const tick = await send.senderTick();
    assert.equal(tick.held, true);
    assert.equal(api.sends.length, 0);
  });

  it('a scan that is still running holds follow-ups', async () => {
    let release;
    const gate = new Promise((r) => { release = r; });
    let seen;
    const started = new Promise((r) => { seen = r; });
    const api = installApi({
      inboxIds: ['m0001'],
      hangGet: async () => { seen(); await gate; },
    });
    await insertDueFollowup('running');
    const inflight = send.checkInbox();
    try {
      await started;
      const tick = await send.senderTick();
      assert.equal(tick.held, true);
      assert.equal(api.sends.length, 0);
    } finally {
      release();
      await inflight.catch(() => {});
    }
  });

  it('a hung scan past SCAN_TIMEOUT_MS holds follow-ups', async () => {
    let release;
    const gate = new Promise((r) => { release = r; });
    let seen;
    const started = new Promise((r) => { seen = r; });
    const api = installApi({
      inboxIds: ['m0001'],
      hangGet: async () => { seen(); await gate; },
    });
    await insertDueFollowup('hung');
    const inflight = send.checkInbox();
    try {
      await started;
      now += send.SCAN_TIMEOUT_MS + 1000;
      const tick = await send.senderTick();
      assert.equal(tick.held, true);
      assert.equal(api.sends.length, 0);
      const later = await send.checkInbox();
      assert.equal(later.caught_up, false);
      assert.equal(later.hung, true);
    } finally {
      release();
      await inflight.catch(() => {});
    }
  });

  it('a scan that throws holds follow-ups', async () => {
    const api = installApi({ inboxIds: [] });
    await insertDueFollowup('threw');
    const orig = pool.query.bind(pool);
    pool.query = async (sql, params) => {
      const text = String(sql);
      if (text.includes("pr.status = 'sent'") && text.includes('to_email IS NOT NULL') && !text.includes('followup1_sent_at')) {
        throw new Error('inbox scan blew up');
      }
      return orig(sql, params);
    };
    try {
      const tick = await send.senderTick();
      assert.equal(tick.held, true);
      assert.equal(api.sends.length, 0);
    } finally {
      pool.query = orig;
    }
  });

  it('a hold past HOLD_ALERT_AFTER_TICKS logs one alert and shows in sendReadiness', async () => {
    installApi({
      inboxIds: ['m0001'],
      failGet: () => Object.assign(new Error('Gmail API: Backend Error'), { status: 500, quota: false }),
    });
    await insertDueFollowup('alert');
    const lines = [];
    const orig = console.error;
    console.error = (...args) => { lines.push(args.join(' ')); };
    try {
      for (let i = 0; i < send.HOLD_ALERT_AFTER_TICKS - 1; i += 1) {
        const tick = await send.senderTick();
        assert.equal(tick.held, true);
      }
      assert.equal(lines.filter((l) => l.includes('alert: follow-ups held')).length, 0);
      const early = await send.sendReadiness();
      assert.equal(early.some((p) => /on hold/i.test(p)), false);
      await send.senderTick();
      await send.senderTick();
      const alerts = lines.filter((l) => l.includes('alert: follow-ups held'));
      assert.equal(alerts.length, 1);
      const readiness = await send.sendReadiness();
      assert.ok(readiness.some((p) => /inbox/i.test(p) && /caught up|on hold/i.test(p)));
    } finally {
      console.error = orig;
    }
  });

  it('a manual check during a cron scan stays inside the shared per-minute budget', async () => {
    let release;
    const gate = new Promise((r) => { release = r; });
    let seen;
    const started = new Promise((r) => { seen = r; });
    let hung = false;
    const api = installApi({
      inboxIds: newestFirstIds(150),
      hangGet: async (id) => {
        if (!hung && id === 'm0001') { hung = true; seen(); await gate; }
      },
    });
    await insertDueFollowup('shared');
    const cron = send.checkInbox();
    try {
      await started;
      const manual = await send.checkInbox();
      assert.equal(manual.caught_up, false);
      assert.ok(api.units() <= 6000, `overlap spent ${api.units()}`);
      const during = api.calls.filter((c) => String(c.path).startsWith('/messages/')).length;
      assert.ok(during < 60, 'the manual check must not open a second full read budget');
    } finally {
      release();
      await cron.catch(() => {});
    }
    await send.checkInbox();
    assert.ok(api.units() <= 6000, `same-minute checks spent ${api.units()}`);
  });

  it('the shared read budget resets each minute', async () => {
    const api = installApi({ inboxIds: newestFirstIds(150) });
    await insertDueFollowup('reset-minute');
    await send.checkInbox();
    const first = api.units();
    assert.ok(first > gmail.COST.get);
    assert.ok(first <= 6000);
    await send.checkInbox();
    const second = api.units();
    assert.ok(second - first < gmail.COST.get, 'the same minute does not buy another full read');
    assert.ok(second <= 6000);
    now += 60 * 1000;
    await send.checkInbox();
    const third = api.units();
    assert.ok(third - second > gmail.COST.get, 'a new minute can read again');
    assert.ok(third - second <= 6000);
  });

  it('M12 senderTick holds follow-ups when the inbox is not caught up', async () => {
    const api = installApi({ inboxIds: newestFirstIds(80) });
    await insertDueFollowup('m12');
    const tick = await send.senderTick();
    assert.equal(tick.held, true);
    assert.equal(tick.sent, 0);
    assert.equal(api.sends.length, 0);
  });

  it('M13 POST /check-inbox holds follow-ups instead of sending', async () => {
    const api = installApi({ inboxIds: newestFirstIds(80) });
    await insertDueFollowup('m13');
    const app = express();
    app.use(express.json());
    app.use('/api/proposals', require('../src/api/proposals'));
    const server = app.listen(0, '127.0.0.1');
    await new Promise((r) => server.once('listening', r));
    try {
      const res = await fetch(`http://127.0.0.1:${server.address().port}/api/proposals/check-inbox`, { method: 'POST' });
      const body = await res.json();
      assert.equal(res.status, 200);
      assert.equal(body.followups.held, true);
      assert.equal(body.followups.sent, 0);
      assert.equal(body.inbox.caught_up, false);
      assert.equal(api.sends.length, 0);
    } finally {
      await new Promise((r) => server.close(r));
    }
  });

  it('M14 markScanned runs only after the reply outcome is written', async () => {
    installApi({ inboxIds: ['m0001'], bodies: { m0001: 'Yes, let us talk this week.' } });
    const lead = await insertDueFollowup('m14', 'owner-m0001@gmail.com');
    const orig = pool.query.bind(pool);
    let statusWhenMarked = null;
    pool.query = async (sql, params) => {
      if (String(sql).includes('INSERT INTO gmail_scanned_messages')) {
        const { rows } = await orig('SELECT status FROM proposals WHERE id = $1', [lead.proposal.id]);
        statusWhenMarked = rows[0].status;
      }
      return orig(sql, params);
    };
    try {
      await send.checkInbox();
    } finally {
      pool.query = orig;
    }
    assert.equal(statusWhenMarked, 'replied');
  });

  it('markScanned skips a bad id and keeps the rest of the batch', async () => {
    const bad = 'x'.repeat(65);
    const n = await gmail.markScanned([
      { id: 'good_id-1', box: 'inbox' },
      { id: 'bad/id', box: 'inbox' },
      { id: bad, box: 'sent' },
      { id: 'also-good', box: 'sent' },
    ]);
    assert.equal(n, 2);
    const { rows } = await pool.query('SELECT gmail_id FROM gmail_scanned_messages ORDER BY gmail_id');
    assert.deepEqual(rows.map((r) => r.gmail_id), ['also-good', 'good_id-1']);
  });

  it('resetDb truncates gmail_scanned_messages', async () => {
    await pool.query(`INSERT INTO gmail_scanned_messages (gmail_id, box) VALUES ('abc_DEF-123', 'inbox')`);
    await resetDb();
    const { rows } = await pool.query('SELECT COUNT(*)::int AS n FROM gmail_scanned_messages');
    assert.equal(rows[0].n, 0);
  });

  it('B5 a scan that crosses a minute cannot push the next check over 6000 units', async () => {
    now = Date.parse('2026-11-06T18:00:50Z');
    let release;
    const gate = new Promise((r) => { release = r; });
    let seen;
    const started = new Promise((r) => { seen = r; });
    let hung = false;
    const api = installApi({
      inboxIds: newestFirstIds(150),
      hangGet: async (id) => {
        if (!hung && id === 'm0001') { hung = true; seen(); await gate; }
      },
    });
    await insertDueFollowup('b5-minute');
    const inflight = send.checkInbox();
    try {
      await started;
      now = Date.parse('2026-11-06T18:01:01Z');
    } finally {
      release();
      await inflight.catch(() => {});
    }
    await send.checkInbox();
    const minuteKey = Math.floor(Date.parse('2026-11-06T18:01:01Z') / 60000);
    const spent = api.calls
      .filter((c) => Math.floor(c.at / 60000) === minuteKey)
      .reduce((n, c) => n + countUnits(c), 0);
    assert.ok(spent <= 6000, `the new minute spent ${spent} units`);
    assert.equal(api.sends.length, 0);
  });


  it('B1 a mailbox of 10002 ids still reads the oldest first', async () => {
    const n = 10002;
    const ids = Array.from({ length: n }, (_, i) => `m${String(n - i).padStart(5, '0')}`);
    installApi({ inboxIds: ids });
    const r = await gmail.scanInbox(new Date('2026-10-01T00:00:00Z'), gmail.readBudget());
    assert.equal(r.messages[0].id, 'm00001');
    assert.ok(r.backlog > 0);
  });

  it('gmail axios catch marks a 429 and a 403 rateLimitExceeded as quota', async () => {
    const previous = axios.defaults.adapter;
    let mode = '429';
    axios.defaults.adapter = async (config) => {
      const url = String(config.url || '');
      if (url.includes('oauth2.googleapis.com')) {
        return { data: { access_token: 'test-token', expires_in: 3600 }, status: 200, statusText: 'OK', headers: {}, config };
      }
      const status = mode === '429' ? 429 : 403;
      const data = mode === '429'
        ? { error: { message: "Quota exceeded for quota metric 'Total Query Cost'", errors: [{ reason: 'rateLimitExceeded' }] } }
        : { error: { message: 'Rate Limit Exceeded', errors: [{ reason: 'rateLimitExceeded' }] } };
      const err = new Error(`Request failed with status code ${status}`);
      err.response = { data, status, statusText: status === 429 ? 'Too Many Requests' : 'Forbidden', headers: {}, config };
      err.config = config;
      throw err;
    };
    try {
      await assert.rejects(
        () => gmail.scanInbox(new Date('2026-10-01T00:00:00Z'), gmail.readBudget()),
        (err) => err.quota === true && err.status === 429
      );
      mode = '403';
      await assert.rejects(
        () => gmail.scanInbox(new Date('2026-10-01T00:00:00Z'), gmail.readBudget()),
        (err) => err.quota === true && err.status === 403
      );
    } finally {
      axios.defaults.adapter = previous;
    }
  });

  function threadMessage(id, threadId, text, iso) {
    return {
      id,
      threadId,
      internalDate: String(Date.parse(iso)),
      payload: {
        mimeType: 'text/plain',
        headers: [
          { name: 'From', value: 'Owner <test+thread@example.com>' },
          { name: 'To', value: 'Owner <test+thread@example.com>' },
          { name: 'Subject', value: 'Re: idea' },
          { name: 'Message-ID', value: `<${id}@mail>` },
        ],
        body: { data: Buffer.from(text).toString('base64url') },
      },
    };
  }

  function installThreads({ inbox = [], sent = [] } = {}) {
    const byId = new Map([...inbox, ...sent].map((m) => [m.id, m]));
    gmail._setApiForTests(async (method, path, { params } = {}) => {
      if (method === 'post' && path === '/messages/send') {
        return { id: 'sent-1', threadId: 'thr-send' };
      }
      if (path === '/messages') {
        const list = (params.q || '').includes('in:sent') ? sent : inbox;
        const start = params.pageToken ? Number(params.pageToken) : 0;
        const page = list.slice(start, start + 100);
        const next = start + 100 < list.length ? String(start + 100) : undefined;
        return { messages: page.map((m) => ({ id: m.id, threadId: m.threadId })), nextPageToken: next };
      }
      return byId.get(path.split('/').pop());
    });
  }

  it('B14 a Gmail reply in the same check is applied once the inbox item exists', async () => {
    const inbox = [threadMessage('in1', 'thr-lead', 'Yes let us talk', '2026-11-06T15:00:00Z')];
    const sent = [
      threadMessage('sentB', 'thr-lead', 'Friday is better', '2026-11-06T17:00:00Z'),
      threadMessage('sentA', 'thr-lead', 'Thursday works', '2026-11-06T16:00:00Z'),
    ];
    installThreads({ inbox, sent });
    const lead = await insertDueFollowup('b14', 'test+thread@example.com');
    await pool.query(`UPDATE proposals SET thread_id = 'thr-lead' WHERE id = $1`, [lead.proposal.id]);
    const first = await send.checkInbox();
    assert.equal(first.replied_from_gmail, 1);
    const item = await pool.query('SELECT status, handled_note FROM inbox_items WHERE prospect_id = $1', [lead.prospect.id]);
    assert.equal(item.rows[0].status, 'handled');
    assert.equal(item.rows[0].handled_note, 'You replied from Gmail');
    const out = await pool.query(
      `SELECT body FROM inbox_messages WHERE prospect_id = $1 AND direction = 'out' ORDER BY received_at DESC`,
      [lead.prospect.id]
    );
    assert.equal(out.rows[0].body, 'Friday is better');
  });

  it('B15 the later Gmail reply is the one stored', async () => {
    const sent = [
      threadMessage('sentB', 'thr-b15', 'Friday is better', '2026-11-06T17:00:00Z'),
      threadMessage('sentA', 'thr-b15', 'Thursday works', '2026-11-06T16:00:00Z'),
    ];
    installThreads({ sent });
    const lead = await insertDueFollowup('b15', 'test+thread@example.com');
    await pool.query(`UPDATE proposals SET thread_id = 'thr-b15' WHERE id = $1`, [lead.proposal.id]);
    const { rows: [inbound] } = await pool.query(
      `INSERT INTO inbox_messages (prospect_id, proposal_id, direction, dedupe_key, thread_id, from_addr, subject, body, received_at)
       VALUES ($1, $2, 'in', 'b15-in', 'thr-b15', 'test+thread@example.com', 'Re: idea', 'Yes', '2026-11-06T15:00:00Z')
       RETURNING id`,
      [lead.prospect.id, lead.proposal.id]
    );
    await pool.query(
      `INSERT INTO inbox_items (prospect_id, proposal_id, message_id, status) VALUES ($1, $2, $3, 'failed')`,
      [lead.prospect.id, lead.proposal.id, inbound.id]
    );
    const result = await send.checkInbox();
    assert.equal(result.replied_from_gmail, 1);
    const out = await pool.query(
      `SELECT body FROM inbox_messages WHERE prospect_id = $1 AND direction = 'out'`,
      [lead.prospect.id]
    );
    assert.equal(out.rows.length, 1);
    assert.equal(out.rows[0].body, 'Friday is better');
  });

  it('B16 a 70900-id inbox reads on the first check and the hold clears', async () => {
    const n = 70900;
    const ids = Array.from({ length: n }, (_, i) => `n${String(n - i).padStart(6, '0')}`);
    installApi({ inboxIds: ids });
    const since = new Date('2026-10-01T00:00:00Z');
    const first = await gmail.scanInbox(since, gmail.readBudget());
    assert.ok(first.messages.length > 0, 'the first check reads messages');
    assert.equal(first.messages[0].id, ids[0], 'the newest id is read when the list does not fit');
    await gmail.markScanned(first.scanned.map((id) => ({ id, box: 'inbox' })));
    let backlog = first.backlog;
    let guard = 0;
    let stuck = 0;
    while (backlog > 0 && guard < 2000) {
      const r = await gmail.scanInbox(since, gmail.readBudget());
      await gmail.markScanned(r.scanned.map((id) => ({ id, box: 'inbox' })));
      if (r.messages.length === 0 && r.backlog >= backlog) stuck += 1;
      else stuck = 0;
      assert.ok(stuck < 8, 'the catch-up stopped making progress');
      backlog = r.backlog;
      guard += 1;
    }
    assert.equal(backlog, 0);
    const { rows } = await pool.query('SELECT COUNT(*)::int AS n FROM gmail_scanned_messages');
    assert.equal(rows[0].n, n);
  });

  it('B17 ordinary Sent mail does not hide a later Gmail reply', async () => {
    const lead = await insertDueFollowup('b17', 'test+b17@example.com');
    await pool.query(`UPDATE proposals SET thread_id = 'thr-open' WHERE id = $1`, [lead.proposal.id]);
    const { rows: [inbound] } = await pool.query(
      `INSERT INTO inbox_messages (prospect_id, proposal_id, direction, dedupe_key, thread_id, from_addr, subject, body, received_at)
       VALUES ($1, $2, 'in', 'b17-in', 'thr-open', 'test+b17@example.com', 'Re: idea', 'Thursday?', '2026-11-06T15:00:00Z')
       RETURNING id`,
      [lead.prospect.id, lead.proposal.id]
    );
    await pool.query(
      `INSERT INTO inbox_items (prospect_id, proposal_id, message_id, status) VALUES ($1, $2, $3, 'failed')`,
      [lead.prospect.id, lead.proposal.id, inbound.id]
    );
    const ordinary = Array.from({ length: 79 }, (_, i) => threadMessage(
      `old-${String(i + 1).padStart(3, '0')}`, `thr-old-${i + 1}`, 'shipping note', '2026-11-01T00:00:00Z'
    ));
    const reply = threadMessage('reply-new', 'thr-open', 'Friday is better', '2026-11-07T00:00:00Z');
    const sent = [reply, ...ordinary];
    installThreads({ sent });
    let tick;
    let stored = 0;
    for (let i = 0; i < 4; i += 1) {
      now += i === 0 ? 0 : 60 * 1000;
      tick = await send.senderTick();
      const out = await pool.query(
        `SELECT body FROM inbox_messages WHERE direction = 'out' AND thread_id = 'thr-open'`
      );
      stored = out.rows.length;
      if (stored) break;
    }
    assert.equal(stored, 1, 'the newest Gmail reply is applied');
    for (let i = 0; i < 4 && (!tick || tick.sent !== 1); i += 1) {
      now += 60 * 1000;
      tick = await send.senderTick();
    }
    assert.equal(tick.sent, 1, 'the due follow-up sends once ordinary Sent mail is covered');
  });

  it('B18 a new opt-out during a resumed scan is applied before a follow-up sends', async () => {
    const lead = await insertDueFollowup('b18', 'owner-NEWREPLY@gmail.com');
    const ids = newestFirstIds(10150);
    const arrived = [];
    gmail._setApiForTests(async (method, path, opts = {}) => {
      if (method === 'post' && path === '/messages/send') {
        return { id: 'sent-1', threadId: 'th-sent-1' };
      }
      if (method === 'get' && path === '/messages') {
        const q = String(opts.params?.q || '');
        const all = q.includes('in:sent') ? [] : [...arrived, ...ids];
        const start = Number(opts.params?.pageToken || 0);
        const slice = all.slice(start, start + 100);
        const next = start + 100;
        return {
          messages: slice.map((id) => ({ id })),
          nextPageToken: next < all.length ? String(next) : undefined,
        };
      }
      if (method === 'get' && path.startsWith('/messages/')) {
        const id = decodeURIComponent(path.slice('/messages/'.length));
        const text = id === 'NEWREPLY' ? 'please unsubscribe' : 'hello';
        return fakeMessage(id, text);
      }
      throw new Error(`unexpected ${method} ${path}`);
    });
    const first = await send.checkInbox();
    assert.equal(first.caught_up, false);
    arrived.unshift('NEWREPLY');
    let sentBefore = false;
    let opted = false;
    for (let i = 0; i < 8; i += 1) {
      now += 60 * 1000;
      const tick = await send.senderTick();
      const row = await pool.query('SELECT do_not_contact FROM prospects WHERE id = $1', [lead.prospect.id]);
      if (tick.sent === 1 && !row.rows[0].do_not_contact) sentBefore = true;
      if (row.rows[0].do_not_contact) { opted = true; break; }
    }
    assert.equal(sentBefore, false, 'a follow-up must not send while the new opt-out is unread');
    assert.equal(opted, true);
    const scanned = await pool.query(
      `SELECT 1 FROM gmail_scanned_messages WHERE gmail_id = 'NEWREPLY'`
    );
    assert.equal(scanned.rows.length, 1);
  });

  it('B19 an invalid page token is dropped and the next check starts at the head', async () => {
    const lead = await insertDueFollowup('b19', 'test+b19@example.com');
    const since = new Date(new Date(lead.proposal.sent_at).getTime() - 24 * 60 * 60 * 1000);
    const q = `in:inbox after:${Math.floor(since.getTime() / 1000)} -from:me`;
    await pool.query(
      `INSERT INTO gmail_list_state (query_key, page_token, pending_ids) VALUES ($1, 'bad-token', '{}')`,
      [q]);
    const tokens = [];
    const ids = newestFirstIds(10150);
    gmail._setApiForTests(async (method, path, opts = {}) => {
      if (method === 'post' && path === '/messages/send') {
        return { id: 'sent-1', threadId: 'th-sent-1' };
      }
      if (method === 'get' && path === '/messages') {
        const token = opts.params?.pageToken || null;
        tokens.push(token);
        if (token === 'bad-token' || token === 'missing-page') {
          const err = new Error('Gmail API: Invalid pageToken');
          err.status = token === 'missing-page' ? 404 : 400;
          throw err;
        }
        const start = Number(token || 0);
        const slice = ids.slice(start, start + 100);
        const next = start + 100;
        return {
          messages: slice.map((id) => ({ id })),
          nextPageToken: next < ids.length ? String(next) : undefined,
        };
      }
      if (method === 'get' && path.startsWith('/messages/')) {
        const id = decodeURIComponent(path.slice('/messages/'.length));
        return fakeMessage(id);
      }
      throw new Error(`unexpected ${method} ${path}`);
    });
    const first = await send.checkInbox();
    assert.equal(first.caught_up, false);
    const row = await pool.query('SELECT page_token FROM gmail_list_state WHERE query_key = $1', [q]);
    assert.ok(!row.rows.length || row.rows[0].page_token !== 'bad-token');
    assert.equal(tokens.filter((token) => token === 'bad-token').length, 1, 'the bad token is requested once');
    now += 60 * 1000;
    tokens.length = 0;
    const second = await send.checkInbox();
    assert.equal(tokens.includes('bad-token'), false);
    assert.equal(tokens[0], null, 'the next check lists from the head');
    assert.equal(second.caught_up, false, 'a large mailbox stays held until it is covered');
    await pool.query(
      `INSERT INTO gmail_list_state (query_key, page_token, pending_ids) VALUES ($1, 'missing-page', '{}')
       ON CONFLICT (query_key) DO UPDATE SET page_token = 'missing-page', pending_ids = '{}'`,
      [q]);
    now += 60 * 1000;
    tokens.length = 0;
    const third = await send.checkInbox();
    assert.equal(third.caught_up, false);
    assert.equal(tokens.filter((token) => token === 'missing-page').length, 1);
    const after404 = await pool.query('SELECT page_token FROM gmail_list_state WHERE query_key = $1', [q]);
    assert.ok(!after404.rows.length || after404.rows[0].page_token !== 'missing-page');
    now += 60 * 1000;
    tokens.length = 0;
    await send.checkInbox();
    assert.equal(tokens.includes('missing-page'), false);
  });

  it('B18 an opt-out at the head during the last tail page blocks the send', async () => {
    const lead = await insertDueFollowup('endopt', 'owner-endopt@gmail.com');
    const since = new Date(new Date(lead.proposal.sent_at).getTime() - 24 * 60 * 60 * 1000);
    const q = `in:inbox after:${Math.floor(since.getTime() / 1000)} -from:me`;
    const ids = newestFirstIds(10200);
    await pool.query(
      `INSERT INTO gmail_scanned_messages (gmail_id, box)
       SELECT id, 'inbox' FROM UNNEST($1::text[]) AS id`,
      [ids]);
    await pool.query(
      `INSERT INTO gmail_list_state (query_key, page_token, pending_ids) VALUES ($1, '10100', '{}')`,
      [q]);
    let seenTail = false;
    const sends = [];
    gmail._setApiForTests(async (method, path, opts = {}) => {
      if (method === 'post' && path === '/messages/send') {
        sends.push(opts.data);
        return { id: 'sent-1', threadId: 'th-sent-1' };
      }
      if (method === 'get' && path === '/messages') {
        const token = opts.params?.pageToken || null;
        const qtext = String(opts.params?.q || '');
        if (token === '10100') seenTail = true;
        const source = (!qtext.includes('in:sent') && token == null && seenTail)
          ? ['endopt', ...ids]
          : (qtext.includes('in:sent') ? [] : ids);
        const start = Number(token || 0);
        const slice = source.slice(start, start + 100);
        const next = start + 100;
        return {
          messages: slice.map((id) => ({ id })),
          nextPageToken: next < source.length ? String(next) : undefined,
        };
      }
      if (method === 'get' && path.startsWith('/messages/')) {
        const id = decodeURIComponent(path.slice('/messages/'.length));
        return fakeMessage(id, id === 'endopt' ? 'please unsubscribe' : 'hello');
      }
      throw new Error(`unexpected ${method} ${path}`);
    });
    const first = await send.senderTick();
    assert.equal(first.sent, 0);
    assert.equal(sends.length, 0);
    const mid = await pool.query('SELECT do_not_contact FROM prospects WHERE id = $1', [lead.prospect.id]);
    now += 60 * 1000;
    const second = await send.senderTick();
    assert.equal(second.sent, 0);
    assert.equal(sends.length, 0);
    const row = await pool.query('SELECT do_not_contact FROM prospects WHERE id = $1', [lead.prospect.id]);
    assert.equal(row.rows[0].do_not_contact, true);
    assert.equal(mid.rows[0].do_not_contact || row.rows[0].do_not_contact, true);
  });

  it('B17 unmatched Sent mail is marked read and the hold clears', async () => {
    await insertDueFollowup('plain', 'test+plain@example.com');
    const sent = Array.from({ length: 80 }, (_, i) => threadMessage(
      `pers-${String(i + 1).padStart(3, '0')}`,
      `pers-thr-${i}`,
      'personal note',
      '2026-11-01T00:00:00Z'
    ));
    installThreads({ sent });
    let tick;
    for (let i = 0; i < 4; i += 1) {
      now += i === 0 ? 0 : 60 * 1000;
      tick = await send.senderTick();
      if (tick && tick.sent === 1) break;
    }
    const scanned = await pool.query(
      `SELECT COUNT(*)::int AS n FROM gmail_scanned_messages WHERE box = 'sent' AND gmail_id LIKE 'pers-%'`);
    assert.equal(scanned.rows[0].n, 80);
    assert.equal(tick.sent, 1);
  });

  it('B14 a newer Sent reply waits only while its proposal inbound has no open item', async () => {
    const lead = await insertDueFollowup('defer', 'test+defer@example.com');
    await pool.query(`UPDATE proposals SET thread_id = 'thr-defer' WHERE id = $1`, [lead.proposal.id]);
    const { rows: [inbound] } = await pool.query(
      `INSERT INTO inbox_messages (prospect_id, proposal_id, direction, dedupe_key, thread_id, from_addr, subject, body, received_at)
       VALUES ($1, $2, 'in', 'defer-in', 'thr-defer', 'test+defer@example.com', 'Re: idea', 'Thursday?', '2026-11-06T15:00:00Z')
       RETURNING id`,
      [lead.prospect.id, lead.proposal.id]
    );
    installThreads({
      sent: [threadMessage('reply-wait', 'thr-defer', 'Friday is better', '2026-11-07T00:00:00Z')],
    });
    const first = await send.checkInbox();
    assert.equal(first.replied_from_gmail, 0);
    assert.equal(first.caught_up, false);
    const waiting = await pool.query(`SELECT 1 FROM gmail_scanned_messages WHERE gmail_id = 'reply-wait'`);
    assert.equal(waiting.rows.length, 0);
    await pool.query(
      `INSERT INTO inbox_items (prospect_id, proposal_id, message_id, status) VALUES ($1, $2, $3, 'failed')`,
      [lead.prospect.id, lead.proposal.id, inbound.id]
    );
    await pool.query(
      `UPDATE proposals SET followup1_due_at = NOW() + INTERVAL '30 days' WHERE id = $1`,
      [lead.proposal.id]);
    now += 60 * 1000;
    const second = await send.checkInbox();
    assert.equal(second.replied_from_gmail, 1);
    const scanned = await pool.query(`SELECT 1 FROM gmail_scanned_messages WHERE gmail_id = 'reply-wait'`);
    assert.equal(scanned.rows.length, 1, 'the applied reply is marked read in that same check');
    await insertDueFollowup('defer-next', 'test+defer-next@example.com');
    now += 60 * 1000;
    const third = await send.senderTick();
    assert.equal(third.held, undefined);
    assert.equal(third.sent, 1, 'the next tick sends the unrelated follow-up');
    const due = await pool.query(
      `SELECT followup1_sent_at FROM proposals WHERE to_email = 'test+defer-next@example.com'`);
    assert.ok(due.rows[0].followup1_sent_at);
  });

  for (const status of ['sent', 'handled', 'discarded']) {
    it(`B20 a ${status} inbox item does not hold unrelated follow-ups`, async () => {
      const closed = await insertDueFollowup(`closed-${status}`, `test+closed-${status}@example.com`);
      await pool.query(
        `UPDATE proposals SET status = 'replied', thread_id = $2, replied_at = NOW() WHERE id = $1`,
        [closed.proposal.id, `thr-${status}`]);
      const { rows: [inbound] } = await pool.query(
        `INSERT INTO inbox_messages (prospect_id, proposal_id, direction, dedupe_key, thread_id, from_addr, subject, body, received_at)
         VALUES ($1, $2, 'in', $3, $4, $5, 'Re: idea', 'Thanks', '2026-11-05T15:00:00Z')
         RETURNING id`,
        [closed.prospect.id, closed.proposal.id, `in-${status}`, `thr-${status}`, `test+closed-${status}@example.com`]
      );
      await pool.query(
        `INSERT INTO inbox_items (prospect_id, proposal_id, message_id, status) VALUES ($1, $2, $3, $4)`,
        [closed.prospect.id, closed.proposal.id, inbound.id, status]
      );
      const due = await insertDueFollowup(`due-${status}`, `test+due-${status}@example.com`);
      const sentId = `crm-${status}`;
      let fetches = 0;
      gmail._setApiForTests(async (method, path, { params } = {}) => {
        if (method === 'post' && path === '/messages/send') {
          return { id: `out-${status}`, threadId: 'thr-send' };
        }
        if (path === '/messages') {
          const list = (params.q || '').includes('in:sent')
            ? [{ id: sentId, threadId: `thr-${status}` }]
            : [];
          return { messages: list };
        }
        const id = decodeURIComponent(path.slice('/messages/'.length));
        if (id === sentId) fetches += 1;
        return threadMessage(id, `thr-${status}`, 'Already answered', '2026-11-06T17:00:00Z');
      });
      const ticks = [];
      for (let i = 0; i < 3; i += 1) {
        if (i) now += 60 * 1000;
        ticks.push(await send.senderTick());
      }
      assert.equal(fetches, 1, `${status}: later ticks do not fetch the same Sent id`);
      assert.equal(ticks[0].sent, 1);
      assert.notEqual(ticks[0].held, true);
      assert.notEqual(ticks[1].held, true);
      assert.notEqual(ticks[2].held, true);
      const row = await pool.query('SELECT followup1_sent_at FROM proposals WHERE id = $1', [due.proposal.id]);
      assert.ok(row.rows[0].followup1_sent_at);
      const scanned = await pool.query('SELECT 1 FROM gmail_scanned_messages WHERE gmail_id = $1', [sentId]);
      assert.equal(scanned.rows.length, 1);
    });
  }

  it('B19 a 400 on every page token clears the saved cursor and the next check starts at the head', async () => {
    const lead = await insertDueFollowup('wedge', 'test+wedge@example.com');
    const ids = newestFirstIds(10200);
    let reject = false;
    const tokens = [];
    gmail._setApiForTests(async (method, path, opts = {}) => {
      if (method === 'post' && path === '/messages/send') return { id: 'sent-1', threadId: 'th-sent-1' };
      if (method === 'get' && path === '/messages') {
        const token = opts.params?.pageToken || null;
        tokens.push(token);
        if (reject && token) {
          const err = new Error('Gmail API: Invalid pageToken');
          err.status = 400;
          throw err;
        }
        const qtext = String(opts.params?.q || '');
        const source = qtext.includes('in:sent') ? [] : ids;
        const start = Number(token || 0);
        const slice = source.slice(start, start + 100);
        const next = start + 100;
        return {
          messages: slice.map((id) => ({ id })),
          nextPageToken: next < source.length ? String(next) : undefined,
        };
      }
      if (method === 'get' && path.startsWith('/messages/')) {
        return fakeMessage(decodeURIComponent(path.slice('/messages/'.length)));
      }
      throw new Error(`unexpected ${method} ${path}`);
    });
    const first = await send.checkInbox();
    assert.equal(first.caught_up, false);
    const saved = await pool.query('SELECT page_token FROM gmail_list_state');
    assert.ok(saved.rows.some((row) => row.page_token));
    const deep = saved.rows.map((row) => row.page_token).filter(Boolean);
    reject = true;
    now += 60 * 1000;
    tokens.length = 0;
    const held = await send.checkInbox();
    assert.equal(held.caught_up, false);
    assert.equal(tokens[0], null);
    assert.equal(tokens.filter((token) => deep.includes(token)).length, 0);
    assert.equal(tokens.filter(Boolean).length, 1, 'one bad cursor is enough to stop the list');
    const cleared = await pool.query('SELECT page_token FROM gmail_list_state');
    for (const row of cleared.rows) assert.equal(deep.includes(row.page_token), false);
    reject = false;
    now += 60 * 1000;
    const recovered = await send.checkInbox();
    assert.ok(recovered.checked > 0, 'the next check reads from the head');
    assert.equal(recovered.caught_up, false);
    void lead;
  });

  it('B16 a 150000-id inbox keeps reading past the first window', async () => {
    const n = 150000;
    const ids = Array.from({ length: n }, (_, i) => `n${String(n - i).padStart(6, '0')}`);
    installApi({ inboxIds: ids });
    const since = new Date('2026-10-01T00:00:00Z');
    const first = await gmail.scanInbox(since, gmail.readBudget());
    assert.ok(first.messages.length > 0);
    assert.equal(first.messages[0].id, ids[0]);
    await gmail.markScanned(first.scanned.map((id) => ({ id, box: 'inbox' })));
    let scanned = first.scanned.length;
    let guard = 0;
    while (scanned < 11000 && guard < 400) {
      const r = await gmail.scanInbox(since, gmail.readBudget());
      assert.ok(r.messages.length > 0, 'a zero-read re-walk is not progress');
      await gmail.markScanned(r.scanned.map((id) => ({ id, box: 'inbox' })));
      const { rows } = await pool.query('SELECT COUNT(*)::int AS n FROM gmail_scanned_messages');
      assert.ok(rows[0].n > scanned);
      scanned = rows[0].n;
      guard += 1;
    }
    assert.ok(scanned > 10100, 'the catch-up leaves the first listed window');
  });

  it('resume state keeps ids that were read but not marked scanned', async () => {
    installApi({ inboxIds: ['only-one'] });
    const since = new Date('2026-10-01T00:00:00Z');
    const after = Math.floor(since.getTime() / 1000);
    await pool.query(
      `INSERT INTO gmail_list_state (query_key, page_token, pending_ids)
       VALUES ($1, NULL, '{keep-me}')`,
      [`in:inbox after:${after} -from:me`]);
    const first = await gmail.scanInbox(since, gmail.readBudget());
    assert.ok(first.scanned.includes('keep-me'));
    const mid = await pool.query(`SELECT pending_ids FROM gmail_list_state`);
    assert.ok(mid.rows.some((row) => (row.pending_ids || []).includes('keep-me')));
    const second = await gmail.scanInbox(since, gmail.readBudget());
    assert.ok(second.scanned.includes('keep-me'));
    await gmail.markScanned(second.scanned.map((id) => ({ id, box: 'inbox' })));
    const third = await gmail.scanInbox(since, gmail.readBudget());
    assert.equal(third.scanned.includes('keep-me'), false);
  });
});
