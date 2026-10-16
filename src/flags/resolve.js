// Uncached flag resolution. Each read hits the database.
//
// Env is a kill switch only. A trimmed, case-insensitive "false" forces the
// flag off. Any other value, including "true", or an unset variable, leaves
// the decision to the database row. Env never forces a flag on.
// A missing row or a database error is off.

const pool = require('../db/client');
const { NAMES, isKnown } = require('./registry');

const ACTOR = 'crm';

function envForcesOff(name) {
  if (!Object.prototype.hasOwnProperty.call(process.env, name)) return false;
  const raw = process.env[name];
  if (raw == null) return false;
  return String(raw).trim().toLowerCase() === 'false';
}

function stamp(value) {
  if (value == null) return null;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString();
}

function toView(name, row) {
  const envOff = envForcesOff(name);
  const enabled = row ? row.enabled === true : false;
  return {
    name,
    enabled,
    effective: envOff ? false : enabled,
    env_forced_off: envOff,
    updated_at: row ? stamp(row.updated_at) : null,
    updated_by: row && row.updated_by != null && row.updated_by !== '' ? String(row.updated_by) : null,
  };
}

function offView(name) {
  return toView(name, null);
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
  if (!isKnown(name)) return offView(name);
  try {
    const rows = await readRows([name]);
    return toView(name, rows[0] || null);
  } catch (err) {
    console.error(`[flags] read failed; flag stays off (${err && err.code ? err.code : 'error'})`);
    return offView(name);
  }
}

async function listFlags() {
  try {
    const rows = await readRows(NAMES);
    const byName = new Map(rows.map((row) => [row.name, row]));
    return NAMES.map((name) => toView(name, byName.get(name) || null));
  } catch (err) {
    console.error(`[flags] list failed; flags stay off (${err && err.code ? err.code : 'error'})`);
    return NAMES.map((name) => offView(name));
  }
}

async function setFlag(name, enabled) {
  if (!isKnown(name)) return null;
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
    return toView(name, updated.rows[0]);
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
  effective,
  listFlags,
  setFlag,
};
