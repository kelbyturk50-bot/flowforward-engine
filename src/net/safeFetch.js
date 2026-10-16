// SSRF guard for outbound GETs of prospect-controlled URLs.
//
// research.js crawls websites through safeFetch. A later logo and colour
// fetch should call this module too, instead of copying the checks.
//
// What is allowed
//   http and https only, and only ports 80 and 443. Other ports are refused.
//   A public host on 8080, 3000, or 22 is a common path to an admin port, so
//   opening that up is not safe. Userinfo in the URL is refused.
//
// How a connection is pinned
//   DNS is resolved here (every A and AAAA record). If any record falls in a
//   blocked range, the whole request is refused. The socket is then opened
//   with a custom lookup on the http or https agent that returns the vetted
//   address and does not query DNS again, so a rebind between the check and
//   the connect cannot switch the target. SNI and the Host header stay on the
//   original hostname.
//
// Redirects are followed manually, at most 5, and every hop is vetted again.
// The 12s timeout is one budget for DNS and every hop. The body is capped at
// 3MB and the socket is destroyed at the cap.

const dns = require('dns');
const http = require('http');
const https = require('https');
const net = require('net');
const zlib = require('zlib');
const { PassThrough } = require('stream');

const DEFAULT_TIMEOUT_MS = 12000;
const DEFAULT_MAX_BYTES = 3_000_000;
const DEFAULT_MAX_REDIRECTS = 5;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

// [base as uint32, prefix length]. 255.255.255.255 is inside 240/4.
const V4_PREFIXES = [
  [0x00000000, 8],  // 0.0.0.0/8
  [0x0a000000, 8],  // 10.0.0.0/8
  [0x64400000, 10], // 100.64.0.0/10
  [0x7f000000, 8],  // 127.0.0.0/8
  [0xa9fe0000, 16], // 169.254.0.0/16
  [0xac100000, 12], // 172.16.0.0/12
  [0xc0000000, 24], // 192.0.0.0/24
  [0xc0000200, 24], // 192.0.2.0/24
  [0xc0a80000, 16], // 192.168.0.0/16
  [0xc6120000, 15], // 198.18.0.0/15
  [0xc6336400, 24], // 198.51.100.0/24
  [0xcb007100, 24], // 203.0.113.0/24
  [0xe0000000, 4],  // 224.0.0.0/4
  [0xf0000000, 4],  // 240.0.0.0/4
];

let resolverOverride = null;
let transportOverride = null;

class SafeFetchError extends Error {
  constructor(reason) {
    super('fetch failed');
    this.name = 'SafeFetchError';
    this.code = 'EFETCH';
    this.reason = reason;
  }
}

function assertTestOnly(name) {
  if (process.env.NODE_ENV !== 'test') {
    throw new Error(`${name} is only available when NODE_ENV=test`);
  }
}

function _setResolver(resolver) {
  assertTestOnly('_setResolver');
  resolverOverride = resolver || null;
}

function _setTransport(transport) {
  assertTestOnly('_setTransport');
  transportOverride = transport || null;
}

function logBlocked(reason, host) {
  const safe = String(host || '-')
    .replace(/[\r\n\t]/g, '')
    .slice(0, 253) || '-';
  console.warn(`[safe-fetch] blocked reason=${reason} host=${safe}`);
}

function prefixMask(bits) {
  if (bits <= 0) return 0;
  if (bits >= 32) return 0xffffffff;
  return (0xffffffff << (32 - bits)) >>> 0;
}

function inPrefix(ip, base, bits) {
  const mask = prefixMask(bits);
  return (ip & mask) === (base & mask);
}

function ipv4ToInt(ip) {
  const parts = String(ip).split('.');
  if (parts.length !== 4) return null;
  let n = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const octet = Number(part);
    if (octet > 255) return null;
    n = ((n * 256) + octet) >>> 0;
  }
  return n;
}

function ipv4BlockedInt(n) {
  if (n == null) return true;
  for (const [base, bits] of V4_PREFIXES) {
    if (inPrefix(n, base, bits)) return true;
  }
  return false;
}

function ipv4Blocked(ip) {
  return ipv4BlockedInt(ipv4ToInt(ip));
}

function stripZone(address) {
  const zone = String(address).indexOf('%');
  return zone === -1 ? String(address) : String(address).slice(0, zone);
}

// Expand an IPv6 address to eight 16-bit groups. Returns null when the text
// is not an IPv6 address. A dotted IPv4 tail is converted first.
function parseIpv6(address) {
  let text = stripZone(address).toLowerCase();
  if (text.includes('.')) {
    const colon = text.lastIndexOf(':');
    if (colon === -1) return null;
    const v4 = ipv4ToInt(text.slice(colon + 1));
    if (v4 == null) return null;
    const hi = ((v4 >>> 16) & 0xffff).toString(16);
    const lo = (v4 & 0xffff).toString(16);
    text = `${text.slice(0, colon + 1)}${hi}:${lo}`;
  }
  const halves = text.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  if (halves.length === 1 && head.length !== 8) return null;
  const missing = 8 - head.length - tail.length;
  if (missing < 0) return null;
  const groups = halves.length === 1
    ? head
    : [...head, ...Array(missing).fill('0'), ...tail];
  if (groups.length !== 8) return null;
  const nums = [];
  for (const group of groups) {
    if (!/^[0-9a-f]{1,4}$/.test(group)) return null;
    nums.push(parseInt(group, 16));
  }
  return nums;
}

function groupsToBytes(groups) {
  const bytes = [];
  for (const group of groups) {
    bytes.push((group >> 8) & 0xff, group & 0xff);
  }
  return bytes;
}

function bytesToIpv4(bytes) {
  return (bytes[0] * 16777216 + bytes[1] * 65536 + bytes[2] * 256 + bytes[3]) >>> 0;
}

// RFC 6052: pull the embedded IPv4 out of an NAT64 address. The "u" octet
// at bits 64–71 is skipped for prefix lengths below 96. Returns a uint32
// or null when the u octet is not zero.
function nat64Embedded(bytes, prefixLength) {
  const v4 = [];
  let bit = prefixLength;
  while (v4.length < 4) {
    if (bit >= 128) return null;
    if (bit >= 64 && bit < 72) {
      bit = 72;
      continue;
    }
    if (bit % 8 !== 0) return null;
    v4.push(bytes[bit / 8]);
    bit += 8;
  }
  if (prefixLength < 96 && bytes[8] !== 0) return null;
  return bytesToIpv4(v4);
}

function ipv6Blocked(address) {
  const groups = parseIpv6(address);
  if (!groups) return true;
  const [g0, g1, g2, g3, g4, g5, g6, g7] = groups;
  const bytes = groupsToBytes(groups);

  // :: and ::1
  if (groups.every(g => g === 0)) return true;
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0 && g6 === 0 && g7 === 1) {
    return true;
  }
  // fc00::/7 unique local, fe80::/10 link-local, ff00::/8 multicast
  if ((g0 & 0xfe00) === 0xfc00) return true;
  if ((g0 & 0xffc0) === 0xfe80) return true;
  if ((g0 & 0xff00) === 0xff00) return true;
  // 2001:db8::/32 documentation
  if (g0 === 0x2001 && g1 === 0x0db8) return true;
  // 64:ff9b::/96 well-known NAT64 prefix. Refused outright. The embedded
  // IPv4 sits in the last 32 bits; blocking the prefix covers it.
  if (g0 === 0x64 && g1 === 0xff9b && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0) return true;
  // Local-use NAT64 64:ff9b:1::/48. Check the RFC 6052 embedded IPv4.
  // A non-zero u octet is not a valid embedding; refuse that too.
  if (g0 === 0x64 && g1 === 0xff9b && g2 === 1) {
    const embedded = nat64Embedded(bytes, 48);
    if (embedded == null) return true;
    return ipv4BlockedInt(embedded);
  }
  // 6to4 2002::/16. The next 32 bits are an IPv4 address.
  if (g0 === 0x2002) {
    const embedded = ((g1 << 16) | g2) >>> 0;
    return ipv4BlockedInt(embedded);
  }
  // IPv4-mapped ::ffff:0:0/96. Allow it only when the embedded IPv4 is public.
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0xffff) {
    return ipv4BlockedInt(((g6 << 16) | g7) >>> 0);
  }
  // IPv4-translated ::ffff:0:0:0/96 (0:0:0:0:ffff:0:v4).
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0xffff && g5 === 0) {
    return ipv4BlockedInt(((g6 << 16) | g7) >>> 0);
  }
  // IPv4-compatible ::/96 (deprecated). :: and ::1 are already refused.
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0) {
    return ipv4BlockedInt(((g6 << 16) | g7) >>> 0);
  }
  return false;
}

function isBlockedAddress(address) {
  const bare = stripZone(String(address || '').trim());
  const family = net.isIP(bare);
  if (family === 4) return ipv4Blocked(bare);
  if (family === 6) return ipv6Blocked(bare);
  return true;
}

function bareHostname(url) {
  let host = url.hostname;
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);
  if (host.endsWith('.')) host = host.slice(0, -1);
  return host;
}

function isLocalHostname(name) {
  const host = String(name || '').toLowerCase();
  if (!host) return false;
  if (host === 'localhost' || host === 'localhost.localdomain') return true;
  if (host.endsWith('.localhost') || host.endsWith('.localhost.localdomain')) return true;
  if (host === 'ip6-localhost' || host === 'ip6-loopback') return true;
  return false;
}

function literalAddress(hostname) {
  let host = hostname;
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);
  host = stripZone(host);
  const family = net.isIP(host);
  if (!family) return null;
  return { address: host, family };
}

function emptyDns(err) {
  const code = err && err.code;
  return code === 'ENOTFOUND' || code === 'ENODATA' || code === 'ENOENT' || code === 'ENOTIMP';
}

function asAddressList(value) {
  const list = Array.isArray(value) ? value : [];
  const out = [];
  for (const item of list) {
    const address = String(item && item.address ? item.address : item).trim();
    if (address) out.push(address);
  }
  return out;
}

async function resolveAll(hostname) {
  const resolve4 = resolverOverride?.resolve4 || dns.promises.resolve4;
  const resolve6 = resolverOverride?.resolve6 || dns.promises.resolve6;
  const [v4, v6] = await Promise.all([
    Promise.resolve()
      .then(() => resolve4(hostname))
      .then(asAddressList, (err) => {
        if (emptyDns(err)) return [];
        throw new SafeFetchError('dns');
      }),
    Promise.resolve()
      .then(() => resolve6(hostname))
      .then(asAddressList, (err) => {
        if (emptyDns(err)) return [];
        throw new SafeFetchError('dns');
      }),
  ]);
  const records = [
    ...v4.map(address => ({ address, family: 4 })),
    ...v6.map(address => ({ address: stripZone(address), family: 6 })),
  ];
  if (!records.length) throw new SafeFetchError('dns');
  return records;
}

function hostHeader(url, bare, port) {
  const shown = url.hostname.startsWith('[') ? `[${bare}]` : bare;
  const defaultPort = url.protocol === 'https:' ? 443 : 80;
  if (port !== defaultPort) return `${shown}:${port}`;
  return shown;
}

// Parse and vet one URL. Throws SafeFetchError after a log line. Returns the
// address the socket must use.
async function vet(input) {
  let url;
  try {
    url = input instanceof URL ? input : new URL(input);
  } catch {
    logBlocked('scheme', '-');
    throw new SafeFetchError('scheme');
  }
  const hostForLog = () => {
    try { return bareHostname(url) || '-'; } catch { return '-'; }
  };
  if (url.username || url.password) {
    logBlocked('credentials', hostForLog());
    throw new SafeFetchError('credentials');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    logBlocked('scheme', hostForLog());
    throw new SafeFetchError('scheme');
  }
  const port = url.port === '' ? (url.protocol === 'https:' ? 443 : 80) : Number(url.port);
  if (!Number.isInteger(port) || (port !== 80 && port !== 443)) {
    logBlocked('port', hostForLog());
    throw new SafeFetchError('port');
  }
  const bare = bareHostname(url);
  if (!bare) {
    logBlocked('scheme', '-');
    throw new SafeFetchError('scheme');
  }
  if (isLocalHostname(bare)) {
    logBlocked('localhost', bare);
    throw new SafeFetchError('localhost');
  }
  const literal = literalAddress(url.hostname);
  const records = literal ? [literal] : await resolveAll(bare);
  for (const record of records) {
    if (isBlockedAddress(record.address)) {
      logBlocked('private-address', bare);
      throw new SafeFetchError('private-address');
    }
  }
  const chosen = records.find(record => record.family === 4) || records[0];
  url.hash = '';
  return { url, bare, port, address: chosen.address, family: chosen.family };
}

function pinnedLookup(address, family) {
  const record = { address, family };
  return function lookup(hostname, options, callback) {
    if (typeof options === 'function') {
      callback = options;
      options = {};
    }
    if (options && options.all) callback(null, [record]);
    else callback(null, address, family);
  };
}

function defaultTransport(options, callback) {
  const lib = options.protocol === 'https:' ? https : http;
  return lib.request(options, callback);
}

function lowerHeaders(headers) {
  const out = {};
  if (!headers) return out;
  for (const [key, value] of Object.entries(headers)) out[String(key).toLowerCase()] = value;
  return out;
}

function headerLocation(headers) {
  const value = headers.location;
  const raw = Array.isArray(value) ? value[0] : value;
  if (raw == null) return '';
  return String(raw).trim();
}

function contentLength(headers) {
  const raw = headers['content-length'];
  const text = Array.isArray(raw) ? raw[0] : raw;
  if (text == null || text === '') return null;
  if (!/^\d+$/.test(String(text).trim())) return null;
  const n = Number(text);
  return Number.isSafeInteger(n) ? n : null;
}

function headerValue(headers, name) {
  if (!headers) return '';
  const want = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (String(key).toLowerCase() === want) {
      return Array.isArray(value) ? value[0] : value;
    }
  }
  return '';
}

function readBody(res, maxBytes) {
  return new Promise((resolve, reject) => {
    const encoding = String(headerValue(res.headers, 'content-encoding') || 'identity')
      .split(',')[0]
      .trim()
      .toLowerCase();
    const capped = new PassThrough();
    let output = capped;
    let settled = false;
    const fail = (err) => {
      if (settled) return;
      settled = true;
      res.destroy();
      capped.destroy();
      if (output !== capped) output.destroy();
      reject(err instanceof SafeFetchError ? err : new SafeFetchError('encoding'));
    };
    const done = (body) => {
      if (settled) return;
      settled = true;
      resolve(body);
    };

    if (encoding === 'gzip' || encoding === 'x-gzip') output = capped.pipe(zlib.createGunzip());
    else if (encoding === 'deflate') output = capped.pipe(zlib.createInflate());
    else if (encoding !== 'identity' && encoding !== '') {
      fail(new SafeFetchError('encoding'));
      return;
    }

    // Count bytes on the socket and stop the source at the cap. Gzip and
    // deflate are decoded; the decoded body is capped too. Any other
    // encoding fails the fetch so compressed bytes are not treated as HTML.
    let raw = 0;
    res.on('data', (chunk) => {
      if (settled) return;
      raw += chunk.length;
      if (raw > maxBytes) {
        fail(new SafeFetchError('too-large'));
        return;
      }
      capped.write(chunk);
    });
    res.on('end', () => {
      if (!settled) capped.end();
    });
    res.on('error', fail);

    const chunks = [];
    let decoded = 0;
    output.on('data', (chunk) => {
      if (settled) return;
      decoded += chunk.length;
      if (decoded > maxBytes) {
        fail(new SafeFetchError('too-large'));
        return;
      }
      chunks.push(chunk);
    });
    output.on('end', () => done(Buffer.concat(chunks)));
    output.on('error', (err) => fail(err instanceof SafeFetchError ? err : new SafeFetchError('encoding')));
  });
}

function requestOnce({ target, headerBag, timeoutMs, maxBytes }) {
  const { url, bare, port, address, family } = target;
  const lookup = pinnedLookup(address, family);
  const lib = url.protocol === 'https:' ? https : http;
  const agent = new lib.Agent({ keepAlive: false, lookup });
  const headers = {
    ...headerBag,
    'Accept-Encoding': 'gzip, deflate, identity',
    Host: hostHeader(url, bare, port),
  };
  const options = {
    protocol: url.protocol,
    hostname: bare,
    port,
    method: 'GET',
    path: `${url.pathname || '/'}${url.search || ''}`,
    headers,
    agent,
    lookup,
  };
  if (url.protocol === 'https:' && net.isIP(bare) === 0) options.servername = bare;

  const transport = transportOverride || defaultTransport;
  return new Promise((resolve, reject) => {
    let settled = false;
    let req;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { agent.destroy(); } catch { /* already closed */ }
      fn(value);
    };
    const fail = (err) => {
      try { if (req) req.destroy(); } catch { /* already closed */ }
      finish(reject, err instanceof SafeFetchError ? err : err);
    };
    const timer = setTimeout(() => fail(new SafeFetchError('timeout')), timeoutMs);

    try {
      req = transport(options, (res) => {
        const responseHeaders = lowerHeaders(res.headers);
        const status = res.statusCode || 0;
        if (REDIRECT_STATUSES.has(status)) {
          res.destroy();
          finish(resolve, {
            status,
            headers: responseHeaders,
            body: Buffer.alloc(0),
            location: headerLocation(responseHeaders),
          });
          return;
        }
        const advertised = contentLength(responseHeaders);
        if (advertised != null && advertised > maxBytes) {
          res.destroy();
          finish(reject, new SafeFetchError('too-large'));
          return;
        }
        readBody(res, maxBytes).then(
          (body) => finish(resolve, { status, headers: responseHeaders, body, location: null }),
          (err) => fail(err),
        );
      });
    } catch (err) {
      fail(err);
      return;
    }
    if (!req || typeof req.end !== 'function') {
      fail(new SafeFetchError('dns'));
      return;
    }
    req.on('error', (err) => fail(err));
    req.on('timeout', () => fail(new SafeFetchError('timeout')));
    if (typeof req.setTimeout === 'function') req.setTimeout(timeoutMs);
    req.end();
  });
}

function publicHref(url) {
  const clean = new URL(url.href);
  clean.username = '';
  clean.password = '';
  clean.hash = '';
  return clean.href;
}

const DROPPED_HEADERS = new Set([
  'host', 'authorization', 'cookie', 'proxy-authorization', 'proxy-connection',
]);

function withDeadline(promise, ms) {
  if (ms <= 0) return Promise.reject(new SafeFetchError('timeout'));
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new SafeFetchError('timeout'));
    }, ms);
    promise.then(
      (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

async function safeFetch(input, options = {}) {
  const timeoutMs = options.timeoutMs == null ? DEFAULT_TIMEOUT_MS : options.timeoutMs;
  const maxBytes = options.maxBytes == null ? DEFAULT_MAX_BYTES : options.maxBytes;
  const maxRedirects = options.maxRedirects == null ? DEFAULT_MAX_REDIRECTS : options.maxRedirects;
  const headerBag = {};
  for (const [key, value] of Object.entries(options.headers || {})) {
    if (!DROPPED_HEADERS.has(String(key).toLowerCase())) headerBag[key] = value;
  }
  const deadline = Date.now() + timeoutMs;
  let current = input;

  for (let followed = 0; ; followed += 1) {
    const budget = deadline - Date.now();
    if (budget <= 0) throw new SafeFetchError('timeout');
    const target = await withDeadline(vet(current), budget);
    const response = await requestOnce({
      target,
      headerBag,
      timeoutMs: Math.max(1, deadline - Date.now()),
      maxBytes,
    });
    if (!REDIRECT_STATUSES.has(response.status)) {
      return {
        status: response.status,
        headers: response.headers,
        body: response.body,
        finalUrl: publicHref(target.url),
      };
    }
    if (followed >= maxRedirects) {
      logBlocked('redirects', target.bare);
      throw new SafeFetchError('redirects');
    }
    if (!response.location) {
      logBlocked('redirects', target.bare);
      throw new SafeFetchError('redirects');
    }
    let next;
    try {
      next = new URL(response.location, publicHref(target.url));
    } catch {
      logBlocked('scheme', target.bare);
      throw new SafeFetchError('scheme');
    }
    current = next;
  }
}

module.exports = {
  safeFetch,
  isBlockedAddress,
  SafeFetchError,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_REDIRECTS,
  _setResolver,
  _setTransport,
};
