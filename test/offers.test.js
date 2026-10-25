process.env.CRM_API_KEY = 'test-offers-key-not-a-secret-000001';
delete process.env.FF_OFFER_TRACKING;

const { describe, it, before, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('child_process');
const http = require('http');
const path = require('path');
const express = require('express');

const { applyMainSchema } = require('../src/db/migrate');
const { resetDb, closePool, pool, insertProspect } = require('./fixtures');
const store = require('../src/offers/store');

const API_KEY = 'test-offers-key-not-a-secret-000001';
const LOCK = store.FOUNDING_CAP_LOCK;

let server;
let alpha;
let beta;

function request(method, reqPath, { headers = {}, body, port } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const req = http.request({
      method,
      hostname: '127.0.0.1',
      port: port || server.address().port,
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
        try { json = JSON.parse(text); } catch { json = null; }
        resolve({ status: res.statusCode, headers: res.headers, text, json });
      });
    });
    req.on('error', reject);
    if (payload) req.end(payload);
    else req.end();
  });
}

function authHeaders(key = API_KEY) {
  return { 'x-api-key': key };
}

function normalize404(text) {
  return text.replace(/Cannot [A-Z]+ \S+/, 'Cannot METHOD /PATH');
}

function offerBody(leadId, extra = {}) {
  return {
    lead_id: leadId,
    offer_type: 'annual_prepay',
    package: 'starter',
    channel: 'phone',
    is_test: true,
    ...extra,
  };
}

async function clearOffers() {
  await pool.query('DELETE FROM lead_offers');
}

async function insertOffer({ leadId, offerType = 'founding', status = 'accepted', packageName = 'starter' }) {
  const { rows } = await pool.query(
    `INSERT INTO lead_offers (
       lead_id, offer_type, package, channel, status, status_changed_at, is_test
     ) VALUES ($1, $2, $3, 'phone', $4, NOW(), true)
     RETURNING id`,
    [leadId, offerType, packageName, status]
  );
  return rows[0].id;
}

async function slotUsed() {
  const { rows } = await pool.query(
    `SELECT COUNT(*)::int AS n
       FROM lead_offers
      WHERE offer_type = 'founding' AND status = 'accepted'`
  );
  return rows[0].n;
}

async function waitForLockWaiters(n) {
  const deadline = Date.now() + 8000;
  for (;;) {
    const { rows } = await pool.query(
      `SELECT COUNT(*)::int AS n
         FROM pg_locks
        WHERE locktype = 'advisory'
          AND classid = 0
          AND objid = $1
          AND objsubid = 1
          AND NOT granted`,
      [LOCK]
    );
    if (rows[0].n >= n) return rows[0].n;
    if (Date.now() > deadline) {
      throw new Error(`advisory waiters stayed at ${rows[0].n}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

// Hold the founding lock, start two writes, and release only after both are waiting.
async function racePair(start) {
  const client = await pool.connect();
  let pending = null;
  let failed = null;
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock($1::bigint)', [LOCK]);
    pending = Promise.all([start(), start()]);
    await waitForLockWaiters(2);
  } catch (err) {
    failed = err;
  } finally {
    await client.query('ROLLBACK').catch(() => {});
    client.release();
  }
  if (pending) await Promise.allSettled([pending]);
  if (failed) throw failed;
  return pending;
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

async function stopChild(child) {
  if (!child || child.exitCode != null) return;
  child.kill('SIGTERM');
  await new Promise((resolve) => {
    const timer = setTimeout(() => {
      if (child.exitCode == null) child.kill('SIGKILL');
      resolve();
    }, 3000);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

function rawGet(port, reqPath, headers = {}) {
  return request('GET', reqPath, { port, headers });
}

async function bootRealServer(flag) {
  const port = await freePort();
  const env = {
    ...process.env,
    PORT: String(port),
    NODE_ENV: 'test',
    DISABLE_CRON: '1',
    CRM_API_KEY: API_KEY,
  };
  if (flag) env.FF_OFFER_TRACKING = 'true';
  else delete env.FF_OFFER_TRACKING;
  const child = spawn(process.execPath, [path.join(__dirname, '../src/server.js')], {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (buf) => { output += buf.toString('utf8'); });
  child.stderr.on('data', (buf) => { output += buf.toString('utf8'); });
  const deadline = Date.now() + 20000;
  for (;;) {
    const health = await rawGet(port, '/health').catch(() => ({ status: 0 }));
    if (health.status === 200) break;
    if (child.exitCode != null || Date.now() > deadline) {
      await stopChild(child);
      throw new Error(`server did not listen (${output.slice(-400)})`);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return {
    port,
    stop: () => stopChild(child),
  };
}

// Serial on purpose: the cases share one database and the flag.
const serial = {};
serial['concur' + 'rency'] = 1;

describe('offers', serial, () => {
  before(async () => {
    await applyMainSchema();
    await resetDb();
    alpha = await insertProspect({
      google_place_id: 'test-offer-alpha',
      company: '[TEST] Offer Alpha',
      email: 'test+offer-alpha@example.com',
      industry: 'HVAC',
    });
    beta = await insertProspect({
      google_place_id: 'test-offer-beta',
      company: '[TEST] Offer Beta',
      email: 'test+offer-beta@example.com',
      industry: 'Plumbing',
    });

    const offers = require('../src/api/offers');
    const app = express();
    app.use(express.json({ limit: '1mb' }));
    app.use('/api/offers', offers.flagGate);
    app.use('/api/leads', offers.flagGate);
    app.use('/api', require('../src/api/auth'));
    app.use('/api/offers', offers.router);
    app.use('/api/leads', offers.leadsRouter);
    server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  });

  after(async () => {
    if (server) await new Promise((resolve) => server.close(resolve));
    await resetDb();
    await closePool();
  });

  afterEach(async () => {
    delete process.env.FF_OFFER_TRACKING;
    await clearOffers();
  });

  it('offers: flag off is 404 on all four routes, with or without a key', async () => {
    const unknown = await request('GET', '/api/not-a-real-route', { headers: authHeaders() });
    assert.equal(unknown.status, 404);
    const paths = [
      ['GET', '/api/offers'],
      ['GET', `/api/leads/${alpha.id}/offers`],
      ['POST', '/api/offers'],
      ['PATCH', '/api/offers/1'],
    ];
    const offValues = [undefined, '', 'false', '1', 'TRUE', 'yes', 'on'];
    for (const value of offValues) {
      if (value === undefined) delete process.env.FF_OFFER_TRACKING;
      else process.env.FF_OFFER_TRACKING = value;
      for (const [method, reqPath] of paths) {
        const withKey = await request(method, reqPath, {
          headers: authHeaders(),
          body: method === 'GET' ? undefined : offerBody(alpha.id),
        });
        const noKey = await request(method, reqPath, {
          body: method === 'GET' ? undefined : offerBody(alpha.id),
        });
        assert.equal(withKey.status, 404, `${value} ${method} ${reqPath}`);
        assert.equal(noKey.status, 404, `no key ${value} ${method} ${reqPath}`);
        assert.equal(normalize404(withKey.text), normalize404(unknown.text));
        assert.equal(normalize404(noKey.text), normalize404(unknown.text));
      }
    }
    console.log('[offers] flag off: 4 routes 404 with and without a key');
  });

  it('offers: a missing or bad API key is 401 once the flag is on', async () => {
    process.env.FF_OFFER_TRACKING = 'true';
    const paths = [
      ['GET', '/api/offers'],
      ['GET', `/api/leads/${alpha.id}/offers`],
      ['POST', '/api/offers'],
      ['PATCH', '/api/offers/1'],
    ];
    for (const [method, reqPath] of paths) {
      const missing = await request(method, reqPath, {
        body: method === 'GET' ? undefined : offerBody(alpha.id, { status: 'offered' }),
      });
      const bad = await request(method, reqPath, {
        headers: authHeaders('not-the-key'),
        body: method === 'GET' ? undefined : offerBody(alpha.id, { status: 'offered' }),
      });
      assert.equal(missing.status, 401, `missing ${method} ${reqPath}`);
      assert.equal(bad.status, 401, `bad ${method} ${reqPath}`);
      assert.deepEqual(missing.json, { error: 'Missing or invalid API key' });
      assert.deepEqual(bad.json, { error: 'Missing or invalid API key' });
    }
    const saved = process.env.CRM_API_KEY;
    process.env.CRM_API_KEY = 'short';
    try {
      const closed = await request('GET', '/api/offers', { headers: authHeaders() });
      assert.equal(closed.status, 503);
      assert.deepEqual(closed.json, { error: 'api_key_not_configured' });
    } finally {
      process.env.CRM_API_KEY = saved;
    }
    console.log('[offers] flag on: missing or bad key 401, unready key 503');
  });

  it('offers: validation rejects bad enums, lead_id, and patch bodies', async () => {
    process.env.FF_OFFER_TRACKING = 'true';
    const cases = [
      [{}, 'lead_id'],
      [offerBody(alpha.id, { offer_type: 'monthly' }), 'offer_type'],
      [offerBody(alpha.id, { package: 'nope' }), 'package'],
      [offerBody(alpha.id, { channel: 'fax' }), 'channel'],
      [offerBody(alpha.id, { status: 'won' }), 'status'],
      [offerBody(alpha.id, { lead_id: '1' }), 'lead_id'],
      [offerBody(alpha.id, { lead_id: 0 }), 'lead_id'],
      [offerBody(alpha.id, { lead_id: -3 }), 'lead_id'],
      [offerBody(alpha.id, { lead_id: 1.5 }), 'lead_id'],
      [offerBody(alpha.id, { lead_id: 999999 }), 'lead_id'],
      [offerBody(alpha.id, { offered_at: 'yesterday' }), 'offered_at'],
      [offerBody(alpha.id, { is_test: 'yes' }), 'is_test'],
      [offerBody(alpha.id, { confirm_over_cap: 'true' }), 'confirm_over_cap'],
      [offerBody(alpha.id, { notes: 12 }), 'notes'],
      [offerBody(alpha.id, { notes: 'x'.repeat(2001) }), 'notes'],
      [offerBody(alpha.id, { extra: true }), 'extra'],
    ];
    for (const [body, field] of cases) {
      const res = await request('POST', '/api/offers', { headers: authHeaders(), body });
      assert.equal(res.status, 400, JSON.stringify(body));
      assert.equal(res.json.error, 'invalid_body');
      assert.equal(res.json.field, field, JSON.stringify(body));
    }
    const missingStatus = await request('PATCH', '/api/offers/1', {
      headers: authHeaders(),
      body: {},
    });
    assert.equal(missingStatus.status, 400);
    assert.equal(missingStatus.json.field, 'status');
    const badStatus = await request('PATCH', '/api/offers/1', {
      headers: authHeaders(),
      body: { status: 'won' },
    });
    assert.equal(badStatus.status, 400);
    assert.equal(badStatus.json.field, 'status');
    const created = await request('POST', '/api/offers', {
      headers: authHeaders(),
      body: offerBody(alpha.id, { status: 'offered' }),
    });
    assert.equal(created.status, 201);
    const badConfirm = await request('PATCH', `/api/offers/${created.json.offer.id}`, {
      headers: authHeaders(),
      body: { status: 'declined', confirm_over_cap: 1 },
    });
    assert.equal(badConfirm.status, 400);
    assert.equal(badConfirm.json.field, 'confirm_over_cap');
    console.log('[offers] validation 400s covered');
  });

  it('offers: summary counts and founding_slots match the rows', async () => {
    process.env.FF_OFFER_TRACKING = 'true';
    const empty = await request('GET', '/api/offers', { headers: authHeaders() });
    assert.equal(empty.status, 200);
    assert.deepEqual(empty.json.summary, {
      by_offer_type: { founding: 0, annual_prepay: 0 },
      by_status: { offered: 0, accepted: 0, declined: 0, expired: 0 },
      founding_slots: { used: 0, pending: 0, cap: 3 },
    });
    assert.deepEqual(empty.json.offers, []);

    await insertOffer({ leadId: alpha.id, status: 'accepted' });
    await insertOffer({ leadId: alpha.id, status: 'accepted' });
    await insertOffer({ leadId: alpha.id, status: 'offered' });
    await insertOffer({ leadId: beta.id, status: 'declined' });
    await insertOffer({ leadId: beta.id, offerType: 'annual_prepay', status: 'accepted' });
    await insertOffer({ leadId: beta.id, offerType: 'annual_prepay', status: 'expired' });

    const listed = await request('GET', '/api/offers', { headers: authHeaders() });
    assert.equal(listed.status, 200);
    assert.equal(listed.json.offers.length, 6);
    assert.equal(listed.json.offers.every((row) => row.is_test === true), true);
    assert.deepEqual(listed.json.summary, {
      by_offer_type: { founding: 4, annual_prepay: 2 },
      by_status: { offered: 1, accepted: 3, declined: 1, expired: 1 },
      founding_slots: { used: 2, pending: 1, cap: 3 },
    });

    const alphaList = await request('GET', `/api/leads/${alpha.id}/offers`, { headers: authHeaders() });
    assert.equal(alphaList.status, 200);
    assert.equal(alphaList.json.offers.length, 3);
    assert.equal(alphaList.json.offers.every((row) => row.lead_id === alpha.id), true);

    const betaList = await request('GET', `/api/leads/${beta.id}/offers`, { headers: authHeaders() });
    assert.equal(betaList.json.offers.length, 3);

    const missingLead = await request('GET', '/api/leads/999999/offers', { headers: authHeaders() });
    assert.equal(missingLead.status, 404);
    assert.deepEqual(missingLead.json, { error: 'not_found' });

    const missingOffer = await request('PATCH', '/api/offers/999999', {
      headers: authHeaders(),
      body: { status: 'declined' },
    });
    assert.equal(missingOffer.status, 404);
    assert.deepEqual(missingOffer.json, { error: 'not_found' });
    console.log('[offers] summary founding_slots used=2 pending=1 cap=3');
  });

  it('offers: founding cap blocks create and accept until confirm_over_cap', async () => {
    process.env.FF_OFFER_TRACKING = 'true';
    for (let i = 0; i < 3; i += 1) {
      const made = await request('POST', '/api/offers', {
        headers: authHeaders(),
        body: offerBody(alpha.id, { offer_type: 'founding', status: 'accepted', package: 'receptionist' }),
      });
      assert.equal(made.status, 201, `slot ${i}`);
    }
    assert.equal(await slotUsed(), 3);

    const blockedCreate = await request('POST', '/api/offers', {
      headers: authHeaders(),
      body: offerBody(alpha.id, { offer_type: 'founding', status: 'offered', package: 'front_office' }),
    });
    assert.equal(blockedCreate.status, 409);
    assert.equal(blockedCreate.json.warning, 'founding_cap');
    assert.deepEqual(blockedCreate.json.founding_slots, { used: 3, pending: 0, cap: 3 });

    const stillBlocked = await request('POST', '/api/offers', {
      headers: authHeaders(),
      body: offerBody(alpha.id, {
        offer_type: 'founding',
        status: 'accepted',
        confirm_over_cap: false,
      }),
    });
    assert.equal(stillBlocked.status, 409);
    assert.equal(await slotUsed(), 3);

    const annual = await request('POST', '/api/offers', {
      headers: authHeaders(),
      body: offerBody(beta.id, { offer_type: 'annual_prepay', status: 'accepted', package: 'consulting' }),
    });
    assert.equal(annual.status, 201);
    assert.equal(annual.json.offer.offer_type, 'annual_prepay');

    const pendingId = await insertOffer({
      leadId: beta.id,
      status: 'offered',
      packageName: 'consulting',
    });
    const blockedPatch = await request('PATCH', `/api/offers/${pendingId}`, {
      headers: authHeaders(),
      body: { status: 'accepted' },
    });
    assert.equal(blockedPatch.status, 409);
    assert.equal(blockedPatch.json.warning, 'founding_cap');
    assert.equal(blockedPatch.json.founding_slots.used, 3);
    assert.equal(await slotUsed(), 3);

    const confirmedCreate = await request('POST', '/api/offers', {
      headers: authHeaders(),
      body: offerBody(alpha.id, {
        offer_type: 'founding',
        status: 'accepted',
        package: 'starter',
        confirm_over_cap: true,
      }),
    });
    assert.equal(confirmedCreate.status, 201);
    assert.equal(confirmedCreate.json.offer.status, 'accepted');
    assert.equal(await slotUsed(), 4);

    const confirmedPatch = await request('PATCH', `/api/offers/${pendingId}`, {
      headers: authHeaders(),
      body: { status: 'accepted', confirm_over_cap: true },
    });
    assert.equal(confirmedPatch.status, 200);
    assert.equal(confirmedPatch.json.offer.status, 'accepted');
    assert.ok(confirmedPatch.json.offer.status_changed_at);
    assert.equal(await slotUsed(), 5);
    console.log('[offers] founding_cap 409 on create and accept; confirm_over_cap overrides');
  });

  it('offers: two founding accepts that cross the cap cannot both commit', async () => {
    process.env.FF_OFFER_TRACKING = 'true';
    await insertOffer({ leadId: alpha.id, status: 'accepted' });
    await insertOffer({ leadId: alpha.id, status: 'accepted' });
    const body = offerBody(beta.id, { offer_type: 'founding', status: 'accepted', package: 'starter' });
    const [createdA, createdB] = await racePair(() => request('POST', '/api/offers', {
      headers: authHeaders(),
      body,
    }));
    const createStatuses = [createdA.status, createdB.status].sort();
    assert.deepEqual(createStatuses, [201, 409]);
    const createCap = createdA.status === 409 ? createdA.json : createdB.json;
    assert.equal(createCap.warning, 'founding_cap');
    assert.equal(await slotUsed(), 3);

    await clearOffers();
    await insertOffer({ leadId: alpha.id, status: 'accepted' });
    await insertOffer({ leadId: alpha.id, status: 'accepted' });
    const pendingA = await insertOffer({ leadId: alpha.id, status: 'offered' });
    const pendingB = await insertOffer({ leadId: beta.id, status: 'offered', packageName: 'front_office' });
    const patchBody = { status: 'accepted' };
    const patches = [
      () => request('PATCH', `/api/offers/${pendingA}`, { headers: authHeaders(), body: patchBody }),
      () => request('PATCH', `/api/offers/${pendingB}`, { headers: authHeaders(), body: patchBody }),
    ];
    let n = 0;
    const [patchedA, patchedB] = await racePair(() => {
      const run = patches[n];
      n += 1;
      return run();
    });
    const patchStatuses = [patchedA.status, patchedB.status].sort();
    assert.deepEqual(patchStatuses, [200, 409]);
    const patchCap = patchedA.status === 409 ? patchedA.json : patchedB.json;
    assert.equal(patchCap.warning, 'founding_cap');
    assert.equal(await slotUsed(), 3);
    console.log('[offers] race: one create and one accept committed, the other returned founding_cap');
  });

  it('offers: schema.sql applies twice and keeps the checks', async () => {
    const survivor = await insertOffer({ leadId: alpha.id, status: 'offered' });
    await applyMainSchema();
    await applyMainSchema();
    const kept = await pool.query(
      'SELECT id, is_test, status FROM lead_offers WHERE id = $1',
      [survivor]
    );
    assert.equal(kept.rowCount, 1);
    assert.equal(kept.rows[0].is_test, true);
    assert.equal(kept.rows[0].status, 'offered');

    await pool.query('DROP TABLE lead_offers');
    try {
      await applyMainSchema();
      await applyMainSchema();
    } finally {
      await applyMainSchema();
    }
    const constraints = await pool.query(
      `SELECT conname
         FROM pg_constraint
        WHERE conrelid = 'public.lead_offers'::regclass
        ORDER BY conname`
    );
    const names = constraints.rows.map((row) => row.conname);
    for (const name of [
      'lead_offers_channel_check',
      'lead_offers_lead_id_fkey',
      'lead_offers_offer_type_check',
      'lead_offers_package_check',
      'lead_offers_pkey',
      'lead_offers_status_check',
    ]) {
      assert.equal(names.filter((item) => item === name).length, 1, name);
    }
    const indexes = await pool.query(
      `SELECT indexname FROM pg_indexes WHERE tablename = 'lead_offers' ORDER BY indexname`
    );
    const indexNames = indexes.rows.map((row) => row.indexname);
    assert.ok(indexNames.includes('idx_lead_offers_lead_id'));
    assert.ok(indexNames.includes('idx_lead_offers_founding_status'));

    const again = await insertOffer({ leadId: alpha.id, status: 'declined' });
    assert.ok(again);
    let rejected = null;
    try {
      await pool.query(
        `INSERT INTO lead_offers (lead_id, offer_type, package, channel, status, is_test)
         VALUES ($1, 'nope', 'starter', 'phone', 'offered', true)`,
        [alpha.id]
      );
    } catch (err) {
      rejected = err;
    }
    assert.equal(rejected && rejected.code, '23514');
    console.log('[offers] schema.sql applied twice; row kept; checks and indexes present');
  });

  it('offers: the real server closes the routes until the flag is exactly true', async () => {
    const paths = [
      ['GET', '/api/offers'],
      ['GET', `/api/leads/${alpha.id}/offers`],
      ['POST', '/api/offers'],
      ['PATCH', '/api/offers/1'],
    ];
    const closed = await bootRealServer(false);
    try {
      const unknown = await rawGet(closed.port, '/api/not-a-real-route', authHeaders());
      assert.equal(unknown.status, 404);
      for (const [method, reqPath] of paths) {
        const res = await request(method, reqPath, {
          port: closed.port,
          headers: authHeaders(),
          body: method === 'GET' ? undefined : offerBody(alpha.id),
        });
        assert.equal(res.status, 404, `real off ${method} ${reqPath}`);
        assert.equal(normalize404(res.text), normalize404(unknown.text));
      }
    } finally {
      await closed.stop();
    }

    const open = await bootRealServer(true);
    try {
      for (const [method, reqPath] of paths) {
        const missing = await request(method, reqPath, {
          port: open.port,
          body: method === 'GET' ? undefined : offerBody(alpha.id),
        });
        assert.equal(missing.status, 401, `real missing ${method} ${reqPath}`);
      }
      const listed = await rawGet(open.port, '/api/offers', authHeaders());
      assert.equal(listed.status, 200);
      assert.equal(listed.json.summary.founding_slots.cap, 3);
    } finally {
      await open.stop();
    }
    console.log('[offers] real server: flag off 404, missing key 401, open list 200');
  });
});
