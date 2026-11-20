process.env.SEND_HOURS = '0,24';
process.env.SEND_DAYS = '0,1,2,3,4,5,6';
process.env.SEND_DAILY_LIMIT = '100';
process.env.CRM_API_KEY = 'test-call-list-key-32chars-minimum';
if (!process.env.SENDER_ADDRESS) {
  process.env.SENDER_ADDRESS = '1 Test Street, Saratoga Springs, UT 84045';
}
delete process.env.FF_CALL_LIST;
delete process.env.FF_DEMO_VIEW_TASK;
delete process.env.FF_PROSPECT_VIEWS;

require('./preload');

// F-010 PR A. Disposable Postgres. Mocks only. The suite asserts the mailer,
// the Gmail transport, the Anthropic client, and Places search are never called.

const fs = require('fs');
const http = require('http');
const path = require('path');
const express = require('express');
const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { resetDb, insertProspect, closePool, pool } = require('./fixtures');
const { applySchema } = require('../src/db/migrate');
const { sendDueFollowups, _setTransport } = require('../src/proposals/send');
const { _setApiForTests } = require('../src/proposals/gmail');
const { _setClient } = require('../src/proposals/draft');
const { _setSearch } = require('../src/bot/google-places');
const {
  denverYmd, instantInDenver, weekdayIndex, _setClockForTests,
} = require('../src/call-list/clock');
const copy = require('../src/call-list/copy');

const API_KEY = process.env.CRM_API_KEY;
const FLAG = 'FF_CALL_LIST';
const CALL_EMAILED = 'Kelby Turk, local in Saratoga Springs. I sent you a note about missed calls and quiet estimates. What happens to a call you can\'t pick up?';
const CALL_NEVER = 'Kelby Turk, local in Saratoga Springs. I help shops catch missed calls and chase unsold estimates. What happens to a call you can\'t pick up?';
const VOICEMAIL = 'This is Kelby Turk, local in Saratoga Springs. I help shops catch missed calls and chase unsold estimates. I\'ll try you again in a couple of days.';
const WALK_IN = 'I\'m Kelby, up the road. I help shops answer every call and chase unsold estimates. Is the owner in? Two minutes.';
const ASK = 'Free, 15 minutes. I look at how calls and open estimates are handled and tell you the two spots losing you jobs. You keep what I find.';
const ITEM_KEYS = [
  'address', 'ask', 'attempts', 'city', 'company', 'emailed', 'kind', 'last_outcome',
  'last_outcome_at', 'maps_url', 'open_task_id', 'phone', 'prospect_id', 'reason',
  'reason_code', 'script', 'tel', 'voicemail_script',
];

const outbound = { mail: 0, gmail: 0, claude: 0, places: 0 };
let n = 0;
let server;
let apiBase;
let current = instantInDenver('2026-11-20', 15);

function at(ymd, hour = 15) {
  current = instantInDenver(ymd, hour);
  return current;
}

async function setFlag(enabled) {
  const { rowCount } = await pool.query(
    `UPDATE feature_flags SET enabled = $2, updated_at = NULL, updated_by = NULL WHERE name = $1`,
    [FLAG, enabled]
  );
  if (rowCount !== 1) throw new Error(`${FLAG} row missing`);
}

async function enable() {
  delete process.env.FF_CALL_LIST;
  await setFlag(true);
}

async function request(method, urlPath, { body, key = API_KEY } = {}) {
  const headers = { 'content-type': 'application/json' };
  if (key) headers['x-api-key'] = key;
  const res = await fetch(`${apiBase}${urlPath}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = null; }
  return { status: res.status, json, text };
}

async function lead(overrides = {}) {
  n += 1;
  const row = await insertProspect({
    google_place_id: `test-call-list-${n}`,
    company: overrides.company || `TEST: Call List ${n}`,
    email: `test+call${n}@example.com`,
    contact_name: 'Dana',
    ...overrides,
  });
  if (overrides.fit_score !== undefined) {
    await pool.query('UPDATE prospects SET fit_score = $2 WHERE id = $1', [row.id, overrides.fit_score]);
  }
  return row;
}

async function proposal(prospectId, fields = {}) {
  n += 1;
  const { rows } = await pool.query(
    `INSERT INTO proposals (
       prospect_id, version, status, slug, to_email, to_name, subject, body, followup1, followup2,
       sent_at, followup1_due_at, followup1_sent_at, followup2_due_at, followup2_sent_at, replied_at
     ) VALUES (
       $1, 1, $2, $3, $4, 'Dana', 'A note', 'Hello.', 'Checking back.', 'Last note.',
       $5, $6, $7, $8, $9, $10
     ) RETURNING id`,
    [
      prospectId,
      fields.status || 'sent',
      `call-list-${prospectId}-${n}`,
      fields.toEmail || `test+seq${n}@example.com`,
      fields.sentAt === undefined ? current : fields.sentAt,
      fields.followup1Due === undefined ? null : fields.followup1Due,
      fields.followup1Sent === undefined ? null : fields.followup1Sent,
      fields.followup2Due === undefined ? null : fields.followup2Due,
      fields.followup2Sent === undefined ? null : fields.followup2Sent,
      fields.repliedAt === undefined ? null : fields.repliedAt,
    ]
  );
  return rows[0];
}

async function viewLog(proposalId, when, reason = null) {
  n += 1;
  const fp = n.toString(16).padStart(64, 'a');
  await pool.query(
    `INSERT INTO proposal_view_log (proposal_id, viewed_at, source, excluded_reason, ua_class, client_fp)
     VALUES ($1, $2, 'onepager', $3, 'browser', $4)`,
    [proposalId, when, reason, fp]
  );
}

async function openTask(prospectId, proposalId, when) {
  const { rows } = await pool.query(
    `INSERT INTO proposal_view_tasks
       (proposal_id, prospect_id, status, view_count, last_viewed_at, last_source)
     VALUES ($1, $2, 'open', 1, $3, 'onepager')
     RETURNING id`,
    [proposalId, prospectId, when]
  );
  return rows[0];
}

async function list(query = '') {
  return request('GET', `/api/today/call-list${query}`);
}

function ids(body) {
  return body.items.map((item) => item.prospect_id);
}

function one(body, id) {
  const rows = body.items.filter((item) => item.prospect_id === id);
  assert.equal(rows.length, 1, `prospect ${id} count ${rows.length}`);
  return rows[0];
}

describe('F-010 call list', { concurrency: false }, () => {
  before(async () => {
    assert.equal(denverYmd(instantInDenver('2026-11-20', 15)), '2026-11-20');
    assert.equal(weekdayIndex('2026-11-20'), 5);
    assert.equal(copy.CALL_EMAILED, CALL_EMAILED);
    assert.equal(copy.CALL_NEVER_EMAILED, CALL_NEVER);
    assert.equal(copy.VOICEMAIL, VOICEMAIL);
    assert.equal(copy.WALK_IN, WALK_IN);
    assert.equal(copy.ASK, ASK);
    await applySchema();
    _setTransport({
      async sendMail() {
        outbound.mail += 1;
        return { messageId: '<call-list@localhost>' };
      },
    });
    _setApiForTests(() => {
      outbound.gmail += 1;
      throw new Error('gmail');
    });
    _setClient({
      messages: {
        create: async () => {
          outbound.claude += 1;
          throw new Error('claude');
        },
      },
    });
    _setSearch(async () => {
      outbound.places += 1;
      throw new Error('places');
    });
    _setClockForTests(() => current);
    const app = express();
    const flagsApi = require('../src/api/flags');
    app.use(express.json());
    app.use('/api/flags', flagsApi.requireFlagApiKey);
    app.use('/api', require('../src/api/auth'));
    app.use('/api/flags', flagsApi);
    app.use('/api/prospects', require('../src/api/prospects'));
    app.use('/api/prospects', require('../src/api/call-list').prospectRouter);
    app.use('/api/today', require('../src/api/call-list').todayRouter);
    app.use('/api/focus', require('../src/api/focus'));
    server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    apiBase = `http://127.0.0.1:${server.address().port}`;
  });

  beforeEach(async () => {
    await resetDb();
    await setFlag(false);
    delete process.env.FF_CALL_LIST;
    at('2026-11-20', 15);
  });

  after(async () => {
    assert.equal(outbound.mail, 0, 'mailer was called');
    assert.equal(outbound.gmail, 0, 'gmail transport was called');
    assert.equal(outbound.claude, 0, 'anthropic client was called');
    assert.equal(outbound.places, 0, 'places search was called');
    delete process.env.FF_CALL_LIST;
    _setClockForTests(null);
    _setTransport(null);
    _setApiForTests(null);
    _setClient(null);
    _setSearch(null);
    try { await setFlag(false); } catch { /* schema already gone */ }
    if (server) await new Promise((resolve) => server.close(resolve));
    await closePool();
  });

  it('confirms /p/ logs a view with FF_DEMO_VIEW_TASK off and /demo/prototype logs only with FF_PROSPECT_VIEWS on', () => {
    const onepager = fs.readFileSync(path.join(__dirname, '../src/proposals/onepager.js'), 'utf8');
    const page = fs.readFileSync(path.join(__dirname, '../src/prototypes/page.js'), 'utf8');
    const store = fs.readFileSync(path.join(__dirname, '../src/demo-view/store.js'), 'utf8');
    const handler = onepager.slice(onepager.indexOf("router.get('/:slug'"), onepager.indexOf('module.exports'));
    assert.match(handler, /await recordOnepagerView\(req, p\.id\)/);
    assert.equal(handler.includes('FF_DEMO_VIEW_TASK'), false);
    assert.equal(handler.includes('demoViewTaskOn'), false);
    const record = store.slice(store.indexOf('async function recordView'), store.indexOf('async function recordOnepagerView'));
    assert.ok(record.indexOf('INSERT INTO proposal_view_log') < record.indexOf('await syncTask'));
    const sync = store.slice(store.indexOf('async function syncTask'), store.indexOf('function prospectViewRef'));
    assert.match(sync, /if \(!demoViewTaskOn\(\)\) return/);
    const demoPage = page.slice(page.indexOf("router.get('/:token'"), page.indexOf('function closePage'));
    assert.match(demoPage, /if \(prospectViewsOn\(\)\) \{[\s\S]*recordDemoPageView/);
    const recordDemo = store.slice(store.indexOf('async function recordDemoPageView'), store.indexOf('function stamp'));
    assert.match(recordDemo, /if \(!prospectViewsOn\(\)\) return null/);
    console.log('[call-list] tier 1 log: /p/ writes proposal_view_log with the task flag off; /demo/prototype writes only while FF_PROSPECT_VIEWS is on');
  });

  it('seeds FF_CALL_LIST off, lists it, and does not let env force it on', async () => {
    const flags = await request('GET', '/api/flags');
    const row = flags.json.flags.find((flag) => flag.name === FLAG);
    assert.equal(row.enabled, false);
    assert.equal(row.effective, false);
    assert.equal(row.writable, true);
    assert.equal(row.source, 'db');
    process.env.FF_CALL_LIST = 'true';
    const forced = await list();
    assert.equal(forced.status, 200);
    assert.deepEqual(forced.json, { enabled: false, items: [] });
    delete process.env.FF_CALL_LIST;
    await setFlag(true);
    process.env.FF_CALL_LIST = 'false';
    const off = await list();
    assert.deepEqual(off.json, { enabled: false, items: [] });
    process.env.FF_CALL_LIST = 'off';
    const offWord = await list();
    assert.equal(offWord.json.enabled, false);
    console.log('[call-list] flag seeded off; env true stays off; env false forces off');
  });

  it('flag off: list is empty, mutations are 404, and prospect JSON has no new keys', async () => {
    const row = await lead({ fit_score: 80, next_action: 'Call', city: 'Lehi' });
    await pool.query(
      `UPDATE prospects SET next_action_at = '2026-11-01', fit_tier = 'A', fit_score = 90 WHERE id = $1`,
      [row.id]
    );
    const listed = await list();
    assert.equal(listed.status, 200);
    assert.deepEqual(listed.json, { enabled: false, items: [] });
    const all = await list('?all=1');
    assert.deepEqual(all.json, { enabled: false, items: [] });
    for (const call of [
      ['PUT', `/api/prospects/${row.id}/call-list`, { kind: 'call' }],
      ['DELETE', `/api/prospects/${row.id}/call-list`, undefined],
      ['POST', `/api/prospects/${row.id}/call-outcome`, { outcome: 'no_answer', kind: 'call' }],
    ]) {
      const res = await request(call[0], call[1], { body: call[2] });
      assert.equal(res.status, 404, call[0]);
      assert.deepEqual(res.json, { error: 'not_found' });
    }
    const stored = await pool.query(
      'SELECT call_list_kind, call_list_set_at FROM prospects WHERE id = $1',
      [row.id]
    );
    assert.equal(stored.rows[0].call_list_kind, null);
    const acts = await pool.query(
      'SELECT COUNT(*)::int AS n FROM prospect_activities WHERE prospect_id = $1',
      [row.id]
    );
    assert.equal(acts.rows[0].n, 0);
    const detail = await request('GET', `/api/prospects/${row.id}`);
    const db = await pool.query('SELECT * FROM prospects WHERE id = $1', [row.id]);
    const expectedKeys = Object.keys(db.rows[0])
      .filter((key) => key !== 'call_list_kind' && key !== 'call_list_set_at')
      .sort();
    const detailKeys = Object.keys(detail.json).filter((key) => key !== 'activities' && key !== 'projects').sort();
    assert.deepEqual(detailKeys, expectedKeys);
    assert.equal(detail.json.company, row.company);
    assert.equal(detail.json.stage, 'found');
    assert.equal('call_list_kind' in detail.json, false);
    assert.equal('call_list_set_at' in detail.json, false);
    const index = await request('GET', '/api/prospects');
    const listedRow = index.json.prospects.find((item) => item.id === row.id);
    assert.equal('call_list_kind' in listedRow, false);
    assert.equal('call_list_set_at' in listedRow, false);
    const focus = await request('GET', '/api/focus?today=2026-11-20');
    const due = focus.json.followups_due.find((item) => item.id === row.id);
    assert.ok(due);
    assert.equal('call_list_kind' in due, false);
    assert.equal('call_list_set_at' in due, false);
    const missing = await request('GET', '/api/today/call-list', { key: null });
    assert.equal(missing.status, 401);
    console.log('[call-list] flag off matches main: empty list, 404 writes, no new prospect keys');
  });

  it('puts and deletes the marker, and prospect responses include it only while the flag is on', async () => {
    await enable();
    const row = await lead();
    const bad = await request('PUT', `/api/prospects/${row.id}/call-list`, { body: { kind: 'maybe' } });
    assert.equal(bad.status, 400);
    assert.deepEqual(bad.json, { error: 'invalid_kind' });
    const missing = await request('PUT', '/api/prospects/999999/call-list', { body: { kind: 'call' } });
    assert.equal(missing.status, 404);
    assert.deepEqual(missing.json, { error: 'not_found' });
    const put = await request('PUT', `/api/prospects/${row.id}/call-list`, { body: { kind: 'walk_in' } });
    assert.equal(put.status, 200);
    assert.equal(put.json.call_list_kind, 'walk_in');
    assert.match(put.json.call_list_set_at, /^2026-11-20T/);
    const detail = await request('GET', `/api/prospects/${row.id}`);
    assert.equal(detail.json.call_list_kind, 'walk_in');
    assert.equal(detail.json.call_list_set_at, put.json.call_list_set_at);
    const index = await request('GET', '/api/prospects');
    const listedRow = index.json.prospects.find((item) => item.id === row.id);
    assert.equal(listedRow.call_list_kind, 'walk_in');
    assert.equal(listedRow.call_list_set_at, put.json.call_list_set_at);
    at('2026-11-20', 16);
    const removed = await request('DELETE', `/api/prospects/${row.id}/call-list`);
    assert.equal(removed.status, 200);
    assert.equal(removed.json.call_list_kind, 'excluded');
    assert.notEqual(removed.json.call_list_set_at, put.json.call_list_set_at);
    at('2026-11-20', 15);
    const again = await request('PUT', `/api/prospects/${row.id}/call-list`, { body: { kind: 'call' } });
    assert.equal(again.json.call_list_kind, 'call');
    const dnc = await lead();
    await pool.query('UPDATE prospects SET do_not_contact = TRUE, do_not_contact_source = \'manual\' WHERE id = $1', [dnc.id]);
    const blocked = await request('PUT', `/api/prospects/${dnc.id}/call-list`, { body: { kind: 'call' } });
    assert.equal(blocked.status, 409);
    assert.deepEqual(blocked.json, { error: 'do_not_contact' });
    const archived = await lead();
    await pool.query('UPDATE prospects SET archived_at = NOW() WHERE id = $1', [archived.id]);
    const archivedRes = await request('PUT', `/api/prospects/${archived.id}/call-list`, { body: { kind: 'call' } });
    assert.equal(archivedRes.status, 409);
    assert.deepEqual(archivedRes.json, { error: 'archived' });
    console.log('[call-list] marker put/delete and prospect keys');
  });

  it('tiers 1 and 2, exclusions, and a sticky remove that only a newer counted view undoes', async () => {
    await enable();
    const viewed = await lead({ city: 'Lehi', fit_score: 40 });
    const viewedProposal = await proposal(viewed.id, { sentAt: null, status: 'sent' });
    await pool.query('UPDATE proposals SET sent_at = NULL, status = \'sent\' WHERE id = $1', [viewedProposal.id]);
    await viewLog(viewedProposal.id, instantInDenver('2026-11-19', 15));
    const taskLead = await lead({ city: 'Provo', phone: null, address: '9 Task St', fit_score: 10 });
    const taskProposal = await proposal(taskLead.id, { sentAt: null, status: 'draft' });
    const task = await openTask(taskLead.id, taskProposal.id, instantInDenver('2026-11-18', 12));
    const listed = await lead({ city: 'Eagle Mountain', fit_score: 70 });
    await request('PUT', `/api/prospects/${listed.id}/call-list`, { body: { kind: 'walk_in' } });
    const neither = await lead({ phone: null, address: null, website: null });
    const neitherProposal = await proposal(neither.id, { sentAt: null, status: 'draft' });
    await viewLog(neitherProposal.id, current);
    const excludedView = await lead({ city: 'Lehi' });
    const excludedProposal = await proposal(excludedView.id, { sentAt: null, status: 'draft' });
    await viewLog(excludedProposal.id, current, 'preview');
    const oldView = await lead({ city: 'Lehi' });
    const oldProposal = await proposal(oldView.id, { sentAt: null, status: 'draft' });
    await viewLog(oldProposal.id, instantInDenver('2026-11-12', 15));

    const body = (await list()).json;
    const viewItem = one(body, viewed.id);
    assert.equal(viewItem.reason_code, 'demo_view');
    assert.equal(viewItem.reason, 'Viewed the demo yesterday');
    assert.equal(viewItem.kind, 'call');
    assert.equal(viewItem.open_task_id, null);
    const taskItem = one(body, taskLead.id);
    assert.equal(taskItem.reason_code, 'demo_view');
    assert.equal(taskItem.reason, 'Viewed the demo 2 days ago');
    assert.equal(taskItem.kind, 'walk_in');
    assert.equal(taskItem.open_task_id, Number(task.id));
    assert.equal(taskItem.voicemail_script, null);
    assert.equal(taskItem.phone, null);
    assert.equal(taskItem.tel, null);
    assert.match(taskItem.maps_url, /^https:\/\/www\.google\.com\/maps\/search\/\?api=1&query=/);
    const listedItem = one(body, listed.id);
    assert.equal(listedItem.reason_code, 'listed');
    assert.equal(listedItem.reason, 'On your walk-in list');
    assert.equal(listedItem.kind, 'walk_in');
    assert.equal(ids(body).includes(neither.id), false);
    assert.equal(ids(body).includes(excludedView.id), false);
    assert.equal(ids(body).includes(oldView.id), false);

    const intro = await lead({ city: 'Lehi', industry: 'HVAC', state: 'UT' });
    await proposal(intro.id, { sentAt: instantInDenver('2026-11-16', 12), followup1Due: instantInDenver('2026-11-25', 12) });
    assert.equal(ids((await list()).json).includes(intro.id), true);
    await request('DELETE', `/api/prospects/${intro.id}/call-list`);
    assert.equal(ids((await list()).json).includes(intro.id), false);
    const introProposal = (await pool.query('SELECT id FROM proposals WHERE prospect_id = $1', [intro.id])).rows[0];
    await viewLog(introProposal.id, instantInDenver('2026-11-19', 12));
    await openTask(intro.id, introProposal.id, current);
    assert.equal(ids((await list()).json).includes(intro.id), false);
    at('2026-11-20', 16);
    await viewLog(introProposal.id, current);
    const back = one((await list()).json, intro.id);
    assert.equal(back.reason_code, 'demo_view');
    assert.equal(back.reason, 'Viewed the demo today');
    at('2026-11-20', 15);

    for (const [label, patch] of [
      ['dnc', `do_not_contact = TRUE, do_not_contact_source = 'manual'`],
      ['archived', `archived_at = NOW()`],
      ['lost', `stage = 'lost'`],
      ['disqualified', `stage = 'disqualified'`],
      ['won', `stage = 'won'`],
    ]) {
      const row = await lead({ company: `TEST: Excluded ${label} ${n}` });
      const prop = await proposal(row.id, { sentAt: null, status: 'draft' });
      await viewLog(prop.id, current);
      await pool.query(`UPDATE prospects SET ${patch} WHERE id = $1`, [row.id]);
      assert.equal(ids((await list()).json).includes(row.id), false, label);
    }
    const pest = await lead({ company: 'TEST: Terminix Heating', industry: 'HVAC', state: 'UT' });
    await proposal(pest.id, { sentAt: instantInDenver('2026-11-16', 12) });
    assert.equal(ids((await list()).json).includes(pest.id), false);
    console.log('[call-list] tiers 1-2, exclusions, sticky remove, newer view brings it back');
  });

  it('keeps tiers 3 and 4 to target trades in Utah and uses the emailed opener only when a proposal email went out', async () => {
    await enable();
    async function introLead(overrides, sentYmd) {
      const row = await lead(overrides);
      await proposal(row.id, {
        sentAt: instantInDenver(sentYmd, 12),
        followup1Due: instantInDenver('2026-11-27', 12),
      });
      return row;
    }
    const hvac = await introLead({ industry: 'HVAC', state: 'UT', city: 'Lehi' }, '2026-11-16');
    const day3 = await introLead({ industry: 'Plumbing', state: 'Utah', city: 'Orem' }, '2026-11-17');
    const day5 = await introLead({ industry: 'Roofing', state: 'ut', city: 'Lindon' }, '2026-11-15');
    const day2 = await introLead({ industry: 'Electrical', state: 'UT', city: 'Orem' }, '2026-11-18');
    const day6 = await introLead({ industry: 'Landscaping', state: 'UT', city: 'Orem' }, '2026-11-14');
    const colorado = await introLead({ industry: 'HVAC', state: 'CO', city: 'Lehi' }, '2026-11-16');
    const cleaning = await introLead({ industry: 'Cleaning', state: 'UT', city: 'Lehi' }, '2026-11-16');
    const oil = await introLead({ industry: 'Heating Oil Delivery', state: 'UT', city: 'Lehi' }, '2026-11-16');
    const poolHeat = await introLead({ industry: 'Pool Heating', state: 'UT', city: 'Lehi' }, '2026-11-16');
    const blankState = await lead({ industry: 'Electrical Contractor', state: '', address: '4 Main St, Provo, UT 84601', city: 'Provo' });
    await proposal(blankState.id, { sentAt: instantInDenver('2026-11-16', 12), followup1Due: instantInDenver('2026-11-27', 12) });
    const replied = await introLead({ industry: 'HVAC', state: 'UT', city: 'Orem' }, '2026-11-16');
    await pool.query(`UPDATE proposals SET replied_at = $2 WHERE prospect_id = $1`, [replied.id, current]);
    const bounced = await introLead({ industry: 'Plumbing', state: 'UT', city: 'Orem' }, '2026-11-16');
    await pool.query(`UPDATE proposals SET status = 'bounced' WHERE prospect_id = $1`, [bounced.id]);
    const opted = await introLead({ industry: 'Roofing', state: 'UT', city: 'Orem' }, '2026-11-16');
    await pool.query(`UPDATE proposals SET status = 'opted_out' WHERE prospect_id = $1`, [opted.id]);
    const sibling = await introLead({ industry: 'HVAC', state: 'UT', city: 'Orem' }, '2026-11-16');
    await proposal(sibling.id, { sentAt: instantInDenver('2026-10-01', 12), status: 'replied', repliedAt: current });

    const body = (await list('?all=1')).json;
    assert.equal(one(body, hvac.id).reason, 'Intro email 4 days ago, no reply');
    assert.equal(one(body, hvac.id).reason_code, 'intro_3_5d');
    assert.equal(one(body, hvac.id).emailed, true);
    assert.equal(one(body, hvac.id).script, CALL_EMAILED);
    assert.equal(one(body, hvac.id).voicemail_script, VOICEMAIL);
    assert.equal(one(body, hvac.id).ask, ASK);
    assert.equal(one(body, day3.id).reason, 'Intro email 3 days ago, no reply');
    assert.equal(one(body, day5.id).reason, 'Intro email 5 days ago, no reply');
    assert.equal(one(body, blankState.id).reason_code, 'intro_3_5d');
    for (const row of [day2, day6, colorado, cleaning, oil, poolHeat, replied, bounced, opted, sibling]) {
      assert.equal(ids(body).includes(row.id), false, row.company);
    }

    const finished = await lead({ industry: 'Landscaping', state: 'UT', city: 'Spanish Fork' });
    const sent = instantInDenver('2026-10-31', 12);
    const f1 = instantInDenver('2026-11-03', 12);
    const f2 = instantInDenver('2026-11-10', 12);
    await proposal(finished.id, {
      sentAt: sent, followup1Due: f1, followup1Sent: f1, followup2Due: f2, followup2Sent: f2,
    });
    const unfinished = await lead({ industry: 'Electrical', state: 'UT', city: 'Orem' });
    await proposal(unfinished.id, {
      sentAt: instantInDenver('2026-10-20', 12),
      followup1Due: instantInDenver('2026-10-23', 12),
    });
    const outStateDone = await lead({ industry: 'Roofing', state: 'NV', city: 'Lehi' });
    await proposal(outStateDone.id, {
      sentAt: sent, followup1Due: f1, followup1Sent: f1, followup2Due: f2, followup2Sent: f2,
    });
    const recentCall = await lead({ industry: 'Plumbing', state: 'UT', city: 'Orem' });
    await proposal(recentCall.id, {
      sentAt: sent, followup1Due: f1, followup1Sent: f1, followup2Due: f2, followup2Sent: f2,
    });
    const beforeOutcome = (await list('?all=1')).json;
    const done = one(beforeOutcome, finished.id);
    assert.equal(done.reason, 'Emails finished, no reply');
    assert.equal(done.reason_code, 'sequence_done');
    assert.equal(ids(beforeOutcome).includes(unfinished.id), false);
    assert.equal(ids(beforeOutcome).includes(outStateDone.id), false);
    const talked = await request('POST', `/api/prospects/${recentCall.id}/call-outcome`, {
      body: { outcome: 'talked', kind: 'call' },
    });
    assert.equal(talked.json.back_on, '2026-11-27');
    assert.equal(talked.json.stage, 'responded');
    at('2026-11-26', 15);
    assert.equal(ids((await list('?all=1')).json).includes(recentCall.id), false);
    at('2026-11-27', 15);
    const talkedBack = one((await list('?all=1')).json, recentCall.id);
    assert.equal(talkedBack.reason_code, 'sequence_done');
    assert.equal(talkedBack.reason, 'Talked Nov 20, follow up');
    at('2026-11-20', 15);

    const never = await lead({ city: 'Saratoga Springs', phone: '(801) 555-0199', industry: 'Auto Repair', state: 'CA' });
    await request('PUT', `/api/prospects/${never.id}/call-list`, { body: { kind: 'call' } });
    const neverItem = one((await list()).json, never.id);
    assert.equal(neverItem.emailed, false);
    assert.equal(neverItem.script, CALL_NEVER);
    assert.equal(neverItem.reason, 'On your call list');
    assert.equal(neverItem.tel, 'tel:8015550199');
    for (const text of [neverItem.script, neverItem.voicemail_script, neverItem.ask]) {
      assert.equal(/viewed|opened/i.test(text), false);
    }
    console.log('[call-list] tiers 3-4 trade and Utah filter; emailed vs never-emailed opener');
  });

  it('orders by tier, city, then fit, caps at 8 with more, and ?all=1 stops at 50', async () => {
    await enable();
    const specs = [
      ['Saratoga Springs', 10],
      ['Saratoga Springs', 90],
      ['Eagle Mountain', 50],
      ['Lehi', 80],
      ['Lehi', 10],
      ['American Fork', 10],
      ['Provo', 99],
    ];
    const made = [];
    for (const [city, fit] of specs) {
      const row = await lead({ city, fit_score: fit, industry: 'Auto Repair', state: 'CA' });
      await request('PUT', `/api/prospects/${row.id}/call-list`, { body: { kind: 'call' } });
      made.push({ id: row.id, city, fit });
    }
    const ordered = (await list()).json;
    assert.deepEqual(ids(ordered), [
      made[1].id, made[0].id, made[2].id, made[3].id, made[4].id, made[5].id, made[6].id,
    ]);
    assert.deepEqual(Object.keys(ordered.items[0]).sort(), ITEM_KEYS);

    const filler = [];
    for (let i = 0; i < 51; i += 1) {
      const row = await lead({
        city: 'Saratoga Springs',
        fit_score: 1000 - i,
        industry: 'Auto Repair',
        state: 'CA',
        company: `TEST: Cap ${i}`,
      });
      await pool.query(
        `UPDATE prospects SET call_list_kind = 'call', call_list_set_at = $2 WHERE id = $1`,
        [row.id, current]
      );
      filler.push(row.id);
    }
    const capped = (await list()).json;
    assert.equal(capped.cap, 8);
    assert.equal(capped.items.length, 8);
    assert.equal(capped.more, made.length + filler.length - 8);
    assert.equal(capped.date, '2026-11-20');
    const topFits = capped.items.map((item) => item.prospect_id);
    assert.deepEqual(topFits, filler.slice(0, 8));
    const expanded = (await list('?all=1')).json;
    assert.equal(expanded.cap, 8);
    assert.equal(expanded.items.length, 50);
    assert.equal(expanded.more, made.length + filler.length - 50);
    const notAll = (await list('?all=true')).json;
    assert.equal(notAll.items.length, 8);
    const unique = new Set(expanded.items.map((item) => item.prospect_id));
    assert.equal(unique.size, expanded.items.length);
    console.log(`[call-list] order and cap more=${capped.more} all=${expanded.items.length} left=${expanded.more}`);
  });

  it('orders tiers 1, 2, 3, then 4 ahead of city and fit', async () => {
    await enable();
    const tier1 = await lead({ city: 'Provo', fit_score: 1, industry: 'HVAC', state: 'UT' });
    const tier1Proposal = await proposal(tier1.id, { sentAt: null, status: 'draft' });
    await viewLog(tier1Proposal.id, instantInDenver('2026-11-19', 12));
    const tier2 = await lead({ city: 'Provo', fit_score: 99, industry: 'Auto Repair', state: 'CA' });
    await request('PUT', `/api/prospects/${tier2.id}/call-list`, { body: { kind: 'call' } });
    const tier3 = await lead({ city: 'Saratoga Springs', fit_score: 99, industry: 'HVAC', state: 'UT' });
    await proposal(tier3.id, {
      sentAt: instantInDenver('2026-11-16', 12),
      followup1Due: instantInDenver('2026-11-27', 12),
    });
    const tier4 = await lead({ city: 'Saratoga Springs', fit_score: 99, industry: 'Plumbing', state: 'UT' });
    const sent = instantInDenver('2026-10-31', 12);
    const f1 = instantInDenver('2026-11-03', 12);
    const f2 = instantInDenver('2026-11-10', 12);
    await proposal(tier4.id, {
      sentAt: sent, followup1Due: f1, followup1Sent: f1, followup2Due: f2, followup2Sent: f2,
    });
    const body = (await list('?all=1')).json;
    assert.deepEqual(ids(body), [tier1.id, tier2.id, tier3.id, tier4.id]);
    assert.deepEqual(body.items.map((item) => item.reason_code), [
      'demo_view', 'listed', 'intro_3_5d', 'sequence_done',
    ]);
    console.log('[call-list] cross-tier order is 1, 2, 3, 4');
  });

  it('returns a tier 4 lead on back_on after no_answer and after three misses', async () => {
    await enable();
    async function finishedLead(city) {
      const row = await lead({ industry: 'HVAC', state: 'UT', city });
      const sentAt = instantInDenver('2026-10-31', 12);
      const follow1 = instantInDenver('2026-11-03', 12);
      const follow2 = instantInDenver('2026-11-10', 12);
      await proposal(row.id, {
        sentAt, followup1Due: follow1, followup1Sent: follow1, followup2Due: follow2, followup2Sent: follow2,
      });
      return row;
    }
    at('2026-11-23', 15);
    const once = await finishedLead('Orem');
    const noAnswer = await request('POST', `/api/prospects/${once.id}/call-outcome`, {
      body: { outcome: 'no_answer', kind: 'call' },
    });
    assert.equal(noAnswer.json.back_on, '2026-11-24');
    assert.equal(noAnswer.json.stage, 'found');
    assert.equal(ids((await list('?all=1')).json).includes(once.id), false);
    at('2026-11-24', 9);
    const back = one((await list('?all=1')).json, once.id);
    assert.equal(back.reason_code, 'sequence_done');
    assert.equal(back.reason, 'No answer Mon, try again');
    assert.equal(back.last_outcome, 'no_answer');

    at('2026-11-20', 15);
    const streak = await finishedLead('Lehi');
    await request('POST', `/api/prospects/${streak.id}/call-outcome`, { body: { outcome: 'no_answer', kind: 'call' } });
    await request('POST', `/api/prospects/${streak.id}/call-outcome`, { body: { outcome: 'voicemail', kind: 'call' } });
    const third = await request('POST', `/api/prospects/${streak.id}/call-outcome`, {
      body: { outcome: 'no_answer', kind: 'call' },
    });
    assert.equal(third.json.back_on, '2026-12-04');
    at('2026-12-03', 15);
    assert.equal(ids((await list('?all=1')).json).includes(streak.id), false);
    at('2026-12-04', 15);
    const held = one((await list('?all=1')).json, streak.id);
    assert.equal(held.attempts, 3);
    assert.equal(held.reason_code, 'sequence_done');
    assert.equal(held.reason, 'No answer Nov 20, try again');
    console.log('[call-list] tier 4 returns on back_on for no_answer and for three misses');
  });

  it('uses the latest outcome on the reason line, and keeps a tier 1 view reason', async () => {
    await enable();
    at('2026-11-17', 15);
    const voice = await lead({ city: 'Lehi', industry: 'Auto Repair', state: 'CA' });
    await request('PUT', `/api/prospects/${voice.id}/call-list`, { body: { kind: 'call' } });
    await request('POST', `/api/prospects/${voice.id}/call-outcome`, { body: { outcome: 'voicemail', kind: 'call' } });

    at('2026-11-18', 15);
    const stopped = await lead({
      city: 'Lehi', industry: 'Auto Repair', state: 'CA', phone: null, address: '4 Walk St',
    });
    await request('PUT', `/api/prospects/${stopped.id}/call-list`, { body: { kind: 'walk_in' } });
    await request('POST', `/api/prospects/${stopped.id}/call-outcome`, { body: { outcome: 'no_answer', kind: 'walk_in' } });

    at('2026-11-13', 15);
    const talked = await lead({ city: 'Lehi', industry: 'Auto Repair', state: 'CA' });
    await request('PUT', `/api/prospects/${talked.id}/call-list`, { body: { kind: 'call' } });
    const talkedRes = await request('POST', `/api/prospects/${talked.id}/call-outcome`, {
      body: { outcome: 'talked', kind: 'call' },
    });
    assert.equal(talkedRes.json.back_on, '2026-11-20');

    at('2026-11-14', 11);
    const boundary = await lead({ city: 'Lehi', industry: 'Auto Repair', state: 'CA' });
    await request('PUT', `/api/prospects/${boundary.id}/call-list`, { body: { kind: 'call' } });
    await request('POST', `/api/prospects/${boundary.id}/call-outcome`, { body: { outcome: 'no_answer', kind: 'call' } });

    at('2026-11-16', 15);
    const viewed = await lead({ city: 'Provo', industry: 'HVAC', state: 'UT' });
    await request('POST', `/api/prospects/${viewed.id}/call-outcome`, { body: { outcome: 'no_answer', kind: 'call' } });
    const viewedProposal = await proposal(viewed.id, { sentAt: null, status: 'draft' });
    await viewLog(viewedProposal.id, instantInDenver('2026-11-19', 12));

    at('2026-11-20', 15);
    const body = (await list('?all=1')).json;
    const voiceItem = one(body, voice.id);
    assert.equal(voiceItem.reason, 'Left a voicemail Tue');
    assert.equal(voiceItem.reason_code, 'listed');
    const stoppedItem = one(body, stopped.id);
    assert.equal(stoppedItem.reason, 'Stopped by Wed, try again');
    assert.equal(stoppedItem.kind, 'walk_in');
    assert.equal(stoppedItem.reason_code, 'listed');
    const talkedItem = one(body, talked.id);
    assert.equal(talkedItem.reason, 'Talked Nov 13, follow up');
    assert.equal(talkedItem.reason_code, 'listed');
    const boundaryItem = one(body, boundary.id);
    assert.equal(boundaryItem.reason, 'No answer Sat, try again');
    const viewedItem = one(body, viewed.id);
    assert.equal(viewedItem.reason, 'Viewed the demo yesterday');
    assert.equal(viewedItem.reason_code, 'demo_view');
    assert.equal(viewedItem.last_outcome, 'no_answer');
    console.log('[call-list] outcome reasons use a weekday inside 6 days and a short date after that; tier 1 keeps the view line');
  });

  it('returns one row when a lead qualifies for several tiers, including an open task', async () => {
    await enable();
    const row = await lead({ city: 'Saratoga Springs', fit_score: 99, industry: 'HVAC', state: 'UT' });
    const sent = instantInDenver('2026-11-16', 12);
    const f1 = instantInDenver('2026-11-18', 12);
    const f2 = instantInDenver('2026-11-19', 12);
    const prop = await proposal(row.id, {
      sentAt: sent, followup1Due: f1, followup1Sent: f1, followup2Due: f2, followup2Sent: f2,
    });
    await viewLog(prop.id, instantInDenver('2026-11-19', 18));
    const task = await openTask(row.id, prop.id, instantInDenver('2026-11-19', 18));
    await request('PUT', `/api/prospects/${row.id}/call-list`, { body: { kind: 'call' } });
    const body = (await list()).json;
    const item = one(body, row.id);
    assert.equal(item.reason_code, 'demo_view');
    assert.equal(item.open_task_id, Number(task.id));
    assert.equal(item.kind, 'call');
    assert.equal(item.emailed, true);
    assert.equal(item.script, CALL_EMAILED);
    assert.equal(body.items.filter((entry) => entry.prospect_id === row.id).length, 1);
    console.log('[call-list] de-dupe: view + task + marker + intro + finished sequence is one tier 1 row');
  });

  it('snoozes across a weekend, applies the 3-attempt rule, and does not move a stage backwards', async () => {
    await enable();
    const friday = await lead({ city: 'Lehi', industry: 'Auto Repair', state: 'CA' });
    await request('PUT', `/api/prospects/${friday.id}/call-list`, { body: { kind: 'call' } });
    const first = await request('POST', `/api/prospects/${friday.id}/call-outcome`, {
      body: { outcome: 'no_answer', kind: 'call' },
    });
    assert.equal(first.status, 200);
    assert.equal(first.json.removed, true);
    assert.equal(first.json.back_on, '2026-11-23');
    assert.equal(first.json.stage, 'found');
    assert.equal(ids((await list()).json).includes(friday.id), false);
    at('2026-11-22', 15);
    assert.equal(ids((await list()).json).includes(friday.id), false);
    at('2026-11-23', 9);
    const back = one((await list()).json, friday.id);
    assert.equal(back.attempts, 1);
    assert.equal(back.last_outcome, 'no_answer');

    at('2026-11-21', 11);
    const saturday = await lead({ city: 'Lehi', industry: 'Auto Repair', state: 'CA' });
    await request('PUT', `/api/prospects/${saturday.id}/call-list`, { body: { kind: 'call' } });
    const satNo = await request('POST', `/api/prospects/${saturday.id}/call-outcome`, {
      body: { outcome: 'no_answer', kind: 'call' },
    });
    assert.equal(satNo.json.back_on, '2026-11-23');
    const satVm = await lead({ city: 'Lehi', industry: 'Auto Repair', state: 'CA' });
    const vm = await request('POST', `/api/prospects/${satVm.id}/call-outcome`, {
      body: { outcome: 'voicemail', kind: 'walk_in' },
    });
    assert.equal(vm.json.back_on, '2026-11-24');
    const visit = await pool.query(
      `SELECT type, body FROM prospect_activities WHERE prospect_id = $1 AND body = 'voicemail'`,
      [satVm.id]
    );
    assert.equal(visit.rows[0].type, 'visit');
    at('2026-11-20', 15);
    const friVm = await lead();
    const friVmRes = await request('POST', `/api/prospects/${friVm.id}/call-outcome`, {
      body: { outcome: 'voicemail', kind: 'call' },
    });
    assert.equal(friVmRes.json.back_on, '2026-11-24');
    const callRow = await pool.query(
      `SELECT type FROM prospect_activities WHERE prospect_id = $1 AND body = 'voicemail'`,
      [friVm.id]
    );
    assert.equal(callRow.rows[0].type, 'call');

    const streak = await lead({ city: 'American Fork' });
    await request('PUT', `/api/prospects/${streak.id}/call-list`, { body: { kind: 'call' } });
    await request('POST', `/api/prospects/${streak.id}/call-outcome`, { body: { outcome: 'no_answer', kind: 'call' } });
    const second = await request('POST', `/api/prospects/${streak.id}/call-outcome`, {
      body: { outcome: 'voicemail', kind: 'call' },
    });
    assert.equal(second.json.back_on, '2026-11-24');
    const third = await request('POST', `/api/prospects/${streak.id}/call-outcome`, {
      body: { outcome: 'no_answer', kind: 'call' },
    });
    assert.equal(third.json.back_on, '2026-12-04');
    at('2026-12-03', 15);
    assert.equal(ids((await list()).json).includes(streak.id), false);
    at('2026-12-04', 15);
    assert.equal(one((await list()).json, streak.id).attempts, 3);

    at('2026-11-21', 11);
    const satStreak = await lead();
    const satThird = await request('POST', `/api/prospects/${satStreak.id}/call-outcome`, {
      body: { outcome: 'no_answer', kind: 'call' },
    });
    await request('POST', `/api/prospects/${satStreak.id}/call-outcome`, { body: { outcome: 'no_answer', kind: 'call' } });
    const satLast = await request('POST', `/api/prospects/${satStreak.id}/call-outcome`, {
      body: { outcome: 'voicemail', kind: 'call' },
    });
    assert.equal(satThird.json.back_on, '2026-11-23');
    assert.equal(satLast.json.back_on, '2026-12-07');

    at('2026-11-20', 15);
    const reset = await lead({ stage: 'found' });
    await request('POST', `/api/prospects/${reset.id}/call-outcome`, { body: { outcome: 'no_answer', kind: 'call' } });
    await request('POST', `/api/prospects/${reset.id}/call-outcome`, { body: { outcome: 'talked', kind: 'call' } });
    const afterTalk = await request('POST', `/api/prospects/${reset.id}/call-outcome`, {
      body: { outcome: 'no_answer', kind: 'call' },
    });
    assert.equal(afterTalk.json.back_on, '2026-11-23');
    assert.equal(afterTalk.json.stage, 'responded');

    const cases = [
      ['found', 'talked', 'responded', '2026-11-27'],
      ['contacted', 'talked', 'responded', '2026-11-27'],
      ['responded', 'talked', 'responded', '2026-11-27'],
      ['qualified', 'talked', 'qualified', '2026-11-27'],
      ['proposal', 'talked', 'proposal', '2026-11-27'],
      ['won', 'talked', 'won', '2026-11-27'],
      ['found', 'audit_booked', 'qualified', null],
      ['responded', 'audit_booked', 'qualified', null],
      ['proposal', 'audit_booked', 'proposal', null],
      ['won', 'audit_booked', 'won', null],
      ['contacted', 'not_interested', 'lost', null],
      ['proposal', 'not_interested', 'lost', null],
      ['won', 'not_interested', 'won', null],
      ['disqualified', 'not_interested', 'disqualified', null],
      ['lost', 'talked', 'lost', '2026-11-27'],
    ];
    for (const [stage, outcome, expectStage, backOn] of cases) {
      const row = await lead({ stage, company: `TEST: Stage ${stage} ${outcome} ${n}` });
      const res = await request('POST', `/api/prospects/${row.id}/call-outcome`, {
        body: { outcome, kind: 'call' },
      });
      assert.equal(res.status, 200, `${stage} ${outcome}`);
      assert.equal(res.json.stage, expectStage, `${stage} ${outcome}`);
      assert.equal(res.json.back_on, backOn, `${stage} ${outcome}`);
      assert.equal(res.json.removed, true);
      const stored = await pool.query('SELECT stage FROM prospects WHERE id = $1', [row.id]);
      assert.equal(stored.rows[0].stage, expectStage);
    }
    at('2026-11-21', 11);
    const satTalk = await lead({ stage: 'found' });
    const satTalkRes = await request('POST', `/api/prospects/${satTalk.id}/call-outcome`, {
      body: { outcome: 'talked', kind: 'call' },
    });
    assert.equal(satTalkRes.json.back_on, '2026-11-30');
    assert.equal(satTalkRes.json.stage, 'responded');

    const badOutcome = await request('POST', `/api/prospects/${friday.id}/call-outcome`, {
      body: { outcome: 'later', kind: 'call' },
    });
    assert.equal(badOutcome.status, 400);
    assert.deepEqual(badOutcome.json, { error: 'invalid_outcome' });
    const badKind = await request('POST', `/api/prospects/${friday.id}/call-outcome`, {
      body: { outcome: 'talked', kind: 'email' },
    });
    assert.equal(badKind.status, 400);
    assert.deepEqual(badKind.json, { error: 'invalid_kind' });
    console.log('[call-list] weekend business days, 3-attempt rule, no stage regression');
  });

  it('stops automatic follow-ups for talked, audit booked, not interested, and do not contact', async () => {
    await enable();
    async function due(stage) {
      const row = await lead({ stage, company: `TEST: Stop ${stage} ${n}` });
      await proposal(row.id, {
        sentAt: new Date(Date.now() - 3 * 86400000),
        followup1Due: new Date(Date.now() - 3600000),
        status: 'sent',
      });
      return row;
    }
    const talked = await due('contacted');
    const talkedRes = await request('POST', `/api/prospects/${talked.id}/call-outcome`, {
      body: { outcome: 'talked', kind: 'call' },
    });
    assert.equal(talkedRes.json.stage, 'responded');
    const booked = await due('contacted');
    const bookedRes = await request('POST', `/api/prospects/${booked.id}/call-outcome`, {
      body: { outcome: 'audit_booked', kind: 'call' },
    });
    assert.equal(bookedRes.json.stage, 'qualified');
    const lost = await due('found');
    const lostRes = await request('POST', `/api/prospects/${lost.id}/call-outcome`, {
      body: { outcome: 'not_interested', kind: 'call' },
    });
    assert.equal(lostRes.json.stage, 'lost');
    const dnc = await due('contacted');
    const dncRes = await request('POST', `/api/prospects/${dnc.id}/call-outcome`, {
      body: { outcome: 'do_not_contact', kind: 'call' },
    });
    assert.equal(dncRes.json.stage, 'contacted');
    const dncRow = await pool.query(
      'SELECT do_not_contact, do_not_contact_source FROM prospects WHERE id = $1',
      [dnc.id]
    );
    assert.equal(dncRow.rows[0].do_not_contact, true);
    assert.equal(dncRow.rows[0].do_not_contact_source, 'manual');
    const dncProposal = await pool.query(
      'SELECT status, stop_reason FROM proposals WHERE prospect_id = $1',
      [dnc.id]
    );
    assert.equal(dncProposal.rows[0].status, 'stopped');
    assert.equal(dncProposal.rows[0].stop_reason, 'Marked do-not-contact (manual)');

    const sweep = await sendDueFollowups();
    assert.equal(sweep.sent, 0);
    assert.equal(outbound.mail, 0);
    const reasons = new Map();
    const stopped = await pool.query(
      `SELECT prospect_id, status, stop_reason FROM proposals
        WHERE prospect_id = ANY($1::int[])`,
      [[talked.id, booked.id, lost.id, dnc.id]]
    );
    for (const row of stopped.rows) reasons.set(row.prospect_id, row);
    assert.equal(reasons.get(talked.id).status, 'stopped');
    assert.equal(reasons.get(talked.id).stop_reason, 'Lead moved to responded');
    assert.equal(reasons.get(booked.id).status, 'stopped');
    assert.equal(reasons.get(booked.id).stop_reason, 'Lead moved to qualified');
    assert.equal(reasons.get(lost.id).status, 'stopped');
    assert.equal(reasons.get(lost.id).stop_reason, 'Lead moved to lost');
    assert.equal(reasons.get(dnc.id).status, 'stopped');

    const taskLead = await lead({ stage: 'contacted' });
    const prop = await proposal(taskLead.id, { sentAt: null, status: 'draft' });
    const task = await openTask(taskLead.id, prop.id, current);
    await request('POST', `/api/prospects/${taskLead.id}/call-outcome`, {
      body: { outcome: 'no_answer', kind: 'call' },
    });
    const done = await pool.query('SELECT status FROM proposal_view_tasks WHERE id = $1', [task.id]);
    assert.equal(done.rows[0].status, 'done');
    const called = await pool.query(
      `SELECT body FROM prospect_activities WHERE prospect_id = $1 AND body = 'called'`,
      [taskLead.id]
    );
    assert.equal(called.rows.length, 1);
    const touch = await pool.query(
      `SELECT type, source FROM campaign_touches WHERE external_ref = $1`,
      [`demo-view-task:${task.id}`]
    );
    assert.equal(touch.rows[0].type, 'call_logged');
    assert.equal(touch.rows[0].source, 'system');

    const stays = await lead({ stage: 'proposal', city: 'Lehi' });
    await request('PUT', `/api/prospects/${stays.id}/call-list`, { body: { kind: 'call' } });
    await request('POST', `/api/prospects/${stays.id}/call-outcome`, {
      body: { outcome: 'audit_booked', kind: 'call' },
    });
    const propView = await proposal(stays.id, { sentAt: null, status: 'draft' });
    await viewLog(propView.id, current);
    assert.equal(ids((await list()).json).includes(stays.id), false);
    console.log('[call-list] closing outcomes stop follow-ups through the existing stage and do-not-contact paths; mailer calls=0');
  });

  it('keeps the marker across a second schema boot and rejects a bad kind', async () => {
    await enable();
    const row = await lead();
    await request('PUT', `/api/prospects/${row.id}/call-list`, { body: { kind: 'call' } });
    await applySchema();
    const stored = await pool.query(
      'SELECT call_list_kind, enabled FROM prospects, feature_flags WHERE prospects.id = $1 AND feature_flags.name = $2',
      [row.id, FLAG]
    );
    assert.equal(stored.rows[0].call_list_kind, 'call');
    assert.equal(stored.rows[0].enabled, true);
    await assert.rejects(
      pool.query(`UPDATE prospects SET call_list_kind = 'nope' WHERE id = $1`, [row.id])
    );
    console.log('[call-list] schema re-boot keeps the marker and the on flag');
  });
});
