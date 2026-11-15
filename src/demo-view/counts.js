// Prospect vs team counts for proposal API responses.
//
// counting_since is app_settings key prospect_views_counting_since, shape
// {"at": "<timestamptz>"}. schema.sql inserts it once on the first boot that
// contains the statement (ON CONFLICT DO NOTHING). That instant is the
// earliest moment the log is a prospect-vs-team record: demo-page
// classification and X-FF-Internal both start there. Later boots do not
// change it. This module does not write the setting and does not backfill.
//
// Rows with viewed_at strictly before that instant are ignored. Both
// sources (onepager and demo) count. A qualifying row has excluded_reason
// NULL. internal_views is every other row in the window.
//
// Null means "not tracked", so the CRM can say that instead of 0:
//   - the setting is missing or unreadable: all four fields are null
//   - the proposal's created_at is strictly before counting_since and the
//     proposal has no log row in the window: the three count fields are
//     null and counting_since is the instant
// A proposal created at or after counting_since with no in-window rows
// returns 0, 0, and a null last_prospect_view_at.
//
// One aggregate covers every id in the list. Flag off does not add keys.

const pool = require('../db/client');
const { prospectViewsOn } = require('./flag');

const COUNTING_KEY = 'prospect_views_counting_since';

function readCountingSince(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value.at;
  if (raw == null || raw === '') return null;
  const date = raw instanceof Date ? raw : new Date(raw);
  if (Number.isNaN(date.getTime())) return null;
  return date;
}

function stamp(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString();
}

async function loadCountingSince(db = pool) {
  const { rows } = await db.query('SELECT value FROM app_settings WHERE key = $1', [COUNTING_KEY]);
  return readCountingSince(rows[0] && rows[0].value);
}

function fieldsFor(proposal, since, row) {
  if (!since) {
    return {
      prospect_views: null,
      last_prospect_view_at: null,
      internal_views: null,
      counting_since: null,
    };
  }
  const createdMs = proposal && proposal.created_at ? new Date(proposal.created_at).getTime() : NaN;
  const before = !Number.isFinite(createdMs) || createdMs < since.getTime();
  const tracked = row ? Number(row.tracked) || 0 : 0;
  if (before && tracked === 0) {
    return {
      prospect_views: null,
      last_prospect_view_at: null,
      internal_views: null,
      counting_since: since.toISOString(),
    };
  }
  return {
    prospect_views: row ? Number(row.prospect_views) || 0 : 0,
    last_prospect_view_at: stamp(row && row.last_prospect_view_at),
    internal_views: row ? Number(row.internal_views) || 0 : 0,
    counting_since: since.toISOString(),
  };
}

async function attachProspectViewFields(proposals, db = pool) {
  const list = Array.isArray(proposals) ? proposals : [];
  if (!prospectViewsOn()) return list;
  const ids = [];
  for (const row of list) {
    const id = Number(row && row.id);
    if (Number.isInteger(id) && id > 0) ids.push(id);
  }
  const since = await loadCountingSince(db);
  let byId = new Map();
  if (since && ids.length) {
    const { rows } = await db.query(
      `SELECT proposal_id,
              COUNT(*) FILTER (WHERE excluded_reason IS NULL)::int AS prospect_views,
              MAX(viewed_at) FILTER (WHERE excluded_reason IS NULL) AS last_prospect_view_at,
              COUNT(*) FILTER (WHERE excluded_reason IS NOT NULL)::int AS internal_views,
              COUNT(*)::int AS tracked
         FROM proposal_view_log
        WHERE proposal_id = ANY($1::int[])
          AND viewed_at >= $2::timestamptz
        GROUP BY proposal_id`,
      [ids, since]
    );
    byId = new Map(rows.map((row) => [Number(row.proposal_id), row]));
  }
  return list.map((row) => ({ ...row, ...fieldsFor(row, since, byId.get(Number(row && row.id))) }));
}

module.exports = {
  COUNTING_KEY,
  loadCountingSince,
  attachProspectViewFields,
};
