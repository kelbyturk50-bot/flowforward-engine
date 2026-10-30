process.env.SEND_HOURS = '0,24';
process.env.SEND_DAYS = '0,1,2,3,4,5,6';
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
const { sendDueFollowups, _setTransport, classifyFollowupError, ARGUMENT_ATTEMPTS } = require('../src/proposals/send');
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
          'SELECT status, followup1_sent_at FROM proposals WHERE id = $1',
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
        assert.ok(row.during.followup1_sent_at, row.item.label);
        const after = await state(row.proposal.id);
        assert.equal(after.status, 'sent', row.item.label);
        assert.notEqual(after.status, 'sending', row.item.label);
        assert.equal(after.followup1_sent_at, null, row.item.label);
        assert.equal(after.followup2_sent_at, null, row.item.label);
        assert.equal(after.error, row.item.stored, row.item.label);
        assert.equal(after.stop_reason, null, row.item.label);
        assert.equal(String(after.error).includes('@'), false, row.item.label);
      }
      assert.equal(logs.sendInfo().length, 0);
      assert.equal(logs.sendError().length, shapes.length);

      fail = false;
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
          permanent: true,
          label: 'recipient',
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
        assert.equal(after.error, `Follow-up will retry: ${row.item.label}`, row.item.name);
      }
      assert.equal(logs.sendError().some((line) => line.includes('Gmail auth is not connected')), true);
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
    assert.equal(row.error, 'Follow-up will retry: smtp');
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
});
