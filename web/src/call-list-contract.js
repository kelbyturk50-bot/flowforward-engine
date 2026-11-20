// F-010 names Canyon can still change. api.js re-exports these, and the test
// mock re-exports the same file, so the strings live in one place.

// Button order. The last entry is the separated caution action.
export const CALL_OUTCOMES = Object.freeze([
  'no_answer',
  'voicemail',
  'talked',
  'audit_booked',
  'not_interested',
  'do_not_contact',
]);

export const CALL_LIST_KIND_FIELD = 'call_list_kind';
export const CALL_LIST_SET_AT_FIELD = 'call_list_set_at';
