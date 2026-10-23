// API-key guard for /api/*.
// Fail closed: crmApiKeyReady() trims CRM_API_KEY, drops every whitespace
// character, and requires at least 32 characters left. Unset, empty,
// whitespace-only, inner-space padded, or shorter than that returns 503
// { error: 'api_key_not_configured' } before the route handler. A ready key
// still requires x-api-key or Authorization: Bearer, compared in constant
// time. A missing or wrong header is 401. OPTIONS (CORS preflight) is not gated.
const crypto = require('crypto');
const { crmApiKeyReady } = require('./crm-key');

if (!crmApiKeyReady()) {
  console.warn('[auth] CRM_API_KEY is not ready — /api returns 503 api_key_not_configured.');
}

function safeEqual(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

function presentedKey(req) {
  const header = req.get('x-api-key');
  if (header) return header;
  return String(req.get('authorization') || '').replace(/^Bearer\s+/i, '');
}

module.exports = function requireApiKey(req, res, next) {
  if (req.method === 'OPTIONS') return next();
  if (!crmApiKeyReady()) {
    return res.status(503).json({ error: 'api_key_not_configured' });
  }
  const key = process.env.CRM_API_KEY;
  const sent = presentedKey(req);
  if (typeof key === 'string' && sent && safeEqual(sent, key)) return next();
  return res.status(401).json({ error: 'Missing or invalid API key' });
};
