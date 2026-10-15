#!/usr/bin/env node
// npm test
//
// Starts a disposable Postgres (or reuses a local flowforward_test URL),
// applies schema.sql, then runs the suite. Never connects to a hosted database.
//
// Node 20 rejects --experimental-test-isolation=process (the process exits 9).
// Each test file runs in its own process instead, so a pool.end() or an env
// change in one file cannot leak into the next. That works on Node 20 and 22.

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const {
  assertSafeDatabaseEnv,
  blankLiveCredentials,
  installNetworkGuard,
  shouldUseProvidedDatabase,
} = require('./guard');
const { startDisposablePostgres } = require('./postgres');

function testFiles() {
  return fs.readdirSync(__dirname)
    .filter(name => name.endsWith('.test.js'))
    .map(name => path.join(__dirname, name))
    .sort();
}

function runFile(file) {
  const args = [
    '--require', path.join(__dirname, 'preload.js'),
    '--test',
    '--test-reporter=spec',
    '--test-timeout=60000',
    file,
  ];
  return new Promise(resolve => {
    const child = spawn(process.execPath, args, { stdio: 'inherit', env: process.env });
    child.on('exit', code => resolve(code == null ? 1 : code));
  });
}

async function runTests() {
  let code = 0;
  for (const file of testFiles()) {
    const one = await runFile(file);
    if (one !== 0) code = one;
  }
  return code;
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

function portOf(url) {
  try { return new URL(url).port || '5432'; } catch { return '5432'; }
}

async function main() {
  // Check the caller's URL and PGHOST/PGHOSTADDR/PGSERVICE before replacing
  // them. allowUnset: a missing URL is normal; a hosted URL is not.
  assertSafeDatabaseEnv({ allowUnset: true });
  blankLiveCredentials();
  delete process.env.PGHOST;
  delete process.env.PGHOSTADDR;
  delete process.env.PGSERVICE;

  const provided = process.env.DATABASE_URL;
  const db = provided && shouldUseProvidedDatabase(provided)
    ? { url: provided, port: portOf(provided), kind: 'provided', async stop() {} }
    : await startDisposablePostgres();

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
