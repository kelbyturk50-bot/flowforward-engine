#!/usr/bin/env node
/**
 * Vercel Ignored Build Step for the CRM.
 *
 * The Vercel project root directory is `web/`, so this command runs with
 * `web/` as its cwd (`node scripts/vercel-ignore.mjs`). Paths in the diff
 * are still repo-root relative: the script asks git for the toplevel.
 *
 * Exit 0 skips the build. Exit 1 runs the build.
 *
 * `main` always builds. Any other ref builds when the merge-base diff
 * against `origin/main` touches `web/`, this script, or Vercel config
 * (`vercel.json` at the repo root, `web/vercel.json`, `.vercelignore`,
 * or anything under `.vercel/`). A diff that succeeds and touches none
 * of those paths skips, including a successful empty diff (the commit
 * matches the merge base, so the frontend is unchanged). If git is
 * missing, the clone is too shallow to find a merge base, `origin/main`
 * cannot be fetched, or anything else throws, the script builds.
 *
 * Vercel clones a single branch with a shallow history, and
 * `git fetch origin main` only writes FETCH_HEAD unless the remote's
 * refspec already tracks main. The fetch uses an explicit refspec so
 * `origin/main` exists. `--depth` / `--deepen` run only on a shallow
 * clone; a full clone fetches normally so this command cannot truncate
 * local history.
 */

import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

/** Command in web/vercel.json. cwd is the Vercel root directory, `web/`. */
export const IGNORE_COMMAND = 'node scripts/vercel-ignore.mjs';

/** Repo-root path of this file. A change here must build. */
export const SCRIPT_REPO_PATH = 'web/scripts/vercel-ignore.mjs';

const MAIN_REFSPEC = 'refs/heads/main:refs/remotes/origin/main';

/**
 * A successful empty diff skips: the branch matches the merge base, so
 * no frontend or Vercel config path changed. Callers must pass
 * `diffOk: true` only after git actually produced the name list.
 */
export function shouldBuild({ ref, changedFiles, diffOk } = {}) {
  if (ref === 'main') {
    return { build: true, reason: 'VERCEL_GIT_COMMIT_REF is main' };
  }
  if (diffOk !== true || !Array.isArray(changedFiles)) {
    return { build: true, reason: 'diff against origin/main was not computed' };
  }

  const matched = [];
  for (const file of changedFiles) {
    if (pathTriggersBuild(file)) matched.push(normalizeRepoPath(file));
  }
  if (matched.length > 0) {
    return {
      build: true,
      reason: `frontend or Vercel config changed: ${summarize(matched)}`,
    };
  }
  if (changedFiles.length === 0) {
    return {
      build: false,
      reason: 'empty diff against origin/main; nothing changed',
    };
  }
  return {
    build: false,
    reason: `no frontend or Vercel config paths changed (${changedFiles.length} other path${changedFiles.length === 1 ? '' : 's'})`,
  };
}

/** Exit 0 skips. Anything other than an explicit skip builds. */
export function exitCodeFor(decision) {
  if (!decision || decision.build !== false) return 1;
  return 0;
}

export function pathTriggersBuild(filePath) {
  const p = normalizeRepoPath(filePath);
  if (!p) return false;
  if (p === 'web' || p === 'vercel.json' || p === '.vercelignore' || p === '.vercel') return true;
  if (p === 'web/vercel.json' || p === SCRIPT_REPO_PATH) return true;
  if (p.startsWith('web/')) return true;
  if (p.startsWith('.vercel/')) return true;
  return false;
}

export function normalizeRepoPath(filePath) {
  if (typeof filePath !== 'string') return '';
  let p = filePath.replaceAll('\\', '/').trim();
  if (p.startsWith('./')) p = p.slice(2);
  return p;
}

/** `git diff -z --name-only` records, including a trailing NUL. */
export function parseDiffNames(output) {
  if (typeof output !== 'string' || output.length === 0) return [];
  return output.split('\0').filter(Boolean);
}

export function errorText(err) {
  const stderr = err && err.stderr != null ? String(err.stderr).trim() : '';
  const raw = stderr || (err && err.message) || 'unknown error';
  const line = String(raw).split('\n').map((part) => part.trim()).filter(Boolean)[0] || 'unknown error';
  return line.replace(/https?:\/\/\S+/g, '[url]').slice(0, 240);
}

function log(line) {
  process.stdout.write(`[vercel-ignore] ${line}\n`);
}

function summarize(paths) {
  const shown = paths.slice(0, 20);
  const extra = paths.length - shown.length;
  if (extra > 0) return `${shown.join(', ')}, and ${extra} more`;
  return shown.join(', ');
}

function git(args, cwd) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 120_000,
    env: {
      ...process.env,
      GIT_TERMINAL_PROMPT: '0',
      GCM_INTERACTIVE: 'never',
    },
  });
}

function readEnvRef(env) {
  const raw = env && env.VERCEL_GIT_COMMIT_REF;
  if (typeof raw !== 'string') return '';
  return raw.trim();
}

function readShallow(root) {
  try {
    return git(['rev-parse', '--is-shallow-repository'], root).trim() === 'true';
  } catch {
    return false;
  }
}

function canMergeBase(root) {
  try {
    return git(['merge-base', 'origin/main', 'HEAD'], root).trim().length > 0;
  } catch {
    return false;
  }
}

function prepareOriginMain(root) {
  const shallow = readShallow(root);
  const attempts = shallow
    ? [
        ['fetch', '--depth=50', 'origin', MAIN_REFSPEC],
        ['fetch', '--deepen=50', 'origin', MAIN_REFSPEC],
        ['fetch', '--deepen=50', 'origin'],
      ]
    : [
        ['fetch', 'origin', MAIN_REFSPEC],
      ];
  const errors = [];
  for (const args of attempts) {
    try {
      git(args, root);
    } catch (err) {
      errors.push(errorText(err));
    }
    if (canMergeBase(root)) return { shallow };
  }
  const why = errors.length > 0 ? errors.join('; ') : 'no common ancestor with origin/main';
  throw new Error(why);
}

function changedFilesAgainstMain(root) {
  const { shallow } = prepareOriginMain(root);
  const base = git(['merge-base', 'origin/main', 'HEAD'], root).trim();
  if (!base) throw new Error('merge-base returned an empty revision');
  const out = git(['diff', '--no-renames', '--name-only', '-z', base, 'HEAD'], root);
  return { base, files: parseDiffNames(out), shallow };
}

export function decide(env = process.env, cwd = process.cwd()) {
  const fromEnv = readEnvRef(env);
  if (fromEnv === 'main') {
    return shouldBuild({ ref: 'main', changedFiles: [], diffOk: true });
  }

  const root = git(['rev-parse', '--show-toplevel'], cwd).trim();
  if (!root) throw new Error('git rev-parse --show-toplevel returned an empty path');

  let ref = fromEnv;
  let refSource = 'VERCEL_GIT_COMMIT_REF';
  if (!ref) {
    ref = git(['rev-parse', '--abbrev-ref', 'HEAD'], root).trim();
    refSource = 'HEAD';
  }
  if (!ref || ref === 'HEAD') {
    throw new Error('branch ref is unknown');
  }
  if (ref === 'main') {
    return { build: true, reason: `${refSource} is main` };
  }

  const { base, files, shallow } = changedFilesAgainstMain(root);
  log(`ref=${ref} (${refSource}) shallow=${shallow} merge-base=${base}`);
  if (files.length > 0) {
    log(`changed: ${summarize(files)}`);
  } else {
    log('changed: (none)');
  }
  return shouldBuild({ ref, changedFiles: files, diffOk: true });
}

function report(decision) {
  const code = exitCodeFor(decision);
  const verb = code === 0 ? 'SKIP' : 'BUILD';
  const reason = decision && decision.reason ? decision.reason : 'diff against origin/main was not computed';
  log(`${verb} (exit ${code}): ${reason}`);
  return code;
}

export function run(env = process.env, cwd = process.cwd()) {
  try {
    return report(decide(env, cwd));
  } catch (err) {
    log(`BUILD (exit 1): ${errorText(err)}`);
    return 1;
  }
}

function invokedDirectly() {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return realpathSync(path.resolve(entry)) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (invokedDirectly()) {
  process.exitCode = run();
}
