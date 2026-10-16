require('./preload');

// SSRF guard. DNS and the socket are mocked. Nothing here dials a public host.

const https = require('https');
const http = require('http');
const zlib = require('zlib');
const { describe, it, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const {
  safeFetch, isBlockedAddress, DEFAULT_MAX_BYTES, DEFAULT_TIMEOUT_MS, DEFAULT_MAX_REDIRECTS,
  _setResolver, _setTransport,
} = require('../src/net/safeFetch');
const { crawlSite } = require('../src/proposals/research');
const { fsmDetectedFromResearch } = require('../src/proposals/servicetitan');
const { draftProposal, _setClient } = require('../src/proposals/draft');
const { insertProspect, closePool, pool, fakeClaude } = require('./fixtures');
const { mockTransport, requestedUrl } = require('./mock-transport');

const PUBLIC = '8.8.8.8';
const PUBLIC_V6 = '2606:4700:4700::1111';

function publicResolver(addresses) {
  const v4 = [];
  const v6 = [];
  for (const address of addresses) {
    if (address.includes(':')) v6.push(address);
    else v4.push(address);
  }
  return {
    async resolve4() { return v4; },
    async resolve6() { return v6; },
  };
}

function silenceWarn() {
  const lines = [];
  const original = console.warn;
  console.warn = (...args) => { lines.push(args.map(String).join(' ')); };
  return {
    lines,
    restore() { console.warn = original; },
  };
}

function htmlResponse(body, extraHeaders = {}) {
  return {
    status: 200,
    headers: { 'content-type': 'text/html; charset=utf-8', ...extraHeaders },
    body,
  };
}

describe('safe fetch SSRF guard', { concurrency: false }, () => {
  let warn;

  before(() => {
    assert.equal(DEFAULT_TIMEOUT_MS, 12000);
    assert.equal(DEFAULT_MAX_BYTES, 3_000_000);
    assert.equal(DEFAULT_MAX_REDIRECTS, 5);
  });

  beforeEach(() => {
    warn = silenceWarn();
    _setResolver({
      async resolve4() { throw new Error('dns should not run'); },
      async resolve6() { throw new Error('dns should not run'); },
    });
    _setTransport(() => { throw new Error('transport should not run'); });
  });

  afterEach(() => {
    warn.restore();
    _setResolver(null);
    _setTransport(null);
    _setClient(null);
  });

  after(async () => {
    _setResolver(null);
    _setTransport(null);
    _setClient(null);
    await closePool();
  });

  it('refuses the test hooks outside the test process', () => {
    const previous = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      assert.throws(() => _setResolver(null), /NODE_ENV=test/);
      assert.throws(() => _setTransport(null), /NODE_ENV=test/);
    } finally {
      process.env.NODE_ENV = previous;
    }
  });

  it('blocks private and reserved IPv4 ranges, including the edges', () => {
    const blocked = [
      '0.0.0.0', '0.255.255.255',
      '10.0.0.0', '10.255.255.255',
      '100.64.0.0', '100.127.255.255',
      '127.0.0.0', '127.0.0.1', '127.255.255.255',
      '169.254.0.0', '169.254.169.254', '169.254.255.255',
      '172.16.0.0', '172.31.255.255',
      '192.0.0.0', '192.0.0.255',
      '192.0.2.0', '192.0.2.255',
      '192.168.0.0', '192.168.255.255',
      '198.18.0.0', '198.19.255.255',
      '198.51.100.0', '198.51.100.255',
      '203.0.113.0', '203.0.113.255',
      '224.0.0.0', '239.255.255.255',
      '240.0.0.0', '255.255.255.255',
    ];
    for (const ip of blocked) assert.equal(isBlockedAddress(ip), true, ip);

    const allowed = [
      '8.8.8.8', '1.1.1.1',
      '9.255.255.255', '11.0.0.0',
      '100.63.255.255', '100.128.0.1',
      '169.253.255.255', '169.255.0.1',
      '172.15.255.255', '172.32.0.1',
      '192.0.1.1', '192.0.3.1',
      '192.167.255.255', '192.169.0.1',
      '198.17.255.255', '198.20.0.1',
      '198.51.99.255', '198.51.101.1',
      '203.0.112.255', '203.0.114.1',
      '223.255.255.255',
    ];
    for (const ip of allowed) assert.equal(isBlockedAddress(ip), false, ip);
  });

  it('blocks IPv6 loopback, mapped, NAT64, and 6to4 embeddings of private addresses', () => {
    const blocked = [
      '::', '::1',
      'fc00::1', 'fd12:3456::1',
      'fe80::1', 'febf::1',
      'ff00::1', 'ff02::1',
      '2001:db8::1',
      '::ffff:127.0.0.1', '::ffff:7f00:1', '::ffff:10.0.0.1', '::ffff:169.254.169.254',
      '::7f00:1', '::127.0.0.1',
      '::ffff:0:10.0.0.1', '::ffff:0:a9fe:a9fe',
      '2002:7f00:1::', '2002:a9fe:a9fe::', '2002:a00:1::',
      '64:ff9b::7f00:1', '64:ff9b::808:808',
      '64:ff9b:1:7f00:0:100::',
    ];
    for (const ip of blocked) assert.equal(isBlockedAddress(ip), true, ip);

    assert.equal(isBlockedAddress('::ffff:8.8.8.8'), false);
    assert.equal(isBlockedAddress('::ffff:808:808'), false);
    assert.equal(isBlockedAddress('2002:808:808::'), false);
    assert.equal(isBlockedAddress('64:ff9b:1:808:8:800::'), false);
    assert.equal(isBlockedAddress(PUBLIC_V6), false);
  });

  it('refuses a direct private IP literal, including decimal, octal, hex, and short forms', async () => {
    const urls = [
      'http://127.0.0.1/',
      'http://10.1.2.3/',
      'http://192.168.1.9/',
      'http://172.16.0.1/',
      'http://169.254.169.254/latest/meta-data',
      'http://0.0.0.0/',
      'http://2130706433/',          // decimal 127.0.0.1
      'http://0x7f000001/',          // hex
      'http://0x7f.0.0.1/',          // dotted hex
      'http://0177.0.0.1/',          // octal
      'http://017700000001/',        // octal integer
      'http://127.1/',               // short form
      'http://127.0.1/',             // three-part short form
      'http://0x7f.1/',
      'http://0300.0250.0000.0001/', // octal 192.168.0.1
      'http://0xA9FEA9FE/',          // hex 169.254.169.254
      'http://2852039166/',          // decimal 169.254.169.254
      'http://[::1]/',
      'http://[::ffff:127.0.0.1]/',
      'http://[::ffff:7f00:1]/',
      'http://[::ffff:10.0.0.1]/',
      'http://[::127.0.0.1]/',
      'http://[::ffff:0:169.254.169.254]/',
      'http://[fc00::1]/',
      'http://[fe80::1]/',
      'http://[ff02::1]/',
      'http://[2001:db8::1]/',
      'http://[2002:7f00:1::]/',
      'http://[2002:a9fe:a9fe::]/',
      'http://[64:ff9b::808:808]/',
      'http://[64:ff9b:1:7f00:0:100::]/',
    ];
    let transportCalls = 0;
    _setTransport(() => { transportCalls += 1; throw new Error('transport called'); });
    for (const url of urls) {
      warn.lines.length = 0;
      await assert.rejects(safeFetch(url), (err) => {
        assert.equal(err.reason, 'private-address', url);
        assert.equal(err.message, 'fetch failed', url);
        assert.equal(err.message.includes('169.254'), false);
        return true;
      }, url);
      assert.equal(transportCalls, 0, url);
      assert.ok(warn.lines.some(line => line.startsWith('[safe-fetch] blocked reason=private-address ')), url);
    }
  });

  it('refuses localhost names without resolving them', async () => {
    let dnsCalls = 0;
    _setResolver({
      async resolve4() { dnsCalls += 1; return [PUBLIC]; },
      async resolve6() { dnsCalls += 1; return []; },
    });
    for (const url of ['http://localhost/', 'http://LOCALHOST/', 'http://foo.localhost/', 'http://localhost.localdomain/']) {
      await assert.rejects(safeFetch(url), (err) => err.reason === 'localhost');
    }
    assert.equal(dnsCalls, 0);
    assert.ok(warn.lines.every(line => line.includes('reason=localhost')));
  });

  it('refuses a hostname that resolves to a private address', async () => {
    _setResolver(publicResolver(['192.168.1.20']));
    await assert.rejects(
      safeFetch('https://shop.example/'),
      (err) => err.reason === 'private-address',
    );
    assert.ok(warn.lines.some(line => line === '[safe-fetch] blocked reason=private-address host=shop.example'));
    assert.equal(warn.lines.join('\n').includes('192.168'), false);
  });

  it('refuses a mixed public and private DNS answer', async () => {
    let transportCalls = 0;
    _setTransport(() => { transportCalls += 1; throw new Error('transport called'); });
    _setResolver({
      async resolve4() { return [PUBLIC, '10.0.0.1']; },
      async resolve6() { return ['::ffff:127.0.0.1']; },
    });
    await assert.rejects(
      safeFetch('https://mixed.example/'),
      (err) => err.reason === 'private-address',
    );
    assert.equal(transportCalls, 0);

    _setResolver({
      async resolve4() { return [PUBLIC]; },
      async resolve6() { return ['::1']; },
    });
    await assert.rejects(
      safeFetch('https://mixed-v6.example/'),
      (err) => err.reason === 'private-address',
    );
    assert.equal(transportCalls, 0);
  });

  it('refuses a 302 to the link-local metadata address', async () => {
    const hosts = [];
    _setResolver(publicResolver([PUBLIC]));
    _setTransport(mockTransport((options) => {
      hosts.push(options.headers.Host);
      return {
        status: 302,
        headers: { location: 'http://169.254.169.254/latest/meta-data' },
        body: '',
      };
    }));
    await assert.rejects(
      safeFetch('https://public.example/start'),
      (err) => err.reason === 'private-address',
    );
    assert.deepEqual(hosts, ['public.example']);
    assert.ok(warn.lines.some(line => line.includes('host=169.254.169.254')));
    assert.equal(warn.lines.join('\n').includes('latest/meta-data'), false);
  });

  it('refuses a redirect to a non-http scheme', async () => {
    const schemes = ['file:///etc/passwd', 'gopher://8.8.8.8/', 'javascript:alert(1)', 'ftp://8.8.8.8/'];
    for (const location of schemes) {
      const hosts = [];
      _setResolver(publicResolver([PUBLIC]));
      _setTransport(mockTransport((options) => {
        hosts.push(requestedUrl(options));
        return { status: 302, headers: { location }, body: '' };
      }));
      await assert.rejects(
        safeFetch('https://public.example/'),
        (err) => err.reason === 'scheme',
        location,
      );
      assert.deepEqual(hosts, ['https://public.example/'], location);
    }
    const joined = warn.lines.join('\n');
    assert.equal(joined.includes('/etc/passwd'), false);
    assert.equal(joined.includes('alert'), false);
  });

  it('refuses credentials, non-80/443 ports, and keeps secrets out of the error and the log', async () => {
    await assert.rejects(
      safeFetch('https://leakuser:s3cret-token@shop.example/path?token=s3cret-token'),
      (err) => {
        assert.equal(err.reason, 'credentials');
        assert.equal(err.message, 'fetch failed');
        assert.equal(err.message.includes('s3cret-token'), false);
        assert.equal(err.message.includes('leakuser'), false);
        return true;
      },
    );
    const log = warn.lines.join('\n');
    assert.match(log, /reason=credentials host=shop\.example/);
    assert.equal(log.includes('s3cret-token'), false);
    assert.equal(log.includes('leakuser'), false);
    assert.equal(log.includes('token='), false);

    for (const url of ['http://8.8.8.8:8080/', 'https://shop.example:8443/', 'http://shop.example:22/']) {
      await assert.rejects(safeFetch(url), (err) => err.reason === 'port', url);
    }
  });

  it('follows a redirect only after the next hop is public, and stops after 5', async () => {
    const seen = [];
    _setResolver(publicResolver([PUBLIC]));
    _setTransport(mockTransport((options) => {
      const url = requestedUrl(options);
      seen.push(url);
      if (url === 'https://shop.example/') {
        return { status: 302, headers: { location: 'https://www.shop.example/home' }, body: '' };
      }
      assert.equal(options.connectedAddress, PUBLIC);
      assert.equal(options.servername, 'www.shop.example');
      return htmlResponse('<html><p>moved</p></html>');
    }));
    const res = await safeFetch('https://shop.example/');
    assert.equal(res.status, 200);
    assert.equal(res.finalUrl, 'https://www.shop.example/home');
    assert.equal(String(res.body), '<html><p>moved</p></html>');
    assert.deepEqual(seen, ['https://shop.example/', 'https://www.shop.example/home']);

    const chain = [];
    _setTransport(mockTransport((options) => {
      const host = options.headers.Host;
      chain.push(host);
      const n = Number(host.split('.')[0].slice(1));
      if (n >= 6) return htmlResponse('<html>too far</html>');
      return { status: 302, headers: { location: `https://h${n + 1}.example/` }, body: '' };
    }));
    chain.length = 0;
    await assert.rejects(safeFetch('https://h0.example/'), (err) => err.reason === 'redirects');
    assert.deepEqual(chain, ['h0.example', 'h1.example', 'h2.example', 'h3.example', 'h4.example', 'h5.example']);

    chain.length = 0;
    const ok = await safeFetch('https://h1.example/');
    assert.equal(ok.status, 200);
    assert.equal(String(ok.body), '<html>too far</html>');
    assert.deepEqual(chain, ['h1.example', 'h2.example', 'h3.example', 'h4.example', 'h5.example', 'h6.example']);
  });

  it('pins the vetted address when a later DNS answer is private', async () => {
    let calls = 0;
    const resolve4 = async () => {
      calls += 1;
      return calls === 1 ? [PUBLIC] : ['10.1.2.3'];
    };
    _setResolver({
      resolve4,
      async resolve6() { return []; },
    });
    let connected = null;
    let callsAtConnect = null;
    _setTransport(mockTransport((options) => {
      connected = options.connectedAddress;
      callsAtConnect = calls;
      assert.equal(options.servername, 'shop.example');
      assert.equal(options.headers.Host, 'shop.example');
      assert.equal(options.agent.options.lookup, options.lookup);
      return htmlResponse('<html>pinned</html>');
    }));
    const res = await safeFetch('https://shop.example/contact');
    assert.equal(connected, PUBLIC);
    assert.equal(callsAtConnect, 1);
    assert.equal(String(res.body), '<html>pinned</html>');
    assert.deepEqual(await resolve4(), ['10.1.2.3']);
    assert.equal(connected, PUBLIC);
  });

  it('fetches a public address through the mocked transport and keeps SNI and Host', async () => {
    _setResolver(publicResolver([PUBLIC, '1.1.1.1']));
    let seen = null;
    _setTransport(mockTransport((options) => {
      seen = options;
      return htmlResponse('<html>ok</html>');
    }));
    const res = await safeFetch('https://shop.example/path?q=1', {
      headers: { 'User-Agent': 'FlowForwardTest', Authorization: 'Bearer secret-token', Cookie: 'a=b' },
    });
    assert.equal(res.status, 200);
    assert.equal(String(res.body), '<html>ok</html>');
    assert.equal(res.finalUrl, 'https://shop.example/path?q=1');
    assert.equal(seen.connectedAddress, PUBLIC);
    assert.equal(seen.servername, 'shop.example');
    assert.equal(seen.headers.Host, 'shop.example');
    assert.equal(seen.headers['User-Agent'], 'FlowForwardTest');
    assert.equal(seen.headers.Authorization, undefined);
    assert.equal(seen.headers.Cookie, undefined);
    assert.equal(seen.headers['Accept-Encoding'], 'gzip, deflate, identity');
    assert.ok(seen.agent instanceof https.Agent);
    assert.equal(seen.protocol, 'https:');
    assert.equal(warn.lines.length, 0);

    _setResolver({
      async resolve4() { return []; },
      async resolve6() { return [PUBLIC_V6]; },
    });
    _setTransport(mockTransport((options) => {
      seen = options;
      return htmlResponse('<html>v6</html>');
    }));
    const v6 = await safeFetch('http://v6.example/');
    assert.equal(String(v6.body), '<html>v6</html>');
    assert.equal(seen.connectedAddress, PUBLIC_V6);
    assert.equal(seen.headers.Host, 'v6.example');
    assert.equal(seen.servername, undefined);
    assert.ok(seen.agent instanceof http.Agent);
    assert.equal(seen.agent instanceof https.Agent, false);

    _setTransport(mockTransport((options) => {
      seen = options;
      return htmlResponse('<html>v6s</html>');
    }));
    const v6s = await safeFetch('https://v6.example/');
    assert.equal(String(v6s.body), '<html>v6s</html>');
    assert.equal(seen.connectedAddress, PUBLIC_V6);
    assert.equal(seen.servername, 'v6.example');
    assert.equal(seen.headers.Host, 'v6.example');
    assert.ok(seen.agent instanceof https.Agent);

    _setTransport(mockTransport((options) => {
      seen = options;
      return htmlResponse('<html>literal</html>');
    }));
    const literal = await safeFetch('http://134744072/'); // decimal 8.8.8.8
    assert.equal(String(literal.body), '<html>literal</html>');
    assert.equal(seen.connectedAddress, PUBLIC);
    assert.equal(seen.hostname, PUBLIC);
    assert.equal(seen.servername, undefined);

    const mapped = await safeFetch('http://[::ffff:8.8.8.8]/');
    assert.equal(String(mapped.body), '<html>literal</html>');
    assert.equal(seen.connectedAddress, '::ffff:808:808');

    const sixToFour = await safeFetch('http://[2002:808:808::]/');
    assert.equal(sixToFour.status, 200);
    assert.equal(seen.connectedAddress, '2002:808:808::');

    const nat64 = await safeFetch('http://[64:ff9b:1:808:8:800::]/');
    assert.equal(nat64.status, 200);
    assert.equal(isBlockedAddress(seen.connectedAddress), false);

    const on443 = await safeFetch('http://8.8.8.8:443/');
    assert.equal(on443.status, 200);
    assert.equal(seen.port, 443);
    assert.equal(seen.headers.Host, '8.8.8.8:443');

    _setResolver(publicResolver([PUBLIC]));
    const on80 = await safeFetch('https://shop.example:80/');
    assert.equal(on80.status, 200);
    assert.equal(seen.port, 80);
    assert.equal(seen.headers.Host, 'shop.example:80');
    assert.equal(seen.servername, 'shop.example');
  });

  it('decodes gzip and stops reading at the size cap', async () => {
    _setResolver(publicResolver([PUBLIC]));
    const payload = '<html><p>gzipped</p></html>';
    _setTransport(mockTransport(() => htmlResponse(zlib.gzipSync(payload), { 'content-encoding': 'gzip' })));
    const decoded = await safeFetch('https://shop.example/');
    assert.equal(String(decoded.body), payload);

    let destroyedBeforePush = false;
    _setTransport((options, callback) => {
      const req = require('events').EventEmitter ? new (require('events').EventEmitter)() : null;
      req.destroyed = false;
      req.setTimeout = () => req;
      req.destroy = () => { req.destroyed = true; };
      req.end = () => {
        const { Readable } = require('stream');
        const res = new Readable({ read() {} });
        res.statusCode = 200;
        res.headers = { 'content-type': 'text/html', 'content-length': String(DEFAULT_MAX_BYTES + 1) };
        process.nextTick(() => {
          callback(res);
          destroyedBeforePush = res.destroyed === true;
          if (!res.destroyed) res.push(Buffer.alloc(64, 1));
          if (!res.destroyed) res.push(null);
        });
      };
      return req;
    });
    await assert.rejects(safeFetch('https://shop.example/big'), (err) => err.reason === 'too-large');
    assert.equal(destroyedBeforePush, true);

    _setTransport(mockTransport(() => htmlResponse(Buffer.alloc(32, 0x61))));
    await assert.rejects(
      safeFetch('https://shop.example/stream', { maxBytes: 16 }),
      (err) => err.reason === 'too-large',
    );

    _setTransport(mockTransport(() => ({
      status: 200,
      headers: { 'content-type': 'text/html', 'content-encoding': 'br' },
      body: Buffer.from('not actually brotli'),
    })));
    await assert.rejects(safeFetch('https://shop.example/br'), (err) => err.reason === 'encoding');
  });

  it('times out a hung transport inside the 12s budget', async () => {
    _setResolver(publicResolver([PUBLIC]));
    _setTransport((options, callback) => {
      const req = new (require('events').EventEmitter)();
      req.setTimeout = () => req;
      req.destroy = () => { req.destroyed = true; };
      req.end = () => {};
      return req;
    });
    const started = Date.now();
    await assert.rejects(
      safeFetch('https://shop.example/', { timeoutMs: 40 }),
      (err) => err.reason === 'timeout',
    );
    assert.ok(Date.now() - started < 2000);
  });

  it('treats a blocked crawl as a failed crawl, not as fsm none', async () => {
    const blocked = await crawlSite('http://169.254.169.254/latest/meta-data');
    assert.equal(blocked.reachable, false);
    assert.equal(blocked.error, 'homepage unreachable: fetch failed');
    assert.deepEqual(blocked.pages, []);
    assert.equal(fsmDetectedFromResearch({ site: blocked }), null);
    assert.equal(blocked.error.includes('169.254'), false);
    assert.ok(warn.lines.some(line => line.includes('reason=private-address')));

    _setResolver({
      async resolve4() { return ['10.0.0.1']; },
      async resolve6() { return []; },
    });
    const byName = await crawlSite('https://internal.example/');
    assert.equal(byName.reachable, false);
    assert.equal(fsmDetectedFromResearch({ site: byName }), null);
    assert.equal(byName.error.includes('10.0.0.1'), false);

    _setResolver(publicResolver([PUBLIC]));
    _setTransport(mockTransport(() => htmlResponse('<html><body><p>Family owned heating in Lehi.</p></body></html>')));
    const open = await crawlSite('https://plain.example/');
    assert.equal(open.reachable, true);
    assert.equal(open.error, null);
    assert.equal(fsmDetectedFromResearch({ site: open }), 'none');

    _setTransport(mockTransport(() => htmlResponse(
      '<html><script src="https://static.servicetitan.com/booking.js"></script></html>',
    )));
    const stamped = await crawlSite('https://st.example/');
    assert.equal(fsmDetectedFromResearch({ site: stamped }), 'ServiceTitan');

    _setClient(fakeClaude());
    _setResolver({
      async resolve4() { return ['10.2.3.4']; },
      async resolve6() { return []; },
    });
    const row = await insertProspect({
      google_place_id: `test-place-ssrf-keep-${Date.now()}`,
      company: 'SSRF Keep Heating',
      city: 'Lehi',
      website: 'https://keep.example/',
      email: null,
      contact_name: null,
      review_count: 80,
      rating: 4.0,
      fsm_detected: 'ServiceTitan',
    });
    await draftProposal(row.id);
    const kept = await pool.query('SELECT fsm_detected FROM prospects WHERE id = $1', [row.id]);
    assert.equal(kept.rows[0].fsm_detected, 'ServiceTitan');

    _setResolver(publicResolver([PUBLIC]));
    _setTransport(mockTransport(() => htmlResponse('<html><p>No field software here.</p></html>')));
    const clear = await insertProspect({
      google_place_id: `test-place-ssrf-clear-${Date.now()}`,
      company: 'SSRF Clear Heating',
      city: 'Lehi',
      website: 'https://clear.example/',
      email: null,
      contact_name: null,
      review_count: 80,
      rating: 4.0,
      fsm_detected: 'ServiceTitan',
    });
    await draftProposal(clear.id, { reuseResearch: false });
    const cleared = await pool.query('SELECT fsm_detected FROM prospects WHERE id = $1', [clear.id]);
    assert.equal(cleared.rows[0].fsm_detected, 'none');
    await pool.query('DELETE FROM prospects WHERE id = ANY($1::int[])', [[row.id, clear.id]]);
  });
});
