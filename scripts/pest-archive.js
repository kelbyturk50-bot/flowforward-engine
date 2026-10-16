#!/usr/bin/env node
// Pest-name archive. Not part of boot.
//
//   node scripts/pest-archive.js dry     count only. No names, emails, or ids.
//   node scripts/pest-archive.js apply   set the archive flag
//   node scripts/pest-archive.js undo    run src/db/pest-archive-undo.sql
//
// Undo restores exactly the rows whose archive_reason is
// 'pest-name gate (#39)'. Rows archived for another reason stay archived.
// Apply uses the same company-name predicate as the drafting gate, including
// a folded name longer than 200 code points. A second apply does not change
// rows that are already archived. Boot does not run either statement: a boot
// update would archive those rows again on the next deploy.
//
// Uses DATABASE_URL. Tests point that at a disposable database. Do not point
// this script at Railway from an agent.

const pool = require('../src/db/client');
const { runDry, runApply, runUndo } = require('../src/db/pest-archive');

const USAGE = {
  dry: 'pest-archive dry-run failed\n',
  apply: 'pest-archive failed\n',
  undo: 'pest-archive undo failed\n',
};

async function main() {
  const mode = process.argv[2];
  if (!USAGE[mode] || process.argv.length !== 3) {
    process.stderr.write('pest-archive failed\n');
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
    const n = mode === 'apply' ? await runApply(client) : await runUndo(client);
    const label = mode === 'apply' ? 'archived' : 'restored';
    process.stdout.write(`${label} ${n}\n`);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    process.stderr.write(USAGE[mode]);
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
  .finally(() => pool.end());
