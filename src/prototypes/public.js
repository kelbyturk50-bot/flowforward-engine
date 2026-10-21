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

module.exports = { router };
