process.env.SEND_HOURS = '0,24';
process.env.SEND_DAYS = '0,1,2,3,4,5,6';
process.env.SEND_DAILY_LIMIT = '100';
process.env.SENDER_ADDRESS = '1 Test Street, Provo, UT 84601';
process.env.CRM_API_KEY = 'test-followup-recipient-key-32chars!';

require('./preload');

// Follow-ups with no recipient, and Gmail errors on that path.
// Disposable Postgres. The mail transport is a mock. Nothing is sent.

const http = require('http');
const fs = require('fs');
const path = require('path');
const express = require('express');
const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { resetDb, insertProspect, closePool, pool } = require('./fixtures');
const { applySchema, applyMainSchema } = require('../src/db/migrate');
const {
  sendDueFollowups, _setTransport, classifyFollowupError, ARGUMENT_ATTEMPTS, claimFollowupAttempt,
  _beforeFollowupClaim, _beforeTransport, _failNextRelease, _failNextPostSend, _resetSendTestHooks,
  backoffDelayMs, backoffDelayMinutes, BACKOFF_CAP_MS, sentToday, storedRecipient,
  _setRandom, sendReadiness, _setAlertHook,
} = require('../src/proposals/send');
const { missingRecipient } = require('../src/proposals/recipient');
const cfg = require('../src/proposals/config');
const { revokeForProposal } = require('../src/pilot/tokens');

const API_KEY = process.env.CRM_API_KEY;
const MARK_SENT_ERROR = 'Add a recipient email before marking this as sent.';

let n = 0;
let server;
let apiBase;

function spyConsole() {
  const info = [];
  const error = [];
  const orig = { info: console.info, error: console.error };
  console.info = (...args) => {
    info.push(args.map(String).join(' '));
    orig.info.apply(console, args);
  };
  console.error = (...args) => {
    error.push(args.map(String).join(' '));
    orig.error.apply(console, args);
  };
  return {
    info,
    error,
    sendInfo() { return info.filter((line) => line.includes('[send]')); },
    sendError() { return error.filter((line) => line.includes('[send]') || line.includes('[sender]')); },
    restore() {
      console.info = orig.info;
      console.error = orig.error;
    },
  };
}

function useTransport(sendMail) {
  const calls = [];
  _setTransport({
    async sendMail(mail) {
      calls.push(mail);
      if (sendMail) return sendMail(mail, calls);
      return { messageId: `<m${calls.length}@localhost>`, threadId: `thr-${calls.length}` };
    },
  });
  return calls;
}

async function lead() {
  n += 1;
  return insertProspect({
    google_place_id: `test-place-fu-recip-${n}`,
    company: `TEST: Recipient Shop ${n}`,
    industry: 'HVAC',
    website: null,
    email: `test+fu${n}@example.com`,
    contact_name: 'Dana',
  });
}

async function insertProposal(prospectId, fields = {}) {
  n += 1;
  const slug = `fu-recip-${prospectId}-${n}`;
  const hasEmail = Object.prototype.hasOwnProperty.call(fields, 'toEmail');
  const toEmail = hasEmail ? fields.toEmail : `test+fu${n}@example.com`;
  const status = fields.status || 'sent';
  const draft = status === 'draft';
  const sentAt = draft ? null : (fields.sentAt || new Date(Date.now() - 86400000));
  const due1 = draft ? null : (fields.followup1Due === undefined ? new Date(Date.now() - 60000) : fields.followup1Due);
  const due2 = draft ? null : (fields.followup2Due === undefined ? new Date(Date.now() + 10 * 86400000) : fields.followup2Due);
  const sent1 = fields.followup1SentAt === undefined ? null : fields.followup1SentAt;
  const createdAt = fields.createdAt || new Date();
  const reviewedAt = fields.reviewedAt === undefined ? null : fields.reviewedAt;
  const { rows } = await pool.query(
    `INSERT INTO proposals (
       prospect_id, version, status, slug, to_email, to_name, subject, body, followup1, followup2,
       sent_at, followup1_due_at, followup2_due_at, followup1_sent_at, message_id, created_at, reviewed_at
     ) VALUES (
       $1, 1, $2, $3, $4, 'Dana', 'A note', 'Hello from the draft.', 'Checking back.', 'Last note.',
       $5, $6, $7, $8, $9, $10, $11
     ) RETURNING *`,
    [prospectId, status, slug, toEmail, sentAt, due1, due2, sent1, `<${slug}@localhost>`, createdAt, reviewedAt]
  );
  return rows[0];
}

async function legacySent(toEmail, fields = {}) {
  const prospect = await lead();
  const proposal = await insertProposal(prospect.id, { toEmail, ...fields });
  return { prospect, proposal };
}

async function state(id) {
  const { rows } = await pool.query(
    `SELECT status, to_email, stop_reason, error, followup1_sent_at, followup2_sent_at, sent_at
       FROM proposals WHERE id = $1`,
    [id]
  );
  return rows[0];
}

async function fullProposal(id) {
  const { rows } = await pool.query('SELECT * FROM proposals WHERE id = $1', [id]);
  return JSON.parse(JSON.stringify(rows[0]));
}

const QA_TICK_MIN = 15;
const QA_CEIL_MIN = 60;
const QA_GAP_MAX_MIN = QA_CEIL_MIN + QA_TICK_MIN;

async function qaAdvance(minutes = QA_TICK_MIN) {
  const { rows } = await pool.query(
    `SELECT column_name FROM information_schema.columns
      WHERE table_schema = current_schema() AND table_name = 'proposals'
        AND data_type LIKE 'timestamp%'`
  );
  if (!rows.length) return;
  const sets = rows.map(({ column_name: c }) => `"${c}" = "${c}" - make_interval(mins => $1)`).join(', ');
  await pool.query(`UPDATE proposals SET ${sets}`, [minutes]);
}

async function prospectStamp(id) {
  const { rows } = await pool.query(
    `SELECT stage, email, last_contacted_at, updated_at FROM prospects WHERE id = $1`,
    [id]
  );
  return JSON.parse(JSON.stringify(rows[0]));
}

async function activities(prospectId) {
  const { rows } = await pool.query(
    `SELECT type, body FROM prospect_activities WHERE prospect_id = $1 ORDER BY id`,
    [prospectId]
  );
  return rows;
}

async function markSent(id, note) {
  const res = await fetch(`${apiBase}/api/proposals/${id}/mark-sent`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': API_KEY },
    body: JSON.stringify(note == null ? {} : { note }),
  });
  const json = await res.json();
  return { status: res.status, json };
}

describe('follow-ups need a recipient', { concurrency: false }, () => {
  before(async () => {
    await applySchema();
    const app = express();
    app.use(express.json());
    app.use('/api', require('../src/api/auth'));
    app.use('/api/proposals', require('../src/api/proposals'));
    server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    apiBase = `http://127.0.0.1:${server.address().port}`;
  });

  beforeEach(async () => {
    await resetDb();
    useTransport();
    _resetSendTestHooks();
    _setRandom(() => 0.5);
  });

  after(async () => {
    _setTransport(null);
    if (server) await new Promise((resolve) => server.close(resolve));
    await closePool();
  });

  it('stops a null to_email, logs one info line, and still sends a row that has one', async () => {
    const logs = spyConsole();
    try {
      const blank = await legacySent(null);
      const prospect = await lead();
      const good = await insertProposal(prospect.id, { toEmail: 'test+keeps@example.com' });
      const calls = useTransport();
      const first = await sendDueFollowups();
      assert.equal(first.sent, 1);
      assert.equal(calls.length, 1);
      assert.equal(calls[0].to.address, 'test+keeps@example.com');

      const stopped = await state(blank.proposal.id);
      assert.equal(stopped.status, 'stopped');
      assert.equal(stopped.stop_reason, 'No recipient email');
      assert.equal(stopped.followup1_sent_at, null);
      assert.equal(stopped.to_email, null);
      assert.notEqual(stopped.status, 'sending');

      const info = logs.sendInfo();
      assert.equal(info.length, 1);
      assert.match(info[0], /^\[send\] skipped follow-up for #\d+: no recipient email; sequence stopped$/);
      assert.equal(info[0].includes('@'), false);
      assert.equal(info[0].includes('TEST:'), false);
      assert.equal(logs.sendError().length, 0);

      const infoCount = logs.info.length;
      const errorCount = logs.error.length;
      const second = await sendDueFollowups();
      assert.equal(second.sent, 0);
      assert.equal(calls.length, 1);
      assert.equal(logs.info.length, infoCount);
      assert.equal(logs.error.length, errorCount);
      assert.equal((await state(blank.proposal.id)).status, 'stopped');
      assert.equal((await state(good.id)).status, 'sent');
      assert.ok((await state(good.id)).followup1_sent_at);
      console.log('[followup-recipient] null to_email: stopped once; second tick silent; addressed row sent');
    } finally {
      logs.restore();
    }
  });

  it('stops an empty or whitespace to_email and does not log an error on the next tick', async () => {
    const logs = spyConsole();
    try {
      const blanks = [];
      for (const toEmail of ['', '   ', '\t', '\n', ' \t ']) {
        blanks.push(await legacySent(toEmail));
      }
      const calls = useTransport();
      const first = await sendDueFollowups();
      assert.equal(first.sent, 0);
      assert.equal(calls.length, 0);
      const info = logs.sendInfo();
      assert.equal(info.length, blanks.length);
      for (const line of info) {
        assert.match(line, /^\[send\] skipped follow-up for #\d+: no recipient email; sequence stopped$/);
        assert.equal(line.includes('@'), false);
      }
      assert.equal(logs.sendError().length, 0);
      for (const row of blanks) {
        const after = await state(row.proposal.id);
        assert.equal(after.status, 'stopped');
        assert.equal(after.stop_reason, 'No recipient email');
        assert.equal(after.followup1_sent_at, null);
        assert.notEqual(after.status, 'sending');
      }
      const infoCount = logs.info.length;
      const errorCount = logs.error.length;
      await sendDueFollowups();
      assert.equal(calls.length, 0);
      assert.equal(logs.info.length, infoCount);
      assert.equal(logs.error.length, errorCount);
      console.log('[followup-recipient] blank to_email: stopped once per row; second tick silent');
    } finally {
      logs.restore();
    }
  });

  it('stops the sequence on a permanent Gmail recipient error and does not retry', async () => {
    const logs = spyConsole();
    try {
      const cases = [
        {
          label: 'missing recipient',
          toEmail: 'test+missing@example.com',
          reason: 'Follow-up stopped: recipient address required',
          error() {
            const err = new Error('Gmail API: Recipient address required');
            return err;
          },
        },
        {
          label: 'invalid to header',
          toEmail: 'test+invalid@example.com',
          reason: 'Follow-up stopped: invalid recipient',
          error() {
            const err = new Error('Gmail API: Invalid To header');
            err.status = 400;
            err.gmailStatus = 'INVALID_ARGUMENT';
            err.reason = 'invalidArgument';
            return err;
          },
        },
        {
          label: 'address rejected',
          toEmail: 'test+rejected@example.com',
          reason: 'Follow-up stopped: address rejected',
          followup2: true,
          error() {
            const err = new Error("Can't send mail - all recipients were rejected: 550 5.1.1 <test+rejected@example.com>");
            err.responseCode = 550;
            err.command = 'RCPT TO';
            err.code = 'EENVELOPE';
            err.rejected = ['test+rejected@example.com'];
            return err;
          },
        },
      ];
      const rows = [];
      for (const item of cases) {
        const prospect = await lead();
        const proposal = await insertProposal(prospect.id, {
          toEmail: item.toEmail,
          followup1SentAt: item.followup2 ? new Date(Date.now() - 2 * 86400000) : null,
          followup2Due: item.followup2 ? new Date(Date.now() - 60000) : new Date(Date.now() + 10 * 86400000),
        });
        rows.push({ item, proposal });
      }
      const calls = useTransport(async (mail) => {
        const address = mail.to.address;
        const item = cases.find((row) => row.toEmail === address);
        throw item.error();
      });
      const first = await sendDueFollowups();
      assert.equal(first.sent, 0);
      assert.equal(calls.length, cases.length);
      for (const row of rows) {
        const after = await state(row.proposal.id);
        assert.equal(after.status, 'stopped', row.item.label);
        assert.equal(after.stop_reason, row.item.reason, row.item.label);
        assert.equal(after.error, row.item.reason, row.item.label);
        assert.equal(String(after.stop_reason).includes('@'), false, row.item.label);
        assert.equal(String(after.error).includes('@'), false, row.item.label);
        assert.notEqual(after.status, 'sending', row.item.label);
        if (row.item.followup2) {
          assert.ok(after.followup1_sent_at, row.item.label);
          assert.equal(after.followup2_sent_at, null, row.item.label);
        } else {
          assert.equal(after.followup1_sent_at, null, row.item.label);
        }
      }
      const info = logs.sendInfo();
      assert.equal(info.length, cases.length);
      for (const line of info) assert.equal(line.includes('@'), false);
      assert.equal(logs.sendError().length, 0);
      const infoCount = logs.info.length;
      const second = await sendDueFollowups();
      assert.equal(second.sent, 0);
      assert.equal(calls.length, cases.length);
      assert.equal(logs.info.length, infoCount);
      console.log('[followup-recipient] permanent Gmail errors stopped the sequence; second tick did not retry');
    } finally {
      logs.restore();
    }
  });

  it('retries a transient Gmail error without counting it as sent or leaving status sending', async () => {
    const logs = spyConsole();
    try {
      const shapes = [
        {
          label: '429',
          toEmail: 'test+quota429@example.com',
          stored: 'Follow-up will retry: quota',
          error() {
            const err = new Error('Quota exceeded for quota metric');
            err.status = 429;
            err.gmailStatus = 'RESOURCE_EXHAUSTED';
            return err;
          },
        },
        {
          label: 'quota text',
          toEmail: 'test+quotatext@example.com',
          stored: 'Follow-up will retry: quota',
          error() {
            return new Error('Gmail API: Quota exceeded');
          },
        },
        {
          label: '500',
          toEmail: 'test+server@example.com',
          stored: 'Follow-up will retry: server',
          error() {
            const err = new Error('Gmail API: Internal error encountered.');
            err.status = 500;
            return err;
          },
        },
        {
          label: 'network',
          toEmail: 'test+network@example.com',
          stored: 'Follow-up will retry: network',
          error() {
            const err = new Error('connect ECONNRESET');
            err.code = 'ECONNRESET';
            return err;
          },
        },
        {
          label: '400 other',
          toEmail: 'test+precondition@example.com',
          stored: 'Follow-up will retry: argument (1/3)',
          error() {
            const err = new Error('Gmail API: Precondition check failed.');
            err.status = 400;
            err.gmailStatus = 'FAILED_PRECONDITION';
            err.reason = 'failedPrecondition';
            return err;
          },
        },
      ];
      const rows = [];
      for (const item of shapes) {
        const prospect = await lead();
        const proposal = await insertProposal(prospect.id, { toEmail: item.toEmail });
        rows.push({ item, proposal, during: null });
      }
      let fail = true;
      const calls = useTransport(async (mail) => {
        const row = rows.find((item) => item.item.toEmail === mail.to.address);
        const seen = await pool.query(
          'SELECT status, followup1_sent_at, send_attempt_key FROM proposals WHERE id = $1',
          [row.proposal.id]
        );
        row.during = seen.rows[0];
        if (fail) throw row.item.error();
        return { messageId: `<ok-${row.proposal.id}@localhost>`, threadId: 'thr-ok' };
      });

      const first = await sendDueFollowups();
      assert.equal(first.sent, 0);
      assert.equal(calls.length, shapes.length);
      for (const row of rows) {
        assert.equal(row.during.status, 'sent', row.item.label);
        assert.notEqual(row.during.status, 'sending', row.item.label);
        assert.equal(row.during.followup1_sent_at, null, row.item.label);
        assert.ok(row.during.send_attempt_key, row.item.label);
        const after = await state(row.proposal.id);
        assert.equal(after.status, 'sent', row.item.label);
        assert.notEqual(after.status, 'sending', row.item.label);
        assert.equal(after.followup1_sent_at, null, row.item.label);
        assert.equal(after.followup2_sent_at, null, row.item.label);
        if (row.item.stored instanceof RegExp) assert.match(after.error, row.item.stored, row.item.label);
        else assert.equal(after.error, row.item.stored, row.item.label);
        assert.equal(after.stop_reason, null, row.item.label);
        assert.equal(String(after.error).includes('@'), false, row.item.label);
      }
      assert.equal(logs.sendInfo().length, 0);
      assert.equal(logs.sendError().length, shapes.length);

      fail = false;
      await qaAdvance(QA_GAP_MAX_MIN);
      const second = await sendDueFollowups();
      assert.equal(second.sent, shapes.length);
      assert.equal(calls.length, shapes.length * 2);
      for (const row of rows) {
        const after = await state(row.proposal.id);
        assert.equal(after.status, 'sent', row.item.label);
        assert.notEqual(after.status, 'sending', row.item.label);
        assert.ok(after.followup1_sent_at, row.item.label);
        assert.equal(after.error, null, row.item.label);
      }
      console.log('[followup-recipient] transient Gmail errors retried; status stayed sent; claim cleared until the retry');
    } finally {
      logs.restore();
    }
  });

  it('mark-sent returns 400 for a missing to_email and writes nothing', async () => {
    for (const toEmail of [null, '', '   ', '\t', '\n', '\u200b', '\u0001', 'kelby', 'test+\u206Aa@example.com']) {
      const prospect = await lead();
      const proposal = await insertProposal(prospect.id, { status: 'draft', toEmail });
      const beforeProposal = await fullProposal(proposal.id);
      const beforeLead = await prospectStamp(prospect.id);
      const beforeNotes = await activities(prospect.id);
      const res = await markSent(proposal.id, 'left a voicemail');
      assert.equal(res.status, 400, JSON.stringify(toEmail));
      assert.deepEqual(res.json, { error: MARK_SENT_ERROR });
      assert.deepEqual(await fullProposal(proposal.id), beforeProposal);
      assert.deepEqual(await prospectStamp(prospect.id), beforeLead);
      assert.deepEqual(await activities(prospect.id), beforeNotes);
      assert.equal(beforeProposal.status, 'draft');
      assert.equal(beforeProposal.sent_at, null);
      assert.equal(beforeProposal.followup1_due_at, null);
    }
    const okLead = await lead();
    const ok = await insertProposal(okLead.id, { status: 'draft', toEmail: 'test+marked@example.com' });
    const sent = await markSent(ok.id, 'left a voicemail');
    assert.equal(sent.status, 200, JSON.stringify(sent.json));
    assert.equal(sent.json.status, 'sent');
    assert.ok(sent.json.followup1_due_at);
    const leadAfter = await prospectStamp(okLead.id);
    assert.equal(leadAfter.stage, 'contacted');
    const notes = await activities(okLead.id);
    assert.equal(notes.some((row) => row.body.includes('left a voicemail')), true);
    console.log('[followup-recipient] mark-sent 400 with no row change when to_email is missing; a real address still records');
  });

  it('drops sent_requires_recipient on boot and still updates a legacy sent row', async () => {
    const schema = fs.readFileSync(path.join(__dirname, '../src/db/schema.sql'), 'utf8');
    const dropAt = schema.indexOf('DROP CONSTRAINT IF EXISTS sent_requires_recipient');
    const backfill = schema.indexOf('UPDATE proposals SET reviewed_at = created_at');
    assert.ok(dropAt > 0 && backfill > dropAt);
    assert.equal(schema.includes('ADD CONSTRAINT sent_requires_recipient'), false);
    assert.doesNotMatch(schema, /VALIDATE CONSTRAINT sent_requires_recipient/);

    const oldLead = await lead();
    const recentLead = await lead();
    const oldRow = await insertProposal(oldLead.id, {
      toEmail: null,
      createdAt: new Date('2026-10-01T00:00:00Z'),
      reviewedAt: null,
      sentAt: new Date('2026-10-01T00:00:00Z'),
    });
    const recentRow = await insertProposal(recentLead.id, {
      toEmail: '   ',
      createdAt: new Date('2026-10-20T00:00:00Z'),
      reviewedAt: null,
      sentAt: new Date('2026-10-20T00:00:00Z'),
    });
    await pool.query(`
      ALTER TABLE proposals
        ADD CONSTRAINT sent_requires_recipient CHECK (
          status IS DISTINCT FROM 'sent'
          OR (followup1_due_at IS NULL AND followup2_due_at IS NULL)
          OR (to_email IS NOT NULL AND to_email ~ '[[:graph:]]')
        ) NOT VALID
    `);

    await applyMainSchema();
    const gone = await pool.query(
      `SELECT 1 FROM pg_constraint WHERE conname = 'sent_requires_recipient'`
    );
    assert.equal(gone.rows.length, 0);
    const oldAfter = await pool.query('SELECT status, to_email, stop_reason, followup1_due_at FROM proposals WHERE id = $1', [oldRow.id]);
    const recentAfter = await pool.query('SELECT status, to_email, stop_reason, followup1_due_at, reviewed_at FROM proposals WHERE id = $1', [recentRow.id]);
    assert.equal(oldAfter.rows[0].status, 'sent');
    assert.equal(oldAfter.rows[0].to_email, null);
    assert.equal(oldAfter.rows[0].stop_reason, null);
    assert.ok(oldAfter.rows[0].followup1_due_at);
    assert.equal(recentAfter.rows[0].status, 'sent');
    assert.equal(recentAfter.rows[0].to_email, '   ');
    assert.equal(recentAfter.rows[0].reviewed_at, null);

    const feedback = await fetch(`${apiBase}/api/proposals/${recentRow.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', 'x-api-key': API_KEY },
      body: JSON.stringify({ feedback_rating: 1 }),
    });
    const feedbackJson = await feedback.json();
    assert.equal(feedback.status, 200, JSON.stringify(feedbackJson));
    assert.equal(feedbackJson.feedback_rating, 1);
    assert.equal(feedbackJson.status, 'sent');
    assert.equal(feedbackJson.to_email, '   ');

    await pool.query(
      `INSERT INTO pilot_tokens (proposal_id, prospect_id, generation, derived, token_hash, expires_at)
       VALUES ($1, $2, 1, TRUE, $3, NOW() + INTERVAL '1 day')`,
      [recentRow.id, recentLead.id, Buffer.from('legacy-recipient-token-hash-32b!!')]
    );
    const revoked = await revokeForProposal(recentRow.id);
    assert.equal(revoked, 1);
    const afterRevoke = await pool.query(
      `SELECT pr.status, pr.to_email, pr.demo_revoked_at, t.revoked_at
         FROM proposals pr
         JOIN pilot_tokens t ON t.proposal_id = pr.id
        WHERE pr.id = $1`,
      [recentRow.id]
    );
    assert.equal(afterRevoke.rows[0].status, 'sent');
    assert.equal(afterRevoke.rows[0].to_email, '   ');
    assert.ok(afterRevoke.rows[0].demo_revoked_at);
    assert.ok(afterRevoke.rows[0].revoked_at);
    console.log('[followup-recipient] boot drops sent_requires_recipient; feedback and revoke update the legacy row');
  });

  it('stops an unusable address before the send window and still sends the next row', async () => {
    const logs = spyConsole();
    const savedHours = cfg.SEND_HOURS.slice();
    try {
      const invisible = await legacySent('\u200b');
      const control = await legacySent('\u0001');
      const mixed = await legacySent('\u200b\u0001  ');
      const prospect = await lead();
      const good = await insertProposal(prospect.id, { toEmail: 'test+after-bad@example.com' });
      await pool.query(`
        ALTER TABLE proposals
          ADD CONSTRAINT sent_requires_recipient CHECK (
            status IS DISTINCT FROM 'sent'
            OR (followup1_due_at IS NULL AND followup2_due_at IS NULL)
            OR (to_email IS NOT NULL AND to_email ~ '[[:graph:]]')
          ) NOT VALID
      `);
      const calls = useTransport();
      const open = await sendDueFollowups();
      assert.equal(open.sent, 1);
      assert.equal(calls.length, 1);
      assert.equal(calls[0].to.address, 'test+after-bad@example.com');
      for (const row of [invisible, control, mixed]) {
        const after = await state(row.proposal.id);
        assert.equal(after.status, 'stopped');
        assert.equal(after.stop_reason, 'No recipient email');
        assert.equal(after.followup1_sent_at, null);
      }
      assert.ok((await state(good.id)).followup1_sent_at);

      await pool.query('ALTER TABLE proposals DROP CONSTRAINT IF EXISTS sent_requires_recipient');
      const outside = await legacySent(null);
      const held = await lead();
      const waiting = await insertProposal(held.id, { toEmail: 'test+held@example.com' });
      cfg.SEND_HOURS = [0, 0];
      _setTransport(null);
      calls.length = 0;
      const closed = await sendDueFollowups();
      assert.equal(closed.sent, 0);
      assert.equal(calls.length, 0);
      assert.equal((await state(outside.proposal.id)).status, 'stopped');
      assert.equal((await state(waiting.id)).status, 'sent');
      assert.equal((await state(waiting.id)).followup1_sent_at, null);
      console.log('[followup-recipient] unusable address stopped before the window; the next row still sent');
    } finally {
      cfg.SEND_HOURS = savedHours;
      await pool.query('ALTER TABLE proposals DROP CONSTRAINT IF EXISTS sent_requires_recipient').catch(() => {});
      logs.restore();
    }
  });

  it('a per-row send error does not skip the rest of the batch', async () => {
    const firstLead = await lead();
    const first = await insertProposal(firstLead.id, { toEmail: 'test+row-a@example.com' });
    const secondLead = await lead();
    const second = await insertProposal(secondLead.id, { toEmail: 'test+row-b@example.com' });
    const calls = useTransport(async (mail) => {
      const address = typeof mail.to === 'string' ? mail.to : mail.to.address;
      if (address === 'test+row-a@example.com') {
        const err = new Error('socket hang up');
        err.code = 'ECONNRESET';
        throw err;
      }
      return { messageId: '<row-b@localhost>', threadId: 'thr-b' };
    });
    const result = await sendDueFollowups();
    assert.equal(calls.length, 2);
    assert.equal(result.sent, 1);
    const a = await state(first.id);
    const b = await state(second.id);
    assert.equal(a.status, 'sent');
    assert.equal(a.followup1_sent_at, null);
    assert.equal(a.error, 'Follow-up will retry: network');
    assert.equal(b.status, 'sent');
    assert.ok(b.followup1_sent_at);
    console.log('[followup-recipient] one row error left the next follow-up in the batch');
  });

  it('classifies follow-up errors by HTTP status and Gmail reason', async () => {
    const logs = spyConsole();
    try {
      const table = [
        {
          name: '500 invalid argument',
          permanent: false,
          label: 'server',
          err() {
            const err = new Error('Internal error: invalid argument');
            err.status = 500;
            err.reason = 'backendError';
            return err;
          },
        },
        {
          name: '400 quotaExceeded',
          permanent: false,
          label: 'quota',
          err() {
            const err = new Error('Gmail API: Bad Request');
            err.status = 400;
            err.reason = 'quotaExceeded';
            return err;
          },
        },
        {
          name: '403 rateLimitExceeded',
          permanent: false,
          label: 'quota',
          err() {
            const err = new Error('Gmail API: Bad Request');
            err.status = 403;
            err.reason = 'rateLimitExceeded';
            return err;
          },
        },
        {
          name: '403 userRateLimitExceeded',
          permanent: false,
          label: 'quota',
          err() {
            const err = new Error('Gmail API: invalid argument');
            err.status = 403;
            err.reason = 'userRateLimitExceeded';
            return err;
          },
        },
        {
          name: '429',
          permanent: false,
          label: 'quota',
          err() {
            const err = new Error('Gmail API: invalid argument');
            err.status = 429;
            return err;
          },
        },
        {
          name: '400 invalidArgument',
          permanent: false,
          label: 'argument',
          err() {
            const err = new Error('Gmail API: Request contains an invalid argument.');
            err.status = 400;
            err.gmailStatus = 'INVALID_ARGUMENT';
            err.reason = 'invalidArgument';
            return err;
          },
        },
        {
          name: '400 Invalid thread_id',
          permanent: false,
          label: 'argument',
          err() {
            const err = new Error('Gmail API: Invalid thread_id');
            err.status = 400;
            err.reason = 'invalidArgument';
            return err;
          },
        },
        {
          name: '400 message.raw',
          permanent: false,
          label: 'argument',
          err() {
            const err = new Error("Gmail API: Invalid value at 'message.raw'");
            err.status = 400;
            err.reason = 'invalidArgument';
            return err;
          },
        },
        {
          name: '400 Invalid To header',
          permanent: true,
          label: 'recipient',
          err() {
            const err = new Error('Gmail API: Invalid To header');
            err.status = 400;
            err.reason = 'invalidArgument';
            return err;
          },
        },
        {
          name: '400 invalid address',
          permanent: false,
          label: 'argument',
          err() {
            const err = new Error('Gmail API: Invalid address');
            err.status = 400;
            err.reason = 'invalidArgument';
            return err;
          },
        },
        {
          name: '400 recipient required',
          permanent: true,
          label: 'recipient',
          err() {
            const err = new Error('Gmail API: Recipient address required');
            err.status = 400;
            return err;
          },
        },
        {
          name: 'invalid_grant',
          permanent: false,
          label: 'auth',
          err() {
            return new Error('Gmail access expired. Go to Settings and click Connect Gmail again.');
          },
        },
        {
          name: 'address rejected',
          permanent: true,
          label: 'recipient',
          err() {
            const err = new Error('all recipients were rejected: 550 5.1.1');
            err.responseCode = 550;
            err.command = 'RCPT TO';
            err.code = 'EENVELOPE';
            err.rejected = ['test+gone@example.com'];
            return err;
          },
        },
        {
          name: 'network',
          permanent: false,
          label: 'network',
          err() {
            const err = new Error('connect ECONNRESET');
            err.code = 'ECONNRESET';
            return err;
          },
        },
        {
          name: '450 recipients were rejected',
          permanent: false,
          label: 'smtp',
          err() {
            const err = new Error('450 4.2.1 recipients were rejected');
            err.responseCode = 450;
            err.code = 'EENVELOPE';
            err.rejected = ['test+temp@example.com'];
            return err;
          },
        },
        {
          name: '421',
          permanent: false,
          label: 'smtp',
          err() {
            const err = new Error('421 4.4.2 recipients were rejected');
            err.responseCode = 421;
            err.rejected = ['test+temp@example.com'];
            return err;
          },
        },
        {
          name: '451',
          permanent: false,
          label: 'smtp',
          err() {
            const err = new Error('451 4.3.0 recipients were rejected');
            err.responseCode = 451;
            err.rejected = ['test+temp@example.com'];
            return err;
          },
        },
        {
          name: '452',
          permanent: false,
          label: 'smtp',
          err() {
            const err = new Error('452 4.2.2 recipients were rejected');
            err.responseCode = 452;
            err.rejected = ['test+temp@example.com'];
            return err;
          },
        },
        {
          name: '550 5.1.1',
          permanent: true,
          label: 'recipient',
          err() {
            const err = new Error('550 5.1.1 The email account does not exist');
            err.responseCode = 550;
            err.command = 'RCPT TO';
            err.rejected = ['test+gone@example.com'];
            return err;
          },
        },
        {
          name: '553',
          permanent: true,
          label: 'recipient',
          err() {
            const err = new Error('553 5.1.3 mailbox name not allowed');
            err.responseCode = 553;
            err.command = 'RCPT TO';
            return err;
          },
        },
        {
          name: 'bare 550',
          permanent: false,
          label: 'later',
          err() {
            const err = new Error('550 Mailbox unavailable');
            err.responseCode = 550;
            err.rejected = ['test+gone@example.com'];
            return err;
          },
        },
        {
          name: 'badRequest without status',
          permanent: false,
          label: 'argument',
          err() {
            const err = new Error('Gmail API: Invalid thread_id');
            err.reason = 'badRequest';
            return err;
          },
        },
        {
          name: 'errors[].reason badRequest',
          permanent: false,
          label: 'argument',
          err() {
            const err = new Error('Gmail API: Invalid thread_id');
            err.status = 400;
            err.errors = [{ reason: 'badRequest', message: 'Invalid thread_id' }];
            return err;
          },
        },
        {
          name: 'failedPrecondition',
          permanent: false,
          label: 'argument',
          err() {
            const err = new Error('Gmail API: Precondition check failed.');
            err.status = 400;
            err.gmailStatus = 'FAILED_PRECONDITION';
            err.reason = 'failedPrecondition';
            return err;
          },
        },
      ];
      for (const row of table) {
        const got = classifyFollowupError(row.err());
        assert.equal(got.kind, row.permanent ? 'permanent' : 'transient', row.name);
        assert.equal(got.label, row.label, row.name);
      }

      const rows = [];
      for (const name of ['500 invalid argument', '400 quotaExceeded', 'invalid_grant']) {
        const item = table.find((row) => row.name === name);
        const prospect = await lead();
        const proposal = await insertProposal(prospect.id, { toEmail: `test+class-${rows.length}@example.com` });
        rows.push({ item, proposal });
      }
      useTransport(async (mail) => {
        const address = typeof mail.to === 'string' ? mail.to : mail.to.address;
        const row = rows.find((item, index) => address === `test+class-${index}@example.com`);
        throw row.item.err();
      });
      const first = await sendDueFollowups();
      assert.equal(first.sent, 0);
      for (const row of rows) {
        const after = await state(row.proposal.id);
        assert.equal(after.status, 'sent', row.item.name);
        assert.equal(after.followup1_sent_at, null, row.item.name);
        if (row.item.label === 'argument') assert.equal(after.error, 'Follow-up will retry: argument (1/3)', row.item.name);
        else assert.match(after.error, new RegExp(`^Follow-up will retry: ${row.item.label}\\b`), row.item.name);
        if (row.item.label === 'auth') {
          const count = await pool.query('SELECT followup_argument_attempts, first_transient_at FROM proposals WHERE id = $1', [row.proposal.id]);
          assert.equal(Number(count.rows[0].followup_argument_attempts), 0);
          assert.equal(count.rows[0].first_transient_at, null);
        }
      }
      assert.equal(logs.sendError().some((line) => /\[ALERT\] gmail oauth_expired halted sweep/.test(line)), true);
      assert.equal(logs.sendInfo().some((line) => line.includes('stopped follow-up')), false);
      console.log('[followup-recipient] status and reason classify 5xx, quota, and auth as retries');
    } finally {
      logs.restore();
    }
  });

  it('retries a non-recipient invalid argument three times, then stops with a different reason', async () => {
    const logs = spyConsole();
    try {
      const prospect = await lead();
      const proposal = await insertProposal(prospect.id, { toEmail: 'test+thread@example.com' });
      let calls = 0;
      useTransport(async () => {
        calls += 1;
        const err = new Error('Gmail API: Invalid thread_id');
        err.status = 400;
        err.reason = 'invalidArgument';
        throw err;
      });
      const first = await sendDueFollowups();
      assert.equal(first.sent, 0);
      assert.equal(calls, 1);
      let row = await state(proposal.id);
      assert.equal(row.status, 'sent');
      assert.equal(row.followup1_sent_at, null);
      assert.equal(row.stop_reason, null);
      assert.match(row.error, /Follow-up will retry: argument \(1\/3\)/);
      assert.equal(logs.sendError().some((line) => line.includes('not the recipient') && line.includes('(1/3)')), true);

      await sendDueFollowups();
      row = await state(proposal.id);
      assert.equal(row.status, 'sent');
      assert.match(row.error, /Follow-up will retry: argument \(2\/3\)/);

      await sendDueFollowups();
      row = await state(proposal.id);
      assert.equal(row.status, 'stopped');
      assert.equal(row.stop_reason, 'Follow-up stopped: Gmail rejected the message');
      assert.equal(row.stop_reason.includes('invalid recipient'), false);
      assert.equal(row.followup1_sent_at, null);
      assert.equal(calls, ARGUMENT_ATTEMPTS);
      assert.equal(logs.sendError().some((line) => line.includes('stopped follow-up') && line.includes('not the recipient')), true);

      await sendDueFollowups();
      assert.equal(calls, ARGUMENT_ATTEMPTS);
      console.log('[followup-recipient] generic invalid argument retried 3 times, then stopped as not the recipient');
    } finally {
      logs.restore();
    }
  });

  it('rejects control, format, and separator characters and matches the web copy', () => {
    const samples = [
      ['Cc', 'test+\u0001a@example.com'],
      ['Cf', 'test+\u206Aa@example.com'],
      ['Cf zero-width', 'test+\u200Ba@example.com'],
      ['Zs', 'test+a@example.com '],
      ['Zl', 'test+a@example.com\u2028'],
      ['Zp', 'test+a@example.com\u2029'],
      ['not an address', 'kelby'],
    ];
    for (const [label, email] of samples) {
      assert.equal(missingRecipient(email), true, label);
    }
    assert.equal(missingRecipient('test+a@example.com'), false);
    assert.equal(missingRecipient(null), true);
    assert.equal(missingRecipient(''), true);

    function core(src) {
      return src
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, '')
        .replace(/module\.exports\s*=\s*\{[\s\S]*?\};?/, '')
        .replace(/export function /g, 'function ')
        .replace(/\s+/g, ' ')
        .trim();
    }
    const server = fs.readFileSync(path.join(__dirname, '../src/proposals/recipient.js'), 'utf8');
    const web = fs.readFileSync(path.join(__dirname, '../web/src/recipient.js'), 'utf8');
    assert.equal(core(server), core(web));
    console.log('[followup-recipient] Cc, Cf, and Z characters are refused; web copy matches');
  });

  it('retries SMTP 450 and stops on SMTP 550 5.1.1', async () => {
    const tempLead = await lead();
    const temp = await insertProposal(tempLead.id, { toEmail: 'test+temp450@example.com' });
    let tempCalls = 0;
    useTransport(async () => {
      tempCalls += 1;
      if (tempCalls === 1) {
        const err = new Error('450 4.2.1 recipients were rejected: test+temp450@example.com');
        err.responseCode = 450;
        err.code = 'EENVELOPE';
        err.rejected = ['test+temp450@example.com'];
        throw err;
      }
      return { messageId: '<ok-450@localhost>', threadId: 'thr-450' };
    });
    const first = await sendDueFollowups();
    assert.equal(first.sent, 0);
    let row = await state(temp.id);
    assert.equal(row.status, 'sent');
    assert.equal(row.followup1_sent_at, null);
    assert.equal(row.stop_reason, null);
    assert.match(row.error, /^Follow-up will retry: smtp\b/);
    await qaAdvance(QA_GAP_MAX_MIN);
    const second = await sendDueFollowups();
    assert.equal(second.sent, 1);
    row = await state(temp.id);
    assert.equal(row.status, 'sent');
    assert.ok(row.followup1_sent_at);
    assert.equal(row.error, null);

    const deadLead = await lead();
    const dead = await insertProposal(deadLead.id, { toEmail: 'test+dead550@example.com' });
    let deadCalls = 0;
    useTransport(async () => {
      deadCalls += 1;
      const err = new Error('550 5.1.1 The email account does not exist');
      err.responseCode = 550;
      err.command = 'RCPT TO';
      err.code = 'EENVELOPE';
      err.rejected = ['test+dead550@example.com'];
      throw err;
    });
    await sendDueFollowups();
    row = await state(dead.id);
    assert.equal(row.status, 'stopped');
    assert.equal(row.stop_reason, 'Follow-up stopped: address rejected');
    assert.equal(row.followup1_sent_at, null);
    await sendDueFollowups();
    assert.equal(deadCalls, 1);
    console.log('[followup-recipient] SMTP 450 retried; SMTP 550 5.1.1 stopped');
  });

  it('stops Invalid thread_id with reason badRequest after 3 attempts', async () => {
    const prospect = await lead();
    const proposal = await insertProposal(prospect.id, { toEmail: 'test+badreq@example.com' });
    let calls = 0;
    useTransport(async () => {
      calls += 1;
      const err = new Error('Gmail API: Invalid thread_id');
      err.status = 400;
      err.errors = [{ reason: 'badRequest', message: 'Invalid thread_id' }];
      throw err;
    });
    await sendDueFollowups();
    await sendDueFollowups();
    let row = await state(proposal.id);
    assert.equal(row.status, 'sent');
    const count = await pool.query('SELECT followup_argument_attempts FROM proposals WHERE id = $1', [proposal.id]);
    assert.equal(Number(count.rows[0].followup_argument_attempts), 2);
    await sendDueFollowups();
    row = await state(proposal.id);
    assert.equal(row.status, 'stopped');
    assert.equal(row.stop_reason, 'Follow-up stopped: Gmail rejected the message');
    assert.equal(calls, 3);
    await sendDueFollowups();
    assert.equal(calls, 3);
    console.log('[followup-recipient] badRequest Invalid thread_id stopped after 3 attempts');
  });

  it('keeps the argument count when a 500 lands between 400s', async () => {
    const prospect = await lead();
    const proposal = await insertProposal(prospect.id, { toEmail: 'test+alternate@example.com' });
    let n = 0;
    useTransport(async () => {
      n += 1;
      if (n % 2 === 1) {
        const err = new Error('Gmail API: Invalid thread_id');
        err.status = 400;
        err.reason = 'badRequest';
        throw err;
      }
      const err = new Error('Internal error encountered.');
      err.status = 500;
      throw err;
    });
    const seen = [];
    for (let i = 0; i < 5; i += 1) {
      await qaAdvance(QA_GAP_MAX_MIN);
      await sendDueFollowups();
      const { rows } = await pool.query(
        'SELECT status, followup_argument_attempts, error FROM proposals WHERE id = $1',
        [proposal.id]
      );
      seen.push(rows[0]);
    }
    assert.equal(n, 5);
    assert.deepEqual(seen.map((r) => [r.status, Number(r.followup_argument_attempts)]),
      [['sent', 1], ['sent', 1], ['sent', 2], ['sent', 2], ['stopped', 3]]);
    assert.match(seen[1].error, /^Follow-up will retry: server\b/);
    assert.match(seen[3].error, /^Follow-up will retry: server\b/);
    assert.equal(seen[4].status, 'stopped');
    assert.equal(seen[4].error, 'Follow-up stopped: Gmail rejected the message');
    const before = n;
    await sendDueFollowups();
    assert.equal(n, before);

    const okLead = await lead();
    const ok = await insertProposal(okLead.id, { toEmail: 'test+resetcount@example.com' });
    let phase = 'fail';
    useTransport(async () => {
      if (phase === 'fail') {
        const err = new Error('Gmail API: Invalid thread_id');
        err.status = 400;
        err.reason = 'badRequest';
        throw err;
      }
      return { messageId: '<reset@localhost>', threadId: 'thr-reset' };
    });
    await sendDueFollowups();
    let count = await pool.query('SELECT followup_argument_attempts FROM proposals WHERE id = $1', [ok.id]);
    assert.equal(Number(count.rows[0].followup_argument_attempts), 1);
    phase = 'ok';
    const sent = await sendDueFollowups();
    assert.equal(sent.sent, 1);
    count = await pool.query('SELECT followup_argument_attempts, error, followup1_sent_at FROM proposals WHERE id = $1', [ok.id]);
    assert.equal(Number(count.rows[0].followup_argument_attempts), 0);
    assert.equal(count.rows[0].error, null);
    assert.ok(count.rows[0].followup1_sent_at);
    console.log('[followup-recipient] argument count survived a 500 and reset on send');
  });

  it('trims surrounding spaces on to_email and rejects interior whitespace', async () => {
    const prospect = await lead();
    const proposal = await insertProposal(prospect.id, { status: 'draft', toEmail: 'test+space@example.com' });
    const trimmed = await fetch(`${apiBase}/api/proposals/${proposal.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', 'x-api-key': API_KEY },
      body: JSON.stringify({ to_email: '  test+trim@example.com  ' }),
    });
    const trimmedJson = await trimmed.json();
    assert.equal(trimmed.status, 200, JSON.stringify(trimmedJson));
    assert.equal(trimmedJson.to_email, 'test+trim@example.com');
    for (const bad of ['test+a @example.com', 'test+\u206Aa@example.com', 'kelby']) {
      const res = await fetch(`${apiBase}/api/proposals/${proposal.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json', 'x-api-key': API_KEY },
        body: JSON.stringify({ to_email: bad }),
      });
      const json = await res.json();
      assert.equal(res.status, 400, bad);
      assert.equal(json.error, "That email address doesn't look right.");
    }
    const still = await pool.query('SELECT to_email FROM proposals WHERE id = $1', [proposal.id]);
    assert.equal(still.rows[0].to_email, 'test+trim@example.com');
    console.log('[followup-recipient] PATCH trims to_email and rejects interior whitespace');
  });

  it('stops a missing recipient on follow-up 2 without a claim or a transport call', async () => {
    const prospect = await lead();
    const proposal = await insertProposal(prospect.id, {
      toEmail: 'test+fu2@example.com',
      followup1SentAt: new Date(Date.now() - 3 * 86400000),
      followup2Due: new Date(Date.now() - 60000),
    });
    await pool.query('UPDATE proposals SET to_email = $2 WHERE id = $1', [proposal.id, 'not-an-email']);
    const calls = useTransport();
    const out = await sendDueFollowups();
    assert.equal(out.sent, 0);
    assert.equal(calls.length, 0);
    const row = await state(proposal.id);
    assert.equal(row.status, 'stopped');
    assert.equal(row.stop_reason, 'No recipient email');
    assert.equal(row.followup2_sent_at, null);
    assert.ok(row.followup1_sent_at);
  });

  it('stops implausible or invisible-character addresses before the claim and sends a valid one unchanged', async () => {
    const bad = ['not-an-email', 'test@nodot', 'test+two@@example.com', ' \u200btest+zw@example.com\u200b ',
      '\uFEFFtest+bom@example.com', '\u200Etest+lrm@example.com', 'test+a@example.com\u00A0'];
    const rows = [];
    for (const toEmail of bad) rows.push(await legacySent(toEmail));
    const good = await legacySent('Test+OK@Sub.Example.com');
    const calls = useTransport();
    const out = await sendDueFollowups();
    assert.equal(out.sent, 1);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].to.address, 'Test+OK@Sub.Example.com');
    for (const [i, row] of rows.entries()) {
      const after = await state(row.proposal.id);
      assert.equal(after.status, 'stopped', JSON.stringify(bad[i]));
      assert.equal(after.stop_reason, 'No recipient email', JSON.stringify(bad[i]));
      assert.equal(after.followup1_sent_at, null, JSON.stringify(bad[i]));
      assert.equal(after.to_email, bad[i], JSON.stringify(bad[i]));
    }
    assert.ok((await state(good.proposal.id)).followup1_sent_at);
  });

  it('refuses the first send for an address that only passes the old regex', async () => {
    for (const toEmail of ['test+\u200bfirst@example.com', 'test+\u206Afirst@example.com']) {
      const prospect = await lead();
      const draft = await insertProposal(prospect.id, { status: 'draft', toEmail });
      const calls = useTransport();
      const res = await fetch(`${apiBase}/api/proposals/${draft.id}/send`, {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': API_KEY }, body: '{}',
      });
      const json = await res.json();
      assert.equal(res.status, 400, JSON.stringify(json));
      assert.match(json.error, /valid "To" email/);
      assert.equal(calls.length, 0);
      assert.equal((await state(draft.id)).status, 'draft');
      assert.equal((await state(draft.id)).to_email, toEmail);
    }
  });

  it('classifies SMTP replies by code and enhanced status exactly as the spec lists', () => {
    const smtp = (code, text) => Object.assign(new Error(text), {
      responseCode: code, code: 'EENVELOPE', command: 'RCPT TO',
    });
    const rows = [
      [smtp(550, '550 5.1.0 Address rejected'), 'permanent', 'recipient'],
      [smtp(550, '550 5.1.1 The email account does not exist'), 'permanent', 'recipient'],
      [smtp(550, '550 5.1.2 Bad destination system address'), 'permanent', 'recipient'],
      [smtp(550, '550 5.1.3 Bad recipient address syntax'), 'permanent', 'recipient'],
      [smtp(550, '550 5.1.10 RESOLVER.ADR.RecipientNotFound'), 'permanent', 'recipient'],
      [smtp(553, '553 Requested action not taken: mailbox name not allowed'), 'permanent', 'recipient'],
      [smtp(550, '550 server build 25.1.1 rejected the message'), 'transient', 'later'],
      [smtp(550, '550 5-1-1 policy rejection'), 'transient', 'later'],
      [smtp(550, '550 5.7.1 Message rejected by policy'), 'transient', 'later'],
      [smtp(550, '550 5.7.1 Message rejected. See policy 5.1.1 for details'), 'transient', 'later'],
      [smtp(554, '554 5.7.0 Transaction failed; mentioned 5.1.1'), 'transient', 'later'],
      [smtp(552, '552 5.2.2 Mailbox full; see 5.1.1'), 'transient', 'later'],
      [smtp(550, '550 5.2.1 Mailbox disabled'), 'transient', 'later'],
      [smtp(551, '551 5.7.1 User not local'), 'transient', 'later'],
      [smtp(552, '552 5.2.2 Mailbox full'), 'transient', 'later'],
      [smtp(450, '450 4.1.1 recipients were rejected 5.1.1'), 'transient', 'smtp'],
      [Object.assign(new Error('Can\'t send mail - all recipients were rejected'), { rejected: [] }), 'transient', 'later'],
      [Object.assign(new Error('connect ETIMEDOUT for test+x@example.com'), { code: 'ETIMEDOUT' }), 'transient', 'network'],
      [Object.assign(new Error('Gmail API: Invalid recipient'), { status: 403 }), 'permanent', 'recipient'],
      [Object.assign(new Error('Gmail API: Invalid To header'), { status: 404 }), 'transient', 'later'],
      [Object.assign(new Error('Gmail API: Invalid From header address'), { status: 400 }), 'transient', 'sender'],
    ];
    for (const [err, kind, label] of rows) {
      const got = classifyFollowupError(err);
      assert.equal(got.kind, kind, err.message);
      assert.equal(got.label, label, err.message);
    }
    const mailFrom = Object.assign(new Error('550 5.1.1 The email account does not exist'), {
      responseCode: 550, command: 'MAIL FROM',
    });
    const rcpt = Object.assign(new Error('550 5.1.1 The email account does not exist'), {
      responseCode: 550, command: 'RCPT TO',
    });
    assert.equal(classifyFollowupError(mailFrom).kind, 'transient');
    assert.equal(classifyFollowupError(mailFrom).label, 'sender');
    assert.equal(classifyFollowupError(rcpt).kind, 'permanent');
    const responseOnly = Object.assign(new Error('recipients were rejected'), {
      responseCode: 550, command: 'RCPT TO', response: '550 5.1.1 user unknown',
    });
    assert.equal(classifyFollowupError(responseOnly).kind, 'permanent');
    const textOnly = Object.assign(new Error('550 5.1.1 user unknown'), { command: 'RCPT TO' });
    assert.equal(classifyFollowupError(textOnly).kind, 'permanent');
  });

  it('keeps the argument count on its own row and does not count a recipient stop', async () => {
    const other = await legacySent('test+bystander@example.com', { followup1Due: new Date(Date.now() + 86400000) });
    const dead = await legacySent('test+deadcount@example.com');
    const target = await legacySent('test+argrow@example.com');
    useTransport(async (mail) => {
      const address = typeof mail.to === 'string' ? mail.to : mail.to.address;
      if (address === 'test+deadcount@example.com') {
        throw Object.assign(new Error('Gmail API: Invalid To header'), { status: 400, reason: 'invalidArgument' });
      }
      throw Object.assign(new Error('Gmail API: Invalid thread_id'), { status: 400, reason: 'badRequest' });
    });
    await sendDueFollowups();
    const count = async (id) => Number((await pool.query('SELECT followup_argument_attempts FROM proposals WHERE id = $1', [id])).rows[0].followup_argument_attempts);
    assert.equal(await count(target.proposal.id), 1);
    assert.equal(await count(other.proposal.id), 0);
    assert.equal(await count(dead.proposal.id), 0);
    assert.equal((await state(dead.proposal.id)).status, 'stopped');
  });

  it('builds classifiable errors from real Gmail API responses', async () => {
    const axios = require('axios');
    const { AxiosError } = axios;
    const gmail = require('../src/proposals/gmail');
    await pool.query(
      `INSERT INTO app_settings (key, value, updated_at) VALUES ('gmail_oauth', $1::jsonb, NOW())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      [JSON.stringify({ refresh_token: 'test-refresh-token', email: 'test+sender@example.com' })]
    );
    let reply;
    const prev = axios.defaults.adapter;
    axios.defaults.adapter = async (config) => {
      const url = String(config && config.url || '');
      if (url.includes('oauth2.googleapis.com/token')) {
        return { data: { access_token: 'test-access', expires_in: 3600 }, status: 200, statusText: 'OK', headers: {}, config };
      }
      if (reply.network) throw new AxiosError('connect ECONNRESET 127.0.0.1:443', 'ECONNRESET', config);
      const response = { data: { error: reply.body }, status: reply.status, statusText: '', headers: {}, config };
      throw new AxiosError(`Request failed with status code ${reply.status}`, 'ERR_BAD_REQUEST', config, null, response);
    };
    const cases = [
      [{ status: 400, body: { code: 400, message: 'Invalid To header', status: 'INVALID_ARGUMENT', errors: [{ reason: 'invalidArgument', message: 'Invalid To header' }] } }, 'permanent', 'recipient'],
      [{ status: 400, body: { code: 400, message: 'Invalid thread_id', errors: [{ message: 'Invalid thread_id', reason: 'badRequest' }] } }, 'transient', 'argument'],
      [{ status: 429, body: { code: 429, message: 'Slow down.' } }, 'transient', 'quota'],
      [{ status: 403, body: { code: 403, message: 'Slow down.', reason: 'rateLimitExceeded' } }, 'transient', 'quota'],
      [{ status: 403, body: { code: 403, message: 'Slow down.', status: 'RESOURCE_EXHAUSTED' } }, 'transient', 'quota'],
      [{ status: 401, body: { code: 401, message: 'Request had invalid authentication credentials.', errors: [{ reason: 'authError' }] } }, 'transient', 'auth'],
      [{ status: 500, body: { code: 500, message: 'Invalid argument' } }, 'transient', 'server'],
      [{ network: true }, 'transient', 'network'],
    ];
    try {
      for (const [r, kind, label] of cases) {
        reply = r;
        const err = await gmail.sendMail({
          from: { name: 'Kelby', address: 'test+sender@example.com' },
          to: { address: 'test+to@example.com' },
          subject: 'TEST',
          text: 'hi',
        }).then(() => null, (e) => e);
        assert.ok(err, JSON.stringify(r));
        assert.match(err.message, /^Gmail API: /);
        const got = classifyFollowupError(err);
        assert.equal(got.kind, kind, JSON.stringify(r));
        assert.equal(got.label, label, JSON.stringify(r));
      }
    } finally {
      axios.defaults.adapter = prev;
    }
  });

  it('PATCH saves a whitespace-only to_email as empty', async () => {
    const prospect = await lead();
    const proposal = await insertProposal(prospect.id, { status: 'draft', toEmail: 'test+clear@example.com' });
    const res = await fetch(`${apiBase}/api/proposals/${proposal.id}`, {
      method: 'PATCH', headers: { 'content-type': 'application/json', 'x-api-key': API_KEY },
      body: JSON.stringify({ to_email: '   ' }),
    });
    assert.equal(res.status, 200);
    assert.equal((await state(proposal.id)).to_email, null);
  });

  it('rejects a comma address at create, PATCH, and send, and does not mail the second half', async () => {
    const { draftProposal, _setClient } = require('../src/proposals/draft');
    const { FAKE_PROPOSAL } = require('./fixtures');
    const comma = 'test+ca,test+cb@example.com';
    const prospect = await insertProspect({
      google_place_id: `test-place-comma-${n}`,
      company: 'TEST: Comma Shop',
      industry: 'HVAC',
      website: null,
      email: null,
      contact_name: 'Dana',
    });
    _setClient({
      messages: {
        async create() {
          return {
            stop_reason: 'end_turn',
            usage: { input_tokens: 1, output_tokens: 1 },
            content: [{
              type: 'tool_use', id: 'toolu_comma', name: 'submit_proposal',
              input: { ...FAKE_PROPOSAL, analysis: { ...FAKE_PROPOSAL.analysis, best_email: comma } },
            }],
          };
        },
      },
    });
    try {
      const drafted = await draftProposal(prospect.id);
      assert.equal(drafted.to_email, null);
      assert.equal(String(drafted.to_email || '').includes('test+cb@'), false);
    } finally {
      _setClient(null);
    }
    const editable = await insertProposal(prospect.id, { status: 'draft', toEmail: 'test+keep@example.com' });
    const patched = await fetch(`${apiBase}/api/proposals/${editable.id}`, {
      method: 'PATCH', headers: { 'content-type': 'application/json', 'x-api-key': API_KEY },
      body: JSON.stringify({ to_email: comma }),
    });
    assert.equal(patched.status, 400);
    assert.equal((await state(editable.id)).to_email, 'test+keep@example.com');
    const live = await legacySent(comma);
    const calls = useTransport();
    await sendDueFollowups();
    assert.equal(calls.length, 0);
    assert.equal(calls.some((mail) => String(mail.to && mail.to.address || '').includes('test+cb@')), false);
    const after = await state(live.proposal.id);
    assert.equal(after.status, 'stopped');
    assert.equal(after.to_email, comma);
  });

  it('rejects invisible characters at create and on sendReply, including a zero-width space at the edge', async () => {
    const { draftProposal, _setClient } = require('../src/proposals/draft');
    const { FAKE_PROPOSAL } = require('./fixtures');
    const inbox = require('../src/proposals/inbox');
    const samples = ['\u200Btest+edge@example.com', 'test+edge@example.com\u200B', 'test+\u200Ca@example.com',
      'test+\u200Da@example.com', 'test+\u2067a@example.com', 'test+\u180Ea@example.com', 'test+\u2060a@example.com',
      'test+\uFFF9a@example.com', 'test+\u00ADa@example.com', 'test+\u0085a@example.com'];
    for (const email of samples) {
      const prospect = await insertProspect({
        google_place_id: `test-place-inv-${n}-${email.length}`,
        company: `TEST: Invisible ${n}`,
        industry: 'HVAC',
        website: null,
        email: null,
      });
      _setClient({
        messages: {
          async create() {
            return {
              stop_reason: 'end_turn',
              usage: { input_tokens: 1, output_tokens: 1 },
              content: [{
                type: 'tool_use', id: 'toolu_inv', name: 'submit_proposal',
                input: { ...FAKE_PROPOSAL, analysis: { ...FAKE_PROPOSAL.analysis, best_email: email } },
              }],
            };
          },
        },
      });
      try {
        const drafted = await draftProposal(prospect.id);
        assert.equal(drafted.to_email, null, JSON.stringify(email));
      } finally {
        _setClient(null);
      }
      const replyProspect = await lead();
      const proposal = await insertProposal(replyProspect.id, { status: 'sent', toEmail: 'test+held@example.com' });
      const msg = await pool.query(
        `INSERT INTO inbox_messages (prospect_id, proposal_id, direction, dedupe_key, from_addr, subject, body)
         VALUES ($1, $2, 'in', $3, 'test+from@example.com', 'Hi', 'Hello') RETURNING id`,
        [replyProspect.id, proposal.id, `dedupe-inv-${proposal.id}`]
      );
      const item = await pool.query(
        `INSERT INTO inbox_items (prospect_id, proposal_id, message_id, status, reply_to, reply_subject, reply_body)
         VALUES ($1, $2, $3, 'ready', $4, 'Re: Hi', 'Thanks for the note.') RETURNING id`,
        [replyProspect.id, proposal.id, msg.rows[0].id, email]
      );
      const calls = useTransport();
      await assert.rejects(inbox.sendReply(item.rows[0].id), (err) => err.status === 400);
      assert.equal(calls.length, 0);
    }
  });

  it('rewrites only a trimmed address that canonicalizes, and a second boot updates 0 rows', async () => {
    const prospect = await lead();
    const good = await insertProposal(prospect.id, { toEmail: 'test+boot@example.com' });
    const bad = await insertProposal(prospect.id, { toEmail: 'test+badboot@example.com' });
    const zw = await insertProposal(prospect.id, { toEmail: 'test+zwboot@example.com' });
    const nbsp = await insertProposal(prospect.id, { toEmail: 'test+nbsp@example.com' });
    await pool.query('UPDATE proposals SET to_email = $2 WHERE id = $1', [good.id, '  test+boot@example.com  ']);
    await pool.query('UPDATE proposals SET to_email = $2 WHERE id = $1', [bad.id, '  test+ca,test+cb@example.com  ']);
    await pool.query('UPDATE proposals SET to_email = $2 WHERE id = $1', [zw.id, '\u200Btest+zwboot@example.com']);
    await pool.query('UPDATE proposals SET to_email = $2 WHERE id = $1', [nbsp.id, '\u00A0test+nbsp@example.com\u00A0']);
    await applyMainSchema();
    const once = await pool.query('SELECT id, to_email, updated_at FROM proposals ORDER BY id');
    const byId = new Map(once.rows.map((row) => [row.id, row]));
    assert.equal(byId.get(good.id).to_email, 'test+boot@example.com');
    assert.equal(byId.get(bad.id).to_email, '  test+ca,test+cb@example.com  ');
    assert.equal(byId.get(zw.id).to_email, '\u200Btest+zwboot@example.com');
    assert.equal(byId.get(nbsp.id).to_email, 'test+nbsp@example.com');
    const stamps = once.rows.map((row) => [row.id, row.to_email, new Date(row.updated_at).toISOString()]);
    await applyMainSchema();
    const twice = await pool.query('SELECT id, to_email, updated_at FROM proposals ORDER BY id');
    assert.deepEqual(
      twice.rows.map((row) => [row.id, row.to_email, new Date(row.updated_at).toISOString()]),
      stamps
    );
  });

  it('two overlapping ticks end at 2, not 1, and forty claims stay inside the cap', async () => {
    const prospect = await lead();
    const proposal = await insertProposal(prospect.id, { toEmail: 'test+race@example.com' });
    const pair = await Promise.all([
      claimFollowupAttempt(proposal.id, 3),
      claimFollowupAttempt(proposal.id, 3),
    ]);
    assert.deepEqual(pair.slice().sort((a, b) => a - b), [1, 2]);
    const afterPair = await pool.query('SELECT followup_argument_attempts FROM proposals WHERE id = $1', [proposal.id]);
    assert.equal(Number(afterPair.rows[0].followup_argument_attempts), 2);

    await pool.query('UPDATE proposals SET followup_argument_attempts = 0 WHERE id = $1', [proposal.id]);
    const forty = await Promise.all(Array.from({ length: 40 }, () => claimFollowupAttempt(proposal.id, 40)));
    assert.deepEqual(forty.slice().sort((a, b) => a - b), Array.from({ length: 40 }, (_, i) => i + 1));

    await pool.query('UPDATE proposals SET followup_argument_attempts = 0 WHERE id = $1', [proposal.id]);
    const capped = await Promise.all(Array.from({ length: 40 }, () => claimFollowupAttempt(proposal.id, 3)));
    const won = capped.filter((value) => value != null).sort((a, b) => a - b);
    assert.deepEqual(won, [1, 2, 3]);
    assert.equal(capped.filter((value) => value == null).length, 37);
    const finalCap = await pool.query('SELECT followup_argument_attempts FROM proposals WHERE id = $1', [proposal.id]);
    assert.equal(Number(finalCap.rows[0].followup_argument_attempts), 3);
  });

  it('stops the rest of the run on a sender or auth error and does not stop that lead', async () => {
    const first = await legacySent('test+authstop@example.com');
    const second = await legacySent('test+afterauth@example.com');
    let calls = 0;
    useTransport(async (mail) => {
      calls += 1;
      assert.equal(mail.to.address, 'test+authstop@example.com');
      throw new Error('invalid_grant');
    });
    await sendDueFollowups();
    assert.equal(calls, 1);
    const stopped = await state(first.proposal.id);
    assert.equal(stopped.status, 'sent');
    assert.equal(stopped.followup1_sent_at, null);
    assert.match(stopped.error, /will retry: auth\b/);
    const charged = await pool.query('SELECT followup_argument_attempts FROM proposals WHERE id = $1', [first.proposal.id]);
    assert.equal(Number(charged.rows[0].followup_argument_attempts), 0);
    const alert = await pool.query(`SELECT value FROM app_settings WHERE key = 'sender_alert'`);
    assert.equal(alert.rows.length, 1);
    const later = await state(second.proposal.id);
    assert.equal(later.followup1_sent_at, null);
    assert.equal(later.error, null);
  });

  it('does not resend when the transport accepted or the post-send write fails', async () => {
    for (const makeErr of [
      () => Object.assign(new Error('timeout'), { code: 'ETIMEDOUT', accepted: true }),
      () => Object.assign(new Error('connect ECONNRESET'), { code: 'ECONNRESET', accepted: true }),
      () => Object.assign(new Error('unavailable'), { status: 503, accepted: true }),
    ]) {
      const row = await legacySent(`test+accepted-${n}@example.com`);
      let calls = 0;
      useTransport(async () => {
        calls += 1;
        throw makeErr();
      });
      await sendDueFollowups();
      const after = await state(row.proposal.id);
      assert.equal(after.status, 'stopped');
      assert.equal(after.stop_reason, 'Needs manual review: the send outcome is uncertain');
      assert.equal(after.followup1_sent_at, null);
      await sendDueFollowups();
      assert.equal(calls, 1);
    }
    const row = await legacySent('test+dbfault@example.com');
    let calls = 0;
    useTransport(async () => {
      calls += 1;
      return { messageId: '<db@localhost>', threadId: 'thr-db' };
    });
    _failNextPostSend();
    await sendDueFollowups();
    const after = await state(row.proposal.id);
    assert.equal(after.status, 'stopped');
    assert.equal(after.followup1_sent_at, null);
    assert.equal(after.stop_reason, 'Needs manual review: the send outcome is uncertain');
    await sendDueFollowups();
    assert.equal(calls, 1);
  });

  it('rechecks do-not-contact inside the claim and sends nothing', async () => {
    const row = await legacySent('test+dnc@example.com');
    const calls = useTransport();
    _beforeFollowupClaim(async (p) => {
      await pool.query('UPDATE prospects SET do_not_contact = TRUE WHERE id = $1', [p.prospect_id]);
    });
    await sendDueFollowups();
    assert.equal(calls.length, 0);
    const after = await state(row.proposal.id);
    assert.equal(after.status, 'stopped');
    assert.equal(after.stop_reason, 'Lead is do-not-contact');
    assert.equal(after.followup1_sent_at, null);
  });

  it('does not count a follow-up as sent when releasing the claim fails', async () => {
    const row = await legacySent('test+release@example.com');
    _failNextRelease();
    useTransport(async () => {
      throw Object.assign(new Error('Gmail API: Invalid thread_id'), { status: 400, reason: 'badRequest' });
    });
    await sendDueFollowups();
    const after = await state(row.proposal.id);
    assert.equal(after.followup1_sent_at, null);
    assert.equal(after.status, 'sent');
    const count = await pool.query('SELECT followup_argument_attempts FROM proposals WHERE id = $1', [row.proposal.id]);
    assert.equal(Number(count.rows[0].followup_argument_attempts), 1);
  });

  it('moves a stale sending row to manual review and does not resend it', async () => {
    const prospect = await lead();
    const stale = await insertProposal(prospect.id, { status: 'draft', toEmail: 'test+stale@example.com' });
    await pool.query(`UPDATE proposals SET status = 'sending', approved_at = NOW() - INTERVAL '2 hours' WHERE id = $1`, [stale.id]);
    const calls = useTransport();
    await sendDueFollowups();
    assert.equal(calls.length, 0);
    const after = await state(stale.id);
    assert.equal(after.status, 'stopped');
    assert.equal(after.stop_reason, 'Needs manual review: the send outcome is uncertain');
    const res = await fetch(`${apiBase}/api/proposals/${stale.id}/send`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': API_KEY }, body: '{}',
    });
    const json = await res.json();
    assert.equal(res.status, 409);
    assert.equal(json.error, 'This version is stopped; only drafts can be sent.');
    assert.equal(calls.length, 0);
  });

  it('returns a generic 400 for a bad proposal id on mark-sent and PATCH', async () => {
    for (const id of ['abc', '1e2', '999999999999', '1 OR 1=1']) {
      const mark = await fetch(`${apiBase}/api/proposals/${encodeURIComponent(id)}/mark-sent`, {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': API_KEY }, body: '{}',
      });
      const markJson = await mark.json();
      assert.equal(mark.status, 400, id);
      assert.equal(markJson.error, 'Bad request.');
      assert.equal(JSON.stringify(markJson).includes('22P02'), false);
      assert.equal(JSON.stringify(markJson).includes('syntax'), false);
      const patch = await fetch(`${apiBase}/api/proposals/${encodeURIComponent(id)}`, {
        method: 'PATCH', headers: { 'content-type': 'application/json', 'x-api-key': API_KEY },
        body: JSON.stringify({ to_email: 'test+id@example.com' }),
      });
      const patchJson = await patch.json();
      assert.equal(patch.status, 400, id);
      assert.equal(patchJson.error, 'Bad request.');
      assert.equal(JSON.stringify(patchJson).includes('syntax'), false);
    }
  });

  it('resets the attempt counter when a proposal is restored', async () => {
    const prospect = await lead();
    const proposal = await insertProposal(prospect.id, { status: 'discarded', toEmail: 'test+restore@example.com' });
    await pool.query(
      `UPDATE proposals SET status = 'discarded', followup_argument_attempts = 4 WHERE id = $1`,
      [proposal.id]
    );
    const res = await fetch(`${apiBase}/api/proposals/${proposal.id}/restore`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': API_KEY }, body: '{}',
    });
    assert.equal(res.status, 200);
    const count = await pool.query('SELECT status, followup_argument_attempts FROM proposals WHERE id = $1', [proposal.id]);
    assert.equal(count.rows[0].status, 'draft');
    assert.equal(Number(count.rows[0].followup_argument_attempts), 0);
  });

  it('QA r4: classifies RCPT-only enhanced codes, anchoring, sender, auth, and 413 as the spec lists', () => {
    const smtp = (code, text, command = 'RCPT TO') => Object.assign(new Error(text), {
      responseCode: code, code: 'EENVELOPE', command,
    });
    const rows = [
      [smtp(550, '550 5.1.6 Recipient has moved'), 'transient', 'later'],
      [smtp(550, '550 5.1.4 Ambiguous destination address'), 'transient', 'later'],
      [smtp(550, '550 5.1.1 user unknown', 'DATA'), 'transient', 'later'],
      [Object.assign(new Error('550 5.1.1 user unknown'), { responseCode: 550 }), 'transient', 'later'],
      [smtp(550, '551 5.1.1 user not local'), 'transient', 'later'],
      [smtp(550, 'id 12550 5.1.1 rejected'), 'transient', 'later'],
      [smtp(550, '550 5.1.1x rejected'), 'transient', 'later'],
      [Object.assign(new Error('Error: 550 5.1.1 user unknown'), { command: 'RCPT TO' }), 'transient', 'later'],
      [Object.assign(new Error('550 5.1.1x user unknown'), { command: 'RCPT TO' }), 'transient', 'later'],
      [Object.assign(new Error('Gmail API: Message bounced, see 550 5.1.1 for details'), { status: 400 }), 'transient', 'argument'],
      [Object.assign(new Error('Gmail API: Delivery failed\n550 5.1.6 recipient moved'), { status: 400 }), 'transient', 'argument'],
      [Object.assign(new Error('Gmail API: Delivery failed\n550 5.1.1 user unknown'), { status: 400 }), 'transient', 'argument'],
      [Object.assign(new Error('550 5.1.1 user unknown'), { status: 400 }), 'permanent', 'recipient'],
      [Object.assign(new Error('Gmail API: Invalid To header'), { status: 403 }), 'permanent', 'recipient'],
      [Object.assign(new Error('Gmail API: Invalid recipient'), { status: 403 }), 'permanent', 'recipient'],
      [smtp(451, '451 4.3.0 Try again later', 'MAIL FROM'), 'transient', 'smtp'],
      [Object.assign(new Error('Gmail API: Invalid address: Reply-To'), { status: 400 }), 'transient', 'sender'],
      [Object.assign(new Error('Gmail API: Invalid Reply-To header'), { status: 400 }), 'transient', 'sender'],
      [Object.assign(new Error('Gmail API: Invalid Reply-To address'), { status: 400 }), 'transient', 'sender'],
      [Object.assign(new Error('Gmail API: Invalid Sender header'), { status: 400 }), 'transient', 'sender'],
      [smtp(553, '553 5.7.1 <test+x@example.com>: Sender address rejected: not owned by user'), 'transient', 'sender'],
      [smtp(550, '550 5.1.8 Bad sender domain'), 'transient', 'sender'],
      [smtp(550, '550 5.1.8 Bad sender domain', 'MAIL FROM'), 'transient', 'sender'],
      [smtp(535, '535 5.7.8 Authentication failed', 'AUTH PLAIN'), 'transient', 'auth'],
      [Object.assign(new Error('530 5.7.0 Must issue a STARTTLS command first'), { responseCode: 530 }), 'transient', 'auth'],
      [Object.assign(new Error('Gmail API: Request had invalid authentication credentials.'), { status: 401 }), 'transient', 'auth'],
      [Object.assign(new Error('Gmail API: Request had insufficient authentication scopes.'), { status: 403, reason: 'insufficientPermissions' }), 'transient', 'auth'],
      [Object.assign(new Error('Gmail API: Request payload size exceeds the limit'), { status: 413 }), 'transient', 'payload'],
      [smtp(550, '550 Mailbox unavailable. The policy text quotes 5.1.1 later'), 'transient', 'later'],
      [smtp(552, '552 Mailbox full. See 5.1.1'), 'transient', 'later'],
      [smtp(554, '554 Transaction failed. Mentioned 5.1.1'), 'transient', 'later'],
      [Object.assign(new Error('see 553 mailbox later'), { command: 'RCPT TO' }), 'transient', 'later'],
      [Object.assign(new Error('553 mailbox name not allowed'), { command: 'RCPT TO' }), 'permanent', 'recipient'],
      [smtp(550, '550 Rejected by policy; upstream said 550 5.1.1 user unknown'), 'transient', 'later'],
      [smtp(554, '554 Transaction failed: relay said 554 5.1.1 unknown'), 'transient', 'later'],
      [smtp(552, '552 Mailbox over quota; earlier hop 552 5.1.1'), 'transient', 'later'],
      [smtp(550, '550-5.1.1 user unknown\n550 5.1.1 user unknown'), 'permanent', 'recipient'],
      [Object.assign(new Error('450 4.2.1 try again later'), { command: 'RCPT TO' }), 'transient', 'smtp'],
      [Object.assign(new Error('421 4.4.2 try again later'), { command: 'MAIL FROM' }), 'transient', 'smtp'],
      [Object.assign(new Error('535 5.7.8 Authentication failed'), { command: 'AUTH' }), 'transient', 'auth'],
      [new Error('530 Authentication required'), 'transient', 'auth'],
      [new Error('Access expired. Reconnect.'), 'transient', 'auth'],
      [new Error('Google access expired'), 'transient', 'auth'],
      [new Error('Token is missing'), 'transient', 'auth'],
      [Object.assign(new Error('Connection closed unexpectedly'), { command: 'DATA' }), 'transient', 'network'],
    ];
    for (const [err, kind, label] of rows) {
      const got = classifyFollowupError(err);
      assert.equal(got.kind, kind, err.message);
      assert.equal(got.label, label, err.message);
    }
    const payloadCap = classifyFollowupError(rows.find((row) => row[0].status === 413)[0]).cap;
    assert.ok(payloadCap === undefined || payloadCap === 3, `413 cap is ${payloadCap}`);
    const rejectedOnly = Object.assign(new Error('550 5.1.1 user unknown'), {
      responseCode: 550,
      rejectedErrors: [{ command: 'RCPT TO', response: '550 5.1.1 user unknown' }],
    });
    assert.equal(classifyFollowupError(rejectedOnly).kind, 'permanent');
  });

  it('QA r4: a Gmail error whose detail is only in errors[] still classifies', async () => {
    const axios = require('axios');
    const { AxiosError } = axios;
    const gmail = require('../src/proposals/gmail');
    await pool.query(
      `INSERT INTO app_settings (key, value, updated_at) VALUES ('gmail_oauth', $1::jsonb, NOW())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      [JSON.stringify({ refresh_token: 'test-refresh-token', email: 'test+sender@example.com' })]
    );
    const prev = axios.defaults.adapter;
    axios.defaults.adapter = async (config) => {
      if (String(config && config.url || '').includes('oauth2.googleapis.com/token')) {
        return { data: { access_token: 'test-access', expires_in: 3600 }, status: 200, statusText: 'OK', headers: {}, config };
      }
      const response = {
        data: { error: { code: 400, message: 'Invalid argument', errors: [{ reason: 'invalidArgument', message: 'Invalid To header' }] } },
        status: 400, statusText: '', headers: {}, config,
      };
      throw new AxiosError('Request failed with status code 400', 'ERR_BAD_REQUEST', config, null, response);
    };
    try {
      const err = await gmail.sendMail({
        from: { name: 'Kelby', address: 'test+sender@example.com' },
        to: { address: 'test+to@example.com' }, subject: 'TEST', text: 'hi',
      }).then(() => null, (e) => e);
      assert.ok(err);
      assert.equal(classifyFollowupError(err).kind, 'permanent');
    } finally {
      axios.defaults.adapter = prev;
    }
  });

  it('QA r4: an Invalid From error stops the run without stopping or charging that lead', async () => {
    const first = await legacySent('test+fromstop@example.com');
    const second = await legacySent('test+afterfrom@example.com');
    let calls = 0;
    useTransport(async (mail) => {
      calls += 1;
      assert.equal(mail.to.address, 'test+fromstop@example.com');
      throw Object.assign(new Error('Gmail API: Invalid From header address'), { status: 400 });
    });
    await sendDueFollowups();
    assert.equal(calls, 1);
    const firstState = await state(first.proposal.id);
    assert.equal(firstState.status, 'sent');
    assert.match(firstState.error, /^Follow-up will retry: sender\b/);
    const count = await pool.query('SELECT followup_argument_attempts, first_transient_at FROM proposals WHERE id = $1', [first.proposal.id]);
    assert.equal(count.rows[0].first_transient_at, null);
    assert.equal(Number(count.rows[0].followup_argument_attempts), 0);
    assert.equal((await state(second.proposal.id)).error, null);
    assert.equal((await state(second.proposal.id)).followup1_sent_at, null);
  });

  it('QA r4: later errors (551) do not stop the run, share the cap, and stop after 3 ticks', async () => {
    const a = await legacySent('test+later-a@example.com');
    const b = await legacySent('test+later-b@example.com');
    let calls = 0;
    useTransport(async () => {
      calls += 1;
      throw Object.assign(new Error('551 5.7.1 User not local'), { responseCode: 551, code: 'EENVELOPE', command: 'RCPT TO' });
    });
    await sendDueFollowups();
    assert.equal(calls, 2);
    assert.match((await state(a.proposal.id)).error, /later \(1\/3\)/);
    await sendDueFollowups();
    await sendDueFollowups();
    for (const row of [a, b]) {
      const s = await state(row.proposal.id);
      assert.equal(s.status, 'stopped');
      assert.equal(s.stop_reason, 'Follow-up stopped: later retry limit reached');
    }
    assert.equal(calls, 6);
    await sendDueFollowups();
    assert.equal(calls, 6);
  });

  it('QA r4: 413 is capped at 3 and counts attempts already stored', async () => {
    const fresh = await legacySent('test+big-fresh@example.com');
    const counted = await legacySent('test+big-counted@example.com');
    await pool.query('UPDATE proposals SET followup_argument_attempts = 1 WHERE id = $1', [counted.proposal.id]);
    useTransport(async () => {
      throw Object.assign(new Error('Gmail API: Request payload size exceeds the limit'), { status: 413 });
    });
    await sendDueFollowups();
    assert.equal((await state(fresh.proposal.id)).status, 'sent');
    assert.equal((await state(counted.proposal.id)).status, 'sent');
    await sendDueFollowups();
    assert.equal((await state(fresh.proposal.id)).status, 'sent');
    assert.equal((await state(counted.proposal.id)).status, 'stopped');
    await sendDueFollowups();
    for (const row of [fresh, counted]) {
      const s = await state(row.proposal.id);
      assert.equal(s.status, 'stopped');
      assert.equal(s.stop_reason, 'Follow-up stopped: the message was too large');
    }
  });

  it('QA r4: the counter increments the stored value, not the value loaded at the start of the tick', async () => {
    const row = await legacySent('test+snapshot@example.com');
    _beforeFollowupClaim(async (p) => {
      await pool.query('UPDATE proposals SET followup_argument_attempts = 1 WHERE id = $1', [p.id]);
    });
    useTransport(async () => {
      throw Object.assign(new Error('Gmail API: Invalid thread_id'), { status: 400, reason: 'badRequest' });
    });
    await sendDueFollowups();
    const count = await pool.query('SELECT followup_argument_attempts FROM proposals WHERE id = $1', [row.proposal.id]);
    assert.equal(Number(count.rows[0].followup_argument_attempts), 2);
  });

  it('QA r4: a real DB error after the transport accepted goes to manual review and is not resent', async () => {
    const row = await legacySent('test+realdb@example.com');
    let calls = 0;
    useTransport(async () => {
      calls += 1;
      return { messageId: '<realdb@localhost>', threadId: 'thr-realdb' };
    });
    const orig = pool.query;
    let tripped = false;
    pool.query = function (sql, ...rest) {
      if (!tripped && typeof sql === 'string' && sql.includes('followup_argument_attempts = 0, send_attempt_key = NULL')) {
        tripped = true;
        return Promise.reject(Object.assign(new Error('terminating connection due to administrator command'), { code: '57P01' }));
      }
      return orig.call(this, sql, ...rest);
    };
    try {
      await sendDueFollowups();
    } finally {
      pool.query = orig;
    }
    assert.equal(tripped, true);
    const after = await state(row.proposal.id);
    assert.equal(after.status, 'stopped');
    assert.equal(after.stop_reason, 'Needs manual review: the send outcome is uncertain');
    await sendDueFollowups();
    assert.equal(calls, 1);
  });

  it('QA r4: a live send key is left alone and an expired lease goes to manual review', async () => {
    const live = await legacySent('test+livekey@example.com');
    await pool.query(`UPDATE proposals SET send_attempt_key = 'live-key', send_attempted_at = NOW() WHERE id = $1`, [live.proposal.id]);
    const calls = useTransport();
    await sendDueFollowups();
    assert.equal(calls.length, 0);
    const liveAfter = await state(live.proposal.id);
    assert.equal(liveAfter.status, 'sent');
    assert.equal(liveAfter.stop_reason, null);
    const expired = await legacySent('test+oldkey@example.com');
    await pool.query(
      `UPDATE proposals SET send_attempt_key = 'old-key', send_attempted_at = NOW() - INTERVAL '2 hours' WHERE id = $1`,
      [expired.proposal.id]
    );
    await sendDueFollowups();
    const oldAfter = await state(expired.proposal.id);
    assert.equal(oldAfter.status, 'stopped');
    assert.equal(oldAfter.stop_reason, 'Needs manual review: the send outcome is uncertain');
    assert.equal(calls.length, 0);
  });

  it('QA r4: the claim rechecks stage, archive, and status', async () => {
    const changes = [
      (p) => pool.query(`UPDATE prospects SET stage = 'responded' WHERE id = $1`, [p.prospect_id]),
      (p) => pool.query('UPDATE prospects SET archived_at = NOW() WHERE id = $1', [p.prospect_id]),
      (p) => pool.query(`UPDATE proposals SET status = 'stopped' WHERE id = $1`, [p.id]),
    ];
    for (const change of changes) {
      await resetDb();
      _resetSendTestHooks();
      await legacySent(`test+recheck-${n}@example.com`);
      const calls = useTransport();
      _beforeFollowupClaim(change);
      await sendDueFollowups();
      assert.equal(calls.length, 0);
    }
  });

  it('QA r4: a sending row younger than 15 minutes is left alone', async () => {
    const prospect = await lead();
    const young = await insertProposal(prospect.id, { status: 'draft', toEmail: 'test+young@example.com' });
    await pool.query(`UPDATE proposals SET status = 'sending', approved_at = NOW() - INTERVAL '5 minutes' WHERE id = $1`, [young.id]);
    await sendDueFollowups();
    assert.equal((await state(young.id)).status, 'sending');
  });

  it('QA r4: edge set excludes BOM, includes NBSP, and the TLD needs two letters', () => {
    const { canonicalizeRecipient } = require('../src/proposals/recipient');
    assert.equal(canonicalizeRecipient('\uFEFFtest+bom@example.com').ok, false);
    assert.equal(canonicalizeRecipient('test+bom@example.com\uFEFF').ok, false);
    assert.deepEqual(canonicalizeRecipient('\u00A0test+nb@example.com\u00A0'), { ok: true, value: 'test+nb@example.com', reason: null });
    assert.equal(canonicalizeRecipient('test+tld@example.c').ok, false);
  });

  it('QA r4: a draft stores the canonical address and inbox reply_to is canonical on PATCH and send', async () => {
    const { draftProposal, _setClient } = require('../src/proposals/draft');
    const { FAKE_PROPOSAL } = require('./fixtures');
    const inbox = require('../src/proposals/inbox');
    const prospect = await insertProspect({
      google_place_id: `test-place-canon-${n}`, company: 'TEST: Canon Shop', industry: 'HVAC', website: null, email: '\u00A0test+draftnb@example.com\u00A0',
    });
    _setClient({
      messages: {
        async create() {
          return {
            stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 },
            content: [{ type: 'tool_use', id: 'toolu_canon', name: 'submit_proposal',
              input: { ...FAKE_PROPOSAL, analysis: { ...FAKE_PROPOSAL.analysis, best_email: '' } } }],
          };
        },
      },
    });
    try {
      const drafted = await draftProposal(prospect.id);
      assert.equal(drafted.to_email, 'test+draftnb@example.com');
    } finally {
      _setClient(null);
    }
    const replyProspect = await lead();
    const proposal = await insertProposal(replyProspect.id, { status: 'sent', toEmail: 'test+held2@example.com' });
    const msg = await pool.query(
      `INSERT INTO inbox_messages (prospect_id, proposal_id, direction, dedupe_key, from_addr, subject, body)
       VALUES ($1, $2, 'in', $3, 'test+from@example.com', 'Hi', 'Hello') RETURNING id`,
      [replyProspect.id, proposal.id, `dedupe-canon-${proposal.id}`]
    );
    const item = await pool.query(
      `INSERT INTO inbox_items (prospect_id, proposal_id, message_id, status, reply_to, reply_subject, reply_body)
       VALUES ($1, $2, $3, 'ready', $4, 'Re: Hi', 'Thanks for the note.') RETURNING id`,
      [replyProspect.id, proposal.id, msg.rows[0].id, '\u00A0test+replynb@example.com']
    );
    const calls = useTransport();
    await assert.rejects(inbox.sendReply(item.rows[0].id), (err) => err.status === 400);
    assert.equal(calls.length, 0);
    const updated = await inbox.update(item.rows[0].id, { reply_to: '  test+replynb@example.com\u00A0' });
    assert.equal(updated.reply_to, 'test+replynb@example.com');
  });

  it('storedRecipient refuses a value that canonicalizing would change', () => {
    assert.equal(storedRecipient('test+a@example.com\u00A0'), null);
    assert.equal(storedRecipient('  test+a@example.com'), null);
    assert.equal(storedRecipient('test+a@example.com'), 'test+a@example.com');
  });

  it('backoff delay stays inside the spec bounds', () => {
    for (let i = 0; i <= 20; i += 1) {
      const rand = i / 20;
      const n1 = backoffDelayMinutes(1, rand);
      assert.ok(n1 >= 15 && n1 <= 18, `n=1 rand ${rand} -> ${n1}`);
      for (const n of [3, 4, 8, 12]) {
        const delay = backoffDelayMinutes(n, rand);
        assert.ok(delay >= 48 && delay <= 60, `n=${n} rand ${rand} -> ${delay}`);
      }
      for (let n = 1; n <= 12; n += 1) {
        const delay = backoffDelayMinutes(n, rand);
        assert.ok(delay >= 15 && delay <= 60, `n=${n} rand ${rand} -> ${delay}`);
      }
    }
    assert.equal(backoffDelayMinutes(1, 0), 15);
    assert.equal(backoffDelayMinutes(1, 1), 18);
    assert.equal(backoffDelayMinutes(2, 0), 24);
    assert.equal(backoffDelayMinutes(2, 1), 36);
    assert.equal(backoffDelayMinutes(3, 0), 48);
    assert.equal(backoffDelayMinutes(3, 1), 60);
    assert.equal(backoffDelayMinutes(12, 1), 60);
    assert.ok(backoffDelayMs(1, 0) === 15 * 60 * 1000);
    assert.ok(backoffDelayMs(20, 1) <= BACKOFF_CAP_MS);
  });

  it('a row past 72 hours of transient failure goes to manual review', async () => {
    const row = await legacySent('test+horizon@example.com');
    await pool.query(
      `UPDATE proposals SET first_transient_at = NOW() - INTERVAL '73 hours' WHERE id = $1`,
      [row.proposal.id]
    );
    const calls = useTransport();
    await sendDueFollowups();
    assert.equal(calls.length, 0);
    const after = await state(row.proposal.id);
    assert.equal(after.status, 'manual_review');
    assert.equal(after.stop_reason, 'transient_max_age');
    assert.equal(calls.length, 0);
  });

  it('a 4-tick outage leaves leads active with 0 cap attempts and they resume', async () => {
    const cases = [
      ['429', () => Object.assign(new Error('Quota exceeded'), { status: 429 })],
      ['503', () => Object.assign(new Error('unavailable'), { status: 503 })],
      ['network', () => Object.assign(new Error('connect ECONNRESET'), { code: 'ECONNRESET' })],
    ];
    for (const [label, makeErr] of cases) {
      const row = await legacySent(`test+outage-${label}-${n}@example.com`);
      let calls = 0;
      useTransport(async () => {
        calls += 1;
        if (calls <= 4) throw makeErr();
        return { messageId: `<${label}@localhost>`, threadId: `thr-${label}` };
      });
      for (let i = 0; i < 4; i += 1) {
        await pool.query('UPDATE proposals SET next_retry_at = NULL WHERE id = $1', [row.proposal.id]);
        await sendDueFollowups();
      }
      const mid = await pool.query(
        'SELECT status, followup_argument_attempts, followup1_sent_at FROM proposals WHERE id = $1',
        [row.proposal.id]
      );
      assert.equal(mid.rows[0].status, 'sent', label);
      assert.equal(Number(mid.rows[0].followup_argument_attempts), 0, label);
      assert.equal(mid.rows[0].followup1_sent_at, null, label);
      await pool.query('UPDATE proposals SET next_retry_at = NULL WHERE id = $1', [row.proposal.id]);
      const done = await sendDueFollowups();
      assert.equal(done.sent, 1, label);
      assert.ok((await state(row.proposal.id)).followup1_sent_at, label);
    }
  });

  it('an auth failure halts the sweep, records an alert, and charges no lead', async () => {
    const first = await legacySent('test+alert-a@example.com');
    const second = await legacySent('test+alert-b@example.com');
    let calls = 0;
    useTransport(async () => {
      calls += 1;
      throw new Error('invalid_grant');
    });
    await sendDueFollowups();
    assert.equal(calls, 1);
    for (const row of [first, second]) {
      const after = await state(row.proposal.id);
      assert.equal(after.status, 'sent');
      assert.equal(after.followup1_sent_at, null);
      const count = await pool.query('SELECT followup_argument_attempts FROM proposals WHERE id = $1', [row.proposal.id]);
      assert.equal(Number(count.rows[0].followup_argument_attempts), 0);
    }
    const alert = await pool.query(`SELECT value->>'reason' AS reason FROM app_settings WHERE key = 'sender_alert'`);
    assert.equal(alert.rows[0].reason, 'gmail auth');
    useTransport(async () => ({ messageId: '<cleared@localhost>', threadId: 'thr-clear' }));
    await sendDueFollowups();
    const gone = await pool.query(`SELECT 1 FROM app_settings WHERE key = 'sender_alert'`);
    assert.equal(gone.rows.length, 0);
  });

  it('do_not_contact set before a retry sends nothing', async () => {
    const row = await legacySent('test+retry-dnc@example.com');
    useTransport(async () => {
      throw Object.assign(new Error('connect ECONNRESET'), { code: 'ECONNRESET' });
    });
    await sendDueFollowups();
    await pool.query('UPDATE proposals SET next_retry_at = NULL WHERE id = $1', [row.proposal.id]);
    let calls = 0;
    _beforeTransport(async (p) => {
      await pool.query('UPDATE prospects SET do_not_contact = TRUE WHERE id = $1', [p.prospect_id]);
    });
    useTransport(async () => {
      calls += 1;
      return { messageId: '<nope@localhost>', threadId: 'thr-nope' };
    });
    await sendDueFollowups();
    assert.equal(calls, 0);
    const after = await state(row.proposal.id);
    assert.equal(after.followup1_sent_at, null);
    assert.equal(after.status, 'stopped');
    assert.equal(after.stop_reason, 'Lead is do-not-contact');
  });

  it('rechecks do_not_contact, opt-out, and responded after the claim and before approve sends', async () => {
    const flags = [
      (id) => pool.query('UPDATE prospects SET do_not_contact = TRUE WHERE id = $1', [id]),
      (id) => pool.query(`UPDATE prospects SET stage = 'lost' WHERE id = $1`, [id]),
      (id) => pool.query(`UPDATE prospects SET stage = 'responded' WHERE id = $1`, [id]),
    ];
    for (const flag of flags) {
      const prospect = await lead();
      const draft = await insertProposal(prospect.id, { status: 'draft', toEmail: `test+approve-${prospect.id}@example.com` });
      const calls = useTransport();
      _beforeTransport(async () => { await flag(prospect.id); });
      const res = await fetch(`${apiBase}/api/proposals/${draft.id}/send`, {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': API_KEY }, body: '{}',
      });
      assert.equal(res.status, 409);
      assert.equal(calls.length, 0);
      assert.equal((await state(draft.id)).status, 'draft');
      _resetSendTestHooks();
    }
  });

  it('stops a non-ASCII address as unsupported and does not mail a trimmed copy', async () => {
    const row = await legacySent('caf\u00e9@example.com');
    const calls = useTransport();
    await sendDueFollowups();
    assert.equal(calls.length, 0);
    const after = await state(row.proposal.id);
    assert.equal(after.status, 'stopped');
    assert.equal(after.stop_reason, 'Unsupported recipient email');
    assert.equal(after.to_email, 'caf\u00e9@example.com');
  });

  it('forty concurrent sweeps record every success and do not flag Gmail 400s as uncertain', async () => {
    const successIds = [];
    for (let i = 0; i < 40; i += 1) successIds.push((await legacySent(`test+wave${i}@example.com`)).proposal.id);
    const before = await sentToday();
    useTransport();
    await Promise.all(Array.from({ length: 40 }, () => sendDueFollowups()));
    const sentRows = await pool.query(
      'SELECT COUNT(*)::int AS n FROM proposals WHERE id = ANY($1::int[]) AND followup1_sent_at IS NOT NULL',
      [successIds]
    );
    assert.equal(sentRows.rows[0].n, 40);
    assert.equal(await sentToday(), before + 40);
    const flagged = await pool.query(
      `SELECT COUNT(*)::int AS n FROM proposals WHERE id = ANY($1::int[]) AND stop_reason LIKE 'Needs manual review%'`,
      [successIds]
    );
    assert.equal(flagged.rows[0].n, 0);

    const failIds = [];
    for (let i = 0; i < 40; i += 1) failIds.push((await legacySent(`test+g400-${i}@example.com`)).proposal.id);
    useTransport(async () => {
      throw Object.assign(new Error('Gmail API: Invalid thread_id'), { status: 400, reason: 'badRequest' });
    });
    await Promise.all(Array.from({ length: 40 }, () => sendDueFollowups()));
    const uncertain = await pool.query(
      `SELECT COUNT(*)::int AS n FROM proposals
        WHERE id = ANY($1::int[]) AND stop_reason = 'Needs manual review: the send outcome is uncertain'`,
      [failIds]
    );
    assert.equal(uncertain.rows[0].n, 0);
  });

  it('a successful send resets the 72-hour streak', async () => {
    const row = await legacySent('test+streak@example.com');
    let calls = 0;
    useTransport(async () => {
      calls += 1;
      if (calls === 1) throw Object.assign(new Error('unavailable'), { status: 503 });
      return { messageId: '<streak@localhost>', threadId: 'thr-streak' };
    });
    await sendDueFollowups();
    await pool.query(
      `UPDATE proposals SET first_transient_at = NOW() - INTERVAL '70 hours', next_retry_at = NULL WHERE id = $1`,
      [row.proposal.id]
    );
    await sendDueFollowups();
    const mid = await pool.query(
      'SELECT status, first_transient_at, followup1_sent_at FROM proposals WHERE id = $1',
      [row.proposal.id]
    );
    assert.equal(mid.rows[0].status, 'sent');
    assert.ok(mid.rows[0].followup1_sent_at);
    assert.equal(mid.rows[0].first_transient_at, null);
    useTransport(async () => { throw Object.assign(new Error('unavailable'), { status: 503 }); });
    await pool.query(`UPDATE proposals SET followup2_due_at = NOW() - INTERVAL '1 minute' WHERE id = $1`, [row.proposal.id]);
    await sendDueFollowups();
    const again = await pool.query(
      `SELECT status, first_transient_at, EXTRACT(EPOCH FROM (NOW() - first_transient_at)) AS age
         FROM proposals WHERE id = $1`,
      [row.proposal.id]
    );
    assert.equal(again.rows[0].status, 'sent');
    assert.ok(again.rows[0].first_transient_at);
    assert.ok(Number(again.rows[0].age) < 120);
  });

  it('an auth halt does not age a lead', async () => {
    const row = await legacySent('test+auth-age@example.com');
    useTransport(async () => { throw new Error('Gmail access expired. Go to Settings and click Connect Gmail again.'); });
    await sendDueFollowups();
    await qaAdvance((72 * 60) + 15);
    await sendDueFollowups();
    const after = await pool.query(
      `SELECT status, stop_reason, first_transient_at, followup_transient_attempts, followup_argument_attempts
         FROM proposals WHERE id = $1`,
      [row.proposal.id]
    );
    assert.equal(after.rows[0].status, 'sent');
    assert.equal(after.rows[0].stop_reason, null);
    assert.equal(after.rows[0].first_transient_at, null);
    assert.equal(Number(after.rows[0].followup_transient_attempts), 0);
    assert.equal(Number(after.rows[0].followup_argument_attempts), 0);
  });

  it('sendReadiness exposes the halt and a later tick clears it', async () => {
    const row = await legacySent('test+ready-halt@example.com');
    const hooked = [];
    _setAlertHook((alert) => { hooked.push(alert); });
    const authErr = () => { throw new Error('Gmail is not connected. Go to Settings and click Connect Gmail.'); };
    useTransport(authErr);
    await sendDueFollowups();
    await sendDueFollowups();
    assert.equal(hooked.length, 1);
    assert.equal(hooked[0].event, 'followups.halted');
    assert.equal(hooked[0].error_class, 'auth');
    assert.equal(hooked[0].provider, 'gmail');
    assert.equal(JSON.stringify(hooked[0]).includes('@'), false);
    let readiness = await sendReadiness();
    assert.equal(readiness.halt.event, 'followups.halted');
    assert.equal(readiness.halt.error_class, 'auth');
    assert.equal(readiness.halt.provider, 'gmail');
    assert.equal(readiness.halt.halted_ticks, 2);
    assert.equal(JSON.stringify(readiness.halt).includes('@'), false);
    _setTransport(null);
    await sendDueFollowups();
    assert.equal((await sendReadiness()).halt.halted_ticks, 2);
    const stored = await pool.query(`SELECT value FROM app_settings WHERE key = 'followups.halted'`);
    const value = stored.rows[0].value;
    value.last_event_at = new Date(Date.now() - (2 * 60 * 60 * 1000)).toISOString();
    await pool.query(`UPDATE app_settings SET value = $1::jsonb WHERE key = 'followups.halted'`, [JSON.stringify(value)]);
    useTransport(authErr);
    await sendDueFollowups();
    assert.equal(hooked.length, 2);
    assert.ok(hooked[1].halted_ticks >= 3);
    assert.equal(JSON.stringify(hooked[1]).includes('@'), false);
    useTransport(async () => ({ messageId: '<cleared-halt@localhost>', threadId: 'thr-halt' }));
    await sendDueFollowups();
    readiness = await sendReadiness();
    assert.equal(readiness.halt, null);
    assert.equal((await state(row.proposal.id)).followup1_sent_at == null, false);
  });

  // QA r6: outage recovery. Summit's formula and halt rules win where this
  // block disagrees: 72h is status manual_review and reason transient_max_age.
  const QA_SEND = require('../src/proposals/send');
  const QA_GAP_MIN_MIN = QA_TICK_MIN;
  const QA_MAX_AGE_MIN = 72 * 60;
  const QA_OUTAGE_TICKS = 32;
  const QA_RECOVER_TICKS = Math.ceil(QA_GAP_MAX_MIN / QA_TICK_MIN) + 1;

  it('QA r6: exported backoff ceiling and max age, when present, match the spec (1h, 72h)', () => {
    if (QA_SEND.FOLLOWUP_BACKOFF_CAP_MS !== undefined) assert.equal(Number(QA_SEND.FOLLOWUP_BACKOFF_CAP_MS), 60 * 60 * 1000);
    if (QA_SEND.FOLLOWUP_MAX_AGE_MS !== undefined) assert.equal(Number(QA_SEND.FOLLOWUP_MAX_AGE_MS), 72 * 60 * 60 * 1000);
  });

  async function qaLeads(tag, count) {
    const out = [];
    for (let i = 0; i < count; i += 1) {
      const { proposal } = await legacySent(`test+qa6-${tag}-${i}@example.com`);
      out.push(proposal);
    }
    return out;
  }

  function qaGaps(ticks) {
    return ticks.slice(1).map((t, i) => (t - ticks[i]) * QA_TICK_MIN);
  }

  function qaSeeded(seed) {
    let a = seed >>> 0;
    return () => {
      a = (a + 0x6D2B79F5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  async function qaWithRandom(rng, fn) {
    const probe = { used: 0 };
    const wrapped = () => { probe.used += 1; return rng(); };
    const hook = typeof QA_SEND._setRandom === 'function' ? QA_SEND._setRandom : null;
    const original = Math.random;
    if (hook) hook(wrapped); else Math.random = wrapped;
    try {
      probe.result = await fn();
    } finally {
      if (hook) hook(null); else Math.random = original;
    }
    return probe;
  }

  function qaAssertBackoff(label, ticks, { trend = false } = {}) {
    const gaps = qaGaps(ticks);
    assert.ok(gaps.length >= 4, `${label}: expected several retries in 8h, got attempts at ticks ${ticks}`);
    for (const g of gaps) {
      assert.ok(g >= QA_GAP_MIN_MIN && g <= QA_GAP_MAX_MIN,
        `${label}: gap ${g} min is outside ${QA_GAP_MIN_MIN}..${QA_GAP_MAX_MIN}: gaps ${gaps} min`);
    }
    assert.ok(gaps.some((g) => g > QA_TICK_MIN), `${label}: no backoff; retried every tick: gaps ${gaps} min`);
    const mean = (xs) => xs.reduce((s, x) => s + x, 0) / xs.length;
    assert.ok(mean(gaps.slice(2)) >= mean(gaps.slice(0, 2)),
      `${label}: later gaps are shorter than the first two: gaps ${gaps} min`);
    if (trend) {
      const first = gaps.slice(0, 4);
      for (let i = 1; i < first.length; i += 1) {
        assert.ok(first[i] >= first[i - 1], `${label}: the first retries do not grow: gaps ${gaps} min`);
      }
      assert.ok(first[first.length - 1] > first[0], `${label}: the first retries do not grow: gaps ${gaps} min`);
    }
    return gaps;
  }

  async function qaRun(rows, ticks, sendMail, { allowStop = false, perTick } = {}) {
    const byAddress = new Map(rows.map((r) => [r.to_email, r.id]));
    const attempts = new Map(rows.map((r) => [r.id, []]));
    let tick = 0;
    let callsThisTick = [];
    _setTransport({
      async sendMail(mail) {
        const id = byAddress.get(mail.to.address);
        attempts.get(id).push(tick);
        callsThisTick.push(id);
        return sendMail({ id, tick, n: attempts.get(id).length, mail });
      },
    });
    for (tick = 0; tick < ticks; tick += 1) {
      callsThisTick = [];
      await sendDueFollowups();
      if (perTick) await perTick({ tick, callsThisTick: callsThisTick.length, ids: callsThisTick });
      if (!allowStop) {
        for (const r of rows) {
          const s = await fullProposal(r.id);
          assert.equal(s.status, 'sent',
            `#${r.id} left 'sent' at tick ${tick} (${tick * QA_TICK_MIN} min): ${s.stop_reason}`);
          assert.equal(Number(s.followup_argument_attempts), 0,
            `#${r.id} was charged a capped attempt at tick ${tick}: ${s.error}`);
        }
      }
      await qaAdvance();
    }
    return attempts;
  }

  async function qaRecover(rows, label) {
    const sentAt = new Map();
    await qaRun(rows, QA_RECOVER_TICKS, ({ id }) => {
      sentAt.set(id, true);
      return { messageId: `<qa6-${label.replace(/\W+/g, '-')}-${id}@localhost>`, threadId: `thr-qa6-${id}` };
    });
    for (const r of rows) {
      const s = await fullProposal(r.id);
      assert.ok(sentAt.has(r.id), `${label}: #${r.id} did not send within ${QA_GAP_MAX_MIN} min of recovery`);
      assert.equal(s.status, 'sent');
      assert.ok(s.followup1_sent_at, `${label}: follow-up 1 not recorded`);
      assert.equal(s.followup2_sent_at, null);
      assert.equal(s.error, null);
      assert.equal(s.stop_reason, null);
      assert.equal(Number(s.followup_argument_attempts), 0);
    }
    await pool.query(`UPDATE proposals SET followup2_due_at = NOW() - INTERVAL '1 minute' WHERE id = ANY($1)`,
      [rows.map((r) => r.id)]);
    const calls = useTransport();
    await sendDueFollowups();
    assert.equal(calls.length, rows.length, `${label}: follow-up 2 did not send on the first due tick`);
    for (const r of rows) {
      const s = await fullProposal(r.id);
      assert.ok(s.followup2_sent_at, `${label}: follow-up 2 not recorded for #${r.id}`);
      assert.equal(s.status, 'sent');
    }
  }

  const QA_OUTAGE_LABELS = ['network', 'server', 'quota', 'smtp'];
  const QA_PROVIDER_OUTAGES = {
    'network ECONNRESET': () => Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }),
    'network ETIMEDOUT': () => Object.assign(new Error('connect ETIMEDOUT 142.250.0.1:443'), { code: 'ETIMEDOUT' }),
    'Gmail 503': () => Object.assign(new Error('Gmail API: The service is currently unavailable.'), { status: 503 }),
    'Gmail 429': () => Object.assign(new Error('Gmail API: Too many concurrent requests for user'), { status: 429 }),
    'Gmail 403 rateLimitExceeded': () => Object.assign(new Error('Gmail API: User-rate limit exceeded'), {
      status: 403, errors: [{ reason: 'rateLimitExceeded', message: 'User-rate limit exceeded' }],
    }),
    'SMTP 451 4xx': () => Object.assign(new Error('451 4.3.0 Temporary server error. Please try again later'), {
      responseCode: 451, code: 'EENVELOPE', command: 'RCPT TO',
    }),
  };

  for (const [label, makeErr] of Object.entries(QA_PROVIDER_OUTAGES)) {
    it(`QA r6: a ${label} outage over 8h backs off with jitter under the 1h ceiling, never stops, then recovers with no restore`, async () => {
      assert.ok(QA_OUTAGE_LABELS.includes(classifyFollowupError(makeErr()).label),
        `${label} is not classified as an outage class`);
      const tag = label.replace(/\W+/g, '-');
      const fail = () => { throw makeErr(); };
      const mid = await qaLeads(`${tag}-mid`, 1);
      const midRun = await qaWithRandom(() => 0.5, () => qaRun(mid, QA_OUTAGE_TICKS, fail));
      qaAssertBackoff(`${label} random=0.5`, midRun.result.get(mid[0].id), { trend: true });
      const lo = await qaLeads(`${tag}-lo`, 1);
      const loRun = await qaWithRandom(() => 0, () => qaRun(lo, QA_OUTAGE_TICKS, fail));
      const loGaps = qaAssertBackoff(`${label} random=0`, loRun.result.get(lo[0].id));
      const hi = await qaLeads(`${tag}-hi`, 1);
      const hiRun = await qaWithRandom(() => 0.999999, () => qaRun(hi, QA_OUTAGE_TICKS, fail));
      const hiGaps = qaAssertBackoff(`${label} random=1`, hiRun.result.get(hi[0].id));
      if (loRun.used && hiRun.used) {
        assert.notDeepEqual(loGaps, hiGaps, `${label}: the random value did not change the schedule (no jitter)`);
      }
      const rows = await qaLeads(tag, 2);
      const seeded = await qaWithRandom(qaSeeded(120), () => qaRun(rows, QA_OUTAGE_TICKS, fail));
      for (const r of rows) qaAssertBackoff(`${label} seeded #${r.id}`, seeded.result.get(r.id));
      await qaRecover(rows, label);
    });

    it(`QA r6: a ${label} outage retries under 72h, recovers with no restore, and moves to manual review at 72h`, async () => {
      const tag = `age-${label.replace(/\W+/g, '-')}`;
      const [recover, aged] = await qaLeads(tag, 2);
      const T72 = QA_MAX_AGE_MIN / QA_TICK_MIN;
      const recoverAt = T72 - 16;
      const lastTick = T72 + QA_RECOVER_TICKS;
      let reviewedAt = null;
      const attempts = await qaRun([recover, aged], lastTick + 1, ({ id, tick }) => {
        if (id === recover.id && tick >= recoverAt) {
          return { messageId: `<qa6-${tag}-${id}@localhost>`, threadId: `thr-qa6-${id}` };
        }
        throw makeErr();
      }, {
        allowStop: true,
        perTick: async ({ tick }) => {
          const r = await fullProposal(recover.id);
          assert.equal(r.status, 'sent', `${label}: the recovering lead left 'sent' at tick ${tick}: ${r.stop_reason}`);
          assert.equal(Number(r.followup_argument_attempts), 0, `${label}: recovering lead charged at tick ${tick}`);
          const a = await fullProposal(aged.id);
          assert.equal(Number(a.followup_argument_attempts), 0, `${label}: aged lead charged at tick ${tick}: ${a.error}`);
          if (tick < T72) {
            assert.equal(a.status, 'sent',
              `${label}: moved before 72h, at ${(tick * QA_TICK_MIN / 60).toFixed(2)}h: ${a.stop_reason}`);
          } else if (reviewedAt == null && a.status !== 'sent') {
            reviewedAt = tick;
          }
        },
      });
      const agedTicks = attempts.get(aged.id);
      assert.ok(agedTicks.some((t) => t < T72 && t >= T72 - QA_RECOVER_TICKS),
        `${label}: no retry in the last ${QA_GAP_MAX_MIN} min before 72h: last attempts ${agedTicks.slice(-4)}`);
      const a = await fullProposal(aged.id);
      assert.ok(reviewedAt != null, `${label}: still '${a.status}' ${QA_GAP_MAX_MIN} min after 72h: ${a.error}`);
      assert.equal(a.status, 'manual_review');
      assert.equal(a.stop_reason, 'transient_max_age', `${label}: stop reason ${a.stop_reason}`);
      assert.doesNotMatch(String(a.stop_reason), /address rejected|retry limit|outcome is uncertain/i,
        `${label}: max age reused another reason: ${a.stop_reason}`);
      assert.equal(a.followup1_sent_at, null);
      assert.ok(agedTicks.every((t) => t <= reviewedAt), `${label}: sent after manual review`);
      const r = await fullProposal(recover.id);
      const recTicks = attempts.get(recover.id).filter((t) => t >= recoverAt);
      assert.equal(recTicks.length, 1, `${label}: recovery sent ${recTicks.length} times`);
      assert.ok(recTicks[0] - recoverAt < QA_RECOVER_TICKS, `${label}: recovery took too long`);
      assert.ok(r.followup1_sent_at);
      assert.equal(r.error, null);
      assert.equal(r.stop_reason, null);
    });
  }

  async function qaAlertRows() {
    const { rows: tables } = await pool.query(
      `SELECT table_name FROM information_schema.tables
        WHERE table_schema = current_schema() AND table_name ILIKE '%alert%'`
    );
    let n = 0;
    for (const { table_name: t } of tables) {
      const { rows } = await pool.query(`SELECT COUNT(*)::int AS n FROM "${t}"`);
      n += rows[0].n;
    }
    const act = await pool.query(`SELECT COUNT(*)::int AS n FROM prospect_activities WHERE type ILIKE '%alert%'`);
    return n + act.rows[0].n;
  }

  async function qaCaptureAlerts(fn) {
    const hooked = [];
    const setHook = QA_SEND._setAlertHook || QA_SEND._setAlert;
    if (typeof setHook === 'function') setHook(async (alert) => { hooked.push(alert); });
    const lines = [];
    const orig = { error: console.error, warn: console.warn, info: console.info };
    for (const k of Object.keys(orig)) console[k] = (...args) => { lines.push(args.map(String).join(' ')); };
    const before = await qaAlertRows();
    try {
      await fn();
    } finally {
      Object.assign(console, orig);
      if (typeof setHook === 'function') setHook(null);
    }
    const tableRows = (await qaAlertRows()) - before;
    const logged = lines.filter((l) => /alert/i.test(l));
    return { hooked, tableRows, logged, lines, total: hooked.length + tableRows + logged.length };
  }

  const QA_AUTH_OUTAGES = {
    'refresh invalid_grant': () => new Error("Couldn't refresh Gmail access: invalid_grant"),
    'HTTP 401': () => Object.assign(new Error('Gmail API: Request had invalid authentication credentials.'), { status: 401 }),
    'SMTP 535': () => Object.assign(new Error('Invalid login: 535-5.7.8 Username and Password not accepted'), {
      responseCode: 535, code: 'EAUTH', command: 'AUTH PLAIN',
    }),
    'access expired': () => new Error('Gmail access expired. Go to Settings and click Connect Gmail again.'),
    'token missing': () => new Error('Gmail is not connected. Go to Settings and click Connect Gmail.'),
  };

  for (const [label, makeErr] of Object.entries(QA_AUTH_OUTAGES)) {
    it(`QA r6: an auth outage (${label}) halts each sweep, raises an alert, charges and stops no lead, then recovers`, async () => {
      assert.equal(classifyFollowupError(makeErr()).label, 'auth', `${label} is not classified as auth`);
      const rows = await qaLeads(`auth-${label.replace(/\W+/g, '-')}`, 3);
      let attempts;
      const alerts = await qaCaptureAlerts(async () => {
        attempts = await qaRun(rows, QA_OUTAGE_TICKS, () => { throw makeErr(); }, {
          perTick: ({ tick, callsThisTick, ids }) => {
            assert.ok(callsThisTick <= 1,
              `${label}: the sweep did not halt at tick ${tick}: ${callsThisTick} calls (#${ids.join(', #')})`);
          },
        });
      });
      const total = [...attempts.values()].reduce((sum, list) => sum + list.length, 0);
      assert.ok(total >= 1 && total <= QA_OUTAGE_TICKS, `${label}: ${total} calls in ${QA_OUTAGE_TICKS} ticks`);
      assert.ok(alerts.total >= 1, `${label}: no alert raised (hook ${alerts.hooked.length}, rows ${alerts.tableRows}, log lines ${alerts.logged.length})`);
      for (const text of [...alerts.logged, ...alerts.hooked.map((x) => JSON.stringify(x))]) {
        assert.equal(/@example\.com/.test(text), false, `${label}: the alert names a lead address`);
      }
      await qaRecover(rows, `auth ${label}`);
    });
  }

  const QA_SENDER_ERRORS = {
    'Invalid From header': () => Object.assign(new Error('Gmail API: Invalid From header address'), { status: 400 }),
    'Invalid Reply-To header': () => Object.assign(new Error('Gmail API: Invalid Reply-To header'), {
      status: 400, reason: 'invalidArgument',
    }),
  };

  for (const [label, makeErr] of Object.entries(QA_SENDER_ERRORS)) {
    it(`QA r6: a sender-config error (${label}) stops only the sweep and charges and stops no lead`, async () => {
      assert.equal(classifyFollowupError(makeErr()).label, 'sender', `${label} is not sender config`);
      const rows = await qaLeads(`sender-${label.replace(/\W+/g, '-')}`, 3);
      const attempts = await qaRun(rows, 12, () => { throw makeErr(); }, {
        perTick: ({ tick, callsThisTick }) => {
          assert.ok(callsThisTick <= 1, `${label}: the sweep did not stop at tick ${tick}: ${callsThisTick} calls`);
        },
      });
      const total = [...attempts.values()].reduce((sum, list) => sum + list.length, 0);
      assert.ok(total >= 1);
      await qaRecover(rows, `sender ${label}`);
    });
  }

  it('QA r6: with no Gmail token and no transport, ticks send nothing and stop nothing', async () => {
    const rows = await qaLeads('no-token', 2);
    _setTransport(null);
    for (let tick = 0; tick < 6; tick += 1) {
      assert.deepEqual(await sendDueFollowups(), { sent: 0 });
      await qaAdvance();
    }
    for (const r of rows) {
      const s = await fullProposal(r.id);
      assert.equal(s.status, 'sent');
      assert.equal(Number(s.followup_argument_attempts), 0);
    }
  });

  const QA_CAPPED = {
    'Gmail 400 badRequest': {
      label: 'argument', reason: 'Follow-up stopped: Gmail rejected the message',
      err: () => Object.assign(new Error('Gmail API: Invalid thread_id'), { status: 400, reason: 'badRequest' }),
    },
    'Gmail 413': {
      label: 'payload', reason: 'Follow-up stopped: the message was too large',
      err: () => Object.assign(new Error('Gmail API: Request payload size exceeds the limit'), { status: 413 }),
    },
    unknown: {
      label: 'later', reason: 'Follow-up stopped: later retry limit reached',
      err: () => new Error('Unexpected mailer failure'),
    },
  };

  for (const [label, item] of Object.entries(QA_CAPPED)) {
    it(`QA r6: a ${label} error stops after exactly 3 attempts`, async () => {
      assert.equal(classifyFollowupError(item.err()).label, item.label);
      const [row] = await qaLeads(`cap-${label.replace(/\W+/g, '-')}`, 1);
      const seen = [];
      const attempts = await qaRun([row], 16, () => { throw item.err(); }, {
        allowStop: true,
        perTick: async ({ callsThisTick }) => {
          if (!callsThisTick) return;
          const s = await fullProposal(row.id);
          seen.push([s.status, Number(s.followup_argument_attempts)]);
        },
      });
      assert.equal(attempts.get(row.id).length, 3, `${label}: attempts at ticks ${attempts.get(row.id)}`);
      assert.deepEqual(seen.slice(0, 2), [['sent', 1], ['sent', 2]]);
      const s = await fullProposal(row.id);
      assert.equal(s.status, 'stopped');
      assert.equal(s.stop_reason, item.reason);
      assert.equal(s.followup1_sent_at, null);
    });
  }

  it('QA r6: 400, 413, and unknown errors share one 3-attempt count', async () => {
    const [row] = await qaLeads('cap-shared', 1);
    const script = [QA_CAPPED['Gmail 400 badRequest'].err, QA_CAPPED['Gmail 413'].err, QA_CAPPED.unknown.err];
    const attempts = await qaRun([row], 16, ({ n }) => { throw script[Math.min(n, 3) - 1](); }, { allowStop: true });
    assert.equal(attempts.get(row.id).length, 3, `attempts at ticks ${attempts.get(row.id)}`);
    const s = await fullProposal(row.id);
    assert.equal(s.status, 'stopped');
    assert.equal(s.stop_reason, QA_CAPPED.unknown.reason);
  });

  it('QA r6: a permanent 550 5.1.1 stops on the first attempt, fresh or after an outage backoff', async () => {
    const perm = () => Object.assign(new Error("Can't send mail - all recipients were rejected: 550 5.1.1 User unknown"), {
      responseCode: 550, command: 'RCPT TO', response: '550 5.1.1 <test+qa6@example.com>: User unknown',
    });
    assert.equal(classifyFollowupError(perm()).kind, 'permanent');
    const [fresh, outaged] = await qaLeads('perm', 2);
    const attempts = await qaRun([fresh, outaged], 12, ({ id, n }) => {
      if (id === outaged.id && n === 1) throw Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' });
      throw perm();
    }, { allowStop: true });
    assert.equal(attempts.get(fresh.id).length, 1);
    assert.equal(attempts.get(outaged.id).length, 2);
    for (const r of [fresh, outaged]) {
      const s = await fullProposal(r.id);
      assert.equal(s.status, 'stopped');
      assert.equal(s.stop_reason, 'Follow-up stopped: address rejected');
      assert.equal(Number(s.followup_argument_attempts), 0, `#${r.id}: the earlier network error was charged a capped attempt`);
    }
  });

  it('QA r6: interleaved outage errors neither consume nor reset the capped counter', async () => {
    const [row] = await qaLeads('interleave', 1);
    const script = [
      () => new Error('Unexpected mailer failure'),
      () => Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }),
      () => new Error('Unexpected mailer failure'),
      () => Object.assign(new Error('Gmail API: Backend Error'), { status: 503 }),
      () => Object.assign(new Error('Gmail API: Too many concurrent requests for user'), { status: 429 }),
      () => new Error('Unexpected mailer failure'),
    ];
    const after = [];
    const attempts = await qaRun([row], 40, ({ n }) => { throw script[Math.min(n, script.length) - 1](); }, {
      allowStop: true,
      perTick: async ({ callsThisTick }) => {
        if (!callsThisTick) return;
        const s = await fullProposal(row.id);
        after.push([s.status, Number(s.followup_argument_attempts)]);
      },
    });
    assert.equal(attempts.get(row.id).length, script.length, `attempts at ticks ${attempts.get(row.id)}`);
    assert.deepEqual(after.slice(0, 5), [['sent', 1], ['sent', 1], ['sent', 2], ['sent', 2], ['sent', 2]]);
    const s = await fullProposal(row.id);
    assert.equal(s.status, 'stopped');
    assert.equal(s.stop_reason, 'Follow-up stopped: later retry limit reached');
  });

  const QA_RECHECK = {
    'an outage backoff': () => Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }),
    'an unknown-error retry': () => new Error('Unexpected mailer failure'),
  };

  for (const [label, makeErr] of Object.entries(QA_RECHECK)) {
    it(`QA r6: do-not-contact or a reply during ${label} stops the sequence at the next retry with no send`, async () => {
      const [dnc, replied, control] = await qaLeads(`recheck-${label.replace(/\W+/g, '-')}`, 3);
      const ids = new Map([[dnc.id, 'dnc'], [replied.id, 'replied'], [control.id, 'control']]);
      let flagged = false;
      const stoppedAt = new Map();
      const attempts = await qaRun([dnc, replied, control], 12, () => { throw makeErr(); }, {
        allowStop: true,
        perTick: async ({ tick }) => {
          for (const id of [dnc.id, replied.id]) {
            if (!stoppedAt.has(id) && (await fullProposal(id)).status !== 'sent') stoppedAt.set(id, tick);
          }
          if (tick === 0) {
            await pool.query('UPDATE prospects SET do_not_contact = TRUE WHERE id = (SELECT prospect_id FROM proposals WHERE id = $1)', [dnc.id]);
            await pool.query(`UPDATE prospects SET stage = 'responded' WHERE id = (SELECT prospect_id FROM proposals WHERE id = $1)`, [replied.id]);
            flagged = true;
          }
        },
      });
      assert.ok(flagged);
      for (const [id, name] of ids) {
        assert.equal(attempts.get(id)[0], 0, `${name}: first attempt not at tick 0`);
      }
      const controlTicks = attempts.get(control.id);
      assert.ok(controlTicks.length >= 2, `control did not retry: ${controlTicks}`);
      for (const [row, reason] of [[dnc, 'Lead is do-not-contact'], [replied, 'Lead moved to responded']]) {
        assert.deepEqual(attempts.get(row.id), [0], `${ids.get(row.id)}: sent again after the flag`);
        assert.ok(stoppedAt.get(row.id) <= controlTicks[1],
          `${ids.get(row.id)}: stopped at tick ${stoppedAt.get(row.id)}, after the next retry at ${controlTicks[1]}`);
        const s = await fullProposal(row.id);
        assert.equal(s.status, 'stopped', `${ids.get(row.id)}: still ${s.status}`);
        assert.equal(s.stop_reason, reason);
        assert.equal(s.followup1_sent_at, null);
        assert.ok(Number(s.followup_argument_attempts) <= 1, `${ids.get(row.id)}: charged after the flag`);
      }
    });
  }

  it('round 6: a do-not-contact, lost, or responded flag inside Gmail status or token refresh sends nothing', async () => {
    const gmail = require('../src/proposals/gmail');
    const original = { status: gmail.status, accessToken: gmail.accessToken };
    const flags = [
      ['do_not_contact', (id) => pool.query('UPDATE prospects SET do_not_contact = TRUE WHERE id = $1', [id]), 'Lead is do-not-contact'],
      ['lost', (id) => pool.query(`UPDATE prospects SET stage = 'lost' WHERE id = $1`, [id]), 'Lead moved to lost'],
      ['responded', (id) => pool.query(`UPDATE prospects SET stage = 'responded' WHERE id = $1`, [id]), 'Lead moved to responded'],
    ];
    try {
      for (const [name, flag, reason] of flags) {
        for (const where of ['status', 'refresh']) {
          const row = await legacySent(`test+recheck-${name}-${where}@example.com`);
          const calls = useTransport(async () => ({ messageId: '<nope@localhost>', threadId: 'thr-nope' }));
          gmail.status = async () => {
            if (where === 'status') await flag(row.prospect.id);
            return { configured: true, connected: true, email: 'test+sender@example.com' };
          };
          gmail.accessToken = async () => {
            if (where === 'refresh') await flag(row.prospect.id);
            return 'test-token';
          };
          await sendDueFollowups();
          assert.equal(calls.length, 0, `${name} during ${where} still sent`);
          const after = await state(row.proposal.id);
          assert.equal(after.followup1_sent_at, null);
          assert.equal(after.status, 'stopped', `${name} during ${where}: ${after.status}`);
          assert.equal(after.stop_reason, reason);
        }
      }
    } finally {
      gmail.status = original.status;
      gmail.accessToken = original.accessToken;
    }
  });

  it('round 6: approve and inbox see do-not-contact set inside status and token refresh', async () => {
    const gmail = require('../src/proposals/gmail');
    const inbox = require('../src/proposals/inbox');
    const original = { status: gmail.status, accessToken: gmail.accessToken };
    try {
      for (const where of ['status', 'refresh']) {
        const prospect = await lead();
        const draft = await insertProposal(prospect.id, { status: 'draft', toEmail: `test+approve-gap-${where}@example.com` });
        const calls = useTransport();
        gmail.status = async () => {
          if (where === 'status') await pool.query('UPDATE prospects SET do_not_contact = TRUE WHERE id = $1', [prospect.id]);
          return { configured: true, connected: true };
        };
        gmail.accessToken = async () => {
          if (where === 'refresh') await pool.query('UPDATE prospects SET do_not_contact = TRUE WHERE id = $1', [prospect.id]);
          return 'test-token';
        };
        const res = await fetch(`${apiBase}/api/proposals/${draft.id}/send`, {
          method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': API_KEY }, body: '{}',
        });
        assert.equal(res.status, 409, `approve ${where}`);
        assert.equal(calls.length, 0, `approve ${where} sent`);
        assert.equal((await state(draft.id)).status, 'draft');

        const message = await pool.query(
          `INSERT INTO inbox_messages (prospect_id, direction, dedupe_key, from_addr, subject, body)
           VALUES ($1, 'in', $2, $3, 'Hi', 'hello') RETURNING id`,
          [prospect.id, `round6-${where}-${prospect.id}`, `test+inbox-${where}@example.com`]
        );
        const item = await pool.query(
          `INSERT INTO inbox_items (prospect_id, message_id, status, reply_to, reply_subject, reply_body)
           VALUES ($1, $2, 'ready', $3, 'Re: Hi', 'Thanks.') RETURNING id`,
          [prospect.id, message.rows[0].id, `test+inbox-${where}@example.com`]
        );
        await pool.query('UPDATE prospects SET do_not_contact = FALSE WHERE id = $1', [prospect.id]);
        const replyCalls = useTransport();
        await assert.rejects(() => inbox.sendReply(item.rows[0].id));
        assert.equal(replyCalls.length, 0, `inbox ${where} sent`);
      }
    } finally {
      gmail.status = original.status;
      gmail.accessToken = original.accessToken;
    }
  });

  it('round 6: an inbox reply still sends when the stage becomes responded during the token refresh', async () => {
    const gmail = require('../src/proposals/gmail');
    const inbox = require('../src/proposals/inbox');
    const original = { status: gmail.status, accessToken: gmail.accessToken };
    const prospect = await lead();
    try {
      gmail.status = async () => ({ configured: true, connected: true });
      gmail.accessToken = async () => {
        await pool.query(`UPDATE prospects SET stage = 'responded' WHERE id = $1`, [prospect.id]);
        return 'test-token';
      };
      const message = await pool.query(
        `INSERT INTO inbox_messages (prospect_id, direction, dedupe_key, from_addr, subject, body)
         VALUES ($1, 'in', $2, 'test+inbox-responded@example.com', 'Hi', 'hello') RETURNING id`,
        [prospect.id, `round6-responded-${prospect.id}`]
      );
      const item = await pool.query(
        `INSERT INTO inbox_items (prospect_id, message_id, status, reply_to, reply_subject, reply_body)
         VALUES ($1, $2, 'ready', 'test+inbox-responded@example.com', 'Re: Hi', 'Thanks.') RETURNING id`,
        [prospect.id, message.rows[0].id]
      );
      const calls = useTransport();
      const sent = await inbox.sendReply(item.rows[0].id);
      assert.equal(calls.length, 1);
      assert.equal(sent.status, 'sent');
    } finally {
      gmail.status = original.status;
      gmail.accessToken = original.accessToken;
    }
  });

  it('round 6: sendMail is called in the same turn as the recheck', async () => {
    const row = await legacySent('test+same-turn@example.com');
    let raced = false;
    const orig = pool.query.bind(pool);
    pool.query = function (text, params) {
      const result = orig(text, params);
      if (typeof text === 'string' && text.includes('do_not_contact, stage, archived_at')) {
        return {
          then(onFulfilled, onRejected) {
            return result.then((value) => {
              const out = onFulfilled ? onFulfilled(value) : value;
              setImmediate(() => { raced = true; });
              return out;
            }, onRejected);
          },
          catch(fn) { return this.then(undefined, fn); },
        };
      }
      return result;
    };
    let sawRace = null;
    try {
      useTransport(() => {
        sawRace = raced;
        return { messageId: '<gap@localhost>', threadId: 'thr-gap' };
      });
      await sendDueFollowups();
    } finally {
      pool.query = orig;
    }
    assert.equal(sawRace, false);
    assert.ok((await state(row.proposal.id)).followup1_sent_at);
  });

  it('round 6: terminating the lock backend does not crash the process', async () => {
    const row = await legacySent('test+lock-die@example.com');
    const crashes = [];
    const onException = (err) => crashes.push(err);
    const onRejection = (err) => crashes.push(err);
    process.on('uncaughtException', onException);
    process.on('unhandledRejection', onRejection);
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    let entered;
    const inSend = new Promise((resolve) => { entered = resolve; });
    useTransport(async () => {
      entered();
      await gate;
      return { messageId: '<lock@localhost>', threadId: 'thr-lock' };
    });
    const sweep = sendDueFollowups();
    try {
      await inSend;
      const locks = await pool.query(
        `SELECT l.pid FROM pg_locks l
          WHERE l.locktype = 'advisory' AND l.granted AND l.classid = 0
            AND l.objid = 89089017 AND l.objsubid = 1`
      );
      assert.ok(locks.rows.length >= 1, 'lock backend was not visible');
      await pool.query('SELECT pg_terminate_backend($1::int)', [locks.rows[0].pid]);
    } finally {
      release();
    }
    await sweep;
    process.removeListener('uncaughtException', onException);
    process.removeListener('unhandledRejection', onRejection);
    assert.equal(crashes.length, 0, crashes.map((err) => err && err.message).join('; '));
    assert.ok((await state(row.proposal.id)).followup1_sent_at);
    const left = await pool.query(
      `SELECT COUNT(*)::int AS n FROM pg_locks
        WHERE locktype = 'advisory' AND granted AND classid = 0 AND objid = 89089017`
    );
    assert.equal(left.rows[0].n, 0);
  });

  it('round 6: a claim that is already at the cap writes nothing', async () => {
    const row = await legacySent('test+cap-nowrite@example.com');
    await pool.query('UPDATE proposals SET followup_argument_attempts = 3 WHERE id = $1', [row.proposal.id]);
    const calls = useTransport();
    await sendDueFollowups();
    assert.equal(calls.length, 0);
    const after = await fullProposal(row.proposal.id);
    assert.equal(after.status, 'sent');
    assert.equal(after.stop_reason, null);
    assert.equal(Number(after.followup_argument_attempts), 3);
  });

  it('round 6: claim SQL sees do-not-contact and a stop stage set just before the claim', async () => {
    for (const [stage, reason] of [[null, 'Lead is do-not-contact'], ['lost', 'Lead moved to lost']]) {
      const row = await legacySent(`test+claim-gate-${stage || 'dnc'}@example.com`);
      let rechecked = false;
      _beforeFollowupClaim(async (p) => {
        if (stage) await pool.query('UPDATE prospects SET stage = $2 WHERE id = $1', [p.prospect_id, stage]);
        else await pool.query('UPDATE prospects SET do_not_contact = TRUE WHERE id = $1', [p.prospect_id]);
      });
      _beforeTransport(() => { rechecked = true; });
      const calls = useTransport();
      await sendDueFollowups();
      assert.equal(calls.length, 0, reason);
      assert.equal(rechecked, false, reason);
      const after = await state(row.proposal.id);
      assert.equal(after.status, 'stopped');
      assert.equal(after.stop_reason, reason);
      _resetSendTestHooks();
    }
  });

  it('round 6: a claim lost to another key writes nothing', async () => {
    const row = await legacySent('test+lost-key@example.com');
    _beforeFollowupClaim(async (p) => {
      await pool.query(`UPDATE proposals SET send_attempt_key = 'other-writer' WHERE id = $1`, [p.id]);
    });
    const calls = useTransport();
    await sendDueFollowups();
    assert.equal(calls.length, 0);
    const after = await fullProposal(row.proposal.id);
    assert.equal(after.status, 'sent');
    assert.equal(after.send_attempt_key, 'other-writer');
    assert.equal(after.stop_reason, null);
    assert.equal(after.followup1_sent_at, null);
  });

  it('round 6: a follow-up success that no longer matches the lease goes to manual review only for that key', async () => {
    const row = await legacySent('test+zero-rows@example.com');
    useTransport(async () => {
      await pool.query(`UPDATE proposals SET status = 'sending' WHERE id = $1`, [row.proposal.id]);
      return { messageId: '<zero@localhost>', threadId: 'thr-zero' };
    });
    await sendDueFollowups();
    const owned = await state(row.proposal.id);
    assert.equal(owned.status, 'stopped');
    assert.equal(owned.stop_reason, 'Needs manual review: the send outcome is uncertain');
    assert.equal(owned.followup1_sent_at, null);

    const stolen = await legacySent('test+stolen-key@example.com');
    const bystander = await legacySent('test+bystander-key@example.com');
    await pool.query(`UPDATE proposals SET send_attempt_key = 'bystander-key' WHERE id = $1`, [bystander.proposal.id]);
    useTransport(async () => {
      await pool.query(`UPDATE proposals SET send_attempt_key = 'stolen' WHERE id = $1`, [stolen.proposal.id]);
      return { messageId: '<stolen@localhost>', threadId: 'thr-stolen' };
    });
    await sendDueFollowups();
    const mine = await fullProposal(stolen.proposal.id);
    const other = await fullProposal(bystander.proposal.id);
    assert.equal(mine.status, 'sent');
    assert.equal(mine.send_attempt_key, 'stolen');
    assert.equal(mine.stop_reason, null);
    assert.equal(other.status, 'sent');
    assert.equal(other.send_attempt_key, 'bystander-key');
    assert.equal(other.stop_reason, null);
  });

  it('round 6: an approve transport failure returns the draft and does not send', async () => {
    const prospect = await lead();
    const draft = await insertProposal(prospect.id, { status: 'draft', toEmail: 'test+approve-fault@example.com' });
    const calls = useTransport(async () => { throw new Error('smtp down'); });
    const res = await fetch(`${apiBase}/api/proposals/${draft.id}/send`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': API_KEY }, body: '{}',
    });
    assert.equal(res.status, 502);
    assert.equal(calls.length, 1);
    const after = await state(draft.id);
    assert.equal(after.status, 'draft');
    assert.equal(after.stop_reason, null);
  });

  it('round 8: 5.1.8 at RCPT TO halts the sweep and charges no lead', async () => {
    const first = await legacySent('test+rcpt518-a@example.com');
    const second = await legacySent('test+rcpt518-b@example.com');
    const calls = useTransport(async () => {
      const err = new Error('550 5.1.8 Bad sender domain');
      err.responseCode = 550;
      err.command = 'RCPT TO';
      err.code = 'EENVELOPE';
      throw err;
    });
    await sendDueFollowups();
    assert.equal(calls.length, 1);
    const lead = await state(first.proposal.id);
    assert.equal(lead.status, 'sent');
    assert.match(lead.error, /^Follow-up will retry: sender\b/);
    assert.equal(lead.followup1_sent_at, null);
    assert.equal((await state(second.proposal.id)).followup1_sent_at, null);
    assert.ok((await sendReadiness()).halt);
  });

  it('round 6: 5.1.8 at MAIL FROM halts the sweep', async () => {
    const first = await legacySent('test+mail518-a@example.com');
    const second = await legacySent('test+mail518-b@example.com');
    const calls = useTransport(async () => {
      const err = new Error('550 5.1.8 Bad sender domain');
      err.responseCode = 550;
      err.command = 'MAIL FROM';
      err.code = 'EENVELOPE';
      throw err;
    });
    await sendDueFollowups();
    assert.equal(calls.length, 1);
    assert.match((await state(first.proposal.id)).error, /^Follow-up will retry: sender\b/);
    assert.equal((await state(second.proposal.id)).followup1_sent_at, null);
  });

  it('round 6: a 5.1.8 quoted in the message does not halt the sweep', async () => {
    const first = await legacySent('test+mid518-a@example.com');
    const second = await legacySent('test+mid518-b@example.com');
    const calls = useTransport(async () => {
      const err = new Error('Gmail API: Delivery failed, see 550 5.1.8 Bad sender domain');
      err.status = 400;
      throw err;
    });
    await sendDueFollowups();
    assert.equal(calls.length, 2);
    assert.equal((await state(first.proposal.id)).status, 'sent');
    assert.equal((await state(second.proposal.id)).status, 'sent');
    assert.match((await state(first.proposal.id)).error, /argument \(1\/3\)/);
  });

  it('round 6: the halt payload has no error text, and an empty sweep keeps it when the credential check fails', async () => {
    const row = await legacySent('test+halt-keep@example.com');
    useTransport(() => { throw new Error('super-secret-mailbox@example.com access expired'); });
    await sendDueFollowups();
    const stored = await pool.query(`SELECT value FROM app_settings WHERE key = 'followups.halted'`);
    const payload = stored.rows[0].value;
    assert.equal(JSON.stringify(payload).includes('super-secret'), false);
    assert.equal(payload.error_class, 'auth');
    assert.equal(Object.hasOwn(payload, 'detail'), false);
    const firstSeen = payload.first_seen;
    await pool.query('UPDATE prospects SET archived_at = NOW() WHERE id = $1', [row.prospect.id]);
    _setTransport(null);
    const gmail = require('../src/proposals/gmail');
    const original = { status: gmail.status, accessToken: gmail.accessToken };
    gmail.status = async () => ({ configured: true, connected: true, email: 'test+sender@example.com' });
    gmail.accessToken = async () => {
      const err = new Error('invalid_grant token for super-secret-mailbox@example.com');
      err.code = 'invalid_grant';
      throw err;
    };
    try {
      await sendDueFollowups();
      const kept = (await sendReadiness()).halt;
      assert.ok(kept);
      assert.equal(kept.first_seen, firstSeen);
      assert.equal(JSON.stringify(kept).includes('super-secret'), false);
      await sendDueFollowups();
      const again = (await sendReadiness()).halt;
      assert.equal(again.first_seen, firstSeen);
      assert.equal(again.halted_ticks, kept.halted_ticks);
    } finally {
      gmail.status = original.status;
      gmail.accessToken = original.accessToken;
      _setTransport(null);
    }
  });

  it('round 6: closed proposals include a manual_review row', async () => {
    const row = await legacySent('test+closed-review@example.com');
    await pool.query(
      `UPDATE proposals SET status = 'manual_review', stop_reason = 'transient_max_age' WHERE id = $1`,
      [row.proposal.id]
    );
    const res = await fetch(`${apiBase}/api/proposals?view=closed`, { headers: { 'x-api-key': API_KEY } });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(body.proposals.some((p) => p.id === row.proposal.id));
    const summary = await fetch(`${apiBase}/api/proposals/summary`, { headers: { 'x-api-key': API_KEY } });
    const summaryBody = await summary.json();
    assert.equal(Object.hasOwn(summaryBody, 'halt'), true);
    assert.equal(summaryBody.halt, null);
  });

  it('round 7: mark-sent returns 400 with no to_email even when delivered and confirm_override are set', async () => {
    const prospect = await lead();
    const proposal = await insertProposal(prospect.id, { status: 'draft', toEmail: null });
    const before = await fullProposal(proposal.id);
    const res = await fetch(`${apiBase}/api/proposals/${proposal.id}/mark-sent`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': API_KEY },
      body: JSON.stringify({ delivered: true, confirm_override: true, note: 'no address' }),
    });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.error, 'Add a recipient email before marking this as sent.');
    const after = await fullProposal(proposal.id);
    assert.equal(after.status, before.status);
    assert.equal(after.sent_at, before.sent_at);
    assert.equal(after.stop_reason, before.stop_reason);
  });


  it('round 7: a successful send clears the send-again reason', async () => {
    const row = await legacySent('test+clear-reason@example.com');
    await pool.query(
      `UPDATE proposals SET status = 'draft', stop_reason = 'Confirm before sending again', sent_at = NULL,
          followup1_due_at = NULL, followup2_due_at = NULL WHERE id = $1`,
      [row.proposal.id]
    );
    useTransport();
    const sent = await fetch(`${apiBase}/api/proposals/${row.proposal.id}/send`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': API_KEY },
      body: JSON.stringify({ confirm: true }),
    });
    assert.equal(sent.status, 200);
    const after = await fullProposal(row.proposal.id);
    assert.equal(after.status, 'sent');
    assert.equal(after.stop_reason, null);
  });

  it('round 7: a halt records a fixed cause and not the error text', async () => {
    const cases = [
      [() => new Error('Gmail access expired. Go to Settings and click Connect Gmail again.'), 'oauth_expired'],
      [() => Object.assign(new Error('invalid_grant'), { reason: 'invalid_grant' }), 'oauth_expired'],
      [() => new Error('Token is missing'), 'token_missing'],
      [() => new Error('Gmail is not connected. Go to Settings and click Connect Gmail.'), 'token_missing'],
      [() => Object.assign(new Error('Request had insufficient authentication scopes.'), { status: 403, reason: 'insufficientPermissions' }), 'insufficient_permissions'],
      [() => Object.assign(new Error('535 5.7.8 Authentication failed'), { responseCode: 535, command: 'AUTH' }), 'smtp_auth'],
      [() => Object.assign(new Error('530 Authentication required'), { command: 'AUTH' }), 'smtp_auth'],
      [() => Object.assign(new Error('550 5.1.8 Bad sender domain'), { responseCode: 550, command: 'MAIL FROM' }), 'sender'],
    ];
    for (const [makeErr, cause] of cases) {
      const row = await legacySent(`test+cause-${cause}-${Math.random().toString(16).slice(2)}@example.com`);
      useTransport(() => { throw makeErr(); });
      await sendDueFollowups();
      const halt = (await sendReadiness()).halt;
      assert.equal(halt && halt.cause, cause, makeErr().message);
      assert.equal(JSON.stringify(halt).includes('example.com'), false);
      await pool.query('DELETE FROM app_settings WHERE key = ANY($1::text[])', [['followups.halted', 'sender_alert']]);
      await pool.query('UPDATE prospects SET archived_at = NOW() WHERE id = $1', [row.prospect.id]);
    }
  });

  describe('QA h (r7 block, run on the round 5 head)', { concurrency: false }, () => {
    // ── QA r7: outage recovery (Summit's answered #120 spec) ──
    // Outage classes (network, 5xx, quota/429, SMTP 4xx) back off per row with
    // delay = clamp(min(60, 15*2^(n-1)) * U(0.8, 1.2), 15, 60) minutes, where n
    // is the transient attempt number. They never stop or charge a lead. A row
    // whose current streak of transient failures reaches 72h moves to
    // status manual_review with reason transient_max_age, and a success resets
    // the streak. Auth (401, invalid_grant, 535, access expired, token missing)
    // and sender config halt the sweep. They charge and age no lead, log
    // one structured `followups.halted` error on entering the halt and then at
    // most hourly, show in sendReadiness, and clear on the first good tick. The
    // 3-attempt cap is shared by per-row 400, 413, and unknown errors. B1 (#122)
    // and B2 (concurrent sweeps) are tested at the end.
    // Fake time: each tick moves every proposals timestamp column back, so the
    // test never waits and any new retry/streak column moves too. Code that
    // keeps time in process memory (the alert dedupe) sees real time only.
    const QA_TICK_MIN = 15;
    const QA_FINE_TICK_MIN = 1; // jitter tests: one sweep per fake minute, so slack is 1 min
    const QA_SEND = require('../src/proposals/send');
    const { sendReadiness, senderTick } = QA_SEND;
    const QA_CEIL_MIN = 60;
    const QA_FLOOR_MIN = 15;
    const QA_MAX_AGE_MIN = 72 * 60;
    const QA_T72 = QA_MAX_AGE_MIN / QA_TICK_MIN;
    // Largest gap a 15-minute tick can observe: the 60-minute ceiling + 1 tick.
    const QA_GAP_MAX_MIN = QA_CEIL_MIN + QA_TICK_MIN;
    const QA_OUTAGE_TICKS = 32; // 8h of 15-minute ticks
    const QA_RECOVER_TICKS = Math.ceil(QA_GAP_MAX_MIN / QA_TICK_MIN) + 1;

    function qaDelay(n, r) {
      const base = Math.min(QA_CEIL_MIN, QA_FLOOR_MIN * 2 ** (n - 1));
      return Math.min(QA_CEIL_MIN, Math.max(QA_FLOOR_MIN, base * (0.8 + 0.4 * r)));
    }
    // Range of delay n for any U(0.8, 1.2) draw, after the clamp.
    function qaDelayRange(n) { return [qaDelay(n, 0), qaDelay(n, 1)]; }

    it('QA r7: exported backoff ceiling and max age, when present, match the spec (1h, 72h)', () => {
      if (QA_SEND.FOLLOWUP_BACKOFF_CAP_MS !== undefined) assert.equal(Number(QA_SEND.FOLLOWUP_BACKOFF_CAP_MS), 60 * 60 * 1000);
      if (QA_SEND.FOLLOWUP_MAX_AGE_MS !== undefined) assert.equal(Number(QA_SEND.FOLLOWUP_MAX_AGE_MS), 72 * 60 * 60 * 1000);
    });

    async function qaAdvance(minutes = QA_TICK_MIN) {
      const { rows } = await pool.query(
        `SELECT column_name FROM information_schema.columns
          WHERE table_schema = current_schema() AND table_name = 'proposals'
            AND data_type LIKE 'timestamp%'`);
      const sets = rows.map(({ column_name: c }) => `"${c}" = "${c}" - make_interval(mins => $1)`).join(', ');
      await pool.query(`UPDATE proposals SET ${sets}`, [minutes]);
    }

    async function qaLeads(tag, count) {
      const out = [];
      for (let i = 0; i < count; i++) {
        const { proposal } = await legacySent(`test+qa7-${tag}-${i}@example.com`);
        out.push(proposal);
      }
      return out;
    }

    // Takes finished rows out of later sweeps so a later qaRun sees only its own rows.
    async function qaPark(rows) {
      await pool.query(`UPDATE proposals SET status = 'stopped', stop_reason = 'QA parked' WHERE id = ANY($1)`, [rows.map((r) => r.id)]);
    }

    const qaTag = (label) => label.replace(/\W+/g, '-');
    const qaGaps = (ticks, tickMin) => ticks.slice(1).map((t, i) => (t - ticks[i]) * tickMin);

    // Jitter seam: send._setRandom when exported, else a Math.random stub.
    // `used` reports whether the code read it.
    async function qaWithRandom(rng, fn) {
      const probe = { used: 0 };
      const wrapped = () => { probe.used += 1; return rng(); };
      const hook = typeof QA_SEND._setRandom === 'function' ? QA_SEND._setRandom : null;
      const original = Math.random;
      if (hook) hook(wrapped); else Math.random = wrapped;
      try {
        probe.result = await fn();
      } finally {
        if (hook) hook(null); else Math.random = original;
      }
      return probe;
    }

    // Captures every console line during fn. Parsed `followups.halted` alerts
    // come back in `halted`.
    async function qaCapture(fn) {
      const lines = [];
      const objects = [];
      const orig = { error: console.error, warn: console.warn, info: console.info, log: console.log };
      for (const k of Object.keys(orig)) {
        console[k] = (...args) => {
          lines.push(args.map((a) => (a && typeof a === 'object' ? JSON.stringify(a) : String(a))).join(' '));
          for (const a of args) if (a && typeof a === 'object' && !(a instanceof Error)) objects.push(a);
        };
      }
      let result;
      try {
        result = await fn();
      } finally {
        Object.assign(console, orig);
      }
      const halted = [];
      const isHalted = (o) => Object.values(o).some((v) => v === 'followups.halted');
      for (const o of objects) if (isHalted(o)) halted.push(o);
      for (const line of lines) {
        if (!line.includes('followups.halted')) continue;
        const start = line.indexOf('{');
        const end = line.lastIndexOf('}');
        let parsed = null;
        try { parsed = start >= 0 ? JSON.parse(line.slice(start, end + 1)) : null; } catch { parsed = null; }
        if (parsed && isHalted(parsed)) {
          if (!halted.some((h) => JSON.stringify(h) === JSON.stringify(parsed))) halted.push(parsed);
        } else if (!objects.some(isHalted)) {
          halted.push({ unstructured: line });
        }
      }
      return { result, lines, halted };
    }

    const qaField = (o, names) => names.map((k) => o[k]).find((v) => v !== undefined);

    function qaAssertAlerts(label, alerts, { errorClass, ticks, tickMin, addresses }) {
      assert.ok(alerts.length >= 1, `${label}: no followups.halted alert`);
      // One on entering the halt, then at most one per fake hour.
      const hours = (ticks * tickMin) / 60;
      assert.ok(alerts.length <= 1 + Math.floor(hours),
        `${label}: ${alerts.length} followups.halted alerts in ${ticks} halted ticks (${hours}h); not deduped`);
      let lastTicks = 0;
      for (const a of alerts) {
        assert.equal(a.unstructured, undefined, `${label}: alert is not structured: ${a.unstructured}`);
        assert.equal(qaField(a, ['error_class', 'errorClass', 'class']), errorClass, `${label}: ${JSON.stringify(a)}`);
        const provider = qaField(a, ['provider']);
        assert.ok(typeof provider === 'string' && provider.length > 0, `${label}: no provider: ${JSON.stringify(a)}`);
        const firstSeen = qaField(a, ['first_seen', 'firstSeen']);
        assert.ok(firstSeen && !Number.isNaN(new Date(firstSeen).getTime()), `${label}: bad first_seen: ${JSON.stringify(a)}`);
        const halted = Number(qaField(a, ['halted_ticks', 'haltedTicks']));
        assert.ok(Number.isInteger(halted) && halted >= 1, `${label}: bad halted_ticks: ${JSON.stringify(a)}`);
        assert.ok(halted > lastTicks || alerts.length === 1, `${label}: halted_ticks does not grow: ${JSON.stringify(alerts)}`);
        lastTicks = halted;
        const text = JSON.stringify(a).toLowerCase();
        for (const addr of addresses) assert.equal(text.includes(addr.toLowerCase()), false, `${label}: the alert names ${addr}`);
        assert.equal(/test\+qa7/.test(text), false, `${label}: the alert names a lead`);
      }
      assert.equal(qaField(alerts[0], ['halted_ticks', 'haltedTicks']), 1, `${label}: first alert is not on entering the halt`);
    }

    // Runs `ticks` sweeps, `tickMin` fake minutes apart. sendMail(ctx) decides
    // each call. Unless allowStop, checks after every tick that no lead was
    // stopped or charged.
    async function qaRun(rows, ticks, sendMail, { allowStop = false, perTick, tickMin = QA_TICK_MIN, sweep } = {}) {
      const byAddress = new Map(rows.map((r) => [r.to_email, r.id]));
      const attempts = new Map(rows.map((r) => [r.id, []]));
      let tick = 0;
      let callsThisTick = [];
      _setTransport({
        async sendMail(mail) {
          const id = byAddress.get(mail.to.address);
          attempts.get(id).push(tick);
          callsThisTick.push(id);
          return sendMail({ id, tick, n: attempts.get(id).length, mail });
        },
      });
      for (tick = 0; tick < ticks; tick++) {
        callsThisTick = [];
        await (sweep || sendDueFollowups)();
        if (perTick) await perTick({ tick, callsThisTick: callsThisTick.length, ids: callsThisTick });
        if (!allowStop) {
          for (const r of rows) {
            const s = await fullProposal(r.id);
            assert.equal(s.status, 'sent', `#${r.id} left 'sent' at tick ${tick}: ${s.stop_reason}`);
            assert.equal(Number(s.followup_argument_attempts), 0, `#${r.id} was charged a capped attempt at tick ${tick}: ${s.error}`);
          }
        }
        await qaAdvance(tickMin);
      }
      return attempts;
    }

    const qaOk = (id, tag) => ({ messageId: `<qa7-${tag}-${id}@localhost>`, threadId: `thr-qa7-${id}` });

    async function qaRecover(rows, label, { firstTickSendsAll = false } = {}) {
      const sentAt = new Map();
      let firstTickCalls = null;
      await qaRun(rows, QA_RECOVER_TICKS, ({ id, tick }) => {
        sentAt.set(id, tick);
        return qaOk(id, qaTag(label));
      }, { perTick: ({ tick, callsThisTick }) => { if (tick === 0) firstTickCalls = callsThisTick; } });
      if (firstTickSendsAll) {
        assert.equal(firstTickCalls, rows.length, `${label}: the first good tick sent ${firstTickCalls} of ${rows.length}; the halt did not clear on the first good pass`);
      }
      for (const r of rows) {
        const s = await fullProposal(r.id);
        assert.ok(sentAt.has(r.id), `${label}: #${r.id} did not send within ${QA_GAP_MAX_MIN} min of recovery`);
        assert.equal(s.status, 'sent');
        assert.ok(s.followup1_sent_at, `${label}: follow-up 1 not recorded`);
        assert.equal(s.followup2_sent_at, null);
        assert.equal(s.error, null);
        assert.equal(s.stop_reason, null);
        assert.equal(Number(s.followup_argument_attempts), 0);
      }
      // Follow-up 2 sends on its first due tick, so no backoff or streak carried past the success.
      await pool.query(`UPDATE proposals SET followup2_due_at = NOW() - INTERVAL '1 minute' WHERE id = ANY($1)`,
        [rows.map((r) => r.id)]);
      const calls = useTransport();
      await sendDueFollowups();
      assert.equal(calls.length, rows.length, `${label}: follow-up 2 did not send on the first due tick`);
      for (const r of rows) {
        const s = await fullProposal(r.id);
        assert.ok(s.followup2_sent_at, `${label}: follow-up 2 not recorded for #${r.id}`);
        assert.equal(s.status, 'sent');
      }
    }

    const QA_OUTAGE_LABELS = ['network', 'server', 'quota', 'smtp'];
    const QA_PROVIDER_OUTAGES = {
      'network ECONNRESET': () => Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }),
      'network ETIMEDOUT': () => Object.assign(new Error('connect ETIMEDOUT 142.250.0.1:443'), { code: 'ETIMEDOUT' }),
      'Gmail 503': () => Object.assign(new Error('Gmail API: The service is currently unavailable.'), { status: 503 }),
      'Gmail 429': () => Object.assign(new Error('Gmail API: Too many concurrent requests for user'), { status: 429 }),
      'Gmail 403 rateLimitExceeded': () => Object.assign(new Error('Gmail API: User-rate limit exceeded'), {
        status: 403, errors: [{ reason: 'rateLimitExceeded', message: 'User-rate limit exceeded' }],
      }),
      'SMTP 451 4xx': () => Object.assign(new Error('451 4.3.0 Temporary server error. Please try again later'), {
        responseCode: 451, code: 'EENVELOPE', command: 'RCPT TO',
      }),
    };
    // Long enough for at least 5 retries even at the slowest draw (18+36+60+60 min).
    const QA_JITTER_FINE_TICKS = 240;

    for (const [label, makeErr] of Object.entries(QA_PROVIDER_OUTAGES)) {
      it(`QA r7: a ${label} outage follows clamp(min(60, 15*2^(n-1)) * U(0.8,1.2), 15, 60), never stops, then recovers`, async () => {
        assert.ok(QA_OUTAGE_LABELS.includes(classifyFollowupError(makeErr()).label), `${label} is not an outage class`);
        const tag = qaTag(label);
        const fail = () => { throw makeErr(); };
        const fine = { tickMin: QA_FINE_TICK_MIN };
        // Pinned draws: 0 and ~1 are the ±20% extremes; 0.5 is the midpoint.
        let seamUsed = true;
        for (const r of [0, 0.5, 0.999999]) {
          const [row] = await qaLeads(`${tag}-r${String(r).replace('.', '')}`, 1);
          const run = await qaWithRandom(() => r, () => qaRun([row], QA_JITTER_FINE_TICKS, fail, fine));
          await qaPark([row]);
          const gaps = qaGaps(run.result.get(row.id), QA_FINE_TICK_MIN);
          assert.ok(gaps.length >= 4, `${label} r=${r}: only ${gaps.length} retries in 4h: gaps ${gaps}`);
          if (!run.used) { seamUsed = false; continue; }
          gaps.forEach((g, i) => {
            const want = qaDelay(i + 1, r);
            assert.ok(g >= want && g <= want + QA_FINE_TICK_MIN,
              `${label} r=${r}: delay ${i + 1} was ${g} min, want ${want.toFixed(2)} (+${QA_FINE_TICK_MIN} min slack): gaps ${gaps}`);
          });
        }
        if (!seamUsed) console.log(`[followup-recipient] QA note: ${label} backoff never read the random seam; pinned-draw checks skipped`);
        // Real draws: each delay n is inside its ±20% band after the clamp, every
        // gap is in 15..60 min (+1 min slack), and draws differ across leads.
        const rows = await qaLeads(tag, 6);
        const attempts = await qaRun(rows, QA_JITTER_FINE_TICKS, fail, fine);
        const second = [];
        for (const r of rows) {
          const gaps = qaGaps(attempts.get(r.id), QA_FINE_TICK_MIN);
          assert.ok(gaps.length >= 4, `${label}: #${r.id} only ${gaps.length} retries: gaps ${gaps}`);
          gaps.forEach((g, i) => {
            const [lo, hi] = qaDelayRange(i + 1);
            assert.ok(g >= QA_FLOOR_MIN && g <= QA_CEIL_MIN + QA_FINE_TICK_MIN, `${label}: gap ${g} outside 15..60 min: gaps ${gaps}`);
            assert.ok(g >= lo && g <= hi + QA_FINE_TICK_MIN,
              `${label}: delay ${i + 1} was ${g} min, outside the ±20% band ${lo}..${hi} (+${QA_FINE_TICK_MIN}): gaps ${gaps}`);
          });
          second.push(gaps[1]);
        }
        assert.ok(new Set(second).size > 1, `${label}: delay 2 was ${second[0]} min for all ${rows.length} leads; no jitter`);
        await qaPark(rows.slice(2));
        await qaRecover(rows.slice(0, 2), label);
      });

      it(`QA r7: a ${label} streak retries under 72h, recovers with no restore, and is manual_review/transient_max_age at 72h`, async () => {
        const tag = `age-${qaTag(label)}`;
        const [recover, aged] = await qaLeads(tag, 2);
        const recoverAt = QA_T72 - 16; // 4h before the max age
        let reviewedAt = null;
        const attempts = await qaRun([recover, aged], QA_T72 + QA_RECOVER_TICKS, ({ id, tick }) => {
          if (id === recover.id && tick >= recoverAt) return qaOk(id, tag);
          throw makeErr();
        }, {
          allowStop: true,
          perTick: async ({ tick }) => {
            const r = await fullProposal(recover.id);
            assert.equal(r.status, 'sent', `${label}: the recovering lead left 'sent' at tick ${tick}: ${r.stop_reason}`);
            assert.equal(Number(r.followup_argument_attempts), 0, `${label}: recovering lead charged at tick ${tick}`);
            const a = await fullProposal(aged.id);
            assert.equal(Number(a.followup_argument_attempts), 0, `${label}: aged lead charged at tick ${tick}: ${a.error}`);
            if (tick < QA_T72) {
              assert.equal(a.status, 'sent', `${label}: moved before 72h, at ${(tick * QA_TICK_MIN / 60).toFixed(2)}h: ${a.status} ${a.stop_reason}`);
            } else if (reviewedAt == null && a.status !== 'sent') {
              reviewedAt = tick;
            }
          },
        });
        const agedTicks = attempts.get(aged.id);
        assert.ok(agedTicks.some((t) => t < QA_T72 && t >= QA_T72 - QA_RECOVER_TICKS),
          `${label}: no retry in the last ${QA_GAP_MAX_MIN} min before 72h: last attempts ${agedTicks.slice(-4)}`);
        const a = await fullProposal(aged.id);
        assert.ok(reviewedAt != null, `${label}: still '${a.status}' ${QA_GAP_MAX_MIN} min after 72h: ${a.error}`);
        assert.equal(a.status, 'manual_review', `${label}: status ${a.status} (${a.stop_reason})`);
        assert.equal(a.stop_reason, 'transient_max_age');
        assert.equal(a.followup1_sent_at, null);
        assert.ok(agedTicks.every((t) => t <= reviewedAt), `${label}: sent after manual review`);
        const recTicks = attempts.get(recover.id).filter((t) => t >= recoverAt);
        assert.equal(recTicks.length, 1, `${label}: recovery sent ${recTicks.length} times`);
        const r = await fullProposal(recover.id);
        assert.ok(r.followup1_sent_at);
        assert.equal(r.error, null);
        assert.equal(r.stop_reason, null);
      });
    }

    it('QA r7: a success resets the 72h streak clock; the next streak gets its own 72h', async () => {
      const makeErr = QA_PROVIDER_OUTAGES['network ECONNRESET'];
      const [row] = await qaLeads('streak', 1);
      const okAt = 160; // 40h into the first streak
      let fu2Started = null;
      let reviewedAt = null;
      const total = okAt + 2 * QA_RECOVER_TICKS + QA_T72 + 1;
      const attempts = await qaRun([row], total, ({ id, tick }) => {
        if (tick >= okAt && fu2Started == null) return qaOk(id, 'streak');
        throw makeErr();
      }, {
        allowStop: true,
        perTick: async ({ tick }) => {
          const s = await fullProposal(row.id);
          if (fu2Started == null && s.followup1_sent_at) {
            // Follow-up 1 went out. Make follow-up 2 due now so a new streak starts next tick.
            await pool.query(`UPDATE proposals SET followup2_due_at = NOW() - INTERVAL '1 minute' WHERE id = $1`, [row.id]);
            fu2Started = tick + 1;
            return;
          }
          if (fu2Started != null && tick < fu2Started + QA_T72) {
            assert.equal(s.status, 'sent',
              `streak not reset: moved at ${((tick - fu2Started) * QA_TICK_MIN / 60).toFixed(2)}h into the second streak ` +
              `(${(tick * QA_TICK_MIN / 60).toFixed(2)}h after the first failure): ${s.status} ${s.stop_reason}`);
          } else if (fu2Started != null && reviewedAt == null && s.status !== 'sent') {
            reviewedAt = tick;
          }
        },
      });
      assert.ok(fu2Started != null && fu2Started <= okAt + QA_RECOVER_TICKS, `follow-up 1 did not send after recovery`);
      const s = await fullProposal(row.id);
      assert.ok(reviewedAt != null, `second streak never reached max age: ${s.status} ${s.error}`);
      assert.equal(s.status, 'manual_review');
      assert.equal(s.stop_reason, 'transient_max_age');
      assert.ok(s.followup1_sent_at);
      assert.equal(s.followup2_sent_at, null);
      assert.ok(attempts.get(row.id).some((t) => t > reviewedAt - QA_RECOVER_TICKS), 'no retry near the end of the second streak');
    });

    // Auth and sender config halt the sweep. Classes per Summit.
    const QA_AUTH_OUTAGES = {
      'refresh invalid_grant': () => new Error("Couldn't refresh Gmail access: invalid_grant"),
      'HTTP 401': () => Object.assign(new Error('Gmail API: Request had invalid authentication credentials.'), { status: 401 }),
      'SMTP 535': () => Object.assign(new Error('Invalid login: 535-5.7.8 Username and Password not accepted'), {
        responseCode: 535, code: 'EAUTH', command: 'AUTH PLAIN',
      }),
      'access expired': () => new Error('Gmail access expired. Go to Settings and click Connect Gmail again.'),
      'token missing': () => new Error('Gmail is not connected. Go to Settings and click Connect Gmail.'),
    };
    const QA_SENDER_ERRORS = {
      'Invalid From header': () => Object.assign(new Error('Gmail API: Invalid From header address'), { status: 400 }),
      'Invalid Reply-To header': () => Object.assign(new Error('Gmail API: Invalid Reply-To header'), {
        status: 400, reason: 'invalidArgument',
      }),
    };
    const QA_HALTS = [
      ...Object.entries(QA_AUTH_OUTAGES).map(([label, makeErr]) => ({ label: `auth ${label}`, makeErr, errorClass: 'auth' })),
      ...Object.entries(QA_SENDER_ERRORS).map(([label, makeErr]) => ({ label: `sender ${label}`, makeErr, errorClass: 'sender' })),
    ];

    async function qaHaltRun(label, makeErr, rows, ticks) {
      const baseline = await sendReadiness();
      const readiness = [];
      const captured = await qaCapture(() => qaRun(rows, ticks, () => { throw makeErr(); }, {
        perTick: async ({ tick, callsThisTick, ids }) => {
          assert.ok(callsThisTick <= 1, `${label}: the sweep did not halt at tick ${tick}: ${callsThisTick} calls (#${ids.join(', #')})`);
          if (tick === 0 || tick === ticks - 1) readiness.push(await sendReadiness());
        },
      }));
      const total = [...captured.result.values()].reduce((sum, list) => sum + list.length, 0);
      assert.ok(total >= 1, `${label}: never probed`);
      // Visible as a new problem entry or as a halt field on the result.
      for (const r of readiness) {
        const shown = { problems: [...r], halt: r.halt };
        assert.ok(r.length > baseline.length || (r.halt != null && baseline.halt == null),
          `${label}: halted state not visible in sendReadiness: ${JSON.stringify(shown)}`);
        assert.equal(/test\+qa7|@example\.com/.test(JSON.stringify(shown)), false, `${label}: sendReadiness names a lead`);
      }
      return { captured, baseline };
    }

    for (const { label, makeErr, errorClass } of QA_HALTS) {
      it(`QA r7: ${label} halts the sweep, logs a deduped followups.halted, shows in sendReadiness, and clears on the first good tick`, async () => {
        assert.equal(classifyFollowupError(makeErr()).label, errorClass, `${label} is not classified as ${errorClass}`);
        const rows = await qaLeads(`halt-${qaTag(label)}`, 3);
        const { captured, baseline } = await qaHaltRun(label, makeErr, rows, QA_OUTAGE_TICKS);
        qaAssertAlerts(label, captured.halted, {
          errorClass, ticks: QA_OUTAGE_TICKS, tickMin: QA_TICK_MIN, addresses: rows.map((r) => r.to_email),
        });
        await qaRecover(rows, label, { firstTickSendsAll: true });
        assert.deepEqual(await sendReadiness(), baseline, `${label}: sendReadiness still shows the halt after recovery`);
      });
    }

    for (const { label, makeErr } of [QA_HALTS[0], QA_HALTS.find((h) => h.errorClass === 'sender')]) {
      it(`QA r7: a ${label} halt lasting over 72h ages no lead; recovery sends with no manual review`, async () => {
        const rows = await qaLeads(`halt72-${qaTag(label)}`, 3);
        await qaHaltRun(label, makeErr, rows, QA_T72 + 8); // 74h
        await qaRecover(rows, `${label} 72h`, { firstTickSendsAll: true });
        for (const r of rows) assert.notEqual((await fullProposal(r.id)).status, 'manual_review');
      });
    }

    it('QA r7: with no Gmail token and no transport, ticks send nothing and stop nothing', async () => {
      const rows = await qaLeads('no-token', 2);
      _setTransport(null);
      for (let tick = 0; tick < 6; tick++) {
        assert.deepEqual(await sendDueFollowups(), { sent: 0 });
        await qaAdvance();
      }
      for (const r of rows) {
        const s = await fullProposal(r.id);
        assert.equal(s.status, 'sent');
        assert.equal(Number(s.followup_argument_attempts), 0);
      }
    });

    // The 3-attempt cap is shared by per-row 400, 413, and unknown errors.
    const QA_CAPPED = {
      'Gmail 400 badRequest': {
        label: 'argument', reason: 'Follow-up stopped: Gmail rejected the message',
        err: () => Object.assign(new Error('Gmail API: Invalid thread_id'), { status: 400, reason: 'badRequest' }),
      },
      'Gmail 413': {
        label: 'payload', reason: 'Follow-up stopped: the message was too large',
        err: () => Object.assign(new Error('Gmail API: Request payload size exceeds the limit'), { status: 413 }),
      },
      unknown: {
        label: 'later', reason: 'Follow-up stopped: later retry limit reached',
        err: () => new Error('Unexpected mailer failure'),
      },
    };

    for (const [label, item] of Object.entries(QA_CAPPED)) {
      it(`QA r7: a ${label} error stops after exactly 3 attempts`, async () => {
        assert.equal(classifyFollowupError(item.err()).label, item.label);
        const [row] = await qaLeads(`cap-${qaTag(label)}`, 1);
        const seen = [];
        const attempts = await qaRun([row], 16, () => { throw item.err(); }, {
          allowStop: true,
          perTick: async ({ callsThisTick }) => {
            if (!callsThisTick) return;
            const s = await fullProposal(row.id);
            seen.push([s.status, Number(s.followup_argument_attempts)]);
          },
        });
        assert.equal(attempts.get(row.id).length, 3, `${label}: attempts at ticks ${attempts.get(row.id)}`);
        assert.deepEqual(seen.slice(0, 2), [['sent', 1], ['sent', 2]]);
        const s = await fullProposal(row.id);
        assert.equal(s.status, 'stopped');
        assert.equal(s.stop_reason, item.reason);
        assert.equal(s.followup1_sent_at, null);
      });
    }

    it('QA r7: 400, 413, and unknown errors share one 3-attempt count', async () => {
      const [row] = await qaLeads('cap-shared', 1);
      const script = [QA_CAPPED['Gmail 400 badRequest'].err, QA_CAPPED['Gmail 413'].err, QA_CAPPED.unknown.err];
      const attempts = await qaRun([row], 16, ({ n }) => { throw script[Math.min(n, 3) - 1](); }, { allowStop: true });
      assert.equal(attempts.get(row.id).length, 3, `attempts at ticks ${attempts.get(row.id)}`);
      const s = await fullProposal(row.id);
      assert.equal(s.status, 'stopped');
      assert.equal(s.stop_reason, QA_CAPPED.unknown.reason);
    });

    it('QA r7: a permanent 550 5.1.1 stops on the first attempt, fresh or after an outage backoff', async () => {
      const perm = () => Object.assign(new Error("Can't send mail - all recipients were rejected: 550 5.1.1 User unknown"), {
        responseCode: 550, command: 'RCPT TO', response: '550 5.1.1 <test+qa7@example.com>: User unknown',
      });
      assert.equal(classifyFollowupError(perm()).kind, 'permanent');
      const [fresh, outaged] = await qaLeads('perm', 2);
      const attempts = await qaRun([fresh, outaged], 12, ({ id, n }) => {
        if (id === outaged.id && n === 1) throw Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' });
        throw perm();
      }, { allowStop: true });
      assert.equal(attempts.get(fresh.id).length, 1);
      assert.equal(attempts.get(outaged.id).length, 2);
      for (const r of [fresh, outaged]) {
        const s = await fullProposal(r.id);
        assert.equal(s.status, 'stopped');
        assert.equal(s.stop_reason, 'Follow-up stopped: address rejected');
        assert.equal(Number(s.followup_argument_attempts), 0, `#${r.id}: the earlier network error was charged a capped attempt`);
      }
    });

    it('QA r7: interleaved outage errors neither consume nor reset the capped counter', async () => {
      const [row] = await qaLeads('interleave', 1);
      const script = [
        () => new Error('Unexpected mailer failure'),
        () => Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }),
        () => new Error('Unexpected mailer failure'),
        () => Object.assign(new Error('Gmail API: Backend Error'), { status: 503 }),
        () => Object.assign(new Error('Gmail API: Too many concurrent requests for user'), { status: 429 }),
        () => new Error('Unexpected mailer failure'),
      ];
      const after = [];
      const attempts = await qaRun([row], 40, ({ n }) => { throw script[Math.min(n, script.length) - 1](); }, {
        allowStop: true,
        perTick: async ({ callsThisTick }) => {
          if (!callsThisTick) return;
          const s = await fullProposal(row.id);
          after.push([s.status, Number(s.followup_argument_attempts)]);
        },
      });
      assert.equal(attempts.get(row.id).length, script.length, `attempts at ticks ${attempts.get(row.id)}`);
      assert.deepEqual(after.slice(0, 5), [['sent', 1], ['sent', 1], ['sent', 2], ['sent', 2], ['sent', 2]]);
      const s = await fullProposal(row.id);
      assert.equal(s.status, 'stopped');
      assert.equal(s.stop_reason, 'Follow-up stopped: later retry limit reached');
    });

    // Do-not-contact and responded are rechecked before every retry.
    const QA_RECHECK = {
      'an outage backoff': () => Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }),
      'an unknown-error retry': () => new Error('Unexpected mailer failure'),
    };

    for (const [label, makeErr] of Object.entries(QA_RECHECK)) {
      it(`QA r7: do-not-contact or a reply during ${label} stops the sequence at the next retry with no send`, async () => {
        // A reply is modelled as the stage moving to responded (what the inbox path writes).
        const [dnc, replied, control] = await qaLeads(`recheck-${qaTag(label)}`, 3);
        const names = new Map([[dnc.id, 'dnc'], [replied.id, 'replied'], [control.id, 'control']]);
        const stoppedAt = new Map();
        const attempts = await qaRun([dnc, replied, control], 12, () => { throw makeErr(); }, {
          allowStop: true,
          perTick: async ({ tick }) => {
            for (const id of [dnc.id, replied.id]) {
              if (!stoppedAt.has(id) && (await fullProposal(id)).status !== 'sent') stoppedAt.set(id, tick);
            }
            if (tick === 0) {
              await pool.query('UPDATE prospects SET do_not_contact = TRUE WHERE id = (SELECT prospect_id FROM proposals WHERE id = $1)', [dnc.id]);
              await pool.query(`UPDATE prospects SET stage = 'responded' WHERE id = (SELECT prospect_id FROM proposals WHERE id = $1)`, [replied.id]);
            }
          },
        });
        const controlTicks = attempts.get(control.id);
        assert.equal(controlTicks[0], 0);
        assert.ok(controlTicks.length >= 2, `control did not retry: ${controlTicks}`);
        for (const [row, reason] of [[dnc, 'Lead is do-not-contact'], [replied, 'Lead moved to responded']]) {
          assert.deepEqual(attempts.get(row.id), [0], `${names.get(row.id)}: sent again after the flag`);
          // Each row draws its own jitter, so the bound is the later of the control's
          // retry and the slowest first delay (18 min).
          const due = Math.max(controlTicks[1], Math.ceil(qaDelay(1, 1) / QA_TICK_MIN));
          assert.ok(stoppedAt.get(row.id) <= due,
            `${names.get(row.id)}: stopped at tick ${stoppedAt.get(row.id)}, after its next retry was due at ${due}`);
          const s = await fullProposal(row.id);
          assert.equal(s.status, 'stopped');
          assert.equal(s.stop_reason, reason);
          assert.equal(s.followup1_sent_at, null);
          assert.ok(Number(s.followup_argument_attempts) <= 1, `${names.get(row.id)}: charged after the flag`);
        }
      });
    }

    // B1 (#122): Gmail or SMTP accepts the message, then the connection times
    // out or resets, so the follow-up is delivered but the call throws. Main has
    // this bug: its sweep retries every failed follow-up on every tick, so over N
    // ticks it delivers up to N copies. #120 must be no worse. If the head has
    // B1 handling, the first such failure must go to manual review with no retry.
    // B1 handling counts as present when send.js exports isUncertainDelivery(err)
    // or uncertainSend(err) that returns true for the probe, or
    // classifyFollowupError(probe).kind is 'uncertain' or 'manual_review', or
    // the row is in manual review after the first failure.
    const QA_B1_PROBES = {
      'SMTP timeout after DATA': () => Object.assign(new Error('Timeout'), { code: 'ETIMEDOUT', command: 'DATA' }),
      'SMTP reset after DATA': () => Object.assign(new Error('Connection closed unexpectedly'), { code: 'ECONNRESET', command: 'DATA' }),
      'Gmail API socket reset after upload': () => Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }),
    };
    const qaInManualReview = (s) => s.status === 'manual_review' || /manual review/i.test(String(s.stop_reason));

    function qaB1Static(err) {
      for (const name of ['isUncertainDelivery', 'uncertainSend']) {
        if (typeof QA_SEND[name] === 'function') {
          try { if (QA_SEND[name](err) === true) return `${name}()`; } catch { /* not this seam */ }
        }
      }
      const kind = classifyFollowupError(err).kind;
      return ['uncertain', 'manual_review'].includes(kind) ? `classifyFollowupError kind ${kind}` : null;
    }

    for (const [label, makeErr] of Object.entries(QA_B1_PROBES)) {
      it(`QA r7: B1 ${label}: no worse than main, and manual review with no retry when B1 handling is present`, async () => {
        const [row, bystander] = await qaLeads(`b1-${qaTag(label)}`, 2);
        const delivered = [];
        let afterFirst = null;
        const attempts = await qaRun([row, bystander], QA_OUTAGE_TICKS, ({ id, tick }) => {
          if (id === bystander.id) return qaOk(id, 'b1');
          delivered.push(tick); // the provider accepted the message ...
          throw makeErr(); // ... then the connection failed
        }, {
          allowStop: true,
          perTick: async ({ tick, ids }) => {
            assert.ok(ids.filter((x) => x === row.id).length <= 1, `${label}: two deliveries in one sweep at tick ${tick}`);
            if (tick === 0) afterFirst = await fullProposal(row.id);
          },
        });
        const viaStatic = qaB1Static(makeErr());
        const viaBehaviour = qaInManualReview(afterFirst);
        const s = await fullProposal(row.id);
        if (viaStatic || viaBehaviour) {
          console.log(`[followup-recipient] QA note: B1 handling detected for ${label} (${viaStatic || 'manual review after the first failure'})`);
          assert.ok(viaBehaviour, `${label}: ${viaStatic} says uncertain, but the row was '${afterFirst.status}' after the first failure: ${afterFirst.error}`);
          assert.deepEqual(delivered, [0], `${label}: retried after an uncertain delivery: ticks ${delivered}`);
          assert.ok(qaInManualReview(s), `${label}: left manual review: ${s.status} ${s.stop_reason}`);
          assert.equal(s.followup2_sent_at, null);
        } else {
          console.log(`[followup-recipient] QA note: no B1 handling for ${label}; checked against main's behaviour`);
          // Main delivers once per tick for every tick in the window.
          const mainDeliveries = QA_OUTAGE_TICKS;
          assert.ok(delivered.length <= mainDeliveries, `${label}: ${delivered.length} deliveries, main makes ${mainDeliveries}`);
          assert.notEqual(s.status, 'sending', `${label}: row left claimed`);
          assert.equal(s.followup2_sent_at, null, `${label}: follow-up 2 went out while follow-up 1 is unconfirmed`);
          assert.notEqual(s.stop_reason, 'Follow-up stopped: address rejected');
        }
        // The bystander is unaffected either way.
        assert.equal(attempts.get(bystander.id).length, 1);
        assert.ok((await fullProposal(bystander.id)).followup1_sent_at);
      });
    }

    it('QA r7: B1 an error flagged accepted goes to manual review with no retry (already handled at head)', async () => {
      const [row] = await qaLeads('b1-accepted', 1);
      const attempts = await qaRun([row], 12, () => {
        throw Object.assign(new Error('Timeout'), { code: 'ETIMEDOUT', accepted: true });
      }, { allowStop: true });
      assert.deepEqual(attempts.get(row.id), [0]);
      assert.ok(qaInManualReview(await fullProposal(row.id)));
    });

    // B2: the check-inbox route and the cron sweep run at once. The sweep that
    // loses the advisory lock skips the row and writes nothing.
    it('QA r7: B2 check-inbox during a cron sweep: advisory lock held, losing sweep skips the row with no write, one delivery each', async () => {
      const [x, y] = await qaLeads('b2', 2);
      const calls = new Map([[x.to_email, 0], [y.to_email, 0]]);
      let seq = 0;
      let release;
      const gate = new Promise((resolve) => { release = resolve; });
      let entered;
      const inSend = new Promise((resolve) => { entered = resolve; });
      _setTransport({
        async sendMail(mail) {
          calls.set(mail.to.address, calls.get(mail.to.address) + 1);
          if (mail.to.address === x.to_email && calls.get(x.to_email) === 1) {
            entered();
            await gate;
          }
          return { messageId: `<qa7-b2-${(seq += 1)}@localhost>`, threadId: 'thr-qa7-b2' };
        },
      });
      const cron = senderTick();
      await Promise.race([inSend, new Promise((_, reject) => setTimeout(() => reject(new Error('cron sweep never reached X')), 5000))]);
      try {
        const locks = await pool.query(`SELECT COUNT(*)::int AS n FROM pg_locks WHERE locktype = 'advisory' AND granted`);
        assert.ok(locks.rows[0].n >= 1, 'no advisory lock is held during the follow-up sweep');
        const before = await fullProposal(x.id);
        const res = await Promise.race([
          fetch(`${apiBase}/api/proposals/check-inbox`, { method: 'POST', headers: { 'x-api-key': API_KEY } }),
          new Promise((_, reject) => setTimeout(() => reject(new Error('check-inbox waited on the cron sweep')), 5000)),
        ]);
        assert.equal(res.status, 200);
        assert.deepEqual(await fullProposal(x.id), before, 'the losing sweep wrote to the row the cron sweep holds');
        assert.equal(calls.get(x.to_email), 1, 'the losing sweep called the transport for the held row');
      } finally {
        release();
        await cron;
      }
      assert.equal(calls.get(x.to_email), 1);
      assert.equal(calls.get(y.to_email), 1, `Y delivered ${calls.get(y.to_email)} times`);
      for (const r of [x, y]) {
        const s = await fullProposal(r.id);
        assert.equal(s.status, 'sent', `#${r.id}: ${s.status} ${s.stop_reason}`);
        assert.ok(s.followup1_sent_at, `#${r.id}: the winning sweep's success write was dropped`);
        assert.equal(s.error, null);
      }
      const locks = await pool.query(`SELECT COUNT(*)::int AS n FROM pg_locks WHERE locktype = 'advisory' AND granted`);
      assert.equal(locks.rows[0].n, 0, 'the advisory lock was not released');
    });
  });
  describe('QA i (r8: survivor kills and restored checks on the round 5 head)', { concurrency: false }, () => {
    const QA_I = require('../src/proposals/send');

    it('QA r8: the 500-between-400s run makes exactly five calls with the full status sequence', async () => {
      const prospect = await lead();
      const proposal = await insertProposal(prospect.id, { toEmail: 'test+alternate-r8@example.com' });
      let calls = 0;
      useTransport(async () => {
        calls += 1;
        const err = new Error(calls % 2 === 1 ? 'Gmail API: Invalid thread_id' : 'Internal error encountered.');
        err.status = calls % 2 === 1 ? 400 : 500;
        if (err.status === 400) err.reason = 'badRequest';
        throw err;
      });
      const seen = [];
      for (let i = 0; i < 5; i += 1) {
        await qaAdvance(QA_GAP_MAX_MIN);
        await sendDueFollowups();
        const { rows } = await pool.query(
          'SELECT status, followup_argument_attempts, error FROM proposals WHERE id = $1', [proposal.id]);
        seen.push(rows[0]);
      }
      assert.equal(calls, 5, `transport called ${calls} times`);
      assert.deepEqual(seen.map((r) => [r.status, Number(r.followup_argument_attempts)]),
        [['sent', 1], ['sent', 1], ['sent', 2], ['sent', 2], ['stopped', 3]]);
      assert.match(seen[1].error, /^Follow-up will retry: server\b/);
      assert.match(seen[3].error, /^Follow-up will retry: server\b/);
      assert.equal(seen[4].error, 'Follow-up stopped: Gmail rejected the message');
    });

    it('QA r8: a cap reached by another writer mid-send stops the lead on that tick', async () => {
      const row = await legacySent('test+capraced-r8@example.com');
      const calls = useTransport(async () => {
        await pool.query('UPDATE proposals SET followup_argument_attempts = 3 WHERE id = $1', [row.proposal.id]);
        const err = new Error('Gmail API: Invalid thread_id');
        err.status = 400;
        err.reason = 'badRequest';
        throw err;
      });
      await sendDueFollowups();
      assert.equal(calls.length, 1);
      const after = await state(row.proposal.id);
      assert.equal(after.status, 'stopped', `row is ${after.status}: ${after.error}`);
      assert.equal(after.stop_reason, 'Follow-up stopped: Gmail rejected the message');
      assert.equal(/null/.test(String(after.error)), false, after.error);
    });

    it('QA r8: a code-less 5.1.8 is a sender halt only at the start of the reply', () => {
      const rows = [
        [Object.assign(new Error('Gmail API: Delivery failed, see 550 5.1.8 Bad sender domain'), { status: 400 }), 'argument'],
        [Object.assign(new Error('550 5.1.8x Bad sender domain'), { status: 400 }), 'argument'],
      ];
      for (const [err, label] of rows) {
        const got = QA_I.classifyFollowupError(err);
        assert.equal(got.label, label, `${err.message}: ${got.kind}/${got.label}`);
      }
    });

    it('QA r8: a clean pass with nothing due still clears the halt alert', async () => {
      const row = await legacySent('test+halt-idle-r8@example.com');
      useTransport(() => { throw new Error('Gmail is not connected. Go to Settings and click Connect Gmail.'); });
      await sendDueFollowups();
      assert.notEqual((await QA_I.sendReadiness()).halt, null);
      await pool.query('UPDATE prospects SET archived_at = NOW() WHERE id = $1', [row.prospect.id]);
      const calls = useTransport();
      await sendDueFollowups();
      assert.equal(calls.length, 0);
      assert.equal((await QA_I.sendReadiness()).halt, null, 'halt alert stayed after a clean pass');
    });
  });


  describe('QA j (r9, adjusted for Summit: 5.1.8 at RCPT TO halts)', { concurrency: false }, () => {
    const QA_J = require('../src/proposals/send');
    const QA_J_GMAIL = require('../src/proposals/gmail');

    async function qaJRow(id) {
      const { rows } = await pool.query(
        `SELECT status, stop_reason, error, followup1_sent_at, followup_argument_attempts,
                followup_transient_attempts, first_transient_at, next_retry_at, send_attempt_key
           FROM proposals WHERE id = $1`, [id]);
      return rows[0];
    }

    for (const [name, make] of [
      ['numeric 451', () => Object.assign(new Error('451 4.3.0 Try again later'), { responseCode: 451, command: 'MAIL FROM', response: '451 4.3.0 Try again later', code: 'EENVELOPE' })],
      ['code-less 421', () => Object.assign(new Error('421 4.4.2 try again later'), { command: 'MAIL FROM' })],
    ]) {
      it(`QA r9: a ${name} at MAIL FROM backs off as an outage and the next lead still sends`, async () => {
        QA_J._setRandom(() => 0.5);
        try {
          const first = await legacySent(`test+mail4xx-a-${name.replace(/\W/g, '')}@example.com`, { sentAt: new Date(Date.now() - 2 * 86400000) });
          const second = await legacySent(`test+mail4xx-b-${name.replace(/\W/g, '')}@example.com`);
          const calls = useTransport(async (mail) => {
            if (String(mail.to.address).includes('mail4xx-a')) throw make();
            return { messageId: '<ok@localhost>', threadId: 'thr-ok' };
          });
          await sendDueFollowups();
          assert.equal(calls.length, 2, 'the sweep stopped after a MAIL FROM 4xx');
          const a = await qaJRow(first.proposal.id);
          assert.equal(a.status, 'sent');
          assert.equal(a.error, 'Follow-up will retry: smtp');
          assert.equal(Number(a.followup_argument_attempts), 0);
          assert.equal(Number(a.followup_transient_attempts), 1);
          assert.ok((await qaJRow(second.proposal.id)).followup1_sent_at);
          assert.equal((await QA_J.sendReadiness()).halt, null);
        } finally {
          QA_J._setRandom(() => 0.5);
        }
      });
    }

    it('QA r9: a 5.1.8 at RCPT TO halts the sweep and charges no lead', async () => {
      const first = await legacySent('test+rcpt518j-a@example.com', { sentAt: new Date(Date.now() - 2 * 86400000) });
      const second = await legacySent('test+rcpt518j-b@example.com');
      const calls = useTransport(async () => {
        throw Object.assign(new Error("Can't send mail - all recipients were rejected: 550 5.1.8 Bad sender domain"), {
          code: 'EENVELOPE', command: 'RCPT TO', responseCode: 550,
          response: '550 5.1.8 Bad sender domain',
        });
      });
      await sendDueFollowups();
      assert.equal(calls.length, 1);
      const a = await qaJRow(first.proposal.id);
      assert.equal(a.status, 'sent');
      assert.match(a.error, /^Follow-up will retry: sender\b/);
      assert.equal(Number(a.followup_argument_attempts), 0);
      assert.equal(a.followup1_sent_at, null);
      assert.equal((await qaJRow(second.proposal.id)).followup1_sent_at, null);
      assert.equal((await QA_J.sendReadiness()).halt.cause, 'sender');
    });

    it('QA r9: an empty sweep clears the halt only after a real Gmail token check passes', async () => {
      const row = await legacySent('test+halt-pass-r9@example.com');
      useTransport(() => { throw Object.assign(new Error('Gmail API: Invalid Credentials'), { status: 401 }); });
      await sendDueFollowups();
      assert.ok((await QA_J.sendReadiness()).halt);
      await pool.query('UPDATE prospects SET archived_at = NOW() WHERE id = $1', [row.prospect.id]);
      _setTransport(null);
      const original = { status: QA_J_GMAIL.status, accessToken: QA_J_GMAIL.accessToken };
      let tokenChecks = 0;
      QA_J_GMAIL.status = async () => ({ configured: true, connected: true, email: 'test+sender@example.com' });
      try {
        QA_J_GMAIL.accessToken = async () => { tokenChecks += 1; throw new Error('Gmail access expired. Go to Settings and click Connect Gmail again.'); };
        await sendDueFollowups();
        assert.ok(tokenChecks >= 1, 'the empty sweep ran no token check');
        assert.ok((await QA_J.sendReadiness()).halt, 'a failing token check cleared the halt');
        QA_J_GMAIL.accessToken = async () => { tokenChecks += 1; return 'test-token'; };
        const before = tokenChecks;
        await sendDueFollowups();
        assert.ok(tokenChecks > before, 'the clearing sweep ran no token check');
        assert.equal((await QA_J.sendReadiness()).halt, null);
      } finally {
        QA_J_GMAIL.status = original.status;
        QA_J_GMAIL.accessToken = original.accessToken;
        _setTransport(null);
      }
    });

    it('QA r9 probe: an empty sweep in SMTP mode keeps a 535 halt when no SMTP login was checked', async () => {
      const row = await legacySent('test+halt-smtp-r9@example.com');
      useTransport(() => { throw Object.assign(new Error('535 5.7.8 Username and Password not accepted'), { responseCode: 535, command: 'AUTH PLAIN' }); });
      await sendDueFollowups();
      assert.ok((await QA_J.sendReadiness()).halt, 'no halt after a 535');
      await pool.query('UPDATE prospects SET archived_at = NOW() WHERE id = $1', [row.prospect.id]);
      _setTransport(null);
      const env = { u: process.env.GMAIL_USER, p: process.env.GMAIL_APP_PASSWORD };
      const original = QA_J_GMAIL.status;
      process.env.GMAIL_USER = 'test+smtp@example.com';
      process.env.GMAIL_APP_PASSWORD = 'not-a-real-password';
      QA_J_GMAIL.status = async () => ({ configured: false, connected: false });
      try {
        assert.equal(await QA_J.mailMode(), 'smtp');
        await sendDueFollowups();
        assert.ok((await QA_J.sendReadiness()).halt, 'SMTP env vars alone cleared a 535 halt');
      } finally {
        QA_J_GMAIL.status = original;
        if (env.u === undefined) delete process.env.GMAIL_USER; else process.env.GMAIL_USER = env.u;
        if (env.p === undefined) delete process.env.GMAIL_APP_PASSWORD; else process.env.GMAIL_APP_PASSWORD = env.p;
        _setTransport(null);
      }
    });
  });

  it('round 8: nodemailer prefixes do not make a quoted enhanced code permanent', () => {
    const SMTPConnection = require('nodemailer/lib/smtp-connection');
    const conn = new SMTPConnection({ port: 1, host: '127.0.0.1' });
    const replies = [
      '550 Rejected by policy; upstream said 550 5.1.1 user unknown',
      '554 Transaction failed: relay said 554 5.1.1 unknown',
      '552 Mailbox over quota; earlier hop 552 5.1.1',
      'see 550 5.1.8 bad',
    ];
    for (const reply of replies) {
      const raw = Object.assign(new Error(reply), { responseCode: Number(reply.slice(0, 3)) || 550, command: 'RCPT TO', response: reply });
      if (!/^\d{3}/.test(reply)) raw.responseCode = 550;
      const formatted = conn._formatError("Can't send mail - all recipients were rejected", 'EENVELOPE', reply, 'RCPT TO');
      for (const err of [raw, formatted]) {
        const got = classifyFollowupError(err);
        assert.notEqual(got.kind, 'permanent', err.message);
        assert.notEqual(got.label, 'sender', err.message);
      }
    }
    const real = conn._formatError("Can't send mail - all recipients were rejected", 'EENVELOPE', '550 5.1.1 user unknown', 'RCPT TO');
    assert.equal(classifyFollowupError(real).kind, 'permanent');
  });

  it('round 8: a loopback SMTP drop after DATA is an outage, not the cap', async () => {
    const net = require('net');
    const nodemailer = require('nodemailer');
    const server = net.createServer((socket) => {
      socket.write('220 localhost ESMTP\r\n');
      let buf = '';
      let data = false;
      socket.on('data', (chunk) => {
        if (data) { socket.destroy(); return; }
        buf += chunk.toString('utf8');
        if (!buf.includes('\n')) return;
        const line = buf.split(/\r?\n/)[0];
        buf = '';
        const cmd = line.split(' ')[0].toUpperCase();
        if (cmd === 'EHLO' || cmd === 'HELO') socket.write('250-localhost\r\n250 OK\r\n');
        else if (cmd === 'DATA') { data = true; socket.write('354 Go\r\n'); }
        else if (cmd === 'QUIT') socket.end('221 bye\r\n');
        else socket.write('250 OK\r\n');
      });
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    let caught;
    try {
      const tx = nodemailer.createTransport({ host: '127.0.0.1', port, secure: false, connectionTimeout: 5000, tls: { rejectUnauthorized: false } });
      await tx.sendMail({ from: 'test+from@example.com', to: 'test+to@example.com', subject: 'TEST', text: 'hi' });
    } catch (err) {
      caught = err;
    } finally {
      server.close();
    }
    assert.ok(caught, 'the drop did not throw');
    assert.equal(classifyFollowupError(caught).label, 'network', `${caught.code} ${caught.command} ${caught.message}`);
    const row = await legacySent('test+data-drop@example.com');
    let n = 0;
    useTransport(() => { n += 1; throw caught; });
    await sendDueFollowups();
    await qaAdvance(75);
    await sendDueFollowups();
    await qaAdvance(75);
    await sendDueFollowups();
    await qaAdvance(75);
    await sendDueFollowups();
    const after = await fullProposal(row.proposal.id);
    assert.equal(after.status, 'sent');
    assert.notEqual(after.stop_reason, 'Follow-up stopped: later retry limit reached');
    assert.ok(n >= 2, `only ${n} calls`);
  });

  it('round 8: do-not-contact set by a settings read is seen before send', async () => {
    const axios = require('axios');
    const gmailMod = require('../src/proposals/gmail');
    const prevAdapter = axios.defaults.adapter;
    const prevId = process.env.GOOGLE_CLIENT_ID;
    const prevSecret = process.env.GOOGLE_CLIENT_SECRET;
    process.env.GOOGLE_CLIENT_ID = 'test-client-id';
    process.env.GOOGLE_CLIENT_SECRET = 'test-client-secret';
    let sends = 0;
    axios.defaults.adapter = async (config) => {
      const url = String(config && config.url || '');
      if (url.includes('oauth2.googleapis.com/token')) {
        return { data: { access_token: 'test-access', expires_in: 3600 }, status: 200, statusText: 'OK', headers: {}, config };
      }
      if (url.includes('/messages/send')) {
        sends += 1;
        return { data: { id: 'mid', threadId: 'thr' }, status: 200, statusText: 'OK', headers: {}, config };
      }
      return { data: { payload: { headers: [] } }, status: 200, statusText: 'OK', headers: {}, config };
    };
    const orig = pool.query.bind(pool);
    const arm = { id: null };
    pool.query = function (text, params) {
      const q = orig(text, params);
      if (arm.id && typeof text === 'string' && text.includes('app_settings')) {
        return q.then(async (value) => {
          await orig('UPDATE prospects SET do_not_contact = TRUE WHERE id = $1', [arm.id]);
          return value;
        });
      }
      return q;
    };
    try {
      await pool.query(
        `INSERT INTO app_settings (key, value, updated_at) VALUES ('gmail_oauth', $1::jsonb, NOW())`,
        [JSON.stringify({ refresh_token: 'test-refresh-token', email: 'test+sender@example.com' })]
      );
      _setTransport(null);
      const follow = await legacySent('test+dnc-read-fu@example.com');
      arm.id = follow.prospect.id;
      await sendDueFollowups();
      assert.equal(sends, 0, 'follow-up mailed after the settings read');
      assert.equal((await state(follow.proposal.id)).followup1_sent_at, null);

      const prospect = await lead();
      const draft = await insertProposal(prospect.id, { status: 'draft', toEmail: 'test+dnc-read-approve@example.com' });
      arm.id = prospect.id;
      const approved = await fetch(`${apiBase}/api/proposals/${draft.id}/send`, {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': API_KEY }, body: '{}',
      });
      assert.equal(approved.status, 409);
      assert.equal(sends, 0, 'approve mailed after the settings read');

      const message = await pool.query(
        `INSERT INTO inbox_messages (prospect_id, direction, dedupe_key, from_addr, subject, body)
         VALUES ($1, 'in', $2, 'test+dnc-read-inbox@example.com', 'Hi', 'hello') RETURNING id`,
        [prospect.id, `round8-dnc-${prospect.id}`]
      );
      const item = await pool.query(
        `INSERT INTO inbox_items (prospect_id, message_id, status, reply_to, reply_subject, reply_body)
         VALUES ($1, $2, 'ready', 'test+dnc-read-inbox@example.com', 'Re: Hi', 'Thanks.') RETURNING id`,
        [prospect.id, message.rows[0].id]
      );
      await pool.query('UPDATE prospects SET do_not_contact = FALSE WHERE id = $1', [prospect.id]);
      const inbox = require('../src/proposals/inbox');
      await assert.rejects(() => inbox.sendReply(item.rows[0].id));
      assert.equal(sends, 0, 'inbox reply mailed after the settings read');
    } finally {
      pool.query = orig;
      axios.defaults.adapter = prevAdapter;
      if (prevId === undefined) delete process.env.GOOGLE_CLIENT_ID; else process.env.GOOGLE_CLIENT_ID = prevId;
      if (prevSecret === undefined) delete process.env.GOOGLE_CLIENT_SECRET; else process.env.GOOGLE_CLIENT_SECRET = prevSecret;
      _setTransport(null);
    }
  });


  it('round 9: MIME build that marks do-not-contact sends nothing on follow-up, approve, and inbox', async () => {
    const MimeNode = require('nodemailer/lib/mime-node');
    const inbox = require('../src/proposals/inbox');
    const orig = MimeNode.prototype.build;
    let arm = null;
    MimeNode.prototype.build = function build(...args) {
      const pending = arm
        ? pool.query('UPDATE prospects SET do_not_contact = TRUE WHERE id = $1', [arm])
        : Promise.resolve();
      return Promise.resolve(pending).then(() => orig.apply(this, args));
    };
    try {
      const row = await legacySent('test+build-dnc-fu@example.com');
      arm = row.prospect.id;
      const followCalls = useTransport();
      await sendDueFollowups();
      assert.equal(followCalls.length, 0, 'follow-up mailed after build() marked do-not-contact');
      const followed = await state(row.proposal.id);
      assert.equal(followed.followup1_sent_at, null);
      assert.equal(followed.status, 'stopped');
      assert.equal(followed.stop_reason, 'Lead is do-not-contact');

      const prospect = await lead();
      const draft = await insertProposal(prospect.id, { status: 'draft', toEmail: 'test+build-dnc-approve@example.com' });
      arm = prospect.id;
      const approveCalls = useTransport();
      const approved = await fetch(`${apiBase}/api/proposals/${draft.id}/send`, {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': API_KEY }, body: '{}',
      });
      assert.equal(approved.status, 409);
      assert.equal(approveCalls.length, 0, 'approve mailed after build() marked do-not-contact');
      assert.equal((await state(draft.id)).status, 'draft');

      const message = await pool.query(
        `INSERT INTO inbox_messages (prospect_id, direction, dedupe_key, from_addr, subject, body)
         VALUES ($1, 'in', $2, 'test+build-dnc-inbox@example.com', 'Hi', 'hello') RETURNING id`,
        [prospect.id, `round9-build-${prospect.id}`]
      );
      const item = await pool.query(
        `INSERT INTO inbox_items (prospect_id, message_id, status, reply_to, reply_subject, reply_body)
         VALUES ($1, $2, 'ready', 'test+build-dnc-inbox@example.com', 'Re: Hi', 'Thanks.') RETURNING id`,
        [prospect.id, message.rows[0].id]
      );
      await pool.query('UPDATE prospects SET do_not_contact = FALSE WHERE id = $1', [prospect.id]);
      arm = prospect.id;
      const replyCalls = useTransport();
      await assert.rejects(() => inbox.sendReply(item.rows[0].id), (err) => err.status === 409);
      assert.equal(replyCalls.length, 0, 'inbox reply mailed after build() marked do-not-contact');
      const reply = await pool.query('SELECT status FROM inbox_items WHERE id = $1', [item.rows[0].id]);
      assert.equal(reply.rows[0].status, 'ready');
    } finally {
      MimeNode.prototype.build = orig;
    }
  });

  it('round 9: ECONNECTION is a network outage without a closed-connection phrase', () => {
    const err = Object.assign(new Error('socket dropped'), { code: 'ECONNECTION', command: 'API' });
    const got = classifyFollowupError(err);
    assert.equal(got.kind, 'transient');
    assert.equal(got.label, 'network');
  });

  describe('QA k (r10: round 8 scope, run on 16fe5ab)', { concurrency: false }, () => {
    const QA_K = require('../src/proposals/send');
    const QA_K_GMAIL = require('../src/proposals/gmail');
    const QA_K_UNCERTAIN = 'Needs manual review: the send outcome is uncertain';

    async function qaKPost(id, route, body) {
      const res = await fetch(`${apiBase}/api/proposals/${id}/${route}`, {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': API_KEY },
        body: JSON.stringify(body == null ? {} : body),
      });
      let json = null;
      try { json = await res.json(); } catch { json = null; }
      return { status: res.status, body: json };
    }

    async function qaKSnapshot(row) {
      const { rows } = await pool.query('SELECT * FROM proposals WHERE prospect_id = $1 ORDER BY id', [row.prospect.id]);
      return {
        proposals: JSON.parse(JSON.stringify(rows)),
        prospect: await prospectStamp(row.prospect.id),
        activities: await activities(row.prospect.id),
      };
    }

    // The four review shapes #120 can produce.
    async function qaKReviewRows(tag, toEmail) {
      const email = (k) => (toEmail === undefined ? `test+k-${tag}-${k}@example.com` : toEmail);
      const aged = await legacySent(email('aged'));
      await pool.query(
        `UPDATE proposals SET status = 'manual_review', stop_reason = 'transient_max_age', error = 'transient_max_age',
                first_transient_at = NOW() - INTERVAL '80 hours' WHERE id = $1`, [aged.proposal.id]);
      const firstSend = await legacySent(email('first'), { sentAt: null });
      await pool.query(
        `UPDATE proposals SET status = 'stopped', stop_reason = $2, error = $2, sent_at = NULL, approved_at = NOW() - INTERVAL '1 hour',
                followup1_due_at = NULL, followup2_due_at = NULL WHERE id = $1`, [firstSend.proposal.id, QA_K_UNCERTAIN]);
      const followUp = await legacySent(email('fu'));
      await pool.query(
        `UPDATE proposals SET status = 'stopped', stop_reason = $2, error = $2 WHERE id = $1`, [followUp.proposal.id, QA_K_UNCERTAIN]);
      const sending = await legacySent(email('sending'), { sentAt: null });
      await pool.query(
        `UPDATE proposals SET status = 'sending', sent_at = NULL, approved_at = NOW(), send_attempt_key = 'k-live-key' WHERE id = $1`,
        [sending.proposal.id]);
      return { aged, firstSend, followUp, sending };
    }

    const QA_K_BODIES = [
      {}, { note: 'Called them' }, { delivered: true }, { confirm_override: true }, { not_sent: true },
      { confirm_override: true, delivered: true }, { confirm_override: true, not_sent: true }, { confirm: true },
    ];

    it('QA r10: mark-sent and restore refuse every review row, whatever the body, and write nothing', async () => {
      const calls = useTransport();
      const rows = await qaKReviewRows('refuse');
      for (const [name, row] of Object.entries(rows)) {
        const before = await qaKSnapshot(row);
        for (const body of QA_K_BODIES) {
          const marked = await qaKPost(row.proposal.id, 'mark-sent', body);
          assert.equal(marked.status, 409, `mark-sent ${JSON.stringify(body)} on ${name}`);
          const restored = await qaKPost(row.proposal.id, 'restore', body);
          assert.equal(restored.status, 409, `restore ${JSON.stringify(body)} on ${name}`);
        }
        assert.deepEqual(await qaKSnapshot(row), before, `a refused resolve wrote ${name}`);
      }
      assert.equal(calls.length, 0);
    });

    it('QA r10: with no to_email, mark-sent is 400 on every review row and on a draft, even with the override, and writes nothing', async () => {
      for (const blank of [null, '', '   ']) {
        const rows = await qaKReviewRows(`blank${String(blank).length}`, blank);
        const draftLead = await lead();
        const draft = await insertProposal(draftLead.id, { status: 'draft', toEmail: blank });
        const all = { ...rows, draft: { prospect: draftLead, proposal: draft } };
        for (const [name, row] of Object.entries(all)) {
          const before = await qaKSnapshot(row);
          for (const body of [{}, { confirm_override: true, delivered: true }]) {
            const out = await qaKPost(row.proposal.id, 'mark-sent', body);
            assert.equal(out.status, 400, `${name} ${JSON.stringify(blank)} ${JSON.stringify(body)}`);
            assert.equal(out.body.error, MARK_SENT_ERROR);
          }
          assert.deepEqual(await qaKSnapshot(row), before, `${name} was written`);
        }
      }
    });

    it('QA r10: a plain draft still marks sent and schedules both follow-ups', async () => {
      const prospect = await lead();
      const draft = await insertProposal(prospect.id, { status: 'draft', toEmail: 'test+k-plain@example.com' });
      const out = await qaKPost(draft.id, 'mark-sent', { note: 'Called' });
      assert.equal(out.status, 200);
      const after = await fullProposal(draft.id);
      assert.equal(after.status, 'sent');
      assert.ok(after.sent_at && after.followup1_due_at && after.followup2_due_at);
    });

    it('QA r10: the old probe paths (restore then approve, override then sweep) send nothing', async () => {
      const calls = useTransport();
      const rows = await qaKReviewRows('oldprobe');
      for (const [name, row] of Object.entries(rows)) {
        const before = await qaKSnapshot(row);
        assert.equal((await qaKPost(row.proposal.id, 'restore', {})).status, 409, name);
        const approve = await qaKPost(row.proposal.id, 'send', { confirm: true });
        assert.equal(approve.status, 409, `approve on ${name}`);
        assert.equal((await qaKPost(row.proposal.id, 'mark-sent', { confirm_override: true, delivered: true })).status, 409, name);
        await sendDueFollowups();
        await sendDueFollowups();
        const afterRows = (await qaKSnapshot(row));
        if (name === 'sending') {
          // A live key younger than the stale window is left alone.
          assert.equal(afterRows.proposals[0].status, 'sending');
        } else {
          assert.deepEqual(afterRows, before, `${name} changed`);
        }
      }
      assert.equal(calls.length, 0, 'a review row was mailed');
    });

    it('QA r10: no other route resolves a review row', async () => {
      const calls = useTransport();
      const rows = await qaKReviewRows('other');
      for (const [name, row] of Object.entries(rows)) {
        if (name === 'sending') continue;
        const before = (await fullProposal(row.proposal.id));
        const patch = await fetch(`${apiBase}/api/proposals/${row.proposal.id}`, {
          method: 'PATCH', headers: { 'content-type': 'application/json', 'x-api-key': API_KEY },
          body: JSON.stringify({ subject: 'Changed', to_email: 'test+k-new@example.com' }),
        });
        assert.equal(patch.status, 409, `PATCH copy on ${name}`);
        await fetch(`${apiBase}/api/proposals/${row.proposal.id}`, {
          method: 'PATCH', headers: { 'content-type': 'application/json', 'x-api-key': API_KEY },
          body: JSON.stringify({ feedback_rating: 1 }),
        });
        for (const route of ['send', 'stop', 'replied', 'discard']) {
          await qaKPost(row.proposal.id, route, { confirm: true });
        }
        const after = await fullProposal(row.proposal.id);
        for (const col of ['status', 'stop_reason', 'sent_at', 'followup1_sent_at', 'followup1_due_at', 'send_attempt_key', 'to_email', 'subject']) {
          assert.deepEqual(after[col], before[col], `${name}.${col} changed`);
        }
      }
      assert.equal(calls.length, 0);
    });

    it('QA r10: a discarded sibling cannot be restored and sent while another version is in review', async () => {
      const calls = useTransport();
      const rows = await qaKReviewRows('sibling');
      for (const [name, row] of Object.entries(rows)) {
        if (name === 'sending') continue;
        const { rows: ins } = await pool.query(
          `INSERT INTO proposals (prospect_id, version, status, slug, to_email, to_name, subject, body, followup1, followup2)
           VALUES ($1, 0, 'discarded', $2, $3, 'Dana', 'Older note', 'Older body.', 'Checking back.', 'Last note.') RETURNING id`,
          [row.prospect.id, `k-sib-${row.proposal.id}`, row.proposal.to_email]);
        const restored = await qaKPost(ins[0].id, 'restore', {});
        const approve = restored.status === 200 ? await qaKPost(ins[0].id, 'send', {}) : null;
        assert.equal(restored.status, 409, `restore of a sibling of a ${name} row was allowed (approve then returned ${approve && approve.status})`);
      }
      assert.equal(calls.length, 0, 'a lead in review got another first email through a restored sibling');
    });

    it('QA r10: a lead in review cannot be redrafted', async () => {
      const prevKey = process.env.ANTHROPIC_API_KEY;
      process.env.ANTHROPIC_API_KEY = 'test-not-a-real-key';
      const { _setClient } = require('../src/proposals/draft');
      const { fakeClaude } = require('./fixtures');
      _setClient(fakeClaude());
      try {
        const rows = await qaKReviewRows('regen');
        const statuses = {};
        for (const [name, row] of Object.entries(rows)) {
          if (name === 'sending') continue;
          const out = await qaKPost(row.proposal.id, 'regenerate', { instructions: 'Shorter' });
          statuses[name] = out.status;
        }
        for (let i = 0; i < 100; i += 1) {
          const { rows: active } = await pool.query(`SELECT 1 FROM proposal_jobs WHERE status IN ('queued', 'running')`);
          if (!active.length) break;
          await new Promise((r) => setTimeout(r, 50));
        }
        const calls = useTransport();
        const sentAfter = {};
        for (const [name, row] of Object.entries(rows)) {
          if (name === 'sending') continue;
          const { rows: drafts } = await pool.query(
            `SELECT id FROM proposals WHERE prospect_id = $1 AND status = 'draft' ORDER BY id DESC LIMIT 1`, [row.prospect.id]);
          sentAfter[name] = drafts.length ? (await qaKPost(drafts[0].id, 'send', {})).status : 'no draft';
        }
        assert.deepEqual(statuses, { aged: 409, firstSend: 409, followUp: 409 },
          `regenerate was accepted on a lead in review; approve of the new draft without confirm returned ${JSON.stringify(sentAfter)}, ${calls.length} first emails`);
        assert.equal(calls.length, 0);
      } finally {
        _setClient(null);
        if (prevKey === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = prevKey;
      }
    });

    function rcpt(response, extra = {}) {
      return Object.assign(new Error(`Can't send mail - all recipients were rejected: ${response}`), {
        code: 'EENVELOPE', command: 'RCPT TO', response, ...extra,
      });
    }

    it('QA r10: a 5.1.8 at RCPT TO halts on the first of three leads, charges and stops nothing, and recovers', async () => {
      const leads = [];
      for (const k of ['a', 'b', 'c']) {
        leads.push(await legacySent(`test+k518-${k}@example.com`, { sentAt: new Date(Date.now() - (5 - leads.length) * 86400000) }));
      }
      for (const responseCode of [550, 553]) {
        await pool.query(`DELETE FROM app_settings WHERE key = 'followups.halted'`);
        const calls = useTransport(async () => { throw rcpt(`${responseCode} 5.1.8 Bad sender address domain`, { responseCode }); });
        await sendDueFollowups();
        await sendDueFollowups();
        assert.equal(calls.length, 2, `${responseCode}: a later lead was attempted after the halt`);
        for (const row of leads) {
          const { rows: [r] } = await pool.query(
            `SELECT status, stop_reason, followup1_sent_at, followup_argument_attempts, followup_transient_attempts,
                    first_transient_at, next_retry_at, send_attempt_key FROM proposals WHERE id = $1`, [row.proposal.id]);
          assert.equal(r.status, 'sent');
          assert.equal(r.stop_reason, null);
          assert.equal(r.followup1_sent_at, null);
          assert.equal(Number(r.followup_argument_attempts), 0, `${responseCode}: charged`);
          assert.equal(Number(r.followup_transient_attempts), 0, `${responseCode}: outage streak`);
          assert.equal(r.first_transient_at, null);
          assert.equal(r.next_retry_at, null);
          assert.equal(r.send_attempt_key, null);
        }
        const halt = (await sendReadiness()).halt;
        assert.ok(halt, `${responseCode}: no halt`);
        assert.equal(halt.error_class, 'sender');
        assert.equal(halt.cause, 'sender');
        assert.equal(Number(halt.halted_ticks), 2);
      }
      const ok = useTransport();
      await sendDueFollowups();
      assert.equal(ok.length, 3, 'recovery did not send every lead');
      for (const row of leads) assert.ok((await state(row.proposal.id)).followup1_sent_at);
      assert.equal((await sendReadiness()).halt, null, 'recovery did not clear the halt');
    });

    it('QA r10: only a leading 5.1.8 that matches the reply code halts', async () => {
      const cases = [
        ['code-less', rcpt('5.1.8 Bad sender address domain')],
        ['mid-text', rcpt('550 5.7.1 Message rejected, see 5.1.8 policy', { responseCode: 550 })],
        ['5.1.8x', rcpt('550 5.1.8x odd', { responseCode: 550 })],
        ['5.1.80', rcpt('550 5.1.80 odd', { responseCode: 550 })],
        ['code mismatch', rcpt('550 5.1.8 Bad sender address domain', { responseCode: 554 })],
        ['second line', rcpt('550-Policy note\n550 5.1.8 Bad sender address domain', { responseCode: 550 })],
        ['message only', Object.assign(new Error('Message failed: 550 5.7.1 see 5.1.8'), { responseCode: 550, command: 'RCPT TO' })],
      ];
      for (const [name, err] of cases) {
        const k = classifyFollowupError(err);
        assert.notEqual(k.label, 'sender', `${name} classified sender`);
        assert.notEqual(k.sweep, true, `${name} halts`);
      }
      for (const [name, err] of [
        ['plain', rcpt('550 5.1.8 Bad sender address domain', { responseCode: 550 })],
        ['dash', rcpt('550-5.1.8 Bad sender address domain', { responseCode: 550 })],
        ['553', rcpt('553 5.1.8 Sender domain does not exist', { responseCode: 553 })],
        ['MAIL FROM', Object.assign(rcpt('550 5.1.8 Bad sender', { responseCode: 550 }), { command: 'MAIL FROM' })],
      ]) {
        const k = classifyFollowupError(err);
        assert.equal(k.label, 'sender', `${name} did not halt`);
        assert.equal(k.sweep, true, name);
      }
    });

    it('QA r10: a quoted or prefixed 5.1.1 is not permanent, a leading one is', () => {
      const SMTPConnection = require('nodemailer/lib/smtp-connection');
      const conn = new SMTPConnection({ port: 1, host: '127.0.0.1' });
      const quoted = [
        '550 5.7.1 Relaying denied; earlier reply was 5.1.1',
        '550 Requested action not taken: 5.1.1 mailbox unavailable',
        '554 5.7.1 Message rejected (5.1.1 seen upstream)',
        '552 5.2.2 Mailbox full, not 5.1.1',
      ];
      for (const response of quoted) {
        const code = Number(response.slice(0, 3));
        for (const err of [
          rcpt(response, { responseCode: code }),
          conn._formatError('Recipient command failed', 'EENVELOPE', response, 'RCPT TO'),
          Object.assign(new Error(`Message failed: ${response}`), { responseCode: code, command: 'DATA', response }),
        ]) {
          assert.notEqual(classifyFollowupError(err).kind, 'permanent', `${response} (${err.message}) is permanent`);
        }
      }
      for (const response of ['550 5.1.1 User unknown', '550-5.1.1 The email account that you tried to reach does not exist.\n550 5.1.1 More']) {
        assert.equal(classifyFollowupError(rcpt(response, { responseCode: 550 })).kind, 'permanent', response);
      }
      conn.close();
    });

    it('QA r10: SMTP mode clears a halt only when transporter.verify() passes', async () => {
      const nodemailer = require('nodemailer');
      const origCreate = nodemailer.createTransport;
      const env = { u: process.env.GMAIL_USER, p: process.env.GMAIL_APP_PASSWORD };
      const row = await legacySent('test+k-smtp-verify@example.com');
      useTransport(() => { throw Object.assign(new Error('535 5.7.8 Username and Password not accepted'), { responseCode: 535, command: 'AUTH PLAIN' }); });
      await sendDueFollowups();
      assert.ok((await sendReadiness()).halt);
      await pool.query('UPDATE prospects SET archived_at = NOW() WHERE id = $1', [row.prospect.id]);
      _setTransport(null);
      let verifies = 0;
      let pass = false;
      nodemailer.createTransport = () => ({
        async verify() { verifies += 1; if (!pass) throw Object.assign(new Error('Invalid login'), { responseCode: 535 }); return true; },
        async sendMail() { throw new Error('no sends in this probe'); },
      });
      process.env.GMAIL_USER = 'test+smtp@example.com';
      process.env.GMAIL_APP_PASSWORD = 'not-a-real-password';
      try {
        assert.equal(await QA_K.mailMode(), 'smtp');
        await sendDueFollowups();
        assert.ok(verifies >= 1, 'the empty sweep did not call verify()');
        assert.ok((await sendReadiness()).halt, 'a failing verify cleared the halt');
        pass = true;
        const before = verifies;
        await sendDueFollowups();
        assert.ok(verifies > before, 'the clearing sweep did not call verify()');
        assert.equal((await sendReadiness()).halt, null, 'a passing verify did not clear the halt');
      } finally {
        nodemailer.createTransport = origCreate;
        if (env.u === undefined) delete process.env.GMAIL_USER; else process.env.GMAIL_USER = env.u;
        if (env.p === undefined) delete process.env.GMAIL_APP_PASSWORD; else process.env.GMAIL_APP_PASSWORD = env.p;
        _setTransport(null);
      }
    });

    it('QA r10: after a Gmail 401 a warm token cache does not clear the halt (real accessToken)', async () => {
      const axios = require('axios');
      const prevAdapter = axios.defaults.adapter;
      const prevId = process.env.GOOGLE_CLIENT_ID;
      const prevSecret = process.env.GOOGLE_CLIENT_SECRET;
      process.env.GOOGLE_CLIENT_ID = 'test-client-id';
      process.env.GOOGLE_CLIENT_SECRET = 'test-client-secret';
      let tokenCalls = 0;
      let grant = 'ok';
      let sends = 0;
      const reply = (config, status, data) => {
        if (status >= 400) {
          const err = new Error(`Request failed with status code ${status}`);
          err.response = { status, data, headers: {}, config };
          err.config = config;
          throw err;
        }
        return { data, status, statusText: 'OK', headers: {}, config };
      };
      axios.defaults.adapter = async (config) => {
        const url = String(config && config.url || '');
        if (url.includes('oauth2.googleapis.com/token')) {
          tokenCalls += 1;
          if (grant === 'revoked') return reply(config, 400, { error: 'invalid_grant' });
          return reply(config, 200, { access_token: `test-access-${tokenCalls}`, expires_in: 3600 });
        }
        if (url.includes('/messages/send')) {
          sends += 1;
          return reply(config, 401, { error: { code: 401, message: 'Request had invalid authentication credentials.', status: 'UNAUTHENTICATED' } });
        }
        return reply(config, 200, { payload: { headers: [] } });
      };
      try {
        await pool.query(
          `INSERT INTO app_settings (key, value, updated_at) VALUES ('gmail_oauth', $1::jsonb, NOW())`,
          [JSON.stringify({ refresh_token: 'test-refresh-token', email: 'test+sender@example.com' })]);
        _setTransport(null);
        assert.equal(await QA_K.mailMode(), 'gmail_api');
        const row = await legacySent('test+k-warm@example.com');
        await QA_K_GMAIL.accessToken();
        await sendDueFollowups();
        assert.equal(sends, 1);
        const halt = (await sendReadiness()).halt;
        assert.ok(halt, 'a Gmail 401 did not halt');
        assert.equal(halt.cause, 'oauth_expired');
        await pool.query('UPDATE prospects SET archived_at = NOW() WHERE id = $1', [row.prospect.id]);
        grant = 'revoked';
        const before = tokenCalls;
        await sendDueFollowups();
        assert.ok(tokenCalls > before, 'the empty sweep used the cached token');
        assert.ok((await sendReadiness()).halt, 'a warm cache cleared the halt');
        grant = 'ok';
        await pool.query(`UPDATE app_settings SET value = $1::jsonb WHERE key = 'gmail_oauth'`,
          [JSON.stringify({ refresh_token: 'test-refresh-token', email: 'test+sender@example.com' })]);
        await sendDueFollowups();
        assert.equal((await sendReadiness()).halt, null, 'a passing refresh did not clear the halt');
      } finally {
        axios.defaults.adapter = prevAdapter;
        if (prevId === undefined) delete process.env.GOOGLE_CLIENT_ID; else process.env.GOOGLE_CLIENT_ID = prevId;
        if (prevSecret === undefined) delete process.env.GOOGLE_CLIENT_SECRET; else process.env.GOOGLE_CLIENT_SECRET = prevSecret;
        _setTransport(null);
      }
    });
  
    it('QA k: restore of a discarded version with no sent_at clears the reason, and a confirmed approve clears it after send', async () => {
      const row = await legacySent('test+k-restore-plain@example.com', { sentAt: null });
      await pool.query(`UPDATE proposals SET status = 'discarded', sent_at = NULL, stop_reason = 'Lead moved to lost' WHERE id = $1`, [row.proposal.id]);
      const res = await fetch(`${apiBase}/api/proposals/${row.proposal.id}/restore`, {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': API_KEY }, body: '{}',
      });
      assert.equal(res.status, 200);
      const after = await fullProposal(row.proposal.id);
      assert.equal(after.status, 'draft');
      assert.equal(after.stop_reason, null);

      const held = await legacySent('test+k-held@example.com');
      await pool.query(`UPDATE proposals SET status = 'draft', stop_reason = 'Needs manual review: the send outcome is uncertain', sent_at = NULL,
                          followup1_due_at = NULL, followup2_due_at = NULL WHERE id = $1`, [held.proposal.id]);
      const calls = useTransport();
      const refused = await fetch(`${apiBase}/api/proposals/${held.proposal.id}/send`, {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': API_KEY }, body: '{}',
      });
      assert.equal(refused.status, 409);
      assert.equal(calls.length, 0);
      const sent = await fetch(`${apiBase}/api/proposals/${held.proposal.id}/send`, {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': API_KEY }, body: JSON.stringify({ confirm: true }),
      });
      assert.equal(sent.status, 200);
      assert.equal(calls.length, 1);
      const done = await fullProposal(held.proposal.id);
      assert.equal(done.status, 'sent');
      assert.equal(done.stop_reason, null);
    });
});


});
