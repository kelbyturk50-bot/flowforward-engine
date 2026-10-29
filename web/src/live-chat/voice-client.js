// Voice receptionist demo, browser side. docs/VOICE_DEMO.md.
//
// The Retell SDK's create-web-call request is routed to our API, which holds
// the Retell key, checks the link and the caps, and returns one call's
// short-lived token. The SDK then joins that call directly. No Retell key is
// ever in this bundle, and any other SDK request is refused here.
// The SDK is loaded only when someone presses Call.

import { publicJson } from './public-client.js';

const CREATE_PATH = '/v3/create-web-call';

function voicePath(token, tail = '') {
  return `/api/public/prototypes/${encodeURIComponent(token)}/voice${tail}`;
}

function count(value, fallback) {
  return Number.isInteger(value) && value >= 0 ? value : fallback;
}

// null: no voice panel at all (flags off, unknown link, or unreadable).
export async function readVoiceStatus(token) {
  if (!token) return null;
  try {
    const { status, data } = await publicJson('GET', voicePath(token));
    if (status !== 200 || !data || typeof data !== 'object') return null;
    if (data.available === true) {
      return { available: true, maxSeconds: count(data.max_seconds, 180), callsLeft: count(data.calls_left, 0) };
    }
    return { available: false, reason: data.reason === 'limit' ? 'limit' : 'off' };
  } catch {
    return null;
  }
}

function jsonResponse(status, data) {
  return new Response(JSON.stringify(data ?? {}), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

// The fetch the SDK uses for its control requests.
export function proxyFetch(token, onRefused) {
  return async (url) => {
    let path = '';
    try { path = new URL(String(url)).pathname; } catch { path = ''; }
    if (path !== CREATE_PATH) return jsonResponse(404, { error: 'not_found' });
    let result;
    try {
      result = await publicJson('POST', voicePath(token, '/session'), {});
    } catch {
      onRefused?.(0, {});
      return jsonResponse(503, { error: 'voice_unavailable' });
    }
    if (result.status !== 201) onRefused?.(result.status, result.data);
    return jsonResponse(result.status, result.data);
  };
}

export async function startVoiceCall({ token, hooks, onRefused, loadSdk = () => import('retell-client-js-sdk') }) {
  const { RetellClient } = await loadSdk();
  const client = new RetellClient({ key: 'proxied', fetch: proxyFetch(token, onRefused) });
  // agent_id is required by the SDK's type; the server ignores the body and
  // uses its own agent.
  return client.createWebCall({ agent_id: 'proxied', hooks });
}

// Plain words for each refusal the API can send.
export function refusalText(status, data) {
  const error = data && typeof data === 'object' ? data.error : '';
  const reason = data && typeof data === 'object' ? data.reason : '';
  if (status === 429 && error === 'voice_rate') return 'Too many calls from this network. Try again in an hour.';
  if (status === 429 && reason === 'link') return 'This link has used its sample calls. Text the demo instead, or reply to the email for a live walkthrough.';
  if (status === 429 && reason === 'busy') return 'The demo line is busy. Try again in a few minutes.';
  if (status === 429) return 'The demo line is done for today. Try again tomorrow.';
  if (status === 410) return 'This link is no longer active.';
  if (status === 404) return 'This demo is not available.';
  return 'The call didn\'t connect. Try again in a minute.';
}
