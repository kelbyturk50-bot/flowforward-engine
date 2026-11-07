// One lock order for a lead and its proposals: the prospect row first, then
// every proposal row in id order. Approve, mark-sent, the draft insert,
// discard, restore, and pilot-token writes (#120) all lock the prospect
// before a proposal, so the manual do-not-contact route and the inbox
// opt-out use the same order and cannot deadlock with them.

let lockGate = null;

function _setLockGate(fn) {
  if (process.env.NODE_ENV !== 'test') {
    throw new Error('_setLockGate is only available when NODE_ENV=test');
  }
  lockGate = fn || null;
}

// between: tests pause after the prospect lock and before the proposal locks.
async function lockLeadForUpdate(db, prospectId, { between = false } = {}) {
  await db.query('SELECT id FROM prospects WHERE id = $1 FOR UPDATE', [prospectId]);
  if (between && lockGate) await lockGate(db, prospectId);
  await db.query(
    'SELECT id FROM proposals WHERE prospect_id = $1 ORDER BY id FOR UPDATE',
    [prospectId]
  );
}

// Deadlock (40P01) and serialization failure (40001) only. Three tries total.
const DEADLOCK_ATTEMPTS = 3;
const DEADLOCK_CODES = new Set(['40P01', '40001']);

function isDeadlock(err) {
  return !!(err && DEADLOCK_CODES.has(err.code));
}

module.exports = {
  lockLeadForUpdate,
  _setLockGate,
  isDeadlock,
  DEADLOCK_ATTEMPTS,
  DEADLOCK_CODES,
};
