// Safety checks for the test process.
//
// 1. DATABASE_URL must be local. A hosted or production-looking URL aborts
//    the process before any client connects.
// 2. Live Places, Anthropic, and Gmail credentials are blanked so dotenv
//    cannot refill them (dotenv does not override variables that are already set).
// 3. Outbound HTTP and sockets to those vendors throw before a request is sent.

const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const net = require('net');

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '0.0.0.0']);

// Hosted Postgres domains. Matched against the URL hostname only.
const HOSTED_DB_SUFFIXES = [
  'railway.app',
  'railway.internal',
  'rlwy.net',
  'neon.tech',
  'supabase.co',
  'supabase.com',
  'render.com',
  'amazonaws.com',
  'azure.com',
  'digitalocean.com',
  'cockroachlabs.cloud',
  'elephantsql.com',
  'herokuapp.com',
  'timescale.com',
  'cloudsql.goog',
];

// Vendors the suite must never call. Matched against the request hostname.
const BLOCKED_HOST_SUFFIXES = [
  'places.googleapis.com',
  'anthropic.com',
  'gmail.googleapis.com',
  'smtp.gmail.com',
  'imap.gmail.com',
  'oauth2.googleapis.com',
];

const LIVE_CREDENTIAL_KEYS = [
  'GOOGLE_PLACES_API_KEY',
  'ANTHROPIC_API_KEY',
  'GOOGLE_CLIENT_ID',
  'GOOGLE_CLIENT_SECRET',
  'GMAIL_APP_PASSWORD',
];

class TestNetworkGuardError extends Error {
  constructor(host, via) {
    super(`Refusing to call ${host} during tests (network guard, ${via}). Tests must not reach Places, Anthropic, or Gmail.`);
    this.name = 'TestNetworkGuardError';
    this.code = 'TEST_NETWORK_BLOCKED';
    this.host = host;
  }
}

function hostMatches(host, suffix) {
  return host === suffix || host.endsWith('.' + suffix);
}

function normalizeHost(host) {
  let h = String(host || '').trim().toLowerCase();
  if (!h) return '';
  if (h.startsWith('[')) {
    const end = h.indexOf(']');
    if (end !== -1) h = h.slice(1, end);
  }
  h = h.replace(/:\d+$/, '').replace(/\.$/, '');
  return h;
}

function inspectDatabaseUrl(raw) {
  if (raw == null || String(raw).trim() === '') return { ok: true, unset: true };
  let hostname;
  try {
    hostname = new URL(String(raw)).hostname;
  } catch {
    return { ok: false, reason: 'not a valid URL' };
  }
  const host = normalizeHost(hostname);
  if (!host) return { ok: false, reason: 'has no host' };
  const hosted = HOSTED_DB_SUFFIXES.find(suffix => hostMatches(host, suffix));
  if (hosted) return { ok: false, host, reason: `a hosted database (${hosted})` };
  if (!LOCAL_HOSTS.has(host)) return { ok: false, host, reason: 'not a local host' };
  return { ok: true, host };
}

function readDotenvDatabaseUrl(file = path.join(process.cwd(), '.env')) {
  if (!fs.existsSync(file)) return undefined;
  const text = fs.readFileSync(file, 'utf8');
  for (const line of text.split(/\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const match = trimmed.match(/^(?:export\s+)?DATABASE_URL\s*=\s*(.*)$/);
    if (!match) continue;
    let value = match[1].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    return value;
  }
  return undefined;
}

function formatRefusal(source, result) {
  const where = result.host ? ` host "${result.host}"` : '';
  return `Refusing to run tests: ${source} DATABASE_URL${where} is ${result.reason}. `
    + 'Tests never connect to a non-local or production database. '
    + 'Unset DATABASE_URL (including in .env) or point it at 127.0.0.1. '
    + 'npm test starts its own disposable Postgres and will not use that URL.';
}

function assertSafeDatabaseEnv({ allowUnset = false } = {}) {
  const sources = [];
  if (process.env.DATABASE_URL) sources.push(['the environment', process.env.DATABASE_URL]);
  const fromFile = readDotenvDatabaseUrl();
  if (fromFile) sources.push(['.env', fromFile]);
  for (const [source, url] of sources) {
    const result = inspectDatabaseUrl(url);
    if (!result.ok) {
      const err = new Error(formatRefusal(source, result));
      err.code = 'TEST_DATABASE_REFUSED';
      throw err;
    }
  }
  if (!allowUnset && !process.env.DATABASE_URL) {
    const err = new Error(
      'Refusing to run tests: DATABASE_URL is not set. Run npm test, which starts a disposable Postgres on 127.0.0.1. '
      + 'Tests will not fall back to a hosted database.'
    );
    err.code = 'TEST_DATABASE_REFUSED';
    throw err;
  }
}

function blankLiveCredentials() {
  // Empty string counts as set, so dotenv will not replace it with a real key.
  for (const key of LIVE_CREDENTIAL_KEYS) process.env[key] = '';
}

function isBlockedHost(host) {
  const normalized = normalizeHost(host);
  if (!normalized) return false;
  return BLOCKED_HOST_SUFFIXES.some(suffix => hostMatches(normalized, suffix));
}

function hostOfRequestArgs(args) {
  const first = args[0];
  if (typeof first === 'string') {
    try { return new URL(first).hostname; } catch { return ''; }
  }
  if (first instanceof URL) return first.hostname;
  if (first && typeof first === 'object') {
    if (first.hostname) return String(first.hostname);
    if (typeof first.host === 'string') return String(first.host);
    if (typeof first.href === 'string') {
      try { return new URL(first.href).hostname; } catch { return ''; }
    }
  }
  return '';
}

// Node's net.connect() calls Socket.prototype.connect with a normalized
// argument list wrapped in an array: [[{ host, port }, null]]. Read every
// nested host field so that shape cannot skip the guard.
function hostOfConnectArgs(args) {
  const found = [];
  const visit = (value) => {
    if (!value) return;
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (typeof value === 'object') {
      found.push(value.servername, value.host, value.hostname);
    }
  };
  args.forEach(visit);
  if (typeof args[1] === 'string') found.push(args[1]);
  return found.find(Boolean) || '';
}

let networkGuardInstalled = false;

function installNetworkGuard() {
  if (networkGuardInstalled) return;
  networkGuardInstalled = true;

  for (const [mod, label] of [[http, 'http'], [https, 'https']]) {
    const originalRequest = mod.request;
    const originalGet = mod.get;
    mod.request = function guardedRequest(...args) {
      const host = normalizeHost(hostOfRequestArgs(args));
      if (isBlockedHost(host)) throw new TestNetworkGuardError(host, label);
      return originalRequest.apply(this, args);
    };
    mod.get = function guardedGet(...args) {
      const host = normalizeHost(hostOfRequestArgs(args));
      if (isBlockedHost(host)) throw new TestNetworkGuardError(host, label);
      return originalGet.apply(this, args);
    };
  }

  const originalFetch = globalThis.fetch;
  if (typeof originalFetch === 'function') {
    globalThis.fetch = function guardedFetch(input, init) {
      const raw = typeof input === 'string' ? input : (input && input.url) || '';
      let host = '';
      try { host = new URL(raw).hostname; } catch { host = ''; }
      if (isBlockedHost(host)) return Promise.reject(new TestNetworkGuardError(normalizeHost(host), 'fetch'));
      return originalFetch.call(globalThis, input, init);
    };
  }

  const originalConnect = net.Socket.prototype.connect;
  net.Socket.prototype.connect = function guardedConnect(...args) {
    const host = normalizeHost(hostOfConnectArgs(args));
    if (isBlockedHost(host)) throw new TestNetworkGuardError(host, 'socket');
    return originalConnect.apply(this, args);
  };
}

module.exports = {
  LOCAL_HOSTS,
  TestNetworkGuardError,
  inspectDatabaseUrl,
  readDotenvDatabaseUrl,
  assertSafeDatabaseEnv,
  blankLiveCredentials,
  isBlockedHost,
  installNetworkGuard,
};
