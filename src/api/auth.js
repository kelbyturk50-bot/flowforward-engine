// API-key guard for /api/*.
// Set CRM_API_KEY in Railway Variables; clients send it as the `x-api-key` header.
// If CRM_API_KEY is unset the API stays open (with a loud warning) so existing
// deployments keep working until the key is configured.
const crypto = require('crypto');

const KEY = process.env.CRM_API_KEY || '';
if (!KEY) console.warn('[auth] ⚠ CRM_API_KEY is not set — /api is open to anyone with the URL.');

function safeEqual(a, b) {
  const ab = Buffer.from(String(a)); const bb = Buffer.from(String(b));
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

module.exports = function requireApiKey(req, res, next) {
  if (!KEY || req.method === 'OPTIONS') return next();
  const sent = req.get('x-api-key') || (req.get('authorization') || '').replace(/^Bearer\s+/i, '');
  if (sent && safeEqual(sent, KEY)) return next();
  res.status(401).json({ error: 'Missing or invalid API key' });
};
