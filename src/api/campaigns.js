// Campaigns HTTP API. Slice 1 is one read route. Tracking only: this file
// does not import the mail transport. Auth is the /api mount. The flag gate
// is mounted before that so a closed flag matches an unknown route.

const express = require('express');
const { isFlagOn } = require('../campaigns/flags');
const { parseMetricsQuery, headlineMetrics } = require('../campaigns/metrics');

const router = express.Router();

function flagGate(req, res, next) {
  if (isFlagOn('FF_CAMPAIGNS')) return next();
  // Leave the app router. The default final handler writes the same 404 an
  // unknown path gets, including when the API key is missing.
  return next('router');
}

router.get('/metrics', async (req, res) => {
  let params;
  try {
    params = parseMetricsQuery(req.query);
  } catch (err) {
    if (err.status === 400) return res.status(400).json({ error: 'invalid_param' });
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
