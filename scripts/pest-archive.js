#!/usr/bin/env node
// Pest-name archive. Not part of boot.
//
//   node scripts/pest-archive.js dry
//   node scripts/pest-archive.js apply
//   node scripts/pest-archive.js undo <run-id>
//
// Dry-run prints counts only. No names, emails, or ids.
// Apply stamps archived_at, archive_reason, and a new archive_run_id, then
// prints the database name, local or remote, the count, and the run id.
// Undo requires that run id. It restores rows with this reason and this run
// id only. Another reason, or the same reason from another run, stays archived.
//
// .env is loaded first. An already-set variable wins. The host is the one
// node-postgres dials: a non-empty DATABASE_URL host, otherwise PGHOST,
// otherwise localhost. A whitespace-only DATABASE_URL is ambiguous: pg parses
// it as host "base". PGHOSTADDR, a URL hostaddr, PGSERVICE, or more than
// one host is ambiguous and is refused. Dry, apply, and undo refuse when
// NODE_ENV trims to production in any case, or that host is not local, unless
// PEST_ARCHIVE_CONFIRM trims to the connected database name. Empty or
// whitespace confirm counts as unset. They print the database name and local
// or remote, never the host, user, password, or URL. A blocked target with
// no confirm exits before the database client loads. A database error prints
// the SQLSTATE and does not print the error text. Apply and undo set
// lock_timeout to 5s and statement_timeout to 15s.
//
// Uses DATABASE_URL. Tests point that at a disposable database. Do not point
// this script at Railway from an agent. Boot does not run either statement:
// a boot update would archive those rows again on the next deploy.

require('dotenv').config();

const {
  isRunId,
  archiveTarget,
  confirmValue,
  beginGuardedWrite,
  runDry,
  runApply,
  runUndo,
} = require('../src/db/pest-archive');

let pool;
let mode;

const USAGE = {
  dry: 'pest-archive dry-run failed\n',
  apply: 'pest-archive failed\n',
  undo: 'pest-archive undo failed\n',
};

function failureText(mode, err) {
  const line = USAGE[mode] || 'pest-archive failed\n';
  const code = err && typeof err.code === 'string' ? err.code : '';
  if (/^[0-9A-Z]{5}$/.test(code)) return line.replace(/\n$/, ` (${code})\n`);
  return line;
}

function confirmSet(env) {
  return confirmValue(env) != null;
}

async function main() {
  mode = process.argv[2];
  const argc = process.argv.length;
  if (mode === 'undo') {
    if (argc !== 4 || !isRunId(process.argv[3])) {
      process.stderr.write('pest-archive undo failed\n');
      process.exitCode = 1;
      return;
    }
  } else if (!USAGE[mode] || argc !== 3) {
    process.stderr.write('pest-archive failed\n');
    process.exitCode = 1;
    return;
  }

  const target = archiveTarget(process.env);
  if (target.blocked && !confirmSet(process.env)) {
    process.stderr.write('pest-archive refused\n');
    process.exitCode = 1;
    return;
  }

  pool = require('../src/db/client');
  const client = await pool.connect();
  try {
    if (mode === 'dry') {
      if (target.blocked) {
        await client.query('BEGIN READ ONLY');
        const { rows } = await client.query('SELECT current_database() AS name');
        const name = rows[0] && rows[0].name;
        if (confirmValue(process.env) !== name) {
          await client.query('ROLLBACK');
          process.stderr.write('pest-archive refused\n');
          process.exitCode = 1;
          return;
        }
        const text = await runDry(client, { joined: true });
        await client.query('COMMIT');
        process.stdout.write(text);
        return;
      }
      const text = await runDry(client);
      process.stdout.write(text);
      return;
    }
    const preface = await beginGuardedWrite(client, process.env);
    process.stdout.write(`database ${preface.database}\n`);
    process.stdout.write(`${preface.place}\n`);
    if (mode === 'apply') {
      const { n, runId } = await runApply(client, { joined: true });
      await client.query('COMMIT');
      process.stdout.write(`archived ${n}\n`);
      process.stdout.write(`run ${runId}\n`);
      return;
    }
    const n = await runUndo(client, process.argv[3], { joined: true });
    await client.query('COMMIT');
    process.stdout.write(`restored ${n}\n`);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    process.stderr.write(err.code === 'PEST_ARCHIVE_REFUSED' ? 'pest-archive refused\n' : failureText(mode, err));
    process.exitCode = 1;
  } finally {
    client.release();
  }
}

main()
  .catch((err) => {
    process.stderr.write(failureText(mode, err));
    process.exitCode = 1;
  })
  .finally(() => {
    if (pool) return pool.end().catch(() => {});
  });
