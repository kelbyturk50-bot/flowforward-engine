// F-003 cache reader. Points and GTM rationale live in src/scoring/config.js
// (ESTIMATE_SIGNAL_POINTS). This module only decides whether each cached
// signal is present. It does not fetch, and it does not score plumbing.

const cfg = require('./config');
const { normalizeIndustry } = require('./industry');

const REPLACEMENT_RE = /\breplacements?\b/i;
const INSTALLATION_RE = /\binstallations?\b/i;
const FREE_ESTIMATE_RE = /\bfree\s+estimates?\b/i;
const FINANCING_RE = /\bfinancing\b/i;
const QUOTE_FORM_TEXT_RE = /\b(?:quote|contact)\s+forms?\b/i;
const FORM_PATH_RE = /\b(?:estimates?|quotes?|contact)\b/i;
const FOLLOW_UP_PROMISE_RE = /\b(?:we(?:'ll|’ll| will)\s+follow\s+up|follow[- ]up\s+(?:is\s+)?guaranteed|guaranteed\s+follow[- ]?up|we\s+promise\s+to\s+follow\s+up|we(?:'ll|’ll| will)\s+be\s+in\s+touch)\b/i;
const JOB_AD_RE = /\bcomfort\s+advisors?\b|\bsales\s+(?:consultants?|representatives?|reps?|advisors?|positions?|roles?|specialists?)\b|\b(?:now\s+hiring|hiring|hire)\s+(?:a\s+|an\s+)?(?:in[- ]home\s+)?sales\b/i;
const JOB_TITLE_RE = /\bcomfort\b|\bsales\b/i;
const SEARCH_ADS_RE = /\blocal\s+services\s+ads?\b|\bgoogle\s+ads\b|\bgoogle\s+local\s+services\b|\blsas?\b/i;
const SEARCH_ADS_LABEL_RE = /google ads|\blocal services\b|\blsas?\b/i;

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
    detail: 'Cached job ad for a comfort advisor or sales role',
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

function skipsIndustry(industry) {
  const name = normalizeIndustry(industry).toLowerCase();
  if (!name) return false;
  return (cfg.ESTIMATE_SIGNAL_SKIP_INDUSTRIES || []).some(item => String(item).trim().toLowerCase() === name);
}

function formFlag(research) {
  const site = asObject(research.site);
  if (site && site.has_contact_form === true) return true;
  if (research.has_contact_form === true) return true;
  if (site && site.has_contact_form === false) return false;
  if (research.has_contact_form === false) return false;
  return null;
}

function quoteFormPresent(research, signals, text) {
  if (mentionTrue(signals, 'quote_form') || mentionTrue(signals, 'contact_form')) return true;
  if (QUOTE_FORM_TEXT_RE.test(text)) return true;
  const flag = formFlag(research);
  if (flag === true) return true;
  if (flag === false) return false;
  return cachedPaths(research).some(pathname => FORM_PATH_RE.test(pathname));
}

function jobAdPresent(signals, text) {
  if (mentionTrue(signals, 'comfort_advisor') || mentionTrue(signals, 'job_ad') || mentionTrue(signals, 'sales_job')) {
    return true;
  }
  const titles = namedList(signals && signals.job_ads);
  if (titles.some(title => JOB_AD_RE.test(title) || JOB_TITLE_RE.test(title))) return true;
  return JOB_AD_RE.test(text);
}

function searchAdsPresent(signals, text) {
  if (mentionTrue(signals, 'lsa') || mentionTrue(signals, 'search_ads')) return true;
  const labels = namedList(signals && signals.analytics_ads).concat(namedList(signals && signals.ads));
  if (labels.some(label => SEARCH_ADS_LABEL_RE.test(label))) return true;
  return SEARCH_ADS_RE.test(text);
}

function financingPresent(signals, text) {
  if (mentionTrue(signals, 'financing')) return true;
  if (namedList(signals && signals.financing).length > 0) return true;
  return FINANCING_RE.test(text);
}

function presentSignals(research) {
  const signals = signalsOf(research) || {};
  const text = cachedText(research);
  const quote = quoteFormPresent(research, signals, text) && !FOLLOW_UP_PROMISE_RE.test(text);
  return {
    replacement: mentionTrue(signals, 'replacement') || REPLACEMENT_RE.test(text),
    installation: mentionTrue(signals, 'installation') || INSTALLATION_RE.test(text),
    free_estimate: mentionTrue(signals, 'free_estimate') || mentionTrue(signals, 'free_estimates') || FREE_ESTIMATE_RE.test(text),
    financing: financingPresent(signals, text),
    quote_form: quote,
    job_ad: jobAdPresent(signals, text),
    search_ads: searchAdsPresent(signals, text),
  };
}

// [points, reasons]. Plumbing, a missing cache, and an unknown signal add 0.
function estimateSignalAdjustment(prospect) {
  if (!prospect || skipsIndustry(prospect.industry)) return [0, []];
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
