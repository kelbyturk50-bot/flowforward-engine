require('./preload');

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  normalizeHost,
  classifyHost,
  inspectDatabaseUrl,
  inspectPgEnv,
  shouldUseProvidedDatabase,
  assertSafeDatabaseEnv,
} = require('./guard');

const LOCAL = 'postgresql://fftest@127.0.0.1:5432/flowforward_test';

function refused(url) {
  const result = inspectDatabaseUrl(url);
  assert.equal(result.ok, false, `${url} should be refused, got ${JSON.stringify(result)}`);
  return result;
}

describe('database guard', () => {
  it('allows loopback URLs, including IPv6 localhost', () => {
    assert.equal(normalizeHost('::1'), '::1');
    assert.equal(normalizeHost('[::1]:5432'), '::1');
    assert.equal(normalizeHost('smtp.gmail.com:465'), 'smtp.gmail.com');

    assert.equal(inspectDatabaseUrl('').ok, true);
    assert.equal(inspectDatabaseUrl(LOCAL).ok, true);
    assert.equal(inspectDatabaseUrl('postgresql://fftest@localhost/flowforward_test').ok, true);
    assert.equal(inspectDatabaseUrl('postgresql://fftest@[::1]:5432/flowforward_test').ok, true);
    assert.equal(inspectDatabaseUrl('postgresql://fftest@[::1]/flowforward_test').ok, true);

    // Every host in a comma-separated list must be local.
    assert.equal(inspectDatabaseUrl('postgresql://fftest@127.0.0.1,localhost/flowforward_test').ok, true);
  });

  it('rejects hosted hosts and 0.0.0.0', () => {
    const railway = refused('postgresql://user:password@monorail.proxy.rlwy.net:12345/railway');
    assert.match(railway.reason, /hosted database/);

    assert.equal(refused('postgresql://user:password@flowforward-engine-production.up.railway.app:5432/railway').ok, false);
    assert.equal(refused('postgresql://user:password@ep-example.us-east-2.aws.neon.tech/neondb').ok, false);

    const other = refused('postgresql://user:password@db.internal.example:5432/app');
    assert.match(other.reason, /not a local host/);

    const allInterfaces = refused('postgresql://fftest@0.0.0.0:5432/flowforward_test');
    assert.equal(allInterfaces.host, '0.0.0.0');
    assert.match(allInterfaces.reason, /not a local host/);
  });

  it('refuses host-overriding query params even when the URL host looks local', () => {
    const host = refused('postgres://u@localhost/db?host=x.rlwy.net');
    assert.match(host.reason, /\?host=/);
    assert.match(host.host, /rlwy\.net/);

    // A local override is still an override. pg-connection-string would use it
    // instead of the hostname in the URL.
    const localOverride = refused('postgres://u@localhost/db?host=127.0.0.1');
    assert.match(localOverride.reason, /\?host=/);

    const hostaddr = refused('postgres://u@localhost/db?hostaddr=1.2.3.4');
    assert.match(hostaddr.reason, /\?hostaddr=/);
    assert.equal(hostaddr.host, '1.2.3.4');

    const both = refused('postgres://u@localhost/db?host=localhost&hostaddr=10.1.2.3');
    assert.match(both.reason, /host override/);

    const service = refused('postgres://u@localhost/db?service=prod');
    assert.match(service.reason, /\?service=/);

    // Comma-separated hosts are what libpq and pg-connection-string connect to.
    const list = refused('postgres://u@localhost/db?host=127.0.0.1,x.rlwy.net');
    assert.match(list.reason, /\?host=/);
  });

  it('refuses a comma-separated host list when any host is not local', () => {
    const listed = refused('postgresql://fftest@127.0.0.1,x.rlwy.net:5432/flowforward_test');
    assert.match(listed.host, /rlwy\.net/);
    assert.equal(listed.ok, false);

    const plain = refused('postgresql://fftest@localhost,db.internal.example/flowforward_test');
    assert.match(plain.reason, /not a local host/);
  });

  it('refuses PGHOST, PGHOSTADDR, and PGSERVICE', () => {
    assert.equal(inspectPgEnv({}).ok, true);
    assert.equal(inspectPgEnv({ PGHOST: '127.0.0.1' }).ok, true);
    assert.equal(inspectPgEnv({ PGHOST: '::1' }).ok, true);
    assert.equal(inspectPgEnv({ PGHOSTADDR: '127.0.0.1' }).ok, true);

    const pghost = inspectPgEnv({ PGHOST: 'x.rlwy.net' });
    assert.equal(pghost.ok, false);
    assert.equal(pghost.source, 'PGHOST');
    assert.match(pghost.reason, /hosted database/);

    const plain = inspectPgEnv({ PGHOST: 'x' });
    assert.equal(plain.ok, false);
    assert.equal(plain.source, 'PGHOST');
    assert.equal(plain.host, 'x');
    assert.equal(plain.reason, 'not a local host');

    const list = inspectPgEnv({ PGHOST: '127.0.0.1,10.0.0.8' });
    assert.equal(list.ok, false);
    assert.equal(list.source, 'PGHOST');

    const addr = inspectPgEnv({ PGHOSTADDR: '8.8.8.8' });
    assert.equal(addr.ok, false);
    assert.equal(addr.source, 'PGHOSTADDR');

    const service = inspectPgEnv({ PGSERVICE: 'prod' });
    assert.equal(service.ok, false);
    assert.equal(service.source, 'PGSERVICE');
  });

  it('treats only a single-slash absolute path as a Unix socket', () => {
    assert.equal(classifyHost('/tmp/.s.PGSQL.5432').ok, true);
    assert.equal(classifyHost('//evil.com').ok, false);
    assert.equal(classifyHost('//evil.com').reason, 'not a local host');
    assert.equal(classifyHost('///tmp/pg.sock').ok, false);

    assert.equal(inspectPgEnv({ PGHOST: '/tmp/.s.PGSQL.5432' }).ok, true);
    const evil = inspectPgEnv({ PGHOST: '//evil.com' });
    assert.equal(evil.ok, false);
    assert.equal(evil.source, 'PGHOST');
    assert.equal(evil.host, '//evil.com');
    assert.equal(evil.reason, 'not a local host');
  });

  it('refuses PGHOST, PGHOSTADDR, and PGSERVICE from .env before dotenv loads them', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-dotenv-'));
    const file = path.join(dir, '.env');
    const previous = process.env.DATABASE_URL;
    try {
      fs.writeFileSync(file, [
        'DATABASE_URL=postgresql://fftest@127.0.0.1:5432/flowforward_test',
        'PGHOST="x.rlwy.net"',
      ].join('\n'));
      assert.throws(
        () => assertSafeDatabaseEnv({ envFile: file }),
        (err) => {
          assert.match(err.message, /Refusing to run tests: \.env PGHOST "x\.rlwy\.net"/);
          assert.doesNotMatch(err.message, /password/);
          return true;
        }
      );

      fs.writeFileSync(file, 'PGHOSTADDR=8.8.8.8\n');
      assert.throws(
        () => assertSafeDatabaseEnv({ envFile: file }),
        /Refusing to run tests: \.env PGHOSTADDR "8\.8\.8\.8"/
      );

      fs.writeFileSync(file, "export PGSERVICE='prod'\n");
      assert.throws(
        () => assertSafeDatabaseEnv({ envFile: file }),
        /Refusing to run tests: \.env PGSERVICE "prod"/
      );

      // A local value is fine when the URL itself names a loopback host.
      fs.writeFileSync(file, 'PGHOST=127.8.8.8\n');
      assert.doesNotThrow(() => assertSafeDatabaseEnv({ envFile: file }));

      // An empty URL host would let a later dotenv load of PGHOST choose the server.
      fs.writeFileSync(file, 'PGHOST=127.0.0.1\n');
      process.env.DATABASE_URL = 'postgresql://fftest@/flowforward_test';
      delete process.env.PGHOST;
      assert.throws(
        () => assertSafeDatabaseEnv({ envFile: file }),
        /DATABASE_URL has no host/
      );
    } finally {
      if (previous == null) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = previous;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('uses a provided URL only when it is local and named flowforward_test', () => {
    assert.equal(shouldUseProvidedDatabase(LOCAL), true);
    assert.equal(shouldUseProvidedDatabase('postgresql://fftest@[::1]:5432/flowforward_test'), true);
    assert.equal(shouldUseProvidedDatabase('postgresql://fftest@127.0.0.1:5432/postgres'), false);
    assert.equal(shouldUseProvidedDatabase('postgresql://fftest@x.rlwy.net:5432/flowforward_test'), false);
    assert.equal(shouldUseProvidedDatabase('postgres://u@localhost/flowforward_test?host=x.rlwy.net'), false);
    assert.equal(shouldUseProvidedDatabase('postgresql://fftest@0.0.0.0:5432/flowforward_test'), false);
  });

  it('aborts the process for each host bypass without connecting', () => {
    const cases = [
      {
        env: { DATABASE_URL: 'postgresql://user:password@monorail.proxy.rlwy.net:12345/railway' },
        pattern: /rlwy\.net/,
      },
      {
        env: { DATABASE_URL: 'postgres://u@localhost/db?host=x.rlwy.net' },
        pattern: /\?host=/,
      },
      {
        env: { DATABASE_URL: 'postgres://u@localhost/db?hostaddr=1.2.3.4' },
        pattern: /\?hostaddr=/,
      },
      {
        env: { DATABASE_URL: 'postgres://u@localhost/flowforward_test?service=prod' },
        pattern: /\?service=/,
      },
      {
        env: { DATABASE_URL: LOCAL, PGHOST: 'x' },
        pattern: /PGHOST "x" is not a local host/,
      },
      {
        env: { DATABASE_URL: LOCAL, PGHOST: '//evil.com' },
        pattern: /PGHOST "\/\/evil\.com" is not a local host/,
      },
      {
        env: { DATABASE_URL: LOCAL, PGHOST: 'x.rlwy.net' },
        pattern: /PGHOST "x\.rlwy\.net" is a hosted database/,
      },
      {
        env: { DATABASE_URL: LOCAL, PGHOSTADDR: '8.8.8.8' },
        pattern: /PGHOSTADDR/,
      },
      {
        env: { DATABASE_URL: LOCAL, PGSERVICE: 'prod' },
        pattern: /PGSERVICE/,
      },
      {
        env: { DATABASE_URL: 'postgresql://fftest@127.0.0.1,x.rlwy.net:5432/flowforward_test' },
        pattern: /rlwy\.net/,
      },
    ];

    for (const [i, item] of cases.entries()) {
      const result = spawnSync(process.execPath, ['-e', `
        require('./test/guard').assertSafeDatabaseEnv();
        console.log('connected');
      `], {
        encoding: 'utf8',
        cwd: path.join(__dirname, '..'),
        env: {
          ...process.env,
          PGHOST: '',
          PGHOSTADDR: '',
          PGSERVICE: '',
          ...item.env,
        },
      });
      assert.notEqual(result.status, 0, `case ${i} exited 0\n${result.stdout}\n${result.stderr}`);
      assert.match(result.stderr, /Refusing to run tests/, `case ${i}\n${result.stderr}`);
      assert.match(result.stderr, item.pattern, `case ${i}\n${result.stderr}`);
      assert.doesNotMatch(result.stdout || '', /connected/);
    }
  });
});
