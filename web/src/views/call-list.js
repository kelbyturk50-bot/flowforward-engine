import { CALL_LIST_KIND_FIELD, CALL_LIST_SET_AT_FIELD, CALL_OUTCOMES } from '../api';

export const UNDO_MS = 8000;

// Display labels stay in this order beside CALL_OUTCOMES. The strings Kelby
// taps are not the API values; those stay in api.js.
const CALL_OUTCOME_LABEL_TEXT = Object.freeze([
  'No answer',
  'Voicemail',
  'Talked',
  'Audit booked',
  'Not interested',
  'Do not contact',
]);

export const CALL_OUTCOME_LABELS = Object.freeze(
  Object.fromEntries(CALL_OUTCOMES.map((outcome, index) => [outcome, CALL_OUTCOME_LABEL_TEXT[index]])),
);

export const EMPTY_CALL_LIST = 'No calls due today. Add leads from a lead\'s drawer.';

const MARKER_KINDS = new Set(['call', 'walk_in', 'excluded']);
const TEL = /^tel:\+?[0-9*#]+$/i;

// Scout, 20 Nov 2026 (issue #144): with the call list on, it is the only call
// surface on Today. Call next and the #131 task panel are not rendered.
// Change this function if that decision changes.
export function callListIsOnlySurface(enabled) {
  return enabled === true;
}

export function readCallListKind(lead) {
  if (!lead || typeof lead !== 'object' || !Object.prototype.hasOwnProperty.call(lead, CALL_LIST_KIND_FIELD)) {
    return { present: false, kind: null };
  }
  const value = lead[CALL_LIST_KIND_FIELD];
  if (MARKER_KINDS.has(value)) return { present: true, kind: value };
  return { present: true, kind: null };
}

export function kindFromMarkerResponse(result, fallback) {
  if (result && typeof result === 'object' && Object.prototype.hasOwnProperty.call(result, CALL_LIST_KIND_FIELD)) {
    const value = result[CALL_LIST_KIND_FIELD];
    if (MARKER_KINDS.has(value) || value === null) return value;
  }
  return fallback;
}

export function applyMarkerResponse(lead, result, fallbackKind) {
  const next = { ...lead, [CALL_LIST_KIND_FIELD]: kindFromMarkerResponse(result, fallbackKind) };
  if (result && typeof result === 'object' && Object.prototype.hasOwnProperty.call(result, CALL_LIST_SET_AT_FIELD)) {
    next[CALL_LIST_SET_AT_FIELD] = result[CALL_LIST_SET_AT_FIELD];
  }
  return next;
}

export function callListErrorMessage(error) {
  const status = error?.status;
  const code = typeof error?.message === 'string' ? error.message : '';
  if (status === 409 && code === 'do_not_contact') return 'This lead is on do-not-contact';
  if (status === 409 && code === 'archived') return 'This lead is archived';
  if (status === 400 && code === 'invalid_kind') return 'Pick a call or a walk-in.';
  if (status === 400 && code === 'invalid_outcome') return 'That outcome isn\'t available.';
  if (status === 404) return 'Call list isn\'t available.';
  return code || 'Something went wrong.';
}

export function moreCount(value) {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : 0;
}

export function safeTel(item) {
  const given = typeof item?.tel === 'string' ? item.tel.trim() : '';
  if (TEL.test(given)) return given;
  const phone = typeof item?.phone === 'string' ? item.phone : '';
  const digits = phone.replace(/[^\d+*#]/g, '');
  if (!TEL.test(`tel:${digits}`)) return null;
  return `tel:${digits}`;
}

export function safeMaps(item) {
  const given = typeof item?.maps_url === 'string' ? item.maps_url.trim() : '';
  if (given) {
    try {
      const url = new URL(given);
      if (url.protocol === 'https:' && url.username === '' && url.password === '') return given;
    } catch {
      /* fall through to a maps search built from the address */
    }
  }
  const parts = [item?.company, item?.address, item?.city].filter((part) => typeof part === 'string' && part.trim());
  if (!parts.length) return null;
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(parts.join(' '))}`;
}

export function backOnLabel(value) {
  if (value == null || value === '') return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(value).trim());
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const date = new Date(Date.UTC(year, month - 1, day, 12));
  const formatted = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Denver',
    month: 'short',
    day: 'numeric',
  }).format(date);
  return `Back on ${formatted}`;
}

export function rowAsk(item) {
  return typeof item?.ask === 'string' && item.ask.trim() ? item.ask.trim() : '';
}

export function rowVoicemail(item) {
  if (item?.kind !== 'call') return '';
  return typeof item?.voicemail_script === 'string' && item.voicemail_script.trim()
    ? item.voicemail_script.trim()
    : '';
}

export function rowScript(item) {
  return typeof item?.script === 'string' ? item.script.trim() : '';
}
