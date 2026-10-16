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

function isSocketPath(host) {
  // A Unix socket is an absolute path with one leading slash (/tmp/.s.PGSQL.5432).
  // "//evil.com" is scheme-relative, not a socket, and must be refused.
  return host.startsWith('/') && !host.startsWith('//');
}

// 127.0.0.0/8 and ::1, including IPv4-mapped loopback (::ffff:127.0.0.1).
function isLoopbackAddress(value) {
  let raw = String(value || '').trim().toLowerCase();
  if (raw.startsWith('[') && raw.endsWith(']')) raw = raw.slice(1, -1);
  if (!raw) return false;
  if (raw === '::1' || raw === '0:0:0:0:0:0:0:1') return true;
  if (raw.startsWith('::ffff:')) return isLoopbackAddress(raw.slice('::ffff:'.length));
  const parts = raw.split('.');
  if (parts.length !== 4) return false;
  const nums = parts.map(part => (/^\d{1,3}$/.test(part) ? Number(part) : NaN));
  if (nums.some(n => Number.isNaN(n) || n > 255)) return false;
  return nums[0] === 127;
}

function classifyHost(host) {
  const normalized = normalizeHost(host);
  if (!normalized) return { ok: false, host: normalized, reason: 'has no host' };
  if (isSocketPath(normalized)) return { ok: true, host: normalized };
  if (normalized === 'localhost' || isLoopbackAddress(normalized)) return { ok: true, host: normalized };
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
      source: 'PGSERVICE',
      host: String(env.PGSERVICE).trim(),
      reason: 'set (a service file can point at any host)',
    };
  }
  for (const key of ['PGHOST', 'PGHOSTADDR']) {
    if (!env[key] || !String(env[key]).trim()) continue;
    for (const host of splitHostList(env[key])) {
      const verdict = classifyHost(host);
      if (!verdict.ok) return { ...verdict, source: key };
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

const DOTENV_GUARD_KEYS = ['DATABASE_URL', 'PGHOST', 'PGHOSTADDR', 'PGSERVICE'];

function readDotenvValues(file = path.join(process.cwd(), '.env')) {
  const found = {};
  if (!file || !fs.existsSync(file)) return found;
  const text = fs.readFileSync(file, 'utf8');
  for (const line of text.split(/\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const match = trimmed.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match || !DOTENV_GUARD_KEYS.includes(match[1])) continue;
    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    found[match[1]] = value;
  }
  return found;
}

function readDotenvDatabaseUrl(file) {
  return readDotenvValues(file).DATABASE_URL;
}

function formatRefusal(source, result) {
  const label = result.source || source;
  const where = result.host ? ` "${result.host}"` : '';
  return `Refusing to run tests: ${label}${where} is ${result.reason}. `
    + 'Tests never connect to a non-local or production database. '
    + 'Unset DATABASE_URL, PGHOST, PGHOSTADDR, and PGSERVICE (including in .env) or point the host at 127.0.0.1. '
    + 'npm test starts its own disposable Postgres and will not use a hosted URL.';
}

function refusal(source, result) {
  const err = new Error(formatRefusal(source, result));
  err.code = 'TEST_DATABASE_REFUSED';
  return err;
}

function effectivePgValue(key, fromFile) {
  // An explicit empty string counts as set, so dotenv will not replace it.
  if (process.env[key] != null) return String(process.env[key]).trim();
  return fromFile[key] ? String(fromFile[key]).trim() : '';
}

function pgSource(key, fromFile) {
  if (process.env[key] != null && String(process.env[key]).trim()) return key;
  if (fromFile[key]) return `.env ${key}`;
  return key;
}

function assertSafeDatabaseEnv({ allowUnset = false, envFile } = {}) {
  const envResult = inspectPgEnv(process.env);
  if (!envResult.ok) throw refusal(envResult.source || 'the environment', envResult);

  // dotenv in src/db/client.js loads .env later and does not override variables
  // that are already set. PGHOST in that file is invisible until then, and an
  // empty URL host makes node-postgres use it. Read the file here.
  const fromFile = readDotenvValues(envFile);
  const filePg = inspectPgEnv({
    PGHOST: fromFile.PGHOST,
    PGHOSTADDR: fromFile.PGHOSTADDR,
    PGSERVICE: fromFile.PGSERVICE,
  });
  if (!filePg.ok) {
    filePg.source = `.env ${filePg.source}`;
    throw refusal(filePg.source, filePg);
  }

  const sources = [];
  if (process.env.DATABASE_URL) sources.push(['the environment DATABASE_URL', process.env.DATABASE_URL]);
  if (fromFile.DATABASE_URL) sources.push(['.env DATABASE_URL', fromFile.DATABASE_URL]);
  for (const [source, url] of sources) {
    const result = inspectDatabaseUrl(url);
    if (!result.ok) throw refusal(source, result);
  }

  // The URL node-postgres will use: an already-set env var wins over dotenv.
  const effectiveUrl = process.env.DATABASE_URL || fromFile.DATABASE_URL;
  if (effectiveUrl) {
    const parsed = inspectDatabaseUrl(effectiveUrl);
    if (parsed.implicit) {
      const pgSet = ['PGHOST', 'PGHOSTADDR', 'PGSERVICE'].filter(key => effectivePgValue(key, fromFile));
      if (pgSet.length) {
        throw refusal(pgSet.map(key => pgSource(key, fromFile)).join(', '), {
          reason: 'set while DATABASE_URL has no host. Unset PGHOST, PGHOSTADDR, and PGSERVICE (including in .env)',
        });
      }
    }
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

function isLocalName(value) {
  const normalized = normalizeHost(value);
  if (!normalized) return true;
  if (isSocketPath(normalized)) return true;
  if (normalized === 'localhost' || isLoopbackAddress(normalized)) return true;
  return false;
}

// Node's ClientRequest dials `hostname` when both are set, otherwise `host`.
// https.request(url, options) copies the URL first and then lets options override.
function mergeRequestOptions(args) {
  let base = null;
  let index = 0;
  const first = args[0];
  if (typeof first === 'string' || first instanceof URL) {
    let url;
    try { url = first instanceof URL ? first : new URL(first); }
    catch { return null; }
    base = { protocol: url.protocol, hostname: url.hostname, href: url.href };
    if (url.port) base.port = url.port;
    index = 1;
  } else if (first && typeof first === 'object') {
    base = { ...first };
    index = 1;
  } else {
    return null;
  }
  const second = args[index];
  if (second && typeof second === 'object') base = { ...base, ...second };
  return base;
}

function dialedHttpHost(options) {
  if (!options) return '';
  if (options.hostname) return String(options.hostname);
  if (typeof options.host === 'string') return String(options.host);
  if (typeof options.href === 'string') {
    try { return new URL(options.href).hostname; } catch { return ''; }
  }
  return '';
}

// HTTP layer: the host Node will actually dial, plus SNI. A local servername
// must not hide a denylisted hostname that options wrote over the URL.
function blockedRequestHost(args) {
  const options = mergeRequestOptions(args);
  if (!options) return '';
  const candidates = [dialedHttpHost(options), options.hostname, options.host, options.servername];
  for (const candidate of candidates) {
    const normalized = normalizeHost(candidate);
    if (normalized && isBlockedHost(normalized)) return normalized;
  }
  return '';
}

function isNumericPort(value) {
  if (typeof value === 'number') return Number.isInteger(value) && value >= 0;
  return typeof value === 'string' && /^\d+$/.test(value);
}

// A connect name is forbidden when it is on the vendor list or is not loopback.
// Empty values are ignored. Unix sockets (one leading slash) are local.
function forbiddenConnectName(value) {
  const normalized = normalizeHost(value);
  if (!normalized || isSocketPath(normalized)) return '';
  if (isBlockedHost(normalized) || !isLocalName(normalized)) return normalized;
  return '';
}

// Node's net.connect() calls Socket.prototype.connect with a normalized
// argument list wrapped in an array: [[{ host, port }, null]]. The dialed
// target is host, hostname, an IPC path, or an already-connected socket's
// remote address. servername is only SNI: it is checked too, and it never
// stands in for the address that is actually dialed.
function blockedConnectHost(args, socket) {
  const ranked = [];
  const add = (kind, value) => {
    if (typeof value !== 'string' || !value.trim()) return;
    const forbidden = forbiddenConnectName(value);
    if (forbidden) ranked.push({ kind, host: forbidden });
  };
  const visit = (value) => {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    // hostname and host are the dial target. Read them before servername.
    add('hostname', value.hostname);
    add('host', typeof value.host === 'string' ? value.host : '');
    // A port means this is TCP. `path` is then the HTTP path, not an IPC socket.
    if (typeof value.path === 'string' && !value.port) add('path', value.path);
    add('servername', value.servername);
    add('remote', value.remoteAddress);
    if (value.socket && typeof value.socket === 'object') add('remote', value.socket.remoteAddress);
  };
  args.forEach(visit);
  // tls.connect(port, host, options) is what http2.connect uses. A numeric
  // string is a port, not an IPC path. Only a non-numeric string is a path.
  if (isNumericPort(args[0])) {
    if (typeof args[1] === 'string') add('host', args[1]);
  } else if (typeof args[0] === 'string') {
    add('path', args[0]);
  }
  if (socket && typeof socket.remoteAddress === 'string') add('remote', socket.remoteAddress);
  // Dialed names outrank SNI, so { host: smtp.gmail.com, servername: localhost }
  // is reported as smtp.gmail.com and not as the local servername.
  const dialed = ranked.find(item => item.kind !== 'servername');
  return (dialed || ranked[0] || {}).host || '';
}

let networkGuardInstalled = false;

function installNetworkGuard() {
  if (networkGuardInstalled) return;
  networkGuardInstalled = true;

  for (const [mod, label] of [[http, 'http'], [https, 'https']]) {
    const originalRequest = mod.request;
    const originalGet = mod.get;
    mod.request = function guardedRequest(...args) {
      const host = blockedRequestHost(args);
      if (host) throw new TestNetworkGuardError(host, label);
      return originalRequest.apply(this, args);
    };
    mod.get = function guardedGet(...args) {
      const host = blockedRequestHost(args);
      if (host) throw new TestNetworkGuardError(host, label);
      return originalGet.apply(this, args);
    };
  }

  const originalFetch = globalThis.fetch;
  if (typeof originalFetch === 'function') {
    globalThis.fetch = function guardedFetch(input, init) {
      // The target host must be loopback, not merely absent from the vendor list.
      // A proxy dispatcher would otherwise CONNECT to 192.0.2.1 through 127.0.0.1.
      // Reject, rather than throw, so fetch keeps returning a promise.
      try {
        assertLoopbackTarget(input, 'fetch');
      } catch (err) {
        return Promise.reject(err);
      }
      return originalFetch.call(globalThis, input, init);
    };
  }

  const originalConnect = net.Socket.prototype.connect;
  net.Socket.prototype.connect = function guardedConnect(...args) {
    const host = blockedConnectHost(args, this);
    if (host) throw new TestNetworkGuardError(host, 'socket');
    return originalConnect.apply(this, args);
  };

  // tls.connect({ socket }) upgrades a socket that is already open and does
  // not call Socket.prototype.connect again. Check that entry too.
  const tls = require('tls');
  const originalTlsConnect = tls.connect;
  tls.connect = function guardedTlsConnect(...args) {
    const host = blockedConnectHost(args, null);
    if (host) throw new TestNetworkGuardError(host, 'tls');
    return originalTlsConnect.apply(this, args);
  };

  installTunnelGuard();
  installNativeConnectGuard();
  installUdpGuard();
  installUndiciProxyGuard();
  installNodemailerProxyGuard();
}

function fetchHostname(input) {
  try {
    if (typeof input === 'string') return new URL(input).hostname;
    if (typeof URL !== 'undefined' && input instanceof URL) return input.hostname;
    if (typeof Request !== 'undefined' && input instanceof Request) return new URL(input.url).hostname;
    if (input && typeof input.href === 'string') return new URL(input.href).hostname;
    if (input && typeof input.url === 'string') return new URL(input.url).hostname;
  } catch {
    return '';
  }
  return '';
}

// Last line of defense. net/tls/http/undici all end in TCP.prototype.connect
// (IPv4) or connect6 (IPv6) with the address they are about to dial. A custom
// lookup, or a replaced dns.lookup, can make that address differ from the
// hostname. Throw before the native binding runs so no SYN is sent.
function installNativeConnectGuard() {
  const { TCP } = process.binding('tcp_wrap');
  const { Pipe } = process.binding('pipe_wrap');
  const guardMethod = (proto, name, via) => {
    const original = proto[name];
    if (typeof original !== 'function' || original.__ffGuarded) return;
    function guarded(...args) {
      if (!isLoopbackAddress(args[1])) {
        throw new TestNetworkGuardError(String(args[1]), via);
      }
      return original.apply(this, args);
    }
    guarded.__ffGuarded = true;
    proto[name] = guarded;
  };
  guardMethod(TCP.prototype, 'connect', 'tcp');
  guardMethod(TCP.prototype, 'connect6', 'tcp');
  const originalPipe = Pipe.prototype.connect;
  if (typeof originalPipe === 'function' && !originalPipe.__ffGuarded) {
    function guardedPipe(...args) {
      if (!isSocketPath(normalizeHost(args[1]))) {
        throw new TestNetworkGuardError(String(args[1]), 'pipe');
      }
      return originalPipe.apply(this, args);
    }
    guardedPipe.__ffGuarded = true;
    Pipe.prototype.connect = guardedPipe;
  }
}

// A fetch/undici target with no parseable host is left to the original call.
// A parsed host must be loopback. Vendor names fail this check too.
function assertLoopbackTarget(value, via) {
  const host = fetchHostname(value);
  if (host && !isLocalName(host)) {
    throw new TestNetworkGuardError(normalizeHost(host), via);
  }
}

// CONNECT 192.0.2.1:443, CONNECT [2001:db8::1]:443, or a leading slash
// added when a path is joined onto an origin.
function connectAuthorityHost(authority) {
  let raw = String(authority || '').trim().replace(/^\/+/, '');
  if (!raw) return '';
  if (raw.startsWith('[')) {
    const end = raw.indexOf(']');
    if (end !== -1) return raw.slice(1, end);
  }
  const colon = raw.lastIndexOf(':');
  if (colon > 0 && /^\d+$/.test(raw.slice(colon + 1))) return raw.slice(0, colon);
  return raw;
}

function chunkPrefix(chunk) {
  if (typeof chunk === 'string') return chunk.slice(0, 512);
  if (Buffer.isBuffer(chunk)) return chunk.subarray(0, 512).toString('latin1');
  if (ArrayBuffer.isView(chunk)) {
    return Buffer.from(chunk.buffer, chunk.byteOffset, Math.min(chunk.byteLength, 512)).toString('latin1');
  }
  return '';
}

// SOCKS5 CONNECT is VER=0x05 CMD=0x01 RSV=0x00 ATYP DST.ADDR DST.PORT.
// The greeting is only VER NMETHODS METHODS (05 01 00 with no address) and
// must not be treated as a CONNECT. An incomplete address is not a request.
function socks5ConnectHost(chunk) {
  let buf = null;
  if (Buffer.isBuffer(chunk)) buf = chunk;
  else if (ArrayBuffer.isView(chunk)) buf = Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
  if (!buf || buf.length < 4) return '';
  if (buf[0] !== 0x05 || buf[1] !== 0x01 || buf[2] !== 0x00) return '';
  const atyp = buf[3];
  if (atyp === 0x01) {
    if (buf.length < 10) return '';
    return `${buf[4]}.${buf[5]}.${buf[6]}.${buf[7]}`;
  }
  if (atyp === 0x03) {
    const len = buf[4];
    if (!len || buf.length < 5 + len + 2) return '';
    return buf.subarray(5, 5 + len).toString('utf8');
  }
  if (atyp === 0x04) {
    if (buf.length < 22) return '';
    const addr = buf.subarray(4, 20);
    const v4Mapped = addr.subarray(0, 10).every(b => b === 0) && addr[10] === 0xff && addr[11] === 0xff;
    if (v4Mapped) return `${addr[12]}.${addr[13]}.${addr[14]}.${addr[15]}`;
    if (addr.subarray(0, 15).every(b => b === 0) && addr[15] === 1) return '::1';
    const parts = [];
    for (let i = 0; i < 8; i++) parts.push(addr.readUInt16BE(i * 2).toString(16));
    return parts.join(':');
  }
  return '';
}

function assertNoForeignTunnel(chunk) {
  const socksHost = socks5ConnectHost(chunk);
  if (socksHost && !isLocalName(socksHost)) {
    throw new TestNetworkGuardError(normalizeHost(socksHost), 'connect-tunnel');
  }
  const prefix = chunkPrefix(chunk);
  // GET http://192.0.2.1/ HTTP/1.1, including a leading CRLF and CONNECT https://...
  const absolute = /^\s*[A-Z]+\s+(https?:\/\/[^\s/]+)/i.exec(prefix);
  if (absolute) {
    let host = '';
    try { host = new URL(absolute[1]).hostname; } catch { host = ''; }
    if (host && !isLocalName(host)) {
      throw new TestNetworkGuardError(normalizeHost(host), 'connect-tunnel');
    }
  }
  // CONNECT 192.0.2.1:443, also after a leading CRLF.
  const tunnel = /^\s*CONNECT\s+(\S+)/i.exec(prefix);
  if (!tunnel) return;
  const host = connectAuthorityHost(tunnel[1]);
  if (host && !isLocalName(host)) {
    throw new TestNetworkGuardError(normalizeHost(host), 'connect-tunnel');
  }
}

// Any library that opens a loopback proxy and then writes CONNECT <target>
// hits this, including axios/https-proxy-agent and a raw socket.
function installTunnelGuard() {
  const proto = net.Socket.prototype;
  const originalWrite = proto.write;
  if (typeof originalWrite === 'function' && !originalWrite.__ffGuarded) {
    function guardedWrite(chunk) {
      try {
        assertNoForeignTunnel(chunk);
      } catch (err) {
        // Drop the socket. A refused CONNECT must not stay open on the proxy.
        this.destroy();
        throw err;
      }
      return originalWrite.apply(this, arguments);
    }
    guardedWrite.__ffGuarded = true;
    proto.write = guardedWrite;
  }
  // Socket.prototype.writev is not a function on Node 20 or 22 (the stream
  // method is _writev). A corked or split write that never passes the whole
  // request line to write() is out of scope.
}

function assertConnectPath(opts, via) {
  if (!opts || typeof opts.path !== 'string' || !opts.path) return;
  const host = connectAuthorityHost(opts.path);
  if (host && !isLocalName(host)) {
    throw new TestNetworkGuardError(normalizeHost(host), via);
  }
}

// socks://, socks4://, socks4a://, socks5://. Tests never need a proxy.
function socksProxyLabel(value) {
  if (value == null || value === '') return '';
  const raw = typeof value === 'string' || (typeof URL !== 'undefined' && value instanceof URL)
    ? value
    : (value.uri || value.href || value.url || value.proxy || '');
  if (raw == null || raw === '') return '';
  try {
    const url = typeof URL !== 'undefined' && raw instanceof URL ? raw : new URL(String(raw));
    if (/^socks\d*a?:$/i.test(url.protocol)) return url.href;
  } catch {
    return '';
  }
  return '';
}

function throwIfSocksProxy(value) {
  const label = socksProxyLabel(value);
  if (label) throw new TestNetworkGuardError(label, 'socks');
  return label;
}

function installUndiciProxyGuard() {
  let undici;
  try { undici = require('undici'); }
  catch { return; }

  const originalFetch = undici.fetch;
  if (typeof originalFetch === 'function' && !originalFetch.__ffGuarded) {
    function guardedUndiciFetch(input, init) {
      // Same loopback rule as global fetch. undici.fetch is a separate export
      // (cheerio uses it) and is not the global fetch wrapper above.
      try {
        assertLoopbackTarget(input, 'undici-fetch');
      } catch (err) {
        return Promise.reject(err);
      }
      return originalFetch.call(this, input, init);
    }
    guardedUndiciFetch.__ffGuarded = true;
    undici.fetch = guardedUndiciFetch;
  }

  for (const name of ['request', 'stream', 'pipeline', 'connect', 'upgrade']) {
    const original = undici[name];
    if (typeof original !== 'function' || original.__ffGuarded) continue;
    function guarded(url, opts, handler) {
      assertLoopbackTarget(url, 'undici');
      if (name === 'connect') assertConnectPath(opts, 'undici-connect');
      return original.call(this, url, opts, handler);
    }
    guarded.__ffGuarded = true;
    undici[name] = guarded;
  }

  const Dispatcher = undici.Dispatcher;
  const originalConnect = Dispatcher && Dispatcher.prototype && Dispatcher.prototype.connect;
  if (typeof originalConnect === 'function' && !originalConnect.__ffGuarded) {
    function guardedDispatcherConnect(opts, callback) {
      assertConnectPath(opts, 'undici-connect');
      return originalConnect.call(this, opts, callback);
    }
    guardedDispatcherConnect.__ffGuarded = true;
    Dispatcher.prototype.connect = guardedDispatcherConnect;
  }

  // ProxyAgent defines its own dispatch and does not call Dispatcher.prototype.dispatch.
  // Socks5ProxyAgent and EnvHttpProxyAgent do not either. They inherit
  // DispatcherBase.prototype.dispatch, which calls [kDispatch]. The method on
  // Dispatcher.prototype is the unimplemented base and is not the one they run.
  const proxyClasses = [undici.ProxyAgent, undici.EnvHttpProxyAgent];
  for (const Ctor of proxyClasses) {
    if (!Ctor || !Ctor.prototype) continue;
    const original = Ctor.prototype.dispatch;
    if (typeof original !== 'function' || original.__ffGuarded) continue;
    if (!Object.prototype.hasOwnProperty.call(Ctor.prototype, 'dispatch')) continue;
    function guardedDispatch(opts, handler) {
      if (opts && opts.origin) assertLoopbackTarget(opts.origin, 'undici-proxy');
      return original.call(this, opts, handler);
    }
    guardedDispatch.__ffGuarded = true;
    Ctor.prototype.dispatch = guardedDispatch;
  }

  // Every dispatcher origin must be loopback, including agents that only
  // implement [kDispatch] and inherit this method. Find DispatcherBase on a
  // real Agent instance rather than assuming Dispatcher.prototype.dispatch.
  const probe = new undici.Agent();
  let baseProto = null;
  try {
    let proto = Object.getPrototypeOf(probe);
    while (proto && proto !== Object.prototype) {
      if (proto.constructor && proto.constructor.name === 'DispatcherBase'
        && Object.prototype.hasOwnProperty.call(proto, 'dispatch')) {
        baseProto = proto;
        break;
      }
      proto = Object.getPrototypeOf(proto);
    }
  } finally {
    if (typeof probe.destroy === 'function') probe.destroy();
  }
  const originalBaseDispatch = baseProto && baseProto.dispatch;
  if (typeof originalBaseDispatch === 'function' && !originalBaseDispatch.__ffGuarded) {
    function guardedBaseDispatch(opts, handler) {
      if (opts && opts.origin) assertLoopbackTarget(opts.origin, 'undici-proxy');
      return originalBaseDispatch.call(this, opts, handler);
    }
    guardedBaseDispatch.__ffGuarded = true;
    baseProto.dispatch = guardedBaseDispatch;
  }

  // Tests never need a SOCKS proxy. Construction throws, including a SOCKS
  // URL handed to ProxyAgent or EnvHttpProxyAgent. The closed-over
  // Socks5ProxyAgent inside undici still emits its experimental warning
  // before it opens a tunnel; that warning throws too.
  refuseSocksConstructors(undici);
  const originalEmitWarning = process.emitWarning;
  if (typeof originalEmitWarning === 'function' && !originalEmitWarning.__ffGuarded) {
    function guardedEmitWarning(warning) {
      const text = typeof warning === 'string' ? warning : (warning && warning.message) || '';
      if (/SOCKS5 proxy support/i.test(text)) {
        throw new TestNetworkGuardError('socks5', 'socks');
      }
      return originalEmitWarning.apply(this, arguments);
    }
    guardedEmitWarning.__ffGuarded = true;
    process.emitWarning = guardedEmitWarning;
  }
}

function refuseSocksConstructors(undici) {
  if (undici.Socks5ProxyAgent && !undici.Socks5ProxyAgent.__ffGuarded) {
    const Original = undici.Socks5ProxyAgent;
    function GuardedSocks5ProxyAgent(...args) {
      throw new TestNetworkGuardError(socksProxyLabel(args[0]) || 'socks5', 'socks');
    }
    GuardedSocks5ProxyAgent.__ffGuarded = true;
    GuardedSocks5ProxyAgent.prototype = Original.prototype;
    Object.setPrototypeOf(GuardedSocks5ProxyAgent, Original);
    undici.Socks5ProxyAgent = GuardedSocks5ProxyAgent;
  }

  if (undici.ProxyAgent && !undici.ProxyAgent.__ffGuarded) {
    const Original = undici.ProxyAgent;
    function GuardedProxyAgent(...args) {
      throwIfSocksProxy(args[0]);
      return new Original(...args);
    }
    GuardedProxyAgent.__ffGuarded = true;
    GuardedProxyAgent.prototype = Original.prototype;
    Object.setPrototypeOf(GuardedProxyAgent, Original);
    undici.ProxyAgent = GuardedProxyAgent;
  }

  if (undici.EnvHttpProxyAgent && !undici.EnvHttpProxyAgent.__ffGuarded) {
    const Original = undici.EnvHttpProxyAgent;
    function GuardedEnvHttpProxyAgent(...args) {
      const opts = args[0] && typeof args[0] === 'object' ? args[0] : {};
      throwIfSocksProxy(opts.httpProxy);
      throwIfSocksProxy(opts.httpsProxy);
      throwIfSocksProxy(process.env.http_proxy);
      throwIfSocksProxy(process.env.HTTP_PROXY);
      throwIfSocksProxy(process.env.https_proxy);
      throwIfSocksProxy(process.env.HTTPS_PROXY);
      throwIfSocksProxy(process.env.all_proxy);
      throwIfSocksProxy(process.env.ALL_PROXY);
      return new Original(...args);
    }
    GuardedEnvHttpProxyAgent.__ffGuarded = true;
    GuardedEnvHttpProxyAgent.prototype = Original.prototype;
    Object.setPrototypeOf(GuardedEnvHttpProxyAgent, Original);
    undici.EnvHttpProxyAgent = GuardedEnvHttpProxyAgent;
  }
}

// send/send6 unconnected: (req, list, length, port, address, hasCallback).
// Connected send omits the address (connect already checked it).
// connect/connect6: (address, port). Throw before the native binding runs.
function installUdpGuard() {
  let UDP;
  try { ({ UDP } = process.binding('udp_wrap')); }
  catch { return; }
  const proto = UDP.prototype;
  const guardSend = (name) => {
    const original = proto[name];
    if (typeof original !== 'function' || original.__ffGuarded) return;
    function guarded(...args) {
      const address = args.length >= 5 ? args[4] : '';
      if (typeof address === 'string' && address && !isLoopbackAddress(address)) {
        throw new TestNetworkGuardError(address, 'udp');
      }
      return original.apply(this, args);
    }
    guarded.__ffGuarded = true;
    proto[name] = guarded;
  };
  const guardConnect = (name) => {
    const original = proto[name];
    if (typeof original !== 'function' || original.__ffGuarded) return;
    function guarded(...args) {
      if (!isLoopbackAddress(args[0])) {
        throw new TestNetworkGuardError(String(args[0]), 'udp');
      }
      return original.apply(this, args);
    }
    guarded.__ffGuarded = true;
    proto[name] = guarded;
  };
  guardSend('send');
  guardSend('send6');
  guardConnect('connect');
  guardConnect('connect6');

  // dgram resolves the address, then calls the binding on a later tick.
  // A throw from that tick is an uncaught exception. Refuse the address here,
  // in the caller, before DNS. The binding wrap above still covers a direct call.
  const dgram = require('dgram');
  const socketProto = dgram.Socket.prototype;
  const originalSend = socketProto.send;
  if (typeof originalSend === 'function' && !originalSend.__ffGuarded) {
    function guardedSocketSend(...args) {
      // send(msg, port[, address][, cb]) or send(msg, offset, length, port, address[, cb]).
      // The first argument is the payload and may be a string. It is not a host.
      let address = '';
      if (typeof args[1] === 'number' && typeof args[2] === 'number') {
        address = typeof args[4] === 'string' ? args[4] : '';
      } else if (typeof args[1] === 'number' && typeof args[2] === 'string') {
        address = args[2];
      }
      if (address && !isLocalName(address)) {
        throw new TestNetworkGuardError(normalizeHost(address), 'udp');
      }
      return originalSend.apply(this, args);
    }
    guardedSocketSend.__ffGuarded = true;
    socketProto.send = guardedSocketSend;
  }
  const originalSocketConnect = socketProto.connect;
  if (typeof originalSocketConnect === 'function' && !originalSocketConnect.__ffGuarded) {
    function guardedSocketConnect(...args) {
      for (const arg of args) {
        if (typeof arg === 'string' && !isLocalName(arg)) {
          throw new TestNetworkGuardError(normalizeHost(arg), 'udp');
        }
      }
      return originalSocketConnect.apply(this, args);
    }
    guardedSocketConnect.__ffGuarded = true;
    socketProto.connect = guardedSocketConnect;
  }
}

function proxyQuery(value) {
  const text = String(value || '');
  const q = text.indexOf('?');
  if (q === -1) return '';
  let query = text.slice(q + 1);
  const hash = query.indexOf('#');
  if (hash !== -1) query = query.slice(0, hash);
  try {
    const proxy = new URLSearchParams(query).get('proxy');
    if (proxy) return proxy;
  } catch { /* query string was not parseable */ }
  const match = /(?:^|&)proxy=([^&]*)/i.exec(query);
  if (!match) return '';
  try { return decodeURIComponent(match[1]); }
  catch { return match[1]; }
}

function nodemailerProxy(options) {
  if (typeof options === 'string') return proxyQuery(options);
  if (!options || typeof options !== 'object') return '';
  if (options.proxy) return String(options.proxy);
  if (typeof options.url === 'string') return proxyQuery(options.url);
  return '';
}

function installNodemailerProxyGuard() {
  const nodemailer = require('nodemailer');
  if (!nodemailer.createTransport.__ffGuarded) {
    const original = nodemailer.createTransport;
    function guardedCreateTransport(options, defaults) {
      const proxy = nodemailerProxy(options);
      if (proxy) throw new TestNetworkGuardError(proxy, 'nodemailer-proxy');
      return original.call(this, options, defaults);
    }
    guardedCreateTransport.__ffGuarded = true;
    nodemailer.createTransport = guardedCreateTransport;
  }

  // createTransport copies ?proxy= onto options and then calls setupProxy.
  // Refusing here covers a proxy that only appears after that parse.
  const Mailer = require('nodemailer/lib/mailer');
  const setup = Mailer.prototype.setupProxy;
  if (typeof setup === 'function' && !setup.__ffGuarded) {
    function guardedSetupProxy(proxyUrl) {
      throw new TestNetworkGuardError(String(proxyUrl || 'proxy'), 'nodemailer-proxy');
    }
    guardedSetupProxy.__ffGuarded = true;
    Mailer.prototype.setupProxy = guardedSetupProxy;
  }
}

module.exports = {
  LOCAL_HOSTS,
  TestNetworkGuardError,
  normalizeHost,
  classifyHost,
  inspectDatabaseUrl,
  inspectPgEnv,
  shouldUseProvidedDatabase,
  readDotenvDatabaseUrl,
  assertSafeDatabaseEnv,
  blankLiveCredentials,
  isBlockedHost,
  installNetworkGuard,
};
