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

function clientIp(req) {
  const socketIp = cleanIp(req && (req.socket?.remoteAddress || req.connection?.remoteAddress));
  const hops = trustedHops(req);
  if (!hops) return socketIp || 'unknown';
  const chain = forwardedChain(req);
  if (!chain.length) return socketIp || 'unknown';
  // Trust-all: the original client is the left-most address.
  if (!Number.isFinite(hops)) return cleanIp(chain[0]) || socketIp || 'unknown';
  // One trusted hop (Railway): index is the right-most address.
  const index = chain.length - hops;
  const chosen = chain[index >= 0 ? index : 0];
  return cleanIp(chosen) || socketIp || 'unknown';
}

function consume(ip, bucket = 'demo') {
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

module.exports = { limits, clientIp, consume, _resetForTests };
