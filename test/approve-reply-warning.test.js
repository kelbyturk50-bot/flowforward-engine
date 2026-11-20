process.env.SEND_HOURS = '0,24';
process.env.SEND_DAYS = '0,1,2,3,4,5,6';
process.env.SEND_DAILY_LIMIT = '100';
process.env.CRM_API_KEY = 'test-approve-reply-warning-key-32ch';
if (!process.env.SENDER_ADDRESS) {
  process.env.SENDER_ADDRESS = '1 Test Street, Saratoga Springs, UT 84045';
}
delete process.env.FF_APPROVE_REPLY_WARNING;

require('./preload');

// F-009 PR A. Disposable Postgres. The mail transport is a mock.
// sendMail on that transport is the mailer call approveAndSend actually makes
// (prepareOutgoing().send()). Nothing is sent.

const http = require('http');
const express = require('express');
const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { resetDb, insertProspect, closePool, pool } = require('./fixtures');
const { applySchema } = require('../src/db/migrate');
const {
  sendDueFollowups, _setTransport, _setSendTxnGate, _resetSendTestHooks,
} = require('../src/proposals/send');

const API_KEY = process.env.CRM_API_KEY;
const FLAG = 'FF_APPROVE_REPLY_WARNING';
const SECRET_SUBJECT = 'SIBLING-REPLY-SUBJECT-NOT-IN-BODY';
const CONFIRM_REASON = 'Confirm before sending again';

let n = 0;
let server;
let apiBase;

function useTransport() {
  const calls = [];
  _setTransport({
    async sendMail(mail) {
      calls.push(mail);
      return { messageId: `<m${calls.length}@localhost>`, threadId: `thr-${calls.length}` };
    },
  });
  return calls;
}

async function lead(overrides = {}) {
  n += 1;
  return insertProspect({
    google_place_id: `test-place-approve-reply-${n}`,
    company: `TEST: Reply Warning ${n}`,
    industry: 'HVAC',
    website: null,
    email: `test+reply${n}@example.com`,
    contact_name: 'Dana',
    stage: overrides.stage || 'found',
  });
}

async function insertProposal(prospectId, fields = {}) {
  n += 1;
  const status = fields.status || 'draft';
  const slug = `approve-reply-${prospectId}-${n}`;
  const { rows } = await pool.query(
    `INSERT INTO proposals (
       prospect_id, version, status, slug, to_email, to_name, subject, body, followup1, followup2,
       stop_reason
     ) VALUES (
       $1, $2, $3, $4, $5, 'Dana', $6, $7, 'Checking back.', 'Last note.',
       $8
     ) RETURNING id, status, replied_at, subject`,
    [
      prospectId,
      fields.version || 1,
      status,
      slug,
      fields.toEmail || `test+approve${n}@example.com`,
      fields.subject || 'A note',
      fields.body || 'Hello from the draft.',
      fields.stopReason === undefined ? null : fields.stopReason,
    ]
  );
  return rows[0];
}

const REPLY_INTERVALS = {
  '59 days': `NOW() - INTERVAL '59 days'`,
  '61 days': `NOW() - INTERVAL '61 days'`,
  '1 day': `NOW() - INTERVAL '1 day'`,
};

async function setRepliedAt(id, which) {
  const expr = REPLY_INTERVALS[which];
  if (!expr) throw new Error(`bad interval ${which}`);
  const { rows } = await pool.query(
    `UPDATE proposals SET replied_at = ${expr} WHERE id = $1 RETURNING replied_at`,
    [id]
  );
  return rows[0].replied_at;
}

async function setFlag(enabled) {
  const { rowCount } = await pool.query(
    `UPDATE feature_flags
        SET enabled = $2, updated_at = NULL, updated_by = NULL
      WHERE name = $1`,
    [FLAG, enabled]
  );
  if (rowCount !== 1) throw new Error(`${FLAG} row missing`);
}

function setEnv(value) {
  if (value === undefined) delete process.env[FLAG];
  else process.env[FLAG] = value;
}

async function postSend(id, body) {
  const res = await fetch(`${apiBase}/api/proposals/${id}/send`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': API_KEY },
    body: JSON.stringify(body == null ? {} : body),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { json = null; }
  return { status: res.status, json, text };
}

async function getFlags() {
  const res = await fetch(`${apiBase}/api/flags`, {
    headers: { 'x-api-key': API_KEY },
  });
  const json = await res.json();
  return { status: res.status, json };
}

async function draftRow(id) {
  const { rows } = await pool.query(
    `SELECT status, approved_at, send_attempt_key, send_attempted_at, sent_at, stop_reason,
            error, replied_at, followup1_due_at, followup1_sent_at, followup2_due_at, followup2_sent_at
       FROM proposals WHERE id = $1`,
    [id]
  );
  return JSON.parse(JSON.stringify(rows[0]));
}

async function prospectStage(id) {
  const { rows } = await pool.query(
    'SELECT stage, last_contacted_at FROM prospects WHERE id = $1',
    [id]
  );
  return rows[0];
}

async function activityCount(prospectId) {
  const { rows } = await pool.query(
    'SELECT COUNT(*)::int AS n FROM prospect_activities WHERE prospect_id = $1',
    [prospectId]
  );
  return rows[0].n;
}

function assertRecentReply(body, siblingId, repliedAt) {
  assert.deepEqual(Object.keys(body).sort(), ['error', 'replied_at', 'sibling_proposal_id']);
  assert.equal(body.error, 'recent_reply');
  assert.equal(body.sibling_proposal_id, siblingId);
  assert.equal(typeof body.sibling_proposal_id, 'number');
  assert.equal(body.replied_at, new Date(repliedAt).toISOString());
  assert.equal(typeof body.replied_at, 'string');
  assert.equal(JSON.stringify(body).includes(SECRET_SUBJECT), false);
}

async function pair({ replied, stopReason, stage, ownReplied } = {}) {
  const prospect = await lead({ stage });
  const sibling = await insertProposal(prospect.id, {
    status: 'replied',
    version: 1,
    subject: SECRET_SUBJECT,
    body: 'The earlier reply text must not leave the server.',
    toEmail: `test+sibling${n}@example.com`,
  });
  if (replied) await setRepliedAt(sibling.id, replied);
  else if (replied === null) {
    // explicit null, already the insert default
  }
  const draft = await insertProposal(prospect.id, {
    status: 'draft',
    version: 2,
    stopReason,
    toEmail: `test+draft${n}@example.com`,
  });
  if (ownReplied) await setRepliedAt(draft.id, ownReplied);
  const siblingRow = await pool.query('SELECT id, replied_at FROM proposals WHERE id = $1', [sibling.id]);
  return { prospect, sibling: siblingRow.rows[0], draft };
}

describe('F-009 approve reply warning', { concurrency: false }, () => {
  before(async () => {
    await applySchema();
    const app = express();
    const flagsApi = require('../src/api/flags');
    app.use(express.json());
    app.use('/api/flags', flagsApi.requireFlagApiKey);
    app.use('/api', require('../src/api/auth'));
    app.use('/api/flags', flagsApi);
    app.use('/api/proposals', require('../src/api/proposals'));
    server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    apiBase = `http://127.0.0.1:${server.address().port}`;
  });

  beforeEach(async () => {
    await resetDb();
    await setFlag(false);
    setEnv(undefined);
    _resetSendTestHooks();
    useTransport();
  });

  after(async () => {
    setEnv(undefined);
    try { await setFlag(false); } catch { /* schema already gone */ }
    try {
      await pool.query('DELETE FROM feature_flag_audit WHERE flag = $1', [FLAG]);
    } catch { /* table already gone */ }
    _setTransport(null);
    _resetSendTestHooks();
    if (server) await new Promise((resolve) => server.close(resolve));
    await closePool();
  });

  it('AC5 flag off: a sibling replied 59 days ago still sends once and the draft becomes sent', async () => {
    const { prospect, draft } = await pair({ replied: '59 days' });
    const calls = useTransport();
    const before = await draftRow(draft.id);
    const res = await postSend(draft.id, {});
    assert.equal(res.status, 200, res.text);
    assert.equal(res.json.status, 'sent');
    assert.equal(res.json.error, null);
    assert.equal(res.json.sibling_proposal_id, undefined);
    assert.equal(calls.length, 1);
    const after = await draftRow(draft.id);
    assert.equal(after.status, 'sent');
    assert.notEqual(after.status, before.status);
    const stage = await prospectStage(prospect.id);
    assert.equal(stage.stage, 'contacted');
    assert.ok(stage.last_contacted_at);
    console.log('[approve-reply-warning] flag off: status=200 mailer_calls=1 proposal=sent stage=contacted');
  });

  it('AC5 flag on: a sibling replied 59 days ago is 409, the mailer is not called, and the draft stays a draft', async () => {
    await setFlag(true);
    const { prospect, sibling, draft } = await pair({ replied: '59 days' });
    const calls = useTransport();
    const before = await draftRow(draft.id);
    const activities = await activityCount(prospect.id);
    const stageBefore = await prospectStage(prospect.id);
    const res = await postSend(draft.id, {});
    assert.equal(res.status, 409);
    assertRecentReply(res.json, sibling.id, sibling.replied_at);
    assert.equal(calls.length, 0);
    assert.deepEqual(await draftRow(draft.id), before);
    assert.equal(await activityCount(prospect.id), activities);
    const stageAfter = await prospectStage(prospect.id);
    assert.equal(stageAfter.stage, stageBefore.stage);
    assert.equal(stageAfter.last_contacted_at, stageBefore.last_contacted_at);
    console.log(`[approve-reply-warning] flag on 59d: status=409 error=recent_reply sibling=${res.json.sibling_proposal_id} mailer_calls=0 proposal=draft`);
  });

  it('AC5 flag on: acknowledge_recent_reply true sends that same 59-day case exactly once', async () => {
    await setFlag(true);
    const { prospect, draft } = await pair({ replied: '59 days' });
    const calls = useTransport();
    const res = await postSend(draft.id, { acknowledge_recent_reply: true });
    assert.equal(res.status, 200, res.text);
    assert.equal(res.json.status, 'sent');
    assert.equal(calls.length, 1);
    assert.equal((await draftRow(draft.id)).status, 'sent');
    assert.equal((await prospectStage(prospect.id)).stage, 'contacted');
    console.log('[approve-reply-warning] acknowledged 59d: status=200 mailer_calls=1 proposal=sent');
  });

  it('AC5 flag on: a sibling replied 61 days ago sends once with no warning', async () => {
    await setFlag(true);
    const { draft } = await pair({ replied: '61 days' });
    const calls = useTransport();
    const res = await postSend(draft.id, {});
    assert.equal(res.status, 200, res.text);
    assert.equal(res.json.status, 'sent');
    assert.equal(calls.length, 1);
    assert.equal((await draftRow(draft.id)).status, 'sent');
    console.log('[approve-reply-warning] flag on 61d: status=200 mailer_calls=1 no warning');
  });

  it('AC5 flag on: a sibling with no replied_at sends once, and another lead\'s recent reply does not warn', async () => {
    await setFlag(true);
    const { draft } = await pair({ replied: null });
    const other = await lead();
    const otherReply = await insertProposal(other.id, {
      status: 'replied',
      version: 1,
      subject: SECRET_SUBJECT,
    });
    await setRepliedAt(otherReply.id, '1 day');
    const calls = useTransport();
    const res = await postSend(draft.id, {});
    assert.equal(res.status, 200, res.text);
    assert.equal(calls.length, 1);
    assert.equal((await draftRow(draft.id)).status, 'sent');
    console.log('[approve-reply-warning] flag on null replied_at: status=200 mailer_calls=1');
  });

  it('AC5 flag on: the proposal\'s own replied_at does not warn', async () => {
    await setFlag(true);
    const { draft } = await pair({ replied: null, ownReplied: '1 day' });
    const calls = useTransport();
    const res = await postSend(draft.id, {});
    assert.equal(res.status, 200, res.text);
    assert.equal(calls.length, 1);
    assert.equal((await draftRow(draft.id)).status, 'sent');
    const stored = await pool.query('SELECT replied_at FROM proposals WHERE id = $1', [draft.id]);
    assert.ok(stored.rows[0].replied_at);
    console.log('[approve-reply-warning] own replied_at: status=200 mailer_calls=1');
  });

  it('AC5 confirm true alone does not bypass the warning, and a string acknowledgement does not either', async () => {
    await setFlag(true);
    const first = await pair({ replied: '59 days' });
    let calls = useTransport();
    let res = await postSend(first.draft.id, { confirm: true });
    assert.equal(res.status, 409);
    assertRecentReply(res.json, first.sibling.id, first.sibling.replied_at);
    assert.equal(calls.length, 0);
    assert.equal((await draftRow(first.draft.id)).status, 'draft');

    const second = await pair({ replied: '59 days' });
    calls = useTransport();
    res = await postSend(second.draft.id, { acknowledge_recent_reply: 'true' });
    assert.equal(res.status, 409);
    assertRecentReply(res.json, second.sibling.id, second.sibling.replied_at);
    assert.equal(calls.length, 0);
    assert.equal((await draftRow(second.draft.id)).status, 'draft');
    console.log('[approve-reply-warning] confirm alone and string ack: status=409 mailer_calls=0');
  });

  it('AC5 acknowledge_recent_reply alone does not bypass the held-back confirm check', async () => {
    await setFlag(true);
    const { draft } = await pair({ replied: '59 days', stopReason: CONFIRM_REASON });
    const calls = useTransport();
    const before = await draftRow(draft.id);
    const res = await postSend(draft.id, { acknowledge_recent_reply: true });
    assert.equal(res.status, 409);
    assert.deepEqual(res.json, { error: 'Confirm this send before it goes out again.' });
    assert.equal(calls.length, 0);
    assert.deepEqual(await draftRow(draft.id), before);
    assert.equal(before.stop_reason, CONFIRM_REASON);
    console.log('[approve-reply-warning] ack without confirm: status=409 held-back message mailer_calls=0');
  });

  it('both acknowledgements send a held-back draft that also has a recent sibling reply exactly once', async () => {
    await setFlag(true);
    const { draft } = await pair({ replied: '59 days', stopReason: CONFIRM_REASON });
    const calls = useTransport();
    const res = await postSend(draft.id, { confirm: true, acknowledge_recent_reply: true });
    assert.equal(res.status, 200, res.text);
    assert.equal(calls.length, 1);
    const after = await draftRow(draft.id);
    assert.equal(after.status, 'sent');
    assert.equal(after.stop_reason, null);
    console.log('[approve-reply-warning] confirm and ack together: status=200 mailer_calls=1');
  });

  it('AC5 waiver: a disqualified or responded lead approve sends the first email once, and follow-ups stop', async () => {
    await setFlag(true);
    for (const stage of ['disqualified', 'responded']) {
      const prospect = await lead({ stage });
      const draft = await insertProposal(prospect.id, {
        status: 'draft',
        version: 1,
        toEmail: `test+waiver${n}@example.com`,
      });
      const calls = useTransport();
      const res = await postSend(draft.id, {});
      assert.equal(res.status, 200, `${stage}: ${res.text}`);
      assert.equal(calls.length, 1, stage);
      assert.equal((await draftRow(draft.id)).status, 'sent', stage);
      assert.equal((await prospectStage(prospect.id)).stage, stage, stage);
      await pool.query(
        `UPDATE proposals SET followup1_due_at = NOW() - INTERVAL '1 minute' WHERE id = $1`,
        [draft.id]
      );
      const follow = await sendDueFollowups();
      assert.equal(calls.length, 1, `${stage} follow-up`);
      assert.equal(follow.sent, 0, stage);
      const after = await draftRow(draft.id);
      assert.equal(after.status, 'stopped', stage);
      assert.equal(after.stop_reason, `Lead moved to ${stage}`, stage);
      assert.equal(after.followup1_sent_at, null, stage);
      console.log(`[approve-reply-warning] waiver ${stage}: first send mailer_calls=1 follow-up mailer_calls=0 status=stopped`);
    }
  });

  it('flag on does not block a follow-up when a sibling replied 59 days ago', async () => {
    await setFlag(true);
    const prospect = await lead({ stage: 'contacted' });
    const sibling = await insertProposal(prospect.id, { status: 'replied', version: 1, subject: SECRET_SUBJECT });
    await setRepliedAt(sibling.id, '59 days');
    const sent = await insertProposal(prospect.id, {
      status: 'sent',
      version: 2,
      toEmail: `test+follow${n}@example.com`,
    });
    await pool.query(
      `UPDATE proposals
          SET sent_at = NOW() - INTERVAL '4 days',
              followup1_due_at = NOW() - INTERVAL '1 minute',
              followup2_due_at = NOW() + INTERVAL '10 days'
        WHERE id = $1`,
      [sent.id]
    );
    const calls = useTransport();
    const result = await sendDueFollowups();
    assert.equal(calls.length, 1);
    assert.equal(result.sent, 1);
    const after = await draftRow(sent.id);
    assert.equal(after.status, 'sent');
    assert.ok(after.followup1_sent_at);
    console.log('[approve-reply-warning] follow-up path: mailer_calls=1 status=sent');
  });

  it('a reply written after the prospect lock and before the claim still refuses, and nothing is claimed', async () => {
    await setFlag(true);
    const prospect = await lead();
    const sibling = await insertProposal(prospect.id, {
      status: 'replied',
      version: 1,
      subject: SECRET_SUBJECT,
    });
    const draft = await insertProposal(prospect.id, {
      status: 'draft',
      version: 2,
      toEmail: `test+lock${n}@example.com`,
    });
    const calls = useTransport();
    _setSendTxnGate(async () => {
      const mid = await pool.query(
        'SELECT status, send_attempt_key FROM proposals WHERE id = $1',
        [draft.id]
      );
      assert.equal(mid.rows[0].status, 'draft');
      assert.equal(mid.rows[0].send_attempt_key, null);
      await pool.query(
        `UPDATE proposals SET replied_at = NOW() - INTERVAL '1 day' WHERE id = $1`,
        [sibling.id]
      );
    });
    const before = await draftRow(draft.id);
    const res = await postSend(draft.id, {});
    assert.equal(res.status, 409);
    assert.equal(res.json.error, 'recent_reply');
    assert.equal(res.json.sibling_proposal_id, sibling.id);
    assert.equal(calls.length, 0);
    assert.deepEqual(await draftRow(draft.id), before);
    const stage = await prospectStage(prospect.id);
    assert.equal(stage.stage, 'found');
    assert.equal(stage.last_contacted_at, null);
    console.log('[approve-reply-warning] post-lock reply: status=409 mailer_calls=0 claim not written');
  });

  it('env force-off wins over a database on, and env true cannot force the flag on', async () => {
    const { draft: offDraft } = await pair({ replied: '59 days' });
    await setFlag(false);
    setEnv('true');
    let calls = useTransport();
    let res = await postSend(offDraft.id, {});
    assert.equal(res.status, 200, res.text);
    assert.equal(calls.length, 1);
    assert.equal((await draftRow(offDraft.id)).status, 'sent');

    for (const value of ['false', 'off', '0', 'no']) {
      const { draft } = await pair({ replied: '59 days' });
      await setFlag(true);
      setEnv(value);
      calls = useTransport();
      res = await postSend(draft.id, {});
      assert.equal(res.status, 200, `${value}: ${res.text}`);
      assert.equal(calls.length, 1, value);
      assert.equal((await draftRow(draft.id)).status, 'sent', value);
    }

    const { sibling, draft } = await pair({ replied: '59 days' });
    await setFlag(true);
    setEnv(undefined);
    calls = useTransport();
    res = await postSend(draft.id, {});
    assert.equal(res.status, 409);
    assertRecentReply(res.json, sibling.id, sibling.replied_at);
    assert.equal(calls.length, 0);
    console.log('[approve-reply-warning] env true with db off sends; env false/off/0/no with db on sends; db on with env unset is 409');
  });

  it('GET /api/flags lists FF_APPROVE_REPLY_WARNING as a database flag seeded off', async () => {
    setEnv(undefined);
    await setFlag(false);
    let listed = await getFlags();
    assert.equal(listed.status, 200);
    let flag = listed.json.flags.find((row) => row.name === FLAG);
    assert.ok(flag);
    assert.equal(flag.enabled, false);
    assert.equal(flag.effective, false);
    assert.equal(flag.env_forced_off, false);
    assert.equal(flag.writable, true);
    assert.equal(flag.source, 'db');
    const names = listed.json.flags.map((row) => row.name);
    assert.equal(names[names.indexOf(FLAG) + 1], 'FF_CALL_LIST');
    assert.equal(names[names.length - 1], 'FF_CALL_LIST');

    await setFlag(true);
    setEnv('false');
    listed = await getFlags();
    flag = listed.json.flags.find((row) => row.name === FLAG);
    assert.equal(flag.enabled, true);
    assert.equal(flag.effective, false);
    assert.equal(flag.env_forced_off, true);
    assert.equal(flag.writable, true);
    assert.equal(flag.source, 'db');

    await setFlag(false);
    setEnv('true');
    listed = await getFlags();
    flag = listed.json.flags.find((row) => row.name === FLAG);
    assert.equal(flag.enabled, false);
    assert.equal(flag.effective, false);
    assert.equal(flag.env_forced_off, false);
    console.log('[approve-reply-warning] GET /api/flags: writable=true source=db seeded off; env false forces effective off');
  });
});
