// Stored open estimates for one pilot customer. No mail, no fetch.
// live_send_enabled is inserted as FALSE and is not a parameter.

const pool = require('../db/client');

async function createCustomer(name) {
  const { rows } = await pool.query(
    `INSERT INTO pilot_customers (name, live_send_enabled)
     VALUES ($1, FALSE)
     RETURNING id, name, live_send_enabled, created_at, updated_at`,
    [name]
  );
  return rows[0];
}

async function getCustomer(id) {
  const { rows } = await pool.query(
    `SELECT id, name, live_send_enabled
       FROM pilot_customers
      WHERE id = $1`,
    [id]
  );
  return rows[0] || null;
}

async function rememberSuppressions(client, customerId, emails) {
  const list = [...new Set(emails.filter(Boolean))];
  if (!list.length) return;
  await client.query(
    `INSERT INTO pilot_estimate_suppressions (customer_id, email)
     SELECT $1, unnest($2::text[])
     ON CONFLICT (customer_id, email) DO NOTHING`,
    [customerId, list]
  );
}

// Upsert estimates and keep opt-outs. A row already opted_out stays opted_out.
// An email on the suppression list is stored as opted_out, including after
// the estimates were deleted and uploaded again. Callers do not send mail.
async function upsertEstimates(customerId, rows) {
  if (!rows.length) return 0;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const ids = rows.map((row) => row.sourceEstimateId);
    const existing = await client.query(
      `SELECT source_estimate_id, email, status
         FROM pilot_open_estimates
        WHERE customer_id = $1 AND source_estimate_id = ANY($2::text[])`,
      [customerId, ids]
    );
    const priorOptOut = existing.rows
      .filter((row) => row.status === 'opted_out')
      .map((row) => row.email);
    const incomingOptOut = rows
      .filter((row) => row.status === 'opted_out')
      .map((row) => row.email);
    await rememberSuppressions(client, customerId, priorOptOut.concat(incomingOptOut));

    const values = [];
    const tuples = rows.map((row, i) => {
      const base = i * 8;
      values.push(
        customerId,
        row.sourceEstimateId,
        row.firstName,
        row.email,
        row.jobType,
        row.amount,
        row.estimateDate,
        row.status,
      );
      const p = (n) => `$${base + n}`;
      return `(${p(1)}::int, ${p(2)}::text, ${p(3)}::text, ${p(4)}::text, ${p(5)}::text, ${p(6)}::numeric, ${p(7)}::date, ${p(8)}::text)`;
    });
    const { rowCount } = await client.query(
      `INSERT INTO pilot_open_estimates (
         customer_id, source_estimate_id, homeowner_first_name, email,
         job_type, amount, estimate_date, status
       )
       SELECT v.customer_id, v.source_estimate_id, v.homeowner_first_name, v.email,
              v.job_type, v.amount, v.estimate_date,
              CASE
                WHEN s.email IS NOT NULL OR v.status = 'opted_out' THEN 'opted_out'
                ELSE v.status
              END
         FROM (VALUES ${tuples.join(', ')})
           AS v(customer_id, source_estimate_id, homeowner_first_name, email,
                job_type, amount, estimate_date, status)
         LEFT JOIN pilot_estimate_suppressions s
           ON s.customer_id = v.customer_id AND s.email = v.email
       ON CONFLICT (customer_id, source_estimate_id) DO UPDATE SET
         homeowner_first_name = EXCLUDED.homeowner_first_name,
         email = EXCLUDED.email,
         job_type = EXCLUDED.job_type,
         amount = EXCLUDED.amount,
         estimate_date = EXCLUDED.estimate_date,
         status = CASE
           WHEN pilot_open_estimates.status = 'opted_out' THEN 'opted_out'
           ELSE EXCLUDED.status
         END`,
      values
    );
    await client.query(
      `INSERT INTO pilot_estimate_suppressions (customer_id, email)
       SELECT customer_id, email
         FROM pilot_open_estimates
        WHERE customer_id = $1
          AND status = 'opted_out'
          AND source_estimate_id = ANY($2::text[])
       ON CONFLICT (customer_id, email) DO NOTHING`,
      [customerId, ids]
    );
    await client.query('COMMIT');
    return rowCount;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

async function listEstimates(customerId) {
  const { rows } = await pool.query(
    `SELECT source_estimate_id, homeowner_first_name, email, job_type,
            amount, estimate_date, status, created_at, updated_at
       FROM pilot_open_estimates
      WHERE customer_id = $1
      ORDER BY source_estimate_id`,
    [customerId]
  );
  return rows;
}

async function deleteEstimates(customerId) {
  const { rowCount } = await pool.query(
    'DELETE FROM pilot_open_estimates WHERE customer_id = $1',
    [customerId]
  );
  return rowCount;
}

module.exports = {
  createCustomer,
  getCustomer,
  upsertEstimates,
  listEstimates,
  deleteEstimates,
};
