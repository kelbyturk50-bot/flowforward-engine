// Opaque demo tokens. 16 random bytes is 22 unpadded base64url characters.
// The CRM preview link uses a fixed synthetic token. It is not a credential.

export const DEMO_PREVIEW_TOKEN = 'demo-example-heating-air';

const TOKEN = /^[A-Za-z0-9_-]{22,}$/;
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
  const flags = current.get('flags');
  if (flags) parts.push(`flags=${encodeList(flags)}`);
  const company = current.get('company');
  if (company && company.trim()) parts.push(`company=${encodeURIComponent(company.trim().slice(0, 80))}`);
  const query = parts.join('&');
  return `/demo/estimate-recovery/${token}${query ? `?${query}` : ''}`;
}
