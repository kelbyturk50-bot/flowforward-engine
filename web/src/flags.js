// Pilot flags for the unsold-estimate recovery demo.
//
// Build-time defaults are off. There is no env var that turns them on.
// A `?flags=a,b` override is honored only on a Vercel preview hostname, or on
// localhost while `import.meta.env.DEV` is true. Every other origin, including
// the production CRM hosts, keeps the defaults.
//
// Production hosts are rejected before the preview regex. That regex also
// matches `flowforward-engine-git-main-turk11.vercel.app`, which is production.

import { PRODUCTION_HOSTS } from './api-base.js';

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

export function flagEnabled(name, options) {
  return readPilotFlags(options)[name] === true;
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
