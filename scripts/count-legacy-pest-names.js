#!/usr/bin/env node
// Read-only. Prints how many prospects have a pest-control company name
// stored under an industry that is not already pest. One integer on stdout.
// No names, ids, or other columns. Uses DATABASE_URL. Tests point that at a
// disposable database.

const pool = require('../src/db/client');
const { legacyPestNameCountQuery } = require('../src/scoring/industry');

async function main() {
  const { text, values } = legacyPestNameCountQuery();
  const { rows } = await pool.query(text, values);
  const n = rows[0] && rows[0].n;
  if (!Number.isInteger(n)) {
    process.stderr.write('count failed\n');
    process.exitCode = 1;
    return;
  }
  process.stdout.write(String(n) + '\n');
}

main()
  .catch(() => {
    process.stderr.write('count failed\n');
    process.exitCode = 1;
  })
  .finally(() => pool.end());
