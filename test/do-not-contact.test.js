process.env.CRM_API_KEY = 'test-dnc-manual-flag-key-32chars!!';

require('./preload');

// Manual do-not-contact flag. Disposable Postgres, mock mail transport.
// Fixture companies start with [TEST]. No send, no discovery, no live inbox.

const fs = require('fs');
const http = require('http');
const path = require('path');
const { spawn } = require('child_process');
const express = require('express');
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const send = require('../src/proposals/send');
const inbox = require('../src/proposals/inbox');
const prospectsApi = require('../src/api/prospects');
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

// Swap pool.query for one test. original is the real method.
async function withPoolQuery(fn, run) {
  const original = pool.query.bind(pool);
  pool.query = function (sql, params) {
    const text = typeof sql === 'string' ? sql : '';
    return fn(text, params, original);
  };
  try {
    return await run();
  } finally {
    pool.query = original;
  }
}

async function drainInbox() {
  await new Promise((resolve) => setImmediate(resolve));
  for (let i = 0; i < 50 && inbox.isWorking(); i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe('manual do-not-contact', () => {
  before(async () => {
    await resetDb();
    send._setTransport(recordingTransport());
    const app = express();
    app.use(express.json());
    app.use('/api', require('../src/api/auth'));
    app.use('/api/prospects', require('../src/api/prospects'));
    server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = server.address();
  });

  after(async () => {
    send._setLeadStop(null);
    send._setOptOutGate(null);
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
    const kept = await lead('Schema Keep Manual');
    await setSource(kept.id, 'manual', true);
    await applyMainSchema();
    await applyMainSchema();

    const bouncedAfter = await flagRow(bounced.id);
    assert.equal(bouncedAfter.do_not_contact, false);
    assert.equal(bouncedAfter.do_not_contact_source, null);
    const keptAfter = await flagRow(kept.id);
    assert.equal(keptAfter.do_not_contact, true);
    assert.equal(keptAfter.do_not_contact_source, 'manual');
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

  it('does not claim a draft when the lead is flagged between the check and the claim', async () => {
    const row = await lead('Claim Race', 'qualified');
    const draft = await proposal(row.id, 'draft', `dnc-claim-race-${row.id}`);
    const before = sentMails.length;
    let claims = 0;
    await withPoolQuery(async (text, params, original) => {
      if (text.includes("UPDATE proposals SET status = 'sending'") && text.includes('NOT (SELECT do_not_contact')) {
        claims += 1;
        await original('UPDATE prospects SET do_not_contact = TRUE WHERE id = $1', [row.id]);
      }
      return original(text, params);
    }, () => assert.rejects(
      () => send.approveAndSend(draft.id),
      (err) => err.status === 409
    ));
    assert.equal(claims, 1);
    const stored = await pool.query('SELECT status, approved_at FROM proposals WHERE id = $1', [draft.id]);
    assert.equal(stored.rows[0].status, 'draft');
    assert.equal(stored.rows[0].approved_at, null);
    assert.equal(sentMails.length, before);
    console.log('[dnc] claim UPDATE skips a flagged lead');
  });

  it('stops a claimed draft and does not send when the lead is flagged before the mailer', async () => {
    const row = await lead('Recheck First', 'qualified');
    const draft = await proposal(row.id, 'draft', `dnc-recheck-first-${row.id}`);
    const before = sentMails.length;
    let claimed = false;
    let flipped = 0;
    await withPoolQuery(async (text, params, original) => {
      if (claimed && text === 'SELECT do_not_contact FROM prospects WHERE id = $1') {
        flipped += 1;
        claimed = false;
        await original('UPDATE prospects SET do_not_contact = TRUE WHERE id = $1', [row.id]);
      }
      const result = await original(text, params);
      if (text.includes("UPDATE proposals SET status = 'sending'") && result.rows.length) claimed = true;
      return result;
    }, () => assert.rejects(
      () => send.approveAndSend(draft.id),
      (err) => err.status === 409 && /do-not-contact/.test(err.message)
    ));
    assert.equal(flipped, 1);
    const stored = await pool.query(
      'SELECT status, stop_reason FROM proposals WHERE id = $1',
      [draft.id]
    );
    assert.equal(stored.rows[0].status, 'stopped');
    assert.equal(stored.rows[0].stop_reason, 'Lead is do-not-contact');
    assert.equal(sentMails.length, before);
    console.log('[dnc] pre-mailer recheck stops the first send');
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

  it('does not claim a follow-up when the lead is flagged between the check and the claim', async () => {
    const restore = widenSendWindow();
    try {
      const row = await lead('Follow Claim', 'contacted');
      const due = await dueFollowup(row.id, `dnc-follow-claim-${row.id}`);
      const before = sentMails.length;
      let claims = 0;
      await withPoolQuery(async (text, params, original) => {
        if (text.includes('UPDATE proposals SET followup1_sent_at = NOW()')
            && text.includes('NOT (SELECT do_not_contact')
            && params && params[0] === due.id) {
          claims += 1;
          await original('UPDATE prospects SET do_not_contact = TRUE WHERE id = $1', [row.id]);
        }
        return original(text, params);
      }, () => send.sendDueFollowups());
      assert.equal(claims, 1);
      const stored = await pool.query(
        'SELECT status, followup1_sent_at FROM proposals WHERE id = $1',
        [due.id]
      );
      assert.equal(stored.rows[0].status, 'sent');
      assert.equal(stored.rows[0].followup1_sent_at, null);
      assert.equal(sentMails.length, before);
      console.log('[dnc] follow-up claim UPDATE skips a flagged lead');
    } finally {
      restore();
    }
  });

  it('stops a claimed follow-up and does not send when the lead is flagged before the mailer', async () => {
    const restore = widenSendWindow();
    try {
      const row = await lead('Follow Recheck', 'contacted');
      const due = await dueFollowup(row.id, `dnc-follow-recheck-${row.id}`);
      const before = sentMails.length;
      const countedBefore = await send.sentToday();
      let claimedId = null;
      let flipped = 0;
      await withPoolQuery(async (text, params, original) => {
        if (claimedId === due.id
            && text === 'SELECT do_not_contact FROM prospects WHERE id = $1'
            && params && params[0] === row.id) {
          flipped += 1;
          claimedId = null;
          await original('UPDATE prospects SET do_not_contact = TRUE WHERE id = $1', [row.id]);
        }
        const result = await original(text, params);
        if (text.includes('UPDATE proposals SET followup1_sent_at = NOW()')
            && text.includes('NOT (SELECT do_not_contact')
            && result.rows.length) {
          claimedId = params[0];
        }
        return result;
      }, () => send.sendDueFollowups());
      assert.equal(flipped, 1);
      const stored = await pool.query(
        'SELECT status, stop_reason, followup1_sent_at FROM proposals WHERE id = $1',
        [due.id]
      );
      assert.equal(stored.rows[0].status, 'stopped');
      assert.equal(stored.rows[0].stop_reason, 'Lead is do-not-contact');
      assert.equal(stored.rows[0].followup1_sent_at, null);
      assert.equal(sentMails.length, before);
      assert.equal(await send.sentToday(), countedBefore);
      console.log('[dnc] pre-mailer recheck stops the follow-up');
    } finally {
      restore();
    }
  });

  it('leaves a proposal stopped when the send finishes or fails after the stop', async () => {
    const row = await lead('Mid Send', 'qualified');
    const stageBefore = row.stage;
    const draft = await proposal(row.id, 'draft', `dnc-mid-send-${row.id}`);
    await pool.query(`UPDATE proposals SET sent_at = NULL WHERE id = $1`, [draft.id]);
    send._setTransport({
      async sendMail() {
        await pool.query(
          `UPDATE proposals SET status = 'stopped', stop_reason = 'Lead is do-not-contact' WHERE id = $1`,
          [draft.id]
        );
        return { messageId: '<dnc-mid@localhost>', threadId: 'thr-mid' };
      },
    });
    try {
      await assert.rejects(
        () => send.approveAndSend(draft.id),
        (err) => err.status === 409
      );
      const stored = await pool.query(
        'SELECT status, sent_at FROM proposals WHERE id = $1',
        [draft.id]
      );
      assert.equal(stored.rows[0].status, 'stopped');
      assert.equal(stored.rows[0].sent_at, null);
      assert.equal((await flagRow(row.id)).stage, stageBefore);
    } finally {
      send._setTransport(recordingTransport());
    }

    const failed = await proposal(row.id, 'draft', `dnc-mid-fail-${row.id}`, 2);
    await pool.query(`UPDATE proposals SET sent_at = NULL WHERE id = $1`, [failed.id]);
    send._setTransport({
      async sendMail() {
        await pool.query(
          `UPDATE proposals SET status = 'stopped', stop_reason = 'Lead is do-not-contact' WHERE id = $1`,
          [failed.id]
        );
        throw new Error('smtp down');
      },
    });
    try {
      await assert.rejects(
        () => send.approveAndSend(failed.id),
        (err) => err.status === 502
      );
      const stored = await pool.query('SELECT status FROM proposals WHERE id = $1', [failed.id]);
      assert.equal(stored.rows[0].status, 'stopped');
    } finally {
      send._setTransport(recordingTransport());
    }
    console.log('[dnc] a stop during send is not reverted to sent or draft');
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
});
