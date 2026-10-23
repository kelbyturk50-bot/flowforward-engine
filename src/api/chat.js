// CRM facts and spend reads. Fail-closed by requireApiKey. The ceiling is
// read from the env and is not writable here.

const express = require('express');
const requireApiKey = require('./auth');
const { readCeiling } = require('../chatdemo/ceiling');
const { zoneDay, FLOWFORWARD_ZONE } = require('../chatdemo/copy');
const { listFacts, writeFact } = require('../chatdemo/facts-store');
const { readSpend } = require('../chatdemo/spend');

const router = express.Router();
const INVALID_BODY = Buffer.from('{"error":"invalid_body"}');

router.use(requireApiKey);

function invalidJson(err, req, res, next) {
  if (res.headersSent) return next(err);
  const url = req.originalUrl || '';
  const chat = url.startsWith('/api/chat')
    || url.startsWith('/api/public/chat')
    || url.startsWith('/api/public/prototypes/');
  const parseError = err && (
    err.type === 'entity.parse.failed'
    || (err instanceof SyntaxError && (err.status === 400 || err.statusCode === 400))
  );
  if (!chat || !parseError) return next(err);
  res.status(400);
  res.set('Content-Type', 'application/json; charset=utf-8');
  res.set('X-Content-Type-Options', 'nosniff');
  res.end(INVALID_BODY);
}

function sendError(res, error) {
  if (error === 'test_only') return res.status(422).json({ error: 'test_only' });
  if (error === 'not_found') return res.status(404).json({ error: 'not_found' });
  return res.status(400).json({ error: 'invalid_body' });
}

router.get('/facts', async (req, res) => {
  try {
    const result = await listFacts(req.query.prospect_id);
    if (result.error) return sendError(res, result.error);
    res.json({ facts: result.facts });
  } catch (err) {
    console.error(`[chat] facts read failed (${err && err.code ? err.code : 'error'})`);
    res.status(500).json({ error: 'server_error' });
  }
});

router.post('/facts', async (req, res) => {
  const body = req.body;
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return res.status(400).json({ error: 'invalid_body' });
  }
  try {
    const result = await writeFact({
      prospectId: body.prospect_id,
      field: body.field,
      value: body.value,
      source: body.source,
      sourceUrl: body.source_url,
      snippet: body.snippet,
      at: new Date(),
    });
    if (result.error) return sendError(res, result.error);
    res.status(201).json({ fact: result.fact });
  } catch (err) {
    console.error(`[chat] facts write failed (${err && err.code ? err.code : 'error'})`);
    res.status(500).json({ error: 'server_error' });
  }
});

router.get('/spend', async (req, res) => {
  try {
    const day = zoneDay(new Date(), FLOWFORWARD_ZONE);
    const spend = await readSpend(day);
    res.json({
      ceiling_micros: readCeiling(process.env),
      day,
      spent_micros: spend.spent_micros,
      reserved_micros: spend.reserved_micros,
      overshoot_micros: spend.overshoot_micros,
    });
  } catch (err) {
    console.error(`[chat] spend read failed (${err && err.code ? err.code : 'error'})`);
    res.status(500).json({ error: 'server_error' });
  }
});

module.exports = router;
module.exports.invalidJson = invalidJson;
