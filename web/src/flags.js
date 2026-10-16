// Pilot flags for the unsold-estimate recovery demo.
//
// Build-time defaults are off. There is no env var that turns them on.
// The running CRM reads flag state from GET /api/flags. A failed or unreadable
// response leaves every flag off.
// A `?flags=a,b` override is honored only on a Vercel preview hostname, or on
// localhost while `import.meta.env.DEV` is true. On those hosts it replaces
// the API values for this browser. Every other origin, including the
// production CRM hosts, ignores the query and the saved override.
//
// Production hosts are rejected before the preview regex. That regex also
// matches `flowforward-engine-git-main-turk11.vercel.app`, which is production.

import { PRODUCTION_HOSTS } from './api-base.js';
import { FEATURE_FLAG_NAMES, isCatalogFlag, isHiddenFlag } from './flags-contract.js';

export const FF_PILOT_ESTIMATE_RECOVERY = 'FF_PILOT_ESTIMATE_RECOVERY';
export const FF_PILOT_LINK_ON_ONEPAGER = 'FF_PILOT_LINK_ON_ONEPAGER';
export const FF_PILOT_ESTIMATE_SMS = 'FF_PILOT_ESTIMATE_SMS';
export const FF_PROTOTYPE_GALLERY = 'FF_PROTOTYPE_GALLERY';

export const PILOT_FLAG_NAMES = Object.freeze([
  FF_PILOT_ESTIMATE_RECOVERY,
  FF_PILOT_LINK_ON_ONEPAGER,
  FF_PILOT_ESTIMATE_SMS,
  FF_PROTOTYPE_GALLERY,
]);

const DEFAULTS = Object.freeze({
  [FF_PILOT_ESTIMATE_RECOVERY]: false,
  [FF_PILOT_LINK_ON_ONEPAGER]: false,
  [FF_PILOT_ESTIMATE_SMS]: false,
  [FF_PROTOTYPE_GALLERY]: false,
});

// Fully anchored. An extra label, a suffix, or a prefix does not match.
export const PREVIEW_HOST_PATTERN = /^flowforward-engine-[a-z0-9-]+-turk11\.vercel\.app$/;

export const FLAG_STORAGE_KEY = 'ff.pilotFlags';

const COMPANY_MAX = 80;

function stripControls(value) {
  return Array.from(String(value ?? '')).filter((ch) => {
    const code = ch.codePointAt(0);
    return code > 0x1f && code !== 0x7f;
  }).join('');
}

function hostFields(loc) {
  return {
    protocol: String(loc?.protocol ?? ''),
    port: String(loc?.port ?? ''),
    hostname: String(loc?.hostname ?? ''),
  };
}

export function flagOverrideAllowed(loc, env = import.meta.env) {
  const { protocol, port, hostname } = hostFields(loc);

  for (const host of PRODUCTION_HOSTS) {
    if (host === hostname) return false;
  }

  if (env?.DEV && hostname === 'localhost') return true;

  if (protocol !== 'https:') return false;
  if (port !== '') return false;
  return PREVIEW_HOST_PATTERN.test(hostname);
}

function splitFlags(raw) {
  return String(raw ?? '').split(',').map(part => part.trim()).filter(Boolean);
}

function namedFlags(names) {
  const on = new Set(names.filter(name => Object.prototype.hasOwnProperty.call(DEFAULTS, name)));
  const flags = {};
  for (const name of PILOT_FLAG_NAMES) flags[name] = on.has(name);
  return flags;
}

function writeStored(storage, value) {
  if (!storage || typeof storage.setItem !== 'function') return;
  try { storage.setItem(FLAG_STORAGE_KEY, value); } catch { /* private mode or quota */ }
}

function readStored(storage) {
  if (!storage || typeof storage.getItem !== 'function') return '';
  try { return storage.getItem(FLAG_STORAGE_KEY) || ''; } catch { return ''; }
}

export function readPilotFlags({
  location = window.location,
  storage = window.sessionStorage,
  env = import.meta.env,
} = {}) {
  if (!flagOverrideAllowed(location, env)) return { ...DEFAULTS };

  const params = new URLSearchParams(location?.search || '');
  if (params.has('flags')) {
    const names = splitFlags(params.get('flags'));
    writeStored(storage, names.join(','));
    return namedFlags(names);
  }

  const saved = readStored(storage);
  if (!saved) return { ...DEFAULTS };
  return namedFlags(splitFlags(saved));
}

function namedFeatureFlags(names) {
  const on = new Set(names.filter((name) => isCatalogFlag(name)));
  const flags = {};
  for (const name of FEATURE_FLAG_NAMES) flags[name] = on.has(name);
  return flags;
}

// Preview-only override. Null means "no override": the API value stands.
// A present `flags` query, including an empty one, replaces the API values
// and is stored for later preview loads. An empty stored value does not.
export function previewFlagsOverride({
  location = window.location,
  storage = window.sessionStorage,
  env = import.meta.env,
} = {}) {
  if (!flagOverrideAllowed(location, env)) return null;

  const params = new URLSearchParams(location?.search || '');
  if (params.has('flags')) {
    const names = splitFlags(params.get('flags'));
    writeStored(storage, names.join(','));
    return namedFeatureFlags(names);
  }

  const saved = readStored(storage);
  if (!saved) return null;
  return namedFeatureFlags(splitFlags(saved));
}

// API snapshot. Idle and error both read as off (fail closed).
let remoteState = { status: 'idle', records: null, error: null };
let remoteGeneration = 0;
const remoteListeners = new Set();

export function getFeatureFlagState() {
  return remoteState;
}

export function subscribeFeatureFlags(listener) {
  remoteListeners.add(listener);
  return () => remoteListeners.delete(listener);
}

function emitFeatureFlags() {
  for (const listener of remoteListeners) listener();
}

export function currentFlagGeneration() {
  return remoteGeneration;
}

export function beginFlagLoad() {
  remoteGeneration += 1;
  remoteState = { status: 'loading', records: null, error: null };
  emitFeatureFlags();
  return remoteGeneration;
}

export function commitFlagLoad(ticket, records) {
  if (ticket !== remoteGeneration) return false;
  remoteState = { status: 'ready', records, error: null };
  emitFeatureFlags();
  return true;
}

export function failFlagLoad(ticket, error) {
  if (ticket !== remoteGeneration) return false;
  remoteState = { status: 'error', records: null, error };
  emitFeatureFlags();
  return true;
}

export function replaceRemoteFlag(record) {
  if (!record || typeof record.name !== 'string' || isHiddenFlag(record.name)) return;
  remoteGeneration += 1;
  const current = Array.isArray(remoteState.records) ? remoteState.records : [];
  const records = current.filter((row) => row?.name !== record.name);
  records.push(record);
  remoteState = { status: 'ready', records, error: null };
  emitFeatureFlags();
}

export function resetRemoteFlags() {
  remoteGeneration += 1;
  remoteState = { status: 'idle', records: null, error: null };
  emitFeatureFlags();
}

export function _setFeatureFlagsForTests(records) {
  remoteGeneration += 1;
  remoteState = { status: 'ready', records, error: null };
  emitFeatureFlags();
}

function remoteFlagOn(name) {
  if (remoteState.status !== 'ready' || !Array.isArray(remoteState.records)) return false;
  const row = remoteState.records.find((item) => item && item.name === name);
  if (!row || isHiddenFlag(name)) return false;
  return row.enabled === true && row.env_forced_off !== true;
}

export function flagEnabled(name, options) {
  if (typeof name !== 'string' || isHiddenFlag(name)) return false;
  const override = previewFlagsOverride(options);
  if (override) return override[name] === true;
  return remoteFlagOn(name);
}

export function readCompanyOverride({
  location = window.location,
  env = import.meta.env,
} = {}) {
  if (!flagOverrideAllowed(location, env)) return '';
  const params = new URLSearchParams(location?.search || '');
  if (!params.has('company')) return '';
  return stripControls(params.get('company')).trim().slice(0, COMPANY_MAX);
}
