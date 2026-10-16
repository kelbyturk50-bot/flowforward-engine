// Uncached flag resolution. Each database read hits the database.
//
// Database flags (source "db"): a trimmed, case-insensitive "false", "off",
// "0", or "no" forces the flag off. An empty string or an unset variable
// leaves the decision to the row. Any other value, including "true", also
// leaves the decision to the row. Env never forces a database flag on.
// A missing row or a database error is off.
//
// Env-only flags (source "env"): SMS and the open pixel. Effective is on
// only when the env var is exactly "true". A database row is ignored.

const pool = require('../db/client');
const { DB_NAMES, NAMES, isEnvOnly, isWritable } = require('./registry');

const ACTOR = 'crm';
const FORCE_OFF = new Set(['false', 'off', '0', 'no']);

function envForcesOff(name) {
  if (!Object.prototype.hasOwnProperty.call(process.env, name)) return false;
  const raw = process.env[name];
  if (raw == null) return false;
  const folded = String(raw).trim().toLowerCase();
  if (folded === '') return false;
  return FORCE_OFF.has(folded);
}

function envExactlyTrue(name) {
  return process.env[name] === 'true';
}

function stamp(value) {
  if (value == null) return null;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString();
}

function dbView(name, row) {
  const envOff = envForcesOff(name);
  const enabled = row ? row.enabled === true : false;
  return {
    name,
    enabled,
    effective: envOff ? false : enabled,
    env_forced_off: envOff,
    updated_at: row ? stamp(row.updated_at) : null,
    updated_by: row && row.updated_by != null && row.updated_by !== '' ? String(row.updated_by) : null,
    writable: true,
    source: 'db',
  };
}

function envView(name) {
  const on = envExactlyTrue(name);
  return {
    name,
    enabled: on,
    effective: on,
    env_forced_off: false,
    updated_at: null,
    updated_by: null,
    writable: false,
    source: 'env',
  };
}

function offView(name) {
  if (isEnvOnly(name)) return envView(name);
  return dbView(name, null);
}

async function readRows(names) {
  const { rows } = await pool.query(
    `SELECT name, enabled, updated_at, updated_by
       FROM feature_flags
      WHERE name = ANY($1::text[])`,
    [names]
  );
  return rows;
}

async function effective(name) {
  if (isEnvOnly(name)) return envView(name);
  if (!isWritable(name)) return offView(name);
  try {
    const rows = await readRows([name]);
    return dbView(name, rows[0] || null);
  } catch (err) {
    console.error(`[flags] read failed; flag stays off (${err && err.code ? err.code : 'error'})`);
    return dbView(name, null);
  }
}

async function listFlags() {
  let byName = new Map();
  let dbOk = true;
  try {
    const rows = await readRows(DB_NAMES);
    byName = new Map(rows.map((row) => [row.name, row]));
  } catch (err) {
    dbOk = false;
    console.error(`[flags] list failed; database flags stay off (${err && err.code ? err.code : 'error'})`);
  }
  return NAMES.map((name) => {
    if (isEnvOnly(name)) return envView(name);
    if (!dbOk) return dbView(name, null);
    return dbView(name, byName.get(name) || null);
  });
}

async function setFlag(name, enabled) {
  if (!isWritable(name)) return null;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const current = await client.query(
      'SELECT enabled FROM feature_flags WHERE name = $1 FOR UPDATE',
      [name]
    );
    if (!current.rows[0]) {
      await client.query('ROLLBACK');
      return null;
    }
    const oldValue = current.rows[0].enabled === true;
    const updated = await client.query(
      `UPDATE feature_flags
          SET enabled = $2, updated_at = NOW(), updated_by = $3
        WHERE name = $1
        RETURNING name, enabled, updated_at, updated_by`,
      [name, enabled, ACTOR]
    );
    await client.query(
      `INSERT INTO feature_flag_audit (flag, old_value, new_value, actor)
       VALUES ($1, $2, $3, $4)`,
      [name, oldValue, enabled, ACTOR]
    );
    await client.query('COMMIT');
    return dbView(name, updated.rows[0]);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

module.exports = {
  ACTOR,
  envForcesOff,
  envExactlyTrue,
  effective,
  listFlags,
  setFlag,
};
