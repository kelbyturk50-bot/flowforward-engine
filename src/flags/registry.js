// Frozen allow-list of server feature flags. Unknown names are rejected
// by the API. FF_PILOT_ESTIMATE_LIVE_SEND stays env-only (kill switch file)
// and is not in this list. FF_HIDE_WATERMARK is test-only and is not listed.
// Keep this list in sync with the seed in src/db/schema.sql.

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

module.exports = {
  NAMES,
  isKnown,
};
