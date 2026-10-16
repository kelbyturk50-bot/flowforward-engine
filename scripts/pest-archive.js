#!/usr/bin/env node
// Pest-name archive. Not part of boot.
//
//   node scripts/pest-archive.js dry
//   node scripts/pest-archive.js apply
//   node scripts/pest-archive.js undo <run-id>
//
// Dry-run prints counts only. No names, emails, or ids.
// Apply stamps archived_at, archive_reason, and a new archive_run_id, then
// prints the host, the database name, the count, and the run id.
// Undo requires that run id. It restores rows with this reason and this run
// id only. Another reason, or the same reason from another run, stays archived.
//
// Apply and undo refuse to write when NODE_ENV is production or the database
// host is not local, unless PEST_ARCHIVE_CONFIRM equals the connected
// database name. They print the host and database name before the update.
// The user, password, and URL are not printed. A blocked target with no
// confirm exits before connecting.
//
// Uses DATABASE_URL. Tests point that at a disposable database. Do not point
// this script at Railway from an agent. Boot does not run either statement:
// a boot update would archive those rows again on the next deploy.

const pool = require('../src/db/client');
const {
  isRunId,
  archiveTarget,
  beginGuardedWrite,
  runDry,
  runApply,
  runUndo,
} = require('../src/db/pest-archive');

const USAGE = {
  dry: 'pest-archive dry-run failed\n',
  apply: 'pest-archive failed\n',
  undo: 'pest-archive undo failed\n',
};

function confirmSet(env) {
  return typeof env.PEST_ARCHIVE_CONFIRM === 'string' && env.PEST_ARCHIVE_CONFIRM.length > 0;
}

async function main() {
  const mode = process.argv[2];
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

  if (mode !== 'dry' && archiveTarget(process.env).blocked && !confirmSet(process.env)) {
    process.stderr.write('pest-archive refused\n');
    process.exitCode = 1;
    return;
  }

  const client = await pool.connect();
  try {
    if (mode === 'dry') {
      const text = await runDry(client);
      process.stdout.write(text);
      return;
    }
    const preface = await beginGuardedWrite(client, process.env);
    process.stdout.write(`host ${preface.host}\n`);
    process.stdout.write(`database ${preface.database}\n`);
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
    process.stderr.write(err.code === 'PEST_ARCHIVE_REFUSED' ? 'pest-archive refused\n' : USAGE[mode]);
    process.exitCode = 1;
  } finally {
    client.release();
  }
}

main()
  .catch(() => {
    process.stderr.write('pest-archive failed\n');
    process.exitCode = 1;
  })
  .finally(() => pool.end().catch(() => {}));
