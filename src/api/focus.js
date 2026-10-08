// GET /api/focus — "what should I work on today?"
// Surfaces the leads and project work that need attention right now.
const express = require('express');
const router  = express.Router();
const pool    = require('../db/client');
const { CLOSED } = require('./prospects');

router.get('/', async (req, res) => {
  const today = req.query.today || null; // YYYY-MM-DD in the viewer's timezone; defaults to server date
  try {
    // $1 = closed stages; $2 = viewer's date when given
    const withDate = today ? [CLOSED, today] : [CLOSED];
    const d = today ? '$2::date' : 'CURRENT_DATE';
    const dOnly = today ? '$1::date' : 'CURRENT_DATE';

    const [due, top, stale, work, counts] = await Promise.all([
      // Follow-ups due today or overdue
      pool.query(`SELECT * FROM prospects
                   WHERE stage <> ALL($1) AND next_action_at IS NOT NULL AND next_action_at <= ${d}
                   ORDER BY next_action_at, fit_score DESC NULLS LAST LIMIT 50`, withDate),
      // Best untouched leads to reach out to
      pool.query(`SELECT * FROM prospects
                   WHERE stage = 'found' AND fit_tier IN ('A','B') AND (phone IS NOT NULL OR website IS NOT NULL)
                   ORDER BY fit_score DESC, review_count DESC NULLS LAST LIMIT 15`),
      // In conversation but gone quiet for 7+ days with no follow-up scheduled
      pool.query(`SELECT * FROM prospects
                   WHERE stage IN ('contacted','responded','qualified','proposal') AND next_action_at IS NULL
                     AND COALESCE(last_contacted_at, updated_at) < NOW() - INTERVAL '7 days'
                   ORDER BY fit_score DESC NULLS LAST LIMIT 20`),
      // Open project tasks overdue or due in the next 7 days
      pool.query(`SELECT t.*, pr.name AS project_name, pr.status AS project_status, pk.company AS client_company
                    FROM tasks t JOIN projects pr ON pr.id = t.project_id
                    LEFT JOIN prospects pk ON pk.id = pr.prospect_id
                   WHERE NOT t.done AND pr.status IN ('planning','active') AND t.due_date IS NOT NULL
                     AND t.due_date <= ${dOnly} + 7
                   ORDER BY t.due_date, t.id LIMIT 30`, today ? [today] : []),
      pool.query(`SELECT
                    (SELECT COUNT(*) FROM prospects WHERE stage <> ALL($1))::int AS open_leads,
                    (SELECT COUNT(*) FROM prospects WHERE stage <> ALL($1) AND fit_tier = 'A')::int AS a_tier_open,
                    (SELECT COUNT(*) FROM prospects WHERE stage IN ('qualified','proposal'))::int AS hot,
                    (SELECT COALESCE(SUM(est_value),0) FROM prospects WHERE stage IN ('qualified','proposal'))::float AS pipeline_value,
                    (SELECT COUNT(*) FROM projects WHERE status = 'active')::int AS active_projects,
                    (SELECT COUNT(*) FROM prospects WHERE discovered_at > NOW() - INTERVAL '24 hours')::int AS new_24h`, [CLOSED]),
    ]);

    res.json({
      followups_due: due.rows,
      top_new_leads: top.rows,
      gone_quiet: stale.rows,
      task_queue: work.rows,
      counts: counts.rows[0],
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
