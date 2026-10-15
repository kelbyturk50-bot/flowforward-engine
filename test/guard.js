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

// 0.0.0.0 is not loopback (it binds every interface). It is not local.
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);

// Hosted Postgres domains. Matched against every host the URL resolves to.
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
  'maps.googleapis.com',
  'www.googleapis.com',
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
  'GMAIL_USER',
  'GMAIL_APP_PASSWORD',
];

// pg-connection-string is what node-postgres uses. A ?host= query param
// overrides the hostname in the URL, so checking URL.hostname alone is not enough.
const parseConnectionString = require('pg-connection-string').parse;

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
  // [::1]:5432 and [2607:f8b0::1] — take the bracketed address and drop the port.
  // Do this before any ":digits" strip. A naive strip turns ::1 into ":".
  if (h.startsWith('[')) {
    const end = h.indexOf(']');
    if (end !== -1) return h.slice(1, end).replace(/\.$/, '');
  }
  const colonCount = (h.match(/:/g) || []).length;
  if (colonCount === 1) h = h.replace(/:\d+$/, '');
  return h.replace(/\.$/, '');
}

// libpq allows several hosts, comma-separated. Do not split inside [ipv6].
function splitHostList(value) {
  const hosts = [];
  let current = '';
  let brackets = 0;
  for (const ch of String(value || '')) {
    if (ch === '[') brackets++;
    else if (ch === ']') brackets = Math.max(0, brackets - 1);
    else if (ch === ',' && brackets === 0) {
      if (current.trim()) hosts.push(current.trim());
      current = '';
      continue;
    }
    current += ch;
  }
  if (current.trim()) hosts.push(current.trim());
  return hosts;
}

function classifyHost(host) {
  const normalized = normalizeHost(host);
  if (!normalized) return { ok: false, host: normalized, reason: 'has no host' };
  // Absolute path: a Unix socket. It cannot be a remote machine.
  if (normalized.startsWith('/')) return { ok: true, host: normalized };
  const hosted = HOSTED_DB_SUFFIXES.find(suffix => hostMatches(normalized, suffix));
  if (hosted) return { ok: false, host: normalized, reason: `a hosted database (${hosted})` };
  if (!LOCAL_HOSTS.has(normalized)) return { ok: false, host: normalized, reason: 'not a local host' };
  return { ok: true, host: normalized };
}

function queryParams(text) {
  const q = String(text).indexOf('?');
  if (q === -1) return null;
  try {
    return new URL(text).searchParams;
  } catch {
    try {
      return new URL('http://127.0.0.1/' + text.slice(q)).searchParams;
    } catch {
      return undefined;
    }
  }
}

// host, hostaddr, and service in the query string override what the URL
// appears to point at. node-postgres (via pg-connection-string) honors host=.
// libpq also honors hostaddr= and service=. Refuse the params themselves.
function hostOverride(text) {
  const params = queryParams(text);
  if (params === undefined) return { ok: false, reason: 'not a valid URL' };
  if (!params) return null;
  for (const [key, value] of params.entries()) {
    const name = key.toLowerCase();
    if (name === 'host' || name === 'hostaddr') {
      return { ok: false, host: value, reason: `a host override (?${name}=)` };
    }
    if (name === 'service') {
      return { ok: false, host: value, reason: 'a libpq service name (?service=), which can point at any host' };
    }
  }
  return null;
}

function inspectDatabaseUrl(raw) {
  if (raw == null || String(raw).trim() === '') return { ok: true, unset: true };
  const text = String(raw).trim();
  const override = hostOverride(text);
  if (override) return override;

  let parsed;
  try {
    parsed = parseConnectionString(text);
  } catch {
    return { ok: false, reason: 'not a valid URL' };
  }

  // The host pg-connection-string actually connects to, after query overrides.
  const hosts = splitHostList(parsed.host || '');
  if (!hosts.length) return { ok: true, host: 'localhost', implicit: true };
  for (const host of hosts) {
    const verdict = classifyHost(host);
    if (!verdict.ok) return verdict;
  }
  return { ok: true, host: hosts.map(h => normalizeHost(h)).join(',') };
}

function inspectPgEnv(env) {
  if (env.PGSERVICE && String(env.PGSERVICE).trim()) {
    return {
      ok: false,
      host: String(env.PGSERVICE).trim(),
      reason: 'PGSERVICE is set (a service file can point at any host)',
    };
  }
  for (const key of ['PGHOST', 'PGHOSTADDR']) {
    if (!env[key] || !String(env[key]).trim()) continue;
    for (const host of splitHostList(env[key])) {
      const verdict = classifyHost(host);
      if (!verdict.ok) return { ...verdict, reason: `${key} is ${verdict.reason}` };
    }
  }
  return { ok: true };
}

function shouldUseProvidedDatabase(url) {
  const result = inspectDatabaseUrl(url);
  if (!result.ok || result.unset || result.implicit) return false;
  let name = '';
  try { name = parseConnectionString(String(url)).database || ''; } catch { return false; }
  return name === 'flowforward_test';
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
  const where = result.host ? ` "${result.host}"` : '';
  return `Refusing to run tests: ${source}${where} is ${result.reason}. `
    + 'Tests never connect to a non-local or production database. '
    + 'Unset DATABASE_URL, PGHOST, PGHOSTADDR, and PGSERVICE (including in .env) or point the host at 127.0.0.1. '
    + 'npm test starts its own disposable Postgres and will not use a hosted URL.';
}

function refusal(source, result) {
  const err = new Error(formatRefusal(source, result));
  err.code = 'TEST_DATABASE_REFUSED';
  return err;
}

function assertSafeDatabaseEnv({ allowUnset = false } = {}) {
  const envResult = inspectPgEnv(process.env);
  if (!envResult.ok) throw refusal('the environment', envResult);

  const sources = [];
  if (process.env.DATABASE_URL) sources.push(['the environment DATABASE_URL', process.env.DATABASE_URL]);
  const fromFile = readDotenvDatabaseUrl();
  if (fromFile) sources.push(['.env DATABASE_URL', fromFile]);
  for (const [source, url] of sources) {
    const result = inspectDatabaseUrl(url);
    if (!result.ok) throw refusal(source, result);
  }
  if (!allowUnset && !process.env.DATABASE_URL) {
    throw refusal('DATABASE_URL', { reason: 'not set. Run npm test, which starts a disposable Postgres on 127.0.0.1' });
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
  normalizeHost,
  inspectDatabaseUrl,
  inspectPgEnv,
  shouldUseProvidedDatabase,
  readDotenvDatabaseUrl,
  assertSafeDatabaseEnv,
  blankLiveCredentials,
  isBlockedHost,
  installNetworkGuard,
};
