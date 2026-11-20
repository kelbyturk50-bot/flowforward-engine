// Marker and outcome writes. The flag is read by the route before this
// module opens a transaction. Nothing here sends mail.

const { withClient } = require('../db/with-client');
const { lockLeadForUpdate, isDeadlock, DEADLOCK_ATTEMPTS } = require('../proposals/lead-lock');
const { completeOpenTasksForProspect } = require('../demo-view/store');
const { raiseManualDoNotContact } = require('../prospects/manual-dnc');
const { now } = require('./clock');
const { backOn, summarize, OUTCOME_BODIES } = require('./schedule');

const KINDS = new Set(['call', 'walk_in']);
const OUTCOMES = new Set(OUTCOME_BODIES);
const PIPELINE = ['found', 'contacted', 'responded', 'qualified', 'proposal'];
const TALKED_STAGE = 'responded';
// The pipeline has no booked-meeting stage. qualified is the next stage
// after responded and the hot-pipeline stage a booked audit lands on.
const AUDIT_STAGE = 'qualified';
const LOST_STAGE = 'lost';

function httpError(status, error) {
  const err = new Error(error);
  err.status = status;
  err.code = error;
  return err;
}

function parseProspectId(raw) {
  if (typeof raw !== 'string' || !/^[1-9]\d*$/.test(raw)) return null;
  const n = Number(raw);
  if (!Number.isSafeInteger(n) || n > 2147483647) return null;
  return n;
}

function stamp(value) {
  return new Date(value).toISOString();
}

async function withLead(id, fn) {
  let last = null;
  for (let attempt = 1; attempt <= DEADLOCK_ATTEMPTS; attempt += 1) {
    try {
      return await withClient('call-list', async (client) => {
        await client.query('BEGIN');
        try {
          await lockLeadForUpdate(client, id);
          const found = await client.query('SELECT * FROM prospects WHERE id = $1', [id]);
          if (!found.rows[0]) throw httpError(404, 'not_found');
          const result = await fn(client, found.rows[0]);
          await client.query('COMMIT');
          return result;
        } catch (err) {
          await client.query('ROLLBACK').catch(() => {});
          throw err;
        }
      });
    } catch (err) {
      last = err;
      if (isDeadlock(err) && attempt < DEADLOCK_ATTEMPTS) continue;
      throw err;
    }
  }
  throw last;
}

function markerBody(row, at) {
  return {
    call_list_kind: row.call_list_kind,
    call_list_set_at: stamp(at || row.call_list_set_at),
  };
}

async function setMarker(id, kind) {
  if (!KINDS.has(kind)) throw httpError(400, 'invalid_kind');
  const at = now();
  return withLead(id, async (client, row) => {
    if (row.do_not_contact) throw httpError(409, 'do_not_contact');
    if (row.archived_at) throw httpError(409, 'archived');
    const updated = await client.query(
      `UPDATE prospects
          SET call_list_kind = $2, call_list_set_at = $3
        WHERE id = $1
        RETURNING call_list_kind, call_list_set_at`,
      [id, kind, at]
    );
    return markerBody(updated.rows[0], at);
  });
}

async function excludeMarker(id) {
  const at = now();
  return withLead(id, async (client) => {
    const updated = await client.query(
      `UPDATE prospects
          SET call_list_kind = 'excluded', call_list_set_at = $2
        WHERE id = $1
        RETURNING call_list_kind, call_list_set_at`,
      [id, at]
    );
    return markerBody(updated.rows[0], at);
  });
}

function nextStage(current, outcome) {
  if (outcome === 'talked') return forward(current, TALKED_STAGE);
  if (outcome === 'audit_booked') return forward(current, AUDIT_STAGE);
  if (outcome === 'not_interested') {
    if (PIPELINE.includes(current)) return LOST_STAGE;
    return current;
  }
  return current;
}

function forward(current, target) {
  const from = PIPELINE.indexOf(current);
  const to = PIPELINE.indexOf(target);
  if (from === -1 || to === -1) return current;
  if (from < to) return target;
  return current;
}

function readOutcomeBody(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw httpError(400, 'invalid_outcome');
  }
  if (!OUTCOMES.has(body.outcome)) throw httpError(400, 'invalid_outcome');
  if (!KINDS.has(body.kind)) throw httpError(400, 'invalid_kind');
  return { outcome: body.outcome, kind: body.kind };
}

async function priorStreak(client, id) {
  const { rows } = await client.query(
    `SELECT body
       FROM prospect_activities
      WHERE prospect_id = $1
        AND type IN ('call', 'visit')
        AND body = ANY($2::text[])
      ORDER BY created_at DESC, id DESC`,
    [id, OUTCOME_BODIES]
  );
  return summarize(rows).attempts;
}

async function recordOutcome(id, body) {
  const { outcome, kind } = readOutcomeBody(body);
  const at = now();
  const activityType = kind === 'walk_in' ? 'visit' : 'call';
  return withLead(id, async (client, row) => {
    const before = await priorStreak(client, id);
    const attempts = (outcome === 'no_answer' || outcome === 'voicemail') ? before + 1 : before;
    const inserted = await client.query(
      `INSERT INTO prospect_activities (prospect_id, type, body, created_at)
       VALUES ($1, $2, $3, $4)
       RETURNING id`,
      [id, activityType, outcome, at]
    );
    let stage = row.stage;
    if (outcome === 'do_not_contact') {
      await raiseManualDoNotContact(client, id);
    } else {
      const moved = nextStage(stage, outcome);
      if (moved !== stage) {
        await client.query(
          `INSERT INTO prospect_activities (prospect_id, type, body, created_at)
           VALUES ($1, 'stage_change', $2, $3)`,
          [id, `${stage} → ${moved}`, at]
        );
        stage = moved;
      }
    }
    await client.query(
      `UPDATE prospects SET stage = $2, last_contacted_at = $3 WHERE id = $1`,
      [id, stage, at]
    );
    await completeOpenTasksForProspect(client, id, at);
    const effect = (outcome === 'no_answer' || outcome === 'voicemail' || outcome === 'talked')
      ? { removed: true, back_on: backOn(outcome, at, attempts) }
      : { removed: true, back_on: null };
    return {
      activity_id: Number(inserted.rows[0].id),
      removed: effect.removed,
      back_on: effect.back_on,
      stage,
    };
  });
}

module.exports = {
  parseProspectId,
  setMarker,
  excludeMarker,
  readOutcomeBody,
  recordOutcome,
  nextStage,
  AUDIT_STAGE,
  TALKED_STAGE,
};
