// F-010 routes. Auth is the shared /api guard. The flag is read before any
// transaction. Flag off: the list is { enabled: false, items: [] } and the
// writes are 404 not_found. These handlers do not send mail.

const express = require('express');
const { callListEnabled } = require('../call-list/flag');
const { buildCallList } = require('../call-list/list');
const {
  parseProspectId,
  setMarker,
  excludeMarker,
  recordOutcome,
} = require('../call-list/outcomes');

function notFound(res) {
  res.set('Cache-Control', 'no-store');
  return res.status(404).json({ error: 'not_found' });
}

function fail(res, err) {
  const status = err && err.status;
  if (status === 404) return notFound(res);
  if (status === 400 || status === 409) {
    res.set('Cache-Control', 'no-store');
    return res.status(status).json({ error: err.code || 'invalid_body' });
  }
  const code = err && typeof err.code === 'string' ? err.code : 'error';
  console.error(`[call-list] ${code}`);
  res.set('Cache-Control', 'no-store');
  return res.status(500).json({ error: 'Something went wrong.' });
}

const todayRouter = express.Router();

todayRouter.get('/call-list', async (req, res) => {
  try {
    const enabled = await callListEnabled();
    if (!enabled) {
      res.set('Cache-Control', 'no-store');
      return res.json({ enabled: false, items: [] });
    }
    const all = req.query && req.query.all === '1';
    const body = await buildCallList({ all });
    res.set('Cache-Control', 'no-store');
    return res.json(body);
  } catch (err) {
    return fail(res, err);
  }
});

const prospectRouter = express.Router();

prospectRouter.put('/:id/call-list', async (req, res) => {
  try {
    const enabled = await callListEnabled();
    if (!enabled) return notFound(res);
    const id = parseProspectId(req.params.id);
    if (id == null) return notFound(res);
    const kind = req.body && req.body.kind;
    const body = await setMarker(id, kind);
    res.set('Cache-Control', 'no-store');
    return res.json(body);
  } catch (err) {
    return fail(res, err);
  }
});

prospectRouter.delete('/:id/call-list', async (req, res) => {
  try {
    const enabled = await callListEnabled();
    if (!enabled) return notFound(res);
    const id = parseProspectId(req.params.id);
    if (id == null) return notFound(res);
    const body = await excludeMarker(id);
    res.set('Cache-Control', 'no-store');
    return res.json(body);
  } catch (err) {
    return fail(res, err);
  }
});

prospectRouter.post('/:id/call-outcome', async (req, res) => {
  try {
    const enabled = await callListEnabled();
    if (!enabled) return notFound(res);
    const id = parseProspectId(req.params.id);
    if (id == null) return notFound(res);
    const body = await recordOutcome(id, req.body);
    res.set('Cache-Control', 'no-store');
    return res.json(body);
  } catch (err) {
    return fail(res, err);
  }
});

module.exports = { todayRouter, prospectRouter };
