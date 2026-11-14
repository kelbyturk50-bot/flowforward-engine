// View log and Today tasks for a real one-pager or live-demo view.
//
// The log stores a coarse UA class and an HMAC of the client bucket plus
// that class. The HMAC key is a random 32-byte salt created once and kept
// in app_settings under proposal_view_fp_salt. The salt is not logged.
// Rows older than 120 days are deleted. No raw IP and no full user-agent
// are written.
//
// Task rows are written only while FF_DEMO_VIEW_TASK is on. The log is
// written either way. This module does not import the mail transport.

const crypto = require('crypto');
const pool = require('../db/client');
const { withClient } = require('../db/with-client');
const { bucketAddress } = require('../pilot/rate-limit');
const { demoViewTaskOn } = require('./flag');
const { uaClass, exclusionReason } = require('./classify');
const { viewFromRequest } = require('./http');

const SALT_KEY = 'proposal_view_fp_salt';
const BURST_LOCK = 89089031;
// Issue #131 AC 2 said 10 minutes. Canyon proposed 2 hours and Summit
// signed off on Nov 14, 2026. The Oct 20 audit was spread across the
// evening. One client opening 3 or more distinct proposals is an audit,
// not a lead. A wider window only drops tasks.
const BURST_WINDOW = '2 hours';
const PURGE_DAYS = 120;
const CALL_REF = /^demo-view-task:[1-9][0-9]{0,17}$/;

let nowFn = () => new Date();

function _setClockForTests(fn) {
  if (process.env.NODE_ENV !== 'test') throw new Error('test only');
  nowFn = typeof fn === 'function' ? fn : () => new Date();
}

function readSalt(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value.salt;
  if (typeof raw !== 'string' || raw.length < 40 || raw.length > 88) return null;
  const buf = Buffer.from(raw, 'base64');
  if (buf.length !== 32) return null;
  return buf;
}

async function loadSalt(db = pool) {
  const existing = await db.query('SELECT value FROM app_settings WHERE key = $1', [SALT_KEY]);
  const found = readSalt(existing.rows[0] && existing.rows[0].value);
  if (found) return found;
  const fresh = crypto.randomBytes(32);
  await db.query(
    `INSERT INTO app_settings (key, value, updated_at)
     VALUES ($1, $2::jsonb, NOW())
     ON CONFLICT (key) DO NOTHING`,
    [SALT_KEY, JSON.stringify({ salt: fresh.toString('base64') })]
  );
  const again = await db.query('SELECT value FROM app_settings WHERE key = $1', [SALT_KEY]);
  const stored = readSalt(again.rows[0] && again.rows[0].value);
  if (!stored) {
    const err = new Error('salt');
    err.code = 'salt';
    throw err;
  }
  return stored;
}

function fingerprint(salt, ip, klass) {
  const bucket = bucketAddress(ip || 'unknown');
  return crypto.createHmac('sha256', salt).update(`${bucket}\n${klass}`).digest('hex');
}

async function purgeViewLog(now = new Date()) {
  const at = now instanceof Date ? now : new Date(now);
  const { rowCount } = await pool.query(
    `DELETE FROM proposal_view_log
      WHERE viewed_at < $1::timestamptz - make_interval(days => $2::int)`,
    [at, PURGE_DAYS]
  );
  return rowCount;
}

async function demoLinkExpired(client, prospectId, proposalId, at) {
  const { rows } = await client.query(
    `SELECT
       EXISTS (
         SELECT 1 FROM prototypes
          WHERE prospect_id = $1
            AND revoked_at IS NULL
            AND expires_at <= $3::timestamptz
       )
       OR EXISTS (
         SELECT 1 FROM pilot_tokens
          WHERE proposal_id = $2
            AND revoked_at IS NULL
            AND expires_at <= $3::timestamptz
       ) AS expired`,
    [prospectId, proposalId, at]
  );
  return rows[0] && rows[0].expired === true;
}

async function qualifyingStats(client, proposalId, closedAt) {
  const { rows } = await client.query(
    `SELECT
       (SELECT COUNT(*)::int
          FROM proposal_view_log
         WHERE proposal_id = $1
           AND excluded_reason IS NULL
           AND ($2::timestamptz IS NULL OR viewed_at > $2::timestamptz + interval '7 days')) AS n,
       (SELECT viewed_at
          FROM proposal_view_log
         WHERE proposal_id = $1
           AND excluded_reason IS NULL
           AND ($2::timestamptz IS NULL OR viewed_at > $2::timestamptz + interval '7 days')
         ORDER BY viewed_at DESC, id DESC
         LIMIT 1) AS last_viewed_at,
       (SELECT source
          FROM proposal_view_log
         WHERE proposal_id = $1
           AND excluded_reason IS NULL
           AND ($2::timestamptz IS NULL OR viewed_at > $2::timestamptz + interval '7 days')
         ORDER BY viewed_at DESC, id DESC
         LIMIT 1) AS source`,
    [proposalId, closedAt]
  );
  return rows[0] || { n: 0, last_viewed_at: null, source: null };
}

async function syncTask(client, proposalId, at) {
  if (!demoViewTaskOn()) return;
  const who = await client.query('SELECT prospect_id FROM proposals WHERE id = $1', [proposalId]);
  if (!who.rows[0]) return;
  const prospectId = who.rows[0].prospect_id;
  await client.query('SELECT id FROM prospects WHERE id = $1 FOR UPDATE', [prospectId]);
  const locked = await client.query(
    `SELECT pr.id, pr.prospect_id,
            (
              pr.sent_at IS NOT NULL
              AND pr.status IN ('sent', 'finished', 'stopped')
              AND pr.replied_at IS NULL
              AND p.archived_at IS NULL
              AND p.do_not_contact = FALSE
              AND COALESCE(p.stage, '') <> 'responded'
              AND NOT EXISTS (
                SELECT 1 FROM campaign_touches t
                 WHERE t.lead_id = p.id AND t.type = 'call_booked'
              )
            ) AS eligible
       FROM proposals pr
       JOIN prospects p ON p.id = pr.prospect_id
      WHERE pr.id = $1
      FOR UPDATE OF pr`,
    [proposalId]
  );
  if (!locked.rows[0]) return;
  const eligible = locked.rows[0].eligible === true;

  const closed = await client.query(
    `SELECT MAX(COALESCE(done_at, dismissed_at)) AS closed_at
       FROM proposal_view_tasks
      WHERE proposal_id = $1 AND status IN ('done', 'dismissed')`,
    [proposalId]
  );
  const closedAt = closed.rows[0] ? closed.rows[0].closed_at : null;
  const stats = await qualifyingStats(client, proposalId, closedAt);
  const n = stats.n || 0;
  const open = await client.query(
    `SELECT id FROM proposal_view_tasks
      WHERE proposal_id = $1 AND status = 'open'
      FOR UPDATE`,
    [proposalId]
  );
  const openId = open.rows[0] ? open.rows[0].id : null;

  if (openId && n === 0) {
    await client.query(`DELETE FROM proposal_view_tasks WHERE id = $1 AND status = 'open'`, [openId]);
  }
  if (!eligible || n < 1) return;
  if (!openId && closedAt && n < 2) return;

  const expired = await demoLinkExpired(client, prospectId, proposalId, at);
  // One statement. A caught 23505 would abort this transaction, so the
  // partial unique index is the conflict target instead of a try/catch.
  await client.query(
    `INSERT INTO proposal_view_tasks
       (proposal_id, prospect_id, status, view_count, last_viewed_at, last_source,
        demo_link_expired, created_at, updated_at)
     VALUES ($1, $2, 'open', $3, $4, $5, $6, $7, $7)
     ON CONFLICT (proposal_id) WHERE status = 'open'
     DO UPDATE SET
       view_count = EXCLUDED.view_count,
       last_viewed_at = EXCLUDED.last_viewed_at,
       last_source = EXCLUDED.last_source,
       demo_link_expired = EXCLUDED.demo_link_expired,
       updated_at = EXCLUDED.updated_at`,
    [proposalId, prospectId, n, stats.last_viewed_at, stats.source, expired, at]
  );
}

async function recordView({ proposalId, source, at, method, ua, purpose, secPurpose, preview, cookie, ip }) {
  if (source !== 'onepager' && source !== 'demo') {
    const err = new Error('source');
    err.code = 'source';
    throw err;
  }
  const when = at instanceof Date ? at : (at ? new Date(at) : nowFn());
  const salt = await loadSalt();
  const klass = uaClass(ua);
  const fp = fingerprint(salt, ip, klass);

  return withClient('demo-view', async (client) => {
    await client.query('BEGIN');
    try {
      const meta = await client.query('SELECT sent_at FROM proposals WHERE id = $1', [proposalId]);
      if (!meta.rows[0]) {
        await client.query('ROLLBACK');
        return null;
      }
      const preliminary = exclusionReason({
        method,
        ua,
        purpose,
        secPurpose,
        preview,
        cookie,
        sentAt: meta.rows[0].sent_at,
        at: when,
      });
      await client.query('SELECT pg_advisory_xact_lock($1::int, hashtext($2::text))', [BURST_LOCK, fp]);
      const inserted = await client.query(
        `INSERT INTO proposal_view_log
           (proposal_id, viewed_at, source, excluded_reason, ua_class, client_fp)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING id`,
        [proposalId, when, source, preliminary, klass, fp]
      );
      const burst = await client.query(
        `SELECT COUNT(DISTINCT proposal_id)::int AS n
           FROM proposal_view_log
          WHERE client_fp = $1
            AND viewed_at <= $2::timestamptz
            AND viewed_at >= $2::timestamptz - interval '${BURST_WINDOW}'`,
        [fp, when]
      );
      const affected = new Set();
      let reason = preliminary;
      if (burst.rows[0] && burst.rows[0].n >= 3) {
        const updated = await client.query(
          `UPDATE proposal_view_log
              SET excluded_reason = 'burst'
            WHERE client_fp = $1
              AND excluded_reason IS NULL
              AND viewed_at <= $2::timestamptz
              AND viewed_at >= $2::timestamptz - interval '${BURST_WINDOW}'
            RETURNING proposal_id`,
          [fp, when]
        );
        for (const row of updated.rows) affected.add(row.proposal_id);
        if (reason == null) reason = 'burst';
      }
      if (reason == null) affected.add(proposalId);
      const ids = [...affected].sort((a, b) => a - b);
      for (const id of ids) await syncTask(client, id, when);
      await client.query('COMMIT');
      return { id: inserted.rows[0].id, reason, ua_class: klass };
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    }
  });
}

async function recordOnepagerView(req, proposalId) {
  const view = viewFromRequest(req);
  return recordView({ proposalId, source: 'onepager', at: nowFn(), ...view });
}

async function recordDemoView({ prospectId, at, view }) {
  if (!prospectId) return null;
  const { rows } = await pool.query(
    `SELECT id
       FROM proposals
      WHERE prospect_id = $1
        AND sent_at IS NOT NULL
        AND status NOT IN ('draft', 'discarded', 'superseded')
      ORDER BY sent_at DESC, id DESC
      LIMIT 1`,
    [prospectId]
  );
  if (!rows[0]) return null;
  const fields = view || {};
  return recordView({
    proposalId: rows[0].id,
    source: 'demo',
    at: at || nowFn(),
    method: fields.method || 'POST',
    ua: fields.ua || '',
    purpose: fields.purpose || '',
    secPurpose: fields.secPurpose || '',
    preview: fields.preview === true,
    cookie: fields.cookie || '',
    ip: fields.ip || 'unknown',
  });
}

function stamp(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString();
}

async function listOpenTasks() {
  const at = nowFn();
  const { rows } = await pool.query(
    `SELECT t.id, t.prospect_id, t.proposal_id, t.view_count, t.last_viewed_at,
            t.last_source, t.demo_link_expired,
            p.company, p.industry, p.city, p.phone
       FROM proposal_view_tasks t
       JOIN prospects p ON p.id = t.prospect_id
      WHERE t.status = 'open'
        AND (t.snoozed_until IS NULL OR t.snoozed_until <= $1::timestamptz)
      ORDER BY t.last_viewed_at DESC NULLS LAST, t.id DESC`,
    [at]
  );
  return {
    tasks: rows.map((row) => ({
      id: Number(row.id),
      prospect_id: row.prospect_id,
      proposal_id: row.proposal_id,
      company: row.company,
      view_count: row.view_count,
      last_viewed_at: stamp(row.last_viewed_at),
      source: row.last_source,
      trade: row.industry,
      city: row.city,
      phone: row.phone && String(row.phone).trim() ? row.phone : null,
      demo_link_expired: row.demo_link_expired === true,
    })),
  };
}

async function loadOpenTask(client, id) {
  const peek = await client.query(
    'SELECT prospect_id, proposal_id FROM proposal_view_tasks WHERE id = $1',
    [id]
  );
  if (!peek.rows[0]) return null;
  await client.query('SELECT id FROM prospects WHERE id = $1 FOR UPDATE', [peek.rows[0].prospect_id]);
  await client.query('SELECT id FROM proposals WHERE id = $1 FOR UPDATE', [peek.rows[0].proposal_id]);
  const { rows } = await client.query(
    `SELECT id, proposal_id, prospect_id, status
       FROM proposal_view_tasks
      WHERE id = $1
      FOR UPDATE`,
    [id]
  );
  return rows[0] || null;
}

async function withTask(id, fn) {
  return withClient('demo-view', async (client) => {
    await client.query('BEGIN');
    try {
      const result = await fn(client, nowFn());
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    }
  });
}

function taskMissing() {
  const err = new Error('not_found');
  err.status = 404;
  err.code = 'not_found';
  return err;
}

function taskClosed() {
  const err = new Error('task_not_open');
  err.status = 409;
  err.code = 'task_not_open';
  return err;
}

async function markDone(id) {
  return withTask(id, async (client, at) => {
    const row = await loadOpenTask(client, id);
    if (!row) throw taskMissing();
    if (row.status !== 'open') throw taskClosed();
    await client.query(
      `UPDATE proposal_view_tasks
          SET status = 'done', done_at = $2, updated_at = $2
        WHERE id = $1 AND status = 'open'`,
      [id, at]
    );
    await client.query(
      `INSERT INTO prospect_activities (prospect_id, type, body) VALUES ($1, 'call', 'called')`,
      [row.prospect_id]
    );
    const ref = `demo-view-task:${id}`;
    if (!CALL_REF.test(ref)) throw taskMissing();
    await client.query(
      `INSERT INTO campaign_touches
         (lead_id, type, channel, occurred_at, source, external_ref)
       VALUES ($1, 'call_logged', 'phone', $2, 'system', $3)`,
      [row.prospect_id, at, ref]
    );
    return { id: Number(id), status: 'done', prospect_id: row.prospect_id };
  });
}

async function snoozeTask(id) {
  return withTask(id, async (client, at) => {
    const row = await loadOpenTask(client, id);
    if (!row) throw taskMissing();
    if (row.status !== 'open') throw taskClosed();
    const updated = await client.query(
      `UPDATE proposal_view_tasks
          SET snoozed_until = $2::timestamptz + interval '1 day', updated_at = $2
        WHERE id = $1 AND status = 'open'
        RETURNING snoozed_until`,
      [id, at]
    );
    return {
      id: Number(id),
      status: 'open',
      snoozed_until: stamp(updated.rows[0].snoozed_until),
    };
  });
}

async function dismissTask(id) {
  return withTask(id, async (client, at) => {
    const row = await loadOpenTask(client, id);
    if (!row) throw taskMissing();
    if (row.status !== 'open') throw taskClosed();
    await client.query(
      `UPDATE proposal_view_tasks
          SET status = 'dismissed', dismissed_at = $2, updated_at = $2
        WHERE id = $1 AND status = 'open'`,
      [id, at]
    );
    return { id: Number(id), status: 'dismissed', prospect_id: row.prospect_id };
  });
}

async function taskMetrics() {
  const created = await pool.query(
    `SELECT
       COUNT(*)::int AS tasks_created,
       COUNT(*) FILTER (WHERE status = 'done')::int AS tasks_done
     FROM proposal_view_tasks`
  );
  const booked = await pool.query(
    `SELECT COUNT(DISTINCT booked.lead_id)::int AS n
       FROM campaign_touches call
       JOIN campaign_touches booked
         ON booked.lead_id = call.lead_id
        AND booked.type = 'call_booked'
        AND booked.occurred_at >= call.occurred_at
        AND booked.occurred_at <= call.occurred_at + interval '14 days'
      WHERE call.type = 'call_logged'
        AND call.source = 'system'
        AND call.external_ref ~ '^demo-view-task:[1-9][0-9]{0,17}$'`
  );
  return {
    tasks_created: created.rows[0].tasks_created,
    tasks_done: created.rows[0].tasks_done,
    calls_booked_within_14d: booked.rows[0].n,
  };
}

module.exports = {
  SALT_KEY,
  BURST_LOCK,
  BURST_WINDOW,
  PURGE_DAYS,
  loadSalt,
  fingerprint,
  purgeViewLog,
  recordView,
  recordOnepagerView,
  recordDemoView,
  listOpenTasks,
  markDone,
  snoozeTask,
  dismissTask,
  taskMetrics,
  _setClockForTests,
};
