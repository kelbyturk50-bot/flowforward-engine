// A live send, or a row waiting on a manual look, blocks another first send.
// The review sentence is for a row that is not out yet.

const REVIEW_WAIT = 'Another version is waiting for review.';
const ALREADY_OUT = 'A proposal is already out for this lead. Stop that sequence before writing a new one.';
const ALREADY_OUT_SEND = 'A proposal is already out for this lead. Stop that sequence first.';
const RESTORE_OUT = 'Another version is already out for this lead.';

// POSIX space, NBSP, figure space (U+2007), narrow no-break space (U+202F), and BOM (U+FEFF).
// JavaScript trim() also strips other Unicode spaces, so this is not the full trim() set.
const REVIEW_EDGE = "[[:space:]' || chr(160) || chr(8199) || chr(8239) || chr(65279) || '";
const BLOCKS_NEW_SEND = `status IN ('sent', 'sending', 'manual_review') OR (status = 'stopped' AND lower(regexp_replace(stop_reason, '^${REVIEW_EDGE}]+|${REVIEW_EDGE}]+$', '', 'g')) LIKE 'needs manual review%')`;

function blocksNewSendSql(alias) {
  const sql = alias ? BLOCKS_NEW_SEND.replace(/\b(status|stop_reason)\b/g, `${alias}.$1`) : BLOCKS_NEW_SEND;
  return `(${sql})`;
}

function foldedReason(value) {
  return String(value || '').trim().toLowerCase();
}

function isReviewBlock(row) {
  if (!row) return false;
  if (row.status === 'manual_review') return true;
  return row.status === 'stopped' && foldedReason(row.stop_reason).startsWith('needs manual review');
}

function siblingBlockMessage(row, { restore = false, send = false } = {}) {
  if (isReviewBlock(row)) return REVIEW_WAIT;
  if (restore) return RESTORE_OUT;
  if (send) return ALREADY_OUT_SEND;
  return ALREADY_OUT;
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
  ALREADY_OUT_SEND,
  RESTORE_OUT,
  blocksNewSendSql,
  isReviewBlock,
  siblingBlockMessage,
  blockingSibling,
};
