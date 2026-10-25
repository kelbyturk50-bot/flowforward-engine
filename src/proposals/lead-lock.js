// One lock order for a lead and its proposals. Callers that update both
// take every proposal row first (id order), then the prospect row. The
// opposite order deadlocks with draft and mark-sent, which already lock a
// proposal before the prospect.

let lockGate = null;

function _setLockGate(fn) {
  if (process.env.NODE_ENV !== 'test') {
    throw new Error('_setLockGate is only available when NODE_ENV=test');
  }
  lockGate = fn || null;
}

// between: tests pause after the proposal locks and before the prospect lock.
async function lockLeadForUpdate(db, prospectId, { between = false } = {}) {
  await db.query(
    'SELECT id FROM proposals WHERE prospect_id = $1 ORDER BY id FOR UPDATE',
    [prospectId]
  );
  if (between && lockGate) await lockGate(db, prospectId);
  await db.query('SELECT id FROM prospects WHERE id = $1 FOR UPDATE', [prospectId]);
}

module.exports = { lockLeadForUpdate, _setLockGate };
