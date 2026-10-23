require('./preload');

// Shared /api auth fails closed (#83, #86). Disposable Postgres, mock mail
// transport. No Gmail, Places, or Anthropic.

const fs = require('fs');
const http = require('http');
const path = require('path');
const express = require('express');
const cors = require('cors');
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const send = require('../src/proposals/send');
const { resetDb, insertProspect, closePool, pool } = require('./fixtures');

const READY_KEY = 'a'.repeat(32);
const INNER_SPACES = `${'d'.repeat(8)}${' '.repeat(16)}${'d'.repeat(9)}`;

const sentMails = [];

function request(port, method, reqPath, { key, headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const reqHeaders = { ...headers };
    if (payload) {
      reqHeaders['content-type'] = 'application/json';
      reqHeaders['content-length'] = String(payload.length);
    }
    if (key !== undefined) reqHeaders['x-api-key'] = key;
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      method,
      path: reqPath,
      headers: reqHeaders,
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

describe('api auth fails closed', { concurrency: false }, () => {
  let server;
  let port;
  let itemId;
  let replyBody;

  before(async () => {
    process.env.CRM_API_KEY = READY_KEY;
    await resetDb();
    send._setTransport({
      async sendMail(mail) {
        sentMails.push(mail);
        return { id: 'gm-auth-1', threadId: 'thr-auth', messageId: '<out-auth@mail>' };
      },
    });
    const lead = await insertProspect({
      google_place_id: 'test-place-api-auth',
      company: 'TEST: Auth Heating',
      email: 'test+auth@example.test',
      contact_name: 'Dana',
      stage: 'contacted',
    });
    const message = await pool.query(
      `INSERT INTO inbox_messages
         (prospect_id, direction, dedupe_key, thread_id, header_message_id, from_addr, subject, body)
       VALUES ($1, 'in', 'auth-dedupe', 'thr-auth', '<in-auth@mail>', 'test+auth@example.test', 'Hello', 'Need a quote')
       RETURNING id`,
      [lead.id]
    );
    replyBody = 'Thanks, we can help.';
    const item = await pool.query(
      `INSERT INTO inbox_items (prospect_id, message_id, status, reply_to, reply_subject, reply_body)
       VALUES ($1, $2, 'ready', 'test+auth@example.test', 'Re: Hello', $3)
       RETURNING id`,
      [lead.id, message.rows[0].id, replyBody]
    );
    itemId = item.rows[0].id;

    const app = express();
    app.use(cors());
    app.use(express.json());
    app.get('/health', (req, res) => res.json({ status: 'ok' }));
    app.use('/api/public/prototypes', require('../src/prototypes/public').router);
    app.use('/api', require('../src/api/auth'));
    app.use('/api/prospects', require('../src/api/prospects'));
    app.use('/api/inbox', require('../src/api/inbox'));
    server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = server.address().port;
  });

  after(async () => {
    send._setTransport(null);
    if (server) await new Promise((resolve) => server.close(resolve));
    await closePool();
  });

  it('closes every sampled /api route when the key is not ready, and still answers preflight', async () => {
    const serverSrc = fs.readFileSync(path.join(__dirname, '../src/server.js'), 'utf8');
    const at = (needle) => {
      const index = serverSrc.indexOf(needle);
      assert.ok(index !== -1, needle);
      return index;
    };
    const authAt = at("app.use('/api', requireApiKey)");
    assert.ok(at("app.get('/health'") < authAt);
    assert.ok(at("app.use('/p'") < authAt);
    assert.ok(at("app.use('/demo/estimate-recovery'") < authAt);
    assert.ok(at("app.use('/api/public/prototypes'") < authAt);
    assert.ok(authAt < at("app.use('/api/inbox'"));

    assert.equal(INNER_SPACES.length, 33);
    assert.equal(INNER_SPACES.replace(/\s/g, '').length, 17);
    const cases = [
      ['unset', undefined],
      ['empty', ''],
      ['spaces', ' '.repeat(32)],
      ['inner-spaces', INNER_SPACES],
      ['31', 'x'.repeat(31)],
    ];
    const sendPath = `/api/inbox/${itemId}/send`;
    const detailPath = `/api/inbox/${itemId}`;
    const routes = [
      ['GET', '/api/prospects'],
      ['GET', '/api/inbox'],
      ['GET', detailPath],
      ['PATCH', detailPath],
      ['POST', sendPath],
    ];

    for (const [label, key] of cases) {
      if (key === undefined) delete process.env.CRM_API_KEY;
      else process.env.CRM_API_KEY = key;
      const health = await request(port, 'GET', '/health');
      assert.equal(health.status, 200, label);
      const pub = await request(port, 'GET', `/api/public/prototypes/${'a'.repeat(43)}`);
      assert.equal(pub.status, 404, label);
      assert.notEqual(pub.json && pub.json.error, 'api_key_not_configured', label);
      for (const reqPath of ['/api/prospects', sendPath]) {
        const preflight = await request(port, 'OPTIONS', reqPath, {
          headers: {
            origin: 'https://evil.example',
            'access-control-request-method': reqPath === sendPath ? 'POST' : 'GET',
            'access-control-request-headers': 'x-api-key,content-type',
          },
        });
        assert.equal(preflight.status, 204, `${label} ${reqPath} preflight`);
        assert.equal(preflight.headers['access-control-allow-origin'], '*', label);
      }
      for (const presented of [undefined, key]) {
        for (const [method, reqPath] of routes) {
          const res = await request(port, method, reqPath, {
            key: presented,
            body: method === 'PATCH' ? { reply_body: 'should not stick' } : undefined,
          });
          assert.equal(res.status, 503, `${label} ${method} ${reqPath} header=${presented === undefined ? 'none' : 'set'}`);
          assert.deepEqual(res.json, { error: 'api_key_not_configured' });
          assert.equal(JSON.stringify(res.json).includes('test+auth@'), false, label);
          assert.equal(JSON.stringify(res.json).includes('Need a quote'), false, label);
        }
      }
      const stored = await pool.query('SELECT reply_body, status FROM inbox_items WHERE id = $1', [itemId]);
      assert.equal(stored.rows[0].reply_body, replyBody, label);
      assert.equal(stored.rows[0].status, 'ready', label);
      assert.equal(sentMails.length, 0, label);
      console.log(`[auth] ${label} key: sampled /api routes 503, preflight 204, send mock 0`);
    }
  });

  it('returns 401 for a ready key with a wrong or missing header, and 200 with the right header', async () => {
    process.env.CRM_API_KEY = READY_KEY;
    const sendPath = `/api/inbox/${itemId}/send`;
    const detailPath = `/api/inbox/${itemId}`;
    const routes = [
      ['GET', '/api/prospects'],
      ['GET', '/api/inbox'],
      ['GET', detailPath],
      ['POST', sendPath],
    ];
    for (const [method, reqPath] of routes) {
      const missing = await request(port, method, reqPath);
      assert.equal(missing.status, 401, `missing ${method} ${reqPath}`);
      assert.deepEqual(missing.json, { error: 'Missing or invalid API key' });
      const wrong = await request(port, method, reqPath, { key: 'b'.repeat(32) });
      assert.equal(wrong.status, 401, `wrong ${method} ${reqPath}`);
      assert.deepEqual(wrong.json, { error: 'Missing or invalid API key' });
    }
    assert.equal(sentMails.length, 0);

    const preflight = await request(port, 'OPTIONS', '/api/prospects', {
      headers: {
        origin: 'https://crm.example',
        'access-control-request-method': 'GET',
        'access-control-request-headers': 'x-api-key',
      },
    });
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers['access-control-allow-origin'], '*');

    const prospects = await request(port, 'GET', '/api/prospects', { key: READY_KEY });
    assert.equal(prospects.status, 200, prospects.text);
    assert.equal(Array.isArray(prospects.json.prospects), true);
    const bearer = await request(port, 'GET', '/api/prospects', {
      headers: { authorization: `Bearer ${READY_KEY}` },
    });
    assert.equal(bearer.status, 200, bearer.text);

    const list = await request(port, 'GET', '/api/inbox', { key: READY_KEY });
    assert.equal(list.status, 200, list.text);
    assert.equal(list.json.items.length, 1);

    const detail = await request(port, 'GET', detailPath, { key: READY_KEY });
    assert.equal(detail.status, 200, detail.text);
    assert.equal(detail.json.lead_email, 'test+auth@example.test');
    assert.equal(detail.json.message_body, 'Need a quote');

    const patched = await request(port, 'PATCH', detailPath, {
      key: READY_KEY,
      body: { reply_body: 'Thanks, Tuesday works.' },
    });
    assert.equal(patched.status, 200, patched.text);
    replyBody = 'Thanks, Tuesday works.';

    const sent = await request(port, 'POST', sendPath, { key: READY_KEY });
    assert.equal(sent.status, 200, sent.text);
    assert.equal(sentMails.length, 1);
    assert.equal(sentMails[0].to, 'test+auth@example.test');
    console.log('[auth] ready key: wrong header 401, right header 200, authed send called the mock once');
  });
});
