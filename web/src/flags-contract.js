// Feature-flag HTTP shape for the CRM.
//
// Issue #63 describes GET /api/flags and PUT /api/flags/:name, a
// feature_flags row (name, enabled, updated_at, updated_by), and an env
// kill switch the panel must show. It does not publish a JSON body.
// No Canyon PR or doc adds one. This module is the only place that spells
// the path and the body the client will send and accept. Change it here
// when the contract lands.

export const FEATURE_FLAGS_API = Object.freeze({
  list: '/api/flags',
  update(name) {
    return `/api/flags/${encodeURIComponent(name)}`;
  },
  body(enabled) {
    return { enabled: enabled === true };
  },
});

// Flags the Settings panel lists. Live sending stays env-only (issue #63)
// and FF_HIDE_WATERMARK is not a flag. Neither is listed or toggleable.
export const FEATURE_FLAG_CATALOG = Object.freeze([
  Object.freeze({ name: 'FF_PILOT_ESTIMATE_RECOVERY', label: 'Unsold-estimate recovery demo' }),
  Object.freeze({ name: 'FF_PILOT_LINK_ON_ONEPAGER', label: 'Recovery link on the one-pager' }),
  Object.freeze({ name: 'FF_PILOT_ESTIMATE_SMS', label: 'Estimate recovery SMS' }),
  Object.freeze({ name: 'FF_PROTOTYPE_GALLERY', label: 'Prototype gallery' }),
  Object.freeze({ name: 'FF_CAMPAIGNS', label: 'Campaigns' }),
  Object.freeze({ name: 'FF_CAMPAIGN_OPEN_PIXEL', label: 'Campaign open pixel' }),
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

export function parseFlagRecord(data) {
  if (!data || typeof data !== 'object' || typeof data.name !== 'string' || data.name === '') {
    throw fail('Feature flag response was missing a name.');
  }
  const envForcedOff = data.env_forced_off === true;
  return {
    name: data.name,
    enabled: data.enabled === true && !envForcedOff,
    updated_at: typeof data.updated_at === 'string' && data.updated_at ? data.updated_at : null,
    updated_by: typeof data.updated_by === 'string' && data.updated_by.trim() ? data.updated_by.trim() : null,
    env_forced_off: envForcedOff,
  };
}

// GET /api/flags → { flags: Flag[] }. Anything else fails closed.
// Flag = { name, enabled, updated_at, updated_by, env_forced_off }.
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

function blankRow(name) {
  return {
    name,
    label: flagLabel(name),
    enabled: false,
    updated_at: null,
    updated_by: null,
    env_forced_off: false,
  };
}

// Catalog order first, then any other DB flag the server returned.
// Missing catalog flags stay off. Hidden flags are dropped.
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
        updated_at: typeof row.updated_at === 'string' && row.updated_at ? row.updated_at : null,
        updated_by: typeof row.updated_by === 'string' && row.updated_by.trim() ? row.updated_by.trim() : null,
        env_forced_off: envForcedOff,
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
