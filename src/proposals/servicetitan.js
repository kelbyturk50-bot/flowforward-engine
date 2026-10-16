// Shared ServiceTitan fingerprints.
//
// research.js builds its tool signatures from these patterns and labels.
// The prospect cache writer (fsmDetectedFromResearch) reads the same labels.
// A new ServiceTitan pattern belongs here, not copied into either caller.
// This module does not fetch.

const SERVICETITAN_RE = /servicetitan/i;
// scheduler.servicetitan is already covered by SERVICETITAN_RE. st-scheduler
// is the token that the broader pattern does not match.
const SERVICETITAN_SCHEDULER_RE = /scheduler\.servicetitan|st-scheduler/i;

const ST_FSM_LABEL = 'ServiceTitan';
const ST_SCHEDULER_LABEL = 'ServiceTitan scheduler';

function htmlHasServiceTitan(html) {
  const text = String(html || '');
  return SERVICETITAN_RE.test(text) || SERVICETITAN_SCHEDULER_RE.test(text);
}

function signalsHaveServiceTitan(signals) {
  const fsm = Array.isArray(signals?.field_service_software) ? signals.field_service_software : [];
  const booking = Array.isArray(signals?.online_booking) ? signals.online_booking : [];
  return fsm.includes(ST_FSM_LABEL) || booking.includes(ST_SCHEDULER_LABEL);
}

// Value for prospects.fsm_detected.
// null  — research payload has no site object; leave the cache alone.
// 'ServiceTitan' | 'Housecall Pro' | 'Jobber' | other fingerprint | 'none'
function fsmDetectedFromResearch(research) {
  if (!research || research.site == null || typeof research.site !== 'object') return null;
  const signals = research.site.signals || {};
  if (signalsHaveServiceTitan(signals)) return ST_FSM_LABEL;
  const fsm = Array.isArray(signals.field_service_software) ? signals.field_service_software : [];
  if (fsm.includes('Housecall Pro')) return 'Housecall Pro';
  if (fsm.includes('Jobber')) return 'Jobber';
  if (fsm.length) return String(fsm[0]);
  return 'none';
}

module.exports = {
  SERVICETITAN_RE,
  SERVICETITAN_SCHEDULER_RE,
  ST_FSM_LABEL,
  ST_SCHEDULER_LABEL,
  htmlHasServiceTitan,
  signalsHaveServiceTitan,
  fsmDetectedFromResearch,
};
