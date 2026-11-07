process.env.SEND_HOURS = '0,24';
process.env.SEND_DAYS = '0,1,2,3,4,5,6';
process.env.SENDER_ADDRESS = '1 Test Street, Provo, UT 84601';
process.env.GOOGLE_CLIENT_ID = 'b21-client';
process.env.GOOGLE_CLIENT_SECRET = 'b21-secret';

require('./preload');

// PR #125 round 10: an arrival wave cannot drop a listed unread opt-out
// (B21), a Sent reply on a rewrite_queued thread is applied once the item
// settles, and a failed Sent apply records no Sent id. Gmail is faked with
// _setApiForTests and disposable Postgres. Nothing is sent.

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const gmail = require('../src/proposals/gmail');
const send = require('../src/proposals/send');
const inbox = require('../src/proposals/inbox');
const { resetDb, insertProspect, closePool, pool } = require('./fixtures');

const OPT_OUT = 'o000250';

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
      body: { data: Buffer.from(text).toString('base64url') },
    },
  };
}

// Index i of the original mailbox is o<i>. The wave is w<i>.
function originalIds(n) {
  return Array.from({ length: n }, (_, i) => `o${String(i).padStart(6, '0')}`);
}
function waveIds(n) {
  return Array.from({ length: n }, (_, i) => `w${String(i).padStart(6, '0')}`);
}

// Page tokens are stable message ids, as in the Security and Fresh-review
// repro: each token is the last id on its page, and the next page starts
// after that id wherever it now sits. Newer mail does not move a token.
function installAnchored(initial) {
  const calls = [];
  const sends = [];
  let ids = [];
  let index = new Map();
  const setInbox = (next) => {
    ids = next.slice();
    index = new Map(ids.map((id, i) => [id, i]));
  };
  setInbox(initial);
  gmail._setApiForTests(async (method, path, { data, params } = {}) => {
    calls.push({ method, path, params });
    if (method === 'post' && path === '/messages/send') {
      sends.push(data);
      return { id: `sent-${sends.length}`, threadId: `th-sent-${sends.length}` };
    }
    if (path === '/messages') {
      if (String(params.q || '').includes('in:sent')) return { messages: [] };
      let start = 0;
      if (params.pageToken) {
        if (!index.has(params.pageToken)) {
          throw Object.assign(new Error('Gmail API: Invalid pageToken'), { status: 400, quota: false });
        }
        start = index.get(params.pageToken) + 1;
      }
      const page = ids.slice(start, start + 100);
      const more = start + 100 < ids.length;
      return {
        messages: page.map((id) => ({ id, threadId: `t-${id}` })),
        nextPageToken: more ? page[page.length - 1] : undefined,
      };
    }
    const id = decodeURIComponent(path.slice('/messages/'.length));
    if (String(id).startsWith('sent-')) {
      return { id, payload: { headers: [{ name: 'Message-ID', value: `<${id}@mail.gmail.com>` }] } };
    }
    return fakeMessage(id, id === OPT_OUT ? 'please unsubscribe' : `reply ${id}`);
  });
  return {
    sends,
    setInbox,
    fetched: (id) => calls.filter((c) => c.method === 'get' && c.path === `/messages/${id}`).length,
  };
}

async function connectGmail() {
  await pool.query(
    `INSERT INTO app_settings (key, value) VALUES ('gmail_oauth', $1::jsonb)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [JSON.stringify({ refresh_token: 'b21-refresh', email: 'qa@example.com' })]
  );
}

async function insertDueFollowup(tag, email) {
  const p = await insertProspect({
    company: `TEST: B21 ${tag}`,
    industry: 'HVAC',
    city: 'Lehi',
    state: 'UT',
    google_place_id: `test-place-b21-${tag}`,
    website: null,
    email,
  });
  const { rows } = await pool.query(
    `INSERT INTO proposals (prospect_id, version, status, slug, to_email, subject, body, followup1, followup2,
                            sent_at, followup1_due_at, followup2_due_at, message_id, thread_id)
     VALUES ($1, 1, 'sent', $2, $3, 'idea', 'Hi', 'Follow up one', 'Follow up two',
             NOW() - INTERVAL '5 days', NOW() - INTERVAL '2 days', NOW() + INTERVAL '5 days',
             $4, $5) RETURNING *`,
    [p.id, `test-b21-${tag}-${Date.now()}`, email, `<msg-${tag}@test>`, `thread-${tag}`]
  );
  return { prospect: p, proposal: rows[0] };
}

async function leadState(lead) {
  const { rows } = await pool.query(
    `SELECT p.do_not_contact, pr.followup1_sent_at
       FROM proposals pr JOIN prospects p ON p.id = pr.prospect_id
      WHERE pr.id = $1`,
    [lead.proposal.id]);
  return rows[0];
}

async function inboxListState() {
  const { rows } = await pool.query(
    `SELECT page_token, pending_ids FROM gmail_list_state WHERE query_key LIKE 'in:inbox %'`);
  return rows[0] || { page_token: null, pending_ids: [] };
}

describe('gmail quota round 10 (B21, rewrite_queued, failed Sent apply)', () => {
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

  // The first check lists the newest 10,100 ids, reads 51, and saves a token
  // past them. The opt-out at index 250 was listed and not read.
  async function firstCheckThenWave(api, lead) {
    const first = await send.senderTick();
    assert.equal(first.held, true);
    assert.equal(api.sends.length, 0);
    assert.equal(api.fetched(OPT_OUT), 0, 'the first check lists the opt-out but does not read it');
    const state = await inboxListState();
    assert.equal(state.page_token, 'o010099');
    // 10,100 newer messages arrive. The opt-out moves to index 10350, past the
    // next head list (the newest 10,100) and before the saved token.
    api.setInbox([...waveIds(10100), ...originalIds(10200)]);
    assert.equal((await leadState(lead)).do_not_contact, false);
    return state;
  }

  it('B21 seeded: after an arrival wave the next check reads the opt-out before the follow-up sends', async () => {
    const lead = await insertDueFollowup('optout', `owner-${OPT_OUT}@gmail.com`);
    const other = await insertDueFollowup('other', 'test+b21-other@example.com');
    const api = installAnchored(originalIds(10200));
    const saved = await firstCheckThenWave(api, lead);

    // Model a later catch-up: every other id is already read.
    const rest = [...waveIds(10100), ...originalIds(10200)].filter((id) => id !== OPT_OUT);
    await pool.query(
      `INSERT INTO gmail_scanned_messages (gmail_id, box)
       SELECT id, 'inbox' FROM UNNEST($1::text[]) AS id ON CONFLICT DO NOTHING`,
      [rest]);

    now += 60 * 1000;
    const tick = await send.senderTick();
    const optedOut = await leadState(lead);
    assert.equal(optedOut.followup1_sent_at, null, 'no follow-up to the lead who opted out');
    assert.equal(optedOut.do_not_contact, true, 'the opt-out is applied');
    assert.equal(api.fetched(OPT_OUT), 1, 'the opt-out is read from pending_ids');
    // The check did catch up, so an unrelated follow-up still goes out.
    assert.notEqual(tick.held, true);
    assert.equal(tick.sent, 1);
    assert.ok((await leadState(other)).followup1_sent_at);
    assert.equal(api.sends.length, 1);
    assert.ok(saved.pending_ids.includes(OPT_OUT), 'the first check kept the listed, unread opt-out in pending_ids');
  });

  it('B21 unseeded: tick by tick after an arrival wave, nothing sends before the opt-out is applied', async () => {
    const lead = await insertDueFollowup('optout-ticks', `owner-${OPT_OUT}@gmail.com`);
    const api = installAnchored(originalIds(10200));
    await firstCheckThenWave(api, lead);

    let ticks = 0;
    let dnc = false;
    while (!dnc && ticks < 700) {
      now += 60 * 1000;
      const tick = await send.senderTick();
      ticks += 1;
      const row = await leadState(lead);
      dnc = row.do_not_contact === true;
      if (!dnc) {
        assert.notEqual(tick.sent, 1, `tick ${ticks} sent before the opt-out was applied`);
        assert.equal(api.sends.length, 0, `tick ${ticks} sent before the opt-out was applied`);
        assert.equal(row.followup1_sent_at, null);
      }
    }
    assert.equal(dnc, true, `the opt-out was applied (after ${ticks} ticks)`);
    assert.equal(api.fetched(OPT_OUT), 1);
    assert.equal(api.sends.length, 0);
    assert.equal((await leadState(lead)).followup1_sent_at, null);
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

  function installSent(sent) {
    const byId = new Map(sent.map((m) => [m.id, m]));
    let fetches = 0;
    gmail._setApiForTests(async (method, path, { params } = {}) => {
      if (method === 'post' && path === '/messages/send') return { id: 'sent-1', threadId: 'thr-send' };
      if (path === '/messages') {
        const list = String(params.q || '').includes('in:sent') ? sent : [];
        return { messages: list.map((m) => ({ id: m.id, threadId: m.threadId })) };
      }
      fetches += 1;
      return byId.get(decodeURIComponent(path.slice('/messages/'.length)));
    });
    return { fetches: () => fetches };
  }

  async function threadWithItem(tag, status) {
    const lead = await insertDueFollowup(tag, `test+${tag}@example.com`);
    const thread = `thr-${tag}`;
    await pool.query(`UPDATE proposals SET thread_id = $2 WHERE id = $1`, [lead.proposal.id, thread]);
    const { rows: [inbound] } = await pool.query(
      `INSERT INTO inbox_messages (prospect_id, proposal_id, direction, dedupe_key, thread_id, from_addr, subject, body, received_at)
       VALUES ($1, $2, 'in', $3, $4, $5, 'Re: idea', 'Can you change the times?', '2026-11-06T15:00:00Z')
       RETURNING id`,
      [lead.prospect.id, lead.proposal.id, `in-${tag}`, thread, `test+${tag}@example.com`]
    );
    const { rows: [item] } = await pool.query(
      `INSERT INTO inbox_items (prospect_id, proposal_id, message_id, status) VALUES ($1, $2, $3, $4) RETURNING id`,
      [lead.prospect.id, lead.proposal.id, inbound.id, status]
    );
    return { lead, thread, itemId: item.id };
  }

  async function itemRow(id) {
    const { rows } = await pool.query('SELECT status, handled_note FROM inbox_items WHERE id = $1', [id]);
    return rows[0];
  }

  async function isScanned(id) {
    const { rows } = await pool.query('SELECT 1 FROM gmail_scanned_messages WHERE gmail_id = $1', [id]);
    return rows.length === 1;
  }

  async function waitForStatusOutside(id, statuses) {
    for (let i = 0; i < 200; i += 1) {
      const row = await itemRow(id);
      if (!statuses.includes(row.status)) return row;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    return itemRow(id);
  }

  // The inbox worker claims rewrite_queued items with FOR UPDATE SKIP LOCKED.
  // Holding the row lock keeps the item rewrite_queued for the whole check,
  // as when the worker is busy with another item.
  async function holdItem(id) {
    const client = await pool.connect();
    await client.query('BEGIN');
    await client.query('SELECT id FROM inbox_items WHERE id = $1 FOR UPDATE', [id]);
    return async () => {
      try { await client.query('COMMIT'); } finally { client.release(); }
    };
  }

  it('QA r9 a newer Gmail reply on a rewrite_queued item stays unread, then is applied', async () => {
    // rewrite_queued is also what inbox.recover() leaves a rewrite cut off by a restart as.
    const { thread, itemId } = await threadWithItem('rq', 'rewrite_queued');
    const replyId = 'reply-rq';
    const api = installSent([threadMessage(replyId, thread, 'Friday at 10 works', '2026-11-06T17:00:00Z')]);

    const release = await holdItem(itemId);
    let first;
    try { first = await send.checkInbox(); }
    finally { await release(); }
    assert.equal((await itemRow(itemId)).status, 'rewrite_queued', 'the check saw the item rewrite_queued');
    assert.equal(first.replied_from_gmail, 0);
    assert.equal(first.caught_up, false, 'the waiting Sent id holds this check');
    assert.equal(await isScanned(replyId), false, 'the Sent id is not marked read while the item is rewrite_queued');

    // The rewrite finishes. In tests triage has no model, so it fails into
    // an applyable status.
    inbox.kick();
    const settled = await waitForStatusOutside(itemId, ['rewrite_queued', 'rewriting']);
    assert.ok(['failed', 'ready', 'fyi', 'queued'].includes(settled.status), `item settled as ${settled.status}`);

    now += 60 * 1000;
    const second = await send.checkInbox();
    assert.equal(second.replied_from_gmail, 1, 'the Gmail reply is applied');
    assert.equal(await isScanned(replyId), true);
    const item = await itemRow(itemId);
    assert.equal(item.status, 'handled');
    assert.equal(item.handled_note, 'You replied from Gmail');
    assert.equal(api.fetches(), 2, 'read once per check until it was applied');
  });

  it('#113 an opt-out that cannot commit leaves its Gmail id unread, and the next check applies it', async () => {
    const lead = await insertDueFollowup('optx', 'owner-optx1@gmail.com');
    const api = installAnchored(['optx1']);
    const optOutText = 'please unsubscribe';
    gmail._setApiForTests(async (method, path, opts = {}) => {
      if (path === '/messages') {
        if (String(opts.params?.q || '').includes('in:sent')) return { messages: [] };
        return { messages: [{ id: 'optx1', threadId: 't-optx1' }] };
      }
      return fakeMessage('optx1', optOutText);
    });
    let tries = 0;
    send._setOptOutGate(() => {
      tries += 1;
      throw Object.assign(new Error('deadlock detected'), { code: '40P01' });
    });
    const quiet = console.error;
    console.error = () => {};
    let first;
    try {
      first = await send.senderTick();
    } finally {
      console.error = quiet;
      send._setOptOutGate(null);
    }
    assert.equal(tries, 3, 'three tries, then the error is thrown');
    assert.equal(first.held, true, 'a check that threw holds follow-ups');
    assert.equal(await isScanned('optx1'), false, 'the opt-out message is not marked read');
    assert.equal((await leadState(lead)).do_not_contact, false);

    now += 60 * 1000;
    await send.checkInbox();
    const row = await leadState(lead);
    assert.equal(row.do_not_contact, true, 'the next check applies the opt-out');
    assert.equal(row.followup1_sent_at, null);
    const src = await pool.query('SELECT do_not_contact_source FROM prospects WHERE id = $1', [lead.prospect.id]);
    assert.equal(src.rows[0].do_not_contact_source, 'opt_out');
    assert.equal(await isScanned('optx1'), true);
    assert.equal(api.sends.length, 0);
  });

  it('a failed Sent apply records no Sent id and the next check applies it', async () => {
    const { thread, itemId } = await threadWithItem('apply-throws', 'ready');
    const replyId = 'reply-apply-throws';
    installSent([threadMessage(replyId, thread, 'Tuesday works', '2026-11-06T17:00:00Z')]);
    const real = inbox.applySentMessages;
    inbox.applySentMessages = async () => { throw new Error('db went away'); };
    let first;
    try { first = await send.checkInbox(); }
    finally { inbox.applySentMessages = real; }
    assert.equal(first.caught_up, false);
    assert.equal(await isScanned(replyId), false, 'a throw does not mark the Sent id read');

    now += 60 * 1000;
    const second = await send.checkInbox();
    assert.equal(second.replied_from_gmail, 1);
    assert.equal(await isScanned(replyId), true);
    assert.equal((await itemRow(itemId)).status, 'handled');
  });
});
