// Public voice routes. docs/VOICE_DEMO.md.
//
//   GET  /api/public/prototypes/:token/voice           is a call possible on this link?
//   POST /api/public/prototypes/:token/voice/session   start one call (Retell web call)
//   POST /api/public/voice/retell-webhook              Retell call_ended -> settle minutes
//
// Mounted before cors() and the global JSON parser (src/chatdemo/mount.js).
// Browser CORS is the chat allowlist (src/chatdemo/cors.js). The prototype
// token is the credential. Logs carry error codes and counts only: no IP,
// no token, no call content.
//
// Order for a session, cheapest refusal first:
//   415 unless Content-Type is application/json
//   429 voice_rate when the IP minted too many calls this hour (in memory)
//   404 when the chat surface flags are off, or the token is unknown/revoked
//   410 when the link expired
//   503 voice_unavailable when the env config is incomplete (calls are off)
//   429 voice_limit { reason: link | day | busy } from the Postgres caps
//   502 voice_failed when Retell refuses or times out (minutes released)
//   201 { call_id, access_token, transport?, ice_servers?, expires_at? }

const express = require('express');
const { chatCors } = require('../chatdemo/cors');
const { effective } = require('../flags/resolve');
const { lookupToken } = require('../prototypes/store');
const { clientIp, consume } = require('../pilot/rate-limit');
const { publicBrandName } = require('../prototypes/brand-name');
const pool = require('../db/client');
const { VOICE_CAPS, voiceConfig } = require('./config');
const { voiceVariables, beginMessage } = require('./variables');
const retell = require('./retell');
const store = require('./store');

const NOT_FOUND = Buffer.from('{"error":"not_found"}');

function stamp(res) {
  res.set('Cache-Control', 'no-store');
  res.set('X-Robots-Tag', 'noindex, nofollow');
  res.set('Referrer-Policy', 'no-referrer');
  res.set('X-Content-Type-Options', 'nosniff');
}

function send(res, status, body) {
  stamp(res);
  res.status(status);
  res.set('Content-Type', 'application/json; charset=utf-8');
  res.end(Buffer.isBuffer(body) ? body : JSON.stringify(body));
}

function log(event, extra = '') {
  console.log(`[voice] ${event}${extra ? ` ${extra}` : ''}`);
}

function jsonType(header) {
  if (typeof header !== 'string' || header.length > 200) return false;
  const [type, ...params] = header.split(';');
  if (type.trim().toLowerCase() !== 'application/json') return false;
  return params.every((p) => /^\s*charset\s*=\s*[A-Za-z0-9_-]{1,40}\s*$/i.test(p));
}

async function surfaceOn() {
  try {
    const [gallery, chat] = await Promise.all([
      effective('FF_PROTOTYPE_GALLERY'),
      effective('FF_LIVE_CHAT_DEMO'),
    ]);
    return gallery.effective === true && chat.effective === true;
  } catch {
    return false;
  }
}

async function resolveLink(token) {
  if (!(await surfaceOn())) return { status: 404 };
  let looked;
  try {
    looked = await lookupToken(token);
  } catch (err) {
    log('lookup_failed', err && err.code ? err.code : 'error');
    return { status: 503 };
  }
  if (looked.status !== 200) return { status: looked.status };
  return { status: 200, row: looked.row };
}

async function approvedFacts(prospectId) {
  const { rows } = await pool.query(
    `SELECT field, value FROM prototype_facts
      WHERE prospect_id = $1 AND review_status = 'approved'
      ORDER BY field`,
    [prospectId]
  );
  return rows;
}

function hourBucket(now) {
  return new Date(now).toISOString().slice(0, 13);
}

let clock = () => new Date();

function _setClockForTests(fn) {
  if (process.env.NODE_ENV !== 'test') throw new Error('_setClockForTests is test-only');
  clock = fn || (() => new Date());
}

// ---- /api/public/prototypes/:token/voice -----------------------------------

const prototypeVoiceRouter = express.Router({ mergeParams: true });
prototypeVoiceRouter.use(chatCors);

prototypeVoiceRouter.get('/', async (req, res) => {
  const link = await resolveLink(req.params.token);
  if (link.status === 404) return send(res, 404, NOT_FOUND);
  if (link.status === 410) return send(res, 410, { error: 'link_expired' });
  if (link.status !== 200) return send(res, 503, { error: 'voice_unavailable' });
  const config = voiceConfig();
  if (!config) return send(res, 200, { available: false, reason: 'off' });
  try {
    const usage = await store.linkUsage(link.row.id);
    if (usage.callsLeft < 1) return send(res, 200, { available: false, reason: 'limit' });
    return send(res, 200, {
      available: true,
      max_seconds: VOICE_CAPS.maxCallSeconds,
      calls_left: usage.callsLeft,
    });
  } catch (err) {
    log('usage_failed', err && err.code ? err.code : 'error');
    return send(res, 503, { error: 'voice_unavailable' });
  }
});

prototypeVoiceRouter.post('/session', express.json({ limit: '2kb' }), async (req, res) => {
  if (!jsonType(req.headers['content-type'])) return send(res, 415, { error: 'unsupported_media_type' });
  const now = clock();
  const limited = consume(clientIp(req), 'voice', {
    fixed: true,
    max: VOICE_CAPS.mintsPerIpHour,
    bucketKey: hourBucket(now),
    clock: () => now.getTime(),
  });
  if (limited.limited) return send(res, 429, { error: 'voice_rate' });
  const link = await resolveLink(req.params.token);
  if (link.status === 404) return send(res, 404, NOT_FOUND);
  if (link.status === 410) return send(res, 410, { error: 'link_expired' });
  if (link.status !== 200) return send(res, 503, { error: 'voice_unavailable' });
  const config = voiceConfig();
  if (!config) return send(res, 503, { error: 'voice_unavailable' });

  let reservation;
  try {
    reservation = await store.reserve({ prototypeId: link.row.id, dailySeconds: config.dailySeconds, now });
  } catch (err) {
    log('reserve_failed', err && err.code ? err.code : 'error');
    return send(res, 503, { error: 'voice_unavailable' });
  }
  if (reservation.capped) {
    log('capped', reservation.capped);
    return send(res, 429, { error: 'voice_limit', reason: reservation.capped });
  }

  let call;
  try {
    const name = publicBrandName(link.row.brand_name);
    const facts = await approvedFacts(link.row.prospect_id);
    call = await retell.createWebCall({
      config,
      variables: voiceVariables({ businessName: name, facts }),
      beginMessage: beginMessage(name),
      metadata: { ff_call: reservation.id, prototype_id: String(link.row.id) },
      maxCallSeconds: VOICE_CAPS.maxCallSeconds,
      silenceEndMs: VOICE_CAPS.silenceEndMs,
      timeoutMs: VOICE_CAPS.retellTimeoutMs,
    });
  } catch (err) {
    await store.failCall(reservation.id).catch(() => {});
    log('retell_failed', `${err && err.code ? err.code : 'error'}${err && err.status ? ` ${err.status}` : ''}`);
    return send(res, 502, { error: 'voice_failed' });
  }
  try {
    await store.attachCall(reservation.id, call.call_id);
  } catch (err) {
    log('attach_failed', err && err.code ? err.code : 'error');
  }
  log('call_started', `prototype=${link.row.id} calls_left=${reservation.callsLeft}`);
  return send(res, 201, call);
});

prototypeVoiceRouter.use((req, res) => send(res, 404, NOT_FOUND));

// ---- /api/public/voice/retell-webhook -----------------------------------------

const webhookRouter = express.Router();

webhookRouter.post('/', express.raw({ type: () => true, limit: '1mb' }), async (req, res) => {
  const config = voiceConfig();
  // Without the key there is nothing to verify against; refuse rather than trust.
  if (!config) return send(res, 503, { error: 'voice_unavailable' });
  const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
  if (!retell.verifySignature(raw, config.apiKey, req.headers['x-retell-signature'], clock().getTime())) {
    log('webhook_bad_signature');
    return send(res, 401, { error: 'bad_signature' });
  }
  let event;
  try {
    event = JSON.parse(raw.toString('utf8'));
  } catch {
    return send(res, 400, { error: 'invalid_body' });
  }
  if (!event || event.event !== 'call_ended' || !event.call || typeof event.call !== 'object') {
    stamp(res);
    return res.status(204).end();
  }
  const call = event.call;
  if (typeof call.call_id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(call.call_id)) {
    return send(res, 400, { error: 'invalid_body' });
  }
  let ms = Number.isFinite(call.duration_ms) ? call.duration_ms : null;
  if (ms == null && Number.isFinite(call.start_timestamp) && Number.isFinite(call.end_timestamp)) {
    ms = call.end_timestamp - call.start_timestamp;
  }
  if (ms == null) ms = 0;
  const seconds = Math.min(7200, Math.max(0, Math.ceil(ms / 1000)));
  try {
    const settled = await store.settleCall(call.call_id, seconds, clock());
    log('call_ended', `seconds=${seconds} settled=${settled}`);
  } catch (err) {
    log('settle_failed', err && err.code ? err.code : 'error');
    return send(res, 500, { error: 'server_error' });
  }
  stamp(res);
  return res.status(204).end();
});

webhookRouter.use((req, res) => send(res, 404, NOT_FOUND));

module.exports = { prototypeVoiceRouter, webhookRouter, _setClockForTests, jsonType };
