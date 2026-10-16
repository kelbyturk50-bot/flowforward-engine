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
