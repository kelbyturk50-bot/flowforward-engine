// REST API routes for discovery run history + manual trigger
const express = require('express');
const router  = express.Router();
const pool    = require('../db/client');

// GET /api/runs — last 20 discovery runs
router.get('/', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT * FROM discovery_runs ORDER BY started_at DESC LIMIT 20`
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/runs/trigger — manually kick off a discovery run
router.post('/trigger', async (req, res) => {
  try {
    const { runDiscovery } = require('../bot/discover');
    // Fire-and-forget — don't await (could take minutes)
    runDiscovery().catch(err => console.error('[api] Discovery run error:', err.message));
    res.json({ ok: true, message: 'Discovery run started in background' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
