// Revoke a prototype. Writes stay closed unless CRM_API_KEY has at least
// 32 non-whitespace characters (crmApiKeyReady, the pilot CSV rule).
// A short, blank, or missing key returns 503 and does not write, including
// when the outer API guard is open. When the key is strong enough, this
// router requires that key. Does not send mail.

const crypto = require('crypto');
const express = require('express');
const { crmApiKeyReady } = require('./crm-key');
const { revoke } = require('../prototypes/store');

const router = express.Router();

let writesDisabledWarned = false;

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

function stamp(res) {
  res.set('Cache-Control', 'no-store');
}

function gate(req, res, next) {
  if (!crmApiKeyReady()) {
    if (!writesDisabledWarned) {
      writesDisabledWarned = true;
      console.warn('[prototype] CRM_API_KEY must be at least 32 non-whitespace characters — prototype revoke stays off.');
    }
    stamp(res);
    return res.status(503).json({ error: 'writes_disabled' });
  }
  writesDisabledWarned = false;
  const secret = process.env.CRM_API_KEY;
  const sent = presentedKey(req);
  if (typeof secret === 'string' && sent && safeEqual(sent, secret)) return next();
  stamp(res);
  return res.status(401).json({ error: 'Missing or invalid API key' });
}

router.use(gate);

function prototypeId(req) {
  const raw = String(req.params.id || '');
  if (!/^\d+$/.test(raw)) return null;
  const id = Number(raw);
  return Number.isInteger(id) && id > 0 ? id : null;
}

router.post('/:id/revoke', async (req, res) => {
  const id = prototypeId(req);
  if (!id) return res.status(404).json({ error: 'not_found' });
  try {
    const row = await revoke(id);
    if (!row) return res.status(404).json({ error: 'not_found' });
    stamp(res);
    res.json({
      id: row.id,
      revoked_at: new Date(row.revoked_at).toISOString(),
    });
  } catch (err) {
    console.error('[prototype] revoke failed:', err && err.code);
    stamp(res);
    res.status(500).json({ error: 'Something went wrong.' });
  }
});

module.exports = router;
