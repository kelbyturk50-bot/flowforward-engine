import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pathToRegexp } from 'path-to-regexp';
import { describe, expect, it } from 'vitest';

const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

const CSP = "default-src 'self'; script-src 'self'; style-src 'self'; style-src-attr 'unsafe-inline'; font-src 'self'; img-src 'self' data:; connect-src 'none'; frame-ancestors 'none'; base-uri 'self'; object-src 'none'; form-action 'none'";

// Vercel compiles header sources with path-to-regexp (strict, case-insensitive).
// Every matching source contributes headers. A later key replaces an earlier one.
function sourceMatches(source, pathname) {
  const keys = [];
  const regexp = pathToRegexp(source, keys, {
    strict: true,
    sensitive: false,
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
      {
        source: '/demo/:path*',
        headers: [
          { key: 'X-Robots-Tag', value: 'noindex, nofollow' },
          { key: 'Referrer-Policy', value: 'no-referrer' },
          { key: 'Cache-Control', value: 'no-store' },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
        ],
      },
      {
        source: '/demo/live-chat',
        headers: [
          { key: 'Content-Security-Policy', value: CSP },
        ],
      },
    ]);
    expect(config.rewrites).toEqual([
      { source: '/about', destination: '/about.html' },
      { source: '/privacy', destination: '/privacy.html' },
      { source: '/(.*)', destination: '/index.html' },
    ]);
  });

  it('applies the CSP only to /demo/live-chat and keeps noindex on the other demo paths', () => {
    const live = headersFor(config, '/demo/live-chat');
    expect(live.get('Content-Security-Policy')).toBe(CSP);
    expect(live.get('X-Robots-Tag')).toBe('noindex, nofollow');
    expect(live.get('Referrer-Policy')).toBe('no-referrer');

    for (const pathname of ['/demo/gallery', '/demo/estimate-recovery', '/demo/prototype/x']) {
      const headers = headersFor(config, pathname);
      expect(headers.has('Content-Security-Policy'), pathname).toBe(false);
      expect(headers.get('X-Robots-Tag'), pathname).toBe('noindex, nofollow');
      expect(headers.get('Referrer-Policy'), pathname).toBe('no-referrer');
    }

    expect(sourceMatches('/demo/live-chat', '/demo/gallery')).toBe(false);
    expect(sourceMatches('/demo/live-chat', '/demo/live-chat/extra')).toBe(false);
    expect(sourceMatches('/demo/:path*', '/demo/gallery/demo-test-wasatch-heating/estimate-follow-up')).toBe(true);
  });
});
