// One pest-control rule for discovery, fit scoring, lead picking, and the
// prospects API. Synonyms collapse to PEST_CANONICAL. Place names and the
// company-name gate use the same words on a boundary, so Pestana, Compest,
// and Best stay in scope. The company check reads the cached name only.

const cfg = require('./config');

const PEST_CANONICAL = 'Pest Control';

// Shown on fit_reasons and returned when drafting is refused. No company name.
const PEST_NAME_REASON = 'Company name matches pest control — out of scope';

// Same normalization as industryKey, for the prospects.company column.
const COMPANY_PEST_KEY = "lower(regexp_replace(btrim(COALESCE(p.company, '')), '\\s+', ' ', 'g'))";
const INDUSTRY_PEST_KEY = "lower(regexp_replace(btrim(COALESCE(p.industry, '')), '\\s+', ' ', 'g'))";

// Lowercased industry text. Word characters are ASCII, matching JS \w and the
// SQL check in appendIndustryExclusion (locale-independent).
const PEST_TEXT_PATTERN = '(^|[^a-z0-9_])(pests?|exterminat(or|ors|ing|ion)?|termites?)([^a-z0-9_]|$)';
const PEST_TEXT_RE = new RegExp(PEST_TEXT_PATTERN);

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

// Cached company name. Same word-boundary pattern as isPestText (ASCII
// boundaries, matching the SQL check and isFranchise's word match). Off when
// Pest Control is not on the exclusion list. Does not fetch.
function isPestCompanyName(company, excluded = cfg.EXCLUDED_INDUSTRIES) {
  if (!pestCategoryExcluded(excluded)) return false;
  return isPestText(company);
}

// SQL fragment. TRUE when the name gate is off. Placeholder numbers continue
// from params.length. The column is the cached company name, not a request.
function appendCompanyPestExclusion(params, excluded = cfg.EXCLUDED_INDUSTRIES) {
  if (!pestCategoryExcluded(excluded)) return 'TRUE';
  const patternIndex = params.push(PEST_TEXT_PATTERN);
  return `${COMPANY_PEST_KEY} !~ $${patternIndex}`;
}

// Industry exclusion plus the company-name gate. pickLeads and the eligible
// count both use this, so a legacy HVAC row with a pest name is not a draft
// candidate even while its stored fit_tier is still A.
function appendDraftExclusion(params, excluded = cfg.EXCLUDED_INDUSTRIES) {
  const industrySql = appendIndustryExclusion(params, excluded);
  const nameSql = appendCompanyPestExclusion(params, excluded);
  return `${industrySql} AND ${nameSql}`;
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
  normalizeIndustry,
  isPestText,
  isPestCompanyName,
  isExcludedIndustry,
  pestCategoryExcluded,
  excludedIndustryKeys,
  appendIndustryExclusion,
  appendCompanyPestExclusion,
  appendDraftExclusion,
  legacyPestNameCountQuery,
  isPestPlaceType,
  isPestDiscoveryPlace,
};
