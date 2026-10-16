// Public pilot routes. No API key: the unguessable token is the credential.
// There is no mint route here. Minting lives on the authenticated proposal
// API and on the one-pager render.
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

function notFound(res) {
  stamp(res);
  return res.status(404).json({ error: 'Not found' });
}

router.use((req, res, next) => {
  stamp(res);
  const hit = consume(clientIp(req), 'demo');
  if (hit.limited) {
    res.set('Retry-After', String(hit.retryAfter));
    return res.status(429).json({ error: 'Too many requests' });
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
    stamp(res);
    res.json(buildDemo({ company: rows[0]?.company || '' }));
  } catch (err) {
    console.error('[pilot] demo read failed:', err.message);
    stamp(res);
    res.status(500).json({ error: 'Something went wrong.' });
  }
});

router.post('/:token/events', async (req, res) => {
  try {
    const tokenRow = await resolveToken(req.params.token);
    if (!tokenRow) return notFound(res);
    const eventType = req.body && req.body.type;
    if (!isEventType(eventType)) {
      stamp(res);
      return res.status(400).json({ error: 'Invalid event type' });
    }
    await recordEvent(tokenRow, eventType);
    stamp(res);
    res.status(201).json({ ok: true, type: eventType });
  } catch (err) {
    console.error('[pilot] demo event failed:', err.message);
    stamp(res);
    const status = err.status || 500;
    res.status(status).json({ error: status === 400 ? 'Invalid event type' : 'Something went wrong.' });
  }
});

// No mint route. Anything else under this mount is the same 404.
router.use((req, res) => notFound(res));

module.exports = { router };
