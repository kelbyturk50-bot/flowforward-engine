#!/usr/bin/env node
// Run: node src/db/migrate.js
// Applies schema.sql to DATABASE_URL

const fs = require('fs');
const path = require('path');
const pool = require('./client');

async function migrate() {
  const sql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  console.log('[migrate] Applying schema...');
  try {
    await pool.query(sql);
    console.log('[migrate] ✓ Schema applied successfully');
  } catch (err) {
    console.error('[migrate] ✗ Error:', err.message);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

migrate();
