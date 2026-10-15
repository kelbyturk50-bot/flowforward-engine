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
});
