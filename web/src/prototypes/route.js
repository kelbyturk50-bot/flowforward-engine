// Prototype gallery routes live under /demo so the existing X-Robots-Tag
// on /demo/:path* covers them. Token shape matches the estimate-recovery demo
// (22–64 base64url characters, at least 16 bytes). Link expiry is the
// issuer's job; this static preview uses one fixed synthetic token.
// The gallery token or route is not access control. A matching token only
// selects this preview; it does not authenticate a caller or hide the page.

import { isDemoToken } from '../demo/token';
import { PREVIEW_QUERY_BUILD } from '../flags.js';

const GALLERY = /^\/demo\/gallery\/([^/]+)(?:\/([^/]+))?\/?$/;

export const GALLERY_PREVIEW_TOKEN = 'demo-test-wasatch-heating';

function decodePart(value) {
  try { return decodeURIComponent(value); }
  catch { return value; }
}

const SCREENS = new Set(['index', 'estimate-follow-up', 'scheduling', 'call', 'bookkeeping']);

export function galleryRouteFromPath(pathname) {
  const match = String(pathname ?? '').match(GALLERY);
  if (!match) return null;
  const token = decodePart(match[1]);
  const rawScreen = match[2] ? decodePart(match[2]) : 'index';
  const screen = SCREENS.has(rawScreen) ? rawScreen : 'unknown';
  return { token, screen };
}

export function galleryTokenOk(token) {
  return isDemoToken(token);
}

function encodeList(value) {
  return String(value)
    .split(',')
    .map(part => encodeURIComponent(part.trim()))
    .filter(Boolean)
    .join(',');
}

export function galleryHref(token = GALLERY_PREVIEW_TOKEN, screen = 'index', search = '') {
  const path = screen && screen !== 'index' && SCREENS.has(screen)
    ? `/demo/gallery/${token}/${screen}`
    : `/demo/gallery/${token}`;
  const current = new URLSearchParams(String(search || '').replace(/^\?/, ''));
  const parts = [];
  if (PREVIEW_QUERY_BUILD) {
    const flags = current.get('flags');
    if (flags) parts.push(`flags=${encodeList(flags)}`);
  }
  const fixture = current.get('fixture');
  if (fixture === 'hostile' || fixture === 'yellow' || fixture === 'navy') {
    parts.push(`fixture=${fixture}`);
  }
  const query = parts.join('&');
  return `${path}${query ? `?${query}` : ''}`;
}

export function followGalleryLink(event, href) {
  if (event.defaultPrevented) return;
  if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return;
  event.preventDefault();
  window.history.pushState({}, '', href);
  window.dispatchEvent(new PopStateEvent('popstate'));
}
