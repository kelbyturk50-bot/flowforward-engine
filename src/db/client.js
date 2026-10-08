const { Pool, types } = require('pg');

// Return DATE columns as 'YYYY-MM-DD' strings (no timezone shifting)
types.setTypeParser(1082, v => v);
require('dotenv').config();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
});

pool.on('error', (err) => {
  console.error('[db] Unexpected pool error:', err.message);
});

module.exports = pool;
