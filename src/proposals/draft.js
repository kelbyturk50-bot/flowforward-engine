// Proposal drafting: research a lead, have Claude write the analysis, email
// sequence and one-pager, and save it as a new version for review in the CRM.
// Nothing here sends email — that only happens after approval (see send.js).

const crypto    = require('crypto');
const Anthropic = require('@anthropic-ai/sdk');
const pool      = require('../db/client');
const cfg       = require('./config');
const { appendDraftExclusion, isPestCompanyName, PEST_NAME_REASON } = require('../scoring/industry');
const { ARCHIVED_LEAD_REASON, isArchivedLead } = require('../db/pest-archive');
const { researchLead } = require('./research');
const { fsmDetectedFromResearch } = require('./servicetitan');
const { rescore } = require('../scoring/fit');
const { systemPrompt, userPrompt, SUBMIT_TOOL } = require('./prompt');

let client = null;
function claude() {
  if (!client) {
    if (!process.env.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY is not set in Railway Variables.');
    client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  }
  return client;
}
// Tests swap in a fake client. Refuses to run outside the test process.
function _setClient(c) {
  if (process.env.NODE_ENV !== 'test') {
    throw new Error('_setClient is only available when NODE_ENV=test');
  }
  client = c;
}

function makeSlug(company) {
  const base = String(company || 'proposal').toLowerCase().normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'proposal';
  return `${base}-${crypto.randomBytes(4).toString('hex')}`; // unguessable, still readable
}

async function getSetting(key, fallback = null) {
  const { rows } = await pool.query('SELECT value FROM app_settings WHERE key = $1', [key]);
  return rows.length ? rows[0].value : fallback;
}

// Context that teaches the bot Kelby's taste: his standing notes, recent
// thumbs-up/down, and emails he rewrote before sending.
async function learningContext() {
  const [styleNotes, feedback, examples] = await Promise.all([
    getSetting('proposal_style_notes', ''),
    pool.query(`SELECT pr.feedback_rating, pr.feedback_note, p.company
                  FROM proposals pr JOIN prospects p ON p.id = pr.prospect_id
                 WHERE pr.feedback_rating IS NOT NULL OR COALESCE(pr.feedback_note, '') <> ''
                 ORDER BY pr.updated_at DESC LIMIT 8`),
    pool.query(`SELECT subject, body FROM proposals
                 WHERE sent_at IS NOT NULL AND ai_original IS NOT NULL
                   AND (body IS DISTINCT FROM ai_original->>'body' OR subject IS DISTINCT FROM ai_original->>'subject')
                 ORDER BY sent_at DESC LIMIT 3`),
  ]);
  return { styleNotes: typeof styleNotes === 'string' ? styleNotes : '', feedback: feedback.rows, examples: examples.rows };
}

// Run Claude with web search + the submit tool until it submits.
async function writeWithClaude({ lead, research, instructions }) {
  const ctx = await learningContext();
  const tools = [];
  if (cfg.WEB_SEARCH) {
    tools.push({
      type: 'web_search_20260318', name: 'web_search', max_uses: cfg.WEB_SEARCH_MAX,
      user_location: { type: 'approximate', city: lead.city || 'Salt Lake City', region: 'Utah', country: 'US', timezone: 'America/Denver' },
    });
  }
  tools.push(SUBMIT_TOOL);

  const system = [{ type: 'text', text: systemPrompt(), cache_control: { type: 'ephemeral' } }];
  const messages = [{ role: 'user', content: userPrompt({ lead, research, instructions, ...ctx }) }];
  const usage = { input: 0, output: 0, cacheWrite: 0, cacheRead: 0, searches: 0 };
  let toolChoice = { type: 'auto' };

  for (let turn = 0; turn < 6; turn++) {
    const res = await claude().messages.create({
      model: cfg.MODEL, max_tokens: 12000, system, tools, tool_choice: toolChoice, messages,
    });
    const u = res.usage || {};
    usage.input      += u.input_tokens || 0;
    usage.output     += u.output_tokens || 0;
    usage.cacheWrite += u.cache_creation_input_tokens || 0;
    usage.cacheRead  += u.cache_read_input_tokens || 0;
    usage.searches   += u.server_tool_use?.web_search_requests || 0;

    const cost = cfg.costOf(cfg.MODEL, usage);
    const submitted = (res.content || []).find(b => b.type === 'tool_use' && b.name === 'submit_proposal');
    if (submitted && res.stop_reason !== 'max_tokens') return { output: submitted.input, usage, cost };
    if (cost > cfg.MAX_COST_PER_LEAD) throw new Error(`Stopped: cost passed the $${cfg.MAX_COST_PER_LEAD} per-lead cap.`);

    messages.push({ role: 'assistant', content: res.content });
    if (res.stop_reason === 'pause_turn') continue;           // long search turn; resume as-is
    if (submitted) {                                          // truncated submit: ask again
      messages.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: submitted.id, is_error: true,
        content: 'Your submission was cut off. Submit again, keeping each field concise.' }] });
    } else {
      messages.push({ role: 'user', content: 'Now call submit_proposal with your final work.' });
    }
    toolChoice = { type: 'tool', name: 'submit_proposal' };
  }
  throw new Error('Claude did not submit a proposal after several turns.');
}

const str = (v) => (typeof v === 'string' ? v.trim() : '');
const arr = (v) => (Array.isArray(v) ? v : []);

function cleanOutput(out, research, lead) {
  const a = out.analysis || {}; const e = out.email || {}; const o = out.onepager || {};
  const analysis = {
    snapshot: str(a.snapshot), owner_name: str(a.owner_name), owner_role: str(a.owner_role), owner_source: str(a.owner_source),
    best_email: str(a.best_email).toLowerCase(), email_source: str(a.email_source), other_contacts: arr(a.other_contacts).map(String),
    tools_in_use: arr(a.tools_in_use).map(String), strengths: arr(a.strengths).map(String),
    pain_signals: arr(a.pain_signals).map(p => ({ signal: str(p?.signal), evidence: str(p?.evidence), source: str(p?.source) })).filter(p => p.signal),
    fit_verdict: ['good', 'weak', 'disqualify'].includes(a.fit_verdict) ? a.fit_verdict : 'good',
    fit_reason: str(a.fit_reason), confidence: Number(a.confidence) || null,
    talking_points: arr(a.talking_points).map(String), verify: arr(a.verify).map(String),
  };
  const onepager = {
    headline: str(o.headline) || `A few ideas for ${lead.company}`,
    intro: str(o.intro),
    observations: arr(o.observations).map(x => ({ title: str(x?.title), detail: str(x?.detail) })).filter(x => x.title || x.detail).slice(0, 4),
    opportunities: arr(o.opportunities).map(x => ({
      title: str(x?.title), problem: str(x?.problem), solution: str(x?.solution), impact: str(x?.impact), assumptions: str(x?.assumptions),
    })).filter(x => x.title).slice(0, 3),
    closing: str(o.closing),
  };
  const email = { to_name: str(e.to_name), subject: str(e.subject), body: str(e.body), followup1: str(e.followup1), followup2: str(e.followup2) };

  const validEmail = (x) => /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(x || '');
  const toEmail = [analysis.best_email, lead.email, ...(research.site?.emails || [])].find(validEmail) || null;
  return { analysis, onepager, email, toEmail };
}

/**
 * Draft a new proposal version for one lead.
 * opts: { instructions, reuseResearch (default true when a prior version exists), trigger }
 */
async function draftProposal(prospectId, opts = {}) {
  const { rows } = await pool.query('SELECT * FROM prospects WHERE id = $1', [prospectId]);
  if (!rows.length) throw Object.assign(new Error('Lead not found'), { status: 404 });
  const lead = rows[0];

  // Name gate, before any research fetch or model call. Stored industry and
  // stored fit_tier do not waive it. The message has no company name.
  if (isPestCompanyName(lead.company)) {
    throw Object.assign(new Error(`${PEST_NAME_REASON}.`), { status: 409 });
  }
  if (isArchivedLead(lead)) {
    throw Object.assign(new Error(`${ARCHIVED_LEAD_REASON}.`), { status: 409 });
  }

  const prev = await pool.query(
    'SELECT id, version, research, status FROM proposals WHERE prospect_id = $1 ORDER BY version DESC LIMIT 1', [lead.id]);
  const last = prev.rows[0];
  if (last && ['sent'].includes(last.status)) {
    throw Object.assign(new Error('A proposal is already out for this lead. Stop that sequence before drafting a new one.'), { status: 409 });
  }

  const reuse = opts.reuseResearch !== false && last?.research;
  const research = reuse ? last.research : await researchLead(lead);
  const { output, usage, cost } = await writeWithClaude({ lead, research, instructions: opts.instructions });
  const { analysis, onepager, email, toEmail } = cleanOutput(output, research, lead);
  const disqualify = analysis.fit_verdict === 'disqualify';

  const db = await pool.connect();
  try {
    await db.query('BEGIN');
    await db.query(`UPDATE proposals SET status = 'superseded' WHERE prospect_id = $1 AND status = 'draft'`, [lead.id]);
    const version = (last?.version || 0) + 1;
    const ins = await db.query(
      `INSERT INTO proposals (prospect_id, version, status, slug, to_email, to_name, subject, body, followup1, followup2,
                              onepager, analysis, research, ai_original, instructions, model,
                              input_tokens, output_tokens, searches, cost_usd, stop_reason)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21) RETURNING *`,
      [lead.id, version, disqualify ? 'discarded' : 'draft', makeSlug(lead.company), toEmail, email.to_name || analysis.owner_name.split(' ')[0] || null,
       email.subject, email.body, email.followup1, email.followup2,
       onepager, analysis, research, { ...email, onepager }, opts.instructions || null, cfg.MODEL,
       usage.input + usage.cacheWrite + usage.cacheRead, usage.output, usage.searches, cost.toFixed(4),
       disqualify ? `Not a fit: ${analysis.fit_reason || 'flagged by the bot'}` : null]
    );

    // Fill in contact details the lead is missing; never overwrite what Kelby typed.
    // fsm_detected is the ServiceTitan cache. null means the crawl failed or
    // returned no usable HTML, so COALESCE keeps the previous value. 'none'
    // is written only after a successful crawl that saw no field-service tool.
    const fsmDetected = fsmDetectedFromResearch(research);
    await db.query(
      `UPDATE prospects SET researched_at = NOW(),
              fsm_detected = COALESCE($4, fsm_detected),
              email = COALESCE(NULLIF(email, ''), $2),
              contact_name = COALESCE(NULLIF(contact_name, ''), NULLIF($3, ''))
        WHERE id = $1`,
      [lead.id, toEmail, analysis.owner_name, fsmDetected]
    );
    await db.query(`INSERT INTO prospect_activities (prospect_id, type, body) VALUES ($1, 'note', $2)`,
      [lead.id, `Proposal v${version} drafted by the bot ($${cost.toFixed(2)})${disqualify ? ` and flagged not a fit: ${analysis.fit_reason}` : ''}.`]);
    if (disqualify && !['won', 'lost', 'disqualified'].includes(lead.stage)) {
      await db.query(`UPDATE prospects SET stage = 'disqualified' WHERE id = $1`, [lead.id]);
      await db.query(`INSERT INTO prospect_activities (prospect_id, type, body) VALUES ($1, 'stage_change', $2)`,
        [lead.id, `${lead.stage} → disqualified (proposal bot)`]);
    }
    await db.query('COMMIT');
    // Score from the cache just written. rescore does not fetch.
    await rescore([lead.id]);
    return ins.rows[0];
  } catch (err) {
    await db.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    db.release();
  }
}

// ─── Nightly batch ────────────────────────────────────────────────────────
let running = false;

async function pickLeads(limit) {
  const params = [cfg.TIERS];
  const gateSql = appendDraftExclusion(params, cfg.EXCLUDED_INDUSTRIES);
  params.push(limit);
  const limitParam = params.length;
  const { rows } = await pool.query(
    `SELECT p.* FROM prospects p
      WHERE p.fit_tier = ANY($1) AND p.stage = 'found' AND NOT p.do_not_contact
        AND p.archived_at IS NULL
        AND ${gateSql}
        AND (p.website IS NOT NULL OR p.email IS NOT NULL)
        AND NOT EXISTS (SELECT 1 FROM proposals pr WHERE pr.prospect_id = p.id)
      ORDER BY p.fit_score DESC NULLS LAST, p.review_count DESC NULLS LAST
      LIMIT $${limitParam}`,
    params
  );
  return rows;
}

async function runProposalBatch({ trigger = 'nightly', count } = {}) {
  if (running) return { skipped: true, reason: 'A drafting run is already in progress.' };
  running = true;
  const n = count || cfg.NIGHTLY_COUNT;
  const run = (await pool.query(`INSERT INTO proposal_runs (trigger, requested) VALUES ($1, $2) RETURNING id`, [trigger, n])).rows[0];
  const log = []; let drafted = 0, errors = 0, total = 0;
  try {
    const leads = await pickLeads(n);
    if (!leads.length) log.push({ msg: 'No new leads match (tier, stage found, not excluded, no proposal yet).' });
    for (const lead of leads) {
      try {
        const p = await draftProposal(lead.id, { trigger });
        drafted++; total += Number(p.cost_usd || 0);
        log.push({ prospect_id: lead.id, company: lead.company, proposal_id: p.id, status: p.status, cost: Number(p.cost_usd) });
      } catch (err) {
        errors++;
        log.push({ prospect_id: lead.id, company: lead.company, error: err.message });
        console.error(`[proposals] ✗ ${lead.company}: ${err.message}`);
        if (/ANTHROPIC_API_KEY|credit balance|authentication/i.test(err.message)) break; // no point continuing
      }
    }
    await pool.query(
      `UPDATE proposal_runs SET finished_at = NOW(), status = $2, drafted = $3, errors = $4, cost_usd = $5, log = $6 WHERE id = $1`,
      [run.id, errors ? 'done_with_errors' : 'done', drafted, errors, total.toFixed(4), JSON.stringify(log)]);
    console.log(`[proposals] Run #${run.id}: drafted ${drafted}, errors ${errors}, cost $${total.toFixed(2)}`);
    return { run_id: run.id, drafted, errors, cost: total, log };
  } catch (err) {
    await pool.query(`UPDATE proposal_runs SET finished_at = NOW(), status = 'failed', log = $2 WHERE id = $1`,
      [run.id, JSON.stringify([...log, { error: err.message }])]).catch(() => {});
    throw err;
  } finally {
    running = false;
  }
}

module.exports = { draftProposal, runProposalBatch, pickLeads, getSetting, cleanOutput, makeSlug, _setClient, isRunning: () => running };
