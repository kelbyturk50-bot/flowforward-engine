// How the CRM chooses an API base URL.
//
// Precedence, first match:
// 1. Settings-saved URL (`localStorage` key `ff.apiUrl`). Written only when
//    someone saves Settings on this origin. It is whatever they typed, including
//    the production API. It is never filled in automatically on a preview.
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
// Read-only from Vercel project flowforward-engine
// (prj_zi6v5WyDucJOuiqHdGSqMdyMtkE0), production deployment
// dpl_JpUqm88fWg7c2bH2VL14uUmESoxd (main a85d592), on 2026-10-16:
// - project production domain (list_project_domains production=true)
// - team production alias and the main-branch alias (deployment aliases)
export const PRODUCTION_HOSTS = Object.freeze([
  'flowforward-engine-six.vercel.app',
  'flowforward-engine-turk11.vercel.app',
  'flowforward-engine-git-main-turk11.vercel.app',
]);

export const UNCONFIGURED_MESSAGE = 'API not configured for this environment';

export function normalizeUrl(value) {
  return String(value ?? '').trim().replace(/\/+$/, '');
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
