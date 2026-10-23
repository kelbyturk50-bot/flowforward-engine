const pool = require('../db/client');

async function withChatTx(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SET LOCAL lock_timeout = '2s'");
    await client.query("SET LOCAL statement_timeout = '5s'");
    await client.query("SET LOCAL TIME ZONE 'UTC'");
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (rollbackErr) {
      void rollbackErr;
    }
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { withChatTx, pool };
