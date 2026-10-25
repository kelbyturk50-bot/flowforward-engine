require('./preload');

// Pin flags and the API key before the db client loads dotenv.
process.env.FF_PILOT_ESTIMATE_RECOVERY = '';
process.env.FF_PILOT_LINK_ON_ONEPAGER = '';
process.env.FF_PILOT_ESTIMATE_SMS = '';
process.env.FF_PILOT_ESTIMATE_LIVE_SEND = '';
process.env.CRM_API_KEY = 'test-pilot-csv-key-must-be-32-chars';

const { describe, it, before, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const http = require('http');
const path = require('path');
const express = require('express');

const { applySchema, applyMainSchema, applyEstimateConstraints } = require('../src/db/migrate');
const { resetDb, closePool, pool } = require('./fixtures');
const { MAX_CSV_BYTES, MAX_DATA_ROWS } = require('../src/pilot/estimate-intake');
const kill = require('../src/pilot/kill-switch');

const API_KEY = 'test-pilot-csv-key-must-be-32-chars';
const NOT_FOUND = { error: 'Not found' };

let server;

async function clearFlags() {
  process.env.FF_PILOT_ESTIMATE_RECOVERY = '';
  process.env.FF_PILOT_ESTIMATE_LIVE_SEND = '';
  await pool.query(
    `UPDATE feature_flags
        SET enabled = false, updated_at = NULL, updated_by = NULL
      WHERE name = 'FF_PILOT_ESTIMATE_RECOVERY'`
  );
}

async function flagOn() {
  process.env.FF_PILOT_ESTIMATE_RECOVERY = '';
  await pool.query(
    `UPDATE feature_flags
        SET enabled = true, updated_at = NOW(), updated_by = 'test'
      WHERE name = 'FF_PILOT_ESTIMATE_RECOVERY'`
  );
}

function request(method, reqPath, { headers = {}, body, rawBody, port } = {}) {
  return new Promise((resolve, reject) => {
    const payload = rawBody != null
      ? (Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(rawBody))
      : (body === undefined ? null : Buffer.from(JSON.stringify(body)));
    const req = http.request({
      method,
      hostname: '127.0.0.1',
      port: port || server.address().port,
      path: reqPath,
      headers: {
        ...(payload && rawBody == null ? { 'content-type': 'application/json' } : {}),
        ...(payload ? { 'content-length': String(payload.length) } : {}),
        ...headers,
      },
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch { json = null; }
        resolve({ status: res.statusCode, headers: res.headers, text, json });
      });
    });
    req.on('error', reject);
    if (payload) req.end(payload);
    else req.end();
  });
}

async function estimateCount(customerId) {
  const params = [];
  let sql = 'SELECT COUNT(*)::int AS n FROM pilot_open_estimates';
  if (customerId != null) {
    sql += ' WHERE customer_id = $1';
    params.push(customerId);
  }
  const { rows } = await pool.query(sql, params);
  return rows[0].n;
}

async function customerCount() {
  const { rows } = await pool.query('SELECT COUNT(*)::int AS n FROM pilot_customers');
  return rows[0].n;
}

async function createShop(name = 'TEST: Wasatch Heating') {
  await flagOn();
  const res = await request('POST', '/api/pilot/estimate-recovery/customers', {
    headers: { 'x-api-key': API_KEY },
    body: { name },
  });
  assert.equal(res.status, 201, res.text);
  assert.equal(res.json.liveSendEnabled, false);
  assert.equal(res.json.sendsKilled, true);
  return res.json.id;
}

function postCsv(customerId, csv, { raw = true, headers = {} } = {}) {
  const reqPath = `/api/pilot/estimate-recovery/customers/${customerId}/estimates`;
  if (raw) {
    return request('POST', reqPath, {
      rawBody: csv,
      headers: { 'content-type': 'text/csv', 'x-api-key': API_KEY, ...headers },
    });
  }
  return request('POST', reqPath, {
    body: { csv },
    headers: { 'x-api-key': API_KEY, ...headers },
  });
}

describe('pilot csv estimate intake', () => {
  before(async () => {
    await applySchema();
    await applySchema();
    await resetDb();

    const app = express();
    app.use(express.json({ limit: '1mb' }));
    app.use('/api', require('../src/api/auth'));
    app.use('/api/pilot/estimate-recovery', require('../src/api/pilot-estimates'));
    server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  });

  after(async () => {
    if (server) await new Promise((resolve) => server.close(resolve));
    await closePool();
  });

  afterEach(async () => {
    await clearFlags();
  });

  it('stores the minimum columns, a unique customer/estimate key, and cascade delete', async () => {
    const estimates = await pool.query(
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'pilot_open_estimates'
        ORDER BY ordinal_position`
    );
    assert.deepEqual(estimates.rows.map((row) => row.column_name), [
      'id',
      'customer_id',
      'source_estimate_id',
      'homeowner_first_name',
      'email',
      'job_type',
      'amount',
      'estimate_date',
      'status',
      'created_at',
      'updated_at',
    ]);
    const customers = await pool.query(
      `SELECT column_name, column_default FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'pilot_customers'
        ORDER BY ordinal_position`
    );
    assert.deepEqual(customers.rows.map((row) => row.column_name), [
      'id', 'name', 'live_send_enabled', 'created_at', 'updated_at',
    ]);
    const live = customers.rows.find((row) => row.column_name === 'live_send_enabled');
    assert.match(String(live.column_default), /false/i);

    const index = await pool.query(
      `SELECT i.indisunique
         FROM pg_index i
         JOIN pg_class c ON c.oid = i.indexrelid
        WHERE c.relname = 'idx_pilot_open_estimates_customer_source'`
    );
    assert.equal(index.rows[0].indisunique, true);

    const fk = await pool.query(
      `SELECT confdeltype
         FROM pg_constraint
        WHERE conname = 'pilot_open_estimates_customer_id_fkey'`
    );
    assert.equal(fk.rows[0].confdeltype, 'c');

    const shop = await pool.query(
      `INSERT INTO pilot_customers (name) VALUES ('TEST: Cascade Shop') RETURNING id, live_send_enabled`
    );
    assert.equal(shop.rows[0].live_send_enabled, false);
    await pool.query(
      `INSERT INTO pilot_open_estimates (customer_id, source_estimate_id, email)
       VALUES ($1, 'E-1', 'test+one@example.com'), ($1, 'E-2', 'test+two@example.com')`,
      [shop.rows[0].id]
    );
    await pool.query('DELETE FROM pilot_customers WHERE id = $1', [shop.rows[0].id]);
    assert.equal(await estimateCount(), 0);
    await resetDb();
  });

  it('keeps the global kill engaged unless the env value is exactly true', async () => {
    await clearFlags();
    assert.equal(kill.globalSendKilled(), true);
    assert.equal(kill.customerSendAllowed(true), false);
    for (const value of ['1', 'TRUE', 'True', 'yes', ' true', 'true ', 'off', 'false']) {
      process.env.FF_PILOT_ESTIMATE_LIVE_SEND = value;
      assert.equal(kill.globalSendKilled(), true, value);
      assert.equal(kill.customerSendAllowed(true), false, value);
    }
    process.env.FF_PILOT_ESTIMATE_LIVE_SEND = 'true';
    assert.equal(kill.globalSendKilled(), false);
    assert.equal(kill.customerSendAllowed(false), false);
    assert.equal(kill.customerSendAllowed(true), true);
    const sendSrc = fs.readFileSync(path.join(__dirname, '../src/proposals/send.js'), 'utf8');
    assert.equal(sendSrc.includes('pilot_open_estimates'), false);
    assert.equal(sendSrc.includes('kill-switch'), false);
    const routeSrc = fs.readFileSync(path.join(__dirname, '../src/api/pilot-estimates.js'), 'utf8');
    assert.equal(routeSrc.includes('sendMail'), false);
    assert.equal(routeSrc.includes('nodemailer'), false);
    const serverSrc = fs.readFileSync(path.join(__dirname, '../src/server.js'), 'utf8');
    assert.equal(serverSrc.includes("'/api/pilot/estimate-recovery'"), true);
  });

  it('returns 404 and writes nothing when the master flag is off', async () => {
    await clearFlags();
    const csv = 'estimate_id,email\nE-9,test+off@example.com\n';
    const post = await request('POST', '/api/pilot/estimate-recovery/customers/1/estimates', {
      rawBody: csv,
      headers: { 'content-type': 'text/csv', 'x-api-key': API_KEY },
    });
    assert.equal(post.status, 404);
    assert.deepEqual(post.json, NOT_FOUND);
    assert.equal(post.headers['cache-control'], 'no-store');

    const created = await request('POST', '/api/pilot/estimate-recovery/customers', {
      headers: { 'x-api-key': API_KEY },
      body: { name: 'TEST: Should Not Insert' },
    });
    assert.equal(created.status, 404);
    assert.equal(await customerCount(), 0);
    assert.equal(await estimateCount(), 0);

    const shop = await pool.query(
      `INSERT INTO pilot_customers (name) VALUES ('TEST: Flag Off Shop') RETURNING id`
    );
    await pool.query(
      `INSERT INTO pilot_open_estimates (customer_id, source_estimate_id, email)
       VALUES ($1, 'E-KEEP', 'test+keep@example.com')`,
      [shop.rows[0].id]
    );
    await clearFlags();
    const remove = await request('DELETE', `/api/pilot/estimate-recovery/customers/${shop.rows[0].id}/estimates`, {
      headers: { 'x-api-key': API_KEY },
    });
    assert.equal(remove.status, 404);
    const listed = await request('GET', `/api/pilot/estimate-recovery/customers/${shop.rows[0].id}/estimates`, {
      headers: { 'x-api-key': API_KEY },
    });
    assert.equal(listed.status, 404);
    assert.equal(await estimateCount(shop.rows[0].id), 1);

    for (const value of ['1', 'TRUE', 'yes', 'true ']) {
      process.env.FF_PILOT_ESTIMATE_RECOVERY = value;
      const again = await postCsv(shop.rows[0].id, 'estimate_id,email\nE-NEW,test+new@example.com\n');
      assert.equal(again.status, 404, value);
    }
    assert.equal(await estimateCount(shop.rows[0].id), 1);
    await resetDb();
  });

  it('requires the API key and does not write without it', async () => {
    await flagOn();
    const shop = await pool.query(
      `INSERT INTO pilot_customers (name) VALUES ('TEST: Auth Shop') RETURNING id`
    );
    await pool.query(
      `INSERT INTO pilot_open_estimates (customer_id, source_estimate_id, email)
       VALUES ($1, 'E-KEEP', 'test+keep@example.com')`,
      [shop.rows[0].id]
    );
    const csv = 'estimate_id,email\nE-NEW,test+new@example.com\n';
    const missing = await request('POST', `/api/pilot/estimate-recovery/customers/${shop.rows[0].id}/estimates`, {
      rawBody: csv,
      headers: { 'content-type': 'text/csv' },
    });
    assert.equal(missing.status, 401);
    const wrong = await postCsv(shop.rows[0].id, csv, { headers: { 'x-api-key': 'wrong-key-wrong-key-wrong-key-xxxx' } });
    assert.equal(wrong.status, 401);
    const getMissing = await request('GET', `/api/pilot/estimate-recovery/customers/${shop.rows[0].id}/estimates`);
    assert.equal(getMissing.status, 401);
    const delWrong = await request('DELETE', `/api/pilot/estimate-recovery/customers/${shop.rows[0].id}/estimates`, {
      headers: { 'x-api-key': 'wrong-key-wrong-key-wrong-key-xxxx' },
    });
    assert.equal(delWrong.status, 401);
    assert.equal(await estimateCount(shop.rows[0].id), 1);
    const emails = await pool.query(
      'SELECT email FROM pilot_open_estimates WHERE customer_id = $1',
      [shop.rows[0].id]
    );
    assert.deepEqual(emails.rows.map((row) => row.email), ['test+keep@example.com']);
    await resetDb();
  });

  it('refuses to turn live send on', async () => {
    await flagOn();
    const blocked = await request('POST', '/api/pilot/estimate-recovery/customers', {
      headers: { 'x-api-key': API_KEY },
      body: { name: 'TEST: Enable Sends', liveSendEnabled: true },
    });
    assert.equal(blocked.status, 400);
    assert.equal(blocked.json.error, 'live_send_locked');
    const snake = await request('POST', '/api/pilot/estimate-recovery/customers', {
      headers: { 'x-api-key': API_KEY },
      body: { name: 'TEST: Enable Sends', live_send_enabled: 'true' },
    });
    assert.equal(snake.status, 400);
    for (const value of [1, '1', 'TRUE', 'yes', 'false', {}, [true]]) {
      const bad = await request('POST', '/api/pilot/estimate-recovery/customers', {
        headers: { 'x-api-key': API_KEY },
        body: { name: 'TEST: Bad Live Send', liveSendEnabled: value },
      });
      assert.equal(bad.status, 400, JSON.stringify(value));
      assert.equal(bad.json.error, 'live_send_locked');
    }
    const stringFalse = await request('POST', '/api/pilot/estimate-recovery/customers', {
      headers: { 'x-api-key': API_KEY },
      body: { name: 'TEST: Bad Live Send', live_send_enabled: 'false' },
    });
    assert.equal(stringFalse.status, 400);
    assert.equal(await customerCount(), 0);
    const explicit = await request('POST', '/api/pilot/estimate-recovery/customers', {
      headers: { 'x-api-key': API_KEY },
      body: { name: 'TEST: Explicit Off', liveSendEnabled: false },
    });
    assert.equal(explicit.status, 201, explicit.text);
    assert.equal(explicit.json.liveSendEnabled, false);
    const id = await createShop();
    const row = await pool.query('SELECT live_send_enabled FROM pilot_customers WHERE id = $1', [id]);
    assert.equal(row.rows[0].live_send_enabled, false);
    await resetDb();
  });

  it('reports per-row validation errors and stores only valid rows', async () => {
    await flagOn();
    const id = await createShop();
    const longJob = 'J'.repeat(81);
    const longName = 'N'.repeat(61);
    const csv = [
      'estimate_id,first_name,email,job_type,amount,estimate_date,status,notes',
      'E-100,Ada,test+ada@example.com,AC replacement,4200.50,2026-09-01,open,secret note about the dog',
      'E-101,Bea,nope,Furnace,100,2026-09-02,open,',
      ',Cy,test+cy@example.com,Coil,50,2026-09-03,open,',
      'E-102,Dee,test+dee@example.com,Coil,50,2026-02-31,open,',
      'E-103,Ed,test+ed@example.com,Coil,$50,2026-09-04,open,',
      'E-104,Fay,test+fay@example.com,Coil,50,2026-09-05,pending,',
      `E-105,Gil,test+gil@example.com,${longJob},10,2026-09-06,open,`,
      `E-106,${longName},test+nan@example.com,Coil,10,2026-09-07,Open,`,
    ].join('\n');
    const res = await postCsv(id, csv);
    assert.equal(res.status, 200, res.text);
    assert.equal(res.json.received, 8);
    assert.equal(res.json.upserted, 1);
    const fields = res.json.errors.map((error) => `${error.row}:${error.field}`).sort();
    assert.deepEqual(fields, [
      '3:email',
      '4:estimate_id',
      '5:estimate_date',
      '6:amount',
      '7:status',
      '8:job_type',
      '9:first_name',
    ]);
    const { rows } = await pool.query(
      `SELECT source_estimate_id, homeowner_first_name, email, job_type, amount::text AS amount,
              estimate_date::text AS estimate_date, status
         FROM pilot_open_estimates WHERE customer_id = $1`,
      [id]
    );
    assert.equal(rows.length, 1);
    assert.equal(rows[0].source_estimate_id, 'E-100');
    assert.equal(rows[0].homeowner_first_name, 'Ada');
    assert.equal(rows[0].email, 'test+ada@example.com');
    assert.equal(rows[0].job_type, 'AC replacement');
    assert.equal(rows[0].amount, '4200.50');
    assert.equal(rows[0].estimate_date, '2026-09-01');
    assert.equal(rows[0].status, 'open');
    assert.equal(JSON.stringify(rows).includes('secret note'), false);
    assert.equal(JSON.stringify(rows).includes('dog'), false);
    await resetDb();
  });

  it('rejects a file that is missing columns, too large, or too long without writing', async () => {
    await flagOn();
    const id = await createShop();
    const missing = await postCsv(id, 'first_name,job_type\nAda,Coil\n');
    assert.equal(missing.status, 400);
    assert.deepEqual(missing.json.columns, ['estimate_id', 'email']);
    const broken = await postCsv(id, 'estimate_id,email\n"E-1,test+a@example.com\n');
    assert.equal(broken.status, 400);
    assert.equal(broken.json.error, 'invalid_csv');

    const tooBig = `estimate_id,email\n${'x'.repeat(MAX_CSV_BYTES)}`;
    const sized = await postCsv(id, tooBig);
    assert.equal(sized.status, 413);
    const jsonSized = await postCsv(id, tooBig, { raw: false });
    assert.equal(jsonSized.status, 413);

    let many = 'estimate_id,email\n';
    for (let i = 0; i < MAX_DATA_ROWS + 1; i++) many += `E-${i},test+row${i}@example.com\n`;
    const tooMany = await postCsv(id, many);
    assert.equal(tooMany.status, 400);
    assert.equal(tooMany.json.error, 'too_many_rows');
    assert.equal(await estimateCount(id), 0);

    const absent = await postCsv(999999, 'estimate_id,email\nE-1,test+a@example.com\n');
    assert.equal(absent.status, 404);
    assert.equal(await estimateCount(), 0);
    await resetDb();
  });

  it('upserts the same source estimate id and keeps another customer separate', async () => {
    await flagOn();
    const first = await createShop('TEST: Wasatch Heating');
    const second = await createShop('TEST: Other Heating');
    const initial = [
      'estimate_id,first_name,email,job_type,amount,estimate_date,status',
      'E-100,Ada,test+ada@example.com,"AC, replacement",4200.50,2026-09-01,Open',
      'E-100,Ignored,test+ada@example.com,Coil,1,2026-09-02,open',
    ].join('\n');
    const uploaded = await postCsv(first, initial, { raw: false });
    assert.equal(uploaded.status, 200, uploaded.text);
    assert.equal(uploaded.json.received, 2);
    assert.equal(uploaded.json.upserted, 1);
    assert.equal(await estimateCount(first), 1);

    const before = await pool.query(
      `SELECT id, created_at, homeowner_first_name, job_type, amount::text AS amount, status
         FROM pilot_open_estimates WHERE customer_id = $1`,
      [first]
    );
    assert.equal(before.rows[0].homeowner_first_name, 'Ignored');
    assert.equal(before.rows[0].job_type, 'Coil');
    assert.equal(before.rows[0].status, 'open');

    const again = await postCsv(first, [
      'Estimate ID,First Name,Email,Job Type,Amount,Estimate Date,Status',
      'E-100,Ann,test+ann@example.com,Furnace,4300,2026-10-01,sold',
    ].join('\n'));
    assert.equal(again.status, 200, again.text);
    assert.equal(again.json.upserted, 1);
    assert.equal(await estimateCount(first), 1);

    const after = await pool.query(
      `SELECT id, created_at, homeowner_first_name, email, job_type, amount::text AS amount,
              estimate_date::text AS estimate_date, status
         FROM pilot_open_estimates WHERE customer_id = $1`,
      [first]
    );
    assert.equal(after.rows.length, 1);
    assert.equal(after.rows[0].id, before.rows[0].id);
    assert.equal(new Date(after.rows[0].created_at).toISOString(), new Date(before.rows[0].created_at).toISOString());
    assert.equal(after.rows[0].homeowner_first_name, 'Ann');
    assert.equal(after.rows[0].email, 'test+ann@example.com');
    assert.equal(after.rows[0].job_type, 'Furnace');
    assert.equal(Number(after.rows[0].amount), 4300);
    assert.equal(after.rows[0].estimate_date, '2026-10-01');
    assert.equal(after.rows[0].status, 'sold');

    const other = await postCsv(second, 'estimate_id,email,first_name\nE-100,test+other@example.com,Bea\n');
    assert.equal(other.status, 200, other.text);
    assert.equal(await estimateCount(second), 1);
    assert.equal(await estimateCount(), 2);

    const quoted = [
      'estimate_id,email,job_type',
      'E-7,test+quote@example.com,"AC',
      'replacement"',
      'E-8,not-an-email,Coil',
    ].join('\n');
    const quoteRes = await postCsv(second, quoted);
    assert.equal(quoteRes.status, 200, quoteRes.text);
    assert.equal(quoteRes.json.upserted, 1);
    assert.ok(quoteRes.json.errors.some((error) => error.row === 4 && error.field === 'email'));
    const job = await pool.query(
      `SELECT job_type FROM pilot_open_estimates
        WHERE customer_id = $1 AND source_estimate_id = 'E-7'`,
      [second]
    );
    assert.equal(job.rows[0].job_type, 'AC replacement');
    await resetDb();
  });

  it('exports one customer and deletes only that customer\'s estimates', async () => {
    await flagOn();
    const first = await createShop('TEST: Export Shop');
    const second = await createShop('TEST: Keep Shop');
    await postCsv(first, [
      'estimate_id,first_name,email,amount,status',
      'E-100,Ada,test+ada@example.com,4200.50,open',
      'E-200,Bea,test+bea@example.com,,lost',
    ].join('\n'));
    await postCsv(second, 'estimate_id,email\nE-100,test+keep@example.com\n');

    const exported = await request('GET', `/api/pilot/estimate-recovery/customers/${first}/estimates`, {
      headers: { 'x-api-key': API_KEY, authorization: 'Bearer wrong' },
    });
    assert.equal(exported.status, 200, exported.text);
    assert.equal(exported.headers['cache-control'], 'no-store');
    assert.deepEqual(exported.json.estimates.map((row) => row.sourceEstimateId), ['E-100', 'E-200']);
    assert.equal(exported.json.estimates[0].firstName, 'Ada');
    assert.equal(exported.json.estimates[0].email, 'test+ada@example.com');
    assert.equal(exported.json.estimates[0].amount, '4200.50');
    assert.equal(exported.json.estimates[1].amount, null);
    assert.equal(exported.json.estimates[1].status, 'lost');
    assert.equal(JSON.stringify(exported.json).includes('test+keep@example.com'), false);

    const bearer = await request('GET', `/api/pilot/estimate-recovery/customers/${first}/estimates?format=csv`, {
      headers: { authorization: `Bearer ${API_KEY}` },
    });
    assert.equal(bearer.status, 200, bearer.text);
    assert.match(bearer.headers['content-type'], /text\/csv/);
    assert.match(bearer.headers['content-disposition'], new RegExp(`estimates-${first}\\.csv`));
    assert.match(bearer.text, /estimate_id,first_name,email/);
    assert.match(bearer.text, /,Ada,/);
    assert.equal(bearer.text.includes('test+keep@example.com'), false);

    const replay = await postCsv(first, bearer.text);
    assert.equal(replay.status, 200, replay.text);
    assert.equal(replay.json.errors.length, 0);
    assert.equal(await estimateCount(first), 2);
    const replayed = await pool.query(
      `SELECT homeowner_first_name FROM pilot_open_estimates
        WHERE customer_id = $1 AND source_estimate_id = 'E-100'`,
      [first]
    );
    assert.equal(replayed.rows[0].homeowner_first_name, 'Ada');

    const removed = await request('DELETE', `/api/pilot/estimate-recovery/customers/${first}/estimates`, {
      headers: { 'x-api-key': API_KEY },
    });
    assert.equal(removed.status, 200, removed.text);
    assert.equal(removed.json.deleted, 2);
    assert.equal(await estimateCount(first), 0);
    assert.equal(await estimateCount(second), 1);
    const shops = await pool.query('SELECT id, live_send_enabled FROM pilot_customers ORDER BY id');
    assert.equal(shops.rows.length, 2);
    assert.equal(shops.rows.every((row) => row.live_send_enabled === false), true);

    const again = await request('DELETE', `/api/pilot/estimate-recovery/customers/${first}/estimates`, {
      headers: { 'x-api-key': API_KEY },
    });
    assert.equal(again.status, 200);
    assert.equal(again.json.deleted, 0);
    assert.equal(await estimateCount(second), 1);
    await resetDb();
  });

  it('prefixes spreadsheet formulas on export and rejects them on intake', async () => {
    await flagOn();
    const id = await createShop('TEST: Formula Shop');
    const csv = [
      'estimate_id,first_name,email,job_type',
      'E-OK,=Ada,test+ada@example.com,Coil',
      'E-ANN,-Ann,test+ann@example.com,Coil',
      'E-FW,＝Bea,test+bea-fw@example.com,Coil',
      '=E5,Bea,test+bea@example.com,Coil',
      'E-PLUS,Cy,+f@example.com,Coil',
      'E-MINUS,Dee,-e@example.com,Coil',
      'E-JOB,Fay,test+fay@example.com,=cmd|\' /C calc\'!A0',
      'E-HYPER,Gil,test+gil@example.com,-HYPERLINK(1)',
      'E-SUM,Hal,test+hal@example.com,+SUM(1)',
      'E-FWJOB,Ida,test+ida@example.com,＝1+1',
      'E-SMJOB,Jo,test+jo@example.com,﹦1',
    ].join('\n');
    const uploaded = await postCsv(id, csv);
    assert.equal(uploaded.status, 200, uploaded.text);
    assert.equal(uploaded.json.upserted, 3);
    const fields = uploaded.json.errors.map((error) => `${error.field}`).sort();
    assert.deepEqual(fields, [
      'email', 'email', 'estimate_id',
      'job_type', 'job_type', 'job_type', 'job_type', 'job_type',
    ]);
    const stored = await pool.query(
      `SELECT source_estimate_id, homeowner_first_name, email, job_type
         FROM pilot_open_estimates WHERE customer_id = $1`,
      [id]
    );
    assert.equal(stored.rows.length, 3);
    const byId = Object.fromEntries(stored.rows.map((row) => [row.source_estimate_id, row]));
    assert.equal(byId['E-OK'].homeowner_first_name, 'Ada');
    assert.equal(byId['E-OK'].email, 'test+ada@example.com');
    assert.equal(byId['E-ANN'].homeowner_first_name, 'Ann');
    assert.equal(byId['E-FW'].homeowner_first_name, 'Bea');
    assert.equal(JSON.stringify(stored.rows).includes('=cmd'), false);
    assert.equal(JSON.stringify(stored.rows).includes('HYPERLINK'), false);

    await pool.query(
      `INSERT INTO pilot_open_estimates
         (customer_id, source_estimate_id, homeowner_first_name, email, job_type)
       VALUES
         ($1, 'E-NAME', '=Ada', 'test+name@example.com', 'Coil'),
         ($1, 'E-PLUSJ', 'Bea', 'test+plus@example.com', '+SUM(1)'),
         ($1, 'E-MINUSJ', 'Cy', 'test+minus@example.com', '-HYPERLINK(1)'),
         ($1, 'E-AT', 'Dee', 'test+at@example.com', '@mention'),
         ($1, 'E-TAB', 'Fay', $2, 'Coil'),
         ($1, 'E-CR', 'Gil', $3, 'Coil'),
         ($1, 'E-FWEQ', $4, 'test+fweq@example.com', 'Coil'),
         ($1, 'E-FWPLUS', 'Bea', 'test+fwplus@example.com', $5),
         ($1, 'E-FWMINUS', 'Cy', 'test+fwminus@example.com', $6),
         ($1, 'E-FWAT', 'Dee', 'test+fwat@example.com', $7),
         ($1, 'E-SMALL', 'Fay', 'test+small@example.com', $8),
         ($1, 'E-LEAD', $9, 'test+lead@example.com', 'Coil')`,
      [
        id,
        '\tuser@example.com',
        '\ruser@example.com',
        '＝Ada',
        '＋Coil',
        '－x',
        '＠mention',
        '﹦1',
        ' \u3000＝1+1',
      ]
    );
    const exported = await request('GET', `/api/pilot/estimate-recovery/customers/${id}/estimates?format=csv`, {
      headers: { 'x-api-key': API_KEY },
    });
    assert.equal(exported.status, 200, exported.text);
    assert.match(exported.text, /"'=Ada"/);
    assert.match(exported.text, /"'\+SUM\(1\)"/);
    assert.match(exported.text, /"'-HYPERLINK\(1\)"/);
    assert.match(exported.text, /"'@mention"/);
    assert.match(exported.text, /"'\tuser@example.com"/);
    assert.match(exported.text, /"'\ruser@example.com"/);
    assert.match(exported.text, /"'＝Ada"/);
    assert.match(exported.text, /"'＋Coil"/);
    assert.match(exported.text, /"'－x"/);
    assert.match(exported.text, /"'＠mention"/);
    assert.match(exported.text, /"'﹦1"/);
    assert.match(exported.text, /"' \u3000＝1\+1"/);
    assert.equal(/(^|,)=Ada(,|\n)/.test(exported.text), false);
    assert.equal(/(^|,)\+SUM/.test(exported.text), false);
    assert.equal(/(^|,)＝Ada(,|\n)/.test(exported.text), false);
    assert.equal(/(^|,)＋Coil/.test(exported.text), false);
    assert.equal(/(^|,)－x/.test(exported.text), false);
    assert.equal(/(^|,)＠mention/.test(exported.text), false);
    await resetDb();
  });

  it('keeps opted_out across re-upload and estimate delete', async () => {
    await flagOn();
    const shop = await createShop('TEST: Opt Out Shop');
    const other = await createShop('TEST: Other Shop');
    const first = await postCsv(shop, [
      'estimate_id,first_name,email,status',
      'E-4,Ada,test+e4@example.com,opted_out',
      'E-8,Bea,test+e8@example.com,opted_out',
      'E-1,Cy,test+open@example.com,open',
    ].join('\n'));
    assert.equal(first.status, 200, first.text);
    assert.equal(first.json.upserted, 3);

    const again = await postCsv(shop, [
      'estimate_id,email',
      'E-4,test+e4@example.com',
      'E-8,test+e8@example.com',
    ].join('\n'));
    assert.equal(again.status, 200, again.text);
    const stuck = await pool.query(
      `SELECT source_estimate_id, status FROM pilot_open_estimates
        WHERE customer_id = $1 AND source_estimate_id IN ('E-4', 'E-8')
        ORDER BY source_estimate_id`,
      [shop]
    );
    assert.deepEqual(stuck.rows.map((row) => row.status), ['opted_out', 'opted_out']);

    const renamed = await postCsv(shop, 'estimate_id,email\nE-4,test+renamed@example.com\n');
    assert.equal(renamed.status, 200, renamed.text);
    const renamedRow = await pool.query(
      `SELECT status, email FROM pilot_open_estimates
        WHERE customer_id = $1 AND source_estimate_id = 'E-4'`,
      [shop]
    );
    assert.equal(renamedRow.rows[0].status, 'opted_out');
    assert.equal(renamedRow.rows[0].email, 'test+renamed@example.com');

    const removed = await request('DELETE', `/api/pilot/estimate-recovery/customers/${shop}/estimates`, {
      headers: { 'x-api-key': API_KEY },
    });
    assert.equal(removed.json.deleted, 3);
    assert.equal(await estimateCount(shop), 0);
    const kept = await pool.query(
      `SELECT email FROM pilot_estimate_suppressions WHERE customer_id = $1 ORDER BY email`,
      [shop]
    );
    assert.deepEqual(kept.rows.map((row) => row.email), [
      'test+e4@example.com',
      'test+e8@example.com',
      'test+renamed@example.com',
    ]);

    const returned = await postCsv(shop, [
      'estimate_id,email,status',
      'E-9,test+e4@example.com,open',
      'E-10,test+e8@example.com,sold',
      'E-11,test+fresh@example.com,open',
    ].join('\n'));
    assert.equal(returned.status, 200, returned.text);
    const after = await pool.query(
      `SELECT source_estimate_id, status FROM pilot_open_estimates
        WHERE customer_id = $1 ORDER BY source_estimate_id`,
      [shop]
    );
    assert.deepEqual(after.rows.map((row) => [row.source_estimate_id, row.status]), [
      ['E-10', 'opted_out'],
      ['E-11', 'open'],
      ['E-9', 'opted_out'],
    ]);

    const elsewhere = await postCsv(other, 'estimate_id,email,status\nE-4,test+e4@example.com,open\n');
    assert.equal(elsewhere.status, 200, elsewhere.text);
    const otherRow = await pool.query(
      `SELECT status FROM pilot_open_estimates WHERE customer_id = $1 AND source_estimate_id = 'E-4'`,
      [other]
    );
    assert.equal(otherRow.rows[0].status, 'open');
    const otherList = await pool.query(
      'SELECT COUNT(*)::int AS n FROM pilot_estimate_suppressions WHERE customer_id = $1',
      [other]
    );
    assert.equal(otherList.rows[0].n, 0);

    await pool.query(
      `ALTER TABLE pilot_estimate_suppressions
         ADD CONSTRAINT pilot_estimate_suppressions_customer_id_fkey
         FOREIGN KEY (customer_id) REFERENCES pilot_customers(id) ON DELETE CASCADE`
    );
    const repaired = await applyEstimateConstraints();
    assert.equal(repaired.errors.length, 0);
    const fk = await pool.query(
      `SELECT conname FROM pg_constraint
        WHERE conname = 'pilot_estimate_suppressions_customer_id_fkey'`
    );
    assert.equal(fk.rows.length, 0);

    await pool.query('DELETE FROM pilot_customers WHERE id = $1', [shop]);
    assert.equal(await estimateCount(shop), 0);
    const retained = await pool.query(
      `SELECT email FROM pilot_estimate_suppressions WHERE customer_id = $1 ORDER BY email`,
      [shop]
    );
    assert.deepEqual(retained.rows.map((row) => row.email), [
      'test+e4@example.com',
      'test+e8@example.com',
      'test+renamed@example.com',
    ]);
    const reborn = await pool.query(
      `INSERT INTO pilot_customers (name) VALUES ('TEST: Opt Out Shop') RETURNING id`
    );
    assert.notEqual(reborn.rows[0].id, shop);
    const inherited = await pool.query(
      'SELECT COUNT(*)::int AS n FROM pilot_estimate_suppressions WHERE customer_id = $1',
      [reborn.rows[0].id]
    );
    assert.equal(inherited.rows[0].n, 0);
    await resetDb();
  });

  it('rejects bidi, zero-width, and C1 characters in names and job types', async () => {
    await flagOn();
    const id = await createShop('TEST: Bidi Shop');
    const csv = [
      'estimate_id,first_name,email,job_type',
      `E-1,Bob\u202Eevil,test+bidi@example.com,Coil`,
      `E-2,Ada,test+zw@example.com,Coil\u200B`,
      `E-3,Cy,test+c1@example.com,Furnace\u0085`,
      `E-4,Fay\u2066,test+iso@example.com,Coil`,
      `E-5,Gil\uFEFF,test+bom@example.com,Coil`,
      'E-6,Hal,test+ok@example.com,Coil',
    ].join('\n');
    const uploaded = await postCsv(id, csv);
    assert.equal(uploaded.status, 200, uploaded.text);
    assert.equal(uploaded.json.upserted, 1);
    assert.deepEqual(
      uploaded.json.errors.map((error) => `${error.row}:${error.field}`).sort(),
      ['2:first_name', '3:job_type', '4:job_type', '5:first_name', '6:first_name']
    );
    const names = await pool.query(
      'SELECT source_estimate_id, homeowner_first_name FROM pilot_open_estimates WHERE customer_id = $1',
      [id]
    );
    assert.equal(names.rows.length, 1);
    assert.equal(names.rows[0].source_estimate_id, 'E-6');
    assert.equal(names.rows[0].homeowner_first_name, 'Hal');

    await assert.rejects(
      pool.query(
        `INSERT INTO pilot_open_estimates (customer_id, source_estimate_id, email, homeowner_first_name)
         VALUES ($1, 'E-BAD', 'test+bad@example.com', $2)`,
        [id, 'Bob\u202E']
      ),
      (err) => err.code === '23514'
    );
    await assert.rejects(
      pool.query(
        `INSERT INTO pilot_open_estimates (customer_id, source_estimate_id, email, job_type)
         VALUES ($1, 'E-JOB', 'test+job@example.com', $2)`,
        [id, 'Coil\u200B']
      ),
      (err) => err.code === '23514'
    );
    await assert.rejects(
      pool.query(
        `INSERT INTO pilot_open_estimates (customer_id, source_estimate_id, email, job_type)
         VALUES ($1, 'E-C1', 'test+c1b@example.com', $2)`,
        [id, 'Coil\u0080']
      ),
      (err) => err.code === '23514'
    );
    await resetDb();
  });

  it('returns 503 and writes nothing when CRM_API_KEY is missing or shorter than 32 characters', async () => {
    const previous = process.env.CRM_API_KEY;
    try {
      await flagOn();
      process.env.CRM_API_KEY = '';
      const missing = await request('POST', '/api/pilot/estimate-recovery/customers', {
        headers: { 'x-api-key': API_KEY },
        body: { name: 'TEST: Missing Key' },
      });
      assert.equal(missing.status, 503);
      assert.deepEqual(missing.json, { error: 'api_key_not_configured' });

      process.env.CRM_API_KEY = 'x'.repeat(31);
      const short = await request('POST', '/api/pilot/estimate-recovery/customers', {
        headers: { 'x-api-key': API_KEY },
        body: { name: 'TEST: Short Key' },
      });
      assert.equal(short.status, 503);
      assert.deepEqual(short.json, { error: 'api_key_not_configured' });
      assert.equal(await customerCount(), 0);

      process.env.CRM_API_KEY = ' '.repeat(32);
      const spaces = await request('POST', '/api/pilot/estimate-recovery/customers', {
        headers: { 'x-api-key': API_KEY },
        body: { name: 'TEST: Spaces Key' },
      });
      assert.equal(spaces.status, 503);
      assert.deepEqual(spaces.json, { error: 'api_key_not_configured' });
      assert.equal(await customerCount(), 0);

      process.env.CRM_API_KEY = `${'x'.repeat(31)} `;
      const trailing = await request('POST', '/api/pilot/estimate-recovery/customers', {
        headers: { 'x-api-key': API_KEY },
        body: { name: 'TEST: Trailing Space Key' },
      });
      assert.equal(trailing.status, 503);
      assert.deepEqual(trailing.json, { error: 'api_key_not_configured' });
      assert.equal(await customerCount(), 0);

      process.env.CRM_API_KEY = 'y'.repeat(32);
      const ready = await request('POST', '/api/pilot/estimate-recovery/customers', {
        headers: { 'x-api-key': 'y'.repeat(32) },
        body: { name: 'TEST: Ready Key' },
      });
      assert.equal(ready.status, 201, ready.text);
      await resetDb();

      process.env.CRM_API_KEY = '';
      const authPath = require.resolve('../src/api/auth');
      delete require.cache[authPath];
      const openAuth = require(authPath);
      const app = express();
      app.use(express.json({ limit: '1mb' }));
      app.use('/api', openAuth);
      app.use('/api/pilot/estimate-recovery', require('../src/api/pilot-estimates'));
      const extra = http.createServer(app);
      await new Promise((resolve) => extra.listen(0, '127.0.0.1', resolve));
      try {
        const port = extra.address().port;
        const shop = await pool.query(
          `INSERT INTO pilot_customers (name) VALUES ('TEST: Unlocked Shop') RETURNING id`
        );
        await pool.query(
          `INSERT INTO pilot_open_estimates (customer_id, source_estimate_id, email)
           VALUES ($1, 'E-KEEP', 'test+keep@example.com')`,
          [shop.rows[0].id]
        );
        const csv = 'estimate_id,email\nE-NEW,test+new@example.com\n';
        const created = await request('POST', '/api/pilot/estimate-recovery/customers', {
          port,
          body: { name: 'TEST: No Key Shop' },
        });
        const posted = await request('POST', `/api/pilot/estimate-recovery/customers/${shop.rows[0].id}/estimates`, {
          port,
          rawBody: csv,
          headers: { 'content-type': 'text/csv' },
        });
        const listed = await request('GET', `/api/pilot/estimate-recovery/customers/${shop.rows[0].id}/estimates`, { port });
        const removed = await request('DELETE', `/api/pilot/estimate-recovery/customers/${shop.rows[0].id}/estimates`, { port });
        for (const res of [created, posted, listed, removed]) {
          assert.equal(res.status, 503);
          assert.deepEqual(res.json, { error: 'api_key_not_configured' });
        }
        assert.equal(await customerCount(), 1);
        assert.equal(await estimateCount(shop.rows[0].id), 1);
      } finally {
        await new Promise((resolve) => extra.close(resolve));
      }
    } finally {
      process.env.CRM_API_KEY = previous;
      const authPath = require.resolve('../src/api/auth');
      delete require.cache[authPath];
      require(authPath);
      await resetDb();
    }
  });

  it('boots when a legacy hostile name is already stored', async () => {
    const schema = fs.readFileSync(path.join(__dirname, '../src/db/schema.sql'), 'utf8');
    const repairSql = fs.readFileSync(path.join(__dirname, '../src/db/estimate-constraints.sql'), 'utf8');
    const migrate = fs.readFileSync(path.join(__dirname, '../src/db/migrate.js'), 'utf8');
    const allowedDrop = 'DROP CONSTRAINT IF EXISTS prospects_do_not_contact_source_check;';
    const schemaWithoutTagUpgrade = schema.replace(
      /-- BEGIN chat_demo_sessions_tag_check upgrade[\s\S]*?-- END chat_demo_sessions_tag_check upgrade/,
      ''
    );
    assert.match(schema, /DROP CONSTRAINT IF EXISTS chat_demo_sessions_tag_check/);
    assert.equal(schemaWithoutTagUpgrade.split(allowedDrop).length - 1, 1);
    const schemaWithoutAllowedDrop = schemaWithoutTagUpgrade.replace(allowedDrop, '');
    assert.equal(/DROP\s+CONSTRAINT/i.test(schemaWithoutAllowedDrop), false);
    assert.equal(/VALIDATE CONSTRAINT/.test(schema), false);
    assert.match(
      schema,
      /ADD CONSTRAINT pilot_open_estimates_name_hostile_check CHECK \([\s\S]*?\) NOT VALID;/
    );
    assert.match(
      schema,
      /ADD CONSTRAINT pilot_open_estimates_job_hostile_check CHECK \([\s\S]*?\) NOT VALID;/
    );
    assert.match(repairSql, /VALIDATE CONSTRAINT pilot_open_estimates_name_hostile_check/);
    assert.match(repairSql, /VALIDATE CONSTRAINT pilot_open_estimates_job_hostile_check/);
    assert.match(repairSql, /pilot_estimates: name check validation failed/);
    assert.match(migrate, /applyEstimateConstraints/);
    assert.match(migrate, /estimate-constraints\.sql/);

    await resetDb();
    await pool.query(`
      ALTER TABLE pilot_open_estimates DROP CONSTRAINT IF EXISTS pilot_open_estimates_name_hostile_check;
      ALTER TABLE pilot_open_estimates DROP CONSTRAINT IF EXISTS pilot_open_estimates_job_hostile_check;
      ALTER TABLE pilot_open_estimates DROP CONSTRAINT pilot_open_estimates_name_check;
      ALTER TABLE pilot_open_estimates ADD CONSTRAINT pilot_open_estimates_name_check CHECK (
        homeowner_first_name IS NULL OR (
          char_length(homeowner_first_name) BETWEEN 1 AND 60
          AND homeowner_first_name !~ '[[:cntrl:]]'
          AND position('@' IN homeowner_first_name) = 0
        )
      );
      ALTER TABLE pilot_open_estimates DROP CONSTRAINT pilot_open_estimates_job_check;
      ALTER TABLE pilot_open_estimates ADD CONSTRAINT pilot_open_estimates_job_check CHECK (
        job_type IS NULL OR (
          char_length(job_type) BETWEEN 1 AND 80
          AND job_type !~ '[[:cntrl:]]'
        )
      );
    `);
    await pool.query('DROP TABLE IF EXISTS pilot_estimate_suppressions');

    const shop = await pool.query(
      `INSERT INTO pilot_customers (name) VALUES ('TEST: Legacy Shop') RETURNING id`
    );
    const legacyName = 'Bob\u202Eevil';
    await pool.query(
      `INSERT INTO pilot_open_estimates
         (customer_id, source_estimate_id, email, homeowner_first_name)
       VALUES ($1, 'E-LEGACY', 'test+legacy@example.com', $2)`,
      [shop.rows[0].id, legacyName]
    );

    await applyMainSchema();
    const created = await pool.query(
      `SELECT to_regclass('public.pilot_estimate_suppressions') AS rel`
    );
    assert.notEqual(created.rows[0].rel, null);
    const kept = await pool.query(
      `SELECT homeowner_first_name FROM pilot_open_estimates
        WHERE source_estimate_id = 'E-LEGACY'`
    );
    assert.equal(kept.rows[0].homeowner_first_name, legacyName);

    const repair = await applyEstimateConstraints();
    assert.equal(repair.errors.length, 0);
    const notes = repair.notices.join('\n');
    assert.match(notes, /name check validation failed/);
    assert.equal(notes.includes('Bob'), false);
    assert.equal(notes.includes('\u202E'), false);
    assert.equal(notes.includes('test+legacy'), false);
    assert.equal(notes.includes(String(shop.rows[0].id)), false);

    const checks = await pool.query(
      `SELECT conname, convalidated
         FROM pg_constraint
        WHERE conname = 'pilot_open_estimates_name_hostile_check'`
    );
    assert.equal(checks.rows.length, 1);
    assert.equal(checks.rows[0].convalidated, false);

    await assert.rejects(
      pool.query(
        `INSERT INTO pilot_open_estimates
           (customer_id, source_estimate_id, email, homeowner_first_name)
         VALUES ($1, 'E-NEWBAD', 'test+newbad@example.com', $2)`,
        [shop.rows[0].id, legacyName]
      ),
      (err) => err.code === '23514'
    );

    await applySchema();
    const still = await pool.query(
      `SELECT homeowner_first_name FROM pilot_open_estimates
        WHERE source_estimate_id = 'E-LEGACY'`
    );
    assert.equal(still.rows[0].homeowner_first_name, legacyName);
    const stillThere = await pool.query(
      `SELECT to_regclass('public.pilot_estimate_suppressions') AS rel`
    );
    assert.notEqual(stillThere.rows[0].rel, null);
    await resetDb();
  });
});
