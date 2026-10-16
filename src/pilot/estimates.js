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

async function upsertEstimates(customerId, rows) {
  if (!rows.length) return 0;
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
    return `(${p(1)}, ${p(2)}, ${p(3)}, ${p(4)}, ${p(5)}, ${p(6)}, ${p(7)}, ${p(8)})`;
  });
  const { rowCount } = await pool.query(
    `INSERT INTO pilot_open_estimates (
       customer_id, source_estimate_id, homeowner_first_name, email,
       job_type, amount, estimate_date, status
     ) VALUES ${tuples.join(', ')}
     ON CONFLICT (customer_id, source_estimate_id) DO UPDATE SET
       homeowner_first_name = EXCLUDED.homeowner_first_name,
       email = EXCLUDED.email,
       job_type = EXCLUDED.job_type,
       amount = EXCLUDED.amount,
       estimate_date = EXCLUDED.estimate_date,
       status = EXCLUDED.status`,
    values
  );
  return rowCount;
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
