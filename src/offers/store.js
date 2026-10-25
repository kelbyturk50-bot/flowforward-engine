// Offer rows only. This module does not import a mail transport.

const pool = require('../db/client');

const OFFER_TYPES = Object.freeze(['founding', 'annual_prepay']);
const PACKAGES = Object.freeze(['starter', 'receptionist', 'front_office', 'consulting']);
const CHANNELS = Object.freeze(['email', 'phone', 'text', 'in_person', 'other']);
const STATUSES = Object.freeze(['offered', 'accepted', 'declined', 'expired']);

const FOUNDING_CAP = 3;
// Distinct from the schema boot lock (89089001). Held until the transaction ends.
const FOUNDING_CAP_LOCK = 89089109;

const COLUMNS = `
  id, lead_id, offer_type, package, offered_at, channel, status,
  status_changed_at, notes, is_test, created_at
`;

function emptySummary() {
  return {
    by_offer_type: { founding: 0, annual_prepay: 0 },
    by_status: { offered: 0, accepted: 0, declined: 0, expired: 0 },
    founding_slots: { used: 0, pending: 0, cap: FOUNDING_CAP },
  };
}

function stamp(value) {
  if (value == null) return null;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString();
}

function present(row) {
  return {
    id: row.id,
    lead_id: row.lead_id,
    offer_type: row.offer_type,
    package: row.package,
    offered_at: stamp(row.offered_at),
    channel: row.channel,
    status: row.status,
    status_changed_at: stamp(row.status_changed_at),
    notes: row.notes == null ? null : String(row.notes),
    is_test: row.is_test === true,
    created_at: stamp(row.created_at),
  };
}

async function foundingSlots(client) {
  const db = client || pool;
  const { rows } = await db.query(
    `SELECT
       COUNT(*) FILTER (WHERE status = 'accepted')::int AS used,
       COUNT(*) FILTER (WHERE status = 'offered')::int AS pending
     FROM lead_offers
     WHERE offer_type = 'founding'`
  );
  const row = rows[0] || { used: 0, pending: 0 };
  return { used: row.used || 0, pending: row.pending || 0, cap: FOUNDING_CAP };
}

function capBlocked(slots, confirmOverCap) {
  return slots.used >= FOUNDING_CAP && confirmOverCap !== true;
}

async function withClient(lock, fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    if (lock) {
      await client.query('SELECT pg_advisory_xact_lock($1::bigint)', [FOUNDING_CAP_LOCK]);
    }
    const out = await fn(client);
    if (out && out.rollback) {
      await client.query('ROLLBACK');
      return out;
    }
    await client.query('COMMIT');
    return out;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

async function leadExists(client, leadId) {
  const { rows } = await client.query('SELECT id FROM prospects WHERE id = $1', [leadId]);
  return Boolean(rows[0]);
}

async function listOffers() {
  const { rows } = await pool.query(
    `SELECT ${COLUMNS} FROM lead_offers ORDER BY id ASC`
  );
  const grouped = await pool.query(
    `SELECT offer_type, status, COUNT(*)::int AS n
       FROM lead_offers
      GROUP BY offer_type, status`
  );
  const summary = emptySummary();
  for (const row of grouped.rows) {
    if (Object.prototype.hasOwnProperty.call(summary.by_offer_type, row.offer_type)) {
      summary.by_offer_type[row.offer_type] += row.n;
    }
    if (Object.prototype.hasOwnProperty.call(summary.by_status, row.status)) {
      summary.by_status[row.status] += row.n;
    }
    if (row.offer_type === 'founding' && row.status === 'accepted') summary.founding_slots.used += row.n;
    if (row.offer_type === 'founding' && row.status === 'offered') summary.founding_slots.pending += row.n;
  }
  return { offers: rows.map(present), summary };
}

async function listForLead(leadId) {
  const found = await pool.query('SELECT id FROM prospects WHERE id = $1', [leadId]);
  if (!found.rows[0]) return null;
  const { rows } = await pool.query(
    `SELECT ${COLUMNS} FROM lead_offers WHERE lead_id = $1 ORDER BY id ASC`,
    [leadId]
  );
  return rows.map(present);
}

async function createOffer(input) {
  const founding = input.offer_type === 'founding';
  return withClient(founding, async (client) => {
    if (!(await leadExists(client, input.lead_id))) {
      return { rollback: true, code: 'invalid_lead' };
    }
    if (founding && capBlocked(await foundingSlots(client), input.confirm_over_cap)) {
      return { rollback: true, code: 'founding_cap', founding_slots: await foundingSlots(client) };
    }
    const inserted = await client.query(
      `INSERT INTO lead_offers (
         lead_id, offer_type, package, offered_at, channel, status,
         status_changed_at, notes, is_test
       ) VALUES (
         $1, $2, $3, COALESCE($4::timestamptz, NOW()), $5, $6, NOW(), $7, $8
       )
       RETURNING ${COLUMNS}`,
      [
        input.lead_id,
        input.offer_type,
        input.package,
        input.offered_at,
        input.channel,
        input.status,
        input.notes,
        input.is_test,
      ]
    );
    return { offer: present(inserted.rows[0]) };
  });
}

async function updateStatus(id, input) {
  return withClient(true, async (client) => {
    const current = await client.query(
      `SELECT ${COLUMNS} FROM lead_offers WHERE id = $1 FOR UPDATE`,
      [id]
    );
    const row = current.rows[0];
    if (!row) return { rollback: true, code: 'not_found' };
    const becomingAccepted = input.status === 'accepted'
      && row.status !== 'accepted'
      && row.offer_type === 'founding';
    if (becomingAccepted && capBlocked(await foundingSlots(client), input.confirm_over_cap)) {
      return { rollback: true, code: 'founding_cap', founding_slots: await foundingSlots(client) };
    }
    const updated = await client.query(
      `UPDATE lead_offers
          SET status = $2, status_changed_at = NOW()
        WHERE id = $1
        RETURNING ${COLUMNS}`,
      [id, input.status]
    );
    return { offer: present(updated.rows[0]) };
  });
}

module.exports = {
  OFFER_TYPES,
  PACKAGES,
  CHANNELS,
  STATUSES,
  FOUNDING_CAP,
  FOUNDING_CAP_LOCK,
  emptySummary,
  listOffers,
  listForLead,
  createOffer,
  updateStatus,
};
