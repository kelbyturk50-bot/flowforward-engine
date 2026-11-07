// Gmail over HTTPS (Gmail API) — used instead of SMTP/IMAP because Railway
// blocks outbound SMTP on non-Pro plans. Mail still goes out from your Gmail
// account, lands in its Sent folder, and replies arrive in its inbox.
//
// Setup: create an OAuth client in Google Cloud (see README), put
// GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in Railway, then click
// "Connect Gmail" in the CRM's Settings. The refresh token is stored in
// app_settings (key gmail_oauth); nothing else needs copying around.

const crypto = require('crypto');
const axios  = require('axios');
const MailComposer = require('nodemailer/lib/mail-composer');
const pool   = require('../db/client');
const { PUBLIC_BASE_URL, SENDER } = require('./config');

const SCOPES = [
  'https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/gmail.readonly',
];
const API = 'https://gmail.googleapis.com/gmail/v1/users/me';
const REDIRECT_PATH = '/oauth/google/callback';
const redirectUri = () => `${PUBLIC_BASE_URL}${REDIRECT_PATH}`;

const clientConfigured = () => !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);

async function getSetting(key) {
  const { rows } = await pool.query('SELECT value FROM app_settings WHERE key = $1', [key]);
  return rows[0]?.value ?? null;
}
async function putSetting(key, value) {
  await pool.query(`INSERT INTO app_settings (key, value, updated_at) VALUES ($1, $2, NOW())
                    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`, [key, JSON.stringify(value)]);
}

/** { configured, connected, email, connected_at, error } */
async function status() {
  const saved = await getSetting('gmail_oauth');
  return {
    configured: clientConfigured(),
    connected: !!(clientConfigured() && saved?.refresh_token),
    email: saved?.email || null,
    connected_at: saved?.connected_at || null,
    error: saved?.last_error || null,
  };
}

// ── OAuth ─────────────────────────────────────────────────────────────────
async function authUrl(returnTo) {
  if (!clientConfigured()) throw Object.assign(new Error('Add GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in Railway Variables first.'), { status: 400 });
  const state = crypto.randomBytes(24).toString('hex');
  const safeReturn = /^https?:\/\/[^\s]+$/i.test(returnTo || '') ? returnTo : null;
  await putSetting('gmail_oauth_state', { state, return_to: safeReturn, created_at: new Date().toISOString() });
  const q = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID,
    redirect_uri: redirectUri(),
    response_type: 'code',
    scope: SCOPES.join(' '),
    access_type: 'offline',
    prompt: 'consent',            // always return a refresh token
    include_granted_scopes: 'true',
    login_hint: SENDER.email,
    state,
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${q}`;
}

async function handleCallback({ code, state, error }) {
  const saved = await getSetting('gmail_oauth_state');
  const returnTo = saved?.return_to || null;
  if (error) return { ok: false, returnTo, message: `Google said: ${error}` };
  const fresh = saved && Date.now() - new Date(saved.created_at).getTime() < 15 * 60 * 1000;
  if (!saved || !fresh || !state || saved.state !== state) return { ok: false, returnTo, message: 'That sign-in link expired. Click Connect Gmail again.' };
  await pool.query(`DELETE FROM app_settings WHERE key = 'gmail_oauth_state'`);

  const tok = await axios.post('https://oauth2.googleapis.com/token', new URLSearchParams({
    code, client_id: process.env.GOOGLE_CLIENT_ID, client_secret: process.env.GOOGLE_CLIENT_SECRET,
    redirect_uri: redirectUri(), grant_type: 'authorization_code',
  }), { timeout: 15000 }).then(r => r.data);
  if (!tok.refresh_token) return { ok: false, returnTo, message: 'Google did not return a long-lived token. Remove FlowForward from your Google account permissions and connect again.' };
  const granted = String(tok.scope || '');
  if (!SCOPES.every(s => granted.includes(s))) {
    return { ok: false, returnTo, message: 'Please tick both Gmail permissions (send, and read) on the Google screen.' };
  }
  const profile = await axios.get(`${API}/profile`, { headers: { Authorization: `Bearer ${tok.access_token}` }, timeout: 15000 }).then(r => r.data);
  await putSetting('gmail_oauth', { refresh_token: tok.refresh_token, email: profile.emailAddress, connected_at: new Date().toISOString() });
  cache = { token: tok.access_token, exp: Date.now() + (tok.expires_in - 60) * 1000 };
  return { ok: true, returnTo, email: profile.emailAddress };
}

async function disconnect() {
  const saved = await getSetting('gmail_oauth');
  if (saved?.refresh_token) {
    await axios.post('https://oauth2.googleapis.com/revoke', new URLSearchParams({ token: saved.refresh_token }), { timeout: 10000 }).catch(() => {});
  }
  await pool.query(`DELETE FROM app_settings WHERE key = 'gmail_oauth'`);
  cache = null;
}

let cache = null;
async function accessToken() {
  if (cache && cache.exp > Date.now()) return cache.token;
  const saved = await getSetting('gmail_oauth');
  if (!saved?.refresh_token) throw new Error('Gmail is not connected. Go to Settings and click Connect Gmail.');
  try {
    const tok = await axios.post('https://oauth2.googleapis.com/token', new URLSearchParams({
      client_id: process.env.GOOGLE_CLIENT_ID, client_secret: process.env.GOOGLE_CLIENT_SECRET,
      refresh_token: saved.refresh_token, grant_type: 'refresh_token',
    }), { timeout: 15000 }).then(r => r.data);
    cache = { token: tok.access_token, exp: Date.now() + (tok.expires_in - 60) * 1000 };
    if (saved.last_error) await putSetting('gmail_oauth', { ...saved, last_error: null });
    return cache.token;
  } catch (err) {
    const reason = err.response?.data?.error;
    if (reason === 'invalid_grant') {
      await putSetting('gmail_oauth', { ...saved, last_error: 'Google revoked access (expired or removed). Click Connect Gmail again.' });
      throw new Error('Gmail access expired. Go to Settings and click Connect Gmail again.');
    }
    throw new Error(`Couldn't refresh Gmail access: ${reason || err.message}`);
  }
}

// Google answers a used-up quota with 429, or 403 rateLimitExceeded /
// userRateLimitExceeded, with "Quota exceeded" in the message.
function isQuotaError(status, data) {
  const reasons = (data?.error?.errors || []).map(e => e && e.reason);
  if (status === 429) return true;
  if (status === 403 && reasons.some(r => /ratelimitexceeded|quotaexceeded/i.test(String(r)))) return true;
  return /quota exceeded|rate limit exceeded/i.test(String(data?.error?.message || ''));
}

let apiOverride = null;
function _setApiForTests(fn) {
  if (process.env.NODE_ENV !== 'test') throw new Error('_setApiForTests is only available when NODE_ENV=test');
  apiOverride = fn || null;
}

async function gmail(method, path, { data, params } = {}) {
  if (apiOverride) return apiOverride(method, path, { data, params });
  const token = await accessToken();
  try {
    const res = await axios({ method, url: `${API}${path}`, data, params, timeout: 20000, headers: { Authorization: `Bearer ${token}` } });
    return res.data;
  } catch (err) {
    const status = err.response?.status || 0;
    const msg = err.response?.data?.error?.message || err.message;
    throw Object.assign(new Error(`Gmail API: ${msg}`), { status, quota: isQuotaError(status, err.response?.data) });
  }
}

// ── Sending ───────────────────────────────────────────────────────────────
function toBase64Url(buf) { return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }

/** Same shape as nodemailer's sendMail; also accepts threadId. Returns { messageId, threadId, id }. */
async function sendMail(mail) {
  const saved = await getSetting('gmail_oauth');
  const fromAddr = saved?.email || SENDER.email;
  const from = typeof mail.from === 'object' ? { ...mail.from, address: fromAddr } : fromAddr;
  const raw = await new MailComposer({ ...mail, from, threadId: undefined }).compile().build();
  const sent = await gmail('post', '/messages/send', { data: { raw: toBase64Url(raw), ...(mail.threadId ? { threadId: mail.threadId } : {}) } });
  // Read back the Message-ID Gmail actually used, for threading follow-ups.
  let messageId = null;
  try {
    const meta = await gmail('get', `/messages/${sent.id}`, { params: { format: 'metadata', metadataHeaders: 'Message-ID' } });
    messageId = (meta.payload?.headers || []).find(h => h.name.toLowerCase() === 'message-id')?.value || null;
  } catch { /* threading still works via threadId */ }
  return { id: sent.id, threadId: sent.threadId, messageId };
}

// ── Reading ───────────────────────────────────────────────────────────────
function header(headers, name) { return (headers || []).find(h => h.name.toLowerCase() === name)?.value || ''; }
function decode(b64) { return Buffer.from(String(b64 || '').replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'); }
function bodyText(payload) {
  let plain = ''; let html = '';
  (function walk(p) {
    if (!p) return;
    if (p.mimeType === 'text/plain' && p.body?.data && !plain) plain = decode(p.body.data);
    else if (p.mimeType === 'text/html' && p.body?.data && !html) html = decode(p.body.data);
    (p.parts || []).forEach(walk);
  })(payload);
  if (plain) return plain;
  return html.replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ').replace(/<br\s*\/?>/gi, '\n').replace(/<\/p>/gi, '\n\n')
    .replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/[ \t]+/g, ' ');
}

// ── Reading on a quota budget ────────────────────────────────────────────
// Gmail charges quota units per call and allows 6,000 units per user per
// minute (developers.google.com/workspace/gmail/api/reference/quota, checked
// Nov 3, 2026). Reading one message in full costs 60, so re-reading a few
// hundred messages every 15 minutes used the whole minute and left nothing
// for sending follow-ups. Each tick lists only the newest 300 inbox messages
// and the newest Sent page, the same windows main reads. A message already
// applied is not fetched again. Reads from the 15-minute scan and from
// Check inbox now share one per-minute budget. A used-up quota or a short
// list stops this tick; it does not authorize a send.
const COST = Object.freeze({ list: 5, get: 60 });
const READ_BUDGET = 3600; // leaves 2,400 of the minute's 6,000 for sends
const MINUTE_MS = 60 * 1000;

function readBudget(units = READ_BUDGET) { return { units, quotaHit: false }; }

// The cron scan and POST /api/proposals/check-inbox both charge the bucket
// for the wall-clock minute of each call. A scan that starts in one minute
// and continues into the next is charged to the new minute from then on,
// and a later check in that minute sees what the scan already spent.
let nowFn = () => Date.now();
let minuteBucket = null;

function clockNow() { return nowFn(); }

function currentMinuteBucket() {
  const minute = Math.floor(clockNow() / MINUTE_MS);
  if (!minuteBucket || minuteBucket.minute !== minute) {
    minuteBucket = { minute, units: READ_BUDGET, quotaHit: false };
  }
  return minuteBucket;
}

// A live view. The list and the reads keep one object for the whole scan, and
// every read of units or quotaHit follows the clock into the current minute.
function minuteReadBudget() {
  const view = {};
  Object.defineProperties(view, {
    units: {
      enumerable: true,
      get() { return currentMinuteBucket().units; },
      set(value) { currentMinuteBucket().units = value; },
    },
    quotaHit: {
      enumerable: true,
      get() { return currentMinuteBucket().quotaHit; },
      set(value) { currentMinuteBucket().quotaHit = value; },
    },
  });
  return view;
}

function _setClockForTests(fn) {
  if (process.env.NODE_ENV !== 'test') throw new Error('_setClockForTests is only available when NODE_ENV=test');
  nowFn = typeof fn === 'function' ? fn : () => Date.now();
}

function resetReadBudgetForTests() {
  if (process.env.NODE_ENV !== 'test') throw new Error('resetReadBudgetForTests is only available when NODE_ENV=test');
  minuteBucket = null;
}

async function scannedIds(ids) {
  if (!ids.length) return new Set();
  const { rows } = await pool.query(`SELECT gmail_id FROM gmail_scanned_messages WHERE gmail_id = ANY($1::text[])`, [ids]);
  return new Set(rows.map(r => r.gmail_id));
}

// Same shape as gmail_scanned_messages_id_check. A bad id is skipped so one
// row cannot roll back the rest of the batch.
const GMAIL_ID = /^[A-Za-z0-9_-]{1,64}$/;

/** Record message ids as read, once their outcomes are applied. */
async function markScanned(entries) {
  const list = (entries || []).filter(e => e && typeof e.id === 'string' && GMAIL_ID.test(e.id) && (e.box === 'inbox' || e.box === 'sent'));
  if (!list.length) return 0;
  const res = await pool.query(
    `INSERT INTO gmail_scanned_messages (gmail_id, box)
     SELECT * FROM UNNEST($1::text[], $2::text[])
     ON CONFLICT (gmail_id) DO NOTHING`,
    [list.map(e => e.id), list.map(e => e.box)]);
  return res.rowCount;
}

async function purgeScanned(days = 120) {
  await pool.query(`DELETE FROM gmail_scanned_messages WHERE scanned_at < NOW() - make_interval(days => $1)`, [days]);
}

const INBOX_WINDOW = 300;
const SENT_WINDOW = 100;

// List the newest ids only, the same window main reads. No page token is
// stored. A list that stops early is incomplete: this tick must not send.
async function listWindow(q, budget, maxIds, { onePage = false } = {}) {
  const ids = [];
  let pageToken;
  while (ids.length < maxIds) {
    if (budget.units < COST.list) return { ids: ids.slice(0, maxIds), incomplete: true };
    budget.units -= COST.list;
    let page;
    try {
      const params = { q, maxResults: Math.min(100, maxIds), pageToken };
      page = await gmail('get', '/messages', { params });
    } catch (err) {
      if (err.quota) { budget.quotaHit = true; budget.units = 0; }
      throw err;
    }
    ids.push(...(page.messages || []).map(m => m.id));
    if (onePage || !page.nextPageToken) return { ids: ids.slice(0, maxIds), incomplete: false };
    pageToken = page.nextPageToken;
  }
  return { ids: ids.slice(0, maxIds), incomplete: false };
}

// ids are already in read order. Already-scanned ids are not fetched again.
// A 404 will not come back. Any other read error stays unread so the tick
// is not a successful check. Quota stops the scan.
async function readWindow(ids, box, budget, shape) {
  const seen = await scannedIds(ids);
  const fresh = ids.filter(id => !seen.has(id));
  const messages = [];
  const scanned = [];
  let readFailed = false;
  for (const id of fresh) {
    if (budget.quotaHit || budget.units < COST.get) break;
    budget.units -= COST.get;
    try {
      const m = await gmail('get', `/messages/${id}`, { params: { format: 'full' } });
      messages.push(await shape(m));
      scanned.push(id);
    } catch (err) {
      if (err.quota) { budget.quotaHit = true; budget.units = 0; break; }
      if (err.status === 404) { scanned.push(id); continue; }
      readFailed = true;
      console.error(`[gmail] skip ${box} ${id}: ${err.message}`);
    }
  }
  const done = new Set(scanned);
  const backlog = fresh.filter(id => !done.has(id)).length;
  return { messages, scanned, backlog, readFailed };
}

function finishWindow(listed, read, budget, order) {
  if ((listed.incomplete || budget.quotaHit || read.readFailed) && read.backlog < 1) read.backlog = 1;
  read.listIncomplete = !!(listed.incomplete || read.backlog > 0 || read.readFailed || budget.quotaHit);
  read.complete = !read.listIncomplete;
  read.order = order;
  return read;
}

function inboxShape(m) {
  const h = m.payload?.headers;
  const fromHeader = header(h, 'from');
  return {
    id: m.id,
    threadId: m.threadId,
    from: (fromHeader.match(/<([^>]+)>/)?.[1] || fromHeader).trim().toLowerCase(),
    subject: header(h, 'subject'),
    date: m.internalDate ? new Date(Number(m.internalDate)) : null,
    inReplyTo: header(h, 'in-reply-to'),
    references: header(h, 'references').split(/\s+/).filter(Boolean),
    messageIdHeader: header(h, 'message-id') || null,
    auto: isAutoReply(h),
    text: bodyText(m.payload).slice(0, 20000),
  };
}

/** Newest 300 inbox messages since a date. Gmail lists newest-first; within that window the read is oldest-first, matching main. */
async function scanInbox(since, budget = readBudget()) {
  const after = Math.floor(new Date(since).getTime() / 1000);
  const listed = await listWindow(`in:inbox after:${after} -from:me`, budget, INBOX_WINDOW);
  const read = await readWindow(listed.ids.slice().reverse(), 'inbox', budget, inboxShape);
  return finishWindow(listed, read, budget, 'oldest');
}

/** Inbox messages since a date, newest last, in the shape classifyMessage expects. */
async function inboxSince(since) {
  return (await scanInbox(since, readBudget())).messages;
}

// RFC 3834 Auto-Submitted plus the common vendor headers for vacation replies.
function isAutoReply(headers) {
  const auto = header(headers, 'auto-submitted').toLowerCase();
  if (auto && auto !== 'no') return true;
  if (header(headers, 'x-autoreply') || header(headers, 'x-autorespond') || header(headers, 'x-auto-response-suppress')) return true;
  return /auto_reply|auto-reply/i.test(header(headers, 'precedence'));
}

/** Newest Sent page since a date, newest-first, matching main's one-page sent check. */
async function scanSent(since, budget = readBudget()) {
  const after = Math.floor(new Date(since).getTime() / 1000);
  const fromEmail = (await getSetting('gmail_oauth'))?.email || SENDER.email;
  const listed = await listWindow(`in:sent after:${after}`, budget, SENT_WINDOW, { onePage: true });
  const read = await readWindow(listed.ids, 'sent', budget, (m) => {
    const h = m.payload?.headers;
    const toHeader = header(h, 'to');
    return {
      id: m.id, threadId: m.threadId,
      from: fromEmail,
      to: (toHeader.match(/<([^>]+)>/)?.[1] || toHeader).trim().toLowerCase(),
      subject: header(h, 'subject'),
      date: m.internalDate ? new Date(Number(m.internalDate)) : null,
      messageIdHeader: header(h, 'message-id') || null,
      text: bodyText(m.payload).slice(0, 20000),
    };
  });
  return finishWindow(listed, read, budget, 'newest');
}

/** Messages Kelby sent from Gmail since a date (to catch replies he sent outside the CRM). */
async function sentSince(since) {
  return (await scanSent(since, readBudget())).messages;
}

module.exports = {
  status, authUrl, handleCallback, disconnect, sendMail, inboxSince, sentSince, scanInbox, scanSent, markScanned, purgeScanned,
  readBudget, minuteReadBudget, isQuotaError, COST, READ_BUDGET, isAutoReply, clientConfigured, REDIRECT_PATH, redirectUri, SCOPES,
  clockNow, _bodyText: bodyText, _setApiForTests, _setClockForTests, resetReadBudgetForTests,
};
