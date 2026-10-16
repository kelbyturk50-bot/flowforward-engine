// Pilot #1 feature flags. Evaluation goes through the database resolver.
// Seeded rows are off. Env is a kill switch only: a trimmed, case-insensitive
// "false" forces the flag off. Any other value, or an unset variable, uses
// the database row. Env never forces a flag on. A missing row or a database
// error is off. Reads are not cached.

const { effective } = require('../flags/resolve');

const FF_PILOT_ESTIMATE_RECOVERY = 'FF_PILOT_ESTIMATE_RECOVERY';
const FF_PILOT_LINK_ON_ONEPAGER = 'FF_PILOT_LINK_ON_ONEPAGER';
const FF_PILOT_ESTIMATE_SMS = 'FF_PILOT_ESTIMATE_SMS';

const NAMES = Object.freeze([
  FF_PILOT_ESTIMATE_RECOVERY,
  FF_PILOT_LINK_ON_ONEPAGER,
  FF_PILOT_ESTIMATE_SMS,
]);

async function isOn(name) {
  const view = await effective(name);
  return view.effective === true;
}

async function flags() {
  const out = {};
  for (const name of NAMES) out[name] = await isOn(name);
  return out;
}

function masterOn() { return isOn(FF_PILOT_ESTIMATE_RECOVERY); }
function linkOn() { return isOn(FF_PILOT_LINK_ON_ONEPAGER); }
function smsOn() { return isOn(FF_PILOT_ESTIMATE_SMS); }

module.exports = {
  FF_PILOT_ESTIMATE_RECOVERY,
  FF_PILOT_LINK_ON_ONEPAGER,
  FF_PILOT_ESTIMATE_SMS,
  NAMES,
  isOn,
  flags,
  masterOn,
  linkOn,
  smsOn,
};
