// Frozen allow-list of server feature flags.
//
// Database flags are seeded off and can be changed with PUT. The one
// exception is FF_PROTOTYPE_ON_DRAFT, seeded on (Kelby, Oct 20); see DEFAULT_ON.
// SMS and the campaign open pixel are listed on GET but are env-only:
// effective is on only when the env var is exactly "true". They are not
// seeded. FF_PILOT_ESTIMATE_LIVE_SEND stays out of this list (kill-switch
// file). FF_HIDE_WATERMARK is test-only and is not listed.
// DB_NAMES and DEFAULT_ON must match the seed in src/db/schema.sql.

const DB_NAMES = Object.freeze([
  'FF_PILOT_ESTIMATE_RECOVERY',
  'FF_PILOT_LINK_ON_ONEPAGER',
  'FF_PROTOTYPE_GALLERY',
  'FF_CAMPAIGNS',
  'FF_PROTOTYPE_ON_DRAFT',
]);

// Database flags whose seed row is enabled. Every other DB flag seeds off.
const DEFAULT_ON = Object.freeze([
  'FF_PROTOTYPE_ON_DRAFT',
]);

const ENV_NAMES = Object.freeze([
  'FF_PILOT_ESTIMATE_SMS',
  'FF_CAMPAIGN_OPEN_PIXEL',
]);

const NAMES = Object.freeze([
  'FF_PILOT_ESTIMATE_RECOVERY',
  'FF_PILOT_LINK_ON_ONEPAGER',
  'FF_PILOT_ESTIMATE_SMS',
  'FF_PROTOTYPE_GALLERY',
  'FF_CAMPAIGNS',
  'FF_CAMPAIGN_OPEN_PIXEL',
  'FF_PROTOTYPE_ON_DRAFT',
]);

function isKnown(name) {
  return typeof name === 'string' && NAMES.includes(name);
}

function isWritable(name) {
  return typeof name === 'string' && DB_NAMES.includes(name);
}

function isEnvOnly(name) {
  return typeof name === 'string' && ENV_NAMES.includes(name);
}

module.exports = {
  DB_NAMES,
  DEFAULT_ON,
  ENV_NAMES,
  NAMES,
  isKnown,
  isWritable,
  isEnvOnly,
};
