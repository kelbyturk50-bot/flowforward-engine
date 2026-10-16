// Reversible archive for leads the company-name gate already matches.
// schema.sql adds the columns and does not set them. applySchema does not
// call this module. Boot must not: the next deploy would archive again and
// a restore would not stick.
//
// The match is appendCompanyPestExclusion, which is companyNameKeptSql on
// p.company. A folded name longer than 200 code points is included. Rows
// already archived for any other reason are not updated.

const fs = require('fs');
const path = require('path');
const {
  PEST_CANONICAL,
  PEST_TEXT_PATTERN,
  appendCompanyPestExclusion,
} = require('../scoring/industry');

const PEST_ARCHIVE_REASON = 'pest-name gate (#39)';
const ARCHIVED_LEAD_REASON = 'This lead is archived';

const CATEGORIES = ['would_archive', 'already_pest_archived', 'skipped_other_reason', 'active_other'];
const BUCKETS = ['other_industry', 'pest_industry'];
const TIERS = ['A', 'B', 'C', 'D', 'none'];

const INDUSTRY_KEY = "lower(regexp_replace(btrim(COALESCE(p.industry, '')), '\\s+', ' ', 'g'))";

function pestIndustryKey() {
  return String(PEST_CANONICAL).trim().replace(/\s+/g, ' ').toLowerCase();
}

function isArchivedLead(row) {
  return !!(row && row.archived_at != null);
}

function notArchivedSql(alias = '') {
  if (alias !== '' && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(alias)) {
    throw new Error('bad alias');
  }
  const prefix = alias ? `${alias}.` : '';
  return `${prefix}archived_at IS NULL`;
}

function archiveStatement() {
  const params = [];
  const kept = appendCompanyPestExclusion(params);
  const reasonIndex = params.push(PEST_ARCHIVE_REASON);
  const text = `WITH updated AS (
    UPDATE prospects p
       SET archived_at = NOW(),
           archive_reason = $${reasonIndex}
     WHERE p.archived_at IS NULL
       AND p.archive_reason IS NULL
       AND NOT (${kept})
    RETURNING 1
  )
  SELECT COUNT(*)::int AS n FROM updated`;
  return { text, values: params };
}

function unarchiveSql() {
  const sql = fs.readFileSync(path.join(__dirname, 'pest-archive-undo.sql'), 'utf8');
  if (!sql.includes(PEST_ARCHIVE_REASON)) throw new Error('undo sql rejected');
  if (/DELETE\s+FROM/i.test(sql)) throw new Error('undo sql rejected');
  return sql;
}

function dryRunQuery() {
  const params = [];
  const reasonIndex = params.push(PEST_ARCHIVE_REASON);
  const kept = appendCompanyPestExclusion(params);
  const patternIndex = params.push(PEST_TEXT_PATTERN);
  const keyIndex = params.push(pestIndustryKey());
  const category = `CASE
    WHEN p.archived_at IS NULL AND p.archive_reason IS NULL AND NOT (${kept}) THEN 'would_archive'
    WHEN p.archive_reason = $${reasonIndex} THEN 'already_pest_archived'
    WHEN p.archived_at IS NOT NULL OR p.archive_reason IS NOT NULL THEN 'skipped_other_reason'
    ELSE 'active_other'
  END`;
  const bucket = `CASE
    WHEN ${INDUSTRY_KEY} = $${keyIndex} OR ${INDUSTRY_KEY} ~ $${patternIndex} THEN 'pest_industry'
    ELSE 'other_industry'
  END`;
  const tier = `CASE WHEN p.fit_tier IN ('A','B','C','D') THEN p.fit_tier ELSE 'none' END`;
  const text = `SELECT ${category} AS category, ${bucket} AS industry_bucket, ${tier} AS tier, COUNT(*)::int AS n
    FROM prospects p
    GROUP BY 1, 2, 3`;
  return { text, values: params };
}

function renderDryRun(rows) {
  const counts = new Map();
  for (const category of CATEGORIES) {
    for (const bucket of BUCKETS) {
      for (const tier of TIERS) counts.set(`${category} ${bucket} ${tier}`, 0);
    }
  }
  for (const row of rows) {
    const key = `${row.category} ${row.industry_bucket} ${row.tier}`;
    if (!counts.has(key) || !Number.isInteger(row.n) || row.n < 0) {
      throw new Error('dry-run row rejected');
    }
    counts.set(key, row.n);
  }
  return [...counts.keys()].map(key => `${key} ${counts.get(key)}`).join('\n') + '\n';
}

async function runDry(client) {
  await client.query('BEGIN READ ONLY');
  try {
    const { text, values } = dryRunQuery();
    const { rows } = await client.query(text, values);
    await client.query('COMMIT');
    return renderDryRun(rows);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  }
}

async function runApply(client) {
  await client.query('BEGIN');
  try {
    const { text, values } = archiveStatement();
    const { rows } = await client.query(text, values);
    const n = rows[0] && rows[0].n;
    if (!Number.isInteger(n) || n < 0) throw new Error('archive count rejected');
    await client.query('COMMIT');
    return n;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  }
}

async function runUndo(client) {
  await client.query('BEGIN');
  try {
    const { rows } = await client.query(unarchiveSql());
    const n = rows[0] && rows[0].n;
    if (!Number.isInteger(n) || n < 0) throw new Error('undo count rejected');
    await client.query('COMMIT');
    return n;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  }
}

module.exports = {
  PEST_ARCHIVE_REASON,
  ARCHIVED_LEAD_REASON,
  CATEGORIES,
  BUCKETS,
  TIERS,
  isArchivedLead,
  notArchivedSql,
  archiveStatement,
  unarchiveSql,
  dryRunQuery,
  renderDryRun,
  runDry,
  runApply,
  runUndo,
};
