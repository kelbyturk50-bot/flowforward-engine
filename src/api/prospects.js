// REST API routes for prospects
const express = require('express');
const router  = express.Router();
const pool    = require('../db/client');

// GET /api/prospects — list all, optional ?stage= or ?industry= filter
router.get('/', async (req, res) => {
  try {
    const { stage, industry, limit = 500 } = req.query;
    let query = 'SELECT * FROM prospects WHERE 1=1';
    const params = [];

    if (stage) {
      params.push(stage);
      query += ` AND stage = $${params.length}`;
    }
    if (industry) {
      params.push(industry);
      query += ` AND industry = $${params.length}`;
    }

    params.push(parseInt(limit, 10));
    query += ` ORDER BY discovered_at DESC LIMIT $${params.length}`;

    const result = await pool.query(query, params);
    res.json({ prospects: result.rows, total: result.rowCount });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/prospects/stats — counts by stage
router.get('/stats', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        COUNT(*) FILTER (WHERE TRUE)                              AS total,
        COUNT(*) FILTER (WHERE stage = 'found')                  AS found,
        COUNT(*) FILTER (WHERE stage = 'contacted')              AS contacted,
        COUNT(*) FILTER (WHERE stage = 'responded')              AS responded,
        COUNT(*) FILTER (WHERE stage = 'vetted')                 AS vetted,
        COUNT(*) FILTER (WHERE stage = 'brief')                  AS brief_ready,
        COUNT(*) FILTER (WHERE industry = 'HVAC')                AS hvac,
        COUNT(*) FILTER (WHERE industry = 'Roofing')             AS roofing,
        COUNT(*) FILTER (WHERE industry = 'Landscaping')         AS landscaping,
        COUNT(*) FILTER (WHERE industry = 'Plumbing')            AS plumbing,
        COUNT(*) FILTER (WHERE industry = 'Pest Control')        AS pest_control,
        COUNT(*) FILTER (WHERE discovered_at > NOW() - INTERVAL '24 hours') AS last_24h,
        COUNT(*) FILTER (WHERE discovered_at > NOW() - INTERVAL '7 days')   AS last_7d
      FROM prospects
    `);
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/prospects/:id
router.get('/:id', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM prospects WHERE id = $1', [req.params.id]);
    if (!result.rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/prospects/:id — update stage, score, note, brief, outreach_draft
router.patch('/:id', async (req, res) => {
  const allowed = ['stage', 'score', 'note', 'brief', 'outreach_draft'];
  const updates = Object.entries(req.body).filter(([k]) => allowed.includes(k));
  if (!updates.length) return res.status(400).json({ error: 'No valid fields' });

  const sets   = updates.map(([k], i) => `${k} = $${i + 2}`).join(', ');
  const values = [req.params.id, ...updates.map(([, v]) => v)];

  try {
    const result = await pool.query(
      `UPDATE prospects SET ${sets} WHERE id = $1 RETURNING *`,
      values
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/prospects/:id
router.delete('/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM prospects WHERE id = $1', [req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
