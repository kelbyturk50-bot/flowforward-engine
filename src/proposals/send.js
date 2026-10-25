// Sending and follow-up. Email goes out through Gmail (flowforward50@gmail.com)
// with an app password, so every message also lands in that account's Sent
// folder and replies land in its inbox like normal.
//
// Flow: Kelby approves a draft in the CRM → first email goes out now →
// follow-up 1 and 2 go out as replies in the same thread on day 3 and day 10
// (weekdays, 8am–5pm Denver) unless the lead replies, books on Calendly,
// bounces, opts out, or Kelby moves them forward/stops the sequence.

const nodemailer = require('nodemailer');
const pool = require('../db/client');
const cfg  = require('./config');
const { appendCompanyPestExclusion, isPestCompanyName, PEST_NAME_REASON } = require('../scoring/industry');
const { ARCHIVED_LEAD_REASON, isArchivedLead } = require('../db/pest-archive');

const { SENDER } = cfg;
const ACTIVE_STAGES_TO_STOP = ['responded', 'qualified', 'proposal', 'won', 'lost', 'disqualified'];
const GENERIC_DOMAINS = ['gmail.com', 'yahoo.com', 'hotmail.com', 'outlook.com', 'icloud.com', 'aol.com', 'live.com', 'msn.com', 'comcast.net', 'me.com', 'protonmail.com'];

const gmail = require('./gmail');

// How mail goes out: the Gmail API (HTTPS) when Gmail is connected in Settings;
// otherwise SMTP with an app password (only works on Railway Pro, which allows SMTP).
let transport = null;
let testTransport = null;
async function mailMode() {
  if (testTransport) return 'test';
  if ((await gmail.status()).connected) return 'gmail_api';
  if (cfg.mailConfigured()) return 'smtp';
  return null;
}
async function mailer() {
  const mode = await mailMode();
  if (mode === 'test') return testTransport;
  if (mode === 'gmail_api') return gmail;
  if (mode === 'smtp') {
    if (!transport) {
      transport = nodemailer.createTransport({
        service: 'gmail',
        auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_APP_PASSWORD },
        connectionTimeout: 20000,
      });
    }
    return transport;
  }
  throw new Error('Email is not set up. Go to Settings and click Connect Gmail.');
}
// Tests swap in a fake transport. Refuses to run outside the test process.
function _setTransport(t) {
  if (process.env.NODE_ENV !== 'test') {
    throw new Error('_setTransport is only available when NODE_ENV=test');
  }
  testTransport = t;
}

const onepagerUrl = (p) => `${cfg.PUBLIC_BASE_URL}/p/${p.slug}`;

function fillPlaceholders(text, p) {
  return String(text || '')
    .replace(/\{\{\s*ONEPAGER_URL\s*\}\}/g, onepagerUrl(p))
    .replace(/\{\{\s*CALENDLY_URL\s*\}\}/g, SENDER.calendly);
}

// CAN-SPAM: sender identity, physical address and a working way to opt out.
function footer() {
  return `\n\n--\n${SENDER.company} · ${SENDER.address}\nNot interested? Reply "no thanks" and I won't reach out again.`;
}

// Prototype link. Callers set p.prototype_url to a live link (or leave it
// unset). A {{PROTOTYPE_URL}} placeholder written in the copy is used as-is;
// otherwise the first email gets a short line after the one-pager link and
// follow-up 1 gets one before the sign-off. Follow-up 2 is left alone.
// With no live link, lines holding the placeholder are dropped.
const PROTO_RE = /\{\{\s*PROTOTYPE_URL\s*\}\}/;
const shopName = (p) => String(p.company || '').replace(/^test:\s*/i, '').trim() || 'your shop';

function protoLine(which, p) {
  return which === 'first'
    ? `I also built a quick clickable prototype of what this could look like for ${shopName(p)}, on sample data:\n${p.prototype_url}`
    : `If it's easier to see than read about, here's the clickable prototype I put together for ${shopName(p)}:\n${p.prototype_url}`;
}

// Insert a paragraph before the sign-off (the last paragraph), or at the end.
function beforeSignoff(text, para) {
  const trimmed = text.replace(/\s+$/, '');
  const parts = trimmed.split(/\n{2,}/);
  if (parts.length < 2) {
    // One block: a short last line with no sentence punctuation is the sign-off.
    const lines = trimmed.split('\n');
    const last = lines[lines.length - 1] || '';
    if (lines.length > 1 && last.length <= 30 && !/[.?!:]$/.test(last)) {
      return `${lines.slice(0, -1).join('\n')}\n\n${para}\n\n${last}`;
    }
    return `${trimmed}\n\n${para}`;
  }
  parts.splice(parts.length - 1, 0, para);
  return parts.join('\n\n');
}

function withPrototype(text, p, which) {
  const raw = String(text || '');
  if (PROTO_RE.test(raw)) {
    if (p.prototype_url) return raw.replace(new RegExp(PROTO_RE.source, 'g'), p.prototype_url);
    return raw.split('\n').filter(line => !PROTO_RE.test(line)).join('\n').replace(/\n{3,}/g, '\n\n');
  }
  if (!p.prototype_url || !raw.trim() || which === 'followup2') return raw;
  const line = protoLine(which, p);
  if (which === 'first') {
    const lines = raw.split('\n');
    const at = lines.findIndex(l => /\{\{\s*ONEPAGER_URL\s*\}\}/.test(l));
    if (at >= 0) {
      lines.splice(at + 1, 0, '', line);
      return lines.join('\n');
    }
  }
  return beforeSignoff(raw, line);
}

// Booking link (Kelby, Oct 20): the first email always ends with a direct
// calendar link before the sign-off, unless the copy already has one.
const BOOK_RE = /\{\{\s*CALENDLY_URL\s*\}\}/;
const BOOK_LINE = "My calendar is here if that's easier: {{CALENDLY_URL}}";
function withBooking(text, which) {
  const raw = String(text || '');
  if (which !== 'first' || !raw.trim() || !SENDER.calendly) return raw;
  if (BOOK_RE.test(raw) || raw.includes(SENDER.calendly)) return raw;
  return beforeSignoff(raw, BOOK_LINE);
}

function composed(p, which) {
  const text = which === 'first' ? p.body : which === 'followup1' ? p.followup1 : p.followup2;
  return fillPlaceholders(withBooking(withPrototype(text, p, which), which), p);
}

// The lines the system adds to the copy Kelby wrote, for the CRM preview.
function addedLines(p, which) {
  const text = which === 'first' ? p.body : which === 'followup1' ? p.followup1 : p.followup2;
  if (!String(text || '').trim()) return [];
  const out = [];
  if (p.prototype_url && !PROTO_RE.test(text) && which !== 'followup2') {
    out.push({ where: which === 'first' ? 'after the one-pager link' : 'before your sign-off', text: protoLine(which, p) });
  }
  if (withBooking(text, which) !== String(text)) {
    out.push({ where: 'before your sign-off', text: fillPlaceholders(BOOK_LINE, p) });
  }
  return out;
}

function renderMessage(p, which) {
  return composed(p, which) + footer();
}

// The HTML part sent alongside the plain text: same words, short link text
// instead of raw URLs, and a signature with the FlowForward logo.
function renderMessageHtml(p, which) {
  return require('./email-html').renderHtml(composed(p, which), p);
}

// Sets p.prototype_url to the lead's live prototype link, if any. A lookup
// failure never blocks an email; it just goes without the link.
async function attachPrototypeUrl(p) {
  try {
    const link = await require('../prototypes/store').liveLink(p.prospect_id);
    p.prototype_url = link ? link.url : null;
  } catch (err) {
    console.error('[prototype] email link lookup failed:', err && err.code);
    p.prototype_url = null;
  }
  return p;
}

// "Now" in the sending timezone → { hour, weekday (0=Sun), date 'YYYY-MM-DD' }
function localNow(d = new Date()) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: cfg.SEND_TZ, hour: 'numeric', hourCycle: 'h23', weekday: 'short', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(d).map(x => [x.type, x.value]));
  const wd = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(parts.weekday);
  return { hour: Number(parts.hour), weekday: wd, date: `${parts.year}-${parts.month}-${parts.day}` };
}
function inSendWindow(d = new Date()) {
  const { hour, weekday } = localNow(d);
  const [start, end] = cfg.SEND_HOURS;
  return cfg.SEND_DAYS.includes(weekday) && hour >= start && hour < end;
}

async function sentToday() {
  const { date } = localNow();
  const { rows } = await pool.query(
    `SELECT
       (SELECT COUNT(*) FROM proposals WHERE (sent_at AT TIME ZONE $2)::date = $1::date) +
       (SELECT COUNT(*) FROM proposals WHERE (followup1_sent_at AT TIME ZONE $2)::date = $1::date) +
       (SELECT COUNT(*) FROM proposals WHERE (followup2_sent_at AT TIME ZONE $2)::date = $1::date) AS n`,
    [date, cfg.SEND_TZ]);
  return Number(rows[0].n);
}

async function sendReadiness() {
  const problems = [];
  const mode = await mailMode();
  if (!mode) {
    problems.push(gmail.clientConfigured()
      ? 'Connect Gmail: go to Settings and click Connect Gmail.'
      : 'Set up Gmail sending: add GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in Railway, then click Connect Gmail in Settings.');
  }
  if (!SENDER.address) problems.push('Add SENDER_ADDRESS (a mailing address for the email footer; the law requires one).');
  return problems;
}

const validEmail = (x) => /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(x || '');

/** Approve a draft and send the first email now. */
async function approveAndSend(proposalId) {
  const { rows } = await pool.query(
    `SELECT pr.*, p.company, p.stage, p.do_not_contact, p.archived_at FROM proposals pr JOIN prospects p ON p.id = pr.prospect_id WHERE pr.id = $1`,
    [proposalId]);
  const p = rows[0];
  if (!p) throw Object.assign(new Error('Proposal not found'), { status: 404 });
  // Legacy drafts can belong to a pest-named lead. Refuse before the claim
  // UPDATE and before mailer() is called.
  if (isPestCompanyName(p.company)) {
    throw Object.assign(new Error(`${PEST_NAME_REASON}.`), { status: 409 });
  }
  if (isArchivedLead(p)) {
    throw Object.assign(new Error(`${ARCHIVED_LEAD_REASON}.`), { status: 409 });
  }

  const problems = await sendReadiness();
  if (problems.length) throw Object.assign(new Error(problems.join(' ')), { status: 400 });
  if (p.status !== 'draft') throw Object.assign(new Error(`This version is ${p.status}; only drafts can be sent.`), { status: 409 });
  if (p.do_not_contact) throw Object.assign(new Error(`${p.company} is marked do-not-contact.`), { status: 409 });
  if (!validEmail(p.to_email)) throw Object.assign(new Error('Add a valid "To" email before sending.'), { status: 400 });
  if (!p.subject?.trim() || !p.body?.trim()) throw Object.assign(new Error('Subject and email body are required.'), { status: 400 });
  if (await sentToday() >= cfg.SEND_DAILY_LIMIT) {
    throw Object.assign(new Error(`Daily send limit (${cfg.SEND_DAILY_LIMIT}) reached. Try again tomorrow.`), { status: 429 });
  }

  // Claim the row first so a double-click can't send twice.
  // A flagged lead is not claimable, even if the earlier read was stale.
  const claim = await pool.query(
    `UPDATE proposals SET status = 'sending', approved_at = NOW()
      WHERE id = $1 AND status = 'draft'
        AND NOT (SELECT do_not_contact FROM prospects WHERE id = proposals.prospect_id)
      RETURNING id`,
    [p.id]
  );
  if (!claim.rows.length) {
    const blocked = await pool.query('SELECT do_not_contact FROM prospects WHERE id = $1', [p.prospect_id]);
    if (blocked.rows[0] && blocked.rows[0].do_not_contact) {
      throw Object.assign(new Error(`${p.company} is marked do-not-contact.`), { status: 409 });
    }
    throw Object.assign(new Error('Already sending.'), { status: 409 });
  }

  // The prototype link's 14 days start when it is first shared.
  try { await require('../prototypes/store').restartClock(p.prospect_id); } catch (err) { console.error('[prototype] clock restart failed:', err && err.code); }
  await attachPrototypeUrl(p);

  const beforeSend = await pool.query('SELECT do_not_contact FROM prospects WHERE id = $1', [p.prospect_id]);
  if (beforeSend.rows[0] && beforeSend.rows[0].do_not_contact) {
    await pool.query(
      `UPDATE proposals SET status = 'stopped', stop_reason = $2 WHERE id = $1 AND status = 'sending'`,
      [p.id, 'Lead is do-not-contact']
    );
    throw Object.assign(new Error(`${p.company} is marked do-not-contact.`), { status: 409 });
  }

  let info;
  try {
    info = await (await mailer()).sendMail({
      from: { name: SENDER.name, address: SENDER.email },
      to: p.to_name ? { name: p.to_name, address: p.to_email } : p.to_email,
      subject: p.subject.trim(),
      text: renderMessage(p, 'first'),
      html: renderMessageHtml(p, 'first'),
      headers: { 'List-Unsubscribe': `<mailto:${SENDER.email}?subject=unsubscribe>` },
    });
  } catch (err) {
    // A stop during the send leaves the row stopped. This revert matches
    // 'sending' only, so it cannot put a stopped proposal back to draft.
    await pool.query(
      `UPDATE proposals SET status = 'draft', approved_at = NULL, error = $2
        WHERE id = $1 AND status = 'sending'`,
      [p.id, `Send failed: ${err.message}`]
    );
    throw Object.assign(new Error(`The email didn't send: ${err.message}`), { status: 502 });
  }

  const [d1, d2] = cfg.FOLLOWUP_DAYS;
  const { rows: updated } = await pool.query(
    `UPDATE proposals SET status = 'sent', sent_at = NOW(), message_id = $2, thread_id = $5, error = NULL,
            followup1_due_at = CASE WHEN COALESCE(followup1, '') <> '' THEN NOW() + make_interval(days => $3) END,
            followup2_due_at = CASE WHEN COALESCE(followup2, '') <> '' THEN NOW() + make_interval(days => $4) END
      WHERE id = $1 AND status = 'sending' RETURNING *`,
    [p.id, info.messageId || null, d1 ?? 3, d2 ?? 10, info.threadId || null]);
  if (!updated.length) {
    const current = await pool.query('SELECT status FROM proposals WHERE id = $1', [p.id]);
    if (current.rows[0] && current.rows[0].status === 'stopped') {
      // The message went out. Keep stopped: no sent status and no follow-up
      // dates. sent_at counts toward the daily cap. A row that is no longer
      // stopped is left alone, including its sent_at and message ids.
      const { rows: tracked } = await pool.query(
        `UPDATE proposals
            SET sent_at = NOW(), message_id = $2, thread_id = $3, error = NULL
          WHERE id = $1 AND status = 'stopped'
          RETURNING *`,
        [p.id, info.messageId || null, info.threadId || null]
      );
      if (!tracked.length) return current.rows[0];
      await pool.query(
        `UPDATE prospects SET last_contacted_at = NOW() WHERE id = $1`,
        [p.prospect_id]
      );
      await logActivity(
        p.prospect_id,
        'email',
        `Sent proposal v${p.version} to ${p.to_email}. The message went out and the sequence stayed stopped.`
      );
      console.log('[send] delivered after the proposal was stopped');
      return tracked[0];
    }
    return current.rows[0] || null;
  }

  await pool.query(
    `UPDATE prospects SET last_contacted_at = NOW(), email = COALESCE(NULLIF(email, ''), $2),
            stage = CASE WHEN stage IN ('found', 'qualified') THEN 'contacted' ELSE stage END
      WHERE id = $1`, [p.prospect_id, p.to_email]);
  if (['found', 'qualified'].includes(p.stage)) {
    await logActivity(p.prospect_id, 'stage_change', `${p.stage} → contacted (proposal email sent)`);
  }
  await logActivity(p.prospect_id, 'email', `Sent proposal v${p.version} to ${p.to_email}: "${p.subject.trim()}". Follow-ups scheduled for day ${d1} and day ${d2}.`);
  return updated[0];
}

async function logActivity(prospectId, type, body) {
  await pool.query(`INSERT INTO prospect_activities (prospect_id, type, body) VALUES ($1, $2, $3)`, [prospectId, type, body]);
}

async function stopSequence(proposalId, reason, status = 'stopped', db = pool) {
  const { rows } = await db.query(
    `UPDATE proposals SET status = $2, stop_reason = $3 WHERE id = $1 AND status IN ('sent', 'draft') RETURNING *`,
    [proposalId, status, reason]);
  return rows[0] || null;
}

// Same status and stop_reason write as stopSequence, and also 'sending'.
// db is the caller's client so the route can keep this inside its transaction.
let leadStop = null;
async function stopLeadSequences(db, prospectId, reason) {
  if (leadStop) return leadStop(db, prospectId, reason);
  const { rows } = await db.query(
    `SELECT id, status FROM proposals
      WHERE prospect_id = $1 AND status IN ('sent', 'draft', 'sending')
      FOR UPDATE`,
    [prospectId]
  );
  for (const proposal of rows) {
    if (proposal.status === 'sending') {
      await db.query(
        `UPDATE proposals SET status = 'stopped', stop_reason = $2 WHERE id = $1 AND status = 'sending'`,
        [proposal.id, reason]
      );
    } else {
      await stopSequence(proposal.id, reason, 'stopped', db);
    }
  }
}

function _setLeadStop(fn) {
  if (process.env.NODE_ENV !== 'test') {
    throw new Error('_setLeadStop is only available when NODE_ENV=test');
  }
  leadStop = fn || null;
}

// Opt-out raises the flag in its own transaction and locks the prospect row
// first, so a manual clear or set cannot pass the row while this is open.
// Sequence stops run on this client after the flag write. A failure rolls
// the flag back. proposalId, when set, is the replied proposal and becomes
// opted_out before siblings are stopped, so it is not rewritten to stopped.
let optOutGate = null;
// Runs after a follow-up claim commits and before the do-not-contact recheck.
// Tests use it to call the real flag route or the inbox opt-out.
let followupClaimGate = null;
async function markOptOut(prospectId, proposalId) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT id FROM prospects WHERE id = $1 FOR UPDATE', [prospectId]);
    if (optOutGate) await optOutGate(client, prospectId);
    await client.query(
      `UPDATE prospects
          SET do_not_contact = TRUE, do_not_contact_source = 'opt_out', stage = 'lost'
        WHERE id = $1`,
      [prospectId]
    );
    if (proposalId != null) {
      await stopSequence(proposalId, 'Asked not to be contacted', 'opted_out', client);
    }
    await stopLeadSequences(client, prospectId, 'Asked not to be contacted');
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

function _setOptOutGate(fn) {
  if (process.env.NODE_ENV !== 'test') {
    throw new Error('_setOptOutGate is only available when NODE_ENV=test');
  }
  optOutGate = fn || null;
}

function _setFollowupClaimGate(fn) {
  if (process.env.NODE_ENV !== 'test') {
    throw new Error('_setFollowupClaimGate is only available when NODE_ENV=test');
  }
  followupClaimGate = fn || null;
}

/** Send any follow-ups that are due. Called every 15 minutes. */
async function sendDueFollowups() {
  if (!(await mailMode()) || !SENDER.address || !inSendWindow()) return { sent: 0 };
  // Exclude pest names in SQL. A JS skip after LIMIT 25 would fill the batch
  // with rows that are never sent and starve every other sequence. The
  // predicate does not update those rows.
  const params = [];
  const nameSql = appendCompanyPestExclusion(params);
  const { rows } = await pool.query(
    `SELECT pr.*, p.company, p.stage, p.do_not_contact, p.archived_at FROM proposals pr JOIN prospects p ON p.id = pr.prospect_id
      WHERE pr.status = 'sent' AND (
            (pr.followup1_sent_at IS NULL AND pr.followup1_due_at <= NOW()) OR
            (pr.followup1_sent_at IS NOT NULL AND pr.followup2_sent_at IS NULL AND pr.followup2_due_at <= NOW()))
        AND ${nameSql}
        AND p.archived_at IS NULL
      ORDER BY pr.sent_at LIMIT 25`,
    params);
  let sent = 0;
  for (const p of rows) {
    // A sequence created before the name gate can still be due. Skip it
    // without claiming the row or calling the transport. The log has no name,
    // address, or id.
    if (isPestCompanyName(p.company)) {
      console.error('[send] skipped follow-up: company name matches pest control');
      continue;
    }
    if (isArchivedLead(p)) {
      console.error('[send] skipped follow-up: lead is archived');
      continue;
    }
    if (p.do_not_contact || ACTIVE_STAGES_TO_STOP.includes(p.stage)) {
      await stopSequence(p.id, p.do_not_contact ? 'Lead is do-not-contact' : `Lead moved to ${p.stage}`);
      continue;
    }
    if (await sentToday() >= cfg.SEND_DAILY_LIMIT) break;
    const which = p.followup1_sent_at ? 'followup2' : 'followup1';
    const claim = await pool.query(
      `UPDATE proposals SET ${which}_sent_at = NOW()
        WHERE id = $1 AND ${which}_sent_at IS NULL AND status = 'sent'
          AND NOT (SELECT do_not_contact FROM prospects WHERE id = proposals.prospect_id)
        RETURNING id`,
      [p.id]
    );
    if (!claim.rows.length) continue;
    if (followupClaimGate) await followupClaimGate(p, which);
    await attachPrototypeUrl(p);
    const beforeSend = await pool.query('SELECT do_not_contact FROM prospects WHERE id = $1', [p.prospect_id]);
    if (beforeSend.rows[0] && beforeSend.rows[0].do_not_contact) {
      // One row. The claim timestamp is always cleared. Status and
      // stop_reason change only while the row is still sent, so a stopped
      // or opted_out row keeps that status. SET reads the old status.
      await pool.query(
        `UPDATE proposals
            SET ${which}_sent_at = NULL,
                status = CASE WHEN status = 'sent' THEN 'stopped' ELSE status END,
                stop_reason = CASE WHEN status = 'sent' THEN $2 ELSE stop_reason END
          WHERE id = $1`,
        [p.id, 'Lead is do-not-contact']
      );
      continue;
    }
    try {
      await (await mailer()).sendMail({
        threadId: p.thread_id || undefined,
        from: { name: SENDER.name, address: SENDER.email },
        to: p.to_name ? { name: p.to_name, address: p.to_email } : p.to_email,
        subject: /^re:/i.test(p.subject) ? p.subject : `Re: ${p.subject}`,
        text: renderMessage(p, which),
        html: renderMessageHtml(p, which),
        inReplyTo: p.message_id || undefined,
        references: p.message_id ? [p.message_id] : undefined,
        headers: { 'List-Unsubscribe': `<mailto:${SENDER.email}?subject=unsubscribe>` },
      });
      sent++;
      await pool.query(`UPDATE prospects SET last_contacted_at = NOW() WHERE id = $1`, [p.prospect_id]);
      await logActivity(p.prospect_id, 'email', `Sent ${which === 'followup1' ? 'follow-up 1' : 'follow-up 2 (last)'} to ${p.to_email}.`);
    } catch (err) {
      await pool.query(`UPDATE proposals SET ${which}_sent_at = NULL, error = $2 WHERE id = $1`, [p.id, `Follow-up failed: ${err.message}`]);
      console.error(`[send] ✗ follow-up for #${p.id}: ${err.message}`);
    }
  }
  // Sequences with no reply two weeks after the last follow-up are finished.
  // Archived leads stay sent. This update does not write their status or
  // next_action.
  const done = await pool.query(
    `UPDATE proposals pr
        SET status = 'finished', stop_reason = 'No reply after the follow-ups'
       FROM prospects p
      WHERE pr.prospect_id = p.id
        AND p.archived_at IS NULL
        AND pr.status = 'sent'
        AND COALESCE(pr.followup2_sent_at, pr.followup1_sent_at, pr.sent_at) < NOW() - INTERVAL '14 days'
        AND (pr.followup2_due_at IS NULL OR pr.followup2_sent_at IS NOT NULL)
        AND (pr.followup1_due_at IS NULL OR pr.followup1_sent_at IS NOT NULL)
      RETURNING pr.prospect_id`);
  for (const r of done.rows) {
    await pool.query(`UPDATE prospects SET next_action = COALESCE(NULLIF(next_action, ''), 'No reply to emails — try a call'),
                             next_action_at = COALESCE(next_action_at, CURRENT_DATE) WHERE id = $1`, [r.prospect_id]);
  }
  return { sent, finished: done.rowCount };
}

// ─── Inbox watching ───────────────────────────────────────────────────────
// Out-of-office and other automatic replies: never stop a sequence for these.
const AUTO_SUBJECT = /^\s*(automatic reply|auto(matic)?[- ]?(reply|response)|out of (the )?office|ooo\b|away from (the )?office|on vacation)/i;
const OPT_OUT = /\b(unsubscribe|remove me|take me off|stop (emailing|contacting)|no thanks|not interested|do not (email|contact)|don'?t (email|contact))\b/i;

function domainOf(email) { return String(email || '').split('@')[1]?.toLowerCase() || ''; }

/** Decide what an incoming message means for an active proposal (pure, testable). */
function classifyMessage(msg, p) {
  const from = (msg.from || '').toLowerCase();
  const to = p.to_email.toLowerCase();
  const text = (msg.text || '').slice(0, 20000);
  const textLower = text.toLowerCase();
  const refs = [msg.inReplyTo, ...(msg.references || [])].filter(Boolean).map(s => s.toLowerCase());
  const threaded = (p.message_id && refs.includes(p.message_id.toLowerCase())) ||
                   (!!p.thread_id && !!msg.threadId && msg.threadId === p.thread_id);

  if (/mailer-daemon|postmaster|mail delivery subsystem/i.test(from + ' ' + (msg.subject || '')) && (textLower.includes(to) || threaded)) {
    return { kind: 'bounced' };
  }
  if (/calendly\.com/.test(from) && textLower.includes(to)) return { kind: 'booked' };

  const dom = domainOf(to);
  const sameSender = from === to || (dom && !GENERIC_DOMAINS.includes(dom) && domainOf(from) === dom);
  if ((sameSender || threaded) && (msg.auto || AUTO_SUBJECT.test(msg.subject || ''))) return { kind: 'auto' };
  if (sameSender || threaded) {
    const fresh = text.split(/\n\s*On .{5,200}wrote:|\n-{2,}\s*Original Message|\n>/)[0];
    return { kind: OPT_OUT.test(fresh) || /^\s*(stop|unsubscribe)\s*$/im.test(fresh) || /unsubscribe/i.test(msg.subject || '') ? 'opted_out' : 'replied',
             snippet: fresh.replace(/\s+/g, ' ').trim().slice(0, 240) };
  }
  return null;
}

async function applyOutcome(p, outcome, msg) {
  await applyOutcomeEffects(p, outcome, msg);
  // Keep the whole message and open an inbox item (Claude reads it and drafts a reply).
  try {
    await require('./inbox').recordInbound(p, outcome.kind, { ...msg, auto: msg.auto || outcome.kind === 'auto' });
  } catch (err) {
    console.error('[inbox] could not record message:', err.message);
  }
}

async function applyOutcomeEffects(p, outcome, msg) {
  const { kind, snippet } = outcome;
  if (kind === 'auto') {
    await logActivity(p.prospect_id, 'email', 'Got an automatic reply (out of office). Follow-ups keep running.');
    return;
  }
  if (kind === 'bounced') {
    await stopSequence(p.id, `Bounced: ${p.to_email} did not accept the message`, 'bounced');
    await pool.query(`UPDATE prospects SET email = NULL WHERE id = $1 AND email = $2`, [p.prospect_id, p.to_email]);
    await logActivity(p.prospect_id, 'note', `Proposal email to ${p.to_email} bounced. Follow-ups stopped; find another address or call.`);
    return;
  }
  if (kind === 'opted_out') {
    await markOptOut(p.prospect_id, p.id);
    await logActivity(p.prospect_id, 'email', `Replied asking not to be contacted${snippet ? `: "${snippet}"` : ''}. Marked do-not-contact.`);
    return;
  }
  const reason = kind === 'booked' ? 'Booked a call on Calendly' : 'They replied';
  await pool.query(`UPDATE proposals SET status = 'replied', replied_at = $2, stop_reason = $3 WHERE id = $1 AND status = 'sent'`,
    [p.id, msg.date || new Date(), reason]);
  await pool.query(
    `UPDATE prospects SET stage = CASE WHEN stage IN ('found', 'contacted') THEN 'responded' ELSE stage END,
            next_action = $2, next_action_at = CURRENT_DATE WHERE id = $1`,
    [p.prospect_id, kind === 'booked' ? 'Prep for the consultation call' : 'Reply to their email']);
  if (['found', 'contacted'].includes(p.stage)) await logActivity(p.prospect_id, 'stage_change', `${p.stage} → responded`);
  await logActivity(p.prospect_id, 'email', kind === 'booked' ? 'Booked a consultation on Calendly. Follow-ups stopped.'
    : `Replied to the proposal email${snippet ? `: "${snippet}"` : ''}. Follow-ups stopped.`);
}

// Pull inbox messages since a date: Gmail API when connected, else IMAP.
async function fetchInbox(since) {
  if ((await mailMode()) === 'gmail_api') return gmail.inboxSince(since);
  const { ImapFlow } = require('imapflow');
  const { simpleParser } = require('mailparser');
  const imap = new ImapFlow({
    host: 'imap.gmail.com', port: 993, secure: true, logger: false,
    auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_APP_PASSWORD },
  });
  const out = [];
  try {
    await imap.connect();
    const lock = await imap.getMailboxLock('INBOX');
    try {
      const uids = await imap.search({ since }, { uid: true });
      const recent = (uids || []).slice(-400);
      if (recent.length) {
        for await (const m of imap.fetch(recent, { uid: true, envelope: true, source: true }, { uid: true })) {
          let parsed;
          try { parsed = await simpleParser(m.source, { skipHtmlToText: false, skipImageLinks: true }); } catch { continue; }
          out.push({
            from: (m.envelope?.from?.[0]?.address || '').toLowerCase(), subject: m.envelope?.subject || '',
            date: m.envelope?.date ? new Date(m.envelope.date) : null,
            inReplyTo: parsed.inReplyTo || '', references: [].concat(parsed.references || []), text: parsed.text || '',
          });
        }
      }
    } finally { lock.release(); }
    await imap.logout();
  } catch (err) {
    try { await imap.close(); } catch { /* already closed */ }
    throw err;
  }
  return out;
}

let checking = false;
// Sent proposals, including archived leads. Opt-outs and bounces are still
// recorded while a lead is archived. A reply or booking is not: that would
// write status and next_action, which stay with the finisher and the send path.
async function inboxCandidates() {
  const { rows } = await pool.query(
    `SELECT pr.*, p.stage, p.archived_at, p.company, p.do_not_contact
       FROM proposals pr JOIN prospects p ON p.id = pr.prospect_id
      WHERE pr.status = 'sent' AND pr.to_email IS NOT NULL`);
  return rows;
}

// Proposals already in a conversation (they replied before). New messages in
// those threads go to the inbox too, without touching the proposal's status.
async function conversationCandidates() {
  const { rows } = await pool.query(
    `SELECT pr.*, p.stage, p.archived_at, p.company, p.do_not_contact
       FROM proposals pr JOIN prospects p ON p.id = pr.prospect_id
      WHERE pr.status = 'replied' AND pr.to_email IS NOT NULL AND p.archived_at IS NULL
        AND COALESCE(pr.replied_at, pr.sent_at) > NOW() - INTERVAL '60 days'`);
  return rows;
}

// A later message from someone already in a conversation.
async function applyFollowOn(p, outcome, msg) {
  const inbox = require('./inbox');
  if (await inbox.alreadyRecorded(msg)) return false;
  if (outcome.kind === 'opted_out') {
    await markOptOut(p.prospect_id);
    await logActivity(p.prospect_id, 'email', 'Asked not to be contacted. Marked do-not-contact.');
  } else if (outcome.kind === 'replied' || outcome.kind === 'booked') {
    await pool.query(`UPDATE prospects SET next_action = $2, next_action_at = CURRENT_DATE WHERE id = $1`,
      [p.prospect_id, outcome.kind === 'booked' ? 'Prep for the consultation call' : 'Reply to their email']);
    await logActivity(p.prospect_id, 'email', outcome.kind === 'booked' ? 'Booked a consultation on Calendly.'
      : `Wrote back${outcome.snippet ? `: "${outcome.snippet}"` : ''}.`);
  }
  const item = await inbox.recordInbound(p, outcome.kind, { ...msg, auto: msg.auto || outcome.kind === 'auto' });
  return !!item;
}

function collectFollowOns(rows, messages, taken) {
  const out = [];
  for (const msg of messages) {
    if (taken.has(msg) || msg.from === SENDER.email.toLowerCase()) continue;
    for (const p of rows) {
      if (msg.date && p.sent_at && msg.date < new Date(p.sent_at)) continue;
      const outcome = classifyMessage(msg, p);
      if (!outcome || outcome.kind === 'bounced') continue;
      out.push([p, outcome, msg]);
      break;
    }
  }
  return out;
}

function keepInboxOutcome(row, outcome) {
  if (!outcome) return false;
  if (!isArchivedLead(row)) return true;
  return outcome.kind === 'opted_out' || outcome.kind === 'bounced';
}

function collectInboxOutcomes(rows, messages) {
  const outcomes = [];
  for (const msg of messages) {
    if (msg.from === SENDER.email.toLowerCase()) continue;
    for (const p of rows) {
      if (p._done || (msg.date && p.sent_at && msg.date < new Date(p.sent_at))) continue;
      const outcome = classifyMessage(msg, p);
      if (!keepInboxOutcome(p, outcome)) continue;
      p._done = true;
      outcomes.push([p, outcome, msg]);
    }
  }
  return outcomes;
}

async function applyInboxMessages(messages) {
  const rows = await inboxCandidates();
  const convo = await conversationCandidates();
  const outcomes = collectInboxOutcomes(rows, messages);
  for (const [p, o, msg] of outcomes) await applyOutcome(p, o, msg);
  const taken = new Set(outcomes.map(([, , m]) => m));
  let followOns = 0;
  for (const [p, o, msg] of collectFollowOns(convo, messages, taken)) if (await applyFollowOn(p, o, msg)) followOns++;
  require('./inbox').kick();
  return { checked: messages.length, matched: outcomes.length, follow_ons: followOns };
}

/** Look through the inbox for replies, bookings, bounces and opt-outs. */
async function checkInbox() {
  if (checking || !(await mailMode()) || (await mailMode()) === 'test') return { checked: 0 };
  const active = await inboxCandidates();
  const convo = await conversationCandidates();
  if (!active.length && !convo.length) return { checked: 0 };
  checking = true;
  let messages = [];
  let outcomes = [];
  let followOns = [];
  let sentHandled = 0;
  try {
    const since = new Date(Math.min(...[...active, ...convo].map(p => new Date(p.sent_at).getTime())) - 86400000);
    messages = await fetchInbox(since);
    outcomes = collectInboxOutcomes(active, messages);
    const taken = new Set(outcomes.map(([, , m]) => m));
    followOns = collectFollowOns(convo, messages, taken);
    if ((await mailMode()) === 'gmail_api') {
      try { sentHandled = await require('./inbox').applySentMessages(await gmail.sentSince(since)); }
      catch (err) { console.error('[inbox] sent check failed:', err.message); }
    }
  } catch (err) {
    console.error('[inbox] ✗ check failed:', err.message);
  } finally {
    checking = false;
  }
  for (const [p, o, msg] of outcomes) await applyOutcome(p, o, msg);
  let recorded = 0;
  for (const [p, o, msg] of followOns) if (await applyFollowOn(p, o, msg)) recorded++;
  require('./inbox').kick();
  return { checked: messages.length, matched: outcomes.length, follow_ons: recorded, replied_from_gmail: sentHandled };
}

async function senderTick() {
  try { await checkInbox(); } catch (err) { console.error('[sender] inbox:', err.message); }
  try { return await sendDueFollowups(); } catch (err) { console.error('[sender] follow-ups:', err.message); }
}

module.exports = {
  approveAndSend, sendDueFollowups, attachPrototypeUrl, withPrototype, checkInbox, inboxCandidates, conversationCandidates, applyInboxMessages, mailer, senderTick, stopSequence, stopLeadSequences, _setLeadStop, _setOptOutGate, _setFollowupClaimGate, classifyMessage, applyOutcome,
  renderMessage, renderMessageHtml, addedLines, withBooking, fillPlaceholders, onepagerUrl, inSendWindow, sendReadiness, sentToday, mailMode, _setTransport,
};
