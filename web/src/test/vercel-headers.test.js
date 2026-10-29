import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pathToRegexp } from 'path-to-regexp';
import { describe, expect, it } from 'vitest';
import { PRODUCTION_API_URL } from '../api-base.js';

const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

const CSP = `default-src 'self'; script-src 'self'; style-src 'self'; font-src 'self'; img-src 'self' data:; connect-src ${PRODUCTION_API_URL}; frame-ancestors 'none'; base-uri 'self'; object-src 'none'; form-action 'none'`;

const DEMO_HEADERS = [
  { key: 'X-Robots-Tag', value: 'noindex, nofollow' },
  { key: 'Referrer-Policy', value: 'no-referrer' },
  { key: 'Cache-Control', value: 'no-store' },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
];

// A shop's chat page also hosts the voice receptionist: the Retell SDK
// signals to api.retellai.com and, on its LiveKit transport, to Retell's
// LiveKit Cloud project (which can hand off to a regional *.livekit.cloud
// host). Media itself is WebRTC, which connect-src does not govern.
const RETELL_HOSTS = 'https://api.retellai.com https://*.livekit.cloud wss://*.livekit.cloud';
const VOICE_CSP = CSP.replace(`connect-src ${PRODUCTION_API_URL}`, `connect-src ${PRODUCTION_API_URL} ${RETELL_HOSTS}`);

const CHAT_CSP = [{ key: 'Content-Security-Policy', value: CSP }];
const PROTO_HEADERS = [
  ...DEMO_HEADERS,
  { key: 'Content-Security-Policy', value: VOICE_CSP },
  { key: 'Permissions-Policy', value: 'microphone=(self)' },
];

// Vercel compiles header sources with path-to-regexp (strict, case-sensitive).
// Every matching source contributes headers. A later key replaces an earlier one.
function sourceMatches(source, pathname) {
  const keys = [];
  const regexp = pathToRegexp(source, keys, {
    strict: true,
    sensitive: true,
    delimiter: '/',
  });
  return regexp.test(pathname);
}

function headersFor(config, pathname) {
  const merged = new Map();
  for (const rule of config.headers) {
    if (!sourceMatches(rule.source, pathname)) continue;
    for (const header of rule.headers) merged.set(header.key, header.value);
  }
  return merged;
}

describe('CRM vercel.json', () => {
  const config = JSON.parse(readFileSync(path.join(webRoot, 'vercel.json'), 'utf8'));

  it('keeps the rewrites and splits demo headers from the live-chat CSP', () => {
    expect(config.headers).toEqual([
      { source: '/demo/:path*', headers: DEMO_HEADERS },
      { source: '/demo/:path*/', headers: DEMO_HEADERS },
      { source: '/demo/live-chat', headers: CHAT_CSP },
      { source: '/demo/live-chat/', headers: CHAT_CSP },
      { source: '/demo/prototype/:token', headers: PROTO_HEADERS },
      { source: '/demo/prototype/:token/', headers: PROTO_HEADERS },
    ]);
    expect(config.rewrites).toEqual([
      { source: '/about', destination: '/about.html' },
      { source: '/privacy', destination: '/privacy.html' },
      { source: '/(.*)', destination: '/index.html' },
    ]);
  });

  it('applies the chat CSP to the live chat and a prototype token, and keeps the gallery CSP-free', () => {
    const token = 'a'.repeat(43);
    const live = headersFor(config, '/demo/live-chat');
    expect(live.get('Content-Security-Policy')).toBe(CSP);
    expect(live.get('Content-Security-Policy')).toContain(`connect-src ${PRODUCTION_API_URL}`);
    expect(live.get('Content-Security-Policy')).not.toContain("connect-src 'none'");
    expect(live.get('Content-Security-Policy')).not.toContain('connect-src *');
    expect(live.get('X-Robots-Tag')).toBe('noindex, nofollow');
    expect(live.get('Referrer-Policy')).toBe('no-referrer');

    for (const pathname of [`/demo/prototype/${token}`, `/demo/prototype/${token}/`]) {
      const headers = headersFor(config, pathname);
      expect(headers.get('Content-Security-Policy'), pathname).toBe(VOICE_CSP);
      expect(headers.get('Content-Security-Policy'), pathname).not.toContain('connect-src *');
      expect(headers.get('Permissions-Policy'), pathname).toBe('microphone=(self)');
      expect(headers.get('X-Robots-Tag'), pathname).toBe('noindex, nofollow');
      expect(headers.get('Referrer-Policy'), pathname).toBe('no-referrer');
      expect(headers.get('Cache-Control'), pathname).toBe('no-store');
      expect(headers.get('X-Content-Type-Options'), pathname).toBe('nosniff');
    }

    for (const pathname of ['/demo/gallery', '/demo/estimate-recovery', '/demo/prototype', '/demo/gallery/']) {
      const headers = headersFor(config, pathname);
      expect(headers.has('Content-Security-Policy'), pathname).toBe(false);
      expect(headers.get('X-Robots-Tag'), pathname).toBe('noindex, nofollow');
      expect(headers.get('Referrer-Policy'), pathname).toBe('no-referrer');
    }

    const liveSlash = headersFor(config, '/demo/live-chat/');
    expect(liveSlash.get('Content-Security-Policy')).toBe(CSP);
    expect(liveSlash.get('X-Robots-Tag')).toBe('noindex, nofollow');
    expect(liveSlash.get('Referrer-Policy')).toBe('no-referrer');
    expect(liveSlash.get('Cache-Control')).toBe('no-store');
    expect(liveSlash.get('X-Content-Type-Options')).toBe('nosniff');

    for (const pathname of ['/demo/gallery/', '/demo/estimate-recovery/']) {
      const headers = headersFor(config, pathname);
      expect(headers.has('Content-Security-Policy'), pathname).toBe(false);
      expect(headers.get('X-Robots-Tag'), pathname).toBe('noindex, nofollow');
      expect(headers.get('Referrer-Policy'), pathname).toBe('no-referrer');
      expect(headers.get('Cache-Control'), pathname).toBe('no-store');
      expect(headers.get('X-Content-Type-Options'), pathname).toBe('nosniff');
    }

    expect(sourceMatches('/demo/live-chat', '/demo/gallery')).toBe(false);
    expect(sourceMatches('/demo/live-chat', '/demo/live-chat/')).toBe(false);
    expect(sourceMatches('/demo/live-chat', '/demo/live-chat/extra')).toBe(false);
    expect(sourceMatches('/demo/live-chat/', '/demo/live-chat')).toBe(false);
    expect(sourceMatches('/demo/:path*', '/demo/live-chat/')).toBe(false);
    expect(sourceMatches('/demo/:path*', '/demo/gallery/demo-test-wasatch-heating/estimate-follow-up')).toBe(true);
    expect(sourceMatches('/demo/:path*/', '/demo/gallery/')).toBe(true);
    expect(sourceMatches('/demo/:path*', '/Demo/live-chat')).toBe(false);
    expect(sourceMatches('/demo/prototype/:token', `/demo/prototype/${token}`)).toBe(true);
    expect(sourceMatches('/demo/prototype/:token', `/demo/prototype/${token}/`)).toBe(false);
    expect(sourceMatches('/demo/prototype/:token/', `/demo/prototype/${token}/`)).toBe(true);
    expect(sourceMatches('/demo/prototype/:token/', `/demo/prototype/${token}`)).toBe(false);
    expect(sourceMatches('/demo/prototype/:token', '/demo/gallery')).toBe(false);
    expect(sourceMatches('/demo/prototype/:token', `/demo/gallery/${token}`)).toBe(false);
    expect(sourceMatches('/demo/prototype/:token', `/Demo/prototype/${token}`)).toBe(false);
    expect(sourceMatches('/demo/prototype/:token', '/demo/live-chat')).toBe(false);
    expect(headersFor(config, `/demo/gallery/${token}/estimate-follow-up`).has('Content-Security-Policy')).toBe(false);
  });
});
