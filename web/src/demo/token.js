// Opaque demo tokens. 16 random bytes is 22 unpadded base64url characters.
// Valid tokens are base64url and 22 to 64 characters. Anything else is not a token.
// The CRM preview link uses a fixed synthetic token. It is not a credential.

export const DEMO_PREVIEW_TOKEN = 'demo-example-heating-air';

const PREVIEW_QUERY_BUILD = import.meta.env.DEV === true || __FF_VERCEL_ENV__ === 'preview';

const TOKEN = /^[A-Za-z0-9_-]{22,64}$/;
const DEMO_PATH = /^\/demo\/estimate-recovery\/([^/]+)\/?$/;

export function isDemoToken(token) {
  return typeof token === 'string' && TOKEN.test(token);
}

export function demoTokenFromPath(pathname) {
  const match = String(pathname ?? '').match(DEMO_PATH);
  if (!match) return null;
  try { return decodeURIComponent(match[1]); }
  catch { return match[1]; }
}

function encodeList(value) {
  return String(value)
    .split(',')
    .map(part => encodeURIComponent(part.trim()))
    .filter(Boolean)
    .join(',');
}

export function demoHref(token = DEMO_PREVIEW_TOKEN, search = '') {
  const current = new URLSearchParams(String(search || '').replace(/^\?/, ''));
  const parts = [];
  if (PREVIEW_QUERY_BUILD) {
    const flags = current.get('flags');
    if (flags) parts.push(`flags=${encodeList(flags)}`);
  }
  const company = current.get('company');
  if (company && company.trim()) parts.push(`company=${encodeURIComponent(company.trim().slice(0, 80))}`);
  const query = parts.join('&');
  return `/demo/estimate-recovery/${token}${query ? `?${query}` : ''}`;
}
