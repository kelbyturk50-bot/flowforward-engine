// Sending and follow-up. Email goes out through Gmail (flowforward50@gmail.com)
// with an app password, so every message also lands in that account's Sent
// folder and replies land in its inbox like normal.
//
// Flow: Kelby approves a draft in the CRM → first email goes out now →
// follow-up 1 and 2 go out as replies in the same thread on day 3 and day 10
// (weekdays, 8am–5pm Denver) unless the lead replies, books on Calendly,
// bounces, opts out, or Kelby moves them forward/stops the sequence.

const crypto = require('crypto');
const nodemailer = require('nodemailer');
const MailComposer = require('nodemailer/lib/mail-composer');
const pool = require('../db/client');
const cfg  = require('./config');
const { appendCompanyPestExclusion, isPestCompanyName, PEST_NAME_REASON } = require('../scoring/industry');
const { ARCHIVED_LEAD_REASON, isArchivedLead } = require('../db/pest-archive');

const { canonicalizeRecipient, missingRecipient, normalizeRecipient } = require('./recipient');
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

// Status, token refresh, and the raw MIME are resolved here. The caller
// rechecks the lead after this returns, then calls send() with no await between
// that recheck and the POST.
function smtpTransport() {
  return nodemailer.createTransport({
    service: 'gmail',
    auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_APP_PASSWORD },
    connectionTimeout: 20000,
  });
}

async function compileOutgoing(mail) {
  if (!mail) return;
  await new MailComposer({ ...mail, threadId: undefined }).compile().build();
}

async function prepareOutgoing(mail) {
  const status = await gmail.status();
  const mode = await mailMode();
  let delivery = null;
  if (mode === 'gmail_api' && status && status.connected && typeof gmail.prepareDelivery === 'function') {
    delivery = await gmail.prepareDelivery(mail);
  } else {
    if (status && status.connected && typeof gmail.accessToken === 'function') {
      await gmail.accessToken({ force: true });
    }
    await compileOutgoing(mail);
  }
  let transportClient = null;
  if (mode === 'test') transportClient = testTransport;
  else if (mode === 'smtp') {
    if (!transport) transport = smtpTransport();
    transportClient = transport;
  }
  return {
    mode,
    send() {
      if (mode === 'gmail_api' && delivery) return delivery.send();
      if (!transportClient || typeof transportClient.sendMail !== 'function') {
        throw new Error('Email is not set up. Go to Settings and click Connect Gmail.');
      }
      return transportClient.sendMail(mail);
    },
  };
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

function haltView(row) {
  if (!row || row.event !== HALT_EVENT) return null;
  return {
    event: HALT_EVENT,
    error_class: row.error_class,
    provider: row.provider,
    cause: row.cause || null,
    first_seen: row.first_seen,
    halted_ticks: Number(row.halted_ticks) || 0,
  };
}

async function loadHalt() {
  const { rows } = await pool.query('SELECT value FROM app_settings WHERE key = $1', [HALT_KEY]);
  return rows[0] ? rows[0].value : null;
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
  problems.halt = haltView(await loadHalt());
  return problems;
}

const MANUAL_REVIEW = 'Needs manual review: the send outcome is uncertain';
const RESEND_CONFIRM = 'Confirm before sending again';
const TRANSIENT_MAX_AGE = 'transient_max_age';
const MANUAL_REVIEW_STATUS = 'manual_review';
const STALE_SENDING = '15 minutes';
const ATTEMPT_CAP = 3;
const FOLLOWUP_SWEEP_LOCK = 89089017;
const FOLLOWUP_BACKOFF_CAP_MS = 60 * 60 * 1000;
const FOLLOWUP_MAX_AGE_MS = 72 * 60 * 60 * 1000;
const BACKOFF_CAP_MS = FOLLOWUP_BACKOFF_CAP_MS;
const SENDER_ALERT_KEY = 'sender_alert';
const HALT_KEY = 'followups.halted';
const HALT_EVENT = 'followups.halted';
const OUTAGE_LABELS = new Set(['quota', 'server', 'network', 'smtp']);

let beforeFollowupClaim = null;
let beforeTransport = null;
let failNextRelease = false;
let failNextPostSend = false;

function testOnly(name) {
  if (process.env.NODE_ENV !== 'test') throw new Error(`${name} is only available when NODE_ENV=test`);
}

function _beforeFollowupClaim(fn) {
  testOnly('_beforeFollowupClaim');
  beforeFollowupClaim = fn;
}

function _beforeTransport(fn) {
  testOnly('_beforeTransport');
  beforeTransport = fn;
}

function _failNextRelease() {
  testOnly('_failNextRelease');
  failNextRelease = true;
}

function _failNextPostSend() {
  testOnly('_failNextPostSend');
  failNextPostSend = true;
}

let randomSource = null;
let alertHook = null;

function _setRandom(fn) {
  testOnly('_setRandom');
  randomSource = typeof fn === 'function' ? fn : null;
}

function _setAlertHook(fn) {
  testOnly('_setAlertHook');
  alertHook = typeof fn === 'function' ? fn : null;
}

let credentialOverride = null;
function _setCredentialCheck(fn) {
  testOnly('_setCredentialCheck');
  credentialOverride = typeof fn === 'function' ? fn : null;
}

function _resetSendTestHooks() {
  testOnly('_resetSendTestHooks');
  beforeFollowupClaim = null;
  beforeTransport = null;
  failNextRelease = false;
  failNextPostSend = false;
  randomSource = null;
  alertHook = null;
  credentialOverride = null;
}

function unitRandom(rand) {
  const raw = rand == null ? (randomSource ? randomSource() : Math.random()) : rand;
  const n = Number(raw);
  if (!Number.isFinite(n)) return 0;
  return Math.min(1, Math.max(0, n));
}

// Minutes: clamp(min(60, 15 * 2^(n-1)) * U(0.8, 1.2), 15, 60).
// n is the transient attempt in the current streak. U comes from _setRandom.
function backoffDelayMinutes(attempt, rand) {
  const n = Math.max(1, Number(attempt) || 1);
  const u = 0.8 + unitRandom(rand) * 0.4;
  const slot = Math.min(60, 15 * (2 ** (n - 1)));
  const raw = Math.round((slot * u) * 1e6) / 1e6;
  return Math.min(60, Math.max(15, raw));
}

function backoffDelayMs(attempt, rand) {
  return backoffDelayMinutes(attempt, rand) * 60 * 1000;
}

function envelopeTo(name, address) {
  const to = { address };
  const label = name == null ? '' : String(name).trim();
  if (label) to.name = label;
  return to;
}

function storedRecipient(email) {
  const text = email == null ? '' : String(email);
  const canonical = canonicalizeRecipient(email);
  if (!canonical.ok || canonical.value !== text) return null;
  return canonical.value;
}

const NETWORK_CODES = new Set([
  'EAI_AGAIN', 'ECONNABORTED', 'ECONNREFUSED', 'ECONNRESET', 'EHOSTUNREACH',
  'ENETUNREACH', 'ENOTFOUND', 'EPIPE', 'ESOCKETTIMEDOUT', 'ETIMEDOUT',
]);
const QUOTA_REASONS = ['quotaexceeded', 'ratelimitexceeded', 'userratelimitexceeded', 'dailylimitexceeded'];

function httpStatus(err) {
  if (!err || typeof err !== 'object') return null;
  const nested = err.response && err.response.data && err.response.data.error;
  const candidates = [
    err.status, err.statusCode,
    err.response && err.response.status,
    nested && typeof nested === 'object' ? nested.code : null,
  ];
  for (const value of candidates) {
    if (typeof value === 'number' && Number.isInteger(value) && value >= 100 && value <= 599) return value;
    if (typeof value === 'string' && /^\d{3}$/.test(value)) return Number(value);
  }
  // googleapis puts the HTTP status on err.code. Nodemailer's SMTP status is
  // responseCode, and a string code is a network or envelope error.
  if (err.responseCode == null && typeof err.code === 'number' && Number.isInteger(err.code) && err.code >= 100 && err.code <= 599) {
    return err.code;
  }
  return null;
}

function reasonTokens(err) {
  const out = new Set();
  const add = (value) => {
    if (value == null) return;
    const text = String(value).trim();
    if (!text) return;
    out.add(text.toLowerCase());
  };
  if (!err || typeof err !== 'object') return out;
  add(err.reason);
  add(err.gmailStatus);
  const nested = err.response && err.response.data && err.response.data.error;
  if (typeof nested === 'string') add(nested);
  if (nested && typeof nested === 'object') {
    add(nested.status);
    add(nested.reason);
    if (Array.isArray(nested.errors)) {
      for (const item of nested.errors) {
        if (!item) continue;
        add(item.reason);
        add(item.status);
      }
    }
  }
  if (Array.isArray(err.errors)) {
    for (const item of err.errors) {
      if (!item) continue;
      add(item.reason);
    }
  }
  return out;
}

function hasReason(err, names) {
  const tokens = reasonTokens(err);
  return names.some((name) => tokens.has(String(name).toLowerCase()));
}

function errorBlob(err) {
  if (!err || typeof err !== 'object') return String(err || '');
  const bits = [];
  if (err.message) bits.push(String(err.message));
  if (err.gmailStatus) bits.push(String(err.gmailStatus));
  if (err.reason) bits.push(String(err.reason));
  const nested = err.response && err.response.data && err.response.data.error;
  if (nested) {
    if (nested.message) bits.push(String(nested.message));
    if (nested.status) bits.push(String(nested.status));
    if (Array.isArray(nested.errors)) {
      for (const item of nested.errors) {
        if (!item) continue;
        if (item.message) bits.push(String(item.message));
        if (item.reason) bits.push(String(item.reason));
      }
    }
  }
  if (Array.isArray(err.errors)) {
    for (const item of err.errors) {
      if (!item) continue;
      if (item.message) bits.push(String(item.message));
      if (item.reason) bits.push(String(item.reason));
    }
  }
  return bits.join(' ');
}

function isNetworkFollowupError(err) {
  const code = err && err.code;
  if (typeof code === 'string' && NETWORK_CODES.has(code)) return true;
  // Nodemailer reports a socket drop after DATA as ECONNECTION with command CONN.
  if (code === 'ECONNECTION') return true;
  if ((atCommand(err, 'DATA') || atCommand(err, 'CONN')) && /connection closed|server closed the connection|unexpectedly closed/i.test(errorBlob(err))) return true;
  return /ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|EHOSTUNREACH|ENETUNREACH|socket hang up|network error|getaddrinfo|timeout of \d+ms exceeded/i.test(errorBlob(err));
}

function isQuotaReason(err) {
  return hasReason(err, QUOTA_REASONS) || hasReason(err, ['resource_exhausted']);
}

function smtpCode(err) {
  const code = err && err.responseCode;
  if (typeof code === 'number' && Number.isInteger(code) && code >= 400 && code <= 599) return code;
  return null;
}

function smtpCommand(value) {
  return String(value || '').trim().toUpperCase();
}

function atCommand(err, command) {
  if (!err || typeof err !== 'object') return false;
  if (smtpCommand(err.command) === command) return true;
  return Array.isArray(err.rejectedErrors) && err.rejectedErrors.some((item) => item && smtpCommand(item.command) === command);
}

function replyTexts(err) {
  const out = [];
  if (!err || typeof err !== 'object') return out;
  if (typeof err.response === 'string') out.push(err.response);
  if (typeof err.message === 'string') out.push(err.message);
  if (Array.isArray(err.rejectedErrors)) {
    for (const item of err.rejectedErrors) {
      if (!item) continue;
      if (typeof item.response === 'string') out.push(item.response);
      if (typeof item.message === 'string') out.push(item.message);
    }
  }
  return out;
}

function serverReply(text) {
  return String(text || '').replace(/^(?:(?:Can't send mail - )?all recipients were rejected|Data command failed|Message failed for recipient [^\n:]*|Message failed|Invalid login):\s*/i, '');
}

function anchoredEnhanced(text, responseCode) {
  // Only the start of the server's own reply line. A code quoted later,
  // including after nodemailer's prefix, is not this reply's status.
  const first = serverReply(text).split(/\r?\n/)[0];
  const start = first.match(/^\s*(\d{3})(?:[ \t]+|-)(5\.\d{1,3}\.\d{1,3})\b/);
  if (!start) return [];
  const code = Number(start[1]);
  if (responseCode != null && code !== responseCode) return [];
  return [{ code, enhanced: start[2] }];
}

function firstAnchoredEnhanced(err) {
  const code = smtpCode(err);
  for (const text of replyTexts(err)) {
    const pairs = anchoredEnhanced(text, code);
    if (pairs.length) return pairs[0];
  }
  return null;
}

const PERMANENT_ENHANCED = new Set(['5.1.0', '5.1.1', '5.1.2', '5.1.3', '5.1.10']);

function isTemporarySmtp(err) {
  const code = smtpCode(err);
  if (code != null && code >= 400 && code < 500) return true;
  for (const text of replyTexts(err)) {
    const lead = leadingSmtpReply(text);
    if (lead && lead.code >= 400 && lead.code < 500) return true;
  }
  return false;
}

function isPermanentSmtpRecipient(err) {
  if (!atCommand(err, 'RCPT TO')) return false;
  // MAIL FROM is sender/config even when the text looks like a recipient bounce.
  if (atCommand(err, 'MAIL FROM')) return false;
  let code = smtpCode(err);
  let enhanced = null;
  if (code == null) {
    const lead = leadingSmtpReply(err && err.message);
    if (!lead) return false;
    code = lead.code;
    enhanced = lead.enhanced;
  } else {
    const anchored = firstAnchoredEnhanced(err);
    if (anchored && anchored.code === code) enhanced = anchored.enhanced;
  }
  if (code === 553 && enhanced !== '5.1.8') return true;
  if (code == null || code < 500) return false;
  if (enhanced === '5.1.8') return false;
  return !!(enhanced && PERMANENT_ENHANCED.has(enhanced));
}

function isSenderWording(text) {
  return /invalid\s+(?:from|reply-to|sender)\s+(?:header|address)|invalid address in from header|invalid address:\s*reply-to|sender address rejected/i.test(String(text || ''));
}

function isSenderConfig(err) {
  // A 4xx at MAIL FROM is an outage, not a sender stop.
  if (isTemporarySmtp(err)) return false;
  if (atCommand(err, 'MAIL FROM')) return true;
  if (isSenderWording(errorBlob(err))) return true;
  // 5.1.8 at the start of the reply halts at RCPT TO the same way it does at MAIL FROM.
  const anchored = firstAnchoredEnhanced(err);
  return !!(anchored && anchored.enhanced === '5.1.8' && atCommand(err, 'RCPT TO'));
}

function leadingSmtpReply(text) {
  const match = serverReply(text).match(/^\s*(\d{3})(?:[ \t]+(5\.\d{1,3}\.\d{1,3}))?\b/);
  if (!match) return null;
  return { code: Number(match[1]), enhanced: match[2] || null };
}

function namesRecipient(err) {
  const text = errorBlob(err);
  if (/invalid from header|\bfrom address\b/i.test(text)) return false;
  return /recipient address required|no recipients defined|missing recipient|invalid recipient|invalid to header/i.test(text);
}

function gmailRecipientReply(err) {
  const status = httpStatus(err);
  if (status !== 400 && status !== 403) return false;
  return replyTexts(err).some((text) => /^\s*550[ \t]+5\.1\.(?:0|1|2|3|10)\b/.test(String(text).split(/\r?\n/, 1)[0]));
}

function isGmailPermanentRecipient(err) {
  const status = httpStatus(err);
  if (status != null && status !== 400 && status !== 403) return false;
  if (/invalid from header|\bfrom address\b/i.test(errorBlob(err))) return false;
  if (status === 403) return /invalid to header|invalid recipient/i.test(errorBlob(err)) || gmailRecipientReply(err);
  return namesRecipient(err) || (status === 400 && gmailRecipientReply(err));
}

const ARGUMENT_ATTEMPTS = ATTEMPT_CAP;

function isAuthFollowupError(err) {
  if (hasReason(err, ['invalid_grant', 'authError', 'insufficientPermissions'])) return true;
  const code = smtpCode(err);
  if (code === 535 || code === 530) return true;
  for (const text of replyTexts(err)) {
    const lead = leadingSmtpReply(text);
    if (lead && (lead.code === 535 || lead.code === 530)) return true;
  }
  if (httpStatus(err) === 401) return true;
  return /invalid_grant|access expired|insufficient permissions|gmail is not connected|token(?:\s+is)?\s+missing/i.test(errorBlob(err));
}

function classifyFollowupError(err) {
  const status = httpStatus(err);
  if (isSenderConfig(err)) return { kind: 'transient', label: 'sender', sweep: true };
  if (isTemporarySmtp(err)) return { kind: 'transient', label: 'smtp' };
  if (isAuthFollowupError(err)) return { kind: 'transient', label: 'auth', sweep: true };
  if (isPermanentSmtpRecipient(err)) return { kind: 'permanent', label: 'recipient' };
  if (isGmailPermanentRecipient(err)) return { kind: 'permanent', label: 'recipient' };
  if (status != null && status >= 500 && status <= 599) return { kind: 'transient', label: 'server' };
  if (status === 429 || ((status === 400 || status === 403) && isQuotaReason(err))) {
    return { kind: 'transient', label: 'quota' };
  }
  if (status === 413) return { kind: 'transient', label: 'payload' };
  if (isNetworkFollowupError(err)) return { kind: 'transient', label: 'network' };
  if (status === 400 || hasReason(err, [
    'badRequest', 'invalidArgument', 'failedPrecondition',
    'INVALID_ARGUMENT', 'FAILED_PRECONDITION', 'BAD_REQUEST',
  ])) {
    return { kind: 'transient', label: 'argument' };
  }
  if (status == null && /quota exceeded|rate limit exceeded|too many requests/i.test(errorBlob(err))) {
    return { kind: 'transient', label: 'quota' };
  }
  return { kind: 'transient', label: 'later' };
}

function isPermanentFollowupError(err) {
  return classifyFollowupError(err).kind === 'permanent';
}

function permanentFollowupReason(err) {
  const text = errorBlob(err);
  if (/recipient address required|no recipients defined|missing recipient/i.test(text)) {
    return 'Follow-up stopped: recipient address required';
  }
  if (/address rejected|recipients were rejected|recipient rejected|5\.1\.[013]\b|user unknown|mailbox (not found|unavailable|does not exist)/i.test(text)
      || (Array.isArray(err && err.rejected) && err.rejected.length > 0)) {
    return 'Follow-up stopped: address rejected';
  }
  return 'Follow-up stopped: invalid recipient';
}

function transientFollowupLabel(err) {
  return classifyFollowupError(err).label;
}

function followupSentColumn(which) {
  if (which === 'followup1') return 'followup1_sent_at';
  if (which === 'followup2') return 'followup2_sent_at';
  throw new Error('Unknown follow-up');
}

async function recoverStaleSending(proposalId) {
  const params = [MANUAL_REVIEW];
  let extra = '';
  if (proposalId != null) {
    params.push(proposalId);
    extra = ` AND id = $${params.length}`;
  }
  const { rows } = await pool.query(
    `UPDATE proposals
        SET status = 'stopped', stop_reason = $1, error = $1
      WHERE status = 'sending'
        AND approved_at IS NOT NULL
        AND approved_at < NOW() - INTERVAL '${STALE_SENDING}'
        ${extra}
      RETURNING id`,
    params);
  for (const row of rows) {
    console.error(`[send] first send for #${row.id} needs manual review: outcome uncertain`);
  }
  return rows;
}

async function claimFollowupAttempt(id, cap) {
  const { rows } = await pool.query(
    `UPDATE proposals
        SET followup_argument_attempts = followup_argument_attempts + 1
      WHERE id = $1 AND followup_argument_attempts < $2
      RETURNING followup_argument_attempts`,
    [id, cap]);
  return rows.length ? Number(rows[0].followup_argument_attempts) : null;
}

function attemptCap(klass) {
  return klass && klass.cap ? klass.cap : ATTEMPT_CAP;
}

function capStopReason(label) {
  if (label === 'argument') return 'Follow-up stopped: Gmail rejected the message';
  if (label === 'payload') return 'Follow-up stopped: the message was too large';
  if (label === 'later') return 'Follow-up stopped: later retry limit reached';
  return `Follow-up stopped: ${label} retry limit reached`;
}

function isOutageClass(klass) {
  return !!(klass && !klass.sweep && OUTAGE_LABELS.has(klass.label));
}

function uncertainSend(err) {
  return !!(err && (err.accepted === true || err.uncertain === true || err.code === 'POST_SEND_WRITE'));
}

/** Approve a draft and send the first email now. */
async function approveAndSend(proposalId, options = {}) {
  const stale = await recoverStaleSending(proposalId);
  if (stale.length) throw Object.assign(new Error(MANUAL_REVIEW), { status: 409 });

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
  const heldBack = p.stop_reason === RESEND_CONFIRM || String(p.stop_reason || '').startsWith('Needs manual review');
  if (heldBack && options.confirm !== true) {
    throw Object.assign(new Error('Confirm this send before it goes out again.'), { status: 409 });
  }
  if (p.do_not_contact) throw Object.assign(new Error(`${p.company} is marked do-not-contact.`), { status: 409 });
  const toAddress = storedRecipient(p.to_email);
  if (!toAddress) throw Object.assign(new Error('Add a valid "To" email before sending.'), { status: 400 });
  if (!p.subject?.trim() || !p.body?.trim()) throw Object.assign(new Error('Subject and email body are required.'), { status: 400 });
  if (await sentToday() >= cfg.SEND_DAILY_LIMIT) {
    throw Object.assign(new Error(`Daily send limit (${cfg.SEND_DAILY_LIMIT}) reached. Try again tomorrow.`), { status: 429 });
  }

  // Claim the row first so a double-click can't send twice.
  const attemptKey = crypto.randomBytes(16).toString('hex');
  const claim = await pool.query(
    `UPDATE proposals
        SET status = 'sending', approved_at = NOW(), send_attempt_key = $2, send_attempted_at = NOW()
      WHERE id = $1 AND status = 'draft' RETURNING id`,
    [p.id, attemptKey]);
  if (!claim.rows.length) throw Object.assign(new Error('Already sending.'), { status: 409 });

  // The prototype link's 14 days start when it is first shared.
  try { await require('../prototypes/store').restartClock(p.prospect_id); } catch (err) { console.error('[prototype] clock restart failed:', err && err.code); }
  await attachPrototypeUrl(p);
  const mail = {
    from: { name: SENDER.name, address: SENDER.email },
    to: envelopeTo(p.to_name, toAddress),
    subject: p.subject.trim(),
    text: renderMessage(p, 'first'),
    html: renderMessageHtml(p, 'first'),
    headers: { 'List-Unsubscribe': `<mailto:${SENDER.email}?subject=unsubscribe>` },
  };
  let prepared;
  try {
    prepared = await prepareOutgoing(mail);
  } catch (err) {
    await pool.query(
      `UPDATE proposals SET status = 'draft', approved_at = NULL, send_attempt_key = NULL, error = $2 WHERE id = $1`,
      [p.id, `Send failed: ${err.message}`]);
    throw Object.assign(new Error(`The email didn't send: ${err.message}`), { status: 502 });
  }
  const gate = await recheckLead(p.prospect_id);
  const block = leadBlocksSend(gate);
  if (block) {
    await pool.query(
      `UPDATE proposals
          SET status = 'draft', approved_at = NULL, send_attempt_key = NULL
        WHERE id = $1 AND status = 'sending' AND send_attempt_key = $2`,
      [p.id, attemptKey]);
    const message = block === 'do_not_contact'
      ? `${p.company} is marked do-not-contact.`
      : `Lead moved to ${gate && gate.stage}.`;
    throw Object.assign(new Error(message), { status: 409 });
  }

  let info;
  let mailed = false;
  try {
    info = await prepared.send();
    mailed = true;
    if (failNextPostSend) {
      failNextPostSend = false;
      const fault = new Error('post-send write failed');
      fault.code = 'POST_SEND_WRITE';
      throw fault;
    }
  } catch (err) {
    if (mailed || uncertainSend(err)) {
      await pool.query(
        `UPDATE proposals SET status = 'stopped', stop_reason = $2, error = $2 WHERE id = $1`,
        [p.id, MANUAL_REVIEW]);
      console.error(`[send] first send for #${p.id} needs manual review: outcome uncertain`);
      throw Object.assign(new Error(MANUAL_REVIEW), { status: 409 });
    }
    await pool.query(
      `UPDATE proposals SET status = 'draft', approved_at = NULL, send_attempt_key = NULL, error = $2 WHERE id = $1`,
      [p.id, `Send failed: ${err.message}`]);
    throw Object.assign(new Error(`The email didn't send: ${err.message}`), { status: 502 });
  }

  const [d1, d2] = cfg.FOLLOWUP_DAYS;
  let updated;
  try {
    const result = await pool.query(
      `UPDATE proposals SET status = 'sent', sent_at = NOW(), message_id = $2, thread_id = $5, error = NULL,
              stop_reason = NULL, send_attempt_key = NULL, followup_argument_attempts = 0,
              followup1_due_at = CASE WHEN COALESCE(followup1, '') <> '' THEN NOW() + make_interval(days => $3) END,
              followup2_due_at = CASE WHEN COALESCE(followup2, '') <> '' THEN NOW() + make_interval(days => $4) END
        WHERE id = $1 AND status = 'sending' AND send_attempt_key = $6
        RETURNING *`,
      [p.id, info.messageId || null, d1 ?? 3, d2 ?? 10, info.threadId || null, attemptKey]);
    if (!result.rowCount) {
      console.error(`[send] first send success write matched 0 rows for #${p.id}`);
      await pool.query(
        `UPDATE proposals SET status = 'stopped', stop_reason = $2, error = $2 WHERE id = $1 AND status = 'sending'`,
        [p.id, MANUAL_REVIEW]);
      throw Object.assign(new Error(MANUAL_REVIEW), { status: 409 });
    }
    updated = result.rows;
  } catch (err) {
    if (err && err.status === 409) throw err;
    console.error(`[send] first send success write failed: ${err && err.code || 'error'}`);
    await pool.query(
      `UPDATE proposals SET status = 'stopped', stop_reason = $2, error = $2 WHERE id = $1 AND status = 'sending'`,
      [p.id, MANUAL_REVIEW]);
    throw Object.assign(new Error(MANUAL_REVIEW), { status: 409 });
  }
  await clearSenderAlert();

  await pool.query(
    `UPDATE prospects SET last_contacted_at = NOW(), email = COALESCE(NULLIF(email, ''), $2),
            stage = CASE WHEN stage IN ('found', 'qualified') THEN 'contacted' ELSE stage END
      WHERE id = $1`, [p.prospect_id, toAddress]);
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

async function loadDueFollowups() {
  // Exclude pest names in SQL. A JS skip after LIMIT 100 would fill the batch
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
        AND (pr.next_retry_at IS NULL OR pr.next_retry_at <= NOW())
      ORDER BY pr.sent_at LIMIT 100`,
    params);
  return rows;
}

function unusableRecipientReason(email) {
  const text = email == null ? '' : String(email);
  const outsideAscii = text.replace(/[\u0000-\u007F]/g, '');
  if (outsideAscii && /[\p{L}\p{N}]/u.test(outsideAscii)) return 'Unsupported recipient email';
  return 'No recipient email';
}

async function stopUnusableRecipient(p) {
  if (!missingRecipient(p.to_email)) return false;
  const reason = unusableRecipientReason(p.to_email);
  const stopped = await stopSequence(p.id, reason);
  if (stopped) {
    const logged = reason === 'No recipient email' ? 'no recipient email' : reason;
    console.info(`[send] skipped follow-up for #${p.id}: ${logged}; sequence stopped`);
  }
  return true;
}

function logFollowupSkip(p, err) {
  console.error(`[send] follow-up for #${p.id} skipped: ${err && err.code || 'error'}`);
}

async function reloadFollowup(id) {
  const { rows } = await pool.query(
    `SELECT pr.*, p.company, p.stage, p.do_not_contact, p.archived_at
       FROM proposals pr JOIN prospects p ON p.id = pr.prospect_id
      WHERE pr.id = $1`,
    [id]);
  return rows[0] || null;
}

async function claimFollowupSend(p, sentColumn) {
  const key = crypto.randomBytes(16).toString('hex');
  const { rows } = await pool.query(
    `UPDATE proposals AS pr
        SET send_attempt_key = $2, send_attempted_at = NOW()
       FROM prospects p
      WHERE pr.id = $1
        AND p.id = pr.prospect_id
        AND pr.status = 'sent'
        AND pr.${sentColumn} IS NULL
        AND pr.send_attempt_key IS NULL
        AND pr.followup_argument_attempts < $3
        AND COALESCE(p.do_not_contact, FALSE) = FALSE
        AND (p.stage IS NULL OR NOT (p.stage = ANY($4::text[])))
        AND p.archived_at IS NULL
      RETURNING pr.id`,
    [p.id, key, ATTEMPT_CAP, ACTIVE_STAGES_TO_STOP]);
  return rows.length ? key : null;
}

async function markManualReview(id, sentColumn, key) {
  const res = await pool.query(
    `UPDATE proposals
        SET status = 'stopped', stop_reason = $2, error = $2, ${sentColumn} = NULL
      WHERE id = $1 AND send_attempt_key = $3 AND status IN ('sent', 'sending')
      RETURNING id`,
    [id, MANUAL_REVIEW, key]);
  if (!res.rowCount) {
    console.error(`[send] manual review matched 0 rows for #${id}`);
    return false;
  }
  console.error(`[send] follow-up for #${id} needs manual review: outcome uncertain`);
  return true;
}

async function recheckLead(prospectId) {
  if (beforeTransport) await beforeTransport({ prospect_id: prospectId });
  const { rows } = await pool.query(
    `SELECT do_not_contact, stage, archived_at FROM prospects WHERE id = $1`,
    [prospectId]);
  return rows[0] || null;
}

function leadBlocksSend(row) {
  if (!row) return 'missing';
  if (row.archived_at) return 'archived';
  if (row.do_not_contact) return 'do_not_contact';
  if (ACTIVE_STAGES_TO_STOP.includes(row.stage)) return 'stage';
  return null;
}

function haltProvider(err) {
  if (smtpCode(err) != null) return 'smtp';
  if (err && typeof err.command === 'string' && /AUTH/i.test(err.command)) return 'smtp';
  return 'gmail';
}

function haltCause(klass, err) {
  if (klass && klass.label === 'sender') return 'sender';
  const code = smtpCode(err);
  for (const text of replyTexts(err)) {
    const lead = leadingSmtpReply(text);
    if (lead && (lead.code === 535 || lead.code === 530)) return 'smtp_auth';
  }
  if (code === 535 || code === 530) return 'smtp_auth';
  if (hasReason(err, ['insufficientPermissions']) || /insufficient permissions/i.test(errorBlob(err))) {
    return 'insufficient_permissions';
  }
  if (/token(?:\s+is)?\s+missing|gmail is not connected/i.test(errorBlob(err))) return 'token_missing';
  if (hasReason(err, ['invalid_grant']) || /invalid_grant|access expired/i.test(errorBlob(err)) || httpStatus(err) === 401) {
    return 'oauth_expired';
  }
  return 'other';
}

async function saveHalt(state) {
  await pool.query(
    `INSERT INTO app_settings (key, value, updated_at) VALUES ($1, $2::jsonb, NOW())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
    [HALT_KEY, JSON.stringify(state)]);
}

async function emitHalt(state) {
  const payload = {
    event: HALT_EVENT,
    error_class: state.error_class,
    provider: state.provider,
    cause: state.cause,
    first_seen: state.first_seen,
    halted_ticks: state.halted_ticks,
  };
  const reason = state.error_class === 'auth' ? 'gmail auth' : 'sender configuration';
  console.error(`[send] [ALERT] ${state.provider} ${state.cause || state.error_class} halted sweep`);
  console.error(`[send] [ALERT] followups.halted ${JSON.stringify(payload)}`);
  if (alertHook) await alertHook(payload);
  await pool.query(
    `INSERT INTO app_settings (key, value, updated_at) VALUES ($1, $2::jsonb, NOW())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
    [SENDER_ALERT_KEY, JSON.stringify({ at: state.first_seen, reason })]);
}

async function recordHalt(klass, err) {
  const now = new Date();
  const existing = await loadHalt();
  const errorClass = klass && klass.label === 'sender' ? 'sender' : 'auth';
  const provider = haltProvider(err);
  const cause = haltCause(klass, err);
  if (!existing || existing.event !== HALT_EVENT) {
    const state = {
      event: HALT_EVENT,
      error_class: errorClass,
      provider,
      cause,
      first_seen: now.toISOString(),
      halted_ticks: 1,
      last_event_at: now.toISOString(),
    };
    await saveHalt(state);
    await emitHalt(state);
    return;
  }
  const state = {
    event: HALT_EVENT,
    error_class: errorClass,
    provider,
    cause,
    first_seen: existing.first_seen,
    halted_ticks: (Number(existing.halted_ticks) || 0) + 1,
    last_event_at: existing.last_event_at || existing.first_seen,
  };
  const last = Date.parse(state.last_event_at);
  if (!Number.isFinite(last) || now.getTime() - last >= 60 * 60 * 1000) {
    state.last_event_at = now.toISOString();
    await saveHalt(state);
    await emitHalt(state);
  } else {
    await saveHalt(state);
  }
}

async function clearSenderAlert() {
  await pool.query('DELETE FROM app_settings WHERE key = ANY($1::text[])', [[SENDER_ALERT_KEY, HALT_KEY]]);
}

async function credentialsPass() {
  if (credentialOverride) return credentialOverride();
  if (testTransport) return true;
  let status;
  try {
    status = await gmail.status();
  } catch (err) {
    console.error(`[send] credential check did not pass: ${err && err.code || 'error'}`);
    return false;
  }
  if (status && status.connected) {
    try {
      await gmail.accessToken({ force: true });
      return true;
    } catch (err) {
      console.error(`[send] credential check did not pass: ${err && err.code || 'auth'}`);
      return false;
    }
  }
  if (cfg.mailConfigured()) {
    try {
      await smtpTransport().verify();
      return true;
    } catch (err) {
      console.error(`[send] credential check did not pass: ${err && err.code || 'smtp'}`);
      return false;
    }
  }
  return false;
}

async function releaseOwnedClaim(id, sentColumn, key) {
  const res = await pool.query(
    `UPDATE proposals
        SET send_attempt_key = NULL, ${sentColumn} = NULL
      WHERE id = $1 AND send_attempt_key = $2
      RETURNING id`,
    [id, key]);
  if (!res.rowCount) console.error(`[send] follow-up release matched 0 rows for #${id}`);
  return res.rowCount;
}

async function recordOutage(p, sentColumn, key, klass) {
  const bumped = await pool.query(
    `UPDATE proposals
        SET followup_transient_attempts = followup_transient_attempts + 1,
            first_transient_at = COALESCE(first_transient_at, NOW()),
            send_attempt_key = NULL,
            ${sentColumn} = NULL,
            error = $2
      WHERE id = $1 AND send_attempt_key = $3
      RETURNING followup_transient_attempts`,
    [p.id, `Follow-up will retry: ${klass.label}`, key]);
  if (!bumped.rowCount) {
    console.error(`[send] follow-up backoff matched 0 rows for #${p.id}`);
    return;
  }
  const attempt = Number(bumped.rows[0].followup_transient_attempts);
  const seconds = Math.round(backoffDelayMinutes(attempt) * 60);
  const scheduled = await pool.query(
    `UPDATE proposals
        SET next_retry_at = NOW() + make_interval(secs => $2)
      WHERE id = $1 AND send_attempt_key IS NULL
      RETURNING next_retry_at`,
    [p.id, seconds]);
  const next = scheduled.rows[0] && scheduled.rows[0].next_retry_at;
  console.error(`[send] follow-up for #${p.id} will retry: ${klass.label} attempt ${attempt} next ${next ? new Date(next).toISOString() : 'unscheduled'}`);
}

async function reapExpiredFollowupLeases() {
  await pool.query(
    `UPDATE proposals
        SET status = 'stopped', stop_reason = $1, error = $1, send_attempt_key = NULL
      WHERE status = 'sent'
        AND send_attempt_key IS NOT NULL
        AND send_attempted_at IS NOT NULL
        AND send_attempted_at < NOW() - INTERVAL '${STALE_SENDING}'`,
    [MANUAL_REVIEW]);
}

async function recordTransient(p, sentColumn, klass, key) {
  const cap = attemptCap(klass);
  const bump = async () => {
    if (failNextRelease) {
      failNextRelease = false;
      const err = new Error('release failed');
      err.code = '55P03';
      throw err;
    }
    return claimFollowupAttempt(p.id, cap);
  };
  let next;
  try {
    next = await bump();
  } catch (err) {
    console.error(`[send] follow-up release failed: ${err && err.code || 'error'}`);
    try {
      next = await claimFollowupAttempt(p.id, cap);
    } catch (err2) {
      console.error(`[send] follow-up release failed: ${err2 && err2.code || 'error'}`);
      await markManualReview(p.id, sentColumn, key);
      return;
    }
  }
  if (next == null || next >= cap) {
    const reason = capStopReason(klass.label);
    await pool.query(
      `UPDATE proposals
          SET status = 'stopped', stop_reason = $2, error = $2, ${sentColumn} = NULL, send_attempt_key = NULL
        WHERE id = $1 AND send_attempt_key = $3 AND status IN ('sent', 'sending')`,
      [p.id, reason, key]);
    const note = klass.label === 'argument' ? 'Gmail invalid argument (not the recipient)' : reason;
    console.error(`[send] stopped follow-up for #${p.id}: ${note}`);
    return;
  }
  const released = await pool.query(
    `UPDATE proposals
        SET send_attempt_key = NULL, ${sentColumn} = NULL, error = $2,
            status = CASE WHEN status = 'sending' THEN 'sent' ELSE status END
      WHERE id = $1 AND send_attempt_key = $3
      RETURNING id`,
    [p.id, `Follow-up will retry: ${klass.label} (${next}/${cap})`, key]);
  if (!released.rowCount) {
    console.error(`[send] follow-up retry write matched 0 rows for #${p.id}`);
    return;
  }
  if (klass.label === 'argument') {
    console.error(`[send] follow-up for #${p.id} will retry: Gmail invalid argument (not the recipient) (${next}/${cap})`);
  } else {
    console.error(`[send] follow-up for #${p.id} will retry: ${klass.label} (${next}/${cap})`);
  }
}

/** Send any follow-ups that are due. Called every 15 minutes and from check-inbox. */
async function sendDueFollowups() {
  // The lock is session-level. Acquire and release it on the same client.
  // pool.query would check the lock out on one connection and unlock on another.
  // A terminated backend emits 'error'. Without a listener that crashes the
  // process. A failed unlock destroys the client so the lock cannot stay on a
  // pooled session.
  const client = await pool.connect();
  let held = false;
  let failed = null;
  const onError = (err) => {
    failed = err || new Error('follow-up sweep client error');
    console.error(`[send] follow-up sweep client error: ${err && err.code || 'error'}`);
  };
  client.on('error', onError);
  try {
    const locked = await client.query('SELECT pg_try_advisory_lock($1::bigint) AS ok', [FOLLOWUP_SWEEP_LOCK]);
    held = !!(locked.rows[0] && locked.rows[0].ok);
    if (!held) return { sent: 0, skipped: true };
    return await sendDueFollowupsLocked();
  } finally {
    if (held && !failed) {
      try {
        await client.query('SELECT pg_advisory_unlock($1::bigint)', [FOLLOWUP_SWEEP_LOCK]);
      } catch (err) {
        failed = err || new Error('follow-up sweep unlock failed');
        console.error(`[send] follow-up sweep unlock failed: ${err && err.code || 'error'}`);
      }
    }
    client.removeListener('error', onError);
    if (failed) client.release(failed instanceof Error ? failed : new Error('follow-up sweep client failed'));
    else client.release();
  }
}

async function sendDueFollowupsLocked() {
  await recoverStaleSending();
  await reapExpiredFollowupLeases();
  const rows = await loadDueFollowups();
  const ready = [];
  // Stop a sequence with no usable address before the mail and send-window
  // gate. Otherwise a row stays due all weekend, and whenever Gmail is unset.
  for (const p of rows) {
    try {
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
      if (await stopUnusableRecipient(p)) continue;
      ready.push(p);
    } catch (err) {
      logFollowupSkip(p, err);
    }
  }
  if (!(await mailMode()) || !SENDER.address || !inSendWindow()) return { sent: 0 };
  let sent = 0;
  let halted = false;
  for (const p of ready) {
    try {
      if (p.do_not_contact || ACTIVE_STAGES_TO_STOP.includes(p.stage)) {
        await stopSequence(p.id, p.do_not_contact ? 'Lead is do-not-contact' : `Lead moved to ${p.stage}`);
        continue;
      }
      if (await sentToday() >= cfg.SEND_DAILY_LIMIT) break;
      if (await stopUnusableRecipient(p)) continue;
      const which = p.followup1_sent_at ? 'followup2' : 'followup1';
      const sentColumn = followupSentColumn(which);
      const toAddress = storedRecipient(p.to_email);
      if (!toAddress) {
        await stopUnusableRecipient(p);
        continue;
      }
      const aged = await pool.query(
        `UPDATE proposals
            SET status = $2, stop_reason = $3, error = $3, next_retry_at = NULL
          WHERE id = $1 AND status = 'sent' AND send_attempt_key IS NULL
            AND first_transient_at IS NOT NULL
            AND first_transient_at <= NOW() - INTERVAL '72 hours'
          RETURNING id`,
        [p.id, MANUAL_REVIEW_STATUS, TRANSIENT_MAX_AGE]);
      if (aged.rowCount) {
        console.error(`[send] follow-up for #${p.id} reached transient_max_age`);
        continue;
      }
      if (beforeFollowupClaim) await beforeFollowupClaim(p);
      const attemptKey = await claimFollowupSend(p, sentColumn);
      if (!attemptKey) {
        const fresh = await reloadFollowup(p.id);
        if (fresh && fresh.send_attempt_key) continue;
        if (fresh && (fresh.do_not_contact || ACTIVE_STAGES_TO_STOP.includes(fresh.stage))) {
          await stopSequence(p.id, fresh.do_not_contact ? 'Lead is do-not-contact' : `Lead moved to ${fresh.stage}`);
        }
        continue;
      }
      let mailed = false;
      let stopSweep = false;
      try {
        await attachPrototypeUrl(p);
        const mail = {
          threadId: p.thread_id || undefined,
          from: { name: SENDER.name, address: SENDER.email },
          to: envelopeTo(p.to_name, toAddress),
          subject: /^re:/i.test(p.subject) ? p.subject : `Re: ${p.subject}`,
          text: renderMessage(p, which),
          html: renderMessageHtml(p, which),
          inReplyTo: p.message_id || undefined,
          references: p.message_id ? [p.message_id] : undefined,
          headers: { 'List-Unsubscribe': `<mailto:${SENDER.email}?subject=unsubscribe>` },
        };
        const prepared = await prepareOutgoing(mail);
        const gate = await recheckLead(p.prospect_id);
        const block = leadBlocksSend(gate);
        if (block) {
          await releaseOwnedClaim(p.id, sentColumn, attemptKey);
          if (block === 'do_not_contact' || block === 'stage') {
            await stopSequence(p.id, block === 'do_not_contact' ? 'Lead is do-not-contact' : `Lead moved to ${gate.stage}`);
          }
          continue;
        }
        await prepared.send();
        mailed = true;
        if (failNextPostSend) {
          failNextPostSend = false;
          const fault = new Error('post-send write failed');
          fault.code = 'POST_SEND_WRITE';
          throw fault;
        }
        const wrote = await pool.query(
          `UPDATE proposals
              SET ${sentColumn} = NOW(), error = NULL, followup_argument_attempts = 0, send_attempt_key = NULL,
                  followup_transient_attempts = 0, first_transient_at = NULL, next_retry_at = NULL
            WHERE id = $1 AND status = 'sent' AND send_attempt_key = $2
            RETURNING id`,
          [p.id, attemptKey]);
        if (!wrote.rowCount) {
          console.error(`[send] follow-up success write matched 0 rows for #${p.id}`);
          await markManualReview(p.id, sentColumn, attemptKey);
        } else {
          sent++;
          await clearSenderAlert();
          await pool.query(`UPDATE prospects SET last_contacted_at = NOW() WHERE id = $1`, [p.prospect_id]);
          await logActivity(p.prospect_id, 'email', `Sent ${which === 'followup1' ? 'follow-up 1' : 'follow-up 2 (last)'} to ${toAddress}.`);
        }
      } catch (err) {
        if (mailed || uncertainSend(err)) {
          await markManualReview(p.id, sentColumn, attemptKey);
        } else if (isPermanentFollowupError(err)) {
          const reason = permanentFollowupReason(err);
          const stopped = await pool.query(
            `UPDATE proposals
                SET status = 'stopped', stop_reason = $2, error = $2, ${sentColumn} = NULL, send_attempt_key = NULL
              WHERE id = $1 AND send_attempt_key = $3 AND status IN ('sent', 'sending')
              RETURNING id`,
            [p.id, reason, attemptKey]);
          if (!stopped.rowCount) console.error(`[send] follow-up stop matched 0 rows for #${p.id}`);
          else console.info(`[send] stopped follow-up for #${p.id}: ${reason}`);
        } else {
          const klass = classifyFollowupError(err);
          if (klass.sweep) {
            const released = await pool.query(
              `UPDATE proposals
                  SET send_attempt_key = NULL, ${sentColumn} = NULL, error = $2
                WHERE id = $1 AND send_attempt_key = $3
                RETURNING id`,
              [p.id, `Follow-up will retry: ${klass.label}`, attemptKey]);
            if (!released.rowCount) console.error(`[send] follow-up release matched 0 rows for #${p.id}`);
            await recordHalt(klass, err);
            stopSweep = true;
            halted = true;
          } else if (isOutageClass(klass)) {
            const agedNow = await pool.query(
              `UPDATE proposals
                  SET status = $2, stop_reason = $3, error = $3, send_attempt_key = NULL,
                      ${sentColumn} = NULL, next_retry_at = NULL
                WHERE id = $1 AND send_attempt_key = $4
                  AND first_transient_at IS NOT NULL
                  AND first_transient_at <= NOW() - INTERVAL '72 hours'
                RETURNING id`,
              [p.id, MANUAL_REVIEW_STATUS, TRANSIENT_MAX_AGE, attemptKey]);
            if (agedNow.rowCount) console.error(`[send] follow-up for #${p.id} reached transient_max_age`);
            else await recordOutage(p, sentColumn, attemptKey, klass);
          } else {
            await recordTransient(p, sentColumn, klass, attemptKey);
          }
        }
      }
      if (stopSweep) break;
    } catch (err) {
      logFollowupSkip(p, err);
    }
  }
  if (!halted && await credentialsPass()) await clearSenderAlert();
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
    await pool.query(`UPDATE prospects SET do_not_contact = TRUE, stage = 'lost' WHERE id = $1`, [p.prospect_id]);
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
  approveAndSend, sendDueFollowups, attachPrototypeUrl, withPrototype, checkInbox, inboxCandidates, conversationCandidates, applyInboxMessages, mailer, prepareOutgoing, senderTick, stopSequence, classifyMessage, applyOutcome,
  missingRecipient, normalizeRecipient, storedRecipient, isPermanentFollowupError, classifyFollowupError, ARGUMENT_ATTEMPTS, claimFollowupAttempt,
  renderMessage, renderMessageHtml, addedLines, withBooking, fillPlaceholders, onepagerUrl, inSendWindow, sendReadiness, sentToday, mailMode, _setTransport,
  _beforeFollowupClaim, _beforeTransport, _failNextRelease, _failNextPostSend, _resetSendTestHooks,
  _setRandom, _setAlertHook, _setCredentialCheck,
  backoffDelayMs, backoffDelayMinutes, recheckLead, BACKOFF_CAP_MS,
  FOLLOWUP_BACKOFF_CAP_MS, FOLLOWUP_MAX_AGE_MS, RESEND_CONFIRM,
};
