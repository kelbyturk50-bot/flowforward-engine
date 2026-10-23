// Public prototype read. No API key: the unguessable token is the credential.
// The limiter uses the prototype bucket (same max and window as the pilot
// demo, separate counters). watermark is fixed in the payload. This router
// does not read a query string or FF_HIDE_WATERMARK.

const express = require('express');
const { clientIp, consume } = require('../pilot/rate-limit');
const { readByToken } = require('./store');

const router = express.Router();

function stamp(res) {
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('X-Robots-Tag', 'noindex, nofollow');
  res.set('Cache-Control', 'no-store');
}

// First. Mounted in server.js before the 1 MB parser, so a large JSON body
// on this route is a stamped 413 and never reaches that parser.
router.use(express.json({ limit: '2kb' }));

router.use((req, res, next) => {
  const hit = consume(clientIp(req), 'prototype');
  if (hit.limited) {
    res.set('Retry-After', String(hit.retryAfter));
    stamp(res);
    return res.status(429).json({ error: 'Too many requests' });
  }
  next();
});

router.get('/:token', async (req, res) => {
  try {
    const result = await readByToken(req.params.token);
    stamp(res);
    res.status(result.status).json(result.body);
  } catch (err) {
    console.error('[prototype] public read failed:', err && err.code);
    stamp(res);
    res.status(500).json({ error: 'Something went wrong.' });
  }
});

router.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  const status = err && (err.status || err.statusCode);
  const tooLarge = status === 413 || (err && err.type === 'entity.too.large');
  if (tooLarge) {
    stamp(res);
    return res.status(413).json({ error: 'Payload too large' });
  }
  const parseError = err && (
    err.type === 'entity.parse.failed'
    || (err instanceof SyntaxError && (status === 400))
  );
  if (!parseError) return next(err);
  // Same JSON body as the chat invalid_body contract. Stamp this route.
  stamp(res);
  return res.status(400).json({ error: 'invalid_body' });
});

// Last. An unmatched path or method ends here, so it never reaches cors().
router.use((req, res) => {
  stamp(res);
  if (req.method !== 'GET') {
    res.set('Allow', 'GET');
    return res.status(405).json({ error: 'method_not_allowed' });
  }
  return res.status(404).json({ error: 'not_found' });
});

module.exports = { router };
