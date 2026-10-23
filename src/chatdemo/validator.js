// Deterministic claims validator. Fixed phrase lists. No model call.
// Reply and fact values are NFKC-normalized, lowercased, and whitespace-collapsed
// before matching. docs/LIVE_CHAT_DEMO.md §5.

const { CANNED_REPLY, normalize } = require('./copy');

const PRICE_PHRASES = Object.freeze([
  'dollars', 'per hour', 'per visit', 'starting at', 'flat rate', 'service call fee', 'trip charge',
]);

const LICENSE_NUMBER_PHRASES = Object.freeze(['license number', 'license #', 'lic #']);

const WARRANTY_PHRASES = Object.freeze(['warranty', 'warranties']);

const GUARANTEE_PHRASES = Object.freeze([
  'satisfaction guaranteed', 'guaranteed', 'guarantee', 'money back', 'money-back',
]);

const YES_NO_PHRASES = Object.freeze({
  free_estimate: Object.freeze([
    'free in-home estimate', 'no-charge estimate', 'no charge estimate',
    'free estimates', 'free estimate', 'free quotes', 'free quote',
  ]),
  emergency_247: Object.freeze([
    '24 hours a day', 'around the clock', 'emergency service', 'after-hours service',
    'after hours service', 'nights and weekends', '24 hours', '24/7', '24-7',
  ]),
  financing: Object.freeze([
    'finance options', 'payment plans', 'payment plan', '0% apr', 'zero percent',
    'no interest', 'financing',
  ]),
  maintenance_plan: Object.freeze([
    'maintenance plan', 'service agreement', 'service plan', 'membership plan', 'comfort club',
  ]),
  license: Object.freeze(['fully licensed', 'licensed']),
  insurance: Object.freeze(['fully insured', 'liability insurance', 'insured']),
  bonding: Object.freeze(['bonded']),
});

const AVAILABILITY_PHRASES = Object.freeze([
  'same-day', 'same day', 'tonight', 'today', 'right away', 'right now', 'asap', 'immediately',
  'within the hour', 'within an hour', 'in under an hour', 'within 30 minutes', 'within 60 minutes',
  'within 2 hours', 'on your doorstep', 'on the way', 'guaranteed arrival',
]);

const RATING_PHRASES = Object.freeze([
  'star rating', 'stars', 'rated', 'reviews', '#1', 'number one', 'best in',
]);

const KNOWN_FALSE_POSITIVES = Object.freeze([
  "I can't confirm that right now",
  "I'll pass this on immediately",
  "today's question",
  'what can I help with today',
  "I'm on the way to getting you an answer",
  "I can't promise same day",
]);

const AVAILABILITY_PATTERN = /\bwithin \d+ (?:minutes?|hours?)\b/;
const PRICE_PATTERN = /\$\s?\d[\d,]*/g;
const LICENSE_HASH_PATTERN = /#\s?\d{4,}/g;
const LICENSE_DASH_PATTERN = /\b\d{5,}-\d{4}\b/g;
const TENURE_PATTERN = /\b\d+ years? (?:in business|of experience|experience)\b/g;
const SINCE_PATTERN = /\bsince (?:19|20)\d{2}\b/g;
const PHONE_PATTERN = /\(?\d{3}\)?[ .-]?\d{3}[ .-]?\d{4}/g;

function hasPhrase(text, phrase) {
  const escaped = phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const start = /^\w/.test(phrase) ? '\\b' : '(?:^|\\W)';
  const end = /\w$/.test(phrase) ? '\\b' : '(?:$|\\W)';
  return new RegExp(`${start}${escaped}${end}`).test(text);
}

function factRows(facts) {
  if (!facts) return [];
  if (Array.isArray(facts)) return facts;
  return Object.entries(facts).map(([field, value]) => ({ field, value, source: 'fixture' }));
}

function fieldValue(facts, field) {
  const row = factRows(facts).find((item) => item.field === field && item.value != null && item.value !== '');
  return row ? String(row.value) : '';
}

function hasYes(facts, field) {
  return factRows(facts).some((item) => item.field === field && item.value === 'yes' && item.source);
}

function foldDigits(value) {
  return normalize(value).replace(/(\d),(?=\d)/g, '$1');
}

function containsText(haystack, needle) {
  if (!needle) return false;
  const foldedHay = foldDigits(haystack);
  const foldedNeedle = foldDigits(needle);
  return foldedHay.includes(foldedNeedle);
}

function pushHit(hits, rule, match) {
  hits.push({ rule, match });
}

function checkPhrases(hits, text, phrases, rule, facts, field) {
  const value = fieldValue(facts, field);
  for (const phrase of phrases) {
    if (!hasPhrase(text, phrase)) continue;
    if (!containsText(value, phrase)) pushHit(hits, rule, phrase);
  }
}

function checkPattern(hits, text, pattern, rule, facts, field) {
  const value = fieldValue(facts, field);
  const flags = pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`;
  const re = new RegExp(pattern.source, flags);
  let match;
  while ((match = re.exec(text))) {
    if (!containsText(value, match[0])) pushHit(hits, rule, match[0]);
  }
}

function digitsOnly(value) {
  return String(value || '').replace(/\D/g, '');
}

function is55501(digits) {
  return digits.length === 10 && digits.slice(3, 6) === '555' && digits.slice(6, 8) === '01';
}

function validate(reply, facts) {
  const text = normalize(reply);
  const hits = [];
  const rows = factRows(facts);

  checkPattern(hits, text, PRICE_PATTERN, 'price', rows, 'price');
  checkPhrases(hits, text, PRICE_PHRASES, 'price', rows, 'price');

  checkPattern(hits, text, LICENSE_HASH_PATTERN, 'license_number', rows, 'license_number');
  checkPattern(hits, text, LICENSE_DASH_PATTERN, 'license_number', rows, 'license_number');
  checkPhrases(hits, text, LICENSE_NUMBER_PHRASES, 'license_number', rows, 'license_number');

  checkPhrases(hits, text, WARRANTY_PHRASES, 'warranty', rows, 'warranty');
  checkPhrases(hits, text, GUARANTEE_PHRASES, 'guarantee', rows, 'guarantee');

  checkPattern(hits, text, TENURE_PATTERN, 'tenure', rows, 'years_in_business');
  checkPattern(hits, text, SINCE_PATTERN, 'tenure', rows, 'years_in_business');

  const phone = digitsOnly(fieldValue(rows, 'phone'));
  const phoneRe = new RegExp(PHONE_PATTERN.source, 'g');
  let phoneMatch;
  while ((phoneMatch = phoneRe.exec(text))) {
    const digits = digitsOnly(phoneMatch[0]);
    if (digits.length < 10) continue;
    const last10 = digits.slice(-10);
    if (last10 === phone || is55501(last10)) continue;
    pushHit(hits, 'phone', phoneMatch[0]);
  }

  for (const phrase of RATING_PHRASES) {
    if (hasPhrase(text, phrase)) pushHit(hits, 'rating', phrase);
  }

  for (const [field, phrases] of Object.entries(YES_NO_PHRASES)) {
    for (const phrase of phrases) {
      if (!hasPhrase(text, phrase)) continue;
      if (!hasYes(rows, field)) pushHit(hits, field, phrase);
    }
  }

  const emergencyPhrases = new Set(YES_NO_PHRASES.emergency_247);
  const emergencyOk = hasYes(rows, 'emergency_247');
  for (const phrase of AVAILABILITY_PHRASES) {
    if (!hasPhrase(text, phrase)) continue;
    if (emergencyOk && emergencyPhrases.has(phrase)) continue;
    pushHit(hits, 'availability', phrase);
  }
  if (AVAILABILITY_PATTERN.test(text)) {
    const found = text.match(AVAILABILITY_PATTERN);
    pushHit(hits, 'availability', found ? found[0] : 'within');
  }

  return { ok: hits.length === 0, reply: String(reply ?? ''), hits };
}

module.exports = {
  PRICE_PHRASES,
  LICENSE_NUMBER_PHRASES,
  WARRANTY_PHRASES,
  GUARANTEE_PHRASES,
  YES_NO_PHRASES,
  AVAILABILITY_PHRASES,
  RATING_PHRASES,
  KNOWN_FALSE_POSITIVES,
  CANNED_REPLY,
  normalize,
  validate,
};
