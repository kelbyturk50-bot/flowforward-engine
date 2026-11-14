process.env.CRM_API_KEY = 'test-demo-view-task-key-32chars!!';
delete process.env.FF_DEMO_VIEW_TASK;

const { describe, it, before, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const path = require('path');
const express = require('express');

const { applyMainSchema } = require('../src/db/migrate');
const { resetDb, closePool, pool, insertProspect } = require('./fixtures');
const { demoViewTaskOn } = require('../src/demo-view/flag');
const store = require('../src/demo-view/store');
const { BURST_WINDOW } = store;
const send = require('../src/proposals/send');
const gmail = require('../src/proposals/gmail');

const API_KEY = process.env.CRM_API_KEY;
const BROWSER = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const BOT = 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)';

let server;
let ipSeq = 20;

function nextIp() {
  ipSeq += 1;
  return `203.0.113.${(ipSeq % 200) + 1}`;
}

function request(method, reqPath, { headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const req = http.request({
      method,
      hostname: '127.0.0.1',
      port: server.address().port,
      path: reqPath,
      headers: {
        ...(payload ? { 'content-type': 'application/json', 'content-length': String(payload.length) } : {}),
        ...headers,
      },
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = text ? JSON.parse(text) : null; } catch { json = null; }
        resolve({ status: res.statusCode, headers: res.headers, text, json });
      });
    });
    req.on('error', reject);
    if (payload) req.end(payload);
    else req.end();
  });
}

function authHeaders(extra = {}) {
  return { 'x-api-key': API_KEY, ...extra };
}

async function sentProposal(label, overrides = {}) {
  const lead = await insertProspect({
    google_place_id: `test-place-dvt-${label}-${crypto.randomBytes(4).toString('hex')}`,
    company: `TEST: ${label}`,
    email: `test+${label}@example.test`,
    phone: Object.prototype.hasOwnProperty.call(overrides, 'phone') ? overrides.phone : '(801) 555-0142',
    city: overrides.city || 'Provo',
    industry: overrides.industry || 'HVAC',
    stage: overrides.stage || 'proposal',
  });
  if (overrides.doNotContact) {
    await pool.query(
      `UPDATE prospects SET do_not_contact = TRUE, do_not_contact_source = 'opt_out' WHERE id = $1`,
      [lead.id]
    );
  }
  if (overrides.archive) {
    await pool.query(
      `UPDATE prospects SET archived_at = NOW(), archive_reason = 'test' WHERE id = $1`,
      [lead.id]
    );
  }
  const sentAt = overrides.sentAt === undefined ? new Date(Date.now() - 3 * 24 * 3600 * 1000) : overrides.sentAt;
  const status = overrides.status || 'sent';
  const due = new Date('2026-12-01T18:00:00.000Z');
  const { rows } = await pool.query(
    `INSERT INTO proposals
       (prospect_id, version, status, slug, sent_at, replied_at, subject, body, onepager, followup1_due_at, followup2_due_at)
     VALUES ($1, 1, $2, $3, $4, $5, 'Hi', 'Body', '{}'::jsonb, $6, $6)
     RETURNING *`,
    [lead.id, status, `dvt-${label}-${crypto.randomBytes(3).toString('hex')}`, sentAt, overrides.repliedAt || null, due]
  );
  return { lead, proposal: rows[0], due };
}

async function openPage(slug, { ip, ua = BROWSER, method = 'GET', query = '', headers = {} } = {}) {
  return request(method, `/p/${slug}${query}`, {
    headers: {
      'user-agent': ua,
      'x-forwarded-for': ip,
      ...headers,
    },
  });
}

async function logs(proposalId) {
  const { rows } = await pool.query(
    `SELECT id, proposal_id, source, excluded_reason, ua_class, client_fp, viewed_at
       FROM proposal_view_log WHERE proposal_id = $1 ORDER BY viewed_at, id`,
    [proposalId]
  );
  return rows;
}

async function tasks(proposalId) {
  const { rows } = await pool.query(
    `SELECT * FROM proposal_view_tasks WHERE proposal_id = $1 ORDER BY id`,
    [proposalId]
  );
  return rows;
}

async function viewCount(proposalId) {
  const { rows } = await pool.query('SELECT views FROM proposals WHERE id = $1', [proposalId]);
  return rows[0].views;
}

function cookieHeader(res) {
  const raw = res.headers['set-cookie'];
  if (!raw) return '';
  return Array.isArray(raw) ? raw.join('\n') : String(raw);
}

describe('demo-view call tasks', { concurrency: false }, () => {
  before(async () => {
    await resetDb();
    await applyMainSchema();
    process.env.FF_DEMO_VIEW_TASK = 'true';
    const app = express();
    app.set('trust proxy', 1);
    app.use(express.json({ limit: '1mb' }));
    app.use('/p', require('../src/proposals/onepager').router);
    app.use('/api', require('../src/api/auth'));
    app.use('/api/demo-view-tasks', require('../src/api/demo-view-tasks'));
    app.use(require('../src/api/json-errors'));
    server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  });

  afterEach(() => {
    store._setClockForTests(null);
    process.env.FF_DEMO_VIEW_TASK = 'true';
    process.env.CRM_API_KEY = API_KEY;
  });

  after(async () => {
    send._setTransport(null);
    gmail._setApiForTests(null);
    store._setClockForTests(null);
    delete process.env.FF_DEMO_VIEW_TASK;
    if (server) await new Promise((resolve) => server.close(resolve));
    await resetDb();
    await closePool();
  });

  it('keeps the log free of raw IP and user-agent columns, and re-applies', async () => {
    const { rows } = await pool.query(
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'proposal_view_log'
        ORDER BY column_name`
    );
    const names = rows.map((row) => row.column_name);
    assert.deepEqual(names, ['client_fp', 'excluded_reason', 'id', 'proposal_id', 'source', 'ua_class', 'viewed_at']);
    const index = await pool.query(
      `SELECT indexdef FROM pg_indexes WHERE indexname = 'proposal_view_tasks_one_open'`
    );
    assert.match(index.rows[0].indexdef, /UNIQUE/);
    assert.match(index.rows[0].indexdef, /status = 'open'/);
    await applyMainSchema();
  });

  it('treats only a clear truthy env value as on', () => {
    for (const value of ['true', 'TRUE', ' true ', '1', 'yes', 'on', 'On']) {
      assert.equal(demoViewTaskOn({ FF_DEMO_VIEW_TASK: value }), true, value);
    }
    for (const value of [undefined, '', ' ', 'false', 'off', '0', 'no', 'truee', '2', 'yes please']) {
      const env = {};
      if (value !== undefined) env.FF_DEMO_VIEW_TASK = value;
      assert.equal(demoViewTaskOn(env), false, String(value));
    }
  });

  it('excludes ?preview=1 and sets the internal cookie', async () => {
    const row = await sentProposal('preview');
    const ip = nextIp();
    const before = await viewCount(row.proposal.id);
    const res = await openPage(row.proposal.slug, { ip, query: '?preview=1' });
    assert.equal(res.status, 200);
    const cookie = cookieHeader(res);
    assert.match(cookie, /ff_internal=1/);
    assert.match(cookie, /HttpOnly/i);
    assert.match(cookie, /Secure/i);
    assert.match(cookie, /SameSite=Lax/i);
    assert.match(cookie, /Path=\//);
    assert.match(cookie, /Max-Age=31536000/);
    const written = await logs(row.proposal.id);
    assert.equal(written.length, 1);
    assert.equal(written[0].excluded_reason, 'preview');
    assert.equal(written[0].source, 'onepager');
    assert.equal(await viewCount(row.proposal.id), before);
    assert.equal((await tasks(row.proposal.id)).length, 0);
    const missing = await openPage('no-such-slug', { ip: nextIp(), query: '?preview=1' });
    assert.equal(missing.status, 404);
    assert.match(cookieHeader(missing), /ff_internal=1/);
  });

  it('excludes a user-agent that matches BOT_UA', async () => {
    const row = await sentProposal('bot');
    const res = await openPage(row.proposal.slug, { ip: nextIp(), ua: BOT });
    assert.equal(res.status, 200);
    const written = await logs(row.proposal.id);
    assert.equal(written[0].excluded_reason, 'bot_ua');
    assert.equal(written[0].ua_class, 'bot');
    assert.equal(await viewCount(row.proposal.id), 0);
    assert.equal((await tasks(row.proposal.id)).length, 0);
  });

  it('excludes a view 2 minutes or less after sent_at', async () => {
    const sent = new Date('2026-03-01T15:00:00.000Z');
    const early = await sentProposal('soon', { sentAt: sent });
    const later = await sentProposal('later', { sentAt: sent });
    store._setClockForTests(() => new Date(sent.getTime() + 120000));
    await openPage(early.proposal.slug, { ip: nextIp() });
    store._setClockForTests(() => new Date(sent.getTime() + 120001));
    await openPage(later.proposal.slug, { ip: nextIp() });
    assert.equal((await logs(early.proposal.id))[0].excluded_reason, 'within_2m');
    assert.equal((await tasks(early.proposal.id)).length, 0);
    assert.equal((await logs(later.proposal.id))[0].excluded_reason, null);
    assert.equal((await tasks(later.proposal.id)).length, 1);
  });

  it('excludes HEAD requests', async () => {
    const row = await sentProposal('head');
    const res = await openPage(row.proposal.slug, { ip: nextIp(), method: 'HEAD' });
    assert.equal(res.status, 200);
    assert.equal((await logs(row.proposal.id))[0].excluded_reason, 'head');
    assert.equal((await tasks(row.proposal.id)).length, 0);
    assert.equal(await viewCount(row.proposal.id), 1);
  });

  it('excludes prefetch and prerender', async () => {
    const purpose = await sentProposal('purpose');
    const sec = await sentProposal('sec-purpose');
    await openPage(purpose.proposal.slug, { ip: nextIp(), headers: { purpose: 'prefetch' } });
    await openPage(sec.proposal.slug, { ip: nextIp(), headers: { 'sec-purpose': 'prerender' } });
    assert.equal((await logs(purpose.proposal.id))[0].excluded_reason, 'prefetch');
    assert.equal((await logs(sec.proposal.id))[0].excluded_reason, 'prefetch');
    assert.equal((await tasks(purpose.proposal.id)).length, 0);
    assert.equal((await tasks(sec.proposal.id)).length, 0);
  });

  it('excludes a later view that carries the internal cookie', async () => {
    const row = await sentProposal('cookie');
    const ip = nextIp();
    await openPage(row.proposal.slug, { ip, query: '?preview=1' });
    const again = await openPage(row.proposal.slug, { ip, headers: { cookie: 'other=1; ff_internal=1' } });
    assert.equal(again.status, 200);
    const written = await logs(row.proposal.id);
    assert.deepEqual(written.map((item) => item.excluded_reason), ['preview', 'internal_cookie']);
    assert.equal((await tasks(row.proposal.id)).length, 0);
    assert.equal(await viewCount(row.proposal.id), 1);
    const plain = await sentProposal('cookie-miss');
    await openPage(plain.proposal.slug, { ip: nextIp(), headers: { cookie: 'ff_internal=2' } });
    assert.equal((await logs(plain.proposal.id))[0].excluded_reason, null);
    assert.equal((await tasks(plain.proposal.id)).length, 1);
  });

  it('retroactively excludes 3 proposals inside 10 minutes, which is inside the 2-hour window', async () => {
    assert.equal(BURST_WINDOW, '2 hours');
    const base = new Date('2026-06-02T16:00:00.000Z');
    const ip = nextIp();
    const other = nextIp();
    const rows = [];
    for (let i = 0; i < 3; i += 1) rows.push(await sentProposal(`burst-${i}`));
    store._setClockForTests(() => base);
    await openPage(rows[0].proposal.slug, { ip: other });
    for (let i = 0; i < 3; i += 1) {
      const at = new Date(base.getTime() + i * 60 * 1000);
      store._setClockForTests(() => at);
      await openPage(rows[i].proposal.slug, { ip });
    }
    const firstLogs = await logs(rows[0].proposal.id);
    assert.equal(firstLogs.length, 2);
    const kept = firstLogs.find((item) => item.excluded_reason == null);
    const dropped = firstLogs.find((item) => item.excluded_reason === 'burst');
    assert.ok(kept && dropped);
    assert.notEqual(kept.client_fp, dropped.client_fp);
    assert.equal((await tasks(rows[0].proposal.id)).length, 1);
    assert.equal((await tasks(rows[0].proposal.id))[0].view_count, 1);
    assert.equal((await tasks(rows[1].proposal.id)).length, 0);
    assert.equal((await tasks(rows[2].proposal.id)).length, 0);
    for (const row of rows) {
      const mine = (await logs(row.proposal.id)).filter((item) => item.excluded_reason === 'burst');
      assert.equal(mine.length, 1);
    }
    const stillInside = new Date(base.getTime() + 15 * 60 * 1000);
    const fifth = await sentProposal('burst-still');
    store._setClockForTests(() => stillInside);
    await openPage(fifth.proposal.slug, { ip });
    assert.equal((await logs(fifth.proposal.id))[0].excluded_reason, 'burst');
    assert.equal((await tasks(fifth.proposal.id)).length, 0);
    const after = new Date(base.getTime() + (2 * 60 + 3) * 60 * 1000);
    const fourth = await sentProposal('burst-after');
    store._setClockForTests(() => after);
    await openPage(fourth.proposal.slug, { ip });
    assert.equal((await logs(fourth.proposal.id))[0].excluded_reason, null);
    assert.equal((await tasks(fourth.proposal.id)).length, 1);
  });

  it('does not treat one proposal, or two, as a burst across 2 hours', async () => {
    const repeat = await sentProposal('repeat');
    const ip = nextIp();
    const start = new Date('2026-06-04T16:00:00.000Z');
    for (let i = 0; i < 5; i += 1) {
      store._setClockForTests(() => new Date(start.getTime() + i * 25 * 60 * 1000));
      await openPage(repeat.proposal.slug, { ip });
    }
    const repeatLogs = await logs(repeat.proposal.id);
    assert.equal(repeatLogs.length, 5);
    assert.ok(repeatLogs.every((item) => item.excluded_reason == null));
    const repeatTask = await tasks(repeat.proposal.id);
    assert.equal(repeatTask.length, 1);
    assert.equal(repeatTask[0].view_count, 5);
    assert.equal(new Date(repeatTask[0].last_viewed_at).toISOString(), new Date(start.getTime() + 100 * 60 * 1000).toISOString());

    const pairIp = nextIp();
    const left = await sentProposal('pair-a');
    const right = await sentProposal('pair-b');
    const pairStart = new Date('2026-06-05T16:00:00.000Z');
    store._setClockForTests(() => pairStart);
    await openPage(left.proposal.slug, { ip: pairIp });
    store._setClockForTests(() => new Date(pairStart.getTime() + 30 * 60 * 1000));
    await openPage(right.proposal.slug, { ip: pairIp });
    store._setClockForTests(() => new Date(pairStart.getTime() + 90 * 60 * 1000));
    await openPage(left.proposal.slug, { ip: pairIp });
    assert.ok((await logs(left.proposal.id)).every((item) => item.excluded_reason == null));
    assert.ok((await logs(right.proposal.id)).every((item) => item.excluded_reason == null));
    assert.equal((await tasks(left.proposal.id))[0].view_count, 2);
    assert.equal((await tasks(right.proposal.id)).length, 1);
  });

  it('keeps one open task per proposal and updates the count', async () => {
    const row = await sentProposal('dedupe');
    const ip = nextIp();
    const first = new Date('2026-06-03T16:00:00.000Z');
    const second = new Date(first.getTime() + 3 * 60 * 1000);
    store._setClockForTests(() => first);
    await openPage(row.proposal.slug, { ip });
    store._setClockForTests(() => second);
    await openPage(row.proposal.slug, { ip });
    const open = await tasks(row.proposal.id);
    assert.equal(open.length, 1);
    assert.equal(open[0].status, 'open');
    assert.equal(open[0].view_count, 2);
    assert.equal(new Date(open[0].last_viewed_at).toISOString(), second.toISOString());
    await assert.rejects(
      pool.query(
        `INSERT INTO proposal_view_tasks
           (proposal_id, prospect_id, status, view_count, last_viewed_at, last_source)
         VALUES ($1, $2, 'open', 1, NOW(), 'onepager')`,
        [row.proposal.id, row.lead.id]
      ),
      (err) => err.code === '23505'
    );
  });

  it('does not reopen a done task until two qualifying views are more than 7 days later', async () => {
    const row = await sentProposal('resurface');
    const ip = nextIp();
    const start = new Date('2026-01-05T15:00:00.000Z');
    store._setClockForTests(() => start);
    await openPage(row.proposal.slug, { ip });
    const open = await tasks(row.proposal.id);
    const done = await request('POST', `/api/demo-view-tasks/${open[0].id}/done`, { headers: authHeaders() });
    assert.equal(done.status, 200);
    assert.equal(done.json.status, 'done');
    store._setClockForTests(() => new Date(start.getTime() + 6 * 24 * 3600 * 1000));
    await openPage(row.proposal.slug, { ip });
    assert.equal((await tasks(row.proposal.id)).filter((item) => item.status === 'open').length, 0);
    const day8 = new Date(start.getTime() + 8 * 24 * 3600 * 1000);
    store._setClockForTests(() => day8);
    await openPage(row.proposal.slug, { ip });
    assert.equal((await tasks(row.proposal.id)).filter((item) => item.status === 'open').length, 0);
    const day8b = new Date(day8.getTime() + 60 * 1000);
    store._setClockForTests(() => day8b);
    await openPage(row.proposal.slug, { ip });
    const reopened = (await tasks(row.proposal.id)).filter((item) => item.status === 'open');
    assert.equal(reopened.length, 1);
    assert.equal(reopened[0].view_count, 2);
  });

  it('writes the log and no task when the flag is off, and the routes 404', async () => {
    delete process.env.FF_DEMO_VIEW_TASK;
    const row = await sentProposal('flag-off');
    const ip = nextIp();
    const page = await openPage(row.proposal.slug, { ip });
    assert.equal(page.status, 200);
    const written = await logs(row.proposal.id);
    assert.equal(written.length, 1);
    assert.equal(written[0].excluded_reason, null);
    assert.equal(await viewCount(row.proposal.id), 1);
    assert.equal((await tasks(row.proposal.id)).length, 0);
    const preview = await sentProposal('flag-off-preview');
    await openPage(preview.proposal.slug, { ip: nextIp(), query: '?preview=1' });
    assert.equal(await viewCount(preview.proposal.id), 0);
    const bot = await sentProposal('flag-off-bot');
    await openPage(bot.proposal.slug, { ip: nextIp(), ua: BOT });
    assert.equal(await viewCount(bot.proposal.id), 0);
    const list = await request('GET', '/api/demo-view-tasks', { headers: authHeaders() });
    const metrics = await request('GET', '/api/demo-view-tasks/metrics', { headers: authHeaders() });
    const post = await request('POST', '/api/demo-view-tasks/1/done', { headers: authHeaders() });
    assert.equal(list.status, 404);
    assert.deepEqual(list.json, { error: 'not_found' });
    assert.equal(metrics.status, 404);
    assert.equal(post.status, 404);
    const missed = await request('GET', '/api/demo-view-tasks');
    assert.equal(missed.status, 401);
    process.env.CRM_API_KEY = 'short';
    const closed = await request('GET', '/api/demo-view-tasks', { headers: authHeaders() });
    assert.equal(closed.status, 503);
    assert.equal(closed.json.error, 'api_key_not_configured');
  });

  it('does not send or move follow-ups across view, update, done, snooze, and dismiss', async () => {
    let transportCalls = 0;
    let gmailCalls = 0;
    send._setTransport({
      sendMail() {
        transportCalls += 1;
        return Promise.resolve({ messageId: 'should-not-send' });
      },
    });
    gmail._setApiForTests(() => {
      gmailCalls += 1;
      throw new Error('gmail should not be called');
    });
    const storeSrc = fs.readFileSync(path.join(__dirname, '../src/demo-view/store.js'), 'utf8');
    const apiSrc = fs.readFileSync(path.join(__dirname, '../src/api/demo-view-tasks.js'), 'utf8');
    assert.doesNotMatch(storeSrc, /proposals\/send|proposals\/gmail|sendMail/);
    assert.doesNotMatch(apiSrc, /proposals\/send|proposals\/gmail|sendMail/);
    const row = await sentProposal('quiet');
    const snoozeRow = await sentProposal('quiet-snooze');
    const dismissRow = await sentProposal('quiet-dismiss');
    const ip = nextIp();
    const start = new Date('2026-07-01T15:00:00.000Z');
    store._setClockForTests(() => start);
    await openPage(row.proposal.slug, { ip });
    store._setClockForTests(() => new Date(start.getTime() + 5 * 60 * 1000));
    await openPage(row.proposal.slug, { ip });
    const open = await tasks(row.proposal.id);
    const done = await request('POST', `/api/demo-view-tasks/${open[0].id}/done`, { headers: authHeaders() });
    assert.equal(done.status, 200);
    await openPage(snoozeRow.proposal.slug, { ip: nextIp() });
    const snoozeId = (await tasks(snoozeRow.proposal.id))[0].id;
    const snoozed = await request('POST', `/api/demo-view-tasks/${snoozeId}/snooze`, { headers: authHeaders() });
    assert.equal(snoozed.status, 200);
    await openPage(dismissRow.proposal.slug, { ip: nextIp() });
    const dismissId = (await tasks(dismissRow.proposal.id))[0].id;
    const dismissed = await request('POST', `/api/demo-view-tasks/${dismissId}/dismiss`, { headers: authHeaders() });
    assert.equal(dismissed.status, 200);
    assert.equal(transportCalls, 0);
    assert.equal(gmailCalls, 0);
    const after = await pool.query(
      `SELECT status, followup1_due_at, followup2_due_at, next_retry_at, sent_at
         FROM proposals WHERE id = $1`,
      [row.proposal.id]
    );
    assert.equal(after.rows[0].status, 'sent');
    assert.equal(new Date(after.rows[0].followup1_due_at).toISOString(), new Date(row.due).toISOString());
    assert.equal(after.rows[0].next_retry_at, null);
    const activity = await pool.query(
      `SELECT type, body FROM prospect_activities WHERE prospect_id = $1`,
      [row.lead.id]
    );
    assert.deepEqual(activity.rows, [{ type: 'call', body: 'called' }]);
    const touches = await pool.query(
      `SELECT type, source, channel, external_ref FROM campaign_touches WHERE lead_id = $1 ORDER BY id`,
      [row.lead.id]
    );
    assert.equal(touches.rows.length, 1);
    assert.equal(touches.rows[0].type, 'call_logged');
    assert.equal(touches.rows[0].source, 'system');
    assert.equal(touches.rows[0].channel, 'phone');
    assert.match(touches.rows[0].external_ref, /^demo-view-task:[1-9][0-9]*$/);
    const dismissNotes = await pool.query(
      `SELECT COUNT(*)::int AS n FROM prospect_activities WHERE prospect_id = $1`,
      [dismissRow.lead.id]
    );
    assert.equal(dismissNotes.rows[0].n, 0);
    send._setTransport(null);
    gmail._setApiForTests(null);
  });

  it('purges log rows older than 120 days', async () => {
    const row = await sentProposal('purge');
    const fp = 'ab'.repeat(32);
    const oldAt = new Date(Date.now() - 121 * 24 * 3600 * 1000);
    const youngAt = new Date(Date.now() - 10 * 24 * 3600 * 1000);
    await pool.query(
      `INSERT INTO proposal_view_log (proposal_id, viewed_at, source, ua_class, client_fp)
       VALUES ($1, $2, 'onepager', 'browser', $3), ($1, $4, 'demo', 'other', $3)`,
      [row.proposal.id, oldAt, fp, youngAt]
    );
    const removed = await store.purgeViewLog(new Date());
    assert.ok(removed >= 1);
    const left = await logs(row.proposal.id);
    assert.equal(left.length, 1);
    assert.equal(left[0].source, 'demo');
    assert.equal(new Date(left[0].viewed_at).toISOString(), youngAt.toISOString());
  });

  it('does not store a raw IP, a full user-agent, or the salt', async () => {
    const row = await sentProposal('privacy');
    const ip = '198.51.100.50';
    const ua = `${BROWSER} UniqueAuditTokenZZZ`;
    const lines = [];
    const origErr = console.error;
    const origLog = console.log;
    console.error = (...args) => {
      lines.push(args.map((part) => String(part)).join(' '));
      origErr(...args);
    };
    console.log = (...args) => {
      lines.push(args.map((part) => String(part)).join(' '));
      origLog(...args);
    };
    try {
      await openPage(row.proposal.slug, { ip, ua });
    } finally {
      console.error = origErr;
      console.log = origLog;
    }
    const written = await logs(row.proposal.id);
    const blob = JSON.stringify(written);
    assert.equal(blob.includes(ip), false);
    assert.equal(blob.includes('UniqueAuditTokenZZZ'), false);
    assert.equal(blob.includes(ua), false);
    assert.equal(written[0].ua_class, 'browser');
    assert.match(written[0].client_fp, /^[0-9a-f]{64}$/);
    const saltRow = await pool.query(
      `SELECT value->>'salt' AS salt FROM app_settings WHERE key = 'proposal_view_fp_salt'`
    );
    const salt = saltRow.rows[0].salt;
    assert.equal(typeof salt, 'string');
    assert.equal(salt.length > 0, true);
    if (lines.join('\n').includes(salt) || blob.includes(salt)) throw new Error('salt leaked');
  });

  it('creates no tasks for an Oct 20 audit replay spread from 10:00 to 11:50 PM MDT', async () => {
    const ip = '198.51.100.77';
    const rows = [];
    for (let i = 0; i < 7; i += 1) rows.push(await sentProposal(`audit-${i}`));
    const start = new Date('2026-10-20T22:00:00-06:00');
    const end = new Date('2026-10-20T23:50:00-06:00');
    const gapMs = 16 * 60 * 1000;
    const opened = [];
    for (let i = 0; i < 7; i += 1) {
      const at = new Date(start.getTime() + i * gapMs);
      opened.push(at);
      store._setClockForTests(() => at);
      const res = await openPage(rows[i].proposal.slug, { ip });
      assert.equal(res.status, 200);
    }
    assert.ok(opened[0].getTime() >= start.getTime());
    assert.ok(opened[opened.length - 1].getTime() <= end.getTime());
    for (let i = 1; i < opened.length; i += 1) {
      const gapMin = (opened[i].getTime() - opened[i - 1].getTime()) / 60000;
      assert.ok(gapMin >= 15 && gapMin <= 18, `gap ${gapMin}`);
    }
    const ids = rows.map((row) => row.proposal.id);
    const found = await pool.query(
      `SELECT excluded_reason, viewed_at FROM proposal_view_log
        WHERE proposal_id = ANY($1::int[])
        ORDER BY viewed_at`,
      [ids]
    );
    assert.equal(found.rows.length, 7);
    assert.ok(found.rows.every((row) => row.excluded_reason != null));
    assert.ok(found.rows.every((row) => row.excluded_reason === 'burst'));
    for (let i = 0; i < found.rows.length; i += 1) {
      let neighbors = 1;
      const at = new Date(found.rows[i].viewed_at).getTime();
      for (let j = 0; j < found.rows.length; j += 1) {
        if (i === j) continue;
        const other = new Date(found.rows[j].viewed_at).getTime();
        if (other <= at && at - other <= 10 * 60 * 1000) neighbors += 1;
      }
      assert.ok(neighbors < 3, `10-minute window held ${neighbors}`);
    }
    const created = await pool.query(
      `SELECT COUNT(*)::int AS n FROM proposal_view_tasks WHERE proposal_id = ANY($1::int[])`,
      [ids]
    );
    assert.equal(created.rows[0].n, 0);
    console.log('[demo-view] Oct 20 audit replay: 7 slugs across 10:00-11:36 PM MDT, 0 tasks');
  });

  it('skips a task when the lead replied, opted out, bounced, booked, or is unsent', async () => {
    const cases = [
      await sentProposal('replied', { status: 'replied', repliedAt: new Date() }),
      await sentProposal('opted', { doNotContact: true }),
      await sentProposal('bounced', { status: 'bounced' }),
      await sentProposal('responded', { stage: 'responded' }),
      await sentProposal('draft', { status: 'draft', sentAt: null }),
      await sentProposal('booked'),
    ];
    await pool.query(
      `INSERT INTO campaign_touches (lead_id, type, channel, occurred_at, source)
       VALUES ($1, 'call_booked', 'phone', NOW(), 'system')`,
      [cases[5].lead.id]
    );
    for (const row of cases) {
      await openPage(row.proposal.slug, { ip: nextIp() });
      assert.equal((await tasks(row.proposal.id)).length, 0, row.lead.company);
    }
    const archived = await sentProposal('archived', { archive: true });
    const hidden = await openPage(archived.proposal.slug, { ip: nextIp() });
    assert.equal(hidden.status, 404);
    assert.equal((await logs(archived.proposal.id)).length, 0);
    const finished = await sentProposal('finished', { status: 'finished' });
    await openPage(finished.proposal.slug, { ip: nextIp() });
    assert.equal((await tasks(finished.proposal.id)).length, 1);
  });

  it('flags a qualifying one-pager view when the 14-day demo link is expired', async () => {
    const expired = await sentProposal('expired-demo');
    const issued = new Date(Date.now() - 20 * 24 * 3600 * 1000);
    await pool.query(
      `INSERT INTO prototypes
         (prospect_id, agent_type, brand_name, color_primary, color_secondary, token_hash, nonce, issued_at, expires_at)
       SELECT $1, 'estimate_followup', 'TEST: Expired Shop', '#112233', '#445566', $2, $3,
              issued, issued + interval '336 hours'
         FROM (SELECT $4::timestamptz AS issued) s`,
      [expired.lead.id, crypto.randomBytes(32), crypto.randomBytes(32), issued]
    );
    await openPage(expired.proposal.slug, { ip: nextIp() });
    const expiredTask = (await tasks(expired.proposal.id))[0];
    assert.equal(expiredTask.demo_link_expired, true);
    assert.equal((await logs(expired.proposal.id))[0].excluded_reason, null);

    const live = await sentProposal('live-demo');
    await pool.query(
      `INSERT INTO prototypes
         (prospect_id, agent_type, brand_name, color_primary, color_secondary, token_hash, nonce, issued_at, expires_at)
       VALUES ($1, 'estimate_followup', 'TEST: Live Shop', '#112233', '#445566', $2, $3, NOW(), NOW() + interval '336 hours')`,
      [live.lead.id, crypto.randomBytes(32), crypto.randomBytes(32)]
    );
    await openPage(live.proposal.slug, { ip: nextIp() });
    assert.equal((await tasks(live.proposal.id))[0].demo_link_expired, false);

    const pilot = await sentProposal('pilot-expired');
    await pool.query(
      `INSERT INTO pilot_tokens (proposal_id, prospect_id, generation, derived, token_hash, expires_at)
       VALUES ($1, $2, 1, true, $3, NOW() - interval '1 day')`,
      [pilot.proposal.id, pilot.lead.id, crypto.randomBytes(32)]
    );
    await openPage(pilot.proposal.slug, { ip: nextIp() });
    assert.equal((await tasks(pilot.proposal.id))[0].demo_link_expired, true);
  });

  it('logs a demo-source view from the prototype_viewed touch and serves the Today API', async () => {
    const engineSrc = fs.readFileSync(path.join(__dirname, '../src/chatdemo/engine.js'), 'utf8');
    const insertAt = engineSrc.indexOf('INSERT INTO campaign_touches');
    const recordAt = engineSrc.indexOf('await recordDemoView');
    assert.ok(insertAt > 0 && recordAt > insertAt);
    const row = await sentProposal('demo-source', { phone: null });
    const at = new Date('2026-08-01T18:30:00.000Z');
    store._setClockForTests(() => at);
    const recorded = await store.recordDemoView({
      prospectId: row.lead.id,
      at,
      view: { method: 'POST', ua: BROWSER, ip: nextIp(), cookie: '', purpose: '', secPurpose: '', preview: false },
    });
    assert.equal(recorded.reason, null);
    const written = await logs(row.proposal.id);
    assert.equal(written[0].source, 'demo');
    const list = await request('GET', '/api/demo-view-tasks', { headers: authHeaders() });
    assert.equal(list.status, 200);
    const item = list.json.tasks.find((task) => task.proposal_id === row.proposal.id);
    assert.ok(item);
    assert.equal(item.company, row.lead.company);
    assert.equal(item.view_count, 1);
    assert.equal(item.last_viewed_at, at.toISOString());
    assert.equal(item.source, 'demo');
    assert.equal(item.trade, 'HVAC');
    assert.equal(item.city, 'Provo');
    assert.equal(item.phone, null);
    assert.equal(item.prospect_id, row.lead.id);
    assert.equal(item.demo_link_expired, false);

    const snooze = await request('POST', `/api/demo-view-tasks/${item.id}/snooze`, { headers: authHeaders() });
    assert.equal(snooze.status, 200);
    assert.equal(snooze.json.status, 'open');
    const hidden = await request('GET', '/api/demo-view-tasks', { headers: authHeaders() });
    assert.equal(hidden.json.tasks.some((task) => task.id === item.id), false);
    store._setClockForTests(() => new Date(at.getTime() + 25 * 3600 * 1000));
    const back = await request('GET', '/api/demo-view-tasks', { headers: authHeaders() });
    assert.equal(back.json.tasks.some((task) => task.id === item.id), true);

    const missing = await request('POST', '/api/demo-view-tasks/999999/done', { headers: authHeaders() });
    assert.equal(missing.status, 404);
    const bad = await request('POST', '/api/demo-view-tasks/nope/dismiss', { headers: authHeaders() });
    assert.equal(bad.status, 404);
    const dismissed = await request('POST', `/api/demo-view-tasks/${item.id}/dismiss`, { headers: authHeaders() });
    assert.equal(dismissed.status, 200);
    assert.equal(dismissed.json.status, 'dismissed');
    const again = await request('POST', `/api/demo-view-tasks/${item.id}/snooze`, { headers: authHeaders() });
    assert.equal(again.status, 409);
    assert.equal(again.json.error, 'task_not_open');

    await pool.query('DELETE FROM proposal_view_tasks');
    await pool.query(`DELETE FROM campaign_touches WHERE type IN ('call_logged', 'call_booked', 'opened')`);
    const metricLead = await sentProposal('metrics');
    const callAt = new Date('2026-04-01T12:00:00.000Z');
    store._setClockForTests(() => callAt);
    await openPage(metricLead.proposal.slug, { ip: nextIp() });
    const metricTask = (await tasks(metricLead.proposal.id))[0];
    const done = await request('POST', `/api/demo-view-tasks/${metricTask.id}/done`, { headers: authHeaders() });
    assert.equal(done.status, 200);
    await pool.query(
      `INSERT INTO campaign_touches (lead_id, type, channel, occurred_at, source)
       VALUES ($1, 'opened', 'email', $2, 'system'),
              ($1, 'call_booked', 'phone', $3, 'manual')`,
      [metricLead.lead.id, callAt, new Date(callAt.getTime() + 13 * 24 * 3600 * 1000)]
    );
    const metrics = await request('GET', '/api/demo-view-tasks/metrics', { headers: authHeaders() });
    assert.equal(metrics.status, 200);
    assert.equal(metrics.json.tasks_created, 1);
    assert.equal(metrics.json.tasks_done, 1);
    assert.equal(metrics.json.calls_booked_within_14d, 1);
    await pool.query(
      `UPDATE campaign_touches SET occurred_at = $2 WHERE lead_id = $1 AND type = 'call_booked'`,
      [metricLead.lead.id, new Date(callAt.getTime() + 14 * 24 * 3600 * 1000 + 1000)]
    );
    const late = await request('GET', '/api/demo-view-tasks/metrics', { headers: authHeaders() });
    assert.equal(late.json.calls_booked_within_14d, 0);
    assert.equal(late.json.tasks_created, 1);
  });
});
