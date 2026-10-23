// Exact browser origins for the public chat routers and GET /api/public/flags.
// This is not the global cors() middleware and it does not read CORS_ORIGINS.
// A missing or disallowed Origin gets no Access-Control-Allow-Origin.
// There is no Access-Control-Allow-Credentials and no `*`.
// Allowed preflights send Access-Control-Max-Age: 600.
// http://localhost:5173 is not allowlisted. Local dev uses the Vite proxy
// or a same-origin page.

// Production CRM hosts from web/src/api-base.js PRODUCTION_HOSTS.
// Compared with === only. https, no path, no port. No preview pattern.
const PRODUCTION_CRM_ORIGINS = Object.freeze([
  'https://flowforward-engine-six.vercel.app',
  'https://flowforward-engine-turk11.vercel.app',
  'https://flowforward-engine-git-main-turk11.vercel.app',
]);

const PREFLIGHT_MAX_AGE = '600';

const CHAT_PREFLIGHT = Object.freeze({
  methods: 'POST, OPTIONS',
  headers: 'Content-Type',
});

const FLAGS_PREFLIGHT = Object.freeze({
  methods: 'GET',
});

function originAllowed(origin) {
  if (typeof origin !== 'string') return false;
  // A header value cannot carry a control character or a newline.
  for (let i = 0; i < origin.length; i += 1) {
    const code = origin.charCodeAt(i);
    if (code <= 0x1f || code === 0x7f) return false;
  }
  for (let i = 0; i < PRODUCTION_CRM_ORIGINS.length; i += 1) {
    if (PRODUCTION_CRM_ORIGINS[i] === origin) return true;
  }
  return false;
}

function writeCors(res, origin, spec) {
  res.vary('Origin');
  if (!originAllowed(origin)) return false;
  res.set('Access-Control-Allow-Origin', origin);
  if (spec.methods) {
    res.set('Access-Control-Allow-Methods', spec.methods);
    res.set('Access-Control-Max-Age', PREFLIGHT_MAX_AGE);
  }
  if (spec.headers) res.set('Access-Control-Allow-Headers', spec.headers);
  return true;
}

// GET is echoed so a simple GET of /api/public/chat/demos is readable.
// Preflight allow-list stays POST, OPTIONS, and Content-Type.
function chatCors(req, res, next) {
  const origin = req.headers.origin;
  if (req.method === 'OPTIONS') {
    writeCors(res, origin, CHAT_PREFLIGHT);
    res.status(204).end();
    return;
  }
  if (req.method === 'GET' || req.method === 'POST') writeCors(res, origin, {});
  next();
}

function flagsCors(req, res, next) {
  const origin = req.headers.origin;
  if (req.method === 'OPTIONS') {
    writeCors(res, origin, FLAGS_PREFLIGHT);
    res.status(204).end();
    return;
  }
  if (req.method === 'GET') writeCors(res, origin, {});
  next();
}

module.exports = {
  PRODUCTION_CRM_ORIGINS,
  originAllowed,
  chatCors,
  flagsCors,
};
