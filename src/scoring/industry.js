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

// National brands. Company-name gate only, so an industry value of "Hawx" or
// "Terminix" is not a pest synonym and computeFit does not change. Whitespace
// is collapsed before the match. A run of spaces or hyphens separates a
// multi-word brand. TrulyNolen is the same brand with no separator. The JS
// check and appendCompanyPestExclusion both use PEST_COMPANY_PATTERN.
const PEST_BRAND_ALTERNATION = [
  'terminix',
  'orkin',
  'rentokil',
  'aptive',
  'truly[- ]*nolen',
  'rollins',
  'ecolab[- ]+pest',
  'arrow[- ]+exterminators',
  'western[- ]+exterminator',
  'massey[- ]+services',
  'hawx',
  'moxie[- ]+pest',
  'bulwark[- ]+exterminating',
].join('|');
const PEST_COMPANY_PATTERN = `(^|[^a-z0-9_])(${PEST_WORD_ALTERNATION}|${PEST_BRAND_ALTERNATION})([^a-z0-9_]|$)`;
const PEST_COMPANY_RE = new RegExp(PEST_COMPANY_PATTERN);

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

// Cached company name. Pest words plus the national-brand list, on ASCII
// boundaries, matching appendCompanyPestExclusion. Off when Pest Control is
// not on the exclusion list. Does not fetch and does not score the row.
function isPestCompanyName(company, excluded = cfg.EXCLUDED_INDUSTRIES) {
  if (!pestCategoryExcluded(excluded)) return false;
  const key = industryKey(company);
  return key !== '' && PEST_COMPANY_RE.test(key);
}

// SQL fragment. TRUE when the name gate is off. Placeholder numbers continue
// from params.length. The column is the cached company name, not a request.
// The bound pattern is PEST_COMPANY_PATTERN, the same one isPestCompanyName uses.
function appendCompanyPestExclusion(params, excluded = cfg.EXCLUDED_INDUSTRIES) {
  if (!pestCategoryExcluded(excluded)) return 'TRUE';
  const patternIndex = params.push(PEST_COMPANY_PATTERN);
  return `${COMPANY_PEST_KEY} !~ $${patternIndex}`;
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
