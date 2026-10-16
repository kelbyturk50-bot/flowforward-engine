// REST API routes for prospects (leads)
const express = require('express');
const router  = express.Router();
const pool    = require('../db/client');
const { rescore } = require('../scoring/fit');
const { normalizeIndustry } = require('../scoring/industry');

// Public writes must already be text. Do not coerce objects, arrays, or numbers.
// Length is checked after trim. Control characters, including bidi marks, are rejected.
const INDUSTRY_MAX = 80;
const INDUSTRY_CONTROL = /[\u0000-\u001F\u007F-\u009F\u200E\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/;

function industryIsValid(value) {
  if (typeof value !== 'string') return false;
  const trimmed = value.trim();
  if (trimmed.length < 1 || trimmed.length > INDUSTRY_MAX) return false;
  return !INDUSTRY_CONTROL.test(trimmed);
}

const STAGES = ['found', 'contacted', 'responded', 'qualified', 'proposal', 'won', 'lost', 'disqualified'];
const CLOSED = ['won', 'lost', 'disqualified'];
const { buildProspectListQuery, ProspectQueryError } = require('./prospect-query');

// GET /api/prospects
//   ?stage= (comma list | open | closed) &industry= &city= &tier= (comma list)
//   &q= (company search) &min_fit= &min_value= &has_website=1
//   &sort=fit|recent|rating|reviews|revenue|next_action|company|updated
//   &limit= (default 200, max 1000) &offset=
// Unknown sort (including constructor / toString / __proto__) and invalid
// min_value return 400 { error: 'bad_request' }. A missing sort defaults to fit.
// min_value filters with est_value >= $n, so NULL estimates are excluded.
// min_value=0 is accepted and still excludes those NULL rows.
router.get('/', async (req, res) => {
  try {
    const q = buildProspectListQuery(req.query);
    const [rows, count] = await Promise.all([
      pool.query(q.listSql, q.params),
      pool.query(q.countSql, q.params),
    ]);
    res.json({ prospects: rows.rows, total: count.rows[0].n, limit: q.limit, offset: q.offset });
  } catch (err) {
    if (err instanceof ProspectQueryError) return res.status(400).json({ error: 'bad_request' });
    console.error('[prospects] list failed:', err.message);
    res.status(500).json({ error: 'server_error' });
  }
});

// GET /api/prospects/stats — counts by stage, tier, industry, recency
router.get('/stats', async (req, res) => {
  try {
    const [byStage, byTier, byIndustry, totals] = await Promise.all([
      pool.query(`SELECT stage, COUNT(*)::int AS n, COALESCE(SUM(est_value),0)::float AS value FROM prospects WHERE archived_at IS NULL GROUP BY stage`),
      pool.query(`SELECT fit_tier AS tier, COUNT(*)::int AS n FROM prospects WHERE stage <> ALL($1) AND archived_at IS NULL GROUP BY fit_tier`, [CLOSED]),
      pool.query(`SELECT industry, COUNT(*)::int AS n, ROUND(AVG(fit_score))::int AS avg_fit FROM prospects WHERE archived_at IS NULL GROUP BY industry ORDER BY n DESC`),
      pool.query(`SELECT COUNT(*)::int AS total,
                         COUNT(*) FILTER (WHERE discovered_at > NOW() - INTERVAL '24 hours')::int AS last_24h,
                         COUNT(*) FILTER (WHERE discovered_at > NOW() - INTERVAL '7 days')::int  AS last_7d
                    FROM prospects WHERE archived_at IS NULL`),
    ]);
    res.json({
      ...totals.rows[0],
      stages: Object.fromEntries(byStage.rows.map(r => [r.stage, { count: r.n, value: r.value }])),
      tiers: Object.fromEntries(byTier.rows.map(r => [r.tier || 'unscored', r.n])),
      industries: byIndustry.rows,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/prospects/meta — filter options
router.get('/meta', async (req, res) => {
  try {
    const [ind, city] = await Promise.all([
      pool.query(`SELECT DISTINCT industry FROM prospects WHERE industry IS NOT NULL ORDER BY industry`),
      pool.query(`SELECT city, COUNT(*)::int AS n FROM prospects WHERE city <> '' GROUP BY city ORDER BY n DESC`),
    ]);
    res.json({ stages: STAGES, industries: ind.rows.map(r => r.industry), cities: city.rows.map(r => r.city) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/prospects/rescore — recompute fit scores for every lead
router.post('/rescore', async (req, res) => {
  try {
    const n = await rescore();
    res.json({ ok: true, rescored: n });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/prospects — add a lead by hand (referral, walk-in, etc.)
router.post('/', async (req, res) => {
  const b = req.body || {};
  if (!industryIsValid(b.industry)) return res.status(400).json({ error: 'invalid industry' });
  const industry = normalizeIndustry(b.industry);
  if (!b.company || !industry) return res.status(400).json({ error: 'company and industry are required' });
  try {
    const { rows } = await pool.query(
      `INSERT INTO prospects (company, industry, phone, website, email, contact_name, address, city, state, zip,
                              rating, review_count, note, source, stage, est_value, fit_boost)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'manual',$14,$15,$16) RETURNING id`,
      [b.company, industry, b.phone || null, b.website || null, b.email || null, b.contact_name || null,
       b.address || null, b.city || null, b.state || 'UT', b.zip || null, b.rating || null, b.review_count || 0,
       b.note || null, STAGES.includes(b.stage) ? b.stage : 'found', b.est_value || null, b.fit_boost || 0]
    );
    await rescore([rows[0].id]);
    const full = await pool.query('SELECT * FROM prospects WHERE id = $1', [rows[0].id]);
    res.status(201).json(full.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/prospects/:id — lead with activity log and linked projects
router.get('/:id', async (req, res) => {
  try {
    const [p, acts, projs] = await Promise.all([
      pool.query('SELECT * FROM prospects WHERE id = $1', [req.params.id]),
      pool.query('SELECT * FROM prospect_activities WHERE prospect_id = $1 ORDER BY created_at DESC LIMIT 100', [req.params.id]),
      pool.query('SELECT id, name, status, due_date FROM projects WHERE prospect_id = $1 ORDER BY created_at DESC', [req.params.id]),
    ]);
    if (!p.rows.length) return res.status(404).json({ error: 'Not found' });
    res.json({ ...p.rows[0], activities: acts.rows, projects: projs.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/prospects/:id
const EDITABLE = ['stage', 'score', 'note', 'brief', 'outreach_draft', 'contact_name', 'email', 'phone', 'website',
  'next_action', 'next_action_at', 'last_contacted_at', 'est_value', 'fit_boost', 'industry', 'city'];
const RESCORE_FIELDS = ['fit_boost', 'industry', 'city', 'phone', 'website'];

router.patch('/:id', async (req, res) => {
  const body = { ...req.body };
  if (Object.prototype.hasOwnProperty.call(body, 'industry')) {
    if (!industryIsValid(body.industry)) return res.status(400).json({ error: 'invalid industry' });
    body.industry = normalizeIndustry(body.industry);
  }
  if (body.stage && !STAGES.includes(body.stage)) return res.status(400).json({ error: `stage must be one of ${STAGES.join(', ')}` });
  for (const k of ['next_action_at', 'est_value', 'email', 'contact_name', 'website', 'phone']) if (body[k] === '') body[k] = null;
  if (body.fit_boost != null) body.fit_boost = Math.max(-20, Math.min(20, parseInt(body.fit_boost, 10) || 0));

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const before = await client.query('SELECT stage FROM prospects WHERE id = $1 FOR UPDATE', [req.params.id]);
    if (!before.rows.length) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Not found' }); }
    const prevStage = before.rows[0].stage;

    // Moving to "contacted" stamps last_contacted_at unless provided
    if (body.stage === 'contacted' && prevStage !== 'contacted' && body.last_contacted_at === undefined) {
      body.last_contacted_at = new Date().toISOString();
    }

    const updates = Object.entries(body).filter(([k]) => EDITABLE.includes(k));
    if (!updates.length) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'No valid fields' }); }
    const sets = updates.map(([k], i) => `${k} = $${i + 2}`).join(', ');
    await client.query(`UPDATE prospects SET ${sets} WHERE id = $1`, [req.params.id, ...updates.map(([, v]) => v)]);

    if (body.stage && body.stage !== prevStage) {
      await client.query(
        `INSERT INTO prospect_activities (prospect_id, type, body) VALUES ($1, 'stage_change', $2)`,
        [req.params.id, `${prevStage} → ${body.stage}`]
      );
    }
    await client.query('COMMIT');

    if (updates.some(([k]) => RESCORE_FIELDS.includes(k))) await rescore([parseInt(req.params.id, 10)]);
    const { rows } = await pool.query('SELECT * FROM prospects WHERE id = $1', [req.params.id]);
    res.json(rows[0]);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// POST /api/prospects/:id/activities — log a call, email, meeting or note
router.post('/:id/activities', async (req, res) => {
  const type = ['note', 'call', 'email', 'meeting'].includes(req.body?.type) ? req.body.type : 'note';
  const body = (req.body?.body || '').trim();
  if (!body) return res.status(400).json({ error: 'body is required' });
  try {
    const { rows } = await pool.query(
      `INSERT INTO prospect_activities (prospect_id, type, body) VALUES ($1, $2, $3) RETURNING *`,
      [req.params.id, type, body]
    );
    if (type !== 'note') {
      await pool.query(`UPDATE prospects SET last_contacted_at = NOW() WHERE id = $1`, [req.params.id]);
    }
    res.status(201).json(rows[0]);
  } catch (err) {
    if (err.code === '23503') return res.status(404).json({ error: 'Prospect not found' });
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/prospects/:id/activities/:activityId
router.delete('/:id/activities/:activityId', async (req, res) => {
  try {
    await pool.query('DELETE FROM prospect_activities WHERE id = $1 AND prospect_id = $2', [req.params.activityId, req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/prospects/:id/convert — mark won and open a linked project
router.post('/:id/convert', async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const p = await client.query('SELECT * FROM prospects WHERE id = $1 FOR UPDATE', [req.params.id]);
    if (!p.rows.length) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Not found' }); }
    const lead = p.rows[0];
    const name = req.body?.name || `${lead.company} — automation build`;
    const proj = await client.query(
      `INSERT INTO projects (name, prospect_id, status, value, start_date, description)
       VALUES ($1, $2, 'planning', $3, CURRENT_DATE, $4) RETURNING *`,
      [name, lead.id, req.body?.value ?? lead.est_value, req.body?.description || lead.brief || null]
    );
    if (lead.stage !== 'won') {
      await client.query(`UPDATE prospects SET stage = 'won' WHERE id = $1`, [lead.id]);
      await client.query(`INSERT INTO prospect_activities (prospect_id, type, body) VALUES ($1, 'stage_change', $2)`,
        [lead.id, `${lead.stage} → won (project #${proj.rows[0].id} created)`]);
    }
    await client.query('COMMIT');
    res.status(201).json(proj.rows[0]);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
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
module.exports.STAGES = STAGES;
module.exports.CLOSED = CLOSED;
