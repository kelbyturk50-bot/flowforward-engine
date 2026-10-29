// Voice demo minutes, in Postgres. One row per call in voice_demo_calls.
//
// A call reserves its full maximum (VOICE_CAPS.maxCallSeconds) before Retell
// is asked for it. The Retell call_ended webhook settles the row to the real
// length. A row with no end event keeps its full reservation counted, so a
// missing webhook can only make the caps stricter, never looser.
//
// Every reservation runs under one transaction-scoped advisory lock, so two
// mints cannot both pass the same cap. Days are America/Denver days.

const crypto = require('crypto');
const pool = require('../db/client');
const { zoneDay, FLOWFORWARD_ZONE } = require('../chatdemo/copy');
const { VOICE_CAPS } = require('./config');

const LOCK_ID = 89089042;

// Seconds a row counts against a budget.
const COUNTED = `CASE status
  WHEN 'ended' THEN COALESCE(actual_seconds, reserved_seconds)
  WHEN 'failed' THEN 0
  ELSE reserved_seconds END`;

async function reserve({ prototypeId, dailySeconds, now = new Date() }) {
  const caps = VOICE_CAPS;
  const day = zoneDay(now, FLOWFORWARD_ZONE);
  const staleBefore = new Date(now.getTime() - caps.reservationTtlMs);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock($1)', [LOCK_ID]);
    await client.query(
      `UPDATE voice_demo_calls SET status = 'expired'
        WHERE status = 'reserved' AND created_at < $1`,
      [staleBefore]
    );
    const link = await client.query(
      `SELECT COUNT(*)::int AS calls, COALESCE(SUM(${COUNTED}), 0)::int AS seconds
         FROM voice_demo_calls
        WHERE prototype_id = $1 AND status <> 'failed'`,
      [prototypeId]
    );
    if (link.rows[0].calls >= caps.callsPerLink
      || link.rows[0].seconds + caps.maxCallSeconds > caps.secondsPerLink) {
      await client.query('ROLLBACK');
      return { capped: 'link' };
    }
    const today = await client.query(
      `SELECT COALESCE(SUM(${COUNTED}), 0)::int AS seconds
         FROM voice_demo_calls
        WHERE day = $1`,
      [day]
    );
    if (today.rows[0].seconds + caps.maxCallSeconds > dailySeconds) {
      await client.query('ROLLBACK');
      return { capped: 'day' };
    }
    // A call cannot outlive its maximum, so an unsettled row stops counting
    // as live a minute after that, even with no webhook.
    const liveSince = new Date(now.getTime() - (caps.maxCallSeconds + 60) * 1000);
    const live = await client.query(
      `SELECT COUNT(*)::int AS n FROM voice_demo_calls WHERE status = 'reserved' AND created_at > $1`,
      [liveSince]
    );
    if (live.rows[0].n >= caps.concurrentCalls) {
      await client.query('ROLLBACK');
      return { capped: 'busy' };
    }
    const id = crypto.randomUUID();
    await client.query(
      `INSERT INTO voice_demo_calls (id, prototype_id, status, reserved_seconds, day, created_at)
       VALUES ($1, $2, 'reserved', $3, $4, $5)`,
      [id, prototypeId, caps.maxCallSeconds, day, now]
    );
    await client.query('COMMIT');
    return {
      id,
      callsLeft: caps.callsPerLink - link.rows[0].calls - 1,
    };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

async function attachCall(id, callId) {
  await pool.query(
    `UPDATE voice_demo_calls SET call_id = $2 WHERE id = $1 AND call_id IS NULL`,
    [id, callId]
  );
}

// Retell refused or never answered: the minutes were not used.
async function failCall(id) {
  await pool.query(
    `UPDATE voice_demo_calls SET status = 'failed', ended_at = NOW() WHERE id = $1 AND status = 'reserved'`,
    [id]
  );
}

// From the call_ended webhook. Idempotent: a retry finds the row settled.
async function settleCall(callId, seconds, endedAt = new Date()) {
  const result = await pool.query(
    `UPDATE voice_demo_calls
        SET status = 'ended', actual_seconds = $2, ended_at = $3
      WHERE call_id = $1 AND status IN ('reserved', 'expired')`,
    [callId, seconds, endedAt]
  );
  return result.rowCount;
}

// What one link has left, for the public availability read.
async function linkUsage(prototypeId) {
  const { rows } = await pool.query(
    `SELECT COUNT(*)::int AS calls, COALESCE(SUM(${COUNTED}), 0)::int AS seconds
       FROM voice_demo_calls
      WHERE prototype_id = $1 AND status <> 'failed'`,
    [prototypeId]
  );
  const calls = rows[0].calls;
  const seconds = rows[0].seconds;
  const left = calls < VOICE_CAPS.callsPerLink && seconds + VOICE_CAPS.maxCallSeconds <= VOICE_CAPS.secondsPerLink
    ? Math.min(VOICE_CAPS.callsPerLink - calls, Math.floor((VOICE_CAPS.secondsPerLink - seconds) / VOICE_CAPS.maxCallSeconds))
    : 0;
  return { calls, seconds, callsLeft: left };
}

// Today's minutes, for the CRM readout.
async function dayUsage(now = new Date()) {
  const day = zoneDay(now, FLOWFORWARD_ZONE);
  const { rows } = await pool.query(
    `SELECT COUNT(*) FILTER (WHERE status <> 'failed')::int AS calls,
            COALESCE(SUM(CASE WHEN status = 'ended' THEN COALESCE(actual_seconds, 0) ELSE 0 END), 0)::int AS used_seconds,
            COALESCE(SUM(CASE WHEN status IN ('reserved', 'expired') THEN reserved_seconds ELSE 0 END), 0)::int AS held_seconds
       FROM voice_demo_calls
      WHERE day = $1`,
    [day]
  );
  return { day, ...rows[0] };
}

module.exports = { reserve, attachCall, failCall, settleCall, linkUsage, dayUsage, LOCK_ID };
