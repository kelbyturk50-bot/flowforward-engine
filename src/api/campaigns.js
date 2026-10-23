// Campaigns HTTP API, slice 1: two read routes. Tracking only: this file
// does not import the mail transport.
//
// Order, from the outside in (flagGate is mounted in server.js before the
// shared /api API-key middleware):
//   1. CRM_API_KEY not ready (crmApiKeyReady: fewer than 32 non-whitespace
//      characters, or unset) -> 503 { error: 'api_key_not_configured' },
//      whether or not the flag is on. The routes never serve data.
//   2. FF_CAMPAIGNS effectively off (flag service, src/campaigns/flags.js)
//      -> the same 404 Express gives an unknown path, with or without a
//      request key. This runs only after the key is ready.
//   3. requireApiKey -> 401 for a missing or wrong key.

const express = require('express');
const { crmApiKeyReady } = require('./crm-key');
const { isFlagOn } = require('../campaigns/flags');
const {
  parseMetricsQuery,
  parseListQuery,
  headlineMetrics,
  campaignList,
} = require('../campaigns/metrics');

const router = express.Router();

async function flagGate(req, res, next) {
  if (req.method === 'OPTIONS') return next();
  if (!crmApiKeyReady()) {
    console.log('[campaigns] refused; api key not configured');
    res.set('Cache-Control', 'no-store');
    return res.status(503).json({ error: 'api_key_not_configured' });
  }
  let on = false;
  try {
    on = await isFlagOn('FF_CAMPAIGNS');
  } catch (err) {
    console.error(`[campaigns] flag read failed (${err && err.code ? err.code : 'error'})`);
    on = false;
  }
  // Leave the app router. The default final handler writes the same 404 an
  // unknown path gets, including when the request key is missing.
  if (!on) return next('router');
  return next();
}

function badParam(err, res) {
  if (err && err.status === 400) {
    res.status(400).json({ error: 'invalid_param' });
    return true;
  }
  return false;
}

router.get('/', async (req, res) => {
  let params;
  try {
    params = parseListQuery(req.query);
  } catch (err) {
    if (badParam(err, res)) return;
    throw err;
  }
  try {
    const body = await campaignList(params);
    console.log(`[campaigns] list campaigns=${body.campaigns.length} from=${body.range.from || '-'} to=${body.range.to || '-'}`);
    res.json(body);
  } catch (err) {
    console.error(`[campaigns] list failed: ${err.code || 'error'}`);
    res.status(500).json({ error: 'list_failed' });
  }
});

router.get('/metrics', async (req, res) => {
  let params;
  try {
    params = parseMetricsQuery(req.query);
  } catch (err) {
    if (badParam(err, res)) return;
    throw err;
  }
  try {
    const body = await headlineMetrics(params);
    console.log(
      `[campaigns] metrics touched=${body.touched}`
      + ` responded=${body.responded.count}/${body.responded.n}`
      + ` converted=${body.converted.count}/${body.converted.n}`
      + ` opened_no_response=${body.opened_no_response.count}/${body.opened_no_response.n}`
      + ` include_machine_opens=${body.include_machine_opens}`
    );
    res.json(body);
  } catch (err) {
    console.error(`[campaigns] metrics failed: ${err.code || 'error'}`);
    res.status(500).json({ error: 'metrics_failed' });
  }
});

module.exports = { router, flagGate };
