import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { describe, expect, it } from 'vitest';
import { run } from '../../scripts/vercel-ignore.mjs';

function gitAvailable() {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

// Repo tests need a real git. CI has one; skip only when it truly is not there.
const hasGit = gitAvailable();

function gitEnv() {
  return {
    ...process.env,
    GIT_AUTHOR_NAME: 'Vercel Ignore Test',
    GIT_AUTHOR_EMAIL: 'test@example.com',
    GIT_COMMITTER_NAME: 'Vercel Ignore Test',
    GIT_COMMITTER_EMAIL: 'test@example.com',
    GIT_TERMINAL_PROMPT: '0',
  };
}

function git(cwd, args) {
  execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: gitEnv(),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

// Feature branch with origin/main. diff.renames is on so a pure rename is
// invisible to `git diff --name-only` unless the script passes --no-renames.
function withFeatureRepo(alter) {
  const parent = mkdtempSync(path.join(tmpdir(), 'ff-vercel-ignore-'));
  try {
    const origin = path.join(parent, 'origin.git');
    const seed = path.join(parent, 'seed');
    const work = path.join(parent, 'work');
    mkdirSync(seed, { recursive: true });
    git(seed, ['init', '-q']);
    git(seed, ['config', 'user.email', 'test@example.com']);
    git(seed, ['config', 'user.name', 'Vercel Ignore Test']);
    git(seed, ['config', 'diff.renames', 'true']);
    mkdirSync(path.join(seed, 'web'), { recursive: true });
    mkdirSync(path.join(seed, 'src'), { recursive: true });
    writeFileSync(path.join(seed, 'web', 'a.js'), 'export const page = 1;\n');
    writeFileSync(path.join(seed, 'web', 'keep.txt'), 'keep\n');
    writeFileSync(path.join(seed, 'src', 'server.js'), 'export const api = 1;\n');
    git(seed, ['add', '.']);
    git(seed, ['commit', '-q', '-m', 'init']);
    git(seed, ['branch', '-M', 'main']);
    git(parent, ['init', '--bare', '-q', '-b', 'main', origin]);
    git(seed, ['remote', 'add', 'origin', origin]);
    git(seed, ['push', '-q', 'origin', 'main']);
    git(parent, ['clone', '-q', '--branch', 'main', origin, work]);
    git(work, ['config', 'user.email', 'test@example.com']);
    git(work, ['config', 'user.name', 'Vercel Ignore Test']);
    git(work, ['config', 'diff.renames', 'true']);
    git(work, ['checkout', '-q', '-b', 'feature']);
    alter(work);
    git(work, ['add', '-A']);
    git(work, ['commit', '-q', '-m', 'change']);
    return { parent, work };
  } catch (err) {
    rmSync(parent, { recursive: true, force: true });
    throw err;
  }
}

function runInWeb(work, env = {}) {
  return run({
    ...process.env,
    VERCEL_GIT_COMMIT_REF: 'feature',
    VERCEL_ENV: 'preview',
    ...env,
  }, path.join(work, 'web'));
}

describe.skipIf(!hasGit)('vercel ignore temp git repos', () => {
  it('builds when web/a.js is renamed to src/a.js', () => {
    const { parent, work } = withFeatureRepo((dir) => {
      git(dir, ['mv', 'web/a.js', 'src/a.js']);
    });
    try {
      expect(runInWeb(work)).toBe(1);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  }, 20_000);

  it('skips an API-only commit', () => {
    const { parent, work } = withFeatureRepo((dir) => {
      writeFileSync(path.join(dir, 'src', 'server.js'), 'export const api = 2;\n');
    });
    try {
      expect(runInWeb(work)).toBe(0);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  }, 20_000);
});

describe('vercel ignore fail-safe exit', () => {
  it('exits 1 when git is not on PATH', () => {
    const bin = mkdtempSync(path.join(tmpdir(), 'ff-no-git-'));
    try {
      const code = run({
        ...process.env,
        PATH: bin,
        VERCEL_GIT_COMMIT_REF: 'feature',
        VERCEL_ENV: 'preview',
      }, bin);
      expect(code).toBe(1);
    } finally {
      rmSync(bin, { recursive: true, force: true });
    }
  });
});
