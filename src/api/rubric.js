// Rubric lookup. Reads the seeded table and the prospect cache.
// Does not fetch, and does not return review text or contact fields.

const express = require('express');
const router = express.Router();
const pool = require('../db/client');
const { loadRubric } = require('../scoring/rubric-store');
const { recommendPrototypes } = require('../scoring/prototypes');

router.get('/', async (req, res) => {
  try {
    const rubric = await loadRubric(pool);
    res.json({
      version: rubric.version,
      spec: rubric.spec,
      minScore: rubric.minScore,
      maxPicks: rubric.maxPicks,
      neverAutoPick: rubric.neverAutoPick,
      serviceTitanAllow: rubric.serviceTitanAllow,
      rows: rubric.rows,
    });
  } catch (err) {
    console.error('[rubric] list failed:', err.message);
    res.status(500).json({ error: 'server_error' });
  }
});

router.post('/lookup', async (req, res) => {
  const id = req.body && req.body.prospectId;
  if (typeof id !== 'number' || !Number.isInteger(id) || id < 1 || id > 2147483647) {
    return res.status(400).json({ error: 'bad_request' });
  }
  try {
    const found = await pool.query(
      `SELECT id, company, industry, website, state, rating, review_count, fsm_detected, research
         FROM prospects WHERE id = $1`,
      [id]
    );
    if (!found.rows[0]) return res.status(404).json({ error: 'not_found' });
    const rubric = await loadRubric(pool);
    const result = recommendPrototypes(found.rows[0], rubric);
    res.json({
      prospectId: id,
      recommended: result.picks[0] || null,
      picks: result.picks,
      disqualified: result.disqualified,
    });
  } catch (err) {
    console.error('[rubric] lookup failed:', err.message);
    res.status(500).json({ error: 'server_error' });
  }
});

module.exports = router;
