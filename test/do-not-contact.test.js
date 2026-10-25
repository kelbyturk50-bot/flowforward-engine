process.env.CRM_API_KEY = 'test-dnc-manual-flag-key-32chars!!';

require('./preload');

// Manual do-not-contact flag. Disposable Postgres, mock mail transport.
// Fixture companies start with [TEST]. No send, no discovery, no live inbox.

const fs = require('fs');
const http = require('http');
const path = require('path');
const express = require('express');
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const send = require('../src/proposals/send');
const inbox = require('../src/proposals/inbox');
const { applyMainSchema } = require('../src/db/migrate');
const { resetDb, insertProspect, closePool, pool } = require('./fixtures');

const API_KEY = process.env.CRM_API_KEY;
const MARKED = 'Marked do-not-contact (manual)';
const CLEARED = 'Cleared do-not-contact';

const sentMails = [];
let server;
let base;
let seq = 0;

function request(method, reqPath, { key, body } = {}) {
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
      port: base.port,
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

function postFlag(id, body, key = API_KEY) {
  return request('POST', `/api/prospects/${id}/do-not-contact`, { key, body });
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

async function drainInbox() {
  await new Promise((resolve) => setImmediate(resolve));
  for (let i = 0; i < 50 && inbox.isWorking(); i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe('manual do-not-contact', () => {
  before(async () => {
    await resetDb();
    send._setTransport({
      async sendMail(mail) {
        sentMails.push(mail);
        return { messageId: `<dnc-${sentMails.length}@localhost>`, threadId: 'thr-dnc' };
      },
    });
    const app = express();
    app.use(express.json());
    app.use('/api', require('../src/api/auth'));
    app.use('/api/prospects', require('../src/api/prospects'));
    server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = server.address();
  });

  after(async () => {
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
    const after = await flagRow(row.id);
    assert.equal(after.do_not_contact, false);
    assert.equal(after.do_not_contact_source, null);
    assert.equal((await activityBodies(row.id)).length, 0);
    console.log('[dnc] 401 without a key');
  });

  it('returns 400 unless value is a strict boolean', async () => {
    const row = await lead('Bad Value');
    const cases = [
      ['string true', { value: 'true' }],
      ['number', { value: 1 }],
      ['null', { value: null }],
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
    console.log('[dnc] 400 for string true, number 1, and null');
  });

  it('returns 400 for a non-numeric id and 404 for an unknown prospect', async () => {
    for (const id of ['abc', '1.5', '12abc']) {
      const res = await postFlag(id, { value: true });
      assert.equal(res.status, 400, id);
      assert.equal(res.json.error, 'invalid_id', id);
      assert.match(res.headers['content-type'], /application\/json/);
    }
    const missing = await postFlag(2147483647, { value: true });
    assert.equal(missing.status, 404);
    assert.equal(missing.json.error, 'Not found');
    assert.match(missing.headers['content-type'], /application\/json/);
    console.log('[dnc] 400 non-numeric id; 404 unknown prospect');
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

  it('keeps an opt-out or bounce source when value is true and writes nothing', async () => {
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
    const optProposal = await pool.query('SELECT status FROM proposals WHERE id = $1', [stillSent.id]);
    assert.equal(optProposal.rows[0].status, 'sent');

    const bounced = await lead('Keep Bounce', 'contacted');
    await setSource(bounced.id, 'bounce', true);
    const bounceRes = await postFlag(bounced.id, { value: true });
    assert.equal(bounceRes.status, 200);
    assert.equal(bounceRes.json.do_not_contact_source, 'bounce');
    assert.equal((await activityBodies(bounced.id)).length, 0);

    const automatic = await lead('Keep Null', 'found');
    await setSource(automatic.id, null, true);
    const nullRes = await postFlag(automatic.id, { value: true });
    assert.equal(nullRes.status, 200);
    assert.equal(nullRes.json.do_not_contact, true);
    assert.equal(nullRes.json.do_not_contact_source, null);
    assert.equal((await activityBodies(automatic.id)).length, 0);
    console.log('[dnc] true on opt_out, bounce, and NULL keeps the source');
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

  it('returns 409 when clearing opt_out, bounce, or a NULL source', async () => {
    const cases = [
      ['opt_out', 'opt_out'],
      ['bounce', 'bounce'],
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
    console.log('[dnc] 409 on opt_out, bounce, and NULL source');
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

  it('records opt_out on both opt-out writes and bounce on the bounce write', async () => {
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
    assert.equal(bounceRow.do_not_contact_source, 'bounce');
    assert.equal(bounceRow.email, null);
    assert.equal(bounceRow.stage, beforeStage);
    assert.equal(bounceRow.do_not_contact, false);
    const bounceStatus = await pool.query('SELECT status FROM proposals WHERE id = $1', [bounceProposal.id]);
    assert.equal(bounceStatus.rows[0].status, 'bounced');
    assert.equal(sentMails.length, 0);
    console.log('[dnc] opt-out source opt_out; follow-on opt_out; bounce source bounce');
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
    assert.match(block, /conname = 'prospects_do_not_contact_source_check'/);
    assert.match(block, /t\.relname = 'prospects'/);
    assert.match(block, /do_not_contact_source IN \('manual', 'opt_out', 'bounce'\)/);
    assert.equal(block.includes('UPDATE'), false);

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

    const constraint = await pool.query(
      `SELECT c.conname
         FROM pg_constraint c
         JOIN pg_class t ON t.oid = c.conrelid
         JOIN pg_namespace n ON n.oid = t.relnamespace
        WHERE c.conname = 'prospects_do_not_contact_source_check'
          AND t.relname = 'prospects'
          AND n.nspname = 'public'`
    );
    assert.equal(constraint.rows.length, 1);

    for (const source of ['manual', 'opt_out', 'bounce', null]) {
      await pool.query(
        `UPDATE prospects SET do_not_contact_source = $2 WHERE id = $1`,
        [row.id, source]
      );
    }
    await assert.rejects(
      pool.query(`UPDATE prospects SET do_not_contact_source = 'other' WHERE id = $1`, [row.id]),
      (err) => err.code === '23514'
    );
    const still = await flagRow(row.id);
    assert.equal(still.do_not_contact_source, null);
    console.log('[dnc] schema.sql applied twice; NULL source not backfilled');
  });
});
