// Last-touch and first-touch, computed on read by campaign_attribute_conversion.
// This module does not send mail.

const pool = require('../db/client');

async function attributeConversion({
  leadId,
  occurredAt,
  origin,
  sourceId,
  model = 'last',
}, db = pool) {
  const { rows } = await db.query(
    'SELECT * FROM campaign_attribute_conversion($1, $2, $3, $4, $5)',
    [leadId, occurredAt, origin, sourceId, model]
  );
  return rows[0] || null;
}

module.exports = { attributeConversion };
