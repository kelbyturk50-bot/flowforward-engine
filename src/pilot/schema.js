// Checks the pilot tables after pilot-schema.sql has committed.
// That file runs in its own transaction, after schema.sql. A caught repair
// error is written to pilot_boot_errors and does not roll back schema.sql.
// A failure closes the pilot; the rest of the API keeps serving.

const pool = require('../db/client');
const tokens = require('./tokens');

function redact(text) {
  let out = String(text == null ? '' : text);
  const secret = process.env.CRM_API_KEY;
  if (typeof secret === 'string' && secret.length > 0) out = out.split(secret).join('[redacted]');
  return out;
}

async function readPilotSchemaStatus() {
  const failures = [];
  try {
    const index = await pool.query(
      `SELECT i.indisunique, i.indisvalid, i.indisready
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
         JOIN pg_index i ON i.indexrelid = c.oid
        WHERE n.nspname = 'public'
          AND c.relname = 'idx_pilot_tokens_one_active'`
    );
    if (!index.rows.length) {
      failures.push('idx_pilot_tokens_one_active is missing');
    } else {
      const row = index.rows[0];
      if (row.indisunique !== true) failures.push('idx_pilot_tokens_one_active is not unique');
      if (row.indisvalid !== true) failures.push('idx_pilot_tokens_one_active is not valid');
      if (row.indisready !== true) failures.push('idx_pilot_tokens_one_active is not ready');
    }
  } catch (err) {
    failures.push(`idx_pilot_tokens_one_active check failed: ${err.message}`);
  }

  try {
    const column = await pool.query(
      `SELECT a.attnotnull
         FROM pg_attribute a
         JOIN pg_class c ON c.oid = a.attrelid
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public'
          AND c.relname = 'pilot_tokens'
          AND a.attname = 'generation'
          AND a.attnum > 0
          AND NOT a.attisdropped`
    );
    if (!column.rows.length) failures.push('pilot_tokens.generation is missing');
    else if (column.rows[0].attnotnull !== true) failures.push('pilot_tokens.generation is nullable');
  } catch (err) {
    failures.push(`pilot_tokens.generation check failed: ${err.message}`);
  }

  try {
    const duplicates = await pool.query(
      `SELECT COUNT(*)::int AS proposals
         FROM (
           SELECT proposal_id
             FROM pilot_tokens
            WHERE revoked_at IS NULL
            GROUP BY proposal_id
           HAVING COUNT(*) > 1
         ) d`
    );
    const proposals = Number(duplicates.rows[0].proposals);
    if (proposals > 0) {
      failures.push(`${proposals} proposals have more than one active demo token`);
    }
  } catch (err) {
    failures.push(`active demo token check failed: ${err.message}`);
  }

  try {
    const legacy = await pool.query(
      `SELECT COUNT(*)::int AS n
         FROM pilot_tokens
        WHERE revoked_at IS NULL
          AND (derived IS NOT TRUE OR generation IS NULL)`
    );
    const n = Number(legacy.rows[0].n);
    if (n > 0) failures.push(`${n} active demo tokens are not HMAC-derived`);
  } catch (err) {
    failures.push(`HMAC demo token check failed: ${err.message}`);
  }

  return { ok: failures.length === 0, failures };
}

function collectFailures(report, status) {
  const failures = [...(status.failures || [])];
  for (const item of (report && report.errors) || []) failures.push(item);
  const joined = failures.join('\n');
  for (const note of (report && report.notices) || []) {
    if (note && !joined.includes(note)) failures.push(note);
  }
  return failures.map(redact).filter(Boolean);
}

async function concludeSchemaBoot(report) {
  // The pilot transaction rolled back (lock timeout, statement timeout, or
  // another error). Its SET LOCAL limits are gone. Reading pilot_tokens now
  // can wait on the same lock and the process would never listen. The
  // failure is already in the report; leave the pilot closed.
  if (report && (report.timedOut || report.rolledBack)) {
    const failures = collectFailures(report, { failures: [] });
    const detail = failures.join('; ').slice(0, 2000);
    tokens.closePilot();
    console.error(`[pilot] schema is not safe — the estimate-recovery demo stays off. ${detail}`);
    return { ok: false, failures };
  }
  const status = await readPilotSchemaStatus();
  const failures = collectFailures(report, status);
  if (failures.length) {
    const detail = failures.join('; ').slice(0, 2000);
    tokens.closePilot();
    console.error(`[pilot] schema is not safe — the estimate-recovery demo stays off. ${detail}`);
    return { ok: false, failures };
  }
  tokens.openPilot();
  console.log('[server] ✓ Schema up to date');
  return { ok: true, failures: [] };
}

module.exports = {
  readPilotSchemaStatus,
  concludeSchemaBoot,
};
