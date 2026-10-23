// Keyless client for /demo pages. The CRM API key in localStorage is never read
// and never attached. Credentials are omitted so a cookie cannot ride along.

import { resolveApiBase } from '../api-base.js';

// Demo pages ignore a Settings-saved API address. The origin is the one baked
// into the build (VITE_API_URL, otherwise the dev or production default).
export function publicApiBase() {
  return resolveApiBase({
    viteApiUrl: import.meta.env.VITE_API_URL,
    dev: import.meta.env.DEV,
    prod: import.meta.env.PROD,
    hostname: typeof window !== 'undefined' ? window.location.hostname : '',
    port: typeof window !== 'undefined' ? window.location.port : '',
    protocol: typeof window !== 'undefined' ? window.location.protocol : '',
    savedUrl: '',
  });
}

export async function publicJson(method, path, body) {
  const base = publicApiBase();
  if (!base.configured || !base.url) {
    const error = new Error('unconfigured');
    error.status = 0;
    throw error;
  }
  const headers = { Accept: 'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  let response;
  try {
    response = await fetch(`${base.url}${path}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      credentials: 'omit',
      cache: 'no-store',
    });
  } catch {
    const error = new Error('network');
    error.status = 0;
    throw error;
  }
  const text = await response.text();
  let data = {};
  if (text) {
    try { data = JSON.parse(text); }
    catch { data = {}; }
  }
  return { status: response.status, data };
}
