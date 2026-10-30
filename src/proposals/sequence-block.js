// A live send, or a row waiting on a manual look, blocks another first send.
// The review sentence is for a row that is not out yet.

const REVIEW_WAIT = 'Another version is waiting for review.';
const ALREADY_OUT = 'A proposal is already out for this lead. Stop that sequence before writing a new one.';
const RESTORE_OUT = 'Another version is already out for this lead.';

const BLOCKS_NEW_SEND = `status IN ('sent', 'sending', 'manual_review') OR (status = 'stopped' AND stop_reason LIKE 'Needs manual review%')`;

function blocksNewSendSql(alias) {
  const sql = alias ? BLOCKS_NEW_SEND.replace(/\b(status|stop_reason)\b/g, `${alias}.$1`) : BLOCKS_NEW_SEND;
  return `(${sql})`;
}

function isReviewBlock(row) {
  if (!row) return false;
  if (row.status === 'manual_review') return true;
  return row.status === 'stopped' && String(row.stop_reason || '').startsWith('Needs manual review');
}

function siblingBlockMessage(row, { restore = false } = {}) {
  if (isReviewBlock(row)) return REVIEW_WAIT;
  return restore ? RESTORE_OUT : ALREADY_OUT;
}

async function blockingSibling(db, prospectId, exceptId) {
  const params = [prospectId];
  let except = '';
  if (exceptId != null) {
    params.push(exceptId);
    except = ` AND id <> $2`;
  }
  const { rows } = await db.query(
    `SELECT status, stop_reason FROM proposals
      WHERE prospect_id = $1${except} AND ${blocksNewSendSql()}
      LIMIT 1`,
    params
  );
  return rows[0] || null;
}

module.exports = {
  BLOCKS_NEW_SEND,
  REVIEW_WAIT,
  ALREADY_OUT,
  RESTORE_OUT,
  blocksNewSendSql,
  isReviewBlock,
  siblingBlockMessage,
  blockingSibling,
};
