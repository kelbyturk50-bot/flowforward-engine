// Pilot #1 feature flags. Every flag is OFF unless the env var is exactly
// the string "true". "1", "TRUE", "yes", and an empty value stay off.
// Do not cache these: tests and a process restart must see the current env.

const FF_PILOT_ESTIMATE_RECOVERY = 'FF_PILOT_ESTIMATE_RECOVERY';
const FF_PILOT_LINK_ON_ONEPAGER = 'FF_PILOT_LINK_ON_ONEPAGER';
const FF_PILOT_ESTIMATE_SMS = 'FF_PILOT_ESTIMATE_SMS';

const NAMES = Object.freeze([
  FF_PILOT_ESTIMATE_RECOVERY,
  FF_PILOT_LINK_ON_ONEPAGER,
  FF_PILOT_ESTIMATE_SMS,
]);

function isOn(name) {
  return process.env[name] === 'true';
}

function flags() {
  return {
    [FF_PILOT_ESTIMATE_RECOVERY]: isOn(FF_PILOT_ESTIMATE_RECOVERY),
    [FF_PILOT_LINK_ON_ONEPAGER]: isOn(FF_PILOT_LINK_ON_ONEPAGER),
    [FF_PILOT_ESTIMATE_SMS]: isOn(FF_PILOT_ESTIMATE_SMS),
  };
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
