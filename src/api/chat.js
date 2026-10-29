// CRM facts and spend reads. Fail-closed by requireApiKey. The ceiling is
// read from the env and is not writable here.

const express = require('express');
const requireApiKey = require('./auth');
const { readCeiling } = require('../chatdemo/ceiling');
const { zoneDay, FLOWFORWARD_ZONE } = require('../chatdemo/copy');
const { listFacts, writeFact, buildFacts, approveFacts, deleteFact } = require('../chatdemo/facts-store');
const { readSpend } = require('../chatdemo/spend');
const { VOICE_CAPS, voiceConfig } = require('../voicedemo/config');
const { AGENT_PROMPT, AGENT_SETTINGS } = require('../voicedemo/agent-prompt');
const voiceStore = require('../voicedemo/store');
const proposalConfig = require('../proposals/config');

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
  if (error === 'not_found') return res.status(404).json({ error: 'not_found' });
  if (error === 'no_research') return res.status(409).json({ error: 'no_research' });
  if (error === 'archived') return res.status(409).json({ error: 'archived' });
  return res.status(400).json({ error: 'invalid_body' });
}

function objectBody(req) {
  const body = req.body;
  return body && typeof body === 'object' && !Array.isArray(body) ? body : null;
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

// Read the research the proposal bot already cached and propose facts.
// No fetch and no model call. Proposed facts wait for approval.
router.post('/facts/build', async (req, res) => {
  const body = objectBody(req);
  if (!body) return res.status(400).json({ error: 'invalid_body' });
  try {
    const result = await buildFacts(body.prospect_id);
    if (result.error) return sendError(res, result.error);
    res.json({ facts: result.facts, proposed: result.proposed });
  } catch (err) {
    console.error(`[chat] facts build failed (${err && err.code ? err.code : 'error'})`);
    res.status(500).json({ error: 'server_error' });
  }
});

// { prospect_id, fields? } approves the listed proposed facts, or all of them.
router.post('/facts/approve', async (req, res) => {
  const body = objectBody(req);
  if (!body) return res.status(400).json({ error: 'invalid_body' });
  if (body.fields !== undefined && body.fields !== null && !Array.isArray(body.fields)) {
    return res.status(400).json({ error: 'invalid_body' });
  }
  try {
    const result = await approveFacts(body.prospect_id, body.fields ?? null);
    if (result.error) return sendError(res, result.error);
    res.json({ facts: result.facts, approved: result.approved });
  } catch (err) {
    console.error(`[chat] facts approve failed (${err && err.code ? err.code : 'error'})`);
    res.status(500).json({ error: 'server_error' });
  }
});

router.delete('/facts', async (req, res) => {
  try {
    const result = await deleteFact(req.query.prospect_id, req.query.field);
    if (result.error) return sendError(res, result.error);
    res.json({ facts: result.facts });
  } catch (err) {
    console.error(`[chat] facts delete failed (${err && err.code ? err.code : 'error'})`);
    res.status(500).json({ error: 'server_error' });
  }
});

// Voice receptionist status for the CRM: whether calls are on (env only),
// today's minutes, and what to paste into Retell. Never returns the key or
// the agent id.
router.get('/voice', async (req, res) => {
  try {
    const config = voiceConfig();
    const today = await voiceStore.dayUsage(new Date());
    res.json({
      configured: Boolean(config),
      daily_minutes: config ? config.dailyMinutes : null,
      max_call_seconds: VOICE_CAPS.maxCallSeconds,
      calls_per_link: VOICE_CAPS.callsPerLink,
      seconds_per_link: VOICE_CAPS.secondsPerLink,
      today,
      webhook_url: `${String(proposalConfig.PUBLIC_BASE_URL || '').replace(/\/+$/, '')}${AGENT_SETTINGS.webhook_path}`,
      prompt: AGENT_PROMPT,
    });
  } catch (err) {
    console.error(`[chat] voice read failed (${err && err.code ? err.code : 'error'})`);
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
