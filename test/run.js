#!/usr/bin/env node
// npm test
//
// Starts a disposable Postgres, applies schema.sql, then runs the suite.
// Never connects to a DATABASE_URL whose host is not local.

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { assertSafeDatabaseEnv, blankLiveCredentials, installNetworkGuard } = require('./guard');
const { startDisposablePostgres } = require('./postgres');

function runTests() {
  const files = fs.readdirSync(__dirname)
    .filter(name => name.endsWith('.test.js'))
    .map(name => path.join(__dirname, name))
    .sort();
  const args = [
    '--require', path.join(__dirname, 'preload.js'),
    '--test',
    '--test-reporter=spec',
    '--experimental-test-isolation=process',
    '--test-concurrency=1',
    '--test-timeout=60000',
    ...files,
  ];
  return new Promise(resolve => {
    const child = spawn(process.execPath, args, { stdio: 'inherit', env: process.env });
    child.on('exit', code => resolve(code == null ? 1 : code));
  });
}

async function applySchema() {
  installNetworkGuard();
  const { applySchema: apply } = require('../src/db/migrate');
  const pool = require('../src/db/client');
  try {
    await apply();
  } finally {
    await pool.end();
  }
}

async function main() {
  // Check the caller's URL before replacing it. allowUnset: a missing URL is
  // normal; a Railway (or other hosted) URL is not.
  assertSafeDatabaseEnv({ allowUnset: true });
  blankLiveCredentials();

  const db = await startDisposablePostgres();
  let code = 1;
  try {
    process.env.DATABASE_URL = db.url;
    process.env.NODE_ENV = 'test';
    process.env.DISABLE_CRON = '1';
    process.env.PUBLIC_BASE_URL = 'http://127.0.0.1:3000';
    if (!process.env.SENDER_ADDRESS) {
      process.env.SENDER_ADDRESS = '1 Test Street, Saratoga Springs, UT 84045';
    }
    assertSafeDatabaseEnv();
    console.log(`[test] Disposable Postgres (${db.kind}) on 127.0.0.1:${db.port}, database flowforward_test`);
    console.log('[test] Applying src/db/schema.sql');
    await applySchema();
    console.log('[test] Schema applied. Running suite.');
    code = await runTests();
  } finally {
    await db.stop();
    console.log('[test] Disposable Postgres stopped.');
  }
  process.exit(code);
}

main().catch(err => {
  console.error(err.message || err);
  process.exit(1);
});
