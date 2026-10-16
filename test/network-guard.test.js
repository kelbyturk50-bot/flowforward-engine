require('./preload');

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const axios = require('axios');
const Anthropic = require('@anthropic-ai/sdk');
const net = require('net');
const { searchPlaces, _setSearch } = require('../src/bot/google-places');
const { TestNetworkGuardError } = require('./guard');

function assertBlocked(err, host) {
  const cause = err && err.cause;
  const messages = [err && err.message, cause && cause.message].filter(Boolean).join(' | ');
  const code = (err && err.code) || (cause && cause.code);
  assert.equal(code, 'TEST_NETWORK_BLOCKED', messages);
  assert.match(messages, new RegExp(host.replace(/\./g, '\\.')));
  assert.match(messages, /network guard/);
}

describe('network guard', () => {
  it('blocks searchPlaces before any HTTP to places.googleapis.com', async () => {
    _setSearch(null);
    process.env.GOOGLE_PLACES_API_KEY = 'test-not-a-real-key';
    await assert.rejects(
      () => searchPlaces('HVAC company', 'Provo UT', 1),
      (err) => {
        assertBlocked(err, 'places.googleapis.com');
        assert.equal(err.name, 'TestNetworkGuardError');
        return true;
      }
    );
  });

  it('blocks the Anthropic SDK before any HTTP to api.anthropic.com', async () => {
    const client = new Anthropic({ apiKey: 'sk-ant-test-not-real', maxRetries: 0 });
    await assert.rejects(
      () => client.messages.create({
        model: 'claude-sonnet-5-5',
        max_tokens: 1,
        messages: [{ role: 'user', content: 'ping' }],
      }),
      (err) => {
        assertBlocked(err, 'api.anthropic.com');
        return true;
      }
    );
  });

  it('blocks Gmail API HTTP and Gmail SMTP sockets', async () => {
    await assert.rejects(
      () => axios.get('https://gmail.googleapis.com/gmail/v1/users/me/profile', {
        timeout: 2000,
        headers: { Authorization: 'Bearer test-not-a-real-token' },
      }),
      (err) => {
        assertBlocked(err, 'gmail.googleapis.com');
        return true;
      }
    );

    await assert.rejects(
      () => axios.post('https://oauth2.googleapis.com/token', 'grant_type=refresh_token', { timeout: 2000 }),
      (err) => {
        assertBlocked(err, 'oauth2.googleapis.com');
        return true;
      }
    );

    assert.throws(
      () => net.connect({ host: 'smtp.gmail.com', port: 465 }),
      (err) => {
        assert.ok(err instanceof TestNetworkGuardError);
        assertBlocked(err, 'smtp.gmail.com');
        return true;
      }
    );

    assert.throws(
      () => net.connect(993, 'imap.gmail.com'),
      (err) => {
        assertBlocked(err, 'imap.gmail.com');
        return true;
      }
    );

    const tls = require('tls');
    assert.throws(
      () => tls.connect({ host: 'smtp.gmail.com', port: 465, servername: 'smtp.gmail.com' }),
      (err) => {
        assert.ok(err instanceof TestNetworkGuardError);
        assertBlocked(err, 'smtp.gmail.com');
        return true;
      }
    );
  });

  it('blocks the dialed host when servername is local, before any handshake', async () => {
    const tls = require('tls');
    const https = require('https');
    const nodemailer = require('nodemailer');

    const syncCases = [
      // Existing variants. The guard throws before Socket.connect dials.
      () => net.connect({ host: 'smtp.gmail.com', port: 465 }),
      () => tls.connect({ host: 'smtp.gmail.com', port: 465, servername: 'smtp.gmail.com' }),
      // servername is SNI only. It must not hide smtp.gmail.com.
      () => tls.connect({ host: 'smtp.gmail.com', port: 465, servername: 'localhost' }),
      // Options override the URL host, the same way Node merges https.request.
      () => https.request('https://127.0.0.1/', {
        hostname: 'places.googleapis.com',
        servername: 'localhost',
      }),
      // An already-open socket's remote address is a dial target too.
      () => tls.connect({
        host: '127.0.0.1',
        port: 465,
        servername: 'localhost',
        socket: { remoteAddress: '172.217.14.109' },
      }),
    ];
    const expectedHosts = [
      'smtp.gmail.com',
      'smtp.gmail.com',
      'smtp.gmail.com',
      'places.googleapis.com',
      '172.217.14.109',
    ];
    syncCases.forEach((fn, i) => {
      assert.throws(fn, (err) => {
        assert.ok(err instanceof TestNetworkGuardError, `case ${i} ${err && err.stack}`);
        assertBlocked(err, expectedHosts[i]);
        return true;
      }, `case ${i} did not throw before connect`);
    });

    const transport = nodemailer.createTransport({
      host: 'smtp.gmail.com',
      port: 465,
      secure: true,
      auth: { user: 'test-not-real@example.com', pass: 'test-not-a-real-password' },
      tls: { servername: 'localhost' },
      connectionTimeout: 3000,
      dnsTimeout: 3000,
    });
    try {
      await assert.rejects(
        () => transport.sendMail({
          from: 'test-not-real@example.com',
          to: 'nobody@example.com',
          subject: 'guard',
          text: 'guard',
        }),
        (err) => {
          assert.ok(err instanceof TestNetworkGuardError, err && err.stack);
          const code = err.originalCode || err.code;
          assert.equal(code, 'TEST_NETWORK_BLOCKED');
          assert.match(err.message, /network guard/);
          const refused = (err.message.match(/Refusing to call (\S+) during tests/) || [])[1];
          assert.ok(refused, err.message);
          assert.ok(!['localhost', '127.0.0.1', '::1'].includes(refused), refused);
          return true;
        }
      );
    } finally {
      transport.close();
    }
  });

  it('blocks maps.googleapis.com and www.googleapis.com', async () => {
    await assert.rejects(
      () => axios.get('https://maps.googleapis.com/maps/api/place/nearbysearch/json', { timeout: 2000 }),
      (err) => {
        assertBlocked(err, 'maps.googleapis.com');
        return true;
      }
    );
    await assert.rejects(
      () => axios.get('https://www.googleapis.com/oauth2/v1/userinfo', { timeout: 2000 }),
      (err) => {
        assertBlocked(err, 'www.googleapis.com');
        return true;
      }
    );
  });

  function badLookup(address, family) {
    return (hostname, options, callback) => {
      if (typeof options === 'function') {
        callback = options;
        options = {};
      }
      if (options && options.all) callback(null, [{ address, family }]);
      else callback(null, address, family);
    };
  }

  // The native TCP connect throws on the next tick, before the syscall.
  function captureGuard(start) {
    return new Promise((resolve, reject) => {
      let settled = false;
      let result;
      const timer = setTimeout(() => finish(new Error('timed out before the guard threw')), 1000);
      function finish(err) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        process.off('uncaughtException', onUncaught);
        if (result && typeof result.destroy === 'function') result.destroy();
        if (err instanceof Error && err.message === 'handshake') reject(err);
        else resolve(err);
      }
      function onUncaught(err) { finish(err); }
      process.on('uncaughtException', onUncaught);
      try {
        result = start();
        if (result && typeof result.on === 'function') {
          result.on('error', finish);
          result.on('connect', () => finish(new Error('handshake')));
          if (typeof result.destroy === 'function') result.once('error', () => result.destroy());
        }
        if (result && typeof result.then === 'function') {
          result.then(() => finish(new Error('handshake')), finish);
        }
      } catch (err) {
        finish(err);
      }
    });
  }

  function guardError(err) {
    let current = err;
    while (current && !(current instanceof TestNetworkGuardError) && current.cause) current = current.cause;
    return current;
  }

  function assertGuard(err, host) {
    const guard = guardError(err);
    assert.ok(guard instanceof TestNetworkGuardError, err && (err.stack || err));
    assert.equal(guard.code, 'TEST_NETWORK_BLOCKED');
    assert.match(guard.message, /network guard/);
    assert.match(guard.stack, /guard\.js/);
    assert.doesNotMatch(guard.stack, /afterConnect/);
    if (host) assert.match(guard.message, new RegExp(host.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }

  it('blocks a resolved address that is not loopback, before the native connect', async () => {
    const dns = require('dns');
    const tls = require('tls');
    const https = require('https');
    const http2 = require('http2');
    const { Agent } = require('undici');

    const cases = [
      () => net.connect({ host: 'localhost', port: 9, lookup: badLookup('192.0.2.1', 4) }),
      () => net.connect({ host: 'localhost', port: 9, lookup: badLookup('2001:db8::1', 6) }),
      () => tls.connect({ host: 'localhost', port: 443, servername: 'localhost', lookup: badLookup('192.0.2.1', 4) }),
      () => https.request({ hostname: 'localhost', port: 443, servername: 'localhost', lookup: badLookup('192.0.2.1', 4) }),
      () => http2.connect('https://localhost', {
        createConnection() {
          return net.connect({ host: 'localhost', port: 443, lookup: badLookup('192.0.2.1', 4) });
        },
      }),
      () => fetch('http://localhost:8080/', {
        dispatcher: new Agent({ connect: { lookup: badLookup('192.0.2.1', 4) } }),
      }),
    ];
    for (const [i, start] of cases.entries()) {
      const err = await captureGuard(start);
      assertGuard(err, i === 1 ? '2001:db8::1' : '192.0.2.1');
    }

    const originalLookup = dns.lookup;
    dns.lookup = badLookup('192.0.2.1', 4);
    try {
      const err = await captureGuard(() => net.connect({ host: 'localhost', port: 9 }));
      assertGuard(err, '192.0.2.1');
    } finally {
      dns.lookup = originalLookup;
    }

    // 127.0.0.0/8 is still dialed. The failure is the OS, not the guard.
    const allowed = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timeout')), 1000);
      const socket = net.connect({ host: 'localhost', port: 1, lookup: badLookup('127.8.8.8', 4) });
      socket.on('error', (err) => { clearTimeout(timer); socket.destroy(); resolve(err); });
      socket.on('connect', () => { clearTimeout(timer); socket.destroy(); reject(new Error('handshake')); });
    });
    assert.ok(!(allowed instanceof TestNetworkGuardError));
    assert.notEqual(allowed.code, 'TEST_NETWORK_BLOCKED');
  });

  it('does not treat tls.connect(port, host) as a socket path', async () => {
    const http2 = require('http2');
    const session = http2.connect('https://localhost');
    try {
      const err = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('timeout')), 2000);
        session.once('error', (error) => { clearTimeout(timer); resolve(error); });
        session.once('connect', () => { clearTimeout(timer); reject(new Error('handshake')); });
      });
      assert.ok(!(err instanceof TestNetworkGuardError), err && err.message);
      assert.notEqual(err.code, 'TEST_NETWORK_BLOCKED');
    } finally {
      session.destroy();
    }
  });

  it('blocks fetch of a URL object or a Request', async () => {
    await assert.rejects(
      () => fetch(new URL('https://places.googleapis.com/v1/places:searchText')),
      (err) => {
        assert.ok(err instanceof TestNetworkGuardError);
        assertBlocked(err, 'places.googleapis.com');
        return true;
      }
    );
    await assert.rejects(
      () => fetch(new Request('https://www.googleapis.com/oauth2/v1/userinfo')),
      (err) => {
        assert.ok(err instanceof TestNetworkGuardError);
        assertBlocked(err, 'www.googleapis.com');
        return true;
      }
    );
  });

  it('blocks nodemailer proxy before any tunnel', () => {
    const nodemailer = require('nodemailer');
    assert.throws(
      () => nodemailer.createTransport({
        host: '127.0.0.1',
        port: 2525,
        secure: false,
        proxy: 'http://127.0.0.1:8888',
      }),
      (err) => {
        assert.ok(err instanceof TestNetworkGuardError);
        assert.equal(err.code, 'TEST_NETWORK_BLOCKED');
        assert.match(err.message, /127\.0\.0\.1:8888/);
        assert.match(err.stack, /guard\.js/);
        return true;
      }
    );
  });

  it('still allows a connection attempt to localhost', async () => {
    await assert.rejects(
      () => fetch('http://127.0.0.1:9/'),
      (err) => {
        assert.notEqual(err.code, 'TEST_NETWORK_BLOCKED');
        assert.doesNotMatch(String(err.message), /network guard/);
        return true;
      }
    );
  });

  it('blocks a nodemailer connection-url proxy before any tunnel', async () => {
    const nodemailer = require('nodemailer');
    const hits = { n: 0 };
    const proxy = net.createServer((socket) => {
      hits.n += 1;
      socket.destroy();
    });
    await new Promise((resolve) => proxy.listen(0, '127.0.0.1', resolve));
    const port = proxy.address().port;
    try {
      const urls = [
        `smtps://smtp.gmail.com:465?proxy=http://127.0.0.1:${port}`,
        { url: `smtp://smtp.gmail.com:587?proxy=http://127.0.0.1:${port}` },
      ];
      for (const options of urls) {
        assert.throws(
          () => nodemailer.createTransport(options),
          (err) => {
            assert.ok(err instanceof TestNetworkGuardError, err && err.stack);
            assert.equal(err.code, 'TEST_NETWORK_BLOCKED');
            assert.match(err.message, /127\.0\.0\.1/);
            assert.match(err.stack, /guard\.js/);
            assert.doesNotMatch(err.stack, /setupProxy/);
            return true;
          }
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
      assert.equal(hits.n, 0);
    } finally {
      proxy.close();
    }
  });

  it('blocks a proxied non-loopback target before CONNECT', async () => {
    const { ProxyAgent, EnvHttpProxyAgent, request, stream, pipeline } = require('undici');
    const hits = { n: 0 };
    const proxy = net.createServer((socket) => {
      hits.n += 1;
      socket.destroy();
    });
    await new Promise((resolve) => proxy.listen(0, '127.0.0.1', resolve));
    const port = proxy.address().port;
    const proxyUrl = `http://127.0.0.1:${port}`;
    const agent = new ProxyAgent(proxyUrl);
    const envAgent = new EnvHttpProxyAgent({ httpsProxy: proxyUrl, httpProxy: proxyUrl });
    try {
      const target = 'https://192.0.2.1/';
      const calls = [
        () => fetch(target, { dispatcher: agent }),
        () => request(target, { dispatcher: agent }),
        () => stream(target, { dispatcher: agent }, () => {}),
        () => pipeline(target, { dispatcher: agent }, () => {}),
        () => request(target, { dispatcher: envAgent }),
        () => agent.dispatch({ origin: 'https://192.0.2.1', path: '/', method: 'GET' }, {
          onRequestStart() {},
          onHeaders() { return true; },
          onData() { return true; },
          onComplete() {},
          onError(err) { throw err; },
        }),
      ];
      for (const [i, start] of calls.entries()) {
        const err = await captureGuard(start);
        assertGuard(err, '192.0.2.1');
        assert.doesNotMatch(String(err && err.stack), /afterConnect/, `case ${i}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
      assert.equal(hits.n, 0);
    } finally {
      proxy.close();
      await Promise.all([agent.close(), envAgent.close()]);
    }
  });

  it('blocks UDP send and connect to a non-loopback address', async () => {
    const dgram = require('dgram');
    const udp4 = dgram.createSocket('udp4');
    const udp6 = dgram.createSocket('udp6');
    try {
      assert.throws(
        () => udp4.send(Buffer.from('x'), 9, '192.0.2.1'),
        (err) => {
          assertGuard(err, '192.0.2.1');
          return true;
        }
      );
      assert.throws(
        () => udp6.connect(9, '2001:db8::1'),
        (err) => {
          assertGuard(err, '2001:db8::1');
          return true;
        }
      );

      const server = dgram.createSocket('udp4');
      try {
        await new Promise((resolve) => server.bind(0, '127.0.0.1', resolve));
        const got = new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('loopback datagram was not delivered')), 1000);
          server.once('message', (msg) => { clearTimeout(timer); resolve(msg.toString()); });
        });
        udp4.send(Buffer.from('ok'), server.address().port, '127.0.0.1');
        assert.equal(await got, 'ok');
      } finally {
        server.close();
      }
    } finally {
      udp4.close();
      udp6.close();
    }
  });

  it('passes the preload to spawned children through NODE_OPTIONS', () => {
    const { spawnSync } = require('child_process');
    const path = require('path');
    const preload = path.resolve(__dirname, 'preload.js');
    assert.match(process.env.NODE_OPTIONS || '', new RegExp(preload.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    const result = spawnSync(process.execPath, ['-e', `
      const net = require('net');
      let handshake = false;
      try {
        const socket = net.connect({ host: '192.0.2.1', port: 9 });
        socket.on('connect', () => { handshake = true; });
        socket.on('error', () => {});
      } catch (err) {
        if (err && err.code === 'TEST_NETWORK_BLOCKED' && !handshake) {
          console.log('blocked');
          process.exit(0);
        }
        console.error(err && err.stack);
        process.exit(2);
      }
      console.error('no throw');
      process.exit(3);
    `], { encoding: 'utf8', timeout: 5000 });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /blocked/);
    assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /handshake|ETIMEDOUT|ECONNREFUSED/i);
  });
});
