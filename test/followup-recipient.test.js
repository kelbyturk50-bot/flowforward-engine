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
      assert.equal(logs.sendError().some((line) => line.includes('[ALERT] gmail auth halted sweep')), true);
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
    assert.equal(Number(seen[0].followup_argument_attempts), 1);
    assert.equal(seen[0].status, 'sent');
    assert.equal(Number(seen[1].followup_argument_attempts), 1);
    assert.match(seen[1].error, /will retry: server/);
    assert.equal(Number(seen[2].followup_argument_attempts), 2);
    assert.equal(Number(seen[3].followup_argument_attempts), 2);
    assert.equal(Number(seen[4].followup_argument_attempts), 3);
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
      [Object.assign(new Error('Gmail API: Invalid To header'), { status: 403 }), 'permanent', 'recipient'],
      [Object.assign(new Error('Gmail API: Invalid recipient'), { status: 403 }), 'permanent', 'recipient'],
      [smtp(451, '451 4.3.0 Try again later', 'MAIL FROM'), 'transient', 'sender'],
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

  it('manual review can be marked sent or returned to draft', async () => {
    const before = await sentToday();
    const row = await legacySent('test+resolve@example.com');
    await pool.query(
      `UPDATE proposals SET status = 'stopped', stop_reason = 'Needs manual review: the send outcome is uncertain', sent_at = NULL WHERE id = $1`,
      [row.proposal.id]
    );
    const marked = await fetch(`${apiBase}/api/proposals/${row.proposal.id}/mark-sent`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': API_KEY },
      body: JSON.stringify({ note: 'It did go out' }),
    });
    assert.equal(marked.status, 200);
    const after = await state(row.proposal.id);
    assert.equal(after.status, 'sent');
    assert.ok(after.sent_at);
    assert.ok(await sentToday() >= before + 1);
    const other = await legacySent('test+unsend@example.com');
    await pool.query(
      `UPDATE proposals SET status = 'manual_review', stop_reason = 'transient_max_age' WHERE id = $1`,
      [other.proposal.id]
    );
    const back = await fetch(`${apiBase}/api/proposals/${other.proposal.id}/restore`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': API_KEY }, body: '{}',
    });
    assert.equal(back.status, 200);
    const restored = await pool.query('SELECT status, followup_argument_attempts, stop_reason FROM proposals WHERE id = $1', [other.proposal.id]);
    assert.equal(restored.rows[0].status, 'draft');
    assert.equal(Number(restored.rows[0].followup_argument_attempts), 0);
    assert.equal(restored.rows[0].stop_reason, null);
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
});
