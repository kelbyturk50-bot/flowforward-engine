// F-003 cache reader. Points and GTM rationale live in src/scoring/config.js
// (ESTIMATE_SIGNAL_POINTS). This module only decides whether each cached
// signal is present. It does not fetch. Points apply only to an HVAC lead:
// a stored non-HVAC industry scores 0 even when the name or category matches.

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
// Apostrophes: straight, U+2019 (don’t), and U+2018. Verb negations keep a
// wide window and may cross a comma, semicolon, or hyphen. "not only" is not
// one of them: the next word after "not" is not "only". "no longer" and "no
// more" are not in that window. They negate only when the phrase follows, or
// after one offer-type verb and an optional any/a/an/the. Bare "no" and
// "without" negate only when the phrase follows immediately, or with just
// any/a/an/the in between. A comma after "no" ("No, free estimates") is not
// that gap.
const NEGATIVE_VERB = /\b(?:do\s+not|does\s+not|did\s+not|is\s+not|are\s+not|was\s+not|were\s+not|will\s+not|cannot|don['\u2019\u2018]?t|doesn['\u2019\u2018]?t|didn['\u2019\u2018]?t|isn['\u2019\u2018]?t|aren['\u2019\u2018]?t|wasn['\u2019\u2018]?t|weren['\u2019\u2018]?t|won['\u2019\u2018]?t|can['\u2019\u2018]?t|not(?!\s+only\b)|never)\b(?:[\s,;-]+[a-z0-9'\u2019\u2018]+){0,8}\s*$/i;
// Sentence-initial "Don't" / "Do not" plus one of these verbs. Cached page
// text joins the title and the meta description on the lines above, so the
// imperative may also start a line. The first comma, semicolon, colon, or
// dash after the verb ends that negator's window only when the text from the
// verb to the phrase has none of the negators the wide window uses (do not,
// don't, cannot, not, never, no, no longer, no more, without, none, nor,
// neither, unable, unavailable). A hit after the break counts. A newline, a
// "|", or a title/meta/body join (cachedText joins those fields with newlines)
// is a boundary that cut does not cross. Offer verbs are absent on purpose
// (offer, provide, accept, have, carry, do, extend), so "Don't offer, ..."
// stays on the wide window above.
const IMPERATIVE_OPEN_RE = /(?:^|[\n\r])\s*(?:don['\u2019\u2018]?t|do\s+not)\s+/i;
const IMPERATIVE_VERB_RE = /^(?:wait|settle|sweat|miss(?:\s+out)?|hesitate|delay|forget|worry|overpay|pay|stop|panic|gamble|risk|struggle|postpone|skip|scramble)\b/i;
const IMPERATIVE_BREAK_RE = /,|;|:|\s+--\s+|\s+-\s+|\u2013|\u2014/;
// Same set as NEGATIVE_VERB, NEGATIVE_NO_MORE, and NEGATIVE_BARE, plus the
// words that block a CTA cut when they sit anywhere from the verb to the
// phrase (none, nor, neither, unable, unavailable). A hit keeps main's window.
const IMPERATIVE_NEGATOR_RE = /\b(?:do\s+not|does\s+not|did\s+not|is\s+not|are\s+not|was\s+not|were\s+not|will\s+not|cannot|don['\u2019\u2018]?t|doesn['\u2019\u2018]?t|didn['\u2019\u2018]?t|isn['\u2019\u2018]?t|aren['\u2019\u2018]?t|wasn['\u2019\u2018]?t|weren['\u2019\u2018]?t|won['\u2019\u2018]?t|can['\u2019\u2018]?t|never|no\s+(?:longer|more)|not(?!\s+only\b)|no|without|none|nor|neither|unable|unavailable)\b/i;
const NEGATIVE_NO_MORE = /\bno\s+(?:longer|more)(?:\s+(?:offer(?:s|ing|ed)?|provide(?:s|ing)?|accept(?:s|ing)?|do(?:es)?)\b)?(?:\s+(?:any|a|an|the))?\s+$/i;
const NEGATIVE_BARE = /\b(?:no|without)(?:\s+(?:any|a|an|the))?\s+$/i;
// A short window after the phrase: "not available", "unavailable", "none",
// or a bare "no" / "no." The bare "no" does not match "no obligation".
const NEGATIVE_AFTER = /^[\s,;:?!-]*(?:(?:are|is|was|were)\s+)?(?:\bnot\s+available\b|\bunavailable\b|\bnone\b|\bno(?=\s*[.!?]|[\s]*$))/i;
// Trade words that block a name or category fallback. A stored industry is
// not filtered through this list, so "Plumbing & Heating" can still count.
const NON_HVAC_TRADE_RE = /\b(?:lawns?|landscapes?|landscaping|trees?|electric(?:al|ian)?s?|pools?|roofs?|roofing|roofers?|pests?|exterminat(?:or|ors|ing|ion)?|cleaning|cleaners?|plumbing|plumbers?|painting|painters?|gutters?|windows?|construction)\b/i;
const NOT_HVAC_TRADE_RE = /\b(?:heating\s+oil|pool\s+heating)\b/i;
const AIR_CONDITIONING_RE = /\bair\s+conditioning\b/i;

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

function foldIdentity(value) {
  return String(value || '')
    .trim()
    .replace(/-+/g, ' ')
    .replace(/\s+/g, ' ')
    .toLowerCase();
}

// HVAC, "Air Conditioning", or a combination that says heating, cooling, HVAC,
// AC, or furnace. "Heating Oil Delivery" and "Pool Heating" are not HVAC.
// Page text is not an identity field.
function identityIsHvac(value) {
  const folded = foldIdentity(value);
  if (!folded) return false;
  if (NOT_HVAC_TRADE_RE.test(folded)) return false;
  if (AIR_CONDITIONING_RE.test(folded)) return true;
  if (normalizeIndustry(folded).toLowerCase() === 'hvac') return true;
  const re = hvacWordRe();
  return Boolean(re && re.test(folded));
}

// A name or category counts only when it has an HVAC term and no other trade.
function fallbackIsHvac(value) {
  const text = fieldText(value);
  if (!text.trim()) return false;
  if (NON_HVAC_TRADE_RE.test(foldIdentity(text))) return false;
  return identityIsHvac(text);
}

// A stored non-HVAC industry is 0 no matter what the company name or category
// says. Name and category are read only when the industry is empty.
function isHvacLead(prospect) {
  const industry = fieldText(prospect.industry).trim();
  if (industry) return identityIsHvac(industry);
  return [prospect.category, prospect.categories, prospect.company].some(fallbackIsHvac);
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

// Stop at . or ! and keep that mark, so "no." is visible and the next sentence
// is not. ? and : stay, so "free estimates? no." and "Financing: none" do too.
function clauseAfter(text, end) {
  let window = text.slice(end, end + 48);
  const stop = window.search(/[.!]/);
  if (stop !== -1) window = window.slice(0, stop + 1);
  return window;
}

// The wide window still applies when this cut does not. No punctuation, an
// offer verb, a negator anywhere from the verb to the phrase, or a break past
// a newline, "|", or a title/meta/body join leaves the clause alone.
function cutImperativeNegation(before) {
  const fenceAt = Math.max(
    before.lastIndexOf('\n'),
    before.lastIndexOf('\r'),
    before.lastIndexOf('|'),
  );
  const segment = fenceAt === -1 ? before : before.slice(fenceAt + 1);
  const open = segment.match(IMPERATIVE_OPEN_RE);
  if (!open || open.index !== 0) return before;
  const rest = segment.slice(open.index + open[0].length);
  const verb = rest.match(IMPERATIVE_VERB_RE);
  if (!verb) return before;
  const after = rest.slice(verb[0].length);
  const brk = after.match(IMPERATIVE_BREAK_RE);
  if (!brk) return before;
  if (IMPERATIVE_NEGATOR_RE.test(after)) return before;
  return after.slice(brk.index + brk[0].length);
}

function isNegated(text, index, length) {
  const before = cutImperativeNegation(clauseBefore(text, index));
  if (NEGATIVE_VERB.test(before)) return true;
  if (NEGATIVE_NO_MORE.test(before)) return true;
  if (NEGATIVE_BARE.test(before)) return true;
  return NEGATIVE_AFTER.test(clauseAfter(text, index + length));
}

function matchesAffirmative(text, re) {
  if (!text) return false;
  const flags = re.flags.includes('g') ? re.flags : `${re.flags}g`;
  const global = new RegExp(re.source, flags);
  let match;
  while ((match = global.exec(text)) !== null) {
    if (!isNegated(text, match.index, match[0].length)) return true;
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
