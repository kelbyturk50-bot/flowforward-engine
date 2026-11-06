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
    const call = { method, path, params, data };
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
    const r = await gmail.scanSent(new Date('2026-10-01T00:00:00Z'), gmail.readBudget());
    assert.equal(r.messages[0].id, 's0001');
    assert.ok(r.backlog > 0);
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
});
