import { existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  IGNORE_COMMAND,
  SCRIPT_REPO_PATH,
  decide,
  errorText,
  exitCodeFor,
  parseDiffNames,
  pathTriggersBuild,
  shouldBuild,
} from '../../scripts/vercel-ignore.mjs';

const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

describe('shouldBuild', () => {
  it('builds when a path under web/ changed', () => {
    const decision = shouldBuild({
      ref: 'feature',
      changedFiles: ['web/src/App.jsx'],
      diffOk: true,
    });
    expect(decision.build).toBe(true);
    expect(exitCodeFor(decision)).toBe(1);
  });

  it('skips an API-only change in src/, schema.sql, and docs', () => {
    const decision = shouldBuild({
      ref: 'feature',
      changedFiles: ['src/server.js', 'src/db/schema.sql', 'docs/PLAYBOOK.md'],
      diffOk: true,
    });
    expect(decision.build).toBe(false);
    expect(exitCodeFor(decision)).toBe(0);
    expect(decision.reason).toMatch(/no frontend or Vercel config paths/);
  });

  it('builds when the ref is main, including when the diff failed', () => {
    expect(shouldBuild({ ref: 'main', changedFiles: ['src/server.js'], diffOk: true }).build).toBe(true);
    expect(shouldBuild({ ref: 'main', changedFiles: [], diffOk: false }).build).toBe(true);
    expect(shouldBuild({ ref: 'main' }).reason).toMatch(/main/);
  });

  it('builds when VERCEL_ENV is production even for an API-only diff', () => {
    const decision = shouldBuild({
      ref: 'feature',
      changedFiles: ['src/server.js', 'docs/PLAYBOOK.md'],
      diffOk: true,
      vercelEnv: 'production',
    });
    expect(decision.build).toBe(true);
    expect(decision.reason).toMatch(/VERCEL_ENV is production/);
    expect(exitCodeFor(decision)).toBe(1);
    expect(shouldBuild({
      ref: 'feature',
      changedFiles: ['src/server.js'],
      diffOk: false,
      vercelEnv: 'production',
    }).build).toBe(true);
  });

  it('does not treat preview, development, or a lookalike as production', () => {
    for (const vercelEnv of ['preview', 'development', 'production-ish', 'Production']) {
      expect(shouldBuild({
        ref: 'feature',
        changedFiles: ['src/server.js'],
        diffOk: true,
        vercelEnv,
      }).build).toBe(false);
    }
  });

  it('builds when the ref is refs/heads/main', () => {
    const decision = shouldBuild({
      ref: 'refs/heads/main',
      changedFiles: ['src/server.js'],
      diffOk: true,
      vercelEnv: 'preview',
    });
    expect(decision.build).toBe(true);
    expect(decision.reason).toMatch(/refs\/heads\/main/);
    expect(exitCodeFor(decision)).toBe(1);
    expect(shouldBuild({
      ref: 'refs/heads/main',
      changedFiles: [],
      diffOk: false,
    }).build).toBe(true);
  });

  it('does not treat a longer main ref as main', () => {
    expect(shouldBuild({
      ref: 'refs/heads/mainline',
      changedFiles: ['src/server.js'],
      diffOk: true,
    }).build).toBe(false);
    expect(shouldBuild({
      ref: 'refs/heads/main/extra',
      changedFiles: ['src/server.js'],
      diffOk: true,
    }).build).toBe(false);
  });

  it('builds when web/vercel.json or the root vercel.json changed', () => {
    expect(shouldBuild({ ref: 'feature', changedFiles: ['web/vercel.json'], diffOk: true }).build).toBe(true);
    expect(shouldBuild({ ref: 'feature', changedFiles: ['vercel.json'], diffOk: true }).build).toBe(true);
    expect(shouldBuild({ ref: 'feature', changedFiles: ['docs/vercel.json'], diffOk: true }).build).toBe(false);
  });

  it('builds when .vercelignore or a path under .vercel/ changed', () => {
    expect(shouldBuild({ ref: 'feature', changedFiles: ['.vercelignore'], diffOk: true }).build).toBe(true);
    expect(shouldBuild({ ref: 'feature', changedFiles: ['.vercel/project.json'], diffOk: true }).build).toBe(true);
    expect(shouldBuild({ ref: 'feature', changedFiles: ['src/.vercel/project.json'], diffOk: true }).build).toBe(false);
  });

  it('builds when the ignore script changed', () => {
    const decision = shouldBuild({
      ref: 'feature',
      changedFiles: [SCRIPT_REPO_PATH],
      diffOk: true,
    });
    expect(decision.build).toBe(true);
    expect(pathTriggersBuild(SCRIPT_REPO_PATH)).toBe(true);
  });

  it('builds when the diff was not computed', () => {
    expect(shouldBuild({ ref: 'feature', changedFiles: [], diffOk: false }).build).toBe(true);
    expect(shouldBuild({ ref: 'feature', changedFiles: ['src/server.js'], diffOk: false }).build).toBe(true);
    expect(shouldBuild({ ref: 'feature', diffOk: true }).build).toBe(true);
    expect(shouldBuild({ ref: 'feature', changedFiles: null, diffOk: true }).build).toBe(true);
  });

  it('skips a successful empty diff', () => {
    // The name list was computed and it is empty, so the commit matches
    // the merge base. Nothing under web/ or the Vercel config changed.
    const decision = shouldBuild({ ref: 'feature', changedFiles: [], diffOk: true });
    expect(decision.build).toBe(false);
    expect(decision.reason).toMatch(/empty diff/);
    expect(exitCodeFor(decision)).toBe(0);
  });

  it('builds when API and web changes are mixed', () => {
    const decision = shouldBuild({
      ref: 'feature',
      changedFiles: ['src/server.js', 'src/db/schema.sql', 'docs/PLAYBOOK.md', 'web/index.html'],
      diffOk: true,
    });
    expect(decision.build).toBe(true);
    expect(decision.reason).toMatch(/web\/index\.html/);
  });

  it('does not treat a web prefix or a nested lookalike as the frontend', () => {
    expect(pathTriggersBuild('web-extra/src/App.jsx')).toBe(false);
    expect(pathTriggersBuild('website/index.html')).toBe(false);
    expect(pathTriggersBuild('src/web/note.txt')).toBe(false);
    expect(pathTriggersBuild('./web/src/App.jsx')).toBe(true);
  });
});

describe('decide', () => {
  const missing = path.join(tmpdir(), 'ff-vercel-ignore-missing-cwd');

  it('builds for production before any git call', () => {
    const decision = decide({
      VERCEL_ENV: 'production',
      VERCEL_GIT_COMMIT_REF: 'feature',
    }, missing);
    expect(decision.build).toBe(true);
    expect(decision.reason).toMatch(/VERCEL_ENV is production/);
  });

  it('builds for refs/heads/main before any git call', () => {
    const decision = decide({
      VERCEL_ENV: 'preview',
      VERCEL_GIT_COMMIT_REF: 'refs/heads/main',
    }, missing);
    expect(decision.build).toBe(true);
    expect(decision.reason).toMatch(/refs\/heads\/main/);
  });
});

describe('ignore script helpers', () => {
  it('parses NUL-separated git names', () => {
    expect(parseDiffNames('')).toEqual([]);
    expect(parseDiffNames('src/server.js\0web/src/App.jsx\0')).toEqual([
      'src/server.js',
      'web/src/App.jsx',
    ]);
    expect(parseDiffNames(null)).toEqual([]);
  });

  it('builds unless the decision is an explicit skip', () => {
    expect(exitCodeFor({ build: true })).toBe(1);
    expect(exitCodeFor({ build: false })).toBe(0);
    expect(exitCodeFor(undefined)).toBe(1);
  });

  it('redacts URLs in git errors', () => {
    const text = errorText(new Error('failed https://user:secret@github.com/org/repo.git now'));
    expect(text).not.toMatch(/secret/);
    expect(text).toMatch(/\[url\]/);
  });
});

describe('web/vercel.json ignoreCommand', () => {
  it('points ignoreCommand at the script and keeps the demo noindex header', () => {
    const config = JSON.parse(readFileSync(path.join(webRoot, 'vercel.json'), 'utf8'));
    expect(config.ignoreCommand).toBe(IGNORE_COMMAND);
    expect(existsSync(path.join(webRoot, 'scripts/vercel-ignore.mjs'))).toBe(true);
    const demoHeaders = [
      { key: 'X-Robots-Tag', value: 'noindex, nofollow' },
      { key: 'Referrer-Policy', value: 'no-referrer' },
      { key: 'Cache-Control', value: 'no-store' },
      { key: 'X-Content-Type-Options', value: 'nosniff' },
    ];
    const csp = [{ key: 'Content-Security-Policy', value: "default-src 'self'; script-src 'self'; style-src 'self'; font-src 'self'; img-src 'self' data:; connect-src 'none'; frame-ancestors 'none'; base-uri 'self'; object-src 'none'; form-action 'none'" }];
    expect(config.headers).toEqual([
      { source: '/demo/:path*', headers: demoHeaders },
      { source: '/demo/:path*/', headers: demoHeaders },
      { source: '/demo/live-chat', headers: csp },
      { source: '/demo/live-chat/', headers: csp },
    ]);
    expect(config.rewrites).toEqual([
      { source: '/about', destination: '/about.html' },
      { source: '/privacy', destination: '/privacy.html' },
      { source: '/(.*)', destination: '/index.html' },
    ]);
  });
});
