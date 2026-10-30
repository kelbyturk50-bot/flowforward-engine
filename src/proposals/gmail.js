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
async function accessToken(options = {}) {
  if (!options.force && cache && cache.exp > Date.now()) return cache.token;
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

async function gmail(method, path, { data, params } = {}) {
  const token = await accessToken();
  try {
    const res = await axios({ method, url: `${API}${path}`, data, params, timeout: 20000, headers: { Authorization: `Bearer ${token}` } });
    return res.data;
  } catch (err) {
    const body = err.response?.data?.error;
    const msg = body?.message || err.message;
    const wrapped = new Error(`Gmail API: ${msg}`);
    const status = err.response?.status;
    if (Number.isInteger(status)) wrapped.status = status;
    else if (body && Number.isInteger(body.code)) wrapped.status = body.code;
    if (body?.status) wrapped.gmailStatus = String(body.status);
    const listed = Array.isArray(body?.errors)
      ? body.errors.map((item) => item && item.reason).find(Boolean)
      : null;
    const reason = listed || body?.reason || null;
    if (reason) wrapped.reason = String(reason);
    if (Array.isArray(body?.errors)) {
      wrapped.errors = body.errors.map((item) => ({
        reason: item && item.reason,
        message: item && item.message,
      }));
    }
    if (typeof err.code === 'string' && !/^\d{3}$/.test(err.code)) wrapped.code = err.code;
    throw wrapped;
  }
}

// ── Sending ───────────────────────────────────────────────────────────────
function toBase64Url(buf) { return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }

function wrapGmailError(err) {
  const body = err.response?.data?.error;
  const msg = body?.message || err.message;
  const wrapped = new Error(`Gmail API: ${msg}`);
  const status = err.response?.status;
  if (Number.isInteger(status)) wrapped.status = status;
  else if (body && Number.isInteger(body.code)) wrapped.status = body.code;
  if (body?.status) wrapped.gmailStatus = String(body.status);
  const listed = Array.isArray(body?.errors)
    ? body.errors.map((item) => item && item.reason).find(Boolean)
    : null;
  const reason = listed || body?.reason || null;
  if (reason) wrapped.reason = String(reason);
  if (Array.isArray(body?.errors)) {
    wrapped.errors = body.errors.map((item) => ({
      reason: item && item.reason,
      message: item && item.message,
    }));
  }
  if (typeof err.code === 'string' && !/^\d{3}$/.test(err.code)) wrapped.code = err.code;
  return wrapped;
}

// Every settings read and the token refresh happen here. send() only posts
// the message that was already addressed with that token.
async function prepareDelivery() {
  const saved = await getSetting('gmail_oauth');
  const token = await module.exports.accessToken({ force: true });
  const fromAddr = saved?.email || SENDER.email;
  return {
    fromAddr,
    async send(mail) {
      const from = typeof mail.from === 'object' ? { ...mail.from, address: fromAddr } : fromAddr;
      const raw = await new MailComposer({ ...mail, from, threadId: undefined }).compile().build();
      let sent;
      try {
        const res = await axios({
          method: 'post',
          url: `${API}/messages/send`,
          data: { raw: toBase64Url(raw), ...(mail.threadId ? { threadId: mail.threadId } : {}) },
          timeout: 20000,
          headers: { Authorization: `Bearer ${token}` },
        });
        sent = res.data;
      } catch (err) {
        throw wrapGmailError(err);
      }
      let messageId = null;
      try {
        const meta = await axios({
          method: 'get',
          url: `${API}/messages/${sent.id}`,
          params: { format: 'metadata', metadataHeaders: 'Message-ID' },
          timeout: 20000,
          headers: { Authorization: `Bearer ${token}` },
        });
        messageId = (meta.data.payload?.headers || []).find((h) => h.name.toLowerCase() === 'message-id')?.value || null;
      } catch { /* threading still works via threadId */ }
      return { id: sent.id, threadId: sent.threadId, messageId };
    },
  };
}

/** Same shape as nodemailer's sendMail; also accepts threadId. Returns { messageId, threadId, id }. */
async function sendMail(mail) {
  const prepared = await prepareDelivery();
  return prepared.send(mail);
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

/** Inbox messages since a date, newest last, in the shape classifyMessage expects. */
async function inboxSince(since, max = 300) {
  const after = Math.floor(new Date(since).getTime() / 1000);
  const ids = []; let pageToken;
  do {
    const page = await gmail('get', '/messages', { params: { q: `in:inbox after:${after} -from:me`, maxResults: 100, pageToken } });
    ids.push(...(page.messages || []).map(m => m.id));
    pageToken = page.nextPageToken;
  } while (pageToken && ids.length < max);

  const out = [];
  for (const id of ids.slice(0, max).reverse()) {
    try {
      const m = await gmail('get', `/messages/${id}`, { params: { format: 'full' } });
      const h = m.payload?.headers;
      const fromHeader = header(h, 'from');
      out.push({
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
      });
    } catch (err) { console.error(`[gmail] skip ${id}: ${err.message}`); }
  }
  return out;
}

// RFC 3834 Auto-Submitted plus the common vendor headers for vacation replies.
function isAutoReply(headers) {
  const auto = header(headers, 'auto-submitted').toLowerCase();
  if (auto && auto !== 'no') return true;
  if (header(headers, 'x-autoreply') || header(headers, 'x-autorespond') || header(headers, 'x-auto-response-suppress')) return true;
  return /auto_reply|auto-reply/i.test(header(headers, 'precedence'));
}

/** Messages Kelby sent from Gmail since a date (to catch replies he sent outside the CRM). */
async function sentSince(since, max = 100) {
  const after = Math.floor(new Date(since).getTime() / 1000);
  const page = await gmail('get', '/messages', { params: { q: `in:sent after:${after}`, maxResults: Math.min(max, 100) } });
  const out = [];
  for (const { id } of page.messages || []) {
    try {
      const m = await gmail('get', `/messages/${id}`, { params: { format: 'full' } });
      const h = m.payload?.headers;
      const toHeader = header(h, 'to');
      out.push({
        id: m.id, threadId: m.threadId,
        from: (await getSetting('gmail_oauth'))?.email || SENDER.email,
        to: (toHeader.match(/<([^>]+)>/)?.[1] || toHeader).trim().toLowerCase(),
        subject: header(h, 'subject'),
        date: m.internalDate ? new Date(Number(m.internalDate)) : null,
        messageIdHeader: header(h, 'message-id') || null,
        text: bodyText(m.payload).slice(0, 20000),
      });
    } catch (err) { console.error(`[gmail] skip sent ${id}: ${err.message}`); }
  }
  return out;
}

module.exports = { status, authUrl, handleCallback, disconnect, accessToken, prepareDelivery, sendMail, inboxSince, sentSince, isAutoReply, clientConfigured, REDIRECT_PATH, redirectUri, SCOPES, _bodyText: bodyText };
