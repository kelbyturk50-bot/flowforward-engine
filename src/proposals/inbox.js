// Inbox: every reply to a proposal is stored, read by Claude (what they're
// saying, what they're asking, suggested next steps) and, when a reply makes
// sense, answered with a draft Kelby reviews and sends from the CRM.
//
// Nothing here sends without Kelby clicking Send. Drafting runs in a small
// in-process queue (one at a time) so the CRM never waits on Claude.

const crypto = require('crypto');
const pool = require('../db/client');
const cfg  = require('./config');
const { replySystemPrompt, replyUserPrompt, TRIAGE_TOOL, KINDS, STAGES } = require('./reply-prompt');
const { isArchivedLead } = require('../db/pest-archive');
const { isPestCompanyName } = require('../scoring/industry');

const send  = () => require('./send');   // lazy: send.js requires this file too
const draft = () => require('./draft');

const NEEDS = ['queued', 'triaging', 'rewrite_queued', 'rewriting', 'ready', 'failed', 'sending'];
const DONE  = ['sent', 'handled', 'discarded'];
const PLACEHOLDER = /\[[^\]\n]{1,120}\]/g;
const AUTOMATED_FROM = /mailer-daemon|postmaster|calendly\.com|no-?reply/i;

const str = (v, max = 2000) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const arr = (v, n = 8) => (Array.isArray(v) ? v.map(x => str(x, 400)).filter(Boolean).slice(0, n) : []);

function dedupeKey(msg) {
  if (msg.key) return msg.key;
  if (msg.id) return `g:${msg.id}`;
  const h = crypto.createHash('sha256')
    .update([msg.from || '', msg.date ? new Date(msg.date).toISOString() : '', msg.subject || '', String(msg.text || '').slice(0, 4000)].join('\n'))
    .digest('hex').slice(0, 40);
  return `h:${h}`;
}

async function alreadyRecorded(msg) {
  const { rows } = await pool.query('SELECT 1 FROM inbox_messages WHERE dedupe_key = $1', [dedupeKey(msg)]);
  return rows.length > 0;
}

async function insertMessage(db, { prospectId, proposalId, direction, msg, to }) {
  const { rows } = await db.query(
    `INSERT INTO inbox_messages (prospect_id, proposal_id, direction, dedupe_key, gmail_id, thread_id, header_message_id,
                                 from_addr, to_addr, subject, body, is_auto, received_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,COALESCE($13, NOW()))
     ON CONFLICT (dedupe_key) DO NOTHING RETURNING *`,
    [prospectId, proposalId || null, direction, dedupeKey(msg), msg.id || null, msg.threadId || null,
     msg.messageIdHeader || null, (msg.from || '').toLowerCase() || null, to || null, msg.subject || null,
     String(msg.text || '').slice(0, 20000), !!msg.auto, msg.date || null]);
  return rows[0] || null;
}

/**
 * Store an inbound message for a proposal and open an inbox item for it.
 * kind: the inbox check's quick read (replied | booked | opted_out | bounced | auto).
 * Returns the item, or null if this message was already recorded or the lead
 * is archived / out of scope.
 */
async function recordInbound(p, kind, msg) {
  if (isArchivedLead(p) || isPestCompanyName(p.company || '')) return null;
  const db = await pool.connect();
  let item = null;
  try {
    await db.query('BEGIN');
    const m = await insertMessage(db, { prospectId: p.prospect_id, proposalId: p.id, direction: 'in', msg, to: cfg.SENDER.email });
    if (!m) { await db.query('ROLLBACK'); return null; }
    let fields;
    if (kind === 'bounced') {
      fields = { status: 'fyi', kind: 'bounce', label: 'Bounced', summary: `The email to ${p.to_email} didn't go through.`,
        notice: 'Follow-ups stopped and the address was cleared from the lead. Find another email or give them a call.' };
    } else if (kind === 'opted_out') {
      fields = { status: 'fyi', kind: 'opt_out', label: 'Opted out', summary: 'Asked not to be contacted again.',
        notice: 'Marked do-not-contact and follow-ups stopped. No reply needed.' };
    } else {
      fields = { status: 'queued', kind: kind === 'auto' ? 'auto_reply' : null, label: null, summary: null, notice: null };
    }
    const { rows } = await db.query(
      `INSERT INTO inbox_items (prospect_id, proposal_id, message_id, status, kind, label, summary, notice)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [p.prospect_id, p.id, m.id, fields.status, fields.kind, fields.label, fields.summary, fields.notice]);
    item = rows[0];
    await db.query('COMMIT');
  } catch (err) {
    await db.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    db.release();
  }
  if (item && item.status === 'queued') kick();
  return item;
}

// ── Thread ────────────────────────────────────────────────────────────────
async function threadFor(prospectId, { upTo } = {}) {
  const [props, msgs] = await Promise.all([
    pool.query(`SELECT * FROM proposals WHERE prospect_id = $1 AND sent_at IS NOT NULL ORDER BY sent_at`, [prospectId]),
    pool.query(`SELECT * FROM inbox_messages WHERE prospect_id = $1 ORDER BY received_at, id`, [prospectId]),
  ]);
  const out = [];
  const s = send();
  // Show the prototype line only on messages sent while that link was live,
  // matching what went out.
  let link = null;
  try { link = await require('../prototypes/store').prototypeForProposal(prospectId); } catch { link = null; }
  const company = props.rows.length
    ? (await pool.query('SELECT company FROM prospects WHERE id = $1', [prospectId])).rows[0]?.company : '';
  const render = (p, which, at) => {
    const t = new Date(at).getTime();
    const live = link && link.url && new Date(link.issued_at).getTime() <= t + 60000 && t < new Date(link.expires_at).getTime();
    return s.renderMessage({ ...p, company, prototype_url: live ? link.url : null }, which);
  };
  for (const p of props.rows) {
    out.push({ who: 'You', direction: 'out', at: p.sent_at, subject: p.subject, body: render(p, 'first', p.sent_at), source: 'proposal' });
    if (p.followup1_sent_at) out.push({ who: 'You', direction: 'out', at: p.followup1_sent_at, subject: `Re: ${p.subject}`, body: render(p, 'followup1', p.followup1_sent_at), source: 'followup' });
    if (p.followup2_sent_at) out.push({ who: 'You', direction: 'out', at: p.followup2_sent_at, subject: `Re: ${p.subject}`, body: render(p, 'followup2', p.followup2_sent_at), source: 'followup' });
  }
  for (const m of msgs.rows) {
    if (upTo && m.id === upTo) break;
    out.push({ who: m.direction === 'out' ? 'You' : (m.from_addr || 'Them'), direction: m.direction, at: m.received_at,
      subject: m.subject, body: m.body, is_auto: m.is_auto, id: m.id, source: 'message' });
  }
  out.sort((a, b) => new Date(a.at) - new Date(b.at));
  return out;
}

// ── Claude triage ─────────────────────────────────────────────────────────
function validDate(s) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s || '')) return null;
  const d = new Date(`${s}T12:00:00Z`);
  return isNaN(d) ? null : s;
}

function cleanTriage(out) {
  const kind = KINDS.includes(out.kind) ? out.kind : 'other';
  const suggestions = (Array.isArray(out.suggestions) ? out.suggestions : []).map(s => {
    const label = str(s?.label, 80);
    if (!label) return null;
    if (s.action === 'set_stage' && STAGES.includes(s.stage)) return { action: 'set_stage', stage: s.stage, label };
    if (s.action === 'remind' && validDate(s.date)) return { action: 'remind', date: s.date, text: str(s.text, 200) || label, label };
    if (s.action === 'add_note' && str(s.text, 300)) return { action: 'add_note', text: str(s.text, 300), label };
    return null;
  }).filter(Boolean).slice(0, 3);
  const noReply = ['auto_reply', 'opt_out'].includes(kind);
  const body = str(out.reply_body, 6000);
  return {
    kind, label: str(out.label, 80) || kind.replace(/_/g, ' '), summary: str(out.summary, 600),
    asks: arr(out.asks, 6), timing: str(out.timing, 200) || 'None', mood: str(out.mood, 60),
    prep: kind === 'booked' ? arr(out.prep, 5) : [], suggestions,
    auto_until: validDate(out.auto_reply_until),
    needs_reply: !noReply && !!out.needs_reply && !!body,
    reply_subject: str(out.reply_subject, 200), reply_body: body,
  };
}

async function callClaude(userText) {
  const system = [{ type: 'text', text: replySystemPrompt(), cache_control: { type: 'ephemeral' } }];
  const res = await draft().getClient().messages.create({
    model: cfg.MODEL, max_tokens: 3000, system, tools: [TRIAGE_TOOL],
    tool_choice: { type: 'tool', name: 'submit_reply_triage' },
    messages: [{ role: 'user', content: userText }],
  });
  const block = (res.content || []).find(b => b.type === 'tool_use' && b.name === 'submit_reply_triage');
  if (!block) throw new Error('Claude did not return a read of this message.');
  const u = res.usage || {};
  const cost = cfg.costOf(cfg.MODEL, {
    input: u.input_tokens || 0, output: u.output_tokens || 0,
    cacheWrite: u.cache_creation_input_tokens || 0, cacheRead: u.cache_read_input_tokens || 0,
  });
  return { out: block.input || {}, cost };
}

// Out-of-office: push unsent follow-ups to the day after they're back.
async function shiftFollowupsForAuto(proposalId, until) {
  if (!proposalId || !until) return null;
  const tz = cfg.SEND_TZ;
  const { rows } = await pool.query(
    `UPDATE proposals SET
        followup1_due_at = CASE WHEN followup1_sent_at IS NULL AND followup1_due_at IS NOT NULL
                                THEN GREATEST(followup1_due_at, (($2::date + 1) + TIME '09:00') AT TIME ZONE $3) ELSE followup1_due_at END,
        followup2_due_at = CASE WHEN followup2_sent_at IS NULL AND followup2_due_at IS NOT NULL
                                THEN GREATEST(followup2_due_at, (($2::date + 8) + TIME '09:00') AT TIME ZONE $3) ELSE followup2_due_at END
      WHERE id = $1 AND status = 'sent'
      RETURNING followup1_due_at, followup1_sent_at, followup2_due_at, followup2_sent_at`, [proposalId, until, tz]);
  return rows[0] || null;
}

// The quick check marked this a reply, but Claude says it's an auto-reply:
// put the sequence back so follow-ups go out. Only when this message is what
// flipped the proposal to "replied" and no real reply has come since.
async function resumeIfOnlyAutoReply(item, message) {
  const { rows } = await pool.query(
    `SELECT pr.id, pr.status, pr.replied_at, p.stage FROM proposals pr JOIN prospects p ON p.id = pr.prospect_id WHERE pr.id = $1`, [item.proposal_id]);
  const pr = rows[0];
  if (!pr || pr.status !== 'replied' || !pr.replied_at) return false;
  const close = Math.abs(new Date(pr.replied_at) - new Date(message.received_at)) < 5 * 60 * 1000;
  if (!close) return false;
  const others = await pool.query(
    `SELECT 1 FROM inbox_items i JOIN inbox_messages m ON m.id = i.message_id
      WHERE i.proposal_id = $1 AND i.id <> $2 AND m.direction = 'in' AND COALESCE(i.kind, '') <> 'auto_reply'`, [pr.id, item.id]);
  if (others.rows.length) return false;
  await pool.query(`UPDATE proposals SET status = 'sent', replied_at = NULL, stop_reason = NULL WHERE id = $1 AND status = 'replied'`, [pr.id]);
  if (pr.stage === 'responded') await pool.query(`UPDATE prospects SET stage = 'contacted', next_action = NULL, next_action_at = NULL WHERE id = $1`, [item.prospect_id]);
  await logActivity(item.prospect_id, 'note', 'That reply was an automatic out-of-office. Follow-ups resumed.');
  return true;
}

async function logActivity(prospectId, type, body) {
  await pool.query(`INSERT INTO prospect_activities (prospect_id, type, body) VALUES ($1, $2, $3)`, [prospectId, type, body]);
}

async function triage(item) {
  const [leadQ, propQ, msgQ] = await Promise.all([
    pool.query('SELECT * FROM prospects WHERE id = $1', [item.prospect_id]),
    item.proposal_id ? pool.query('SELECT * FROM proposals WHERE id = $1', [item.proposal_id]) : { rows: [] },
    pool.query('SELECT * FROM inbox_messages WHERE id = $1', [item.message_id]),
  ]);
  const lead = leadQ.rows[0]; const proposal = propQ.rows[0] || null; const message = msgQ.rows[0];
  if (!lead || !message) throw new Error('Lead or message is missing.');
  if (lead.do_not_contact) {
    return { status: 'fyi', kind: item.kind || 'opt_out', label: 'Do not contact', summary: 'This lead is marked do-not-contact.',
      notice: 'No reply drafted because the lead asked not to be contacted.' };
  }
  const thread = (await threadFor(lead.id, { upTo: message.id })).map(t => ({
    who: t.who, when: new Date(t.at).toISOString().slice(0, 16).replace('T', ' '), subject: t.subject, body: t.body,
  }));
  const styleNotes = await draft().getSetting('proposal_style_notes', '');
  const { out, cost } = await callClaude(replyUserPrompt({
    lead, proposal, thread, message, styleNotes: typeof styleNotes === 'string' ? styleNotes : '',
    instructions: item.status === 'rewriting' ? item.instructions : null,
    previousDraft: item.status === 'rewriting' ? item.reply_body : null,
  }));
  const t = cleanTriage(out);
  if (message.is_auto && t.kind !== 'auto_reply') { t.kind = 'auto_reply'; t.needs_reply = false; }
  // A rewrite Kelby asked for always comes back as a draft to review.
  if (item.status === 'rewriting' && t.reply_body && t.kind !== 'auto_reply') t.needs_reply = true;
  const automated = AUTOMATED_FROM.test(message.from_addr || '');
  const replyTo = automated ? (proposal?.to_email || lead.email) : message.from_addr;
  const subjectBase = message.subject || proposal?.subject || '';
  const subject = t.reply_subject || (/^re:/i.test(subjectBase) ? subjectBase : `Re: ${subjectBase}`);

  let notice = null;
  if (t.kind === 'auto_reply') {
    const resumed = await resumeIfOnlyAutoReply(item, message);
    const shifted = await shiftFollowupsForAuto(item.proposal_id, t.auto_until);
    const next = shifted && !shifted.followup1_sent_at ? shifted.followup1_due_at : shifted?.followup2_due_at;
    notice = next
      ? `Your follow-ups keep running. The next one moved to ${new Date(next).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: cfg.SEND_TZ })}, after they're back.`
      : resumed ? 'Your follow-ups keep running.' : 'Automatic reply. Nothing to do.';
  }
  const status = t.needs_reply ? 'ready' : 'fyi';
  if (!t.needs_reply && !notice) notice = t.kind === 'not_interested' ? "They're not interested. No reply needed unless you want to." : 'No reply needed.';
  return {
    status, kind: t.kind, label: t.label, summary: t.summary, asks: t.asks, timing: t.timing, mood: t.mood,
    prep: t.prep, suggestions: t.suggestions, notice,
    reply_to: replyTo, reply_subject: t.needs_reply ? subject : null, reply_body: t.needs_reply ? t.reply_body : null,
    ai_original: t.needs_reply ? t.reply_body : null, cost,
  };
}

// ── Worker ────────────────────────────────────────────────────────────────
let working = false;
function kick() { setImmediate(() => work().catch(err => console.error('[inbox] worker error:', err.message))); }

async function work() {
  if (working) return;
  if (!process.env.ANTHROPIC_API_KEY && process.env.NODE_ENV !== 'test') return;
  working = true;
  try {
    for (;;) {
      const { rows } = await pool.query(
        `UPDATE inbox_items SET status = CASE WHEN status = 'rewrite_queued' THEN 'rewriting' ELSE 'triaging' END, error = NULL
          WHERE id = (SELECT id FROM inbox_items WHERE status IN ('queued', 'rewrite_queued')
                       ORDER BY id LIMIT 1 FOR UPDATE SKIP LOCKED)
          RETURNING *`);
      const item = rows[0];
      if (!item) break;
      try {
        const r = await triage(item);
        await pool.query(
          `UPDATE inbox_items SET status = $2, kind = $3, label = $4, summary = $5, asks = $6, timing = $7, mood = $8, prep = $9,
                  suggestions = $10, notice = $11, reply_to = $12, reply_subject = $13, reply_body = $14,
                  ai_original = COALESCE($15, ai_original), cost_usd = COALESCE(cost_usd, 0) + $16, model = $17,
                  triaged_at = NOW(), instructions = NULL, reviewed_at = NULL, error = NULL
            WHERE id = $1`,
          [item.id, r.status, r.kind, r.label, r.summary, JSON.stringify(r.asks || []), r.timing || null, r.mood || null,
           JSON.stringify(r.prep || []), JSON.stringify(r.suggestions || []), r.notice, r.reply_to || null,
           r.reply_subject, r.reply_body, r.ai_original, (r.cost || 0).toFixed(4), cfg.MODEL]);
        console.log(`[inbox] #${item.id} → ${r.status} (${r.kind})`);
      } catch (err) {
        await pool.query(`UPDATE inbox_items SET status = 'failed', error = $2, triaged_at = NOW() WHERE id = $1`, [item.id, err.message.slice(0, 500)]);
        console.error(`[inbox] #${item.id} failed: ${err.message}`);
      }
    }
  } finally {
    working = false;
  }
}

async function recover() {
  await pool.query(`UPDATE inbox_items SET status = 'queued' WHERE status = 'triaging'`);
  await pool.query(`UPDATE inbox_items SET status = 'rewrite_queued' WHERE status = 'rewriting'`);
  await pool.query(`UPDATE inbox_items SET status = 'ready', error = 'Sending was interrupted by a restart. Check Gmail Sent before trying again.'
                     WHERE status = 'sending'`);
  kick();
}

// ── Actions from the CRM ──────────────────────────────────────────────────
const httpError = (msg, status) => Object.assign(new Error(msg), { status });

async function getItem(id) {
  const { rows } = await pool.query(
    `SELECT i.*, p.company, p.contact_name, p.industry, p.city, p.stage, p.fit_score, p.fit_tier, p.email AS lead_email,
            p.do_not_contact, p.archived_at, m.from_addr, m.subject AS message_subject, m.body AS message_body,
            m.received_at, m.thread_id, m.header_message_id, m.is_auto
       FROM inbox_items i JOIN prospects p ON p.id = i.prospect_id JOIN inbox_messages m ON m.id = i.message_id
      WHERE i.id = $1`, [id]);
  return rows[0] || null;
}

async function update(id, patch) {
  const item = await getItem(id);
  if (!item) throw httpError('Not found', 404);
  if (item.status !== 'ready') throw httpError('Only a reply waiting for review can be edited.', 409);
  const sets = []; const vals = [id];
  for (const k of ['reply_body', 'reply_subject', 'reply_to']) {
    if (patch[k] === undefined) continue;
    const v = String(patch[k] ?? '').slice(0, k === 'reply_body' ? 8000 : 300);
    if (k === 'reply_to' && !/^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(v)) throw httpError("That email address doesn't look right.", 400);
    vals.push(v); sets.push(`${k} = $${vals.length}`);
  }
  if (!sets.length) throw httpError('No valid fields', 400);
  await pool.query(`UPDATE inbox_items SET ${sets.join(', ')} WHERE id = $1`, vals);
  return getItem(id);
}

function placeholdersIn(text) { return String(text || '').match(PLACEHOLDER) || []; }

async function sendReply(id) {
  const item = await getItem(id);
  if (!item) throw httpError('Not found', 404);
  if (item.status !== 'ready') throw httpError(`This reply is ${item.status}; only a reply waiting for review can be sent.`, 409);
  if (item.do_not_contact) throw httpError('This lead asked not to be contacted.', 409);
  if (isArchivedLead(item) || isPestCompanyName(item.company || '')) throw httpError('This lead is archived.', 409);
  const body = String(item.reply_body || '').trim();
  if (!body) throw httpError('The reply is empty.', 400);
  const holes = placeholdersIn(body);
  if (holes.length) throw httpError(`Fill in ${holes.join(', ')} before sending.`, 400);
  if (!/^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(item.reply_to || '')) throw httpError('Add a valid "To" address.', 400);
  const s = send();
  if (!(await s.mailMode())) throw httpError('Email is not set up. Go to Settings and click Connect Gmail.', 400);

  const claim = await pool.query(`UPDATE inbox_items SET status = 'sending' WHERE id = $1 AND status = 'ready' RETURNING id`, [id]);
  if (!claim.rows.length) throw httpError('Already sending.', 409);
  let info;
  try {
    const refs = item.header_message_id ? [item.header_message_id] : undefined;
    info = await (await s.mailer()).sendMail({
      from: { name: cfg.SENDER.name, address: cfg.SENDER.email },
      to: item.reply_to,
      subject: item.reply_subject || `Re: ${item.message_subject || ''}`,
      text: body,
      html: require('./email-html').renderHtml(body, { company: item.company }, { footer: false }),
      inReplyTo: item.header_message_id || undefined,
      references: refs,
      threadId: item.thread_id || undefined,
    });
  } catch (err) {
    await pool.query(`UPDATE inbox_items SET status = 'ready', error = $2 WHERE id = $1`, [id, `Send failed: ${err.message}`.slice(0, 500)]);
    throw httpError(`The reply didn't send: ${err.message}`, 502);
  }
  const out = await insertMessage(pool, {
    prospectId: item.prospect_id, proposalId: item.proposal_id, direction: 'out', to: item.reply_to,
    msg: { id: info.id || null, key: info.id ? null : `out:${crypto.randomUUID()}`, threadId: info.threadId || item.thread_id,
      messageIdHeader: info.messageId || null, from: cfg.SENDER.email, subject: item.reply_subject, text: body, date: new Date() },
  });
  await pool.query(`UPDATE inbox_items SET status = 'sent', sent_at = NOW(), sent_message_id = $2, error = NULL, reviewed_at = COALESCE(reviewed_at, NOW()) WHERE id = $1`,
    [id, out?.id || null]);
  await pool.query(`UPDATE prospects SET last_contacted_at = NOW() WHERE id = $1`, [item.prospect_id]);
  await pool.query(`UPDATE prospects SET next_action = NULL, next_action_at = NULL WHERE id = $1 AND next_action = 'Reply to their email'`, [item.prospect_id]);
  await logActivity(item.prospect_id, 'email', `Replied to ${item.reply_to}: "${(item.reply_subject || '').slice(0, 120)}".`);
  return getItem(id);
}

async function setStatus(id, status, note) {
  const item = await getItem(id);
  if (!item) throw httpError('Not found', 404);
  const allowed = { handled: [...NEEDS, 'fyi'], discarded: ['ready', 'failed'] };
  if (!allowed[status].includes(item.status)) throw httpError(`Can't mark a ${item.status} item ${status}.`, 409);
  await pool.query(`UPDATE inbox_items SET status = $2, handled_note = $3, reviewed_at = COALESCE(reviewed_at, NOW()) WHERE id = $1`, [id, status, note || null]);
  if (status === 'handled') {
    await pool.query(`UPDATE prospects SET next_action = NULL, next_action_at = NULL WHERE id = $1 AND next_action = 'Reply to their email'`, [item.prospect_id]);
  }
  return getItem(id);
}

async function reopen(id) {
  const item = await getItem(id);
  if (!item) throw httpError('Not found', 404);
  if (!['handled', 'discarded'].includes(item.status)) throw httpError('Only handled or discarded items can be reopened.', 409);
  const next = item.reply_body ? 'ready' : 'fyi';
  await pool.query(`UPDATE inbox_items SET status = $2, handled_note = NULL WHERE id = $1`, [id, next]);
  return getItem(id);
}

async function rewrite(id, instructions) {
  const item = await getItem(id);
  if (!item) throw httpError('Not found', 404);
  if (!['ready', 'failed', 'fyi'].includes(item.status)) throw httpError(`Can't rewrite a ${item.status} item.`, 409);
  if (item.kind === 'opt_out' || item.kind === 'bounce') throw httpError('No reply is drafted for an opt-out or a bounce.', 409);
  if (item.do_not_contact) throw httpError('This lead asked not to be contacted.', 409);
  if (!process.env.ANTHROPIC_API_KEY && process.env.NODE_ENV !== 'test') throw httpError('Add ANTHROPIC_API_KEY in Railway Variables first.', 400);
  // A failed read with no draft goes back through the normal queue.
  const status = item.status === 'failed' && !item.reply_body ? 'queued' : 'rewrite_queued';
  await pool.query(`UPDATE inbox_items SET status = $2, instructions = $3, triaged_at = NULL, error = NULL WHERE id = $1`,
    [id, status, String(instructions || '').slice(0, 1000) || 'Write a reply.']);
  kick();
  return getItem(id);
}

async function applySuggestion(id, index) {
  const item = await getItem(id);
  if (!item) throw httpError('Not found', 404);
  const s = (item.suggestions || [])[index];
  if (!s) throw httpError('No such suggestion.', 404);
  if (item.applied && item.applied[index]) return getItem(id);
  if (s.action === 'set_stage') {
    if (!STAGES.includes(s.stage)) throw httpError('Bad stage.', 400);
    const { rows } = await pool.query('SELECT stage FROM prospects WHERE id = $1', [item.prospect_id]);
    if (rows[0] && rows[0].stage !== s.stage) {
      await pool.query('UPDATE prospects SET stage = $2 WHERE id = $1', [item.prospect_id, s.stage]);
      await logActivity(item.prospect_id, 'stage_change', `${rows[0].stage} → ${s.stage} (from inbox)`);
    }
  } else if (s.action === 'remind') {
    if (!validDate(s.date)) throw httpError('Bad date.', 400);
    await pool.query('UPDATE prospects SET next_action = $2, next_action_at = $3 WHERE id = $1', [item.prospect_id, s.text || s.label, s.date]);
  } else if (s.action === 'add_note') {
    await logActivity(item.prospect_id, 'note', s.text);
  } else {
    throw httpError('Unknown action.', 400);
  }
  await pool.query(`UPDATE inbox_items SET applied = applied || jsonb_build_object($2::text, NOW()) WHERE id = $1`, [id, String(index)]);
  return getItem(id);
}

async function markSeen(id) {
  await pool.query(`UPDATE inbox_items SET reviewed_at = COALESCE(reviewed_at, NOW()) WHERE id = $1`, [id]);
}

// ── Lists ─────────────────────────────────────────────────────────────────
const LIST_COLS = `i.id, i.prospect_id, i.proposal_id, i.status, i.kind, i.label, i.summary, i.reviewed_at, i.created_at,
  i.updated_at, i.sent_at, i.error, m.from_addr, m.subject AS message_subject, left(m.body, 200) AS preview, m.received_at,
  p.company, p.contact_name, p.fit_score, p.fit_tier`;
const VIEW_WHERE = {
  needs: `i.status = ANY('{queued,triaging,rewrite_queued,rewriting,ready,failed,sending}')`,
  fyi: `i.status = 'fyi'`,
  handled: `i.status = ANY('{sent,handled,discarded}')`,
};
const visible = `p.archived_at IS NULL`;

async function list(view = 'needs') {
  const where = VIEW_WHERE[view] || VIEW_WHERE.needs;
  const order = view === 'handled' ? 'i.updated_at DESC' : 'm.received_at DESC';
  const { rows } = await pool.query(
    `SELECT ${LIST_COLS} FROM inbox_items i JOIN inbox_messages m ON m.id = i.message_id JOIN prospects p ON p.id = i.prospect_id
      WHERE ${where} AND ${visible} ORDER BY ${order} LIMIT 200`);
  return rows;
}

async function counts() {
  const { rows } = await pool.query(
    `SELECT
       COUNT(*) FILTER (WHERE ${VIEW_WHERE.needs})::int AS needs,
       COUNT(*) FILTER (WHERE ${VIEW_WHERE.fyi})::int AS fyi,
       COUNT(*) FILTER (WHERE ${VIEW_WHERE.handled})::int AS handled,
       COUNT(*) FILTER (WHERE i.status IN ('queued', 'triaging', 'rewrite_queued', 'rewriting'))::int AS working,
       COUNT(*) FILTER (WHERE i.status IN ('ready', 'failed') OR (i.status = 'fyi' AND i.reviewed_at IS NULL))::int AS waiting
       FROM inbox_items i JOIN prospects p ON p.id = i.prospect_id WHERE ${visible}`);
  return rows[0];
}

async function detail(id) {
  const item = await getItem(id);
  if (!item) return null;
  const thread = await threadFor(item.prospect_id);
  const proposal = item.proposal_id
    ? (await pool.query('SELECT id, subject, version, slug, status FROM proposals WHERE id = $1', [item.proposal_id])).rows[0] || null
    : null;
  return { ...item, thread, proposal, placeholders: placeholdersIn(item.reply_body) };
}

// ── Replies Kelby sent straight from Gmail ───────────────────────────────
/** Mark open items handled when Kelby already replied in the same Gmail thread. */
async function applySentMessages(sentMessages) {
  let handled = 0;
  for (const msg of sentMessages) {
    if (!msg.threadId) continue;
    const { rows } = await pool.query(
      `SELECT i.id, i.prospect_id, i.proposal_id, m.received_at FROM inbox_items i JOIN inbox_messages m ON m.id = i.message_id
        WHERE m.thread_id = $1 AND i.status = ANY('{queued,ready,failed,fyi}') ORDER BY m.received_at DESC LIMIT 1`, [msg.threadId]);
    const it = rows[0];
    if (!it || (msg.date && new Date(msg.date) <= new Date(it.received_at))) continue;
    const out = await insertMessage(pool, { prospectId: it.prospect_id, proposalId: it.proposal_id, direction: 'out', msg, to: msg.to || null });
    if (!out) continue; // already recorded (e.g. sent from the CRM)
    await pool.query(`UPDATE inbox_items SET status = 'handled', handled_note = 'You replied from Gmail', reviewed_at = COALESCE(reviewed_at, NOW()) WHERE id = $1`, [it.id]);
    await logActivity(it.prospect_id, 'email', 'Replied from Gmail.');
    handled++;
  }
  return handled;
}

module.exports = {
  recordInbound, alreadyRecorded, dedupeKey, threadFor, work, recover, kick, list, counts, detail, update, sendReply,
  setStatus, reopen, rewrite, applySuggestion, markSeen, applySentMessages, cleanTriage, placeholdersIn,
  isWorking: () => working,
};
