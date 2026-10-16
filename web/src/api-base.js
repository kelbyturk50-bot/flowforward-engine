// How the CRM chooses an API base URL.
//
// Precedence, first match:
// 1. Settings-saved URL (`localStorage` key `ff.apiUrl`). Written only when
//    someone changes the address and saves. The prefilled default is not stored.
//    The value must be https, except http for localhost or 127.0.0.1.
// 2. `VITE_API_URL`, when the build set it. Wins over the defaults below.
// 3. `http://localhost:3000` when `import.meta.env.DEV` (the API's default port).
// 4. The production Railway URL when `import.meta.env.PROD` and
//    `location.hostname` is exactly one of `PRODUCTION_HOSTS`.
// 5. Otherwise unconfigured: no URL, and the client must not call `fetch`.
//
// Preview deployments are not in the allowlist and do not set `VITE_API_URL`.
// They cannot reach an API until a staging API exists.

export const LOCAL_API_URL = 'http://localhost:3000';

export const PRODUCTION_API_URL = 'https://flowforward-engine-production.up.railway.app';

// Exact production CRM hostnames. Compare with === only.
// Production aliases for the flowforward-engine project, read 2026-10-16:
// - project production domain
// - team production alias and the main-branch alias
export const PRODUCTION_HOSTS = Object.freeze([
  'flowforward-engine-six.vercel.app',
  'flowforward-engine-turk11.vercel.app',
  'flowforward-engine-git-main-turk11.vercel.app',
]);

export const UNCONFIGURED_MESSAGE = 'API not configured for this environment';

export function normalizeUrl(value) {
  return String(value ?? '').trim().replace(/\/+$/, '');
}

export const API_URL_SCHEME_MESSAGE = 'Use an https address. http is only allowed for localhost and 127.0.0.1.';

export function apiUrlIssue(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return 'Enter an API address.';
  let parsed;
  try { parsed = new URL(raw); }
  catch { return API_URL_SCHEME_MESSAGE; }
  const host = parsed.hostname;
  if (parsed.protocol === 'https:') return '';
  if (parsed.protocol === 'http:' && (host === 'localhost' || host === '127.0.0.1')) return '';
  return API_URL_SCHEME_MESSAGE;
}

export function shouldStoreApiUrl(typed, prefilled) {
  return normalizeUrl(typed) !== normalizeUrl(prefilled);
}

export function isProductionHost(hostname) {
  const host = String(hostname ?? '');
  for (const allowed of PRODUCTION_HOSTS) {
    if (allowed === host) return true;
  }
  return false;
}

export function resolveApiBase({ viteApiUrl, dev, prod, hostname, savedUrl } = {}) {
  const saved = normalizeUrl(savedUrl);
  if (saved) return { url: saved, configured: true, source: 'settings' };

  const fromEnv = normalizeUrl(viteApiUrl);
  if (fromEnv) return { url: fromEnv, configured: true, source: 'env' };

  if (dev) return { url: LOCAL_API_URL, configured: true, source: 'dev' };

  if (prod && isProductionHost(hostname)) {
    return { url: PRODUCTION_API_URL, configured: true, source: 'production' };
  }

  return { url: '', configured: false, source: 'unconfigured' };
}
