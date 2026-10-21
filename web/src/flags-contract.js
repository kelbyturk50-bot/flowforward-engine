// Feature-flag HTTP shape for the CRM. Server side: PR #70
// (src/api/flags.js, src/flags/resolve.js).
//
// GET  /api/flags        -> 200 { flags: Flag[] }
// PUT  /api/flags/:name  { enabled: <boolean> } -> 200 { flag: Flag }
// Flag = { name, enabled, effective, env_forced_off, updated_at, updated_by,
//          writable, source: 'db' | 'env' }
// `effective` is what is actually on. `enabled` is the stored row value.
// `env_forced_off` means a server env var is forcing the flag off.
// `writable: false` (source 'env') flags are set only by the server env.
// This module is the only place that spells the path and the body.

export const FEATURE_FLAGS_API = Object.freeze({
  list: '/api/flags',
  update(name) {
    return `/api/flags/${encodeURIComponent(name)}`;
  },
  body(enabled) {
    return { enabled: enabled === true };
  },
});

// Flags the Settings panel lists, in the server's registry order. Live
// sending stays env-only (issue #63) and FF_HIDE_WATERMARK is not a flag.
// Neither is listed or toggleable.
export const FEATURE_FLAG_CATALOG = Object.freeze([
  Object.freeze({ name: 'FF_PILOT_ESTIMATE_RECOVERY', label: 'Unsold-estimate recovery demo' }),
  Object.freeze({ name: 'FF_PILOT_LINK_ON_ONEPAGER', label: 'Recovery link on the one-pager' }),
  Object.freeze({ name: 'FF_PILOT_ESTIMATE_SMS', label: 'Estimate recovery SMS' }),
  Object.freeze({ name: 'FF_PROTOTYPE_GALLERY', label: 'Prototype gallery' }),
  Object.freeze({ name: 'FF_CAMPAIGNS', label: 'Campaigns' }),
  Object.freeze({ name: 'FF_CAMPAIGN_OPEN_PIXEL', label: 'Campaign open pixel' }),
  Object.freeze({ name: 'FF_PROTOTYPE_ON_DRAFT', label: 'Branded prototype on new proposal drafts' }),
]);

export const FEATURE_FLAG_NAMES = Object.freeze(FEATURE_FLAG_CATALOG.map((flag) => flag.name));

export const HIDDEN_FLAG_NAMES = Object.freeze([
  'FF_PILOT_ESTIMATE_LIVE_SEND',
  'FF_HIDE_WATERMARK',
]);

const LABEL_BY_NAME = new Map(FEATURE_FLAG_CATALOG.map((flag) => [flag.name, flag.label]));

export function isHiddenFlag(name) {
  return HIDDEN_FLAG_NAMES.includes(name);
}

export function isCatalogFlag(name) {
  return LABEL_BY_NAME.has(name);
}

export function flagLabel(name) {
  return LABEL_BY_NAME.get(name) || name;
}

function fail(message) {
  const error = new Error(message);
  error.status = 0;
  return error;
}

function stampText(value) {
  return typeof value === 'string' && value ? value : null;
}

function actorText(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

// One Flag from the server. `enabled` here is what the CRM shows and uses:
// the server's `effective` value (falling back to the stored `enabled` only
// when `effective` is missing), and always off when env forces it off.
// Only a JSON boolean true counts. `writable` must be exactly true.
export function parseFlagRecord(data) {
  if (!data || typeof data !== 'object' || typeof data.name !== 'string' || data.name === '') {
    throw fail('Feature flag response was missing a name.');
  }
  const envForcedOff = data.env_forced_off === true;
  const on = typeof data.effective === 'boolean' ? data.effective : data.enabled === true;
  return {
    name: data.name,
    enabled: on === true && !envForcedOff,
    updated_at: stampText(data.updated_at),
    updated_by: actorText(data.updated_by),
    env_forced_off: envForcedOff,
    writable: data.writable === true,
    source: data.source === 'env' ? 'env' : 'db',
  };
}

// PUT /api/flags/:name -> { flag: Flag }. Anything else fails closed.
export function parseFlagUpdate(data) {
  if (!data || typeof data !== 'object' || !data.flag || typeof data.flag !== 'object') {
    throw fail('Feature flag update response was missing the flag.');
  }
  return parseFlagRecord(data.flag);
}

// GET /api/flags -> { flags: Flag[] }. Anything else fails closed.
export function parseFlagsPayload(data) {
  if (!data || typeof data !== 'object' || !Array.isArray(data.flags)) {
    throw fail('Feature flags response was not a list.');
  }
  const rows = [];
  for (const row of data.flags) {
    if (!row || typeof row !== 'object' || typeof row.name !== 'string' || row.name === '') continue;
    if (isHiddenFlag(row.name)) continue;
    rows.push(parseFlagRecord(row));
  }
  return rows;
}

// A catalog flag the server did not return: off and not toggleable.
function blankRow(name) {
  return {
    name,
    label: flagLabel(name),
    enabled: false,
    updated_at: null,
    updated_by: null,
    env_forced_off: false,
    writable: false,
    source: 'db',
  };
}

// Catalog order first, then any other flag the server returned.
// Records are already parsed (parseFlagRecord). Missing catalog flags stay
// off and locked. Hidden flags are dropped.
export function panelFlagsFromRecords(records) {
  const byName = new Map();
  if (Array.isArray(records)) {
    for (const row of records) {
      if (!row || typeof row.name !== 'string' || row.name === '' || isHiddenFlag(row.name)) continue;
      const envForcedOff = row.env_forced_off === true;
      byName.set(row.name, {
        name: row.name,
        label: flagLabel(row.name),
        enabled: row.enabled === true && !envForcedOff,
        updated_at: stampText(row.updated_at),
        updated_by: actorText(row.updated_by),
        env_forced_off: envForcedOff,
        writable: row.writable === true,
        source: row.source === 'env' ? 'env' : 'db',
      });
    }
  }
  const rows = FEATURE_FLAG_CATALOG.map((flag) => byName.get(flag.name) || blankRow(flag.name));
  for (const [name, row] of byName) {
    if (!isCatalogFlag(name)) rows.push(row);
  }
  return rows;
}

export function closedPanelFlags() {
  return FEATURE_FLAG_CATALOG.map((flag) => blankRow(flag.name));
}
