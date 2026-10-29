// Retell: create one browser web call, and check webhook signatures.
// The secret key stays on this server. The browser only ever receives the
// short-lived access token for the one call this server created.
//
// Tests swap the fetch with _setFetchForTests (throws outside NODE_ENV=test).
// npm test's network guard also refuses api.retellai.com.

const crypto = require('crypto');

const RETELL_API = 'https://api.retellai.com';
const SIGNATURE = /^v=(\d{1,16}),d=([0-9a-f]{64})$/i;
const SIGNATURE_WINDOW_MS = 5 * 60 * 1000;

let fetchOverride = null;

function _setFetchForTests(fn) {
  if (process.env.NODE_ENV !== 'test') throw new Error('_setFetchForTests is test-only');
  fetchOverride = fn || null;
}

function retellError(code, status) {
  const err = new Error(code);
  err.code = code;
  if (status) err.status = status;
  return err;
}

const CALL_ID = /^[A-Za-z0-9_-]{1,128}$/;

// Only the fields the browser SDK needs leave this server.
function pickCall(data) {
  if (!data || typeof data !== 'object') throw retellError('retell_bad_response');
  const out = {
    call_id: data.call_id,
    access_token: data.access_token,
  };
  if (typeof out.call_id !== 'string' || !CALL_ID.test(out.call_id)) throw retellError('retell_bad_response');
  if (typeof out.access_token !== 'string' || !out.access_token || out.access_token.length > 8192) {
    throw retellError('retell_bad_response');
  }
  if (data.transport === 'gateway' || data.transport === 'livekit') out.transport = data.transport;
  if (Array.isArray(data.ice_servers)) out.ice_servers = data.ice_servers.slice(0, 8);
  if (Number.isSafeInteger(data.expires_at)) out.expires_at = data.expires_at;
  return out;
}

async function createWebCall({ config, variables, beginMessage, metadata, maxCallSeconds, silenceEndMs, timeoutMs }) {
  const doFetch = fetchOverride || fetch;
  const body = {
    agent_id: config.agentId,
    metadata,
    retell_llm_dynamic_variables: variables,
    agent_override: {
      agent: {
        max_call_duration_ms: maxCallSeconds * 1000,
        end_call_after_silence_ms: silenceEndMs,
      },
      retell_llm: {
        begin_message: beginMessage,
        start_speaker: 'agent',
      },
    },
  };
  let res;
  try {
    res = await doFetch(`${RETELL_API}/v3/create-web-call`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    throw retellError(err && err.name === 'TimeoutError' ? 'retell_timeout' : 'retell_unreachable');
  }
  if (!res || typeof res.status !== 'number') throw retellError('retell_bad_response');
  if (res.status < 200 || res.status > 299) {
    // The body can echo request details; it is not read or logged.
    throw retellError('retell_rejected', res.status);
  }
  let data;
  try {
    data = await res.json();
  } catch {
    throw retellError('retell_bad_response');
  }
  return pickCall(data);
}

// x-retell-signature is "v=<ms>,d=<hex>", where hex is HMAC-SHA256 keyed by
// the Retell API key over the raw body followed by the timestamp. A
// signature older or newer than five minutes is refused (replay).
function verifySignature(rawBody, apiKey, header, now = Date.now()) {
  if (!Buffer.isBuffer(rawBody) || typeof apiKey !== 'string' || !apiKey) return false;
  if (typeof header !== 'string' || header.length > 200) return false;
  const match = SIGNATURE.exec(header.trim());
  if (!match) return false;
  const stamp = Number(match[1]);
  if (!Number.isSafeInteger(stamp) || Math.abs(now - stamp) > SIGNATURE_WINDOW_MS) return false;
  const expected = crypto.createHmac('sha256', apiKey)
    .update(Buffer.concat([rawBody, Buffer.from(String(stamp))]))
    .digest();
  const given = Buffer.from(match[2], 'hex');
  return given.length === expected.length && crypto.timingSafeEqual(given, expected);
}

// For tests and the docs: the header Retell would send for this body.
function signBody(rawBody, apiKey, stamp = Date.now()) {
  const digest = crypto.createHmac('sha256', apiKey)
    .update(Buffer.concat([Buffer.from(rawBody), Buffer.from(String(stamp))]))
    .digest('hex');
  return `v=${stamp},d=${digest}`;
}

module.exports = {
  RETELL_API,
  createWebCall,
  verifySignature,
  signBody,
  pickCall,
  _setFetchForTests,
};
