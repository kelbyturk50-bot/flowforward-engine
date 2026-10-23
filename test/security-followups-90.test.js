process.env.CRM_API_KEY = 'test-issue-90-key-32chars-minimum!!';
process.env.CORS_ORIGINS = '';

require('./preload');

// Issue #90 items 3 and 5, measured on the real server.js mount.
// Disposable Postgres. No mail, Places, or Anthropic. CORS_ORIGINS is empty,
// which is the case that used to send Access-Control-Allow-Origin: *.

const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const tokens = require('../src/prototypes/tokens');
const { resetDb, insertProspect, closePool, pool } = require('./fixtures');

const ROOT = path.join(__dirname, '..');
const KEY = process.env.CRM_API_KEY;
const PRODUCTION_ORIGIN = 'https://flowforward-engine-six.vercel.app';
const EVIL_ORIGIN = 'https://evil.example';
const MARKER = 'ZZ_PROTO_413_MARKER';

function request(port, method, reqPath, { body, origin, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const reqHeaders = { ...headers };
    if (origin) reqHeaders.origin = origin;
    const payload = body == null ? null : body;
    if (payload) {
      reqHeaders['content-type'] = reqHeaders['content-type'] || 'application/json';
      reqHeaders['content-length'] = String(payload.length);
    }
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

function assertNoStar(res, label) {
  assert.notEqual(res.headers['access-control-allow-origin'], '*', label);
  assert.equal(res.headers['access-control-allow-origin'], undefined, label);
  assert.equal(res.headers['access-control-allow-credentials'], undefined, label);
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

describe('issue 90 public prototype limits and CORS', { timeout: 180000 }, () => {
  let child;
  let port;
  let output = '';
  let liveToken;
  let expiredToken;

  before(async () => {
    await resetDb();
    const liveLead = await insertProspect({
      google_place_id: 'test-place-issue-90-live',
      company: 'TEST: Issue Ninety Heating',
      email: 'test+issue90@example.invalid',
      website: null,
    });
    const expiredLead = await insertProspect({
      google_place_id: 'test-place-issue-90-expired',
      company: 'TEST: Issue Ninety Expired',
      email: 'test+issue90expired@example.invalid',
      website: null,
    });
    const live = tokens.mintToken();
    const expired = tokens.mintToken();
    assert.ok(live && expired);
    liveToken = live.token;
    expiredToken = expired.token;
    await pool.query(
      `INSERT INTO prototypes
         (prospect_id, agent_type, brand_name, color_primary, color_secondary, token_hash, nonce, issued_at, expires_at)
       VALUES ($1, 'scheduling', 'TEST Heating', '#1F4E79', '#F0C14A', $2, $3, NOW(), NOW() + INTERVAL '336 hours')`,
      [liveLead.id, live.hash, live.nonce]
    );
    await pool.query(
      `INSERT INTO prototypes
         (prospect_id, agent_type, brand_name, color_primary, color_secondary, token_hash, nonce, issued_at, expires_at)
       SELECT $1, 'scheduling', 'TEST Heating', '#1F4E79', '#F0C14A', $2, $3,
              issued_at, issued_at + INTERVAL '336 hours'
         FROM (SELECT NOW() - INTERVAL '400 hours' AS issued_at) stamp`,
      [expiredLead.id, expired.hash, expired.nonce]
    );

    port = await freePort();
    const env = {
      ...process.env,
      PORT: String(port),
      NODE_ENV: 'test',
      DISABLE_CRON: '1',
      CORS_ORIGINS: '',
      CRM_API_KEY: KEY,
      PILOT_DEMO_RATE_MAX: '1000',
    };
    child = spawn(process.execPath, [path.join(ROOT, 'src/server.js')], {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.on('data', (buf) => { output += buf.toString('utf8'); });
    child.stderr.on('data', (buf) => { output += buf.toString('utf8'); });
    await new Promise((resolve, reject) => {
      const deadline = Date.now() + 20000;
      const attempt = () => {
        if (child.exitCode != null) {
          reject(new Error(`server exited ${child.exitCode}: ${output.slice(0, 500)}`));
          return;
        }
        const req = http.request({
          method: 'GET', hostname: '127.0.0.1', port, path: '/health',
        }, (res) => {
          res.resume();
          res.on('end', () => resolve(res.statusCode));
        });
        req.on('error', () => {
          if (Date.now() > deadline) reject(new Error(`server did not listen: ${output.slice(0, 500)}`));
          else setTimeout(attempt, 100);
        });
        req.end();
      };
      attempt();
    });
  });

  after(async () => {
    if (child && child.exitCode == null) {
      child.kill('SIGTERM');
      await new Promise((resolve) => {
        const timer = setTimeout(() => { child.kill('SIGKILL'); }, 2000);
        child.once('exit', () => { clearTimeout(timer); resolve(); });
      });
    }
    await closePool();
  });

  it('a 2 MB JSON body on the public prototype read is a stamped 413', async () => {
    const token = 'a'.repeat(43);
    const pathName = `/api/public/prototypes/${token}`;
    const big = Buffer.alloc(2 * 1024 * 1024, 0x61);
    Buffer.from(MARKER).copy(big);
    const over = Buffer.alloc(2049, 0x62);
    for (const [label, body] of [['2mb', big], ['2049', over]]) {
      const res = await request(port, 'GET', pathName, { body, origin: PRODUCTION_ORIGIN });
      assert.equal(res.status, 413, label);
      assert.deepEqual(res.json, { error: 'Payload too large' });
      assert.equal(res.headers['cache-control'], 'no-store', label);
      assert.equal(res.headers['x-robots-tag'], 'noindex, nofollow', label);
      assert.equal(res.headers['x-content-type-options'], 'nosniff', label);
      assertNoStar(res, label);
      assert.equal(res.text.includes('<html'), false, label);
      assert.equal(res.text.includes('PayloadTooLargeError'), false, label);
      assert.equal(res.text.includes('entity.too.large'), false, label);
      assert.equal(res.text.includes(MARKER), false, label);
    }
    const small = await request(port, 'GET', pathName, {
      origin: EVIL_ORIGIN,
      headers: { 'x-forwarded-for': '203.0.113.90' },
    });
    assert.equal(small.status, 404);
    assert.deepEqual(small.json, { error: 'not_found' });
    assert.equal(output.includes(MARKER), false);
    console.log('[issue-90] 2 MB and 2049-byte public prototype bodies are stamped 413; a small GET stays 404');
  });

  it('public prototype JSON, page, and font responses never send ACAO *', async () => {
    const cases = [
      ['GET', `/api/public/prototypes/${liveToken}`, 200],
      ['GET', `/api/public/prototypes/${expiredToken}`, 410],
      ['GET', `/api/public/prototypes/${'b'.repeat(43)}`, 404],
      ['GET', `/demo/prototype/${liveToken}`, 200],
      ['GET', `/demo/prototype/${expiredToken}`, 410],
      ['GET', `/demo/prototype/${'c'.repeat(43)}`, 404],
      ['GET', '/demo/prototype-assets/OFL-LICENSE.txt', 200],
    ];
    let n = 100;
    for (const origin of [EVIL_ORIGIN, PRODUCTION_ORIGIN, undefined]) {
      for (const [method, reqPath, status] of cases) {
        n += 1;
        const res = await request(port, method, reqPath, {
          origin,
          headers: { 'x-forwarded-for': `203.0.113.${n % 200}` },
        });
        assert.equal(res.status, status, `${origin || 'none'} ${reqPath}`);
        assertNoStar(res, `${origin || 'none'} ${reqPath}`);
        if (reqPath.includes('/api/public/prototypes/') && status === 410) {
          assert.equal(res.json.error, 'link_expired');
        }
        if (reqPath.includes('/api/public/prototypes/') && status === 404) {
          assert.deepEqual(res.json, { error: 'not_found' });
        }
        if (reqPath.includes('/api/public/prototypes/') && status === 200) {
          assert.equal(res.json.brand_name, 'TEST Heating');
          assert.equal(res.json.watermark, true);
        }
      }
    }
    console.log('[issue-90] prototype JSON 200/404/410, page, and font responses have no ACAO');
  });

  it('mixed-case GET and OPTIONS on prototype routes send no ACAO', async () => {
    const preflight = { 'access-control-request-method': 'GET', 'x-forwarded-for': '203.0.113.40' };
    const cases = [
      ['GET', `/API/Public/Prototypes/${liveToken}`, 200, { 'x-forwarded-for': '203.0.113.41' }],
      ['OPTIONS', `/Api/Public/Prototypes/${liveToken}`, null, preflight],
      ['GET', `/Demo/Prototype/${liveToken}`, 200, { 'x-forwarded-for': '203.0.113.42' }],
      ['OPTIONS', `/DEMO/prototype/${liveToken}`, null, { ...preflight, 'x-forwarded-for': '203.0.113.43' }],
      ['GET', '/DEMO/PROTOTYPE-ASSETS/OFL-LICENSE.txt', 200, { 'x-forwarded-for': '203.0.113.44' }],
      ['OPTIONS', '/demo/Prototype-Assets/OFL-LICENSE.txt', null, { ...preflight, 'x-forwarded-for': '203.0.113.45' }],
      ['GET', `/demo/prototype/${liveToken}/`, 200, { 'x-forwarded-for': '203.0.113.46' }],
      ['OPTIONS', `/demo/prototype/${liveToken}/`, null, { ...preflight, 'x-forwarded-for': '203.0.113.47' }],
      ['GET', `/demo/prototype//${liveToken}`, 200, { 'x-forwarded-for': '203.0.113.48' }],
    ];
    for (const [method, reqPath, status, headers] of cases) {
      const res = await request(port, method, reqPath, { origin: EVIL_ORIGIN, headers });
      if (status != null) assert.equal(res.status, status, reqPath);
      assertNoStar(res, `${method} ${reqPath}`);
    }
    const unrouted = await request(port, 'GET', `/demo//prototype/${liveToken}`, {
      origin: EVIL_ORIGIN,
      headers: { 'x-forwarded-for': '203.0.113.49' },
    });
    assert.equal(unrouted.status, 404);
    assert.equal(unrouted.headers['access-control-allow-origin'], '*');
    console.log('[issue-90] mixed-case GET and OPTIONS on prototype routes have no ACAO');
  });

  it('GET, POST, and OPTIONS on unmatched prototype sub-paths send no ACAO', async () => {
    const cases = [
      ['GET', '/api/public/prototypes/nope/extra', 404],
      ['POST', '/api/public/prototypes/nope/extra', 405],
      ['OPTIONS', '/api/public/prototypes/nope/extra', 405],
      ['GET', '/demo/prototype/nope/extra', 404],
      ['POST', '/demo/prototype/nope/extra', 405],
      ['OPTIONS', '/demo/prototype/nope/extra', 405],
      ['GET', '/demo/prototype-assets/no-such-file.woff2', 404],
      ['POST', '/demo/prototype-assets/no-such-file.woff2', 405],
      ['OPTIONS', '/demo/prototype-assets/missing/nested.txt', 405],
    ];
    let n = 160;
    for (const [method, reqPath, status] of cases) {
      n += 1;
      const res = await request(port, method, reqPath, {
        origin: EVIL_ORIGIN,
        headers: {
          'x-forwarded-for': `198.51.100.${n}`,
          'access-control-request-method': 'POST',
        },
      });
      assert.equal(res.status, status, `${method} ${reqPath}`);
      assertNoStar(res, `${method} ${reqPath}`);
    }
    console.log('[issue-90] unmatched prototype sub-paths have no ACAO');
  });

  it('a malformed JSON body on the public prototype read is a stamped 400', async () => {
    const res = await request(port, 'GET', `/api/public/prototypes/${liveToken}`, {
      body: Buffer.from('{'),
      origin: EVIL_ORIGIN,
      headers: { 'x-forwarded-for': '203.0.113.39' },
    });
    assert.equal(res.status, 400);
    assert.deepEqual(res.json, { error: 'invalid_body' });
    assert.equal(res.headers['cache-control'], 'no-store');
    assert.equal(res.headers['x-robots-tag'], 'noindex, nofollow');
    assert.equal(res.headers['x-content-type-options'], 'nosniff');
    assertNoStar(res, 'malformed');
    assert.equal(res.text.includes('<html'), false);
    console.log('[issue-90] malformed public prototype JSON is a stamped 400');
  });

  it('keeps chat and flag allowlists and global CORS on other routes', async () => {
    const preflight = await request(port, 'OPTIONS', '/api/public/chat/demos/wasatch-heating/session', {
      origin: PRODUCTION_ORIGIN,
      headers: {
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'content-type',
      },
    });
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers['access-control-allow-origin'], PRODUCTION_ORIGIN);
    assert.notEqual(preflight.headers['access-control-allow-origin'], '*');

    const flags = await request(port, 'GET', '/api/public/flags', { origin: PRODUCTION_ORIGIN });
    assert.equal(flags.status, 200);
    assert.equal(flags.headers['access-control-allow-origin'], PRODUCTION_ORIGIN);

    const protoPreflight = await request(port, 'OPTIONS', '/api/public/prototypes/not-a-token/chat/session', {
      origin: PRODUCTION_ORIGIN,
      headers: { 'access-control-request-method': 'POST' },
    });
    assert.equal(protoPreflight.status, 204);
    assert.equal(protoPreflight.headers['access-control-allow-origin'], PRODUCTION_ORIGIN);

    const health = await request(port, 'GET', '/health', { origin: EVIL_ORIGIN });
    assert.equal(health.status, 200);
    assert.equal(health.headers['access-control-allow-origin'], '*');
    console.log('[issue-90] chat and flags still echo an allowed origin; /health still uses global CORS');
  });

  it('CRM-origin 401 and 503 on /api/chat keep ACAO when CORS_ORIGINS is set', { timeout: 120000 }, async () => {
    const serverSrc = fs.readFileSync(path.join(ROOT, 'src/server.js'), 'utf8');
    const corsAt = serverSrc.indexOf('const corsMiddleware = cors(');
    const chatAuthAt = serverSrc.indexOf("app.use('/api/chat', requireApiKey)");
    const parserAt = serverSrc.indexOf("app.use(express.json({ limit: '1mb' }))");
    assert.ok(corsAt > 0 && corsAt < chatAuthAt && chatAuthAt < parserAt);

    async function boot(key) {
      const listenPort = await freePort();
      const env = {
        ...process.env,
        PORT: String(listenPort),
        NODE_ENV: 'test',
        DISABLE_CRON: '1',
        CORS_ORIGINS: PRODUCTION_ORIGIN,
        CRM_API_KEY: key,
        GOOGLE_PLACES_API_KEY: '',
        ANTHROPIC_API_KEY: '',
        GMAIL_USER: '',
        GMAIL_APP_PASSWORD: '',
      };
      let log = '';
      const proc = spawn(process.execPath, [path.join(ROOT, 'src/server.js')], {
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      proc.stdout.on('data', (buf) => { log += buf.toString('utf8'); });
      proc.stderr.on('data', (buf) => { log += buf.toString('utf8'); });
      await new Promise((resolve, reject) => {
        const deadline = Date.now() + 20000;
        const attempt = () => {
          if (proc.exitCode != null) {
            reject(new Error(`server exited ${proc.exitCode}: ${log.slice(0, 500)}`));
            return;
          }
          const req = http.request({
            method: 'GET', hostname: '127.0.0.1', port: listenPort, path: '/health',
          }, (res) => {
            res.resume();
            res.on('end', () => resolve());
          });
          req.on('error', () => {
            if (Date.now() > deadline) reject(new Error(`server did not listen: ${log.slice(0, 500)}`));
            else setTimeout(attempt, 100);
          });
          req.end();
        };
        attempt();
      });
      return {
        port: listenPort,
        async stop() {
          if (proc.exitCode != null) return;
          proc.kill('SIGTERM');
          await new Promise((resolve) => {
            const timer = setTimeout(() => { proc.kill('SIGKILL'); }, 2000);
            proc.once('exit', () => { clearTimeout(timer); resolve(); });
          });
        },
      };
    }

    async function expectAuth(listenPort, status, error) {
      const cases = [
        ['GET', '/api/chat'],
        ['GET', '/api/chat/x'],
        ['HEAD', '/api/chat'],
        ['POST', '/api/chat/facts'],
        // Malformed JSON: the real server must answer with auth, not the
        // parser's 400, so the key check runs before express.json().
        ['POST', '/api/chat/facts', '{"a":'],
      ];
      for (const [method, reqPath, body] of cases) {
        const res = await request(listenPort, method, reqPath, { origin: PRODUCTION_ORIGIN, body });
        assert.equal(res.status, status, `${status} ${method} ${reqPath}`);
        if (method !== 'HEAD') assert.equal(res.json && res.json.error, error, `${method} ${reqPath}`);
        assert.equal(res.headers['access-control-allow-origin'], PRODUCTION_ORIGIN, `${method} ${reqPath}`);
        assert.notEqual(res.headers['access-control-allow-origin'], '*', `${method} ${reqPath}`);
      }
    }

    const ready = await boot(KEY);
    try {
      await expectAuth(ready.port, 401, 'Missing or invalid API key');
      const preflight = await request(ready.port, 'OPTIONS', '/api/chat/facts', {
        origin: PRODUCTION_ORIGIN,
        headers: {
          'access-control-request-method': 'POST',
          'access-control-request-headers': 'content-type,x-api-key',
        },
      });
      assert.equal(preflight.status, 204);
      assert.equal(preflight.headers['access-control-allow-origin'], PRODUCTION_ORIGIN);
      const prototypes = [
        ['GET', '/demo/prototype/no-such/extra', 404],
        ['POST', '/demo/prototype/no-such/extra', 405],
        ['OPTIONS', '/demo/prototype/no-such/extra', 405],
        ['GET', '/api/public/prototypes/nope/extra', 404],
        ['POST', '/api/public/prototypes/nope/extra', 405],
        ['OPTIONS', '/api/public/prototypes/nope/extra', 405],
        ['GET', '/demo/prototype-assets/no-such-file.woff2', 404],
        ['OPTIONS', '/demo/prototype-assets/missing/nested.txt', 405],
      ];
      for (const [method, reqPath, status] of prototypes) {
        const res = await request(ready.port, method, reqPath, {
          origin: PRODUCTION_ORIGIN,
          headers: { 'access-control-request-method': 'GET' },
        });
        assert.equal(res.status, status, `${method} ${reqPath}`);
        assert.equal(res.headers['access-control-allow-origin'], undefined, `${method} ${reqPath}`);
      }
    } finally {
      await ready.stop();
    }

    const closed = await boot('too-short');
    try {
      await expectAuth(closed.port, 503, 'api_key_not_configured');
    } finally {
      await closed.stop();
    }
    console.log('[issue-90] /api/chat 401 and 503 keep the CRM origin; prototype prefixes send no ACAO');
  });
});
