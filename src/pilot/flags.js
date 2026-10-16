// Pilot #1 feature flags. Reads are not cached.
// Recovery and the one-pager link are database flags, seeded off. A trimmed
// case-insensitive "false", "off", "0", or "no" forces the flag off. An empty
// string or an unset variable uses the row. Env never forces those flags on.
// SMS is env-only: on only when FF_PILOT_ESTIMATE_SMS is exactly "true".

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
