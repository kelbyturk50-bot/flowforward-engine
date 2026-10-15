require('./preload');

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('child_process');
const path = require('path');
const { inspectDatabaseUrl } = require('./guard');

describe('database guard', () => {
  it('allows a local URL and rejects hosted ones without connecting', () => {
    assert.equal(inspectDatabaseUrl('').ok, true);
    assert.equal(inspectDatabaseUrl('postgresql://fftest@127.0.0.1:5432/flowforward_test').ok, true);
    assert.equal(inspectDatabaseUrl('postgresql://fftest@localhost/flowforward_test').ok, true);

    const railway = inspectDatabaseUrl('postgresql://user:password@monorail.proxy.rlwy.net:12345/railway');
    assert.equal(railway.ok, false);
    assert.match(railway.reason, /hosted database/);

    const apiHost = inspectDatabaseUrl('postgresql://user:password@flowforward-engine-production.up.railway.app:5432/railway');
    assert.equal(apiHost.ok, false);

    const neon = inspectDatabaseUrl('postgresql://user:password@ep-example.us-east-2.aws.neon.tech/neondb');
    assert.equal(neon.ok, false);

    const other = inspectDatabaseUrl('postgresql://user:password@db.internal.example:5432/app');
    assert.equal(other.ok, false);
    assert.match(other.reason, /not a local host/);
  });

  it('aborts the process when DATABASE_URL points at Railway', () => {
    const result = spawnSync(process.execPath, ['-e', `
      process.env.DATABASE_URL = 'postgresql://user:password@monorail.proxy.rlwy.net:12345/railway';
      require('./test/guard').assertSafeDatabaseEnv();
      console.log('connected');
    `], {
      encoding: 'utf8',
      cwd: path.join(__dirname, '..'),
      env: { ...process.env, DATABASE_URL: '' },
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Refusing to run tests/);
    assert.match(result.stderr, /rlwy\.net/);
    assert.doesNotMatch(result.stdout, /connected/);
  });
});
