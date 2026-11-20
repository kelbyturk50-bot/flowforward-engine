// Manual do-not-contact raise. Same write the POST /:id/do-not-contact
// route uses when value is true: keep an existing source, note the raise
// only when the flag was off, and stop sent, draft, and sending sequences
// on the caller's client. The caller holds the transaction and has locked
// the prospect row.

const { stopLeadSequences } = require('../proposals/send');

const MARKED_DNC = 'Marked do-not-contact (manual)';

async function raiseManualDoNotContact(client, id) {
  const updated = await client.query(
    `WITH prev AS (
       SELECT id, do_not_contact AS was_flagged
         FROM prospects
        WHERE id = $1
     )
     UPDATE prospects AS p
        SET do_not_contact = TRUE,
            do_not_contact_source = CASE
              WHEN p.do_not_contact AND p.do_not_contact_source IS NULL
                THEN p.do_not_contact_source
              ELSE COALESCE(p.do_not_contact_source, 'manual')
            END
       FROM prev
      WHERE p.id = prev.id
    RETURNING p.*, prev.was_flagged`,
    [id]
  );
  let row = null;
  if (updated.rows.length) {
    row = updated.rows[0];
    if (row.was_flagged === false) {
      await client.query(
        `INSERT INTO prospect_activities (prospect_id, type, body) VALUES ($1, 'note', $2)`,
        [id, MARKED_DNC]
      );
    }
    delete row.was_flagged;
  }
  await stopLeadSequences(client, id, MARKED_DNC);
  return row;
}

module.exports = { raiseManualDoNotContact, MARKED_DNC };
