// F-003 cache reader. Points and GTM rationale live in src/scoring/config.js
// (ESTIMATE_SIGNAL_POINTS). This module only decides whether each cached
// signal is present. It does not fetch. Points apply only to an HVAC lead.

const cfg = require('./config');
const { normalizeIndustry } = require('./industry');

const REPLACEMENT_RE = /\breplacements?\b/i;
const INSTALLATION_RE = /\binstallations?\b/i;
const FREE_ESTIMATE_RE = /\bfree\s+estimates?\b/i;
const FINANCING_RE = /\bfinancing\b/i;
const QUOTE_FORM_TEXT_RE = /\b(?:quote|contact)\s+forms?\b/i;
const FORM_PATH_RE = /\b(?:estimates?|quotes?|contact)\b/i;
const FOLLOW_UP_PROMISE_RE = /\b(?:we(?:'ll|’ll| will)\s+follow\s+up|follow[- ]up\s+(?:is\s+)?guaranteed|guaranteed\s+follow[- ]?up|we\s+promise\s+to\s+follow\s+up|we(?:'ll|’ll| will)\s+be\s+in\s+touch)\b/i;
// Comfort advisor, sales advisor, and the same HVAC sales roles. A title that
// only contains "comfort" or "sales" does not match.
const JOB_AD_RE = /\b(?:comfort|sales)\s+(?:advisors?|consultants?)\b|\bcomfort\s+sales\b|\bsales\s+comfort\b/i;
const SEARCH_ADS_RE = /\blocal\s+services\s+ads?\b|\bgoogle\s+ads\b|\bgoogle\s+local\s+services\b|\blsas?\b/i;
const SEARCH_ADS_LABEL_RE = /google ads|\blocal services\b|\blsas?\b/i;
// A negation in the words just before a phrase. "not only" is excluded by the
// lookahead. "no-cost" fails this shape because the hyphen is not a space.
const NEGATIVE_TAIL = /\b(?:do\s+not|does\s+not|did\s+not|is\s+not|are\s+not|was\s+not|were\s+not|will\s+not|cannot|don'?t|doesn'?t|didn'?t|isn'?t|aren'?t|wasn'?t|weren'?t|won'?t|can'?t|no|not|never|without)\b(?:\s+(?!only\b)[a-z0-9'’-]+){0,4}\s*$/i;

const REASONS = {
  replacement: {
    label: 'Replacement',
    detail: 'Cached research mentions replacement — unsold-estimate motion',
  },
  installation: {
    label: 'Installation',
    detail: 'Cached research mentions installation — new-equipment motion',
  },
  free_estimate: {
    label: 'Free estimate',
    detail: 'Cached research mentions a free estimate',
  },
  financing: {
    label: 'Financing',
    detail: 'Cached research mentions financing or a lender signature',
  },
  quote_form: {
    label: 'Quote form',
    detail: 'Cached quote or contact form, with no follow-up promise',
  },
  job_ad: {
    label: 'Job ad',
    detail: 'Cached job ad for a comfort advisor or sales advisor',
  },
  search_ads: {
    label: 'Search ads',
    detail: 'Cached Local Services Ads or search-ads evidence',
  },
};

function asObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value;
}

function namedList(value) {
  if (!Array.isArray(value)) return [];
  return value.map(item => String(item ?? '').trim()).filter(Boolean);
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function hvacWordRe() {
  const parts = (cfg.ESTIMATE_SIGNAL_HVAC_WORDS || []).map(escapeRegExp).filter(Boolean);
  if (!parts.length) return null;
  return new RegExp(`\\b(?:${parts.join('|')})\\b`, 'i');
}

function fieldText(value) {
  if (value == null) return '';
  if (Array.isArray(value)) return value.map(fieldText).filter(Boolean).join('\n');
  if (typeof value === 'object') return '';
  return String(value);
}

// Industry or category HVAC, or heating / cooling / HVAC / AC / furnace on a
// word boundary in the industry, category, or company name. Page text is not
// an identity field: a landscaper that mentions a furnace on its site is
// still a landscaper.
function isHvacLead(prospect) {
  const re = hvacWordRe();
  const chunks = [
    fieldText(prospect.industry),
    fieldText(prospect.category),
    fieldText(prospect.categories),
    fieldText(prospect.company),
  ];
  for (const chunk of chunks) {
    const trimmed = chunk.trim();
    if (!trimmed) continue;
    if (normalizeIndustry(trimmed).toLowerCase() === 'hvac') return true;
    if (re && re.test(trimmed)) return true;
  }
  return false;
}

function signalsOf(research) {
  const top = asObject(research.signals);
  const site = asObject(research.site);
  const nested = site && asObject(site.signals);
  if (!top) return nested;
  if (!nested) return top;
  const topMentions = asObject(top.mentions);
  const nestedMentions = asObject(nested.mentions);
  return {
    ...nested,
    ...top,
    mentions: { ...(nestedMentions || {}), ...(topMentions || {}) },
  };
}

function mentionTrue(signals, key) {
  const mentions = signals && asObject(signals.mentions);
  if (!mentions || !Object.hasOwn(mentions, key)) return false;
  return mentions[key] === true;
}

function pageList(research) {
  const site = asObject(research.site);
  return []
    .concat(Array.isArray(site && site.pages) ? site.pages : [])
    .concat(Array.isArray(research.pages) ? research.pages : []);
}

function cachedText(research) {
  const parts = [];
  for (const page of pageList(research)) {
    if (!page || typeof page !== 'object') continue;
    for (const key of ['title', 'description', 'text']) {
      if (typeof page[key] === 'string' && page[key]) parts.push(page[key]);
    }
  }
  const site = asObject(research.site);
  for (const value of [site && site.text, research.text, research.page_text]) {
    if (typeof value === 'string' && value) parts.push(value);
  }
  const google = asObject(research.google);
  if (google && typeof google.summary === 'string' && google.summary) parts.push(google.summary);
  return parts.join('\n');
}

function pathnameOf(url) {
  const raw = String(url || '').trim();
  if (!raw) return '';
  const noQuery = raw.split(/[?#]/)[0];
  const scheme = noQuery.indexOf('://');
  const rest = scheme === -1 ? noQuery : noQuery.slice(scheme + 3);
  const slash = rest.indexOf('/');
  if (slash === -1) return '';
  return rest.slice(slash);
}

function cachedPaths(research) {
  const paths = [];
  for (const page of pageList(research)) {
    if (!page || typeof page.url !== 'string') continue;
    const pathname = pathnameOf(page.url);
    if (pathname) paths.push(pathname);
  }
  return paths;
}

function formFlag(research) {
  const site = asObject(research.site);
  if (site && site.has_contact_form === true) return true;
  if (research.has_contact_form === true) return true;
  if (site && site.has_contact_form === false) return false;
  if (research.has_contact_form === false) return false;
  return null;
}

// The clause before this match, cut at the previous sentence end.
function clauseBefore(text, index) {
  const start = Math.max(0, index - 80);
  let window = text.slice(start, index);
  const breakAt = window.search(/[.!?][^.!?]*$/);
  if (breakAt !== -1) window = window.slice(breakAt + 1);
  return window;
}

function isNegated(text, index) {
  const window = clauseBefore(text, index);
  if (/\bnot\s+only(?:\s+\S+){0,4}\s*$/i.test(window)) return false;
  if (/\bno[-\s]+cost\s*$/i.test(window)) return false;
  return NEGATIVE_TAIL.test(window);
}

function matchesAffirmative(text, re) {
  if (!text) return false;
  const flags = re.flags.includes('g') ? re.flags : `${re.flags}g`;
  const global = new RegExp(re.source, flags);
  let match;
  while ((match = global.exec(text)) !== null) {
    if (!isNegated(text, match.index)) return true;
    if (match[0].length === 0) global.lastIndex += 1;
  }
  return false;
}

// The phrase is in the text, and every hit is negated. A cached boolean that
// research set from that same phrase does not override the negation.
function textContradicts(text, re) {
  if (!text) return false;
  if (!new RegExp(re.source, re.flags).test(text)) return false;
  return !matchesAffirmative(text, re);
}

function affirmedOrMention(mention, text, re) {
  if (matchesAffirmative(text, re)) return true;
  return Boolean(mention) && !textContradicts(text, re);
}

function quoteFormPresent(research, signals, text) {
  const mentioned = mentionTrue(signals, 'quote_form') || mentionTrue(signals, 'contact_form');
  if (matchesAffirmative(text, QUOTE_FORM_TEXT_RE)) return true;
  if (mentioned && !textContradicts(text, QUOTE_FORM_TEXT_RE)) return true;
  if (textContradicts(text, QUOTE_FORM_TEXT_RE)) return false;
  const flag = formFlag(research);
  if (flag === true) return true;
  if (flag === false) return false;
  return cachedPaths(research).some(pathname => FORM_PATH_RE.test(pathname));
}

function jobAdPresent(signals, text) {
  const mentioned = mentionTrue(signals, 'comfort_advisor')
    || mentionTrue(signals, 'sales_advisor')
    || mentionTrue(signals, 'comfort_consultant')
    || mentionTrue(signals, 'sales_consultant');
  const titles = namedList(signals && signals.job_ads).join('\n');
  if (matchesAffirmative(titles, JOB_AD_RE) || matchesAffirmative(text, JOB_AD_RE)) return true;
  if (mentioned && !textContradicts(text, JOB_AD_RE) && !textContradicts(titles, JOB_AD_RE)) return true;
  return false;
}

function searchAdsPresent(signals, text) {
  if (mentionTrue(signals, 'lsa') || mentionTrue(signals, 'search_ads')) {
    if (!textContradicts(text, SEARCH_ADS_RE)) return true;
  }
  const labels = namedList(signals && signals.analytics_ads).concat(namedList(signals && signals.ads));
  if (labels.some(label => SEARCH_ADS_LABEL_RE.test(label))) return true;
  return matchesAffirmative(text, SEARCH_ADS_RE);
}

function financingPresent(signals, text) {
  // A lender signature is a tool on the page, not the negated sentence.
  if (namedList(signals && signals.financing).length > 0) return true;
  return affirmedOrMention(mentionTrue(signals, 'financing'), text, FINANCING_RE);
}

function presentSignals(research) {
  const signals = signalsOf(research) || {};
  const text = cachedText(research);
  const quote = quoteFormPresent(research, signals, text) && !FOLLOW_UP_PROMISE_RE.test(text);
  return {
    replacement: affirmedOrMention(mentionTrue(signals, 'replacement'), text, REPLACEMENT_RE),
    installation: affirmedOrMention(mentionTrue(signals, 'installation'), text, INSTALLATION_RE),
    free_estimate: affirmedOrMention(
      mentionTrue(signals, 'free_estimate') || mentionTrue(signals, 'free_estimates'),
      text,
      FREE_ESTIMATE_RE,
    ),
    financing: financingPresent(signals, text),
    quote_form: quote,
    job_ad: jobAdPresent(signals, text),
    search_ads: searchAdsPresent(signals, text),
  };
}

// [points, reasons]. A non-HVAC lead, a missing cache, and an unknown signal add 0.
function estimateSignalAdjustment(prospect) {
  if (!prospect || !isHvacLead(prospect)) return [0, []];
  const research = asObject(prospect.research);
  if (!research) return [0, []];
  const hits = presentSignals(research);
  const reasons = [];
  let points = 0;
  for (const id of Object.keys(REASONS)) {
    if (!hits[id]) continue;
    const weight = Number(cfg.ESTIMATE_SIGNAL_POINTS[id]) || 0;
    if (!weight) continue;
    points += weight;
    reasons.push({
      label: REASONS[id].label,
      points: weight,
      max: weight,
      detail: REASONS[id].detail,
    });
  }
  return [points, reasons];
}

module.exports = { estimateSignalAdjustment };
