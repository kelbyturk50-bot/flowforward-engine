// Campaigns feature flag, read through the #63 flag service (src/flags).
// FF_CAMPAIGNS is a feature_flags row, seeded off and turned on from the CRM
// (PUT /api/flags/FF_CAMPAIGNS). The env var can only force it off (trimmed,
// case-insensitive false, off, 0, or no); env "true" does not turn it on.
// A missing row or a database read error is off. Not cached.

const { effective } = require('../flags/resolve');

async function isFlagOn(name) {
  const view = await effective(name);
  return view.effective === true;
}

module.exports = { isFlagOn };
