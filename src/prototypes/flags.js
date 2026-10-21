// Gates the draftProposal prototype hook.
// On by default (Kelby, Oct 20): the feature_flags row is seeded true and can
// be turned off from the CRM (PUT /api/flags/FF_PROTOTYPE_ON_DRAFT). Setting
// the FF_PROTOTYPE_ON_DRAFT env var to false, off, 0, or no (trimmed, any
// case) still forces it off. Env never forces it on. A missing row or a
// database read error is off, so the hook does nothing.
// Existing links keep working until they expire or are revoked.

const { effective } = require('../flags/resolve');

const FLAG = 'FF_PROTOTYPE_ON_DRAFT';

async function prototypeOnDraft() {
  const view = await effective(FLAG);
  return view.effective === true;
}

module.exports = { FLAG, prototypeOnDraft };
