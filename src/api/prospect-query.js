// WHERE / ORDER BY builder for GET /api/prospects. No database import.
// A tier filter that includes A also hides company-name-gate rows from that result.
// The stored fit_tier is not updated.
const SORTS = require('./prospect-sorts');
const { appendATierPestHide } = require('../scoring/industry');

const CLOSED = ['won', 'lost', 'disqualified'];

// sort: a missing value defaults to `fit`. Any other value that is not an own
// key of SORTS — including prototype names such as constructor, toString, and
// __proto__ — is a 400. Unknown sorts do not fall back to fit.
//
// min_value: omitted or '' applies no filter. Any other value must be a finite
// number >= 0 written as a plain decimal (no sign, exponent, hex, or surrounding
// whitespace). `est_value >= $n` is unknown for NULL, so a set min_value drops
// rows with no estimate. min_value=0 is valid and still drops those NULL rows.

class ProspectQueryError extends Error {
  constructor() {
    super('bad_request');
    this.status = 400;
  }
}

function reject() {
  throw new ProspectQueryError();
}

function sortClause(sort) {
  const key = sort === undefined || sort === null ? 'fit' : sort;
  if (typeof key !== 'string' || !Object.hasOwn(SORTS, key)) reject();
  return SORTS[key];
}

function parseMinValue(raw) {
  if (raw === undefined || raw === null || raw === '') return null;
  if (typeof raw === 'number') {
    if (!Number.isFinite(raw) || raw < 0) reject();
    return raw;
  }
  if (typeof raw !== 'string' || !/^\d+(\.\d+)?$/.test(raw)) reject();
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) reject();
  return n;
}

function buildProspectListQuery(query = {}) {
  const limitRaw = parseInt(query.limit ?? '200', 10);
  const offsetRaw = parseInt(query.offset ?? '0', 10);
  const limit = Math.min(Number.isFinite(limitRaw) && limitRaw > 0 ? limitRaw : 200, 1000);
  const offset = Number.isFinite(offsetRaw) && offsetRaw > 0 ? offsetRaw : 0;

  const where = [];
  const params = [];
  const add = (sql, val) => {
    params.push(val);
    where.push(sql.replace('?', `$${params.length}`));
  };

  const { stage, industry, city, tier, q, min_fit, min_value, has_website } = query;
  if (stage === 'open') add('stage <> ALL(?)', CLOSED);
  else if (stage === 'closed') add('stage = ANY(?)', CLOSED);
  else if (stage) add('stage = ANY(?)', String(stage).split(','));
  if (industry) add('industry = ANY(?)', String(industry).split(','));
  if (city) add('city = ANY(?)', String(city).split(','));
  if (tier) {
    const tiers = String(tier).split(',').map(s => s.trim()).filter(Boolean);
    add('fit_tier = ANY(?)', tiers);
    // A-tier queue only. tier=B and an unfiltered list still return the row.
    if (tiers.includes('A')) {
      const hide = appendATierPestHide(params);
      if (hide !== 'TRUE') where.push(hide);
    }
  }
  if (q) {
    params.push(`%${q}%`);
    const i = params.length;
    where.push(`(company ILIKE $${i} OR contact_name ILIKE $${i} OR phone ILIKE $${i})`);
  }
  if (min_fit) add('fit_score >= ?', parseInt(min_fit, 10));

  const min = parseMinValue(min_value);
  if (min !== null) add('est_value >= ?', min);
  if (has_website === '1') where.push('website IS NOT NULL');

  const whereSql = where.length ? `WHERE ${where.join(' AND ')} ` : '';
  const order = sortClause(query.sort);
  return {
    listSql: `SELECT * FROM prospects ${whereSql}ORDER BY ${order}, id LIMIT ${limit} OFFSET ${offset}`,
    countSql: `SELECT COUNT(*)::int AS n FROM prospects ${whereSql}`.trim(),
    params,
    limit,
    offset,
  };
}

module.exports = { buildProspectListQuery, ProspectQueryError };
