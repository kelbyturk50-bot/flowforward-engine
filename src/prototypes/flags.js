// Gates the draftProposal prototype hook and the prototype page.
// On by default (Kelby, Oct 20). Set FF_PROTOTYPE_ON_DRAFT to false, off,
// 0, or no (trimmed, any case) to stop new prototypes on draft.
// Existing links keep working until they expire or are revoked.

const FLAG = 'FF_PROTOTYPE_ON_DRAFT';
const OFF = new Set(['false', 'off', '0', 'no']);

function prototypeOnDraft() {
  const raw = process.env[FLAG];
  if (raw == null) return true;
  return !OFF.has(String(raw).trim().toLowerCase());
}

module.exports = { FLAG, prototypeOnDraft };
