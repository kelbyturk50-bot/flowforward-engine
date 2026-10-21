// Feature-flag records as api.flags() / api.setFlag() resolve them, after
// parseFlagsPayload / parseFlagUpdate. Mirrors the server registry from
// PR #70: SMS and the open pixel are env-only (read-only in the CRM), and
// FF_PROTOTYPE_ON_DRAFT is the one database flag seeded on.
import { FEATURE_FLAG_CATALOG } from '../flags-contract.js';

export const ENV_ONLY_FLAGS = Object.freeze(['FF_PILOT_ESTIMATE_SMS', 'FF_CAMPAIGN_OPEN_PIXEL']);
export const DEFAULT_ON_FLAGS = Object.freeze(['FF_PROTOTYPE_ON_DRAFT']);

export function flagRecords(overrides = {}, { seeded = false } = {}) {
  return FEATURE_FLAG_CATALOG.map(({ name }) => {
    const envOnly = ENV_ONLY_FLAGS.includes(name);
    return {
      name,
      enabled: seeded && DEFAULT_ON_FLAGS.includes(name),
      updated_at: null,
      updated_by: null,
      env_forced_off: false,
      writable: !envOnly,
      source: envOnly ? 'env' : 'db',
      ...(overrides[name] || {}),
    };
  });
}

export function savedFlag(name, enabled, extra = {}) {
  return {
    name,
    enabled: enabled === true,
    updated_at: '2026-10-16T18:00:00.000Z',
    updated_by: 'crm',
    env_forced_off: false,
    writable: true,
    source: 'db',
    ...extra,
  };
}
