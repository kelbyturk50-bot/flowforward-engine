// Gates the draftProposal prototype hook.
// Off unless FF_PROTOTYPE_ON_DRAFT is exactly "true".
// Issue #63, when it lands, should seed this flag off in a registry.
// Until that registry exists, this reads the environment only.

const FLAG = 'FF_PROTOTYPE_ON_DRAFT';

function prototypeOnDraft() {
  return process.env[FLAG] === 'true';
}

module.exports = { FLAG, prototypeOnDraft };
