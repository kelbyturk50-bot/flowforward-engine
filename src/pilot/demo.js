// Public pilot routes. No API key: the unguessable token is the credential.
// There is no mint route here. Minting lives on the authenticated proposal
// API and, only when the proposal has not been revoked, on the one-pager render.
//
// Master flag off, or an unknown / expired / revoked / malformed token:
// the same 404. These handlers do not send mail or call Places, Anthropic,
// or Gmail.

const express = require('express');
const flags = require('./flags');
const { clientIp, consume } = require('./rate-limit');
const { resolveToken } = require('./tokens');
const { buildDemo } = require('./payload');
const { isEventType, recordEvent } = require('./events');
const pool = require('../db/client');

const router = express.Router();

function stamp(res) {
  res.set('X-Robots-Tag', 'noindex, nofollow');
  res.set('Cache-Control', 'no-store');
}

function sendJson(res, status, body) {
  stamp(res);
  res.status(status);
  return res.json(body);
}

function notFound(res) {
  return sendJson(res, 404, { error: 'Not found' });
}

function isDemoUrl(req) {
  const url = String((req && (req.originalUrl || req.url)) || '');
  return url === '/demo' || url.startsWith('/demo/');
}

// express.json rejects an oversized body before this router runs.
function payloadTooLarge(err, req, res, next) {
  const status = err && (err.status || err.statusCode);
  const tooLarge = status === 413 || (err && err.type === 'entity.too.large');
  if (!tooLarge || !isDemoUrl(req)) return next(err);
  return sendJson(res, 413, { error: 'Payload too large' });
}

router.use((req, res, next) => {
  const hit = consume(clientIp(req), 'demo');
  if (hit.limited) {
    res.set('Retry-After', String(hit.retryAfter));
    return sendJson(res, 429, { error: 'Too many requests' });
  }
  if (!flags.masterOn()) return notFound(res);
  next();
});

router.get('/:token', async (req, res) => {
  try {
    const tokenRow = await resolveToken(req.params.token);
    if (!tokenRow) return notFound(res);
    const { rows } = await pool.query(
      'SELECT company FROM prospects WHERE id = $1',
      [tokenRow.prospect_id]
    );
    sendJson(res, 200, buildDemo({ company: rows[0]?.company || '' }));
  } catch (err) {
    console.error('[pilot] demo read failed:', err.message);
    sendJson(res, 500, { error: 'Something went wrong.' });
  }
});

router.post('/:token/events', async (req, res) => {
  try {
    const tokenRow = await resolveToken(req.params.token);
    if (!tokenRow) return notFound(res);
    const eventType = req.body && req.body.type;
    if (!isEventType(eventType)) {
      return sendJson(res, 400, { error: 'Invalid event type' });
    }
    await recordEvent(tokenRow, eventType);
    sendJson(res, 201, { ok: true, type: eventType });
  } catch (err) {
    console.error('[pilot] demo event failed:', err.message);
    const status = err.status || 500;
    sendJson(res, status, { error: status === 400 ? 'Invalid event type' : 'Something went wrong.' });
  }
});

// No mint route. Anything else under this mount is the same 404.
router.use((req, res) => notFound(res));

module.exports = { router, payloadTooLarge };
