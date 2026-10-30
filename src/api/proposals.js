// REST API for the proposal bot: review queue, editing, versions, sending.
const express = require('express');
const router  = express.Router();
const pool    = require('../db/client');
const cfg     = require('../proposals/config');
const { appendDraftExclusion, isPestCompanyName, PEST_NAME_REASON } = require('../scoring/industry');
const { ARCHIVED_LEAD_REASON, isArchivedLead } = require('../db/pest-archive');
const { draftProposal, runProposalBatch, getSetting, isRunning, rebuildOnepager } = require('../proposals/draft');
const send    = require('../proposals/send');
const jobs    = require('../proposals/jobs');
const pilotFlags = require('../pilot/flags');
const pilotTokens = require('../pilot/tokens');
const { prototypeForProposal } = require('../prototypes/store');

const LIST_COLS = `pr.id, pr.prospect_id, pr.version, pr.status, pr.slug, pr.to_email, pr.to_name, pr.subject,
  pr.cost_usd, pr.feedback_rating, pr.reviewed_at, pr.created_at, pr.updated_at, pr.sent_at, pr.followup1_due_at, pr.followup1_sent_at,
  pr.followup2_due_at, pr.followup2_sent_at, pr.replied_at, pr.stop_reason, pr.views, pr.last_viewed_at, pr.error,
  pr.analysis->>'fit_verdict' AS fit_verdict, (pr.analysis->>'confidence')::int AS confidence, pr.analysis->>'snapshot' AS snapshot,
  p.company, p.industry, p.city, p.fit_score, p.fit_tier, p.stage, p.phone, p.website`;

const VIEWS = {
  review:  `pr.status = 'draft'`,
  out:     `pr.status IN ('sent', 'sending')`,
  replied: `pr.status = 'replied'`,
  flagged: `pr.status = 'discarded' AND pr.analysis->>'fit_verdict' = 'disqualify'`,
  closed:  `(pr.status IN ('finished', 'stopped', 'bounced', 'opted_out', 'manual_review') OR (pr.status = 'discarded' AND COALESCE(pr.analysis->>'fit_verdict', '') <> 'disqualify'))`,
};

const fail = (res, err) => res.status(err.status || 500).json({ error: err.message });
const { canonicalizeRecipient } = require('../proposals/recipient');

function proposalIdOrNull(raw) {
  if (typeof raw !== 'string' || !/^\d{1,9}$/.test(raw)) return null;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 2147483647) return null;
  return n;
}
const withUrl = (p) => p && ({ ...p, onepager_url: send.onepagerUrl(p) });

// GET /api/proposals?view=review|out|replied|flagged|closed  or  ?prospect_id=
router.get('/', async (req, res) => {
  try {
    if (req.query.prospect_id) {
      const { rows } = await pool.query(`SELECT ${LIST_COLS} FROM proposals pr JOIN prospects p ON p.id = pr.prospect_id
        WHERE pr.prospect_id = $1 AND p.archived_at IS NULL ORDER BY pr.version DESC`, [req.query.prospect_id]);
      return res.json({ proposals: rows.map(withUrl) });
    }
    const where = VIEWS[req.query.view] || VIEWS.review;
    const order = req.query.view === 'out' ? 'pr.sent_at DESC' : req.query.view === 'review' ? 'p.fit_score DESC NULLS LAST, pr.created_at DESC' : 'pr.updated_at DESC';
    const { rows } = await pool.query(`SELECT ${LIST_COLS} FROM proposals pr JOIN prospects p ON p.id = pr.prospect_id
      WHERE ${where} AND p.archived_at IS NULL ORDER BY ${order} LIMIT 200`);
    res.json({ proposals: rows.map(withUrl) });
  } catch (err) { fail(res, err); }
});

// GET /api/proposals/summary — counts, setup status, today's sends
router.get('/summary', async (req, res) => {
  try {
    const counts = {};
    await Promise.all(Object.entries(VIEWS).map(async ([k, w]) => {
      const { rows } = await pool.query(`SELECT COUNT(*)::int AS n FROM proposals pr JOIN prospects p ON p.id = pr.prospect_id WHERE ${w} AND p.archived_at IS NULL`);
      counts[k] = rows[0].n;
    }));
    const eligibleParams = [cfg.TIERS];
    const gateSql = appendDraftExclusion(eligibleParams, cfg.EXCLUDED_INDUSTRIES);
    const [spend, sentToday, eligible, chatSpend] = await Promise.all([
      pool.query(`SELECT COALESCE(SUM(cost_usd), 0)::float AS month FROM proposals WHERE created_at >= date_trunc('month', NOW())`),
      send.sentToday(),
      pool.query(`SELECT COUNT(*)::int AS n FROM prospects p WHERE p.fit_tier = ANY($1) AND p.stage = 'found' AND NOT p.do_not_contact
                    AND p.archived_at IS NULL
                    AND ${gateSql} AND (p.website IS NOT NULL OR p.email IS NOT NULL)
                    AND NOT EXISTS (SELECT 1 FROM proposals pr WHERE pr.prospect_id = p.id)`, eligibleParams),
      pool.query(`SELECT COALESCE(SUM(cost_usd), 0)::float AS month FROM chat_demo_turns WHERE created_at >= date_trunc('month', NOW())`),
    ]);
    const [unreviewed, activeJobs] = await Promise.all([
      pool.query(`SELECT COUNT(*)::int AS n FROM proposals pr JOIN prospects p ON p.id = pr.prospect_id WHERE pr.status = 'draft' AND pr.reviewed_at IS NULL AND p.archived_at IS NULL`),
      pool.query(`SELECT COUNT(*)::int AS n FROM proposal_jobs WHERE status IN ('queued', 'running')`),
    ]);
    counts.unreviewed = unreviewed.rows[0].n;
    counts.jobs_active = activeJobs.rows[0].n;
    const setup = [];
    if (!cfg.anthropicConfigured()) setup.push('Add ANTHROPIC_API_KEY in Railway Variables so the bot can write drafts.');
    const readiness = await send.sendReadiness();
    setup.push(...readiness);
    const gstatus = await require('../proposals/gmail').status();
    res.json({
      counts, setup, running: isRunning(),
      email: { mode: await send.mailMode(), gmail: gstatus },
      spend_this_month: spend.rows[0].month,
      chat_demo_this_month: chatSpend.rows[0].month,
      sent_today: sentToday, daily_limit: cfg.SEND_DAILY_LIMIT,
      halt: readiness.halt || null,
      eligible_leads: eligible.rows[0].n,
      config: {
        model: cfg.MODEL, nightly_count: cfg.NIGHTLY_COUNT, auto_draft: cfg.AUTO_DRAFT, tiers: cfg.TIERS, excluded: cfg.EXCLUDED_INDUSTRIES, cron: cfg.CRON,
        followup_days: cfg.FOLLOWUP_DAYS, web_search: cfg.WEB_SEARCH, reviews: cfg.FETCH_REVIEWS,
        sender: { name: cfg.SENDER.name, email: cfg.SENDER.email, calendly: cfg.SENDER.calendly, address: cfg.SENDER.address },
      },
    });
  } catch (err) { fail(res, err); }
});

// Background jobs (single-lead drafts and rewrites)
router.get('/jobs', async (req, res) => {
  try {
    const [list, unreviewed, inboxCounts] = await Promise.all([
      jobs.list({ prospectId: req.query.prospect_id ? parseInt(req.query.prospect_id, 10) : null }),
      pool.query(`SELECT COUNT(*)::int AS n FROM proposals pr JOIN prospects p ON p.id = pr.prospect_id WHERE pr.status = 'draft' AND pr.reviewed_at IS NULL AND p.archived_at IS NULL`),
      require('../proposals/inbox').counts(),
    ]);
    // inbox_waiting: replies with a draft (or a problem) to look at, plus unseen FYIs. inbox_working: being read by Claude.
    res.json({ jobs: list, unreviewed: unreviewed.rows[0].n, inbox_waiting: inboxCounts.waiting, inbox_working: inboxCounts.working });
  }
  catch (err) { fail(res, err); }
});
router.post('/jobs/:jobId/dismiss', async (req, res) => {
  try { await jobs.dismiss(parseInt(req.params.jobId, 10)); res.json({ ok: true }); } catch (err) { fail(res, err); }
});

async function startJob(res, { prospectId, kind, sourceProposalId, instructions, freshResearch }) {
  const lead = await pool.query('SELECT id, do_not_contact, company, archived_at FROM prospects WHERE id = $1', [prospectId]);
  if (!lead.rows.length) return res.status(404).json({ error: 'Lead not found' });
  // Refuse before a job row, a research fetch, or a model call.
  if (isPestCompanyName(lead.rows[0].company)) {
    return res.status(409).json({ error: `${PEST_NAME_REASON}.` });
  }
  if (isArchivedLead(lead.rows[0])) {
    return res.status(409).json({ error: `${ARCHIVED_LEAD_REASON}.` });
  }
  if (!cfg.anthropicConfigured()) return res.status(400).json({ error: 'Add ANTHROPIC_API_KEY in Railway Variables first.' });
  if (lead.rows[0].do_not_contact) return res.status(409).json({ error: 'This lead asked not to be contacted.' });
  const out = await pool.query(`SELECT 1 FROM proposals WHERE prospect_id = $1 AND status IN ('sent', 'sending')`, [prospectId]);
  if (out.rows.length) return res.status(409).json({ error: 'A proposal is already out for this lead. Stop that sequence before writing a new one.' });
  const { job, existing } = await jobs.enqueue({ prospectId, kind, sourceProposalId, instructions, freshResearch });
  res.status(202).json({ job, existing });
}

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

// Gmail connection (Gmail API over HTTPS; Railway blocks SMTP on non-Pro plans)
const gmail = require('../proposals/gmail');
router.get('/gmail/status', async (req, res) => {
  try { res.json({ ...(await gmail.status()), redirect_uri: gmail.redirectUri() }); } catch (err) { fail(res, err); }
});
router.post('/gmail/connect', async (req, res) => {
  try { res.json({ url: await gmail.authUrl(req.body?.return_to) }); } catch (err) { fail(res, err); }
});
router.post('/gmail/disconnect', async (req, res) => {
  try { await gmail.disconnect(); res.json({ ok: true }); } catch (err) { fail(res, err); }
});

// POST /api/proposals/check-inbox — run the reply check + follow-up sender now
router.post('/check-inbox', async (req, res) => {
  try {
    const inbox = await send.checkInbox();
    const followups = await send.sendDueFollowups();
    res.json({ ok: true, inbox, followups });
  } catch (err) { fail(res, err); }
});

// POST /api/proposals { prospect_id, instructions } — draft one lead in the background (any tier).
// Returns 202 with the job; poll GET /api/proposals/jobs.
router.post('/', async (req, res) => {
  const id = parseInt(req.body?.prospect_id, 10);
  if (!id) return res.status(400).json({ error: 'prospect_id is required' });
  try { await startJob(res, { prospectId: id, kind: 'draft', instructions: req.body?.instructions }); }
  catch (err) { fail(res, err); }
});

function pilotProposalId(req) {
  const raw = String(req.params.id || '');
  if (!/^\d+$/.test(raw)) return null;
  const id = Number(raw);
  return Number.isInteger(id) && id > 0 ? id : null;
}

// POST /api/proposals/:id/demo-token — mint a demo token. API key required.
// Not a public route. 404 when the master pilot flag is off or the proposal is missing.
router.post('/:id/demo-token', async (req, res) => {
  if (!(await pilotFlags.masterOn()) || !pilotTokens.pilotReady()) return res.status(404).json({ error: 'Not found' });
  const id = pilotProposalId(req);
  if (!id) return res.status(404).json({ error: 'Not found' });
  try {
    const minted = await pilotTokens.mintForProposal(id);
    if (!minted) return res.status(404).json({ error: 'Not found' });
    res.set('Cache-Control', 'no-store');
    res.status(201).json({
      token: minted.token,
      expires_at: minted.expires_at,
      path: pilotTokens.publicDemoPath(minted.token),
    });
  } catch (err) {
    console.error('[pilot] demo token mint failed:', err.message);
    res.set('Cache-Control', 'no-store');
    res.status(500).json({ error: 'Something went wrong.' });
  }
});

// POST /api/proposals/:id/demo-token/revoke — revoke active demo tokens for this proposal.
router.post('/:id/demo-token/revoke', async (req, res) => {
  if (!(await pilotFlags.masterOn()) || !pilotTokens.pilotReady()) return res.status(404).json({ error: 'Not found' });
  const id = pilotProposalId(req);
  if (!id) return res.status(404).json({ error: 'Not found' });
  try {
    const found = await pool.query('SELECT id FROM proposals WHERE id = $1', [id]);
    if (!found.rows.length) return res.status(404).json({ error: 'Not found' });
    await pilotTokens.revokeForProposal(id);
    res.set('Cache-Control', 'no-store');
    res.json({ ok: true });
  } catch (err) {
    console.error('[pilot] demo token revoke failed:', err.message);
    res.set('Cache-Control', 'no-store');
    res.status(500).json({ error: 'Something went wrong.' });
  }
});

// GET /api/proposals/:id — full proposal with lead basics and version list
router.get('/:id', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT pr.*, p.company, p.industry, p.city, p.fit_score, p.fit_tier, p.stage, p.phone, p.website, p.email AS lead_email,
              p.contact_name, p.do_not_contact, p.rating, p.review_count, p.archived_at, p.archive_reason
         FROM proposals pr JOIN prospects p ON p.id = pr.prospect_id WHERE pr.id = $1`, [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    const versions = await pool.query(
      `SELECT id, version, status, created_at, cost_usd, instructions FROM proposals WHERE prospect_id = $1 ORDER BY version DESC`,
      [rows[0].prospect_id]);
    const p = rows[0];
    const prototype = await prototypeForProposal(p.prospect_id);
    // Preview shows the prototype line exactly as it would go out now.
    p.prototype_url = prototype && prototype.url && !prototype.expired ? prototype.url : null;
    const additions = { first: send.addedLines(p, 'first'), followup1: send.addedLines(p, 'followup1') };
    res.json({
      ...withUrl(p),
      versions: versions.rows,
      preview: {
        first: send.renderMessage(p, 'first'),
        followup1: p.followup1 ? send.renderMessage(p, 'followup1') : '',
        followup2: p.followup2 ? send.renderMessage(p, 'followup2') : '',
      },
      prototype,
      additions,
    });
  } catch (err) { fail(res, err); }
});

// PATCH /api/proposals/:id — edit copy (drafts only) or leave feedback (any time)
const COPY_FIELDS = ['to_email', 'to_name', 'subject', 'body', 'followup1', 'followup2', 'onepager'];
router.patch('/:id', async (req, res) => {
  const proposalId = proposalIdOrNull(req.params.id);
  if (proposalId == null) return res.status(400).json({ error: 'Bad request.' });
  try {
    const cur = await pool.query('SELECT status FROM proposals WHERE id = $1', [proposalId]);
    if (!cur.rows.length) return res.status(404).json({ error: 'Not found' });
    const b = req.body || {};
    if (typeof b.to_email === 'string') {
      const canonical = canonicalizeRecipient(b.to_email);
      if (!canonical.ok) {
        if (canonical.reason === 'empty') b.to_email = '';
        else return res.status(400).json({ error: 'That email address doesn\'t look right.' });
      } else b.to_email = canonical.value;
    }
    const updates = [];
    for (const k of COPY_FIELDS) if (b[k] !== undefined) updates.push([k, k === 'onepager' ? b[k] : (b[k] === '' ? null : String(b[k]))]);
    if (updates.length && cur.rows[0].status !== 'draft') {
      return res.status(409).json({ error: 'This version has already gone out, so its copy is locked. Feedback can still be added.' });
    }
    if (b.to_email && send.missingRecipient(b.to_email)) return res.status(400).json({ error: 'That email address doesn\'t look right.' });
    if (b.feedback_rating !== undefined) updates.push(['feedback_rating', [1, -1].includes(Number(b.feedback_rating)) ? Number(b.feedback_rating) : null]);
    if (b.feedback_note !== undefined) updates.push(['feedback_note', String(b.feedback_note || '').slice(0, 2000) || null]);
    if (!updates.length) return res.status(400).json({ error: 'No valid fields' });
    const sets = updates.map(([k], i) => `${k} = $${i + 2}`).join(', ');
    await pool.query(`UPDATE proposals SET ${sets}, error = NULL WHERE id = $1`, [proposalId, ...updates.map(([, v]) => v)]);
    const { rows } = await pool.query('SELECT * FROM proposals WHERE id = $1', [proposalId]);
    res.json(withUrl(rows[0]));
  } catch (err) { fail(res, err); }
});

// POST /api/proposals/:id/send — approve + send the first email now
router.post('/:id/send', async (req, res) => {
  try {
    const confirm = !!(req.body && req.body.confirm === true);
    res.json(withUrl(await send.approveAndSend(parseInt(req.params.id, 10), { confirm })));
  } catch (err) { fail(res, err); }
});

// POST /api/proposals/:id/regenerate { instructions, fresh_research }
// Rewrite just the one-pager (same link). Works on sent proposals too, so a
// one-pager that came out empty can be fixed after the email went out.
router.post('/:id/rebuild-onepager', async (req, res) => {
  try {
    const p = await rebuildOnepager(Number(req.params.id));
    res.json({ id: p.id, onepager: p.onepager });
  } catch (err) { fail(res, err); }
});

router.post('/:id/regenerate', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT prospect_id FROM proposals WHERE id = $1', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    await startJob(res, {
      prospectId: rows[0].prospect_id, kind: 'rewrite', sourceProposalId: parseInt(req.params.id, 10),
      instructions: req.body?.instructions, freshResearch: !!req.body?.fresh_research,
    });
  } catch (err) { fail(res, err); }
});

// POST /api/proposals/:id/seen — opened in the CRM; clears the "New" tag
router.post('/:id/seen', async (req, res) => {
  try {
    await pool.query(`UPDATE proposals SET reviewed_at = COALESCE(reviewed_at, NOW()) WHERE id = $1`, [req.params.id]);
    await pool.query(`UPDATE proposal_jobs SET dismissed_at = COALESCE(dismissed_at, NOW()) WHERE result_proposal_id = $1`, [req.params.id]);
    res.json({ ok: true });
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

// POST /api/proposals/:id/mark-sent — record a manual outreach as sent
router.post('/:id/mark-sent', async (req, res) => {
  const proposalId = proposalIdOrNull(req.params.id);
  if (proposalId == null) return res.status(400).json({ error: 'Bad request.' });
  const db = await pool.connect();
  try {
    await db.query('BEGIN');
    const { rows } = await db.query(
      `SELECT pr.*, p.company, p.stage, p.archived_at
         FROM proposals pr
         JOIN prospects p ON p.id = pr.prospect_id
        WHERE pr.id = $1
        FOR UPDATE`,
      [proposalId]
    );
    const p = rows[0];
    if (!p) { await db.query('ROLLBACK'); return res.status(404).json({ error: 'Not found' }); }
    // Same refusal as send. Roll back before any status change, prospect
    // update, or follow-up scheduling.
    if (isPestCompanyName(p.company)) {
      await db.query('ROLLBACK');
      return res.status(409).json({ error: `${PEST_NAME_REASON}.` });
    }
    if (isArchivedLead(p)) {
      await db.query('ROLLBACK');
      return res.status(409).json({ error: `${ARCHIVED_LEAD_REASON}.` });
    }
    // Review-row resolve (delivered, confirm_override, not_sent) is issue #123.
    // A missing recipient is still refused before any write.
    if (send.missingRecipient(p.to_email)) {
      await db.query('ROLLBACK');
      return res.status(400).json({ error: 'Add a recipient email before marking this as sent.' });
    }
    if (p.status !== 'draft') {
      await db.query('ROLLBACK');
      return res.status(409).json({ error: `Cannot mark as sent — this proposal is ${p.status}.` });
    }

    const now = new Date();
    const fu1 = new Date(now); fu1.setDate(fu1.getDate() + 3);
    const fu2 = new Date(now); fu2.setDate(fu2.getDate() + 10);
    const note = req.body?.note || 'Manual outreach';
    await db.query(
      `UPDATE proposals SET status = 'sent', sent_at = $2,
        followup1_due_at = $3, followup2_due_at = $4,
        stop_reason = NULL, error = NULL, send_attempt_key = NULL,
        followup_argument_attempts = 0, followup_transient_attempts = 0,
        first_transient_at = NULL, next_retry_at = NULL
       WHERE id = $1`,
      [p.id, now, fu1, fu2]
    );
    await db.query(
      `UPDATE prospects SET stage = CASE WHEN stage IN ('found','qualified') THEN 'contacted' ELSE stage END,
        last_contacted_at = $2, updated_at = NOW() WHERE id = $1`,
      [p.prospect_id, now]
    );
    await db.query(
      `INSERT INTO prospect_activities (prospect_id, type, body) VALUES ($1, 'note', $2)`,
      [p.prospect_id, `Marked manually sent — ${note}`]
    );
    await db.query('COMMIT');
    const fresh = await pool.query('SELECT * FROM proposals WHERE id = $1', [p.id]);
    res.json(withUrl(fresh.rows[0]));
  } catch (err) {
    await db.query('ROLLBACK').catch(() => {});
    fail(res, err);
  } finally { db.release(); }
});

// Skip demo columns and token rows that this boot has not created yet.
// Missing pilot structures are not an error: the draft still discards.
async function revokeDemoOnDiscard(db, proposalId) {
  const column = await db.query(
    `SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'proposals' AND column_name = 'demo_revoked_at'`
  );
  if (column.rows.length) {
    await db.query('UPDATE proposals SET demo_revoked_at = NOW() WHERE id = $1', [proposalId]);
  }
  const table = await db.query(
    `SELECT 1 FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = 'pilot_tokens'`
  );
  if (table.rows.length) {
    await db.query(
      `UPDATE pilot_tokens SET revoked_at = NOW()
        WHERE proposal_id = $1 AND revoked_at IS NULL`,
      [proposalId]
    );
  }
}

// POST /api/proposals/:id/discard — drop a draft
router.post('/:id/discard', async (req, res) => {
  const db = await pool.connect();
  try {
    await db.query('BEGIN');
    const { rows } = await db.query(
      `UPDATE proposals SET status = 'discarded', stop_reason = $2
        WHERE id = $1 AND status = 'draft' RETURNING *`,
      [req.params.id, req.body?.reason || 'Discarded by Kelby']
    );
    if (!rows.length) {
      await db.query('ROLLBACK');
      return res.status(409).json({ error: 'Only drafts can be discarded.' });
    }
    await revokeDemoOnDiscard(db, rows[0].id);
    if (req.body?.disqualify) {
      const lead = await db.query('SELECT stage FROM prospects WHERE id = $1', [rows[0].prospect_id]);
      if (lead.rows[0] && lead.rows[0].stage !== 'disqualified') {
        await db.query('UPDATE prospects SET stage = \'disqualified\' WHERE id = $1', [rows[0].prospect_id]);
        await db.query(
          'INSERT INTO prospect_activities (prospect_id, type, body) VALUES ($1, \'stage_change\', $2)',
          [rows[0].prospect_id, `${lead.rows[0].stage} → disqualified (from proposal review)`]
        );
      }
    }
    await db.query('COMMIT');
    const fresh = await pool.query('SELECT * FROM proposals WHERE id = $1', [rows[0].id]);
    res.json(withUrl(fresh.rows[0] || rows[0]));
  } catch (err) {
    await db.query('ROLLBACK').catch(() => {});
    console.error('[proposals] discard failed:', err.message);
    res.status(500).json({ error: 'Something went wrong.' });
  } finally {
    db.release();
  }
});

// POST /api/proposals/:id/restore — bring a discarded/flagged version back to review
router.post('/:id/restore', async (req, res) => {
  const db = await pool.connect();
  try {
    await db.query('BEGIN');
    const { rows } = await db.query(
      `SELECT pr.*, p.company, p.archived_at
         FROM proposals pr
         JOIN prospects p ON p.id = pr.prospect_id
        WHERE pr.id = $1
        FOR UPDATE OF pr`,
      [req.params.id]
    );
    const p = rows[0];
    if (!p) { await db.query('ROLLBACK'); return res.status(404).json({ error: 'Not found' }); }
    // Same refusal as send. Roll back before any status change.
    if (isPestCompanyName(p.company)) {
      await db.query('ROLLBACK');
      return res.status(409).json({ error: `${PEST_NAME_REASON}.` });
    }
    if (isArchivedLead(p)) {
      await db.query('ROLLBACK');
      return res.status(409).json({ error: `${ARCHIVED_LEAD_REASON}.` });
    }
    if (!['discarded', 'superseded'].includes(p.status)) { await db.query('ROLLBACK'); return res.status(409).json({ error: 'Only discarded or older versions can be restored.' }); }
    const out = await db.query(`SELECT 1 FROM proposals WHERE prospect_id = $1 AND status IN ('sent', 'sending')`, [p.prospect_id]);
    if (out.rows.length) { await db.query('ROLLBACK'); return res.status(409).json({ error: 'Another version is already out for this lead.' }); }
    await db.query(`UPDATE proposals SET status = 'superseded' WHERE prospect_id = $1 AND status = 'draft'`, [p.prospect_id]);
    await db.query(
      `UPDATE proposals
          SET status = 'draft', stop_reason = NULL, error = NULL, approved_at = NULL,
              send_attempt_key = NULL, followup_argument_attempts = 0,
              followup_transient_attempts = 0, first_transient_at = NULL, next_retry_at = NULL
        WHERE id = $1`,
      [p.id]);
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
