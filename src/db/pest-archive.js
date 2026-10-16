// Reversible archive for leads the company-name gate already matches.
// schema.sql adds the columns and does not set them. applySchema does not
// call this module. Boot must not: the next deploy would archive again and
// a restore would not stick.
//
// The match is appendCompanyPestExclusion, which is companyNameKeptSql on
// p.company. A folded name longer than 200 code points is included. Rows
// already archived for any other reason are not updated. Each apply stamps
// a new archive_run_id. Undo restores that run only.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const parseConnectionString = require('pg-connection-string').parse;
const {
  PEST_CANONICAL,
  PEST_TEXT_PATTERN,
  appendCompanyPestExclusion,
} = require('../scoring/industry');

const PEST_ARCHIVE_REASON = 'pest-name gate (#39)';
const ARCHIVED_LEAD_REASON = 'This lead is archived';
const RUN_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const CATEGORIES = ['would_archive', 'already_pest_archived', 'skipped_other_reason', 'active_other'];
const BUCKETS = ['other_industry', 'pest_industry'];
const TIERS = ['A', 'B', 'C', 'D', 'none'];

const INDUSTRY_KEY = "lower(regexp_replace(btrim(COALESCE(p.industry, '')), '\\s+', ' ', 'g'))";

function pestIndustryKey() {
  return String(PEST_CANONICAL).trim().replace(/\s+/g, ' ').toLowerCase();
}

function isRunId(value) {
  return typeof value === 'string' && RUN_ID_RE.test(value);
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

function splitHostList(value) {
  const hosts = [];
  let current = '';
  let brackets = 0;
  for (const ch of String(value || '')) {
    if (ch === '[') brackets += 1;
    else if (ch === ']') brackets = Math.max(0, brackets - 1);
    else if (ch === ',' && brackets === 0) {
      if (current.trim()) hosts.push(current.trim());
      current = '';
      continue;
    }
    current += ch;
  }
  if (current.trim()) hosts.push(current.trim());
  return hosts;
}

function normalizeHost(host) {
  let value = String(host || '').trim().toLowerCase();
  if (value.startsWith('[') && value.endsWith(']')) value = value.slice(1, -1);
  return value.replace(/\.$/, '');
}

function isLocalHost(host) {
  const value = normalizeHost(host);
  if (!value) return false;
  if (value.startsWith('/') && !value.startsWith('//')) return true;
  if (value === 'localhost' || value === '::1' || value === '0:0:0:0:0:0:0:1') return true;
  if (value.startsWith('::ffff:')) return isLocalHost(value.slice('::ffff:'.length));
  const parts = value.split('.');
  if (parts.length !== 4 || !parts.every(part => /^\d{1,3}$/.test(part))) return false;
  const nums = parts.map(Number);
  if (nums.some(n => n > 255)) return false;
  return nums[0] === 127;
}

function envText(env, key) {
  if (env[key] == null) return '';
  return String(env[key]).trim();
}

function oneHost(value) {
  const hosts = splitHostList(value);
  if (hosts.length !== 1) return null;
  return hosts[0];
}

// node-postgres (ConnectionParameters): a truthy connection-string host wins,
// otherwise PGHOST, otherwise localhost. It does not read PGHOSTADDR.
// PGDATABASE supplies the database name only when the URL has none.
// A service name, more than one host, or a hostaddr that is not that same
// host can point somewhere else. Those are ambiguous and fail closed.
function archiveTarget(env) {
  const production = env.NODE_ENV === 'production';
  const closed = (ambiguous) => ({
    blocked: true,
    local: false,
    production,
    ambiguous,
    place: 'remote',
  });
  const url = envText(env, 'DATABASE_URL');
  let parsed = {};
  if (url) {
    try {
      parsed = parseConnectionString(url);
    } catch {
      return closed(true);
    }
  }
  if (envText(env, 'PGSERVICE') || (parsed.service && String(parsed.service).trim())) {
    return closed(true);
  }

  const urlHost = String(parsed.host || '').trim();
  const pgHost = envText(env, 'PGHOST');
  const chosenText = urlHost || pgHost || 'localhost';
  const chosen = oneHost(chosenText);
  if (!chosen) return closed(true);

  const extras = [];
  const pgHostAddr = envText(env, 'PGHOSTADDR');
  const urlHostAddr = String(parsed.hostaddr || '').trim();
  if (pgHostAddr) extras.push(pgHostAddr);
  if (urlHostAddr) extras.push(urlHostAddr);
  for (const extra of extras) {
    const host = oneHost(extra);
    if (!host || normalizeHost(host) !== normalizeHost(chosen)) return closed(true);
  }

  const local = isLocalHost(chosen);
  return {
    blocked: production || !local,
    local,
    production,
    ambiguous: false,
    place: local ? 'local' : 'remote',
  };
}

function confirmValue(env) {
  const confirm = env.PEST_ARCHIVE_CONFIRM;
  return typeof confirm === 'string' && confirm.length > 0 ? confirm : null;
}

function refused() {
  const err = new Error('pest-archive refused');
  err.code = 'PEST_ARCHIVE_REFUSED';
  return err;
}

// Opens a transaction and allows the write, or rolls back and throws.
// A blocked target with no confirm throws before any query.
async function beginGuardedWrite(client, env) {
  const target = archiveTarget(env);
  const confirm = confirmValue(env);
  if (target.blocked && !confirm) throw refused();
  await client.query('BEGIN');
  try {
    const { rows } = await client.query('SELECT current_database() AS name');
    const database = rows[0] && rows[0].name;
    if (typeof database !== 'string' || !database) throw new Error('database name rejected');
    if (target.blocked && confirm !== database) {
      await client.query('ROLLBACK');
      throw refused();
    }
    return { place: target.place, database };
  } catch (err) {
    if (err.code !== 'PEST_ARCHIVE_REFUSED') await client.query('ROLLBACK').catch(() => {});
    throw err;
  }
}

function archiveStatement(runId) {
  if (!isRunId(runId)) throw new Error('archive run id rejected');
  const params = [];
  const kept = appendCompanyPestExclusion(params);
  const reasonIndex = params.push(PEST_ARCHIVE_REASON);
  const runIndex = params.push(runId);
  const text = `WITH updated AS (
    UPDATE prospects p
       SET archived_at = NOW(),
           archive_reason = $${reasonIndex},
           archive_run_id = $${runIndex}
     WHERE p.archived_at IS NULL
       AND p.archive_reason IS NULL
       AND p.archive_run_id IS NULL
       AND NOT (${kept})
    RETURNING 1
  )
  SELECT COUNT(*)::int AS n FROM updated`;
  return { text, values: params };
}

function unarchiveSql() {
  const sql = fs.readFileSync(path.join(__dirname, 'pest-archive-undo.sql'), 'utf8');
  if (!sql.includes(PEST_ARCHIVE_REASON)) throw new Error('undo sql rejected');
  if (!sql.includes('archive_run_id = $1')) throw new Error('undo sql rejected');
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
    WHEN p.archived_at IS NULL AND p.archive_reason IS NULL AND p.archive_run_id IS NULL AND NOT (${kept}) THEN 'would_archive'
    WHEN p.archive_reason = $${reasonIndex} THEN 'already_pest_archived'
    WHEN p.archived_at IS NOT NULL OR p.archive_reason IS NOT NULL OR p.archive_run_id IS NOT NULL THEN 'skipped_other_reason'
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

async function runDry(client, opts = {}) {
  const own = !opts.joined;
  if (own) await client.query('BEGIN READ ONLY');
  try {
    const { text, values } = dryRunQuery();
    const { rows } = await client.query(text, values);
    if (own) await client.query('COMMIT');
    return renderDryRun(rows);
  } catch (err) {
    if (own) await client.query('ROLLBACK').catch(() => {});
    throw err;
  }
}

async function setWriteTimeouts(client) {
  await client.query("SET LOCAL lock_timeout = '5s'");
  await client.query("SET LOCAL statement_timeout = '15s'");
}

async function runApply(client, opts = {}) {
  const own = !opts.joined;
  if (own) await client.query('BEGIN');
  try {
    await setWriteTimeouts(client);
    const runId = crypto.randomUUID();
    const { text, values } = archiveStatement(runId);
    const { rows } = await client.query(text, values);
    const n = rows[0] && rows[0].n;
    if (!Number.isInteger(n) || n < 0) throw new Error('archive count rejected');
    if (own) await client.query('COMMIT');
    return { n, runId };
  } catch (err) {
    if (own) await client.query('ROLLBACK').catch(() => {});
    throw err;
  }
}

async function runUndo(client, runId, opts = {}) {
  if (!isRunId(runId)) throw new Error('archive run id rejected');
  const own = !opts.joined;
  if (own) await client.query('BEGIN');
  try {
    await setWriteTimeouts(client);
    const { rows } = await client.query(unarchiveSql(), [runId]);
    const n = rows[0] && rows[0].n;
    if (!Number.isInteger(n) || n < 0) throw new Error('undo count rejected');
    if (own) await client.query('COMMIT');
    return n;
  } catch (err) {
    if (own) await client.query('ROLLBACK').catch(() => {});
    throw err;
  }
}

module.exports = {
  PEST_ARCHIVE_REASON,
  ARCHIVED_LEAD_REASON,
  CATEGORIES,
  BUCKETS,
  TIERS,
  isRunId,
  isArchivedLead,
  notArchivedSql,
  archiveTarget,
  confirmValue,
  beginGuardedWrite,
  archiveStatement,
  unarchiveSql,
  dryRunQuery,
  renderDryRun,
  runDry,
  runApply,
  runUndo,
};
