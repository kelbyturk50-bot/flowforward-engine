process.env.CRM_API_KEY = 'test-dnc-manual-flag-key-32chars!!';

require('./preload');

// Manual do-not-contact flag. Disposable Postgres, mock mail transport.
// Fixture companies start with [TEST]. No send, no discovery, no live inbox.

const fs = require('fs');
const http = require('http');
const path = require('path');
const { spawn } = require('child_process');
const { EventEmitter } = require('events');
const { Readable } = require('stream');
const express = require('express');
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const send = require('../src/proposals/send');
const gmail = require('../src/proposals/gmail');
const inbox = require('../src/proposals/inbox');
const prospectsApi = require('../src/api/prospects');
const { draftProposal, _setClient, _setDraftTxnGate: _setDraftTxGate } = require('../src/proposals/draft');
const { fakeClaude } = require('./fixtures');
const cfg = require('../src/proposals/config');
const { applyMainSchema } = require('../src/db/migrate');
const { resetDb, insertProspect, closePool, pool } = require('./fixtures');

const API_KEY = process.env.CRM_API_KEY;
const WRONG_KEY = 'wrong-key-wrong-key-wrong-key-xx';
const MARKED = 'Marked do-not-contact (manual)';
const CLEARED = 'Cleared do-not-contact';

const sentMails = [];
let server;
let base;
let seq = 0;

function request(method, reqPath, { key, body, port } = {}) {
  const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
  return new Promise((resolve, reject) => {
    const headers = {};
    if (payload) {
      headers['content-type'] = 'application/json';
      headers['content-length'] = String(payload.length);
    }
    if (key !== undefined) headers['x-api-key'] = key;
    const req = http.request({
      hostname: '127.0.0.1',
      port: port || base.port,
      method,
      path: reqPath,
      headers,
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = text ? JSON.parse(text) : null; } catch { json = null; }
        resolve({
          status: res.statusCode,
          headers: res.headers,
          text,
          json,
        });
      });
    });
    req.on('error', reject);
    if (payload) req.end(payload);
    else req.end();
  });
}

function postFlag(id, body, key = API_KEY, port) {
  return request('POST', `/api/prospects/${id}/do-not-contact`, { key, body, port });
}

function scrub(text) {
  return String(text || '').split(API_KEY).join('[redacted]');
}

function recordingTransport() {
  return {
    async sendMail(mail) {
      sentMails.push(mail);
      return { messageId: `<dnc-${sentMails.length}@localhost>`, threadId: 'thr-dnc' };
    },
  };
}

function holdGate() {
  let release;
  let entered;
  const ready = new Promise((resolve) => { entered = resolve; });
  const gate = new Promise((resolve) => { release = resolve; });
  return {
    ready,
    release,
    async wait() {
      entered();
      await gate;
    },
  };
}

async function expectRowLocked(id) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await assert.rejects(
      client.query('SELECT id FROM prospects WHERE id = $1 FOR UPDATE NOWAIT', [id]),
      (err) => err.code === '55P03'
    );
  } finally {
    await client.query('ROLLBACK').catch(() => {});
    client.release();
  }
}

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = http.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

function stopChild(child) {
  return new Promise((resolve) => {
    if (!child || child.exitCode != null) {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolve();
    }, 2000);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
    child.kill('SIGTERM');
  });
}

async function lead(label, stage = 'qualified') {
  seq += 1;
  return insertProspect({
    google_place_id: `test-dnc-${seq}`,
    company: `[TEST] DNC ${label}`,
    email: `test+dnc-${seq}@dnc-${seq}.test`,
    website: null,
    stage,
    contact_name: 'Dana',
  });
}

async function proposal(prospectId, status, slug, version = 1) {
  const { rows } = await pool.query(
    `INSERT INTO proposals (
       prospect_id, version, status, slug, to_email, to_name, subject, body,
       sent_at, replied_at, message_id
     ) VALUES (
       $1, $4, $2, $3,
       (SELECT email FROM prospects WHERE id = $1),
       'Dana', 'Hi', 'Hello',
       NOW() - INTERVAL '2 days',
       CASE WHEN $2 = 'replied' THEN NOW() - INTERVAL '1 day' ELSE NULL END,
       $5
     ) RETURNING id, status, to_email`,
    [prospectId, status, slug, version, `<${slug}@localhost>`]
  );
  return rows[0];
}

async function flagRow(id) {
  const { rows } = await pool.query(
    `SELECT do_not_contact, do_not_contact_source, stage, email
       FROM prospects WHERE id = $1`,
    [id]
  );
  return rows[0];
}

async function activityBodies(id) {
  const { rows } = await pool.query(
    `SELECT type, body FROM prospect_activities WHERE prospect_id = $1 ORDER BY id`,
    [id]
  );
  return rows;
}

async function setSource(id, source, flagged = true) {
  await pool.query(
    `UPDATE prospects
        SET do_not_contact = $2, do_not_contact_source = $3
      WHERE id = $1`,
    [id, flagged, source]
  );
}

async function dueFollowup(prospectId, slug) {
  const row = await proposal(prospectId, 'sent', slug);
  await pool.query(
    `UPDATE proposals
        SET followup1 = 'Checking in',
            followup1_due_at = NOW() - INTERVAL '1 hour',
            followup1_sent_at = NULL,
            followup2_sent_at = NULL
      WHERE id = $1`,
    [row.id]
  );
  return row;
}

function widenSendWindow() {
  const days = cfg.SEND_DAYS.slice();
  const hours = cfg.SEND_HOURS.slice();
  cfg.SEND_DAYS = [0, 1, 2, 3, 4, 5, 6];
  cfg.SEND_HOURS = [0, 24];
  return () => {
    cfg.SEND_DAYS = days;
    cfg.SEND_HOURS = hours;
  };
}

async function drainInbox() {
  await new Promise((resolve) => setImmediate(resolve));
  for (let i = 0; i < 50 && inbox.isWorking(); i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function holdsRowShare(db, table) {
  const { rows } = await db.query(
    `SELECT 1
       FROM pg_locks
      WHERE pid = pg_backend_pid()
        AND locktype = 'relation'
        AND relation = $1::regclass
        AND mode = 'RowShareLock'
        AND granted
      LIMIT 1`,
    [table]
  );
  return rows.length > 0;
}

async function waitForLockWait(timeoutMs = 4000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const { rows } = await pool.query(
      `SELECT 1 FROM pg_locks WHERE granted = false LIMIT 1`
    );
    if (rows.length) return true;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return false;
}

async function waitForLockWaiters(count, timeoutMs = 8000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const { rows } = await pool.query(
      `SELECT COUNT(DISTINCT pid)::int AS n FROM pg_locks WHERE granted = false`
    );
    if (rows[0].n >= count) return true;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return false;
}

function sqlstateError(code) {
  const err = new Error('injected');
  err.code = code;
  return err;
}

function postMarkSent(id) {
  return request('POST', `/api/proposals/${id}/mark-sent`, { key: API_KEY, body: {} });
}

function postRestore(id) {
  return request('POST', `/api/proposals/${id}/restore`, { key: API_KEY, body: {} });
}

function inStack(name) {
  // A method call is "at Object.prepare", a direct call is "at accessToken".
  return new RegExp(`\\bat (?:async )?(?:Object\\.)?${name}\\b`).test(new Error().stack || '');
}

function gmailHttpResult(ctx) {
  const host = String(ctx.host || '');
  const reqPath = String(ctx.path || '');
  if (host.includes('oauth2.googleapis.com')) {
    return {
      status: 200,
      body: JSON.stringify({ access_token: 'test-access-token', expires_in: 3600, token_type: 'Bearer' }),
    };
  }
  if (reqPath.includes('/messages/send')) {
    return { status: 200, body: JSON.stringify({ id: 'gmail-test-id', threadId: 'gmail-test-thread' }) };
  }
  return {
    status: 200,
    body: JSON.stringify({ payload: { headers: [{ name: 'Message-ID', value: '<gmail-test@localhost>' }] } }),
  };
}

async function duringCompile(optOut, run) {
  const MimeNode = require('nodemailer/lib/mime-node');
  const orig = MimeNode.prototype.build;
  let armed = true;
  MimeNode.prototype.build = function build(callback) {
    const result = orig.call(this, callback);
    if (!armed) return result;
    armed = false;
    return Promise.resolve(result).then(async (buf) => {
      await optOut();
      return buf;
    });
  };
  try {
    await run();
  } finally {
    MimeNode.prototype.build = orig;
  }
}

async function readyReply(row, proposalId) {
  const msg = await pool.query(
    `INSERT INTO inbox_messages (
       prospect_id, proposal_id, direction, dedupe_key, from_addr, subject, body
     ) VALUES ($1, $2, 'in', $3, $4, 'Re: Hi', 'Sounds good')
     RETURNING id`,
    [row.id, proposalId, `test-dnc-ready-${row.id}-${proposalId}`, row.email]
  );
  const item = await pool.query(
    `INSERT INTO inbox_items (
       prospect_id, proposal_id, message_id, status, kind, reply_to, reply_subject, reply_body
     ) VALUES ($1, $2, $3, 'ready', 'interested', $4, 'Re: Hi', 'Thanks for the note.')
     RETURNING id`,
    [row.id, proposalId, msg.rows[0].id, row.email]
  );
  return item.rows[0];
}

const inboxMessage = (row, slug) => ({
  from: row.email,
  subject: 'Re: Hi',
  text: 'Please unsubscribe me.',
  date: new Date(),
  inReplyTo: `<${slug}@localhost>`,
});

describe('manual do-not-contact', () => {
  before(async () => {
    await resetDb();
    send._setTransport(recordingTransport());
    const app = express();
    app.use(express.json());
    app.use('/api', require('../src/api/auth'));
    app.use('/api/prospects', require('../src/api/prospects'));
    app.use('/api/proposals', require('../src/api/proposals'));
    server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = server.address();
  });

  after(async () => {
    send._setLeadStop(null);
    send._setOptOutGate(null);
    send._setLockGate(null);
    _setClient(null);
    _setDraftTxGate(null);
    prospectsApi._setFlagWriteGate(null);
    send._setTransport(null);
    await drainInbox();
    await pool.query(`DELETE FROM prospects WHERE google_place_id LIKE 'test-dnc-%'`).catch(() => {});
    if (server) await new Promise((resolve) => server.close(resolve));
    await closePool();
  });

  it('returns 401 without a key', async () => {
    const row = await lead('No Key');
    const missing = await request('POST', `/api/prospects/${row.id}/do-not-contact`, {
      body: { value: true },
    });
    assert.equal(missing.status, 401);
    assert.equal(missing.json.error, 'Missing or invalid API key');
    assert.match(missing.headers['content-type'], /application\/json/);
    const wrong = await request('POST', `/api/prospects/${row.id}/do-not-contact`, {
      key: WRONG_KEY,
      body: { value: true },
    });
    assert.equal(wrong.status, 401);
    assert.equal(wrong.json.error, 'Missing or invalid API key');
    assert.match(wrong.headers['content-type'], /application\/json/);
    const after = await flagRow(row.id);
    assert.equal(after.do_not_contact, false);
    assert.equal(after.do_not_contact_source, null);
    assert.equal((await activityBodies(row.id)).length, 0);
    console.log('[dnc] 401 without a key and with a wrong key');
  });

  it('returns 400 unless value is a strict boolean', async () => {
    const row = await lead('Bad Value');
    const cases = [
      ['string true', { value: 'true' }],
      ['string false', { value: 'false' }],
      ['number', { value: 1 }],
      ['zero', { value: 0 }],
      ['null', { value: null }],
      ['empty', {}],
    ];
    for (const [label, body] of cases) {
      const res = await postFlag(row.id, body);
      assert.equal(res.status, 400, label);
      assert.equal(res.json.error, 'invalid_body', label);
      assert.match(res.headers['content-type'], /application\/json/);
    }
    const after = await flagRow(row.id);
    assert.equal(after.do_not_contact, false);
    assert.equal(after.do_not_contact_source, null);
    assert.equal((await activityBodies(row.id)).length, 0);
    console.log('[dnc] 400 unless value is a strict boolean and the only field');
  });

  it('returns 400 for a non-numeric id and 404 for an unknown prospect', async () => {
    for (const id of ['abc', '1.5', '12abc', '0', '01', '00', '2147483648']) {
      const res = await postFlag(id, { value: true });
      assert.equal(res.status, 400, id);
      assert.equal(res.json.error, 'invalid_id', id);
      assert.match(res.headers['content-type'], /application\/json/);
    }
    const missing = await postFlag(2147483647, { value: true });
    assert.equal(missing.status, 404);
    assert.equal(missing.json.error, 'Not found');
    assert.match(missing.headers['content-type'], /application\/json/);
    console.log('[dnc] 400 for non-numeric, 0, and leading zeros; 404 unknown prospect');
  });

  it('returns 400 when the body has any field besides value', async () => {
    const row = await lead('Extra Field');
    const res = await postFlag(row.id, { value: true, extra: 1 });
    assert.equal(res.status, 400);
    assert.equal(res.json.error, 'invalid_body');
    assert.match(res.headers['content-type'], /application\/json/);
    const after = await flagRow(row.id);
    assert.equal(after.do_not_contact, false);
    assert.equal(after.do_not_contact_source, null);
    assert.equal((await activityBodies(row.id)).length, 0);
    console.log('[dnc] 400 for an unknown body field');
  });

  it('sets the flag, stops an active sequence, leaves the stage, and writes one activity', async () => {
    const row = await lead('Set', 'qualified');
    const sent = await proposal(row.id, 'sent', `dnc-sent-${row.id}`, 1);
    const draft = await proposal(row.id, 'draft', `dnc-draft-${row.id}`, 2);
    const replied = await proposal(row.id, 'replied', `dnc-replied-${row.id}`, 3);

    const res = await postFlag(row.id, { value: true });
    assert.equal(res.status, 200);
    assert.equal(res.json.id, row.id);
    assert.equal(res.json.do_not_contact, true);
    assert.equal(res.json.do_not_contact_source, 'manual');
    assert.equal(res.json.stage, 'qualified');
    assert.equal(res.json.company, row.company);

    const stored = await flagRow(row.id);
    assert.equal(stored.do_not_contact, true);
    assert.equal(stored.do_not_contact_source, 'manual');
    assert.equal(stored.stage, 'qualified');

    const proposals = await pool.query(
      `SELECT id, status, stop_reason FROM proposals WHERE prospect_id = $1 ORDER BY version`,
      [row.id]
    );
    const byId = Object.fromEntries(proposals.rows.map((p) => [p.id, p]));
    assert.equal(byId[sent.id].status, 'stopped');
    assert.equal(byId[sent.id].stop_reason, MARKED);
    assert.equal(byId[draft.id].status, 'stopped');
    assert.equal(byId[draft.id].stop_reason, MARKED);
    assert.equal(byId[replied.id].status, 'replied');
    assert.equal(byId[replied.id].stop_reason, null);

    const notes = await activityBodies(row.id);
    assert.deepEqual(notes, [{ type: 'note', body: MARKED }]);
    console.log('[dnc] manual set stops sent and draft, stage unchanged, activity written');
  });

  it('keeps an opt-out or NULL source when value is true and writes no activity', async () => {
    const opted = await lead('Keep Opt Out', 'contacted');
    await setSource(opted.id, 'opt_out', true);
    const stillSent = await proposal(opted.id, 'sent', `dnc-keep-opt-${opted.id}`);
    const optRes = await postFlag(opted.id, { value: true });
    assert.equal(optRes.status, 200);
    assert.equal(optRes.json.do_not_contact, true);
    assert.equal(optRes.json.do_not_contact_source, 'opt_out');
    assert.equal(optRes.json.stage, 'contacted');
    const optStored = await flagRow(opted.id);
    assert.equal(optStored.do_not_contact_source, 'opt_out');
    assert.equal((await activityBodies(opted.id)).length, 0);
    const optProposal = await pool.query(
      'SELECT status, stop_reason FROM proposals WHERE id = $1',
      [stillSent.id]
    );
    assert.equal(optProposal.rows[0].status, 'stopped');
    assert.equal(optProposal.rows[0].stop_reason, MARKED);

    // No writer leaves the flag down with a non-null source: a clear sets the
    // source to NULL, opt-out raises the flag, and a bounce writes no source.
    // The set path can see an existing source on this flagged opt_out row.
    const sourceKeep = await lead('Source Keep', 'contacted');
    await setSource(sourceKeep.id, 'opt_out', true);
    const sourceSent = await proposal(sourceKeep.id, 'sent', `dnc-source-keep-${sourceKeep.id}`);
    const sourceRes = await postFlag(sourceKeep.id, { value: true });
    assert.equal(sourceRes.status, 200);
    assert.equal(sourceRes.json.do_not_contact, true);
    assert.equal(sourceRes.json.do_not_contact_source, 'opt_out');
    assert.equal(Object.hasOwn(sourceRes.json, 'was_flagged'), false);
    assert.equal(Object.hasOwn(optRes.json, 'was_flagged'), false);
    assert.equal((await flagRow(sourceKeep.id)).do_not_contact_source, 'opt_out');
    assert.equal((await activityBodies(sourceKeep.id)).length, 0);
    const sourceStatus = await pool.query(
      'SELECT status FROM proposals WHERE id = $1',
      [sourceSent.id]
    );
    assert.equal(sourceStatus.rows[0].status, 'stopped');

    const automatic = await lead('Keep Null', 'found');
    await setSource(automatic.id, null, true);
    const nullRes = await postFlag(automatic.id, { value: true });
    assert.equal(nullRes.status, 200);
    assert.equal(nullRes.json.do_not_contact, true);
    assert.equal(nullRes.json.do_not_contact_source, null);
    assert.equal((await activityBodies(automatic.id)).length, 0);
    console.log('[dnc] true on opt_out and NULL keeps the source and writes no activity');
  });

  it('clears a manual flag and writes one activity', async () => {
    const row = await lead('Clear');
    const set = await postFlag(row.id, { value: true });
    assert.equal(set.status, 200);
    assert.equal(set.json.do_not_contact_source, 'manual');

    const cleared = await postFlag(row.id, { value: false });
    assert.equal(cleared.status, 200);
    assert.equal(cleared.json.do_not_contact, false);
    assert.equal(cleared.json.do_not_contact_source, null);
    assert.equal(cleared.json.stage, 'qualified');
    const stored = await flagRow(row.id);
    assert.equal(stored.do_not_contact, false);
    assert.equal(stored.do_not_contact_source, null);
    const notes = await activityBodies(row.id);
    assert.deepEqual(notes.map((n) => n.body), [MARKED, CLEARED]);
    console.log('[dnc] clear manual succeeds');
  });

  it('returns 409 when clearing opt_out or a NULL source', async () => {
    const cases = [
      ['opt_out', 'opt_out'],
      ['null source', null],
    ];
    for (const [label, source] of cases) {
      const row = await lead(`Lock ${label}`);
      await setSource(row.id, source, true);
      const res = await postFlag(row.id, { value: false });
      assert.equal(res.status, 409, label);
      assert.deepEqual(res.json, { error: 'do_not_contact_locked', source });
      assert.match(res.headers['content-type'], /application\/json/);
      const stored = await flagRow(row.id);
      assert.equal(stored.do_not_contact, true, label);
      assert.equal(stored.do_not_contact_source, source, label);
      assert.equal((await activityBodies(row.id)).length, 0, label);
    }
    console.log('[dnc] 409 on opt_out and NULL source');
  });

  it('writes nothing when the call does not change the flag', async () => {
    const manual = await lead('Noop Manual');
    assert.equal((await postFlag(manual.id, { value: true })).status, 200);
    const again = await postFlag(manual.id, { value: true });
    assert.equal(again.status, 200);
    assert.equal(again.json.do_not_contact_source, 'manual');
    assert.deepEqual((await activityBodies(manual.id)).map((n) => n.body), [MARKED]);

    const clear = await lead('Noop Clear');
    const res = await postFlag(clear.id, { value: false });
    assert.equal(res.status, 200);
    assert.equal(res.json.do_not_contact, false);
    assert.equal(res.json.do_not_contact_source, null);
    assert.equal((await activityBodies(clear.id)).length, 0);

    const opted = await lead('Noop Opt');
    await setSource(opted.id, 'opt_out', true);
    assert.equal((await postFlag(opted.id, { value: true })).status, 200);
    assert.equal((await activityBodies(opted.id)).length, 0);
    console.log('[dnc] no-ops write no activity');
  });

  it('records opt_out on both opt-out writes and leaves a bounce with no source', async () => {
    assert.equal(sentMails.length, 0);

    const opted = await lead('Inbox Opt', 'contacted');
    const optProposal = await proposal(opted.id, 'sent', `dnc-inbox-opt-${opted.id}`);
    const optResult = await send.applyInboxMessages([{
      from: opted.email,
      subject: 'Re: Hi',
      text: 'Please unsubscribe me.',
      date: new Date(),
      inReplyTo: `<dnc-inbox-opt-${opted.id}@localhost>`,
    }]);
    assert.equal(optResult.matched, 1);
    await drainInbox();
    const optRow = await flagRow(opted.id);
    assert.equal(optRow.do_not_contact, true);
    assert.equal(optRow.do_not_contact_source, 'opt_out');
    assert.equal(optRow.stage, 'lost');
    const optStatus = await pool.query('SELECT status FROM proposals WHERE id = $1', [optProposal.id]);
    assert.equal(optStatus.rows[0].status, 'opted_out');

    const follow = await lead('Inbox Follow', 'responded');
    await proposal(follow.id, 'replied', `dnc-inbox-follow-${follow.id}`);
    const followResult = await send.applyInboxMessages([{
      from: follow.email,
      subject: 'Re: Hi',
      text: 'Please unsubscribe me.',
      date: new Date(),
      inReplyTo: `<dnc-inbox-follow-${follow.id}@localhost>`,
    }]);
    assert.equal(followResult.follow_ons, 1);
    await drainInbox();
    const followRow = await flagRow(follow.id);
    assert.equal(followRow.do_not_contact, true);
    assert.equal(followRow.do_not_contact_source, 'opt_out');
    assert.equal(followRow.stage, 'lost');

    const bounced = await lead('Inbox Bounce', 'contacted');
    const beforeStage = bounced.stage;
    const bounceProposal = await proposal(bounced.id, 'sent', `dnc-inbox-bounce-${bounced.id}`);
    const bounceResult = await send.applyInboxMessages([{
      from: 'mailer-daemon@example.test',
      subject: 'Delivery Status Notification (Failure)',
      text: `Delivery to ${bounced.email} failed`,
      date: new Date(),
    }]);
    assert.equal(bounceResult.matched, 1);
    await drainInbox();
    const bounceRow = await flagRow(bounced.id);
    assert.equal(bounceRow.do_not_contact_source, null);
    assert.equal(bounceRow.email, null);
    assert.equal(bounceRow.stage, beforeStage);
    assert.equal(bounceRow.do_not_contact, false);
    const bounceStatus = await pool.query('SELECT status FROM proposals WHERE id = $1', [bounceProposal.id]);
    assert.equal(bounceStatus.rows[0].status, 'bounced');
    assert.equal(sentMails.length, 0);
    console.log('[dnc] opt-out source opt_out; follow-on opt_out; bounce leaves source NULL');
  });

  it('rejects do_not_contact and do_not_contact_source on PATCH', async () => {
    const row = await lead('Patch');
    await pool.query(`UPDATE prospects SET note = 'keep' WHERE id = $1`, [row.id]);

    const onlyFlag = await request('PATCH', `/api/prospects/${row.id}`, {
      key: API_KEY,
      body: { do_not_contact: true },
    });
    assert.equal(onlyFlag.status, 400);
    assert.equal(onlyFlag.json.error, 'field_not_editable');

    const onlySource = await request('PATCH', `/api/prospects/${row.id}`, {
      key: API_KEY,
      body: { do_not_contact_source: 'manual' },
    });
    assert.equal(onlySource.status, 400);
    assert.equal(onlySource.json.error, 'field_not_editable');

    const mixed = await request('PATCH', `/api/prospects/${row.id}`, {
      key: API_KEY,
      body: { note: 'changed', do_not_contact: true, do_not_contact_source: 'manual' },
    });
    assert.equal(mixed.status, 400);
    assert.equal(mixed.json.error, 'field_not_editable');

    const stored = await pool.query(
      `SELECT note, do_not_contact, do_not_contact_source FROM prospects WHERE id = $1`,
      [row.id]
    );
    assert.equal(stored.rows[0].note, 'keep');
    assert.equal(stored.rows[0].do_not_contact, false);
    assert.equal(stored.rows[0].do_not_contact_source, null);
    console.log('[dnc] PATCH rejects do_not_contact and do_not_contact_source');
  });

  it('applies schema.sql twice and does not backfill', async () => {
    const schema = fs.readFileSync(path.join(__dirname, '../src/db/schema.sql'), 'utf8');
    const start = schema.indexOf('ALTER TABLE prospects ADD COLUMN IF NOT EXISTS do_not_contact_source');
    const end = schema.indexOf('ALTER TABLE prospects ADD COLUMN IF NOT EXISTS researched_at');
    assert.ok(start > 0 && end > start);
    const block = schema.slice(start, end);
    assert.match(block, /DROP CONSTRAINT IF EXISTS prospects_do_not_contact_source_check;/);
    assert.match(block, /conname = 'prospects_dnc_source_v2_chk'/);
    assert.match(block, /t\.relname = 'prospects'/);
    assert.match(block, /do_not_contact_source IN \('manual', 'opt_out'\)/);
    assert.equal(block.includes("'bounce'"), false);
    const clearAt = block.indexOf('SET do_not_contact_source = NULL');
    const addAt = block.indexOf('ADD CONSTRAINT prospects_dnc_source_v2_chk');
    assert.ok(clearAt > 0 && clearAt < addAt);
    assert.match(block, /do_not_contact_source NOT IN \('manual', 'opt_out'\)/);

    const serverSrc = fs.readFileSync(path.join(__dirname, '../src/server.js'), 'utf8');
    const authAt = serverSrc.indexOf("app.use('/api', requireApiKey)");
    const prospectsAt = serverSrc.indexOf("app.use('/api/prospects'");
    assert.ok(authAt > 0 && authAt < prospectsAt);

    const row = await lead('Schema');
    await setSource(row.id, null, true);
    await applyMainSchema();
    await applyMainSchema();

    const stored = await flagRow(row.id);
    assert.equal(stored.do_not_contact, true);
    assert.equal(stored.do_not_contact_source, null);

    const column = await pool.query(
      `SELECT is_nullable, column_default
         FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'prospects'
          AND column_name = 'do_not_contact_source'`
    );
    assert.equal(column.rows.length, 1);
    assert.equal(column.rows[0].is_nullable, 'YES');
    assert.equal(column.rows[0].column_default, null);

    async function sourceConstraints() {
      const { rows } = await pool.query(
        `SELECT c.conname, pg_get_constraintdef(c.oid) AS def
           FROM pg_constraint c
           JOIN pg_class t ON t.oid = c.conrelid
           JOIN pg_namespace n ON n.oid = t.relnamespace
          WHERE t.relname = 'prospects'
            AND n.nspname = 'public'
            AND c.contype = 'c'
            AND c.conname IN (
              'prospects_dnc_source_v2_chk',
              'prospects_do_not_contact_source_check'
            )
          ORDER BY c.conname`
      );
      return rows;
    }

    let constraints = await sourceConstraints();
    assert.deepEqual(constraints.map((c) => c.conname), ['prospects_dnc_source_v2_chk']);
    assert.equal(constraints[0].def.includes('bounce'), false);

    await pool.query('ALTER TABLE prospects DROP CONSTRAINT prospects_dnc_source_v2_chk');
    await pool.query(
      `ALTER TABLE prospects
         ADD CONSTRAINT prospects_do_not_contact_source_check
         CHECK (
           do_not_contact_source IS NULL
           OR do_not_contact_source IN ('manual', 'opt_out', 'bounce')
         )`
    );
    const bounced = await lead('Schema Bounce');
    await pool.query(
      `UPDATE prospects
          SET do_not_contact = FALSE, do_not_contact_source = 'bounce'
        WHERE id = $1`,
      [bounced.id]
    );
    const flaggedBounce = await lead('Schema Flagged Bounce');
    await pool.query(
      `UPDATE prospects
          SET do_not_contact = TRUE, do_not_contact_source = 'bounce'
        WHERE id = $1`,
      [flaggedBounce.id]
    );
    const kept = await lead('Schema Keep Manual');
    await setSource(kept.id, 'manual', true);
    const keptOpt = await lead('Schema Keep Opt');
    await setSource(keptOpt.id, 'opt_out', true);
    await applyMainSchema();
    await applyMainSchema();

    const bouncedAfter = await flagRow(bounced.id);
    assert.equal(bouncedAfter.do_not_contact, false);
    assert.equal(bouncedAfter.do_not_contact_source, null);
    const flaggedBounceAfter = await flagRow(flaggedBounce.id);
    assert.equal(flaggedBounceAfter.do_not_contact, true);
    assert.equal(flaggedBounceAfter.do_not_contact_source, null);
    const keptAfter = await flagRow(kept.id);
    assert.equal(keptAfter.do_not_contact, true);
    assert.equal(keptAfter.do_not_contact_source, 'manual');
    const keptOptAfter = await flagRow(keptOpt.id);
    assert.equal(keptOptAfter.do_not_contact, true);
    assert.equal(keptOptAfter.do_not_contact_source, 'opt_out');
    const nullAfter = await flagRow(row.id);
    assert.equal(nullAfter.do_not_contact, true);
    assert.equal(nullAfter.do_not_contact_source, null);

    constraints = await sourceConstraints();
    assert.deepEqual(constraints.map((c) => c.conname), ['prospects_dnc_source_v2_chk']);
    assert.match(constraints[0].def, /manual/);
    assert.match(constraints[0].def, /opt_out/);
    assert.equal(constraints[0].def.includes('bounce'), false);

    for (const source of ['manual', 'opt_out', null]) {
      await pool.query(
        `UPDATE prospects SET do_not_contact_source = $2 WHERE id = $1`,
        [row.id, source]
      );
    }
    await assert.rejects(
      pool.query(`UPDATE prospects SET do_not_contact_source = 'bounce' WHERE id = $1`, [row.id]),
      (err) => err.code === '23514'
    );
    await assert.rejects(
      pool.query(`UPDATE prospects SET do_not_contact_source = 'other' WHERE id = $1`, [row.id]),
      (err) => err.code === '23514'
    );
    const still = await flagRow(row.id);
    assert.equal(still.do_not_contact_source, null);
    console.log('[dnc] schema.sql twice, and over the old check, leaves one v2 constraint');
  });

  it('stops a sending proposal in the same transaction as the flag', async () => {
    const row = await lead('Sending', 'qualified');
    const sending = await proposal(row.id, 'sending', `dnc-sending-${row.id}`);
    const res = await postFlag(row.id, { value: true });
    assert.equal(res.status, 200);
    assert.equal(res.json.do_not_contact, true);
    assert.equal(res.json.do_not_contact_source, 'manual');
    const stored = await pool.query(
      'SELECT status, stop_reason FROM proposals WHERE id = $1',
      [sending.id]
    );
    assert.equal(stored.rows[0].status, 'stopped');
    assert.equal(stored.rows[0].stop_reason, MARKED);
    assert.deepEqual((await activityBodies(row.id)).map((n) => n.body), [MARKED]);
    console.log('[dnc] flag update stops a sending proposal');
  });

  it('rolls the flag back when the stop fails, and a retry stops the sequence', async () => {
    const row = await lead('Stop Fails', 'contacted');
    const sent = await proposal(row.id, 'sent', `dnc-stop-fail-${row.id}`);
    send._setLeadStop(async () => {
      throw Object.assign(new Error('boom'), { code: 'XX000' });
    });
    try {
      const failed = await postFlag(row.id, { value: true });
      assert.equal(failed.status, 500);
      assert.equal(failed.json.error, 'server_error');
      const mid = await flagRow(row.id);
      assert.equal(mid.do_not_contact, false);
      assert.equal(mid.do_not_contact_source, null);
      const midProposal = await pool.query('SELECT status FROM proposals WHERE id = $1', [sent.id]);
      assert.equal(midProposal.rows[0].status, 'sent');
      assert.equal((await activityBodies(row.id)).length, 0);
    } finally {
      send._setLeadStop(null);
    }
    const retry = await postFlag(row.id, { value: true });
    assert.equal(retry.status, 200);
    assert.equal(retry.json.do_not_contact, true);
    assert.equal(retry.json.do_not_contact_source, 'manual');
    const done = await pool.query(
      'SELECT status, stop_reason FROM proposals WHERE id = $1',
      [sent.id]
    );
    assert.equal(done.rows[0].status, 'stopped');
    assert.equal(done.rows[0].stop_reason, MARKED);
    assert.deepEqual((await activityBodies(row.id)).map((n) => n.body), [MARKED]);
    console.log('[dnc] stop failure rolls back; retry stops the sequence');
  });

  it('does not claim or send a draft when the lead is already flagged', async () => {
    const row = await lead('Flagged Draft', 'qualified');
    await setSource(row.id, 'manual', true);
    const draft = await proposal(row.id, 'draft', `dnc-flagged-draft-${row.id}`);
    const before = sentMails.length;
    await assert.rejects(
      () => send.approveAndSend(draft.id),
      (err) => err.status === 409 && /do-not-contact/.test(err.message)
    );
    const stored = await pool.query(
      'SELECT status, approved_at FROM proposals WHERE id = $1',
      [draft.id]
    );
    assert.equal(stored.rows[0].status, 'draft');
    assert.equal(stored.rows[0].approved_at, null);
    assert.equal(sentMails.length, before);
    console.log('[dnc] flagged draft is not claimed or sent');
  });

  it('does not claim or send a follow-up when the lead is flagged', async () => {
    const restore = widenSendWindow();
    try {
      assert.equal(send.inSendWindow(), true);
      const row = await lead('Flagged Follow', 'contacted');
      await setSource(row.id, 'manual', true);
      const due = await dueFollowup(row.id, `dnc-flagged-follow-${row.id}`);
      const before = sentMails.length;
      const result = await send.sendDueFollowups();
      assert.equal(result.sent, 0);
      const stored = await pool.query(
        'SELECT status, stop_reason, followup1_sent_at FROM proposals WHERE id = $1',
        [due.id]
      );
      assert.equal(stored.rows[0].status, 'stopped');
      assert.equal(stored.rows[0].stop_reason, 'Lead is do-not-contact');
      assert.equal(stored.rows[0].followup1_sent_at, null);
      assert.equal(sentMails.length, before);
      console.log('[dnc] flagged follow-up is not claimed or sent');
    } finally {
      restore();
    }
  });

  async function parkedFollowup(prospectId, slug) {
    const row = await proposal(prospectId, 'sent', slug);
    await pool.query(
      `UPDATE proposals
          SET followup1_sent_at = NOW() - INTERVAL '3 days',
              followup2_sent_at = NULL,
              followup2_due_at = NULL
        WHERE id = $1`,
      [row.id]
    );
    const stored = await pool.query(
      'SELECT status, followup1_sent_at FROM proposals WHERE id = $1',
      [row.id]
    );
    return { id: row.id, status: stored.rows[0].status, followup1_sent_at: stored.rows[0].followup1_sent_at };
  }

  async function assertParked(parked) {
    const stored = await pool.query(
      'SELECT status, followup1_sent_at FROM proposals WHERE id = $1',
      [parked.id]
    );
    assert.equal(stored.rows[0].status, parked.status);
    assert.equal(
      new Date(stored.rows[0].followup1_sent_at).getTime(),
      new Date(parked.followup1_sent_at).getTime()
    );
  }

  it('keeps a first send stopped when the lead is flagged during the send itself', async () => {
    // #120 rechecks the lead right before the mail goes out. A flag that
    // commits after that recheck, while the message is in flight, stops the
    // 'sending' row (stopLeadSequences). #120's success write then matches
    // nothing: the row stays stopped, no follow-ups are scheduled, and the
    // operator gets the manual-review 409 instead of a "sent" row.
    const row = await lead('In Flight Flag', 'found');
    const draft = await proposal(row.id, 'draft', `dnc-inflight-${row.id}`);
    await pool.query(
      `UPDATE proposals
          SET sent_at = NULL, followup1 = 'Soon', followup2 = 'Later',
              followup1_due_at = NULL, followup2_due_at = NULL
        WHERE id = $1`,
      [draft.id]
    );
    let flagged = null;
    send._setTransport({
      async sendMail() {
        flagged = await postFlag(row.id, { value: true });
        return { messageId: '<dnc-inflight@localhost>', threadId: 'thr-inflight' };
      },
    });
    try {
      await assert.rejects(
        () => send.approveAndSend(draft.id),
        (err) => err.status === 409 && /manual review/i.test(err.message)
      );
    } finally {
      send._setTransport(recordingTransport());
    }
    assert.equal(flagged.status, 200);
    const stored = await pool.query(
      `SELECT status, stop_reason, followup1_due_at, followup2_due_at FROM proposals WHERE id = $1`,
      [draft.id]
    );
    assert.equal(stored.rows[0].status, 'stopped');
    assert.equal(stored.rows[0].stop_reason, 'Marked do-not-contact (manual)');
    assert.equal(stored.rows[0].followup1_due_at, null);
    assert.equal(stored.rows[0].followup2_due_at, null);
    const flag = await flagRow(row.id);
    assert.equal(flag.do_not_contact, true);
    assert.equal(flag.do_not_contact_source, 'manual');
    console.log('[dnc] a flag during the send keeps the row stopped with no follow-ups');
  });

  it('rolls back the opt-out when stopping sequences fails', async () => {
    send._setLeadStop(async () => {
      throw Object.assign(new Error('stop failed'), { code: 'XX000' });
    });
    try {
      const row = await lead('Opt Stop Fail', 'contacted');
      const before = await flagRow(row.id);
      const sent = await proposal(row.id, 'sent', `dnc-opt-rollback-${row.id}`);
      const sibling = await proposal(row.id, 'draft', `dnc-opt-rollback-sib-${row.id}`, 2);
      await assert.rejects(
        () => send.applyInboxMessages([{
          from: row.email,
          subject: 'Re: Hi',
          text: 'Please unsubscribe me.',
          date: new Date(),
          inReplyTo: `<dnc-opt-rollback-${row.id}@localhost>`,
        }]),
        (err) => err.code === 'XX000'
      );
      const flagged = await flagRow(row.id);
      assert.equal(flagged.do_not_contact, false);
      assert.equal(flagged.do_not_contact_source, null);
      assert.equal(flagged.stage, before.stage);
      const sentRow = await pool.query(
        'SELECT status, stop_reason FROM proposals WHERE id = $1',
        [sent.id]
      );
      assert.equal(sentRow.rows[0].status, 'sent');
      assert.equal(sentRow.rows[0].stop_reason, null);
      const siblingRow = await pool.query(
        'SELECT status, stop_reason FROM proposals WHERE id = $1',
        [sibling.id]
      );
      assert.equal(siblingRow.rows[0].status, 'draft');
      assert.equal(siblingRow.rows[0].stop_reason, null);
      assert.equal((await activityBodies(row.id)).length, 0);
      const inboxCount = await pool.query(
        'SELECT COUNT(*)::int AS n FROM inbox_items WHERE prospect_id = $1',
        [row.id]
      );
      assert.equal(inboxCount.rows[0].n, 0);

      const follow = await lead('Opt Stop Fail Follow', 'responded');
      const followBefore = await flagRow(follow.id);
      const replied = await proposal(follow.id, 'replied', `dnc-opt-rollback-re-${follow.id}`);
      const followDraft = await proposal(follow.id, 'draft', `dnc-opt-rollback-fd-${follow.id}`, 2);
      await assert.rejects(
        () => send.applyInboxMessages([{
          from: follow.email,
          subject: 'Re: Hi',
          text: 'Please unsubscribe me.',
          date: new Date(),
          inReplyTo: `<dnc-opt-rollback-re-${follow.id}@localhost>`,
        }]),
        (err) => err.code === 'XX000'
      );
      const followFlag = await flagRow(follow.id);
      assert.equal(followFlag.do_not_contact, false);
      assert.equal(followFlag.do_not_contact_source, null);
      assert.equal(followFlag.stage, followBefore.stage);
      const repliedRow = await pool.query(
        'SELECT status, stop_reason FROM proposals WHERE id = $1',
        [replied.id]
      );
      assert.equal(repliedRow.rows[0].status, 'replied');
      assert.equal(repliedRow.rows[0].stop_reason, null);
      const followDraftRow = await pool.query(
        'SELECT status, stop_reason FROM proposals WHERE id = $1',
        [followDraft.id]
      );
      assert.equal(followDraftRow.rows[0].status, 'draft');
      assert.equal(followDraftRow.rows[0].stop_reason, null);
      console.log('[dnc] a failed sequence stop rolls the opt-out back');
    } finally {
      send._setLeadStop(null);
    }
  });

  it('does not send a draft claimed after the opt-out commits', async () => {
    const row = await lead('Opt Then Claim', 'qualified');
    const sent = await proposal(row.id, 'sent', `dnc-opt-claim-${row.id}`);
    const earlier = await proposal(row.id, 'draft', `dnc-opt-claim-early-${row.id}`, 2);
    const before = sentMails.length;
    const opt = await send.applyInboxMessages([{
      from: row.email,
      subject: 'Re: Hi',
      text: 'Please unsubscribe me.',
      date: new Date(),
      inReplyTo: `<dnc-opt-claim-${row.id}@localhost>`,
    }]);
    assert.equal(opt.matched, 1);
    await drainInbox();
    const flagged = await flagRow(row.id);
    assert.equal(flagged.do_not_contact, true);
    assert.equal(flagged.do_not_contact_source, 'opt_out');
    assert.equal(flagged.stage, 'lost');
    const sentRow = await pool.query(
      'SELECT status, stop_reason FROM proposals WHERE id = $1',
      [sent.id]
    );
    assert.equal(sentRow.rows[0].status, 'opted_out');
    assert.equal(sentRow.rows[0].stop_reason, 'Asked not to be contacted');
    const earlierRow = await pool.query(
      'SELECT status, stop_reason FROM proposals WHERE id = $1',
      [earlier.id]
    );
    assert.equal(earlierRow.rows[0].status, 'stopped');
    assert.equal(earlierRow.rows[0].stop_reason, 'Asked not to be contacted');
    const item = await pool.query(
      'SELECT status, kind FROM inbox_items WHERE prospect_id = $1',
      [row.id]
    );
    assert.equal(item.rows.length, 1);
    assert.equal(item.rows[0].status, 'fyi');
    assert.equal(item.rows[0].kind, 'opt_out');

    const draft = await proposal(row.id, 'draft', `dnc-opt-claim-later-${row.id}`, 3);
    await pool.query('UPDATE proposals SET sent_at = NULL WHERE id = $1', [draft.id]);
    await assert.rejects(
      () => send.approveAndSend(draft.id),
      (err) => err.status === 409 && /do-not-contact/.test(err.message)
    );
    const stored = await pool.query(
      'SELECT status, sent_at, message_id FROM proposals WHERE id = $1',
      [draft.id]
    );
    assert.equal(stored.rows[0].status, 'draft');
    assert.equal(stored.rows[0].sent_at, null);
    assert.equal(stored.rows[0].message_id, `<dnc-opt-claim-later-${row.id}@localhost>`);
    assert.equal(sentMails.length, before);
    console.log('[dnc] a draft claimed after opt-out commits is not sent');
  });

  it('blocks a draft claimed while the opt-out transaction is stopping sequences', async () => {
    const row = await lead('Opt Claim Race', 'contacted');
    await proposal(row.id, 'sent', `dnc-opt-race-${row.id}`);
    const draft = await proposal(row.id, 'draft', `dnc-opt-race-d-${row.id}`, 2);
    await pool.query('UPDATE proposals SET sent_at = NULL WHERE id = $1', [draft.id]);
    const before = sentMails.length;
    let claim = null;
    // Run the real stop on the opt-out client and start a claim right after
    // it reads the lead's proposals, while the opt-out is still open.
    send._setLeadStop(async (db, prospectId, reason) => {
      send._setLeadStop(null);
      const watched = {
        async query(sql, params) {
          const result = await db.query(sql, params);
          if (!claim && /SELECT id, status FROM proposals/.test(sql)) {
            claim = send.approveAndSend(draft.id).then(
              () => ({ ok: true }),
              (err) => ({ ok: false, err })
            );
            await Promise.race([claim, new Promise((resolve) => setTimeout(resolve, 300))]);
          }
          return result;
        },
      };
      return send.stopLeadSequences(watched, prospectId, reason);
    });
    try {
      const opt = await send.applyInboxMessages([{
        from: row.email,
        subject: 'Re: Hi',
        text: 'Please unsubscribe me.',
        date: new Date(),
        inReplyTo: `<dnc-opt-race-${row.id}@localhost>`,
      }]);
      assert.equal(opt.matched, 1);
      await drainInbox();
    } finally {
      send._setLeadStop(null);
    }
    assert.ok(claim, 'the claim ran inside the opt-out');
    const outcome = await claim;
    assert.equal(outcome.ok, false);
    // #120's approve waits on the prospect lock the opt-out holds, then finds
    // the draft already stopped and refuses it with its own 409 sentence.
    assert.equal(outcome.err.status, 409);
    const stored = await pool.query(
      'SELECT status, stop_reason, sent_at FROM proposals WHERE id = $1',
      [draft.id]
    );
    assert.equal(stored.rows[0].status, 'stopped');
    assert.equal(stored.rows[0].stop_reason, 'Asked not to be contacted');
    assert.equal(stored.rows[0].sent_at, null);
    assert.equal(sentMails.length, before);
    console.log('[dnc] a draft claimed while the opt-out is open is not sent');
  });

  it('blocks a claim that arrives while stopLeadSequences holds the proposal row', async () => {
    const row = await lead('Stop Lock', 'qualified');
    const draft = await proposal(row.id, 'draft', `dnc-stop-lock-${row.id}`);
    await pool.query('UPDATE proposals SET sent_at = NULL WHERE id = $1', [draft.id]);
    const before = sentMails.length;
    const client = await pool.connect();
    let claim = null;
    send._setLeadStop(async (db, prospectId, reason) => {
      send._setLeadStop(null);
      const watched = {
        async query(sql, params) {
          const result = await db.query(sql, params);
          if (!claim && /SELECT id, status FROM proposals/.test(sql)) {
            claim = send.approveAndSend(draft.id).then(
              () => ({ ok: true }),
              (err) => ({ ok: false, status: err.status })
            );
            // This client does not already hold the row. The claim waits
            // only when this SELECT took FOR UPDATE.
            assert.equal(await waitForLockWait(), true);
          }
          return result;
        },
      };
      return send.stopLeadSequences(watched, prospectId, reason);
    });
    try {
      await client.query('BEGIN');
      await send.stopLeadSequences(client, row.id, 'Asked not to be contacted');
      await client.query('COMMIT');
    } finally {
      send._setLeadStop(null);
      await client.query('ROLLBACK').catch(() => {});
      client.release();
    }
    assert.ok(claim, 'the claim ran inside the stop');
    const outcome = await claim;
    assert.equal(outcome.ok, false);
    const stored = await pool.query(
      'SELECT status, sent_at FROM proposals WHERE id = $1',
      [draft.id]
    );
    assert.equal(stored.rows[0].status, 'stopped');
    assert.equal(stored.rows[0].sent_at, null);
    assert.equal(sentMails.length, before);
    console.log('[dnc] stopLeadSequences holds the proposal row so a claim cannot send');
  });

  it('stops lead sequences inside the opt-out transaction after the flag is set', async () => {
    async function seenInside(db, prospectId) {
      assert.notEqual(db, pool);
      const inside = await db.query(
        'SELECT do_not_contact, do_not_contact_source FROM prospects WHERE id = $1',
        [prospectId]
      );
      assert.equal(inside.rows[0].do_not_contact, true);
      assert.equal(inside.rows[0].do_not_contact_source, 'opt_out');
      const outside = await pool.query(
        'SELECT do_not_contact FROM prospects WHERE id = $1',
        [prospectId]
      );
      assert.equal(outside.rows[0].do_not_contact, false);
    }
    const row = await lead('Opt Inside', 'contacted');
    const sent = await proposal(row.id, 'sent', `dnc-opt-inside-${row.id}`);
    send._setLeadStop((db, prospectId) => seenInside(db, prospectId));
    try {
      const opt = await send.applyInboxMessages([{
        from: row.email,
        subject: 'Re: Hi',
        text: 'Please unsubscribe me.',
        date: new Date(),
        inReplyTo: `<dnc-opt-inside-${row.id}@localhost>`,
      }]);
      assert.equal(opt.matched, 1);
      await drainInbox();
      const flagged = await flagRow(row.id);
      assert.equal(flagged.do_not_contact, true);
      assert.equal(flagged.do_not_contact_source, 'opt_out');
      const sentRow = await pool.query('SELECT status FROM proposals WHERE id = $1', [sent.id]);
      assert.equal(sentRow.rows[0].status, 'opted_out');

      const follow = await lead('Opt Inside Follow', 'responded');
      await proposal(follow.id, 'replied', `dnc-opt-inside-re-${follow.id}`);
      const followOpt = await send.applyInboxMessages([{
        from: follow.email,
        subject: 'Re: Hi',
        text: 'Please unsubscribe me.',
        date: new Date(),
        inReplyTo: `<dnc-opt-inside-re-${follow.id}@localhost>`,
      }]);
      assert.equal(followOpt.matched, 0);
      assert.equal(followOpt.follow_ons, 1);
      await drainInbox();
      const followFlag = await flagRow(follow.id);
      assert.equal(followFlag.do_not_contact, true);
      assert.equal(followFlag.do_not_contact_source, 'opt_out');
      console.log('[dnc] opt-out stops sequences on its own transaction after the flag');
    } finally {
      send._setLeadStop(null);
      await drainInbox();
    }
  });

  it('does not clear or downgrade opt_out when a manual clear or set races it', async () => {
    const clearRow = await lead('Race Clear', 'contacted');
    await setSource(clearRow.id, 'manual', true);
    prospectsApi._setFlagWriteGate(async (client) => {
      await client.query('ROLLBACK');
      await pool.query(
        `UPDATE prospects
            SET do_not_contact = TRUE, do_not_contact_source = 'opt_out', stage = 'lost'
          WHERE id = $1`,
        [clearRow.id]
      );
      await client.query('BEGIN');
    });
    try {
      const cleared = await postFlag(clearRow.id, { value: false });
      assert.equal(cleared.status, 409);
      assert.equal(cleared.json.error, 'do_not_contact_locked');
      assert.equal(cleared.json.source, 'opt_out');
      const stored = await flagRow(clearRow.id);
      assert.equal(stored.do_not_contact, true);
      assert.equal(stored.do_not_contact_source, 'opt_out');
      assert.equal((await activityBodies(clearRow.id)).some((n) => n.body === CLEARED), false);
    } finally {
      prospectsApi._setFlagWriteGate(null);
    }

    const setRow = await lead('Race Set', 'contacted');
    prospectsApi._setFlagWriteGate(async (client) => {
      await client.query('ROLLBACK');
      await pool.query(
        `UPDATE prospects
            SET do_not_contact = TRUE, do_not_contact_source = 'opt_out', stage = 'lost'
          WHERE id = $1`,
        [setRow.id]
      );
      await client.query('BEGIN');
    });
    try {
      const set = await postFlag(setRow.id, { value: true });
      assert.equal(set.status, 200);
      assert.equal(set.json.do_not_contact, true);
      assert.equal(set.json.do_not_contact_source, 'opt_out');
      const stored = await flagRow(setRow.id);
      assert.equal(stored.do_not_contact_source, 'opt_out');
      assert.equal((await activityBodies(setRow.id)).length, 0);
    } finally {
      prospectsApi._setFlagWriteGate(null);
    }

    const routeRow = await lead('Race Route Lock', 'contacted');
    await setSource(routeRow.id, 'manual', true);
    const routeHold = holdGate();
    prospectsApi._setFlagWriteGate(() => routeHold.wait());
    const routePending = postFlag(routeRow.id, { value: false });
    try {
      await routeHold.ready;
      await expectRowLocked(routeRow.id);
    } finally {
      routeHold.release();
      prospectsApi._setFlagWriteGate(null);
    }
    const routeResult = await routePending;
    assert.equal(routeResult.status, 200);
    assert.equal((await flagRow(routeRow.id)).do_not_contact, false);

    const optRow = await lead('Race Opt Lock', 'contacted');
    const optProposal = await proposal(optRow.id, 'sent', `dnc-race-opt-${optRow.id}`);
    const optHold = holdGate();
    send._setOptOutGate(() => optHold.wait());
    const optPending = send.applyInboxMessages([{
      from: optRow.email,
      subject: 'Re: Hi',
      text: 'Please unsubscribe me.',
      date: new Date(),
      inReplyTo: `<dnc-race-opt-${optRow.id}@localhost>`,
    }]);
    try {
      await optHold.ready;
      await expectRowLocked(optRow.id);
      const during = await flagRow(optRow.id);
      assert.equal(during.do_not_contact, false);
      assert.equal(during.do_not_contact_source, null);
    } finally {
      optHold.release();
      send._setOptOutGate(null);
    }
    const optResult = await optPending;
    assert.equal(optResult.matched, 1);
    await drainInbox();
    const optStored = await flagRow(optRow.id);
    assert.equal(optStored.do_not_contact, true);
    assert.equal(optStored.do_not_contact_source, 'opt_out');
    const optStatus = await pool.query('SELECT status FROM proposals WHERE id = $1', [optProposal.id]);
    assert.equal(optStatus.rows[0].status, 'opted_out');
    console.log('[dnc] opt_out survives a racing clear or set, and both locks are held');
  });

  it('writes one activity when two manual sets overlap', async () => {
    const row = await lead('Overlap', 'contacted');
    const lockHold = holdGate();
    const stopHold = holdGate();
    prospectsApi._setFlagWriteGate(() => lockHold.wait());
    send._setLeadStop(() => stopHold.wait());
    const first = postFlag(row.id, { value: true });
    try {
      await lockHold.ready;
      await expectRowLocked(row.id);
      prospectsApi._setFlagWriteGate(null);
      lockHold.release();
      await stopHold.ready;
      const second = postFlag(row.id, { value: true });
      await new Promise((resolve) => setTimeout(resolve, 50));
      stopHold.release();
      const [setA, setB] = await Promise.all([first, second]);
      assert.equal(setA.status, 200);
      assert.equal(setB.status, 200);
      const stored = await flagRow(row.id);
      assert.equal(stored.do_not_contact, true);
      assert.equal(stored.do_not_contact_source, 'manual');
      assert.deepEqual((await activityBodies(row.id)).map((n) => n.body), [MARKED]);
    } finally {
      lockHold.release();
      stopHold.release();
      send._setLeadStop(null);
      prospectsApi._setFlagWriteGate(null);
    }
    console.log('[dnc] overlapping manual sets write one activity');
  });

  it('requires the API key on the real server mount', async () => {
    const row = await lead('Real Server');
    const port = await freePort();
    const child = spawn(process.execPath, [path.join(__dirname, '../src/server.js')], {
      env: {
        ...process.env,
        PORT: String(port),
        NODE_ENV: 'test',
        DISABLE_CRON: '1',
        CORS_ORIGINS: '',
        CRM_API_KEY: API_KEY,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', (buf) => { output += buf.toString('utf8'); });
    child.stderr.on('data', (buf) => { output += buf.toString('utf8'); });
    try {
      const deadline = Date.now() + 20000;
      for (;;) {
        const health = await request('GET', '/health', { port }).catch(() => ({ status: 0 }));
        if (health.status === 200) break;
        if (child.exitCode != null || Date.now() > deadline) {
          throw new Error(scrub(output).slice(-1500) || 'server did not listen');
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      const missing = await request('POST', `/api/prospects/${row.id}/do-not-contact`, {
        port,
        body: { value: true },
      });
      assert.equal(missing.status, 401);
      assert.equal(missing.json.error, 'Missing or invalid API key');
      const wrong = await request('POST', `/api/prospects/${row.id}/do-not-contact`, {
        port,
        key: WRONG_KEY,
        body: { value: true },
      });
      assert.equal(wrong.status, 401);
      assert.equal(wrong.json.error, 'Missing or invalid API key');
      const empty = await postFlag(row.id, {}, API_KEY, port);
      assert.equal(empty.status, 400);
      assert.equal(empty.json.error, 'invalid_body');
      const stored = await flagRow(row.id);
      assert.equal(stored.do_not_contact, false);
      assert.equal(stored.do_not_contact_source, null);
      assert.equal((await activityBodies(row.id)).length, 0);
      console.log('[dnc] real server rejects a missing key, a wrong key, and an empty body');
    } catch (err) {
      err.message = scrub(err.message);
      throw err;
    } finally {
      await stopChild(child);
    }
  });

  async function assertLockOrderThenRace(start, prospectId, draftId) {
    _setClient(fakeClaude());
    let pending = Promise.resolve([]);
    let fired = false;
    send._setLockGate(async (db) => {
      send._setLockGate(null);
      fired = true;
      // Prospect first, then proposals: the order approve, mark-sent, and the
      // draft insert use (#120). The gate runs between the two locks.
      const prospects = await holdsRowShare(db, 'prospects');
      const proposals = await holdsRowShare(db, 'proposals');
      assert.equal(prospects, true);
      assert.equal(proposals, false);
      pending = Promise.all([
        draftProposal(prospectId).then(
          () => ({ name: 'draft', code: null }),
          (err) => ({ name: 'draft', code: err && err.code ? err.code : null })
        ),
        postMarkSent(draftId).then((res) => ({
          name: 'mark-sent',
          code: /40P01|40001|deadlock detected/i.test(res.text || '') ? '40P01' : null,
          status: res.status,
        })),
      ]);
      // Draft and mark-sent both wait on the prospect lock.
      assert.equal(await waitForLockWaiters(2), true);
    });
    try {
      return await start();
    } finally {
      send._setLockGate(null);
      const results = await pending;
      _setClient(null);
      // The caller must reach the lead lock; a skipped lock never fires the gate.
      assert.equal(fired, true);
      for (const result of results) {
        assert.notEqual(result.code, '40P01');
        assert.notEqual(result.code, '40001');
      }
      // mark-sent waited for the stop, so it refuses the stopped draft.
      const markSent = results.find((result) => result.name === 'mark-sent');
      assert.equal(markSent.status, 409);
      const stored = await pool.query('SELECT status FROM proposals WHERE id = $1', [draftId]);
      assert.notEqual(stored.rows[0].status, 'sent');
    }
  }

  it('locks the prospect before its proposals while draft and mark-sent wait', async () => {
    const row = await lead('Lock Order Opt', 'contacted');
    const draft = await proposal(row.id, 'draft', `dnc-lock-opt-${row.id}`);
    await pool.query('UPDATE proposals SET sent_at = NULL WHERE id = $1', [draft.id]);
    try {
      await assertLockOrderThenRace(
        () => send.markOptOut(row.id, draft.id),
        row.id,
        draft.id
      );
    } finally {
      send._setLockGate(null);
      _setClient(null);
    }
    const flag = await flagRow(row.id);
    assert.equal(flag.do_not_contact, true);
    assert.equal(flag.do_not_contact_source, 'opt_out');
    console.log('[dnc] markOptOut locks the prospect first and does not deadlock with draft or mark-sent');
  });

  it('locks the prospect before its proposals on the manual route while draft and mark-sent wait', async () => {
    const row = await lead('Lock Order Manual', 'contacted');
    const draft = await proposal(row.id, 'draft', `dnc-lock-manual-${row.id}`);
    await pool.query('UPDATE proposals SET sent_at = NULL WHERE id = $1', [draft.id]);
    let response;
    try {
      response = await assertLockOrderThenRace(
        () => postFlag(row.id, { value: true }),
        row.id,
        draft.id
      );
    } finally {
      send._setLockGate(null);
      _setClient(null);
    }
    assert.equal(response.status, 200);
    assert.equal(response.json.do_not_contact, true);
    assert.equal(response.json.do_not_contact_source, 'manual');
    const flag = await flagRow(row.id);
    assert.equal(flag.do_not_contact, true);
    console.log('[dnc] manual do-not-contact locks the prospect first and does not deadlock with draft or mark-sent');
  });

  it('retries a deadlock and still commits the opt-out', async () => {
    for (const code of ['40P01', '40001']) {
      const row = await lead(`Retry ${code}`, 'contacted');
      const sent = await proposal(row.id, 'sent', `dnc-retry-${code}-${row.id}`);
      let tries = 0;
      send._setOptOutGate(() => {
        tries += 1;
        if (tries === 1) throw sqlstateError(code);
      });
      try {
        await send.markOptOut(row.id, sent.id);
      } finally {
        send._setOptOutGate(null);
      }
      assert.equal(tries, 2);
      const flag = await flagRow(row.id);
      assert.equal(flag.do_not_contact, true);
      assert.equal(flag.do_not_contact_source, 'opt_out');
      const stored = await pool.query('SELECT status FROM proposals WHERE id = $1', [sent.id]);
      assert.equal(stored.rows[0].status, 'opted_out');
    }
    console.log('[dnc] one 40P01 or 40001 is retried and the opt-out commits');
  });

  it('does not retry a non-deadlock SQLSTATE', async () => {
    const row = await lead('No Retry XX000', 'contacted');
    const sent = await proposal(row.id, 'sent', `dnc-xx000-${row.id}`);
    let tries = 0;
    send._setOptOutGate(() => {
      tries += 1;
      throw sqlstateError('XX000');
    });
    try {
      await assert.rejects(
        () => send.markOptOut(row.id, sent.id),
        (err) => err.code === 'XX000' && err.optOutExhausted !== true
      );
    } finally {
      send._setOptOutGate(null);
    }
    assert.equal(tries, 1);
    const flag = await flagRow(row.id);
    assert.equal(flag.do_not_contact, false);
    console.log('[dnc] XX000 is not retried and does not set the flag');
  });

  it('leaves the inbox message unprocessed when opt-out retries are exhausted', async () => {
    const row = await lead('Retry Exhausted', 'contacted');
    const slug = `dnc-exhausted-${row.id}`;
    const sent = await proposal(row.id, 'sent', slug);
    let tries = 0;
    send._setOptOutGate(() => {
      tries += 1;
      throw sqlstateError('40P01');
    });
    const logged = [];
    const original = console.error;
    console.error = (...args) => {
      logged.push(args.map((part) => String(part)).join(' '));
    };
    const message = inboxMessage(row, slug);
    try {
      // The exhausted opt-out is thrown, not swallowed. checkInbox records a
      // Gmail id only after outcomes apply (#125), so the message is read
      // again on the next check instead of being lost.
      await assert.rejects(
        () => send.applyInboxMessages([message]),
        (err) => err.optOutExhausted === true && err.code === '40P01'
      );
    } finally {
      console.error = original;
      send._setOptOutGate(null);
    }
    assert.equal(tries, 3);
    const flag = await flagRow(row.id);
    assert.equal(flag.do_not_contact, false);
    const status = await pool.query('SELECT status FROM proposals WHERE id = $1', [sent.id]);
    assert.equal(status.rows[0].status, 'sent');
    const recorded = await pool.query(
      'SELECT COUNT(*)::int AS n FROM inbox_messages WHERE proposal_id = $1',
      [sent.id]
    );
    assert.equal(recorded.rows[0].n, 0);
    const items = await pool.query(
      'SELECT COUNT(*)::int AS n FROM inbox_items WHERE proposal_id = $1',
      [sent.id]
    );
    assert.equal(items.rows[0].n, 0);
    const line = logged.find((entry) => entry.includes('retries exhausted'));
    assert.ok(line);
    assert.match(line, new RegExp(`prospect ${row.id}`));
    assert.match(line, new RegExp(`proposal ${sent.id}`));
    assert.equal(line.includes('@'), false);
    assert.equal(line.includes(row.email), false);
    const second = await send.applyInboxMessages([message]);
    assert.equal(second.matched, 1);
    await drainInbox();
    const after = await flagRow(row.id);
    assert.equal(after.do_not_contact, true);
    assert.equal(after.do_not_contact_source, 'opt_out');
    const opted = await pool.query('SELECT status FROM proposals WHERE id = $1', [sent.id]);
    assert.equal(opted.rows[0].status, 'opted_out');
    console.log('[dnc] exhausted retries leave the inbox message pending and the next sweep commits');
  });

  it('leaves a follow-on opt-out unprocessed when retries are exhausted', async () => {
    const row = await lead('Retry Exhausted Follow', 'responded');
    const slug = `dnc-exhausted-fo-${row.id}`;
    const replied = await proposal(row.id, 'replied', slug);
    let tries = 0;
    send._setOptOutGate(() => {
      tries += 1;
      throw sqlstateError('40P01');
    });
    const original = console.error;
    console.error = () => {};
    const message = inboxMessage(row, slug);
    try {
      await assert.rejects(
        () => send.applyInboxMessages([message]),
        (err) => err.optOutExhausted === true
      );
    } finally {
      console.error = original;
      send._setOptOutGate(null);
    }
    await drainInbox();
    assert.equal(tries, 3);
    const flag = await flagRow(row.id);
    assert.equal(flag.do_not_contact, false);
    const recorded = await pool.query(
      'SELECT COUNT(*)::int AS n FROM inbox_messages WHERE proposal_id = $1',
      [replied.id]
    );
    assert.equal(recorded.rows[0].n, 0);
    const notes = await pool.query(
      `SELECT COUNT(*)::int AS n FROM prospect_activities WHERE prospect_id = $1 AND body LIKE 'Asked not to be contacted%'`,
      [row.id]
    );
    assert.equal(notes.rows[0].n, 0);
    const second = await send.applyInboxMessages([message]);
    assert.equal(second.follow_ons, 1);
    await drainInbox();
    const after = await flagRow(row.id);
    assert.equal(after.do_not_contact, true);
    assert.equal(after.do_not_contact_source, 'opt_out');
    console.log('[dnc] exhausted follow-on opt-out stays pending and the next sweep commits');
  });

  it('retries one deadlock on the manual route and commits', async () => {
    const row = await lead('Manual Retry', 'contacted');
    const sent = await proposal(row.id, 'sent', `dnc-manual-retry-${row.id}`);
    let tries = 0;
    prospectsApi._setFlagWriteGate(() => {
      tries += 1;
      if (tries === 1) throw sqlstateError('40P01');
    });
    try {
      const res = await postFlag(row.id, { value: true });
      assert.equal(res.status, 200);
      assert.equal(res.json.do_not_contact, true);
    } finally {
      prospectsApi._setFlagWriteGate(null);
    }
    assert.equal(tries, 2);
    const stored = await pool.query('SELECT status FROM proposals WHERE id = $1', [sent.id]);
    assert.equal(stored.rows[0].status, 'stopped');
    console.log('[dnc] one 40P01 on the manual route is retried');
  });

  it('rolls the manual route back when retries are exhausted and a later try is idempotent', async () => {
    const row = await lead('Manual Exhausted', 'contacted');
    const sent = await proposal(row.id, 'sent', `dnc-manual-ex-${row.id}`);
    let tries = 0;
    prospectsApi._setFlagWriteGate(() => {
      tries += 1;
      throw sqlstateError('40P01');
    });
    const original = console.error;
    console.error = () => {};
    let res;
    try {
      res = await postFlag(row.id, { value: true });
    } finally {
      console.error = original;
      prospectsApi._setFlagWriteGate(null);
    }
    assert.equal(tries, 3);
    assert.equal(res.status, 503);
    assert.equal(res.json.error, 'deadlock_retry_exhausted');
    const flag = await flagRow(row.id);
    assert.equal(flag.do_not_contact, false);
    const during = await pool.query('SELECT status FROM proposals WHERE id = $1', [sent.id]);
    assert.equal(during.rows[0].status, 'sent');
    assert.equal((await activityBodies(row.id)).length, 0);
    const again = await postFlag(row.id, { value: true });
    assert.equal(again.status, 200);
    assert.equal(again.json.do_not_contact, true);
    assert.equal(again.json.do_not_contact_source, 'manual');
    const stopped = await pool.query('SELECT status, stop_reason FROM proposals WHERE id = $1', [sent.id]);
    assert.equal(stopped.rows[0].status, 'stopped');
    assert.equal(stopped.rows[0].stop_reason, 'Marked do-not-contact (manual)');
    const repeat = await postFlag(row.id, { value: true });
    assert.equal(repeat.status, 200);
    assert.deepEqual((await activityBodies(row.id)).map((n) => n.body), [MARKED]);
    console.log('[dnc] exhausted manual retries roll back and a retry is idempotent');
  });

  it('refuses mark-sent when the lead is flagged while it waits on the prospect lock', async () => {
    const row = await lead('Mark Sent Flag', 'qualified');
    const draft = await proposal(row.id, 'draft', `dnc-mark-flag-${row.id}`);
    await pool.query('UPDATE proposals SET sent_at = NULL WHERE id = $1', [draft.id]);
    // Another transaction holds the prospect and raises the flag. mark-sent
    // (#120) locks the prospect first, so it waits, then reads the flag the
    // other transaction committed.
    const holder = await pool.connect();
    let res;
    try {
      await holder.query('BEGIN');
      await holder.query('SELECT id FROM prospects WHERE id = $1 FOR UPDATE', [row.id]);
      await holder.query(
        `UPDATE prospects SET do_not_contact = TRUE, do_not_contact_source = 'manual' WHERE id = $1`,
        [row.id]
      );
      const pending = postMarkSent(draft.id);
      assert.equal(await waitForLockWait(), true);
      await holder.query('COMMIT');
      res = await pending;
    } finally {
      await holder.query('ROLLBACK').catch(() => {});
      holder.release();
    }
    assert.equal(res.status, 409);
    assert.match(res.json.error, /do-not-contact/);
    const stored = await pool.query('SELECT status, followup1_due_at FROM proposals WHERE id = $1', [draft.id]);
    assert.equal(stored.rows[0].status, 'draft');
    assert.equal(stored.rows[0].followup1_due_at, null);
    // A lead already flagged is refused the same way.
    const again = await postMarkSent(draft.id);
    assert.equal(again.status, 409);
    console.log('[dnc] mark-sent reads the flag on the locked prospect and does not schedule follow-ups');
  });

  it('refuses a draft when the lead is flagged while the model call runs', async () => {
    const row = await lead('Draft Inside Flag', 'found');
    const claude = fakeClaude();
    const create = claude.messages.create.bind(claude.messages);
    claude.messages.create = async (...args) => {
      // The opt-out commits while the proposal is being written.
      await pool.query(
        `UPDATE prospects SET do_not_contact = TRUE, do_not_contact_source = 'opt_out' WHERE id = $1`,
        [row.id]
      );
      return create(...args);
    };
    _setClient(claude);
    try {
      await assert.rejects(
        () => draftProposal(row.id),
        (err) => err.status === 409 && /do-not-contact/.test(err.message)
      );
    } finally {
      _setClient(null);
    }
    const n = await pool.query('SELECT COUNT(*)::int AS n FROM proposals WHERE prospect_id = $1', [row.id]);
    assert.equal(n.rows[0].n, 0);
    console.log('[dnc] draft reads the flag on the locked prospect after the model call');
  });

  it('restores a discarded proposal while an opt-out runs, with no deadlock', async () => {
    // Restore (#120) and the opt-out both lock the prospect before a proposal.
    for (let i = 0; i < 8; i += 1) {
      const race = await lead(`Restore Ungated ${i}`, 'contacted');
      const live = await proposal(race.id, 'sent', `dnc-restore-live-${race.id}`);
      const old = await proposal(race.id, 'discarded', `dnc-restore-old-${race.id}`, 2);
      await pool.query(`UPDATE proposals SET status = 'discarded' WHERE id = $1`, [old.id]);
      const optResult = send.markOptOut(race.id, live.id).then(
        () => ({ code: null }),
        (err) => ({ code: err && err.code, message: err.message })
      );
      const restored = await postRestore(old.id);
      const optDone = await optResult;
      assert.equal(optDone.code, null);
      assert.equal(/40P01|40001|deadlock detected/i.test(restored.text || ''), false);
      assert.ok(restored.status === 200 || restored.status === 409);
      assert.notEqual(restored.status, 503);
    }
    console.log('[dnc] restore and opt-out overlap with no 40P01');
  });

  it('overlaps an opt-out with a reply, a draft, and mark-sent', { timeout: 180000 }, async () => {
    for (let i = 0; i < 20; i += 1) {
      const row = await lead(`Stress ${i}`, 'contacted');
      const sent = await proposal(row.id, 'sent', `dnc-stress-${row.id}`);
      const draft = await proposal(row.id, 'draft', `dnc-stress-d-${row.id}`, 2);
      await pool.query('UPDATE proposals SET sent_at = NULL WHERE id = $1', [draft.id]);
      const item = await readyReply(row, sent.id);
      const before = sentMails.length;
      _setClient(fakeClaude());
      send._setTransport({
        async sendMail() {
          sentMails.push({ stress: row.id });
          return { messageId: '<stress@localhost>', threadId: 'thr-stress' };
        },
      });
      // The opt-out commits after the reply is prepared and before #120's
      // last recheck (recheckLead runs this hook), so the reply must not go.
      send._beforeTransport(async ({ prospect_id: prospectId }) => {
        if (prospectId === row.id) await send.markOptOut(row.id, sent.id);
      });
      let racers = null;
      send._setLockGate(async () => {
        send._setLockGate(null);
        racers = Promise.all([
          postFlag(row.id, { value: true }).then((res) => ({
            name: 'flag',
            status: res.status,
            code: /40P01|40001|deadlock detected/i.test(res.text || '') ? '40P01' : null,
          })),
          postMarkSent(draft.id).then((res) => ({
            name: 'mark-sent',
            status: res.status,
            code: /40P01|40001|deadlock detected/i.test(res.text || '') ? '40P01' : null,
          })),
          draftProposal(row.id).then(
            () => ({ name: 'draft', code: null, status: 200 }),
            (err) => ({ name: 'draft', code: err && err.code, status: err && err.status })
          ),
          inbox.sendReply(item.id).then(
            () => ({ name: 'reply', code: null, status: 200 }),
            (err) => ({ name: 'reply', code: err && err.code, status: err && err.status })
          ),
        ]);
        assert.equal(await waitForLockWaiters(2), true);
      });
      let sweep = null;
      let sweepErr = null;
      try {
        sweep = await send.applyInboxMessages([inboxMessage(row, `dnc-stress-${row.id}`)]);
      } catch (err) {
        sweepErr = err;
      } finally {
        send._setLockGate(null);
        send._setTransport(recordingTransport());
        _setClient(null);
      }
      const results = racers ? await racers : [];
      send._beforeTransport(null);
      if (sweepErr) throw sweepErr;
      assert.equal(sweep.matched, 1);
      for (const result of results) {
        assert.notEqual(result.code, '40P01');
        assert.notEqual(result.code, '40001');
      }
      await drainInbox();
      const recorded = await pool.query(
        'SELECT COUNT(*)::int AS n FROM inbox_messages WHERE proposal_id = $1 AND direction = $2',
        [sent.id, 'in']
      );
      assert.ok(recorded.rows[0].n >= 1);
      const stuck = await pool.query(
        `SELECT COUNT(*)::int AS n FROM inbox_items WHERE prospect_id = $1 AND status = 'sending'`,
        [row.id]
      );
      assert.equal(stuck.rows[0].n, 0);
      assert.equal(sentMails.length, before);
      const reply = results.find((result) => result.name === 'reply');
      assert.equal(reply.status, 409);
      const marked = await pool.query('SELECT status FROM proposals WHERE id = $1', [draft.id]);
      assert.notEqual(marked.rows[0].status, 'sent');
    }
    console.log('[dnc] twenty overlapped opt-out rounds lost no inbound row and sent nothing after the flag');
  });
});
