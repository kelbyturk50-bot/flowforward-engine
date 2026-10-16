#!/usr/bin/env node
// Read-only. Prints how many prospects have a pest-control company name
// stored under an industry that is not already pest. One integer on stdout.
// No names, ids, or other columns. Uses DATABASE_URL. Tests point that at a
// disposable database. The count runs inside a READ ONLY transaction.

const pool = require('../src/db/client');
const { legacyPestNameCountQuery } = require('../src/scoring/industry');

async function main() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN READ ONLY');
    const { text, values } = legacyPestNameCountQuery();
    const { rows } = await client.query(text, values);
    const n = rows[0] && rows[0].n;
    if (!Number.isInteger(n)) {
      await client.query('ROLLBACK');
      process.stderr.write('count failed\n');
      process.exitCode = 1;
      return;
    }
    await client.query('COMMIT');
    process.stdout.write(String(n) + '\n');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

main()
  .catch(() => {
    process.stderr.write('count failed\n');
    process.exitCode = 1;
  })
  .finally(() => pool.end());
