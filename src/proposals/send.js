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

const { SENDER } = cfg;
const ACTIVE_STAGES_TO_STOP = ['responded', 'qualified', 'proposal', 'won', 'lost', 'disqualified'];
const GENERIC_DOMAINS = ['gmail.com', 'yahoo.com', 'hotmail.com', 'outlook.com', 'icloud.com', 'aol.com', 'live.com', 'msn.com', 'comcast.net', 'me.com', 'protonmail.com'];

let transport = null;
function mailer() {
  if (!cfg.mailConfigured()) throw new Error('Email is not set up. Add GMAIL_USER and GMAIL_APP_PASSWORD in Railway Variables.');
  if (!transport) {
    transport = nodemailer.createTransport({
      service: 'gmail',
      auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_APP_PASSWORD },
    });
  }
  return transport;
}
function _setTransport(t) { transport = t; } // tests

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

function renderMessage(p, which) {
  const text = which === 'first' ? p.body : which === 'followup1' ? p.followup1 : p.followup2;
  return fillPlaceholders(text, p) + footer();
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

function sendReadiness() {
  const problems = [];
  if (!cfg.mailConfigured()) problems.push('Add GMAIL_USER and GMAIL_APP_PASSWORD in Railway Variables.');
  if (!SENDER.address) problems.push('Add SENDER_ADDRESS (a mailing address for the email footer; the law requires one).');
  return problems;
}

const validEmail = (x) => /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(x || '');

/** Approve a draft and send the first email now. */
async function approveAndSend(proposalId) {
  const problems = sendReadiness();
  if (problems.length) throw Object.assign(new Error(problems.join(' ')), { status: 400 });

  const { rows } = await pool.query(
    `SELECT pr.*, p.company, p.stage, p.do_not_contact FROM proposals pr JOIN prospects p ON p.id = pr.prospect_id WHERE pr.id = $1`,
    [proposalId]);
  const p = rows[0];
  if (!p) throw Object.assign(new Error('Proposal not found'), { status: 404 });
  if (p.status !== 'draft') throw Object.assign(new Error(`This version is ${p.status}; only drafts can be sent.`), { status: 409 });
  if (p.do_not_contact) throw Object.assign(new Error(`${p.company} is marked do-not-contact.`), { status: 409 });
  if (!validEmail(p.to_email)) throw Object.assign(new Error('Add a valid "To" email before sending.'), { status: 400 });
  if (!p.subject?.trim() || !p.body?.trim()) throw Object.assign(new Error('Subject and email body are required.'), { status: 400 });
  if (await sentToday() >= cfg.SEND_DAILY_LIMIT) {
    throw Object.assign(new Error(`Daily send limit (${cfg.SEND_DAILY_LIMIT}) reached. Try again tomorrow.`), { status: 429 });
  }

  // Claim the row first so a double-click can't send twice.
  const claim = await pool.query(`UPDATE proposals SET status = 'sending', approved_at = NOW() WHERE id = $1 AND status = 'draft' RETURNING id`, [p.id]);
  if (!claim.rows.length) throw Object.assign(new Error('Already sending.'), { status: 409 });

  let info;
  try {
    info = await mailer().sendMail({
      from: { name: SENDER.name, address: SENDER.email },
      to: p.to_name ? { name: p.to_name, address: p.to_email } : p.to_email,
      subject: p.subject.trim(),
      text: renderMessage(p, 'first'),
      headers: { 'List-Unsubscribe': `<mailto:${SENDER.email}?subject=unsubscribe>` },
    });
  } catch (err) {
    await pool.query(`UPDATE proposals SET status = 'draft', approved_at = NULL, error = $2 WHERE id = $1`, [p.id, `Send failed: ${err.message}`]);
    throw Object.assign(new Error(`Gmail refused the message: ${err.message}`), { status: 502 });
  }

  const [d1, d2] = cfg.FOLLOWUP_DAYS;
  const { rows: updated } = await pool.query(
    `UPDATE proposals SET status = 'sent', sent_at = NOW(), message_id = $2, error = NULL,
            followup1_due_at = CASE WHEN COALESCE(followup1, '') <> '' THEN NOW() + make_interval(days => $3) END,
            followup2_due_at = CASE WHEN COALESCE(followup2, '') <> '' THEN NOW() + make_interval(days => $4) END
      WHERE id = $1 RETURNING *`,
    [p.id, info.messageId, d1 ?? 3, d2 ?? 10]);

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

async function stopSequence(proposalId, reason, status = 'stopped') {
  const { rows } = await pool.query(
    `UPDATE proposals SET status = $2, stop_reason = $3 WHERE id = $1 AND status IN ('sent', 'draft') RETURNING *`,
    [proposalId, status, reason]);
  return rows[0] || null;
}

/** Send any follow-ups that are due. Called every 15 minutes. */
async function sendDueFollowups() {
  if (!cfg.mailConfigured() || !SENDER.address || !inSendWindow()) return { sent: 0 };
  const { rows } = await pool.query(
    `SELECT pr.*, p.company, p.stage, p.do_not_contact FROM proposals pr JOIN prospects p ON p.id = pr.prospect_id
      WHERE pr.status = 'sent' AND (
            (pr.followup1_sent_at IS NULL AND pr.followup1_due_at <= NOW()) OR
            (pr.followup1_sent_at IS NOT NULL AND pr.followup2_sent_at IS NULL AND pr.followup2_due_at <= NOW()))
      ORDER BY pr.sent_at LIMIT 25`);
  let sent = 0;
  for (const p of rows) {
    if (p.do_not_contact || ACTIVE_STAGES_TO_STOP.includes(p.stage)) {
      await stopSequence(p.id, p.do_not_contact ? 'Lead is do-not-contact' : `Lead moved to ${p.stage}`);
      continue;
    }
    if (await sentToday() >= cfg.SEND_DAILY_LIMIT) break;
    const which = p.followup1_sent_at ? 'followup2' : 'followup1';
    const claim = await pool.query(
      `UPDATE proposals SET ${which}_sent_at = NOW() WHERE id = $1 AND ${which}_sent_at IS NULL AND status = 'sent' RETURNING id`, [p.id]);
    if (!claim.rows.length) continue;
    try {
      await mailer().sendMail({
        from: { name: SENDER.name, address: SENDER.email },
        to: p.to_name ? { name: p.to_name, address: p.to_email } : p.to_email,
        subject: /^re:/i.test(p.subject) ? p.subject : `Re: ${p.subject}`,
        text: renderMessage(p, which),
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
  const done = await pool.query(
    `UPDATE proposals SET status = 'finished', stop_reason = 'No reply after the follow-ups'
      WHERE status = 'sent' AND COALESCE(followup2_sent_at, followup1_sent_at, sent_at) < NOW() - INTERVAL '14 days'
        AND (followup2_due_at IS NULL OR followup2_sent_at IS NOT NULL)
        AND (followup1_due_at IS NULL OR followup1_sent_at IS NOT NULL)
      RETURNING prospect_id`);
  for (const r of done.rows) {
    await pool.query(`UPDATE prospects SET next_action = COALESCE(NULLIF(next_action, ''), 'No reply to emails — try a call'),
                             next_action_at = COALESCE(next_action_at, CURRENT_DATE) WHERE id = $1`, [r.prospect_id]);
  }
  return { sent, finished: done.rowCount };
}

// ─── Inbox watching ───────────────────────────────────────────────────────
const OPT_OUT = /\b(unsubscribe|remove me|take me off|stop (emailing|contacting)|no thanks|not interested|do not (email|contact)|don'?t (email|contact))\b/i;

function domainOf(email) { return String(email || '').split('@')[1]?.toLowerCase() || ''; }

/** Decide what an incoming message means for an active proposal (pure, testable). */
function classifyMessage(msg, p) {
  const from = (msg.from || '').toLowerCase();
  const to = p.to_email.toLowerCase();
  const text = (msg.text || '').slice(0, 20000);
  const textLower = text.toLowerCase();
  const refs = [msg.inReplyTo, ...(msg.references || [])].filter(Boolean).map(s => s.toLowerCase());
  const threaded = p.message_id && refs.includes(p.message_id.toLowerCase());

  if (/mailer-daemon|postmaster|mail delivery subsystem/i.test(from + ' ' + (msg.subject || '')) && (textLower.includes(to) || threaded)) {
    return { kind: 'bounced' };
  }
  if (/calendly\.com/.test(from) && textLower.includes(to)) return { kind: 'booked' };

  const dom = domainOf(to);
  const sameSender = from === to || (dom && !GENERIC_DOMAINS.includes(dom) && domainOf(from) === dom);
  if (sameSender || threaded) {
    const fresh = text.split(/\n\s*On .{5,200}wrote:|\n-{2,}\s*Original Message|\n>/)[0];
    return { kind: OPT_OUT.test(fresh) || /^\s*(stop|unsubscribe)\s*$/im.test(fresh) || /unsubscribe/i.test(msg.subject || '') ? 'opted_out' : 'replied',
             snippet: fresh.replace(/\s+/g, ' ').trim().slice(0, 240) };
  }
  return null;
}

async function applyOutcome(p, outcome, msg) {
  const { kind, snippet } = outcome;
  if (kind === 'bounced') {
    await stopSequence(p.id, `Bounced: ${p.to_email} did not accept the message`, 'bounced');
    await pool.query(`UPDATE prospects SET email = NULL WHERE id = $1 AND email = $2`, [p.prospect_id, p.to_email]);
    await logActivity(p.prospect_id, 'note', `Proposal email to ${p.to_email} bounced. Follow-ups stopped; find another address or call.`);
    return;
  }
  if (kind === 'opted_out') {
    await stopSequence(p.id, 'Asked not to be contacted', 'opted_out');
    await pool.query(`UPDATE prospects SET do_not_contact = TRUE, stage = 'lost' WHERE id = $1`, [p.prospect_id]);
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

let checking = false;
/** Look through the Gmail inbox for replies, bookings, bounces and opt-outs. */
async function checkInbox() {
  if (!cfg.mailConfigured() || checking) return { checked: 0 };
  const { rows: active } = await pool.query(
    `SELECT pr.*, p.stage FROM proposals pr JOIN prospects p ON p.id = pr.prospect_id WHERE pr.status = 'sent' AND pr.to_email IS NOT NULL`);
  if (!active.length) return { checked: 0 };
  checking = true;

  const { ImapFlow } = require('imapflow');
  const { simpleParser } = require('mailparser');
  const imap = new ImapFlow({
    host: 'imap.gmail.com', port: 993, secure: true, logger: false,
    auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_APP_PASSWORD },
  });
  let checked = 0; const outcomes = [];
  try {
    await imap.connect();
    const lock = await imap.getMailboxLock('INBOX');
    try {
      const since = new Date(Math.min(...active.map(p => new Date(p.sent_at).getTime())) - 86400000);
      const uids = await imap.search({ since }, { uid: true });
      const recent = (uids || []).slice(-400);
      if (recent.length) {
        for await (const m of imap.fetch(recent, { uid: true, envelope: true, source: true }, { uid: true })) {
          checked++;
          const fromAddr = m.envelope?.from?.[0]?.address || '';
          const date = m.envelope?.date ? new Date(m.envelope.date) : null;
          if (fromAddr.toLowerCase() === SENDER.email.toLowerCase()) continue;
          let parsed;
          try { parsed = await simpleParser(m.source, { skipHtmlToText: false, skipImageLinks: true }); } catch { continue; }
          const msg = {
            from: fromAddr, subject: m.envelope?.subject || '', date,
            inReplyTo: parsed.inReplyTo || '', references: [].concat(parsed.references || []),
            text: parsed.text || '',
          };
          for (const p of active) {
            if (p._done || (date && date < new Date(p.sent_at))) continue;
            const outcome = classifyMessage(msg, p);
            if (outcome) { p._done = true; outcomes.push([p, outcome, msg]); }
          }
        }
      }
    } finally { lock.release(); }
    await imap.logout();
  } catch (err) {
    console.error('[inbox] ✗ check failed:', err.message);
    try { await imap.close(); } catch { /* already closed */ }
  } finally {
    checking = false;
  }
  for (const [p, o, msg] of outcomes) await applyOutcome(p, o, msg);
  return { checked, matched: outcomes.length };
}

async function senderTick() {
  try { await checkInbox(); } catch (err) { console.error('[sender] inbox:', err.message); }
  try { return await sendDueFollowups(); } catch (err) { console.error('[sender] follow-ups:', err.message); }
}

module.exports = {
  approveAndSend, sendDueFollowups, checkInbox, senderTick, stopSequence, classifyMessage, applyOutcome,
  renderMessage, fillPlaceholders, onepagerUrl, inSendWindow, sendReadiness, sentToday, _setTransport,
};
