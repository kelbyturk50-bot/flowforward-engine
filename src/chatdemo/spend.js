// Spend seam. Integer micro-dollars. The ceiling is an argument, never a table.
// Every chat statement takes the clock timestamp as a bound parameter.

const crypto = require('crypto');
const cfg = require('../proposals/config');
const { CHAT_CAPS } = require('./caps');
const { usdToMicros } = require('./ceiling');
const { log } = require('./log');
const { withChatTx, pool } = require('./tx');

class UnpricedModelError extends Error {
  constructor() {
    super('unpriced');
    this.name = 'UnpricedModelError';
    this.code = 'model_unpriced';
  }
}

function reservationUsd(model = cfg.MODEL) {
  if (!cfg.PRICES || !Object.prototype.hasOwnProperty.call(cfg.PRICES, model)) {
    throw new UnpricedModelError();
  }
  const usd = cfg.costOf(model, {
    cacheWrite: CHAT_CAPS.maxInputTokens,
    output: CHAT_CAPS.maxOutputTokens,
  });
  return usdToMicros(usd);
}

function asMicros(value) {
  const n = typeof value === 'bigint' ? Number(value) : Number(value);
  if (!Number.isSafeInteger(n)) {
    const err = new Error('micros');
    err.code = '22P02';
    throw err;
  }
  return n;
}

async function sweepWith(client, at) {
  const { rows } = await client.query(
    `WITH due AS (
       SELECT id
         FROM chat_demo_reservations
        WHERE status = 'reserved'
          AND created_at < $1::timestamptz - interval '10 minutes'
        FOR UPDATE SKIP LOCKED
     ),
     marked AS (
       UPDATE chat_demo_reservations AS r
          SET status = 'expired', expired_at = $1::timestamptz
         FROM due
        WHERE r.id = due.id
          AND r.status = 'reserved'
       RETURNING r.day, r.amount_micros
     ),
     sums AS (
       SELECT day, SUM(amount_micros) AS amt, COUNT(*)::int AS n
         FROM marked
        GROUP BY day
     )
     UPDATE chat_demo_spend_days AS s
        SET reserved_micros = s.reserved_micros - sums.amt,
            spent_micros = s.spent_micros + sums.amt
       FROM sums
      WHERE s.day = sums.day
     RETURNING sums.n AS n`,
    [at]
  );
  return rows.reduce((sum, row) => sum + Number(row.n || 0), 0);
}

async function reserve({ day, turnId, amountMicros, ceilingMicros, at }) {
  if (ceilingMicros == null || amountMicros == null || amountMicros <= 0) return null;
  return withChatTx(async (client) => {
    const expired = await sweepWith(client, at);
    if (expired > 0) log('reservation_expired');
    await client.query(
      `INSERT INTO chat_demo_spend_days (day, spent_micros, reserved_micros, overshoot_micros)
       VALUES ($1::date, 0, 0, 0)
       ON CONFLICT (day) DO NOTHING`,
      [day]
    );
    const id = crypto.randomUUID();
    const { rows } = await client.query(
      `WITH upd AS (
         UPDATE chat_demo_spend_days
            SET reserved_micros = reserved_micros + $2
          WHERE day = $1::date
            AND spent_micros + reserved_micros + $2 <= $3
         RETURNING day
       )
       INSERT INTO chat_demo_reservations (id, day, turn_id, status, amount_micros, created_at)
       SELECT $4::uuid, day, $5::uuid, 'reserved', $2, $6::timestamptz
         FROM upd
       RETURNING id`,
      [day, amountMicros, ceilingMicros, id, turnId || null, at]
    );
    return rows[0] ? rows[0].id : null;
  });
}

async function settle({ id, actualMicros, at }) {
  const actual = asMicros(actualMicros);
  return withChatTx(async (client) => {
    const { rows } = await client.query(
      `WITH old AS (
         SELECT id, status, amount_micros, day
           FROM chat_demo_reservations
          WHERE id = $1
          FOR UPDATE
       ),
       upd AS (
         UPDATE chat_demo_reservations AS r
            SET status = 'settled',
                settled_at = $2::timestamptz,
                actual_micros = $3
           FROM old
          WHERE r.id = old.id
            AND old.status IN ('reserved', 'expired')
         RETURNING old.status AS status, old.amount_micros AS amount_micros, old.day AS day
       )
       SELECT status, amount_micros, day FROM upd`,
      [id, at, actual]
    );
    if (!rows[0]) return { applied: false, overshoot: 0 };
    const status = rows[0].status;
    const amount = asMicros(rows[0].amount_micros);
    const spentDelta = status === 'reserved' ? actual : actual - amount;
    const reservedDelta = status === 'reserved' ? -amount : 0;
    const overshoot = actual > amount ? actual - amount : 0;
    await client.query(
      `UPDATE chat_demo_spend_days
          SET reserved_micros = reserved_micros + $2,
              spent_micros = spent_micros + $3,
              overshoot_micros = overshoot_micros + $4
        WHERE day = $1`,
      [rows[0].day, reservedDelta, spentDelta, overshoot]
    );
    if (overshoot > 0) log('spend_overshoot');
    return { applied: true, status, overshoot };
  });
}

async function release(id, at) {
  return withChatTx(async (client) => {
    const { rows } = await client.query(
      `UPDATE chat_demo_reservations
          SET status = 'released', released_at = $2::timestamptz
        WHERE id = $1
          AND status = 'reserved'
       RETURNING day, amount_micros`,
      [id, at]
    );
    if (!rows[0]) return { released: false };
    await client.query(
      `UPDATE chat_demo_spend_days
          SET reserved_micros = reserved_micros - $2
        WHERE day = $1`,
      [rows[0].day, asMicros(rows[0].amount_micros)]
    );
    return { released: true };
  });
}

async function sweep(at) {
  const when = at instanceof Date ? at : new Date(at);
  return withChatTx(async (client) => {
    const n = await sweepWith(client, when);
    if (n > 0) log('reservation_expired');
    return n;
  });
}

async function readSpend(day) {
  const { rows } = await pool.query(
    `SELECT spent_micros, reserved_micros, overshoot_micros
       FROM chat_demo_spend_days
      WHERE day = $1::date`,
    [day]
  );
  if (!rows[0]) return { spent_micros: 0, reserved_micros: 0, overshoot_micros: 0 };
  return {
    spent_micros: asMicros(rows[0].spent_micros),
    reserved_micros: asMicros(rows[0].reserved_micros),
    overshoot_micros: asMicros(rows[0].overshoot_micros),
  };
}

module.exports = {
  UnpricedModelError,
  reservationUsd,
  reserve,
  settle,
  release,
  sweep,
  readSpend,
  asMicros,
};
