import { PREVIEW_QUERY_BUILD } from '../flags.js';

// Public chat routes. A matching path does not authenticate anyone.
// /demo/live-chat is the sample demo. /demo/prototype/:token is one shop's
// chat. The token is 43 unpadded base64url characters, the same shape the
// prototype minter returns. The routes sit under /demo so the demo headers
// cover them.

const LIVE_CHAT = /^\/demo\/live-chat\/?$/;
const PROTO_CHAT = /^\/demo\/prototype\/([^/]+)\/?$/;
const PROTO_TOKEN = /^[A-Za-z0-9_-]{43}$/;

export const LIVE_CHAT_PATH = '/demo/live-chat';

export function liveChatRouteFromPath(pathname) {
  return LIVE_CHAT.test(String(pathname ?? '')) ? { screen: 'live-chat' } : null;
}

function decodePart(value) {
  try { return decodeURIComponent(value); }
  catch { return value; }
}

export function prototypeChatFromPath(pathname) {
  const match = String(pathname ?? '').match(PROTO_CHAT);
  if (!match) return null;
  const token = decodePart(match[1]);
  if (!PROTO_TOKEN.test(token)) return { token: '', malformed: true };
  return { token, screen: 'prototype-chat' };
}

export function tokenFromPrototypeUrl(value) {
  let pathname = '';
  try {
    pathname = new URL(String(value), 'https://example.invalid').pathname;
  } catch {
    return '';
  }
  const match = pathname.match(/\/demo\/prototype\/([^/]+)\/?$/);
  if (!match) return '';
  const token = decodePart(match[1]);
  return PROTO_TOKEN.test(token) ? token : '';
}

export function demoChatUrl(prototypeUrl, origin = typeof window !== 'undefined' ? window.location.origin : '') {
  const token = tokenFromPrototypeUrl(prototypeUrl);
  const base = String(origin || '').replace(/\/$/, '');
  if (!token || !base) return '';
  return `${base}/demo/prototype/${token}`;
}

function encodeList(value) {
  return String(value)
    .split(',')
    .map((part) => encodeURIComponent(part.trim()))
    .filter(Boolean)
    .join(',');
}

export function liveChatHref(search = '') {
  if (!PREVIEW_QUERY_BUILD) return LIVE_CHAT_PATH;
  const current = new URLSearchParams(String(search || '').replace(/^\?/, ''));
  const flags = current.get('flags');
  if (!flags) return LIVE_CHAT_PATH;
  return `${LIVE_CHAT_PATH}?flags=${encodeList(flags)}`;
}
