// One pest-control rule for discovery, fit scoring, lead picking, and the
// prospects API. Synonyms collapse to PEST_CANONICAL. Place names use the
// pest, exterminator, and termite words on a boundary, so Pestana, Compest,
// and Best stay in scope. The company-name gate uses those words plus a
// national-brand list. It reads the cached name only and does not change
// computeFit.

const cfg = require('./config');

const PEST_CANONICAL = 'Pest Control';

// Shown on fit_reasons and returned when drafting is refused. No company name.
const PEST_NAME_REASON = 'Company name matches pest control — out of scope';

// Same normalization as industryKey, for the prospects.company column.
const COMPANY_PEST_KEY = "lower(regexp_replace(btrim(COALESCE(p.company, '')), '\\s+', ' ', 'g'))";
const INDUSTRY_PEST_KEY = "lower(regexp_replace(btrim(COALESCE(p.industry, '')), '\\s+', ' ', 'g'))";

// Lowercased industry text. Word characters are ASCII, matching JS \w and the
// SQL check in appendIndustryExclusion (locale-independent).
const PEST_WORD_ALTERNATION = 'pests?|exterminat(or|ors|ing|ion)?|termites?';
const PEST_TEXT_PATTERN = `(^|[^a-z0-9_])(${PEST_WORD_ALTERNATION})([^a-z0-9_]|$)`;
const PEST_TEXT_RE = new RegExp(PEST_TEXT_PATTERN);

// Company-name gate only. These are not industry synonyms, so computeFit does
// not change. Both sides fold ASCII A-Z only, fold COMPANY_SPACE_PATTERN to
// one space, trim, then keep the first COMPANY_NAME_LIMIT characters. The cap
// is after that fold so a Unicode casefold cannot change the length on one
// side only. Then both strip street-style Orkin/Terminix with
// STREET_BRAND_PATTERN and test PEST_COMPANY_PATTERN. The patterns are
// case-sensitive (no /i, no ~*). The space class is literal code points.
// Postgres \s is POSIX space and does not match JS \s, so the class is not
// written with \s. U+200B is in the class and is not part of JS \s.
// appendCompanyPestExclusion binds that class, the street pattern, and the
// company pattern.
//
// Distinctive tokens match on their own: Terminix, Orkin, Rentokil, Truly Nolen
// (a space or hyphen, and TrulyNolen with neither). Rollins Inc / Rollins, Inc.
// and the multi-word brands match on their own. Surname-style tokens (Rollins,
// Aptive, Hawx, Massey, Bulwark, Moxie, Arrow, Western, Ecolab) match only when
// the name also has pest context: pest, exterminator, termite, bug, rodent, or
// mosquito.
const DISTINCTIVE_ALTERNATION = 'terminix|orkin|rentokil|truly[- ]*nolen';
const AMBIGUOUS_ALTERNATION = 'rollins|aptive|hawx|massey|bulwark|moxie|arrow|western|ecolab';
const CONTEXT_ALTERNATION = 'bugs?|rodents?|mosquitoe?s?';
const MULTIWORD_ALTERNATION = [
  'ecolab[- ]+pests?',
  'arrow[- ]+exterminators',
  'western[- ]+exterminator',
  'massey[- ]+services',
  'moxie[- ]+pests?',
  'bulwark[- ]+exterminating',
  'rollins[- ,]+inc',
].join('|');
// Longer street suffixes come first so "street" is not read as "st".
const STREET_SUFFIX_ALTERNATION = 'street|avenue|drive|road|ave|rd|st|dr';
// Four capturing groups. Group 1 is the boundary before the brand. Group 4 is
// the boundary after the suffix. The replacement keeps both so neighboring
// words do not merge. Orkin Street Pest still matches the pest word.
const STREET_BRAND_PATTERN = `(^|[^a-z0-9_])(terminix|orkin)[- ]+(${STREET_SUFFIX_ALTERNATION})([^a-z0-9_]|$)`;

// Same characters in JS and SQL. Listed one by one so a hyphen is not a
// range and a locale cannot reorder a range. JS \s, plus U+200B.
const COMPANY_SPACE_CODE_POINTS = [
  0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x20,
  0xa0,
  0x1680,
  0x2000, 0x2001, 0x2002, 0x2003, 0x2004, 0x2005, 0x2006, 0x2007, 0x2008, 0x2009, 0x200a, 0x200b,
  0x2028, 0x2029,
  0x202f,
  0x205f,
  0x3000,
  0xfeff,
];
const COMPANY_SPACE_PATTERN = `[${COMPANY_SPACE_CODE_POINTS.map(cp => String.fromCodePoint(cp)).join('')}]+`;
const COMPANY_NAME_LIMIT = 200;

function bounded(alternation) {
  return `(?:^|[^a-z0-9_])(?:${alternation})(?:[^a-z0-9_]|$)`;
}

// Either order. The first token must be its own word. The second token is the
// next word, or a later word that still starts on a boundary.
function eitherOrder(left, right) {
  const forward = `(?:^|[^a-z0-9_])(?:${left})(?:[^a-z0-9_]|$)(?:.*(?:^|[^a-z0-9_]))?(?:${right})(?:[^a-z0-9_]|$)`;
  const reverse = `(?:^|[^a-z0-9_])(?:${right})(?:[^a-z0-9_]|$)(?:.*(?:^|[^a-z0-9_]))?(?:${left})(?:[^a-z0-9_]|$)`;
  return `${forward}|${reverse}`;
}

const PEST_COMPANY_PATTERN = [
  bounded(PEST_WORD_ALTERNATION),
  bounded(DISTINCTIVE_ALTERNATION),
  bounded(MULTIWORD_ALTERNATION),
  eitherOrder(AMBIGUOUS_ALTERNATION, CONTEXT_ALTERNATION),
].join('|');
const PEST_COMPANY_RE = new RegExp(PEST_COMPANY_PATTERN);

function stripStreetBrand(key) {
  if (!key) return '';
  return key.replace(new RegExp(STREET_BRAND_PATTERN, 'g'), '$1$4');
}

// SQL left() counts Unicode code points. Stop at the limit so a long name
// never reaches the company pattern.
function takePrefix(value, limit) {
  let units = 0;
  let i = 0;
  while (i < value.length && units < limit) {
    const cp = value.codePointAt(i);
    i += cp > 0xffff ? 2 : 1;
    units += 1;
  }
  return i === value.length ? value : value.slice(0, i);
}

// Company gate only. industryKey stays on JS \s and toLowerCase so scoring
// and industry synonyms do not move. ASCII A-Z only: toLowerCase() maps
// U+212A to "k" and expands U+0130, and Postgres lower() follows the database
// locale. A new RegExp each call: the global flag keeps lastIndex.
function companyNameKey(value) {
  if (value == null) return '';
  const folded = String(value)
    .replace(/[A-Z]/g, c => String.fromCharCode(c.charCodeAt(0) + 32))
    .replace(new RegExp(COMPANY_SPACE_PATTERN, 'g'), ' ')
    .trim();
  return takePrefix(folded, COMPANY_NAME_LIMIT);
}

function industryKey(value) {
  if (value == null) return '';
  return String(value).trim().replace(/\s+/g, ' ').toLowerCase();
}

function isPestText(value) {
  const key = industryKey(value);
  return key !== '' && PEST_TEXT_RE.test(key);
}

function normalizeIndustry(value) {
  if (value == null) return '';
  const trimmed = String(value).trim().replace(/\s+/g, ' ');
  if (!trimmed) return '';
  if (isPestText(trimmed)) return PEST_CANONICAL;
  return trimmed;
}

function pestCategoryExcluded(excluded = cfg.EXCLUDED_INDUSTRIES) {
  return excluded.some(name => normalizeIndustry(name) === PEST_CANONICAL);
}

function isExcludedIndustry(value, excluded = cfg.EXCLUDED_INDUSTRIES) {
  const canonical = normalizeIndustry(value);
  if (!canonical) return false;
  const key = canonical.toLowerCase();
  return excluded.some(name => normalizeIndustry(name).toLowerCase() === key);
}

function excludedIndustryKeys(excluded = cfg.EXCLUDED_INDUSTRIES) {
  const keys = [];
  for (const name of excluded) {
    const key = normalizeIndustry(name).toLowerCase();
    if (key && !keys.includes(key)) keys.push(key);
  }
  return keys;
}

// Push bound params and return the SQL fragment. Placeholders continue from
// params.length. The pest word check is included only when Pest Control is excluded.
function appendIndustryExclusion(params, excluded = cfg.EXCLUDED_INDUSTRIES) {
  const keyExpr = "lower(regexp_replace(btrim(p.industry), '\\s+', ' ', 'g'))";
  const keysIndex = params.push(excludedIndustryKeys(excluded));
  let sql = `${keyExpr} <> ALL($${keysIndex}::text[])`;
  if (pestCategoryExcluded(excluded)) {
    const patternIndex = params.push(PEST_TEXT_PATTERN);
    sql += ` AND ${keyExpr} !~ $${patternIndex}`;
  }
  return sql;
}

function placeTypeValues(place) {
  const values = [];
  if (place?.primaryType) values.push(place.primaryType);
  const display = place?.primaryTypeDisplayName;
  if (typeof display === 'string') values.push(display);
  else if (display?.text) values.push(display.text);
  if (Array.isArray(place?.types)) values.push(...place.types);
  return values;
}

function isPestPlaceType(place) {
  return placeTypeValues(place).some(value => {
    const text = String(value ?? '').trim().toLowerCase().replace(/[_-]+/g, ' ').replace(/\s+/g, ' ');
    return text.includes('pest control');
  });
}

function placeName(place) {
  const raw = place?.displayName;
  if (raw && typeof raw === 'object') return raw.text || '';
  return raw || '';
}

function isPestDiscoveryPlace(place, excluded = cfg.EXCLUDED_INDUSTRIES) {
  if (!pestCategoryExcluded(excluded)) return false;
  return isPestText(placeName(place)) || isPestPlaceType(place);
}

// Cached company name. Pest words plus the brand rules above, on ASCII
// boundaries, matching appendCompanyPestExclusion. Off when Pest Control is
// not on the exclusion list. Does not fetch and does not score the row.
function isPestCompanyName(company, excluded = cfg.EXCLUDED_INDUSTRIES) {
  if (!pestCategoryExcluded(excluded)) return false;
  const key = stripStreetBrand(companyNameKey(company));
  return key !== '' && PEST_COMPANY_RE.test(key);
}

// SQL fragment. TRUE when the name gate is off. Placeholder numbers continue
// from params.length. The column is the cached company name, not a request.
// Bound parameters, in order: COMPANY_SPACE_PATTERN, STREET_BRAND_PATTERN,
// PEST_COMPANY_PATTERN. translate folds ASCII A-Z only. left(..., 200) is
// applied after that fold and the space fold. !~ is case-sensitive.
function appendCompanyPestExclusion(params, excluded = cfg.EXCLUDED_INDUSTRIES) {
  if (!pestCategoryExcluded(excluded)) return 'TRUE';
  const spaceIndex = params.push(COMPANY_SPACE_PATTERN);
  const streetIndex = params.push(STREET_BRAND_PATTERN);
  const patternIndex = params.push(PEST_COMPANY_PATTERN);
  const folded = `left(btrim(regexp_replace(translate(COALESCE(p.company, ''), 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'), $${spaceIndex}, ' ', 'g')), ${COMPANY_NAME_LIMIT})`;
  const stripped = `regexp_replace(${folded}, $${streetIndex}, '\\1\\4', 'g')`;
  return `${stripped} !~ $${patternIndex}`;
}

// Industry exclusion plus the company-name gate. pickLeads and the eligible
// count both use this, so a legacy HVAC row with a pest name is not a draft
// candidate. This is a read filter. It does not write fit_score or fit_tier.
function appendDraftExclusion(params, excluded = cfg.EXCLUDED_INDUSTRIES) {
  const industrySql = appendIndustryExclusion(params, excluded);
  const nameSql = appendCompanyPestExclusion(params, excluded);
  return `${industrySql} AND ${nameSql}`;
}

// Read-time hide for an A-tier queue. A stored tier of A is left in the
// database; the SELECT drops a pest-name row from that result. TRUE when
// Pest Control is not excluded. alias is '' or a SQL identifier such as 'p'.
function appendATierPestHide(params, alias = '', excluded = cfg.EXCLUDED_INDUSTRIES) {
  if (!pestCategoryExcluded(excluded)) return 'TRUE';
  if (alias !== '' && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(alias)) {
    throw new Error('bad alias');
  }
  const prefix = alias ? `${alias}.` : '';
  const patternIndex = params.push(PEST_TEXT_PATTERN);
  const key = `lower(regexp_replace(btrim(COALESCE(${prefix}company, '')), '\\s+', ' ', 'g'))`;
  return `NOT (${prefix}fit_tier = 'A' AND ${key} ~ $${patternIndex})`;
}

// Count of rows the name gate newly covers: the company matches, and the
// stored industry is not already excluded. One integer. No other columns.
function legacyPestNameCountQuery(excluded = cfg.EXCLUDED_INDUSTRIES) {
  if (!pestCategoryExcluded(excluded)) {
    return { text: 'SELECT 0::int AS n', values: [] };
  }
  const params = [];
  const patternIndex = params.push(PEST_TEXT_PATTERN);
  const keysIndex = params.push(excludedIndustryKeys(excluded));
  const text = `SELECT COUNT(*)::int AS n
      FROM prospects p
     WHERE ${COMPANY_PEST_KEY} ~ $${patternIndex}
       AND ${INDUSTRY_PEST_KEY} <> ALL($${keysIndex}::text[])
       AND ${INDUSTRY_PEST_KEY} !~ $${patternIndex}`;
  return { text, values: params };
}

module.exports = {
  PEST_CANONICAL,
  PEST_NAME_REASON,
  PEST_TEXT_PATTERN,
  PEST_COMPANY_PATTERN,
  STREET_BRAND_PATTERN,
  COMPANY_SPACE_PATTERN,
  COMPANY_NAME_LIMIT,
  normalizeIndustry,
  isPestText,
  isPestCompanyName,
  isExcludedIndustry,
  pestCategoryExcluded,
  excludedIndustryKeys,
  appendIndustryExclusion,
  appendCompanyPestExclusion,
  appendDraftExclusion,
  appendATierPestHide,
  legacyPestNameCountQuery,
  isPestPlaceType,
  isPestDiscoveryPlace,
};
