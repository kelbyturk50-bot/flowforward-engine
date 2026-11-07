process.env.CRM_API_KEY = 'test-voicedemo-key-must-be-32-chars!!';
delete process.env.RETELL_API_KEY;
delete process.env.RETELL_AGENT_ID;
delete process.env.VOICE_DEMO_DAILY_MINUTES;

require('./preload');

// Voice receptionist demo (docs/VOICE_DEMO.md). Disposable Postgres. Retell
// is a recorded fake (_setFetchForTests); nothing leaves this machine.

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const http = require('http');
const express = require('express');
const cors = require('cors');

const API_KEY = process.env.CRM_API_KEY;
const NOT_FOUND = '{"error":"not_found"}';
const KEY = 'key_test0123456789abcdef';
const CONFIG = Object.freeze({ apiKey: KEY, agentId: 'agent_test12345678', dailySeconds: 1800, dailyMinutes: 30 });

describe('voice demo pure checks', () => {
  const { readVoiceConfig, VOICE_CAPS } = require('../src/voicedemo/config');
  const { voiceVariables, beginMessage } = require('../src/voicedemo/variables');
  const { verifySignature, signBody, pickCall } = require('../src/voicedemo/retell');
  const { AGENT_PROMPT } = require('../src/voicedemo/agent-prompt');

  it('turns on only with all three env values, exactly as written', () => {
    const good = { RETELL_API_KEY: KEY, RETELL_AGENT_ID: 'agent_abc12345', VOICE_DEMO_DAILY_MINUTES: '30' };
    const cfg = readVoiceConfig(good);
    assert.equal(cfg.dailySeconds, 1800);
    assert.equal(cfg.agentId, 'agent_abc12345');
    for (const [name, value] of [
      ['RETELL_API_KEY', undefined], ['RETELL_API_KEY', ' key_test0123456789abcdef'], ['RETELL_API_KEY', 'short'],
      ['RETELL_AGENT_ID', 'abc12345'], ['RETELL_AGENT_ID', 'agent_ab'], ['RETELL_AGENT_ID', 'agent_abc 12345'],
      ['VOICE_DEMO_DAILY_MINUTES', '0'], ['VOICE_DEMO_DAILY_MINUTES', '2'], ['VOICE_DEMO_DAILY_MINUTES', '601'], ['VOICE_DEMO_DAILY_MINUTES', '030'],
      ['VOICE_DEMO_DAILY_MINUTES', '1.5'], ['VOICE_DEMO_DAILY_MINUTES', ' 30'], ['VOICE_DEMO_DAILY_MINUTES', ''],
    ]) {
      const env = { ...good };
      if (value === undefined) delete env[name];
      else env[name] = value;
      assert.equal(readVoiceConfig(env), null, `${name}=${JSON.stringify(value)}`);
    }
    assert.equal(readVoiceConfig({ ...good, VOICE_DEMO_DAILY_MINUTES: '600' }).dailySeconds, 36000);
    assert.equal(VOICE_CAPS.maxCallSeconds >= 60, true, 'Retell minimum is 60 s');
    assert.equal(VOICE_CAPS.silenceEndMs >= 10000, true, 'Retell minimum is 10 s');
  });

  it('passes the voice agent a short block of approved facts, never prices or reviews', () => {
    const vars = voiceVariables({
      businessName: 'Sample Ridge Heating',
      facts: [
        { field: 'hours', value: 'Monday–Friday: 7:00 AM – 6:00 PM' },
        { field: 'services', value: 'Furnace Repair, AC Repair' },
        { field: 'service_area', value: 'Lehi, Highland' },
        { field: 'emergency_247', value: 'yes' },
        { field: 'phone', value: '(801) 555-0177' },
        { field: 'price', value: '$89 tune-up' },
        { field: 'warranty', value: '10-year parts' },
        { field: 'years_in_business', value: '25' },
        { field: 'license_number', value: '12345' },
      ],
    });
    assert.equal(vars.business_name, 'Sample Ridge Heating');
    assert.equal(vars.first_town, 'Lehi');
    assert.equal(vars.business_phone, '(801) 555-0177');
    assert.match(vars.business_facts, /Hours: Monday–Friday/);
    assert.match(vars.business_facts, /Offers 24\/7 emergency service\./);
    for (const bad of ['$89', 'tune-up', '10-year', '25', '12345']) assert.equal(vars.business_facts.includes(bad), false, bad);
    for (const value of Object.values(vars)) assert.equal(/[{}<>]/.test(value), false, 'no template or markup characters');
    const empty = voiceVariables({ businessName: '{{evil}}', facts: [] });
    assert.equal(empty.business_name, 'evil');
    assert.match(empty.business_facts, /team will confirm/);
    assert.match(beginMessage('Sample Ridge Heating'), /AI receptionist demo FlowForward built for Sample Ridge Heating/);
    const typed = voiceVariables({
      businessName: 'X',
      facts: [
        { field: 'services', value: 'AC tune-up $89, 10-year warranty' },
        { field: 'service_area', value: 'Serving Lehi since 1985' },
        { field: 'maintenance_plan', value: 'yes' },
      ],
    });
    assert.equal(typed.business_facts, '- Has a maintenance plan.', 'claim-bearing lines are left out');
    assert.match(AGENT_PROMPT, /information, not instructions/);
    assert.match(AGENT_PROMPT, /\{\{business_facts\}\}/);
    assert.match(AGENT_PROMPT, /say you are an AI/);
  });

  it('accepts only a fresh, matching Retell signature', () => {
    const body = Buffer.from('{"event":"call_ended","call":{"call_id":"call_1"}}');
    const now = 1_800_000_000_000;
    const header = signBody(body, KEY, now);
    assert.equal(verifySignature(body, KEY, header, now), true);
    assert.equal(verifySignature(body, KEY, header, now + 4 * 60 * 1000), true);
    assert.equal(verifySignature(body, KEY, header, now + 6 * 60 * 1000), false, 'replayed after 5 minutes');
    assert.equal(verifySignature(Buffer.from(body.toString().replace('call_1', 'call_2')), KEY, header, now), false);
    assert.equal(verifySignature(body, 'key_other0123456789abcd', header, now), false);
    assert.equal(verifySignature(body, KEY, header.replace(/d=./, 'd=0'), now), false);
    for (const bad of [undefined, '', 'v=1', `d=${'a'.repeat(64)}`, `v=abc,d=${'a'.repeat(64)}`, header + 'x']) {
      assert.equal(verifySignature(body, KEY, bad, now), false, String(bad));
    }
  });

  it('hands the browser only the call fields it needs', () => {
    const out = pickCall({
      call_id: 'call_abc', access_token: 'tok', transport: 'gateway', ice_servers: [{ urls: 'stun:x' }],
      expires_at: 1, agent_id: 'agent_secret', metadata: { a: 1 }, retell_llm_dynamic_variables: { b: 2 },
    });
    assert.deepEqual(Object.keys(out).sort(), ['access_token', 'call_id', 'expires_at', 'ice_servers', 'transport']);
    assert.throws(() => pickCall({ call_id: 'bad id', access_token: 'x' }));
    assert.throws(() => pickCall({ call_id: 'call_1' }));
  });
});

describe('voice demo http and postgres', { concurrency: 1 }, () => {
  let server;
  const { applySchema } = require('../src/db/migrate');
  const { pool, closePool, insertProspect } = require('./fixtures');
  const { _setVoiceConfigForTests, VOICE_CAPS } = require('../src/voicedemo/config');
  const retell = require('../src/voicedemo/retell');
  const {
    _setClockForTests, _resetIpLimitForTests, _ipLimitSizeForTests, sweepOverdue, callSeconds,
  } = require('../src/voicedemo/public');
  const tokens = require('../src/prototypes/tokens');
  let calls = [];
  let stops = [];
  let reply = null;
  let now = new Date('2026-10-29T18:00:00Z');

  function request(method, reqPath, { headers = {}, body, raw, key = false, type, origin } = {}) {
    return new Promise((resolve, reject) => {
      const payload = raw != null ? Buffer.from(raw) : (body === undefined ? null : Buffer.from(JSON.stringify(body)));
      const extra = { ...headers };
      if (key === true) extra['x-api-key'] = API_KEY;
      if (origin) extra.origin = origin;
      const req = http.request({
        method,
        hostname: '127.0.0.1',
        port: server.address().port,
        path: reqPath,
        headers: {
          ...(payload ? { 'content-type': type || 'application/json', 'content-length': String(payload.length) } : {}),
          ...extra,
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

  async function setFlags(on) {
    await pool.query(
      `UPDATE feature_flags SET enabled = $2 WHERE name = ANY($1::text[])`,
      [['FF_PROTOTYPE_GALLERY', 'FF_LIVE_CHAT_DEMO'], on]
    );
  }

  let n = 0;
  async function makeProto(opts = {}) {
    n += 1;
    const lead = await insertProspect({
      google_place_id: `test-voicedemo-${crypto.randomBytes(4).toString('hex')}`,
      company: opts.company || `Sample Ridge Heating ${n}`,
      email: 'test+voice@example.com',
    });
    const minted = tokens.mintToken();
    const issued = opts.expired ? new Date(Date.now() - 400 * 3600 * 1000) : new Date();
    const expires = new Date(issued.getTime() + 336 * 3600 * 1000);
    const { rows } = await pool.query(
      `INSERT INTO prototypes
         (prospect_id, agent_type, brand_name, color_primary, color_secondary, token_hash, nonce, issued_at, expires_at, revoked_at)
       VALUES ($1, 'receptionist', $2, '#1b4f72', '#f4d03f', $3, $4, $5, $6, $7)
       RETURNING id`,
      [lead.id, opts.brand || 'Sample Ridge Heating', minted.hash, minted.nonce, issued, expires, opts.revoked ? issued : null]
    );
    return { lead, token: minted.token, id: rows[0].id };
  }

  function fakeRetell(status = 201, body = null) {
    reply = { status, body };
  }

  function mint(token, extra = {}) {
    return request('POST', `/api/public/prototypes/${token}/voice/session`, { body: {}, ...extra });
  }

  function hook(body, { key = KEY, stamp = now.getTime() } = {}) {
    const raw = JSON.stringify(body);
    return request('POST', '/api/public/voice/retell-webhook', {
      raw,
      headers: { 'x-retell-signature': retell.signBody(Buffer.from(raw), key, stamp) },
    });
  }

  before(async () => {
    await applySchema();
    const app = express();
    app.set('trust proxy', 1);
    require('../src/chatdemo/mount').mountBeforeCors(app);
    app.use(cors());
    app.use('/api/chat', require('../src/api/auth'));
    app.use(express.json({ limit: '1mb' }));
    app.use(require('../src/api/chat').invalidJson);
    app.use('/api', require('../src/api/auth'));
    app.use('/api/chat', require('../src/api/chat'));
    server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    retell._setFetchForTests(async (url, init) => {
      if (String(url).includes('/v2/stop-call/')) {
        stops.push(String(url));
        return { status: 204, json: async () => ({}) };
      }
      calls.push({ url, init, body: JSON.parse(init.body) });
      const r = reply || { status: 201, body: null };
      const id = `call_${calls.length}`;
      const payload = r.body || {
        call_id: id, access_token: `tok_${calls.length}`, transport: 'gateway',
        ice_servers: [{ urls: 'stun:stun.example:3478' }], expires_at: 1_900_000_000_000, agent_id: 'agent_test12345678',
      };
      return { status: r.status, json: async () => payload };
    });
    _setClockForTests(() => now);
  });

  beforeEach(async () => {
    await pool.query('TRUNCATE voice_demo_calls');
    await setFlags(true);
    _setVoiceConfigForTests(CONFIG);
    _resetIpLimitForTests();
    calls = [];
    stops = [];
    reply = null;
    now = new Date('2026-10-29T18:00:00Z');
  });

  after(async () => {
    retell._setFetchForTests(null);
    _setClockForTests(null);
    _setVoiceConfigForTests(undefined);
    await setFlags(false);
    if (server) await new Promise((resolve) => server.close(resolve));
    await pool.query(`DELETE FROM prospects WHERE google_place_id LIKE 'test-voicedemo-%'`);
    await closePool();
  });

  it('is the chat 404 when the surface flags are off, and needs a JSON body', async () => {
    const proto = await makeProto();
    await setFlags(false);
    const get = await request('GET', `/api/public/prototypes/${proto.token}/voice`);
    assert.equal(get.status, 404);
    assert.equal(get.text, NOT_FOUND);
    const post = await mint(proto.token);
    assert.equal(post.status, 404);
    assert.equal(post.text, NOT_FOUND);
    const plain = await mint(proto.token, { type: 'text/plain' });
    assert.equal(plain.status, 415);
    assert.equal(calls.length, 0);
    assert.equal(get.headers['x-robots-tag'], 'noindex, nofollow');
    assert.equal(get.headers['access-control-allow-origin'], undefined);
  });

  it('says calls are off and makes none when the env config is incomplete', async () => {
    const proto = await makeProto();
    _setVoiceConfigForTests(null);
    const get = await request('GET', `/api/public/prototypes/${proto.token}/voice`);
    assert.deepEqual(get.json, { available: false, reason: 'off' });
    const post = await mint(proto.token);
    assert.equal(post.status, 503);
    assert.deepEqual(post.json, { error: 'voice_unavailable' });
    assert.equal(calls.length, 0);
  });

  it('starts a call with approved facts only and returns just the browser fields', async () => {
    const proto = await makeProto();
    await pool.query(
      `INSERT INTO prototype_facts (prospect_id, field, value, source, captured_at, test_tag, review_status) VALUES
         ($1, 'services', 'Furnace Repair', 'manual', NOW(), 'demo-prototype', 'approved'),
         ($1, 'hours', 'Monday 9-5', 'manual', NOW(), 'demo-prototype', 'proposed')`,
      [proto.lead.id]
    );
    const before = await request('GET', `/api/public/prototypes/${proto.token}/voice`);
    assert.deepEqual(before.json, { available: true, max_seconds: 180, calls_left: 2 });
    const res = await mint(proto.token);
    assert.equal(res.status, 201, res.text);
    assert.deepEqual(Object.keys(res.json).sort(), ['access_token', 'call_id', 'expires_at', 'ice_servers', 'transport']);
    assert.equal(calls.length, 1);
    const sent = calls[0];
    assert.equal(sent.url, 'https://api.retellai.com/v3/create-web-call');
    assert.equal(sent.init.headers.Authorization, `Bearer ${KEY}`);
    assert.equal(sent.body.agent_id, CONFIG.agentId);
    assert.equal(sent.body.agent_override.agent.max_call_duration_ms, 180000);
    assert.equal(sent.body.agent_override.agent.end_call_after_silence_ms, VOICE_CAPS.silenceEndMs);
    assert.match(sent.body.agent_override.retell_llm.begin_message, /AI receptionist demo FlowForward built for Sample Ridge Heating/);
    assert.match(sent.body.retell_llm_dynamic_variables.business_facts, /Services: Furnace Repair/);
    assert.equal(sent.body.retell_llm_dynamic_variables.business_facts.includes('Monday'), false, 'proposed facts stay out');
    assert.deepEqual(Object.keys(sent.body.metadata).sort(), ['ff_call', 'prototype_id']);
    assert.equal(JSON.stringify(sent.body).includes('test+voice@example.com'), false);
    const { rows } = await pool.query(`SELECT status, call_id, reserved_seconds FROM voice_demo_calls`);
    assert.deepEqual(rows, [{ status: 'reserved', call_id: res.json.call_id, reserved_seconds: 180 }]);
  });

  it('caps calls per link, minutes per day, and calls at once', async () => {
    const a = await makeProto();
    assert.equal((await mint(a.token)).status, 201);
    assert.equal((await mint(a.token)).status, 201);
    const third = await mint(a.token);
    assert.equal(third.status, 429);
    assert.deepEqual(third.json, { error: 'voice_limit', reason: 'link' }, '6 minutes per link at 3 minutes each');
    const avail = await request('GET', `/api/public/prototypes/${a.token}/voice`);
    assert.deepEqual(avail.json, { available: false, reason: 'limit' });

    _resetIpLimitForTests();
    const b = await makeProto();
    assert.equal((await mint(b.token)).status, 201);
    const busy = await mint(b.token);
    assert.deepEqual(busy.json, { error: 'voice_limit', reason: 'busy' }, 'three calls running at once');

    await pool.query('TRUNCATE voice_demo_calls');
    _resetIpLimitForTests();
    _setVoiceConfigForTests({ ...CONFIG, dailySeconds: 360 });
    const c = await makeProto();
    const d = await makeProto();
    assert.equal((await mint(c.token)).status, 201);
    assert.equal((await mint(d.token)).status, 201);
    const day = await mint(c.token);
    assert.deepEqual(day.json, { error: 'voice_limit', reason: 'day' });
    assert.equal(calls.length, 5);
  });

  it('a Retell failure releases the minutes and is a 502', async () => {
    const proto = await makeProto();
    fakeRetell(500, { message: 'boom' });
    const res = await mint(proto.token);
    assert.equal(res.status, 502);
    assert.deepEqual(res.json, { error: 'voice_failed' });
    fakeRetell(201, { call_id: 'bad id', access_token: 't' });
    assert.equal((await mint(proto.token)).status, 502);
    const { rows } = await pool.query(`SELECT status FROM voice_demo_calls ORDER BY created_at`);
    assert.deepEqual(rows.map((r) => r.status), ['failed', 'failed']);
    reply = null;
    const avail = await request('GET', `/api/public/prototypes/${proto.token}/voice`);
    assert.equal(avail.json.calls_left, 2);
  });

  it('expired is 410, revoked is 404, and an IP gets four calls an hour', async () => {
    const expired = await makeProto({ expired: true });
    assert.equal((await mint(expired.token)).status, 410);
    const revoked = await makeProto({ revoked: true });
    assert.equal((await mint(revoked.token)).status, 404);
    _resetIpLimitForTests();
    const ids = [];
    for (let i = 0; i < 4; i += 1) ids.push(await makeProto());
    for (const proto of ids) assert.notEqual((await mint(proto.token)).json?.error, 'voice_rate');
    const fifth = await mint(ids[0].token);
    assert.equal(fifth.status, 429);
    assert.deepEqual(fifth.json, { error: 'voice_rate' });
    now = new Date('2026-10-29T19:00:01Z');
    assert.notEqual((await mint(ids[0].token)).json?.error, 'voice_rate', 'next clock hour');
  });

  it('the call_ended webhook settles minutes once, and only with a valid signature', async () => {
    const proto = await makeProto();
    const started = await mint(proto.token);
    const callId = started.json.call_id;
    const ended = { event: 'call_ended', call: { call_id: callId, start_timestamp: 1000, end_timestamp: 62_500 } };
    const forged = await hook(ended, { key: 'key_other0123456789abcd' });
    assert.equal(forged.status, 401);
    const stale = await hook(ended, { stamp: now.getTime() - 10 * 60 * 1000 });
    assert.equal(stale.status, 401);
    const ok = await hook(ended);
    assert.equal(ok.status, 204);
    const again = await hook(ended);
    assert.equal(again.status, 204);
    const { rows } = await pool.query(`SELECT status, actual_seconds FROM voice_demo_calls WHERE call_id = $1`, [callId]);
    assert.deepEqual(rows[0], { status: 'ended', actual_seconds: 62 });
    const other = await hook({ event: 'call_started', call: { call_id: callId } });
    assert.equal(other.status, 204);
    const avail = await request('GET', `/api/public/prototypes/${proto.token}/voice`);
    assert.equal(avail.json.calls_left, 1, '62 s used + 180 s per call fits 360 s once more');
    _setVoiceConfigForTests(null);
    assert.equal((await hook(ended)).status, 503, 'no key to verify with');
  });

  it('settles an unreadable length to the full reservation, a never-joined call to zero, and ignores other agents', async () => {
    assert.equal(callSeconds({ duration_ms: 61_000 }), 61);
    assert.equal(callSeconds({ duration_ms: 10_000, start_timestamp: 0, end_timestamp: 95_000 }), 95, 'the larger source');
    assert.equal(callSeconds({ disconnection_reason: 'user_hangup' }), null);
    assert.equal(callSeconds({ disconnection_reason: 'error_user_not_joined' }), 0);
    const a = await makeProto();
    const first = (await mint(a.token)).json.call_id;
    const second = (await mint(a.token)).json.call_id;
    assert.equal((await hook({ event: 'call_ended', call: { call_id: first, disconnection_reason: 'user_hangup' } })).status, 204);
    assert.equal((await hook({ event: 'call_ended', call: { call_id: second, agent_id: 'agent_someoneelse1' } })).status, 204);
    const row = async (id) => (await pool.query(`SELECT status, actual_seconds FROM voice_demo_calls WHERE call_id = $1`, [id])).rows[0];
    assert.deepEqual(await row(first), { status: 'ended', actual_seconds: 180 }, 'unknown length keeps the full reservation');
    assert.deepEqual(await row(second), { status: 'reserved', actual_seconds: null }, 'another agent is ignored');
  });

  it('the sweeper asks Retell to stop a call once it outlives its maximum, once', async () => {
    const proto = await makeProto();
    const callId = (await mint(proto.token)).json.call_id;
    assert.equal(await sweepOverdue(new Date(now.getTime() + 200 * 1000)), 0, 'still inside 3 min + grace');
    assert.equal(await sweepOverdue(new Date(now.getTime() + 240 * 1000)), 1);
    assert.deepEqual(stops, [`https://api.retellai.com/v2/stop-call/${callId}`]);
    assert.equal(await sweepOverdue(new Date(now.getTime() + 300 * 1000)), 0, 'asked once');
    _setVoiceConfigForTests(null);
    assert.equal(await sweepOverdue(new Date(now.getTime() + 900 * 1000)), 0);
  });

  it('keeps the IP map bounded and refuses new addresses past the bound', async () => {
    const proto = await makeProto();
    for (let i = 0; i < 5000; i += 1) {
      await request('GET', `/api/public/prototypes/${proto.token}/voice`, { headers: { 'x-forwarded-for': `10.${(i >> 16) & 255}.${(i >> 8) & 255}.${i & 255}` } }).catch(() => {});
      if (_ipLimitSizeForTests() >= 5000) break;
    }
    assert.equal(_ipLimitSizeForTests() <= 5000, true);
    const fresh = await request('GET', `/api/public/prototypes/${proto.token}/voice`, { headers: { 'x-forwarded-for': '203.0.113.9' } });
    assert.equal(fresh.status, 429);
    now = new Date('2026-10-29T19:00:00Z');
    const nextHour = await request('GET', `/api/public/prototypes/${proto.token}/voice`, { headers: { 'x-forwarded-for': '203.0.113.9' } });
    assert.equal(nextHour.status, 200, 'the map resets each clock hour');
    assert.equal(_ipLimitSizeForTests(), 1);
  });

  it('parser errors and OPTIONS are stamped and carry no CORS header', async () => {
    const proto = await makeProto();
    const origin = 'https://flowforward-engine-six.vercel.app';
    const big = await request('POST', `/api/public/prototypes/${proto.token}/voice/session`, { raw: JSON.stringify({ x: 'y'.repeat(4000) }), origin });
    assert.equal(big.status, 413);
    assert.deepEqual(big.json, { error: 'payload_too_large' });
    assert.equal(big.headers['access-control-allow-origin'], undefined);
    assert.equal(big.headers['x-robots-tag'], 'noindex, nofollow');
    const bad = await request('POST', `/api/public/prototypes/${proto.token}/voice/session`, { raw: '{nope', origin });
    assert.equal(bad.status, 400);
    assert.equal(bad.headers['access-control-allow-origin'], undefined);
    const pre = await request('OPTIONS', `/api/public/prototypes/${proto.token}/voice/session`, { origin, headers: { 'access-control-request-method': 'POST' } });
    assert.equal(pre.status, 204);
    assert.equal(pre.headers['access-control-allow-origin'], origin);
    assert.equal(pre.headers['cache-control'], 'no-store');
    assert.equal(pre.headers['referrer-policy'], 'no-referrer');
    const hookBig = await request('POST', '/api/public/voice/retell-webhook', { raw: 'x'.repeat(1024 * 1024 + 10) });
    assert.equal(hookBig.status, 413);
    assert.equal(hookBig.text, '{"error":"payload_too_large"}');
  });

  it('deleting a lead keeps its minutes counted for the day', async () => {
    _setVoiceConfigForTests({ ...CONFIG, dailySeconds: 360 });
    const a = await makeProto();
    const b = await makeProto();
    assert.equal((await mint(a.token)).status, 201);
    await pool.query(`DELETE FROM prospects WHERE id = $1`, [a.lead.id]);
    const { rows } = await pool.query(`SELECT prototype_id, status FROM voice_demo_calls`);
    assert.deepEqual(rows, [{ prototype_id: null, status: 'reserved' }]);
    assert.equal((await mint(b.token)).status, 201);
    assert.deepEqual((await mint(b.token)).json, { error: 'voice_limit', reason: 'day' });
  });

  it('the agent hears the same business name the chat uses', async () => {
    const proto = await makeProto({ brand: 'Sample Ridge HVAC LLC' });
    await pool.query(
      `INSERT INTO prototype_facts (prospect_id, field, value, source, captured_at, test_tag, review_status)
       VALUES ($1, 'business_name', 'Sample Ridge Heating', 'manual', NOW(), 'demo-prototype', 'approved')`,
      [proto.lead.id]
    );
    await mint(proto.token);
    assert.equal(calls[0].body.retell_llm_dynamic_variables.business_name, 'Sample Ridge Heating');
  });

  it('the CRM voice status needs the key and never returns the Retell key or agent', async () => {
    const proto = await makeProto();
    await mint(proto.token);
    const noKey = await request('GET', '/api/chat/voice');
    assert.equal(noKey.status, 401);
    const res = await request('GET', '/api/chat/voice', { key: true });
    assert.equal(res.status, 200);
    assert.equal(res.json.configured, true);
    assert.equal(res.json.daily_minutes, 30);
    assert.equal(res.json.today.calls, 1);
    assert.equal(res.json.today.held_seconds, 180);
    assert.match(res.json.webhook_url, /\/api\/public\/voice\/retell-webhook$/);
    assert.match(res.json.prompt, /\{\{business_name\}\}/);
    assert.equal(res.text.includes(KEY), false);
    assert.equal(res.text.includes(CONFIG.agentId), false);
    console.log('[voicedemo] CRM status reads minutes without secrets');
  });
});
