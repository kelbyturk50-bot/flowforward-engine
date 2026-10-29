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
      ['VOICE_DEMO_DAILY_MINUTES', '0'], ['VOICE_DEMO_DAILY_MINUTES', '601'], ['VOICE_DEMO_DAILY_MINUTES', '030'],
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
  const { _setClockForTests } = require('../src/voicedemo/public');
  const rateLimit = require('../src/pilot/rate-limit');
  const tokens = require('../src/prototypes/tokens');
  let calls = [];
  let reply = null;
  let now = new Date('2026-10-29T18:00:00Z');

  function request(method, reqPath, { headers = {}, body, raw, key = false, type } = {}) {
    return new Promise((resolve, reject) => {
      const payload = raw != null ? Buffer.from(raw) : (body === undefined ? null : Buffer.from(JSON.stringify(body)));
      const extra = { ...headers };
      if (key === true) extra['x-api-key'] = API_KEY;
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
    rateLimit._resetForTests();
    calls = [];
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

    rateLimit._resetForTests();
    const b = await makeProto();
    assert.equal((await mint(b.token)).status, 201);
    const busy = await mint(b.token);
    assert.deepEqual(busy.json, { error: 'voice_limit', reason: 'busy' }, 'three calls running at once');

    await pool.query('TRUNCATE voice_demo_calls');
    rateLimit._resetForTests();
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
    rateLimit._resetForTests();
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
