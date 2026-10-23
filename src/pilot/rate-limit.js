// In-memory per-IP limiter for the public pilot demo routes.
// The IP is a map key only. It is never written to the database or a log line.
//
// PILOT_DEMO_RATE_MAX (default 60) requests are allowed per
// PILOT_DEMO_RATE_WINDOW_MS (default 60000) for each IP and bucket.
//
// Railway is one reverse proxy, and server.js sets `trust proxy` to 1.
// That proxy appends the connecting client to X-Forwarded-For, so the
// right-most address is the client the trusted hop saw. A caller can prepend
// a spoof; the left-most address is not the rate-limit key. With trust proxy
// off, the header is ignored and the socket address is used.
// The key folds an IPv4-mapped ::ffff: address to IPv4 and groups IPv6 by /64.

const net = require('net');

const buckets = new Map();

function positiveInt(raw, fallback) {
  if (raw == null || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 1) return fallback;
  return Math.floor(n);
}

function limits() {
  return {
    max: positiveInt(process.env.PILOT_DEMO_RATE_MAX, 60),
    windowMs: positiveInt(process.env.PILOT_DEMO_RATE_WINDOW_MS, 60_000),
  };
}

function cleanIp(value) {
  const ip = String(value || '').trim();
  if (!ip) return '';
  return ip.slice(0, 128);
}

function forwardedChain(req) {
  const header = req && req.headers && req.headers['x-forwarded-for'];
  if (!header) return [];
  return String(header).split(',').map((part) => part.trim()).filter(Boolean);
}

// Hop count from `trust proxy`. A positive number N trusts N proxies in
// front of this process. Infinity means every hop is trusted (Express `true`).
function trustedHops(req) {
  const trust = req && req.app && typeof req.app.get === 'function'
    ? req.app.get('trust proxy')
    : 0;
  if (trust === true) return Infinity;
  if (typeof trust === 'number' && Number.isFinite(trust) && trust > 0) return Math.floor(trust);
  return 0;
}

function hextet(value) {
  if (!/^[0-9a-f]{1,4}$/.test(value)) return null;
  return parseInt(value, 16).toString(16);
}

function expandIPv6(ip) {
  const halves = ip.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':').filter((part) => part !== '') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':').filter((part) => part !== '') : [];
  if (halves.length === 1 && head.length !== 8) return null;
  const missing = 8 - head.length - tail.length;
  if (missing < 0) return null;
  const parts = halves.length === 1 ? head : [...head, ...Array(missing).fill('0'), ...tail];
  if (parts.length !== 8) return null;
  const parsed = parts.map(hextet);
  if (parsed.some((part) => part == null)) return null;
  return parsed;
}

function compress(parts) {
  let bestStart = -1;
  let bestLen = 0;
  let runStart = -1;
  for (let i = 0; i <= parts.length; i += 1) {
    if (i < parts.length && parts[i] === '0') {
      if (runStart < 0) runStart = i;
    } else if (runStart >= 0) {
      const len = i - runStart;
      if (len > bestLen) {
        bestStart = runStart;
        bestLen = len;
      }
      runStart = -1;
    }
  }
  if (bestLen < 2) return parts.join(':');
  const head = parts.slice(0, bestStart).join(':');
  const tail = parts.slice(bestStart + bestLen).join(':');
  return `${head}::${tail}`;
}

// Rate-limit key. Fold IPv4-mapped ::ffff: to IPv4. Key IPv6 by /64.
// A value this function already returned (/64 suffix) comes back unchanged.
// Chat's bucketIp delegates here so the two layers do not disagree.
function bucketAddress(ip) {
  let value = String(ip || '').trim().toLowerCase();
  if (!value) return 'unknown';
  if (value.endsWith('/64')) {
    const base = value.slice(0, -3);
    if (net.isIP(base) === 6) value = base;
  }
  if (value.startsWith('::ffff:')) {
    const mapped = value.slice('::ffff:'.length);
    if (net.isIP(mapped) === 4) return mapped;
  }
  if (net.isIP(value) === 4) return value;
  if (net.isIP(value) !== 6) return 'unknown';
  const parts = expandIPv6(value);
  if (!parts) return 'unknown';
  const prefix = parts.slice(0, 4).concat(['0', '0', '0', '0']);
  return `${compress(prefix)}/64`;
}

function clientIp(req) {
  const socketIp = cleanIp(req && (req.socket?.remoteAddress || req.connection?.remoteAddress));
  const hops = trustedHops(req);
  let raw;
  if (!hops) raw = socketIp || 'unknown';
  else {
    const chain = forwardedChain(req);
    if (!chain.length) raw = socketIp || 'unknown';
    // Trust-all: the original client is the left-most address.
    else if (!Number.isFinite(hops)) raw = cleanIp(chain[0]) || socketIp || 'unknown';
    else {
      // One trusted hop (Railway): index is the right-most address.
      const index = chain.length - hops;
      const chosen = chain[index >= 0 ? index : 0];
      raw = cleanIp(chosen) || socketIp || 'unknown';
    }
  }
  return bucketAddress(raw);
}

function consumeFixed(ip, bucket, options) {
  const max = options.max;
  const bucketKey = String(options.bucketKey || '');
  const readClock = typeof options.clock === 'function' ? options.clock : Date.now;
  const now = readClock();
  const key = `${bucket}\n${ip || 'unknown'}\n${bucketKey}`;
  let entry = buckets.get(key);
  if (!entry || entry.bucketKey !== bucketKey) {
    entry = { count: 0, bucketKey };
    buckets.set(key, entry);
  }
  entry.count += 1;
  if (entry.count > max) return { limited: true, retryAfter: 1 };
  return { limited: false, retryAfter: 0 };
}

function consume(ip, bucket = 'demo', options) {
  if (options && options.fixed === true) return consumeFixed(ip, bucket, options);
  const { max, windowMs } = limits();
  const now = Date.now();
  const key = `${bucket}\n${ip || 'unknown'}`;
  let entry = buckets.get(key);
  if (!entry || now >= entry.resetAt) {
    entry = { count: 0, resetAt: now + windowMs };
    buckets.set(key, entry);
  }
  entry.count += 1;
  if (buckets.size > 5000) {
    for (const [k, v] of buckets) {
      if (now >= v.resetAt) buckets.delete(k);
    }
  }
  if (entry.count > max) {
    return {
      limited: true,
      retryAfter: Math.max(1, Math.ceil((entry.resetAt - now) / 1000)),
    };
  }
  return { limited: false, retryAfter: 0 };
}

function _resetForTests() {
  if (process.env.NODE_ENV !== 'test') {
    throw new Error('_resetForTests is only available when NODE_ENV=test');
  }
  buckets.clear();
}

module.exports = { limits, clientIp, bucketAddress, consume, _resetForTests };
