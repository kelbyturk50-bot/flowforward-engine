import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

describe('CRM vercel.json', () => {
  it('noindexes only /demo/:path* and leaves the rewrites unchanged', () => {
    const config = JSON.parse(readFileSync(path.join(webRoot, 'vercel.json'), 'utf8'));

    expect(config.headers).toEqual([
      {
        source: '/demo/:path*',
        headers: [
          { key: 'X-Robots-Tag', value: 'noindex, nofollow' },
          { key: 'Referrer-Policy', value: 'no-referrer' },
          { key: 'Cache-Control', value: 'no-store' },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Content-Security-Policy', value: "default-src 'self'; script-src 'self'; style-src 'self'; style-src-attr 'unsafe-inline'; font-src 'self'; img-src 'self' data:; connect-src 'none'; frame-ancestors 'none'; base-uri 'self'; object-src 'none'; form-action 'none'" },
        ],
      },
    ]);
    expect(config.rewrites).toEqual([
      { source: '/about', destination: '/about.html' },
      { source: '/privacy', destination: '/privacy.html' },
      { source: '/(.*)', destination: '/index.html' },
    ]);
    expect('/demo/gallery/demo-test-wasatch-heating/estimate-follow-up'.startsWith('/demo/')).toBe(true);
  });
});
