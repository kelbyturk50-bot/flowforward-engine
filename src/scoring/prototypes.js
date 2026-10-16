// Cache-only prototype picker. Spec: docs/PROTOTYPE_PLAY.md.
//
// pickPrototypes(prospect) ranks agents from the prospect row plus
// prospects.research. It does not fetch, resolve DNS, write, or call
// computeFit. An unknown signal adds 0. A missing research blob is not a
// penalty and does not throw.
//
// Signals follow Scout's catalog. Array gaps (no booking widget, no chat,
// no review tool, no FSM) count only when mentions is present, which is
// what a finished research cache always writes. A missing mentions object
// leaves those gaps unknown.

const cfg = require('./config');
const { RUBRIC } = require('./prototypes.config');
const { isExcludedIndustry, normalizeIndustry } = require('./industry');
const { signalsHaveServiceTitan } = require('../proposals/servicetitan');

const RV_MISSED = /no answer|voicemail|couldn'?t reach|never (called|call) back|didn'?t call back/i;
const RV_SLOW = /never (got|received) (a|the|my) (quote|estimate)|slow (to )?quote|never followed up|no follow[- ]?up/i;
const RV_SCHED = /no[- ]show|hard to schedule|reschedul|showed up late|never showed/i;

const JOBBER_HCP = new Set(['jobber', 'housecall pro']);

function asObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value;
}

function signalsOf(research) {
  if (!research) return null;
  const top = asObject(research.signals);
  if (top) return top;
  const site = asObject(research.site);
  if (site) return asObject(site.signals);
  return null;
}

function mention(signals, key) {
  const mentions = signals && asObject(signals.mentions);
  if (!mentions || !Object.hasOwn(mentions, key)) return null;
  return mentions[key] === true;
}

// null = unknown. [] = looked, and the tool group was absent.
function knownList(signals, key) {
  const mentions = signals && asObject(signals.mentions);
  if (!mentions) return null;
  const value = signals[key];
  if (value == null) return [];
  if (!Array.isArray(value)) return null;
  return value;
}

function reviewTexts(research) {
  if (!research) return [];
  let list = [];
  if (Array.isArray(research.reviews)) list = research.reviews;
  else if (Array.isArray(research.google?.reviews)) list = research.google.reviews;
  return list.slice(0, 5).map(review => String(review && review.text || ''));
}

function hoursOf(research) {
  if (!research) return null;
  const place = asObject(research.place);
  if (place && place.hours != null) return place.hours;
  const google = asObject(research.google);
  if (google && google.hours != null) return google.hours;
  return null;
}

// true when every parsed open day closes at or before 18:00.
// null when hours are missing or not a list we can read. false when any
// day runs past 18:00 or the shop says it is open 24 hours.
function hoursClosedEvenings(hours) {
  if (!Array.isArray(hours) || hours.length === 0) return null;
  let sawOpenDay = false;
  for (const line of hours) {
    if (typeof line !== 'string') return null;
    if (/24\s*hours/i.test(line)) return false;
    const times = [];
    const re = /(\d{1,2})(?::(\d{2}))?\s*(AM|PM)/gi;
    let match;
    while ((match = re.exec(line))) {
      let hour = Number(match[1]);
      const minute = match[2] ? Number(match[2]) : 0;
      if (hour === 12) hour = 0;
      if (match[3].toUpperCase() === 'PM') hour += 12;
      times.push(hour * 60 + minute);
    }
    if (times.length === 0) {
      if (/closed/i.test(line)) continue;
      return null;
    }
    sawOpenDay = true;
    if (times[times.length - 1] > 18 * 60) return false;
  }
  return sawOpenDay ? true : null;
}

function hostOf(website) {
  if (typeof website !== 'string') return '';
  try {
    const raw = website.trim();
    if (!raw) return '';
    const withScheme = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
    return new URL(withScheme).hostname.replace(/^www\./, '').toLowerCase();
  } catch {
    return '';
  }
}

function hasRealSite(website) {
  const host = hostOf(website);
  if (!host) return false;
  return !cfg.SOCIAL_HOSTS.some(item => host === item || host.endsWith('.' + item));
}

function numberOrNull(value) {
  if (value == null || value === '') return null;
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

function isHvac(prospect) {
  return normalizeIndustry(prospect.industry).toLowerCase() === 'hvac';
}

function isFranchise(company) {
  const name = String(company || '').toLowerCase();
  if (!name) return false;
  return cfg.FRANCHISE_PATTERNS.some(pattern => name.includes(pattern));
}

function outOfState(prospect) {
  const state = String(prospect.state || '').trim().toUpperCase();
  if (!state) return false;
  return state !== String(cfg.HOME_STATE || 'UT').toUpperCase();
}

function fsmInfo(prospect, signals) {
  const raw = prospect.fsm_detected;
  if (raw != null && String(raw).trim()) {
    return { known: true, value: String(raw).trim() };
  }
  const mentions = signals && asObject(signals.mentions);
  const list = signals && signals.field_service_software;
  if (Array.isArray(list) && list.length) return { known: true, value: String(list[0]) };
  if (mentions) return { known: true, value: 'none' };
  return { known: false, value: null };
}

function isJobberOrHcp(value, signals) {
  if (value && JOBBER_HCP.has(String(value).toLowerCase())) return true;
  const list = Array.isArray(signals?.field_service_software) ? signals.field_service_software : [];
  return list.some(name => JOBBER_HCP.has(String(name).toLowerCase()));
}

function isServiceTitan(value, signals) {
  if (String(value || '').trim().toLowerCase() === 'servicetitan') return true;
  return signalsHaveServiceTitan(signals);
}

function anyReview(texts, re) {
  return texts.some(text => re.test(text));
}

function deriveSignals(prospect) {
  const research = asObject(prospect.research);
  const signals = signalsOf(research);
  const texts = reviewTexts(research);
  const fsm = fsmInfo(prospect, signals);
  const widgets = knownList(signals, 'online_booking');
  const chat = knownList(signals, 'chat_or_text_widget');
  const reviewTools = knownList(signals, 'reviews_tools');
  const bookingLanguage = mention(signals, 'online_booking_language');
  const emergency = mention(signals, 'emergency_24_7');
  const evenings = hoursClosedEvenings(hoursOf(research));
  const serviceTitan = isServiceTitan(fsm.value, signals);
  const jobber = isJobberOrHcp(fsm.value, signals) && !serviceTitan;
  const fsmNone = fsm.known && String(fsm.value).toLowerCase() === 'none' && !jobber && !serviceTitan;
  const reviews = numberOrNull(prospect.review_count);
  const rating = numberOrNull(prospect.rating);
  const financingList = Array.isArray(signals?.financing) ? signals.financing : [];

  return {
    free_estimate: mention(signals, 'free_estimates') === true,
    financing: mention(signals, 'financing') === true || financingList.length > 0,
    maint_plan: mention(signals, 'maintenance_plan') === true,
    rv_missed_call: anyReview(texts, RV_MISSED),
    rv_slow_quote: anyReview(texts, RV_SLOW),
    rv_scheduling: anyReview(texts, RV_SCHED),
    no_booking: widgets !== null && bookingLanguage === false && widgets.length === 0,
    no_chat: chat !== null && chat.length === 0,
    no_review_tool: reviewTools !== null && reviewTools.length === 0,
    closed_after_hours: emergency === false || evenings === true,
    contact_form_only: hasRealSite(prospect.website)
      && widgets !== null && widgets.length === 0
      && chat !== null && chat.length === 0
      && fsmNone,
    fsm_jobber_hcp: jobber,
    fsm_none: fsmNone,
    small_good_rating: reviews !== null && rating !== null && reviews < 75 && rating >= 4.3,
    size_sweet: reviews !== null && reviews >= 25 && reviews <= 200,
    size_big: reviews !== null && reviews > 200,
    hvac: isHvac(prospect),
    serviceTitan,
  };
}

function emptyResult(disqualified) {
  return { picks: [], disqualified };
}

function recommendPrototypes(prospect, rubric = RUBRIC) {
  if (!prospect || typeof prospect !== 'object') return emptyResult('below_min');
  if (isExcludedIndustry(prospect.industry)) return emptyResult('pest');
  if (isFranchise(prospect.company)) return emptyResult('franchise');
  if (outOfState(prospect)) return emptyResult('out_of_state');

  const flags = deriveSignals(prospect);
  const gaps = new Set(rubric.gapSignals);
  const skip = new Set(rubric.neverAutoPick);
  let ranked = [];
  for (const [agent, spec] of Object.entries(rubric.agents)) {
    if (skip.has(agent)) continue;
    const reasons = [];
    let score = 0;
    for (const [signal, points] of Object.entries(spec.points)) {
      if (!flags[signal]) continue;
      score += points;
      reasons.push({ signal, points, gap: gaps.has(signal) });
    }
    reasons.sort((a, b) => a.signal.localeCompare(b.signal));
    score = Math.max(0, Math.min(100, score));
    ranked.push({ agent, score, tieRank: spec.tieRank, reasons });
  }

  if (flags.serviceTitan) {
    const allow = new Set(rubric.serviceTitanAllow);
    ranked = ranked.filter(row => allow.has(row.agent));
  }

  const picks = ranked
    .filter(row => row.score >= rubric.minScore)
    .sort((a, b) => b.score - a.score || a.tieRank - b.tieRank)
    .slice(0, rubric.maxPicks)
    .map(({ agent, score, reasons }) => ({ agent, score, reasons }));

  if (!picks.length) return emptyResult('below_min');
  return { picks, disqualified: null };
}

function pickPrototypes(prospect, rubric = RUBRIC) {
  return recommendPrototypes(prospect, rubric).picks;
}

module.exports = {
  pickPrototypes,
  recommendPrototypes,
  hoursClosedEvenings,
};
