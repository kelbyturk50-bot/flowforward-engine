process.env.CRM_API_KEY = 'test-json-errors-key-32-characters!!';
require('./preload');

// Malformed JSON is a JSON 400 with no stack, including when NODE_ENV is not
// production. /api/chat checks the key before the body is parsed.

const http = require('http');
const fs = require('fs');
const path = require('path');
const express = require('express');
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const requireApiKey = require('../src/api/auth');
const jsonErrorHandler = require('../src/api/json-errors');

const KEY = process.env.CRM_API_KEY;

function request(port, method, reqPath, { body, key, raw } = {}) {
  return new Promise((resolve, reject) => {
    const payload = raw != null ? raw : (body == null ? null : Buffer.from(JSON.stringify(body)));
    const headers = {};
    if (payload) {
      headers['content-type'] = 'application/json';
      headers['content-length'] = String(payload.length);
    }
    if (key) headers['x-api-key'] = key;
    const req = http.request({ hostname: '127.0.0.1', port, path: reqPath, method, headers }, (res) => {
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

describe('shared JSON error handler', () => {
  let server;
  let port;
  let prospectHits = 0;

  before(async () => {
    assert.notEqual(process.env.NODE_ENV, 'production');
    const app = express();
    app.use('/api/chat', requireApiKey);
    app.use(express.json({ limit: '1mb' }));
    app.use('/api', requireApiKey);
    app.post('/api/prospects', (req, res) => {
      prospectHits += 1;
      res.json({ ok: true });
    });
    app.use('/demo/estimate-recovery', require('../src/pilot/demo').router);
    app.use('/api/chat', require('../src/api/chat'));
    app.use(jsonErrorHandler);
    server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = server.address().port;
  });

  after(async () => {
    if (server) await new Promise((resolve) => server.close(resolve));
  });

  it('malformed JSON is invalid_body with no stack, and chat auth runs first', async () => {
    const src = fs.readFileSync(path.join(__dirname, '../src/api/json-errors.js'), 'utf8');
    assert.equal(src.includes('NODE_ENV'), false);
    assert.equal(src.includes('err.stack'), false);
    assert.equal(src.includes('err.message'), false);
    const serverSrc = fs.readFileSync(path.join(__dirname, '../src/server.js'), 'utf8');
    const chatAuth = serverSrc.indexOf("app.use('/api/chat', requireApiKey)");
    const parser = serverSrc.indexOf("app.use(express.json({ limit: '1mb' }))");
    const handler = serverSrc.indexOf("require('./api/json-errors')");
    assert.ok(chatAuth > 0 && chatAuth < parser);
    assert.ok(handler > parser);

    const raw = Buffer.from('{"a":');
    const leaked = (text) => text.includes('SyntaxError') || text.includes('<html') || text.includes('at JSON') || text.includes('/workspace');

    prospectHits = 0;
    const prospects = await request(port, 'POST', '/api/prospects', { raw, key: KEY });
    assert.equal(prospects.status, 400);
    assert.equal(prospects.text, '{"error":"invalid_body"}');
    assert.match(String(prospects.headers['content-type']), /^application\/json/);
    assert.equal(prospects.headers['x-content-type-options'], 'nosniff');
    assert.equal(leaked(prospects.text), false);
    assert.equal(prospectHits, 0);

    const anon = await request(port, 'POST', '/api/prospects', { raw });
    assert.equal(anon.status, 400);
    assert.equal(anon.text, '{"error":"invalid_body"}');
    assert.equal(leaked(anon.text), false);

    const demo = await request(port, 'POST', '/demo/estimate-recovery/not-a-token', { raw });
    assert.equal(demo.status, 400);
    assert.equal(demo.text, '{"error":"invalid_body"}');
    assert.equal(leaked(demo.text), false);

    const chatAnon = await request(port, 'POST', '/api/chat/facts', { raw });
    assert.equal(chatAnon.status, 401);
    assert.equal(chatAnon.json.error, 'Missing or invalid API key');
    assert.equal(leaked(chatAnon.text), false);

    const saved = process.env.CRM_API_KEY;
    delete process.env.CRM_API_KEY;
    try {
      const closed = await request(port, 'POST', '/api/chat/facts', { raw, key: KEY });
      assert.equal(closed.status, 503);
      assert.equal(closed.json.error, 'api_key_not_configured');
      assert.equal(leaked(closed.text), false);
    } finally {
      process.env.CRM_API_KEY = saved;
    }

    const chatBad = await request(port, 'POST', '/api/chat/facts', { raw, key: KEY });
    assert.equal(chatBad.status, 400);
    assert.equal(chatBad.text, '{"error":"invalid_body"}');
    assert.equal(leaked(chatBad.text), false);

    const ok = await request(port, 'POST', '/api/prospects', { body: { a: 1 }, key: KEY });
    assert.equal(ok.status, 200);
    assert.equal(ok.json.ok, true);
    assert.equal(prospectHits, 1);
    console.log('[json-errors] malformed JSON is invalid_body with no stack; /api/chat auth is 401 or 503 first');
  });
});
