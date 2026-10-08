#!/usr/bin/env node
// Applies schema.sql to DATABASE_URL. The schema is idempotent, so this also
// runs automatically every time the server boots (see src/server.js).
//
// Run manually: node src/db/migrate.js

const fs = require('fs');
const path = require('path');
const pool = require('./client');

async function applySchema() {
  const sql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  await pool.query(sql);
}

module.exports = { applySchema };

if (require.main === module) {
  console.log('[migrate] Applying schema...');
  applySchema()
    .then(() => console.log('[migrate] ✓ Schema applied successfully'))
    .catch(err => { console.error('[migrate] ✗ Error:', err.message); process.exitCode = 1; })
    .finally(() => pool.end());
}
