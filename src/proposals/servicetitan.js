// Shared ServiceTitan fingerprints.
//
// research.js builds its tool signatures from these patterns and labels.
// The prospect cache writer (fsmDetectedFromResearch) reads the same labels.
// A new ServiceTitan pattern belongs here, not copied into either caller.
// This module does not fetch.

const SERVICETITAN_RE = /servicetitan/i;
// scheduler.servicetitan is a host token. st-scheduler is a standalone
// class, id, or file token. The character before st-scheduler must be a
// boundary, so list-scheduler, best-scheduler, first-scheduler, and
// last-scheduler do not match (each contains "st-scheduler" as a suffix).
const SERVICETITAN_SCHEDULER_RE = /(?:^|[^a-z0-9.])scheduler\.servicetitan(?![a-z0-9])|(?:^|[^a-z0-9-])st-scheduler(?![a-z0-9-])/i;

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

// A crawl that actually read HTML. An error, a social/directory page, a missing
// site, or a homepage that never came back is unknown: the caller must not
// overwrite a cached fingerprint. crawlSite still returns a site object in
// those cases, with reachable false and pages empty.
function crawlUsable(site) {
  if (!site || typeof site !== 'object') return false;
  if (site.error) return false;
  if (site.reachable !== true) return false;
  return Array.isArray(site.pages) && site.pages.length > 0;
}

// Value for prospects.fsm_detected.
// null — unknown (failed crawl, no usable HTML, or no site object). Leave the cache.
// 'ServiceTitan' | 'Housecall Pro' | 'Jobber' | other fingerprint | 'none'
// 'none' is written only after a successful crawl that saw no field-service tool.
function fsmDetectedFromResearch(research) {
  const site = research?.site;
  if (!crawlUsable(site)) return null;
  const signals = site.signals || {};
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
