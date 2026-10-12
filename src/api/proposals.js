// REST API for the proposal bot: review queue, editing, versions, sending.
const express = require('express');
const router  = express.Router();
const pool    = require('../db/client');
const cfg     = require('../proposals/config');
const { draftProposal, runProposalBatch, getSetting, isRunning } = require('../proposals/draft');
const send    = require('../proposals/send');

const LIST_COLS = `pr.id, pr.prospect_id, pr.version, pr.status, pr.slug, pr.to_email, pr.to_name, pr.subject,
  pr.cost_usd, pr.feedback_rating, pr.created_at, pr.updated_at, pr.sent_at, pr.followup1_due_at, pr.followup1_sent_at,
  pr.followup2_due_at, pr.followup2_sent_at, pr.replied_at, pr.stop_reason, pr.views, pr.last_viewed_at, pr.error,
  pr.analysis->>'fit_verdict' AS fit_verdict, (pr.analysis->>'confidence')::int AS confidence, pr.analysis->>'snapshot' AS snapshot,
  p.company, p.industry, p.city, p.fit_score, p.fit_tier, p.stage, p.phone, p.website`;

const VIEWS = {
  review:  `pr.status = 'draft'`,
  out:     `pr.status IN ('sent', 'sending')`,
  replied: `pr.status = 'replied'`,
  flagged: `pr.status = 'discarded' AND pr.analysis->>'fit_verdict' = 'disqualify'`,
  closed:  `(pr.status IN ('finished', 'stopped', 'bounced', 'opted_out') OR (pr.status = 'discarded' AND COALESCE(pr.analysis->>'fit_verdict', '') <> 'disqualify'))`,
};

const fail = (res, err) => res.status(err.status || 500).json({ error: err.message });
const withUrl = (p) => p && ({ ...p, onepager_url: send.onepagerUrl(p) });

// GET /api/proposals?view=review|out|replied|flagged|closed  or  ?prospect_id=
router.get('/', async (req, res) => {
  try {
    if (req.query.prospect_id) {
      const { rows } = await pool.query(`SELECT ${LIST_COLS} FROM proposals pr JOIN prospects p ON p.id = pr.prospect_id
        WHERE pr.prospect_id = $1 ORDER BY pr.version DESC`, [req.query.prospect_id]);
      return res.json({ proposals: rows.map(withUrl) });
    }
    const where = VIEWS[req.query.view] || VIEWS.review;
    const order = req.query.view === 'out' ? 'pr.sent_at DESC' : req.query.view === 'review' ? 'p.fit_score DESC NULLS LAST, pr.created_at DESC' : 'pr.updated_at DESC';
    const { rows } = await pool.query(`SELECT ${LIST_COLS} FROM proposals pr JOIN prospects p ON p.id = pr.prospect_id
      WHERE ${where} ORDER BY ${order} LIMIT 200`);
    res.json({ proposals: rows.map(withUrl) });
  } catch (err) { fail(res, err); }
});

// GET /api/proposals/summary — counts, setup status, today's sends
router.get('/summary', async (req, res) => {
  try {
    const counts = {};
    await Promise.all(Object.entries(VIEWS).map(async ([k, w]) => {
      const { rows } = await pool.query(`SELECT COUNT(*)::int AS n FROM proposals pr WHERE ${w}`);
      counts[k] = rows[0].n;
    }));
    const [spend, sentToday, eligible] = await Promise.all([
      pool.query(`SELECT COALESCE(SUM(cost_usd), 0)::float AS month FROM proposals WHERE created_at >= date_trunc('month', NOW())`),
      send.sentToday(),
      pool.query(`SELECT COUNT(*)::int AS n FROM prospects p WHERE p.fit_tier = ANY($1) AND p.stage = 'found' AND NOT p.do_not_contact
                    AND p.industry <> ALL($2) AND (p.website IS NOT NULL OR p.email IS NOT NULL)
                    AND NOT EXISTS (SELECT 1 FROM proposals pr WHERE pr.prospect_id = p.id)`, [cfg.TIERS, cfg.EXCLUDED_INDUSTRIES]),
    ]);
    const setup = [];
    if (!cfg.anthropicConfigured()) setup.push('Add ANTHROPIC_API_KEY in Railway Variables so the bot can write drafts.');
    setup.push(...send.sendReadiness());
    res.json({
      counts, setup, running: isRunning(),
      spend_this_month: spend.rows[0].month,
      sent_today: sentToday, daily_limit: cfg.SEND_DAILY_LIMIT,
      eligible_leads: eligible.rows[0].n,
      config: {
        model: cfg.MODEL, nightly_count: cfg.NIGHTLY_COUNT, tiers: cfg.TIERS, excluded: cfg.EXCLUDED_INDUSTRIES, cron: cfg.CRON,
        followup_days: cfg.FOLLOWUP_DAYS, web_search: cfg.WEB_SEARCH, reviews: cfg.FETCH_REVIEWS,
        sender: { name: cfg.SENDER.name, email: cfg.SENDER.email, calendly: cfg.SENDER.calendly, address: cfg.SENDER.address },
      },
    });
  } catch (err) { fail(res, err); }
});

// Drafting runs
router.get('/runs', async (req, res) => {
  try {
    const { rows } = await pool.query(`SELECT * FROM proposal_runs ORDER BY started_at DESC LIMIT 20`);
    res.json(rows);
  } catch (err) { fail(res, err); }
});
router.post('/runs/trigger', async (req, res) => {
  if (isRunning()) return res.status(409).json({ error: 'A drafting run is already in progress.' });
  if (!cfg.anthropicConfigured()) return res.status(400).json({ error: 'Add ANTHROPIC_API_KEY in Railway Variables first.' });
  const count = Math.max(1, Math.min(20, parseInt(req.body?.count, 10) || cfg.NIGHTLY_COUNT));
  runProposalBatch({ trigger: 'manual', count }).catch(err => console.error('[api] proposal run error:', err.message));
  res.json({ ok: true, message: `Drafting up to ${count} proposals in the background.` });
});

// Voice / approach notes the bot reads on every draft
router.get('/settings', async (req, res) => {
  try { res.json({ style_notes: await getSetting('proposal_style_notes', '') }); } catch (err) { fail(res, err); }
});
router.put('/settings', async (req, res) => {
  try {
    const notes = String(req.body?.style_notes ?? '').slice(0, 8000);
    await pool.query(`INSERT INTO app_settings (key, value, updated_at) VALUES ('proposal_style_notes', $1, NOW())
                      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`, [JSON.stringify(notes)]);
    res.json({ style_notes: notes });
  } catch (err) { fail(res, err); }
});

// POST /api/proposals/check-inbox — run the reply check + follow-up sender now
router.post('/check-inbox', async (req, res) => {
  try {
    const inbox = await send.checkInbox();
    const followups = await send.sendDueFollowups();
    res.json({ ok: true, inbox, followups });
  } catch (err) { fail(res, err); }
});

// POST /api/proposals { prospect_id, instructions } — draft one on demand (any tier). Takes ~30–90s.
router.post('/', async (req, res) => {
  const id = parseInt(req.body?.prospect_id, 10);
  if (!id) return res.status(400).json({ error: 'prospect_id is required' });
  try {
    const p = await draftProposal(id, { instructions: req.body?.instructions, trigger: 'manual' });
    res.status(201).json(withUrl(p));
  } catch (err) { fail(res, err); }
});

// GET /api/proposals/:id — full proposal with lead basics and version list
router.get('/:id', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT pr.*, p.company, p.industry, p.city, p.fit_score, p.fit_tier, p.stage, p.phone, p.website, p.email AS lead_email,
              p.contact_name, p.do_not_contact, p.rating, p.review_count
         FROM proposals pr JOIN prospects p ON p.id = pr.prospect_id WHERE pr.id = $1`, [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    const versions = await pool.query(
      `SELECT id, version, status, created_at, cost_usd, instructions FROM proposals WHERE prospect_id = $1 ORDER BY version DESC`,
      [rows[0].prospect_id]);
    const p = rows[0];
    res.json({
      ...withUrl(p),
      versions: versions.rows,
      preview: {
        first: send.renderMessage(p, 'first'),
        followup1: p.followup1 ? send.renderMessage(p, 'followup1') : '',
        followup2: p.followup2 ? send.renderMessage(p, 'followup2') : '',
      },
    });
  } catch (err) { fail(res, err); }
});

// PATCH /api/proposals/:id — edit copy (drafts only) or leave feedback (any time)
const COPY_FIELDS = ['to_email', 'to_name', 'subject', 'body', 'followup1', 'followup2', 'onepager'];
router.patch('/:id', async (req, res) => {
  try {
    const cur = await pool.query('SELECT status FROM proposals WHERE id = $1', [req.params.id]);
    if (!cur.rows.length) return res.status(404).json({ error: 'Not found' });
    const b = req.body || {};
    const updates = [];
    for (const k of COPY_FIELDS) if (b[k] !== undefined) updates.push([k, k === 'onepager' ? b[k] : (b[k] === '' ? null : String(b[k]))]);
    if (updates.length && cur.rows[0].status !== 'draft') {
      return res.status(409).json({ error: 'This version has already gone out, so its copy is locked. Feedback can still be added.' });
    }
    if (b.to_email && !/^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(b.to_email)) return res.status(400).json({ error: 'That email address doesn\'t look right.' });
    if (b.feedback_rating !== undefined) updates.push(['feedback_rating', [1, -1].includes(Number(b.feedback_rating)) ? Number(b.feedback_rating) : null]);
    if (b.feedback_note !== undefined) updates.push(['feedback_note', String(b.feedback_note || '').slice(0, 2000) || null]);
    if (!updates.length) return res.status(400).json({ error: 'No valid fields' });
    const sets = updates.map(([k], i) => `${k} = $${i + 2}`).join(', ');
    await pool.query(`UPDATE proposals SET ${sets}, error = NULL WHERE id = $1`, [req.params.id, ...updates.map(([, v]) => v)]);
    const { rows } = await pool.query('SELECT * FROM proposals WHERE id = $1', [req.params.id]);
    res.json(withUrl(rows[0]));
  } catch (err) { fail(res, err); }
});

// POST /api/proposals/:id/send — approve + send the first email now
router.post('/:id/send', async (req, res) => {
  try { res.json(withUrl(await send.approveAndSend(parseInt(req.params.id, 10)))); } catch (err) { fail(res, err); }
});

// POST /api/proposals/:id/regenerate { instructions, fresh_research }
router.post('/:id/regenerate', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT prospect_id FROM proposals WHERE id = $1', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    const p = await draftProposal(rows[0].prospect_id, {
      instructions: req.body?.instructions, reuseResearch: !req.body?.fresh_research, trigger: 'manual',
    });
    res.status(201).json(withUrl(p));
  } catch (err) { fail(res, err); }
});

// POST /api/proposals/:id/stop — stop follow-ups (e.g. you talked on the phone)
router.post('/:id/stop', async (req, res) => {
  try {
    const p = await send.stopSequence(req.params.id, req.body?.reason || 'Stopped by Kelby');
    if (!p) return res.status(409).json({ error: 'Nothing to stop.' });
    res.json(withUrl(p));
  } catch (err) { fail(res, err); }
});

// POST /api/proposals/:id/replied — they replied some other way (phone, text)
router.post('/:id/replied', async (req, res) => {
  try {
    const { rows } = await pool.query(`SELECT pr.*, p.stage FROM proposals pr JOIN prospects p ON p.id = pr.prospect_id WHERE pr.id = $1`, [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    if (rows[0].status !== 'sent') return res.status(409).json({ error: 'Only a sequence that is out can be marked replied.' });
    await send.applyOutcome(rows[0], { kind: 'replied', snippet: req.body?.note || 'marked by Kelby' }, { date: new Date() });
    const fresh = await pool.query('SELECT * FROM proposals WHERE id = $1', [req.params.id]);
    res.json(withUrl(fresh.rows[0]));
  } catch (err) { fail(res, err); }
});

// POST /api/proposals/:id/discard — drop a draft
router.post('/:id/discard', async (req, res) => {
  try {
    const { rows } = await pool.query(`UPDATE proposals SET status = 'discarded', stop_reason = $2 WHERE id = $1 AND status = 'draft' RETURNING *`,
      [req.params.id, req.body?.reason || 'Discarded by Kelby']);
    if (!rows.length) return res.status(409).json({ error: 'Only drafts can be discarded.' });
    if (req.body?.disqualify) {
      const lead = await pool.query(`SELECT stage FROM prospects WHERE id = $1`, [rows[0].prospect_id]);
      if (lead.rows[0] && lead.rows[0].stage !== 'disqualified') {
        await pool.query(`UPDATE prospects SET stage = 'disqualified' WHERE id = $1`, [rows[0].prospect_id]);
        await pool.query(`INSERT INTO prospect_activities (prospect_id, type, body) VALUES ($1, 'stage_change', $2)`,
          [rows[0].prospect_id, `${lead.rows[0].stage} → disqualified (from proposal review)`]);
      }
    }
    res.json(withUrl(rows[0]));
  } catch (err) { fail(res, err); }
});

// POST /api/proposals/:id/restore — bring a discarded/flagged version back to review
router.post('/:id/restore', async (req, res) => {
  const db = await pool.connect();
  try {
    await db.query('BEGIN');
    const { rows } = await db.query(`SELECT * FROM proposals WHERE id = $1 FOR UPDATE`, [req.params.id]);
    const p = rows[0];
    if (!p) { await db.query('ROLLBACK'); return res.status(404).json({ error: 'Not found' }); }
    if (!['discarded', 'superseded'].includes(p.status)) { await db.query('ROLLBACK'); return res.status(409).json({ error: 'Only discarded or older versions can be restored.' }); }
    const out = await db.query(`SELECT 1 FROM proposals WHERE prospect_id = $1 AND status IN ('sent', 'sending')`, [p.prospect_id]);
    if (out.rows.length) { await db.query('ROLLBACK'); return res.status(409).json({ error: 'Another version is already out for this lead.' }); }
    await db.query(`UPDATE proposals SET status = 'superseded' WHERE prospect_id = $1 AND status = 'draft'`, [p.prospect_id]);
    await db.query(`UPDATE proposals SET status = 'draft', stop_reason = NULL WHERE id = $1`, [p.id]);
    const lead = await db.query(`SELECT stage FROM prospects WHERE id = $1`, [p.prospect_id]);
    if (lead.rows[0]?.stage === 'disqualified') {
      await db.query(`UPDATE prospects SET stage = 'found' WHERE id = $1`, [p.prospect_id]);
      await db.query(`INSERT INTO prospect_activities (prospect_id, type, body) VALUES ($1, 'stage_change', 'disqualified → found (proposal restored)')`, [p.prospect_id]);
    }
    await db.query('COMMIT');
    const fresh = await pool.query('SELECT * FROM proposals WHERE id = $1', [p.id]);
    res.json(withUrl(fresh.rows[0]));
  } catch (err) {
    await db.query('ROLLBACK').catch(() => {});
    fail(res, err);
  } finally { db.release(); }
});

module.exports = router;
