// pilot_events rows: an allowlisted type, timestamps, and join ids.
// No free text, IP, user agent, or contact fields are accepted or stored.

const pool = require('../db/client');

const EVENT_TYPES = Object.freeze([
  'demo_view',
  'step_estimates',
  'step_preview',
  'step_reply',
  'step_recovered',
  'estimate_recovered',
]);

const ALLOWED = new Set(EVENT_TYPES);

function isEventType(value) {
  return typeof value === 'string' && ALLOWED.has(value);
}

async function recordEvent(tokenRow, eventType) {
  if (!isEventType(eventType)) {
    throw Object.assign(new Error('Invalid event type'), { status: 400 });
  }
  await pool.query(
    `INSERT INTO pilot_events (event_type, token_id, proposal_id, prospect_id)
     VALUES ($1, $2, $3, $4)`,
    [eventType, tokenRow.id, tokenRow.proposal_id, tokenRow.prospect_id]
  );
}

module.exports = { EVENT_TYPES, isEventType, recordEvent };
