// GET /api/today/call-list. One row per prospect, highest tier wins.
// This module does not send mail and does not open a transaction.

const pool = require('../db/client');
const { appendCompanyPestExclusion } = require('../scoring/industry');
const { now, denverYmd, calendarDaysBetween } = require('./clock');
const copy = require('./copy');
const { isTargetTrade, isUtah } = require('./trades');
const { OUTCOME_BODIES, summarize, held } = require('./schedule');

const CAP = 8;
const ALL_LIMIT = 50;
const CITY_ORDER = Object.freeze([
  'Saratoga Springs',
  'Eagle Mountain',
  'Lehi',
  'American Fork',
]);
const CLOSED = ['lost', 'disqualified', 'won'];

function cityKey(city) {
  return String(city || '').trim().replace(/\s+/g, ' ').toLowerCase();
}

function cityRank(city) {
  const key = cityKey(city);
  const idx = CITY_ORDER.findIndex((name) => name.toLowerCase() === key);
  return idx === -1 ? CITY_ORDER.length : idx;
}

function phoneFields(raw) {
  const text = raw == null ? '' : String(raw).trim();
  const digits = text.replace(/\D/g, '');
  if (!digits) return { phone: null, tel: null };
  const telBody = text.startsWith('+') ? `+${digits}` : digits;
  return { phone: text, tel: `tel:${telBody}` };
}

function addressFields(row) {
  const address = row.address == null ? '' : String(row.address).trim();
  if (!address) return { address: null, maps_url: null };
  const parts = [address, row.city, row.state, row.zip]
    .map((value) => (value == null ? '' : String(value).trim()))
    .filter(Boolean);
  const query = parts.join(', ');
  return {
    address,
    maps_url: `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(query)}`,
  };
}

function resolveKind(row) {
  if (row.call_list_kind === 'call' || row.call_list_kind === 'walk_in') return row.call_list_kind;
  const phone = phoneFields(row.phone);
  if (phone.phone) return 'call';
  const address = row.address == null ? '' : String(row.address).trim();
  if (address) return 'walk_in';
  return null;
}

function demoReason(at, todayYmd) {
  if (!at) return 'Viewed the demo';
  const days = calendarDaysBetween(denverYmd(at), todayYmd);
  if (days <= 0) return copy.REASON_DEMO_TODAY;
  if (days === 1) return copy.REASON_DEMO_YESTERDAY;
  return copy.reasonDemoDays(days);
}

function recentOutcome(rows, at) {
  const cutoff = at.getTime() - 14 * 24 * 60 * 60 * 1000;
  return rows.some((row) => new Date(row.created_at).getTime() >= cutoff);
}

async function loadCandidates() {
  const params = [];
  const kept = appendCompanyPestExclusion(params);
  const closedIndex = params.push(CLOSED);
  const { rows } = await pool.query(
    `SELECT p.id, p.company, p.phone, p.address, p.city, p.state, p.zip,
            p.industry, p.fit_score, p.stage, p.call_list_kind, p.call_list_set_at
       FROM prospects p
      WHERE p.archived_at IS NULL
        AND COALESCE(p.do_not_contact, FALSE) = FALSE
        AND NOT (p.stage = ANY($${closedIndex}::text[]))
        AND ${kept}`,
    params
  );
  return rows;
}

async function loadSignals(ids, at) {
  if (!ids.length) {
    return { views: new Map(), tasks: new Map(), mail: new Map(), outcomes: new Map() };
  }
  const [views, tasks, mail, outcomes] = await Promise.all([
    pool.query(
      `SELECT pr.prospect_id, MAX(l.viewed_at) AS viewed_at
         FROM proposal_view_log l
         JOIN proposals pr ON pr.id = l.proposal_id
        WHERE pr.prospect_id = ANY($1::int[])
          AND l.excluded_reason IS NULL
          AND l.viewed_at <= $2::timestamptz
          AND l.viewed_at >= $2::timestamptz - INTERVAL '7 days'
        GROUP BY pr.prospect_id`,
      [ids, at]
    ),
    pool.query(
      `SELECT DISTINCT ON (prospect_id)
              id, prospect_id, last_viewed_at
         FROM proposal_view_tasks
        WHERE prospect_id = ANY($1::int[])
          AND status = 'open'
        ORDER BY prospect_id, last_viewed_at DESC NULLS LAST, id ASC`,
      [ids]
    ),
    pool.query(
      `SELECT prospect_id,
              MIN(sent_at) FILTER (WHERE sent_at IS NOT NULL) AS first_sent_at,
              bool_or(sent_at IS NOT NULL OR followup1_sent_at IS NOT NULL OR followup2_sent_at IS NOT NULL) AS emailed,
              bool_or(replied_at IS NOT NULL OR status = 'replied') AS replied,
              bool_or(status = 'bounced') AS bounced,
              bool_or(status = 'opted_out') AS opted_out,
              bool_or(sent_at IS NOT NULL) AS any_sent,
              bool_or(
                sent_at IS NOT NULL AND (
                  (followup1_due_at IS NOT NULL AND followup1_sent_at IS NULL)
                  OR (followup2_due_at IS NOT NULL AND followup2_sent_at IS NULL)
                )
              ) AS sequence_open
         FROM proposals
        WHERE prospect_id = ANY($1::int[])
        GROUP BY prospect_id`,
      [ids]
    ),
    pool.query(
      `SELECT prospect_id, id, body, created_at
         FROM prospect_activities
        WHERE prospect_id = ANY($1::int[])
          AND type IN ('call', 'visit')
          AND body = ANY($2::text[])
        ORDER BY prospect_id, created_at DESC, id DESC`,
      [ids, OUTCOME_BODIES]
    ),
  ]);
  const viewMap = new Map(views.rows.map((row) => [row.prospect_id, row.viewed_at]));
  const taskMap = new Map(tasks.rows.map((row) => [row.prospect_id, row]));
  const mailMap = new Map(mail.rows.map((row) => [row.prospect_id, row]));
  const outcomeMap = new Map();
  for (const row of outcomes.rows) {
    const list = outcomeMap.get(row.prospect_id);
    if (list) list.push(row);
    else outcomeMap.set(row.prospect_id, [row]);
  }
  return { views: viewMap, tasks: taskMap, mail: mailMap, outcomes: outcomeMap };
}

function truthy(value) {
  return value === true;
}

function chooseTier(row, signal, at) {
  const today = denverYmd(at);
  const excluded = row.call_list_kind === 'excluded';
  const setAt = row.call_list_set_at ? new Date(row.call_list_set_at) : null;
  const viewAt = signal.viewAt ? new Date(signal.viewAt) : null;
  const viewCounts = !!(viewAt && (!excluded || (setAt && viewAt.getTime() > setAt.getTime())));
  const taskCounts = !!(signal.task && !excluded);
  if (viewCounts || taskCounts) {
    const reasonAt = viewCounts ? viewAt : signal.task.last_viewed_at;
    return { tier: 1, reason: demoReason(reasonAt, today), reason_code: 'demo_view' };
  }
  if (excluded) return null;
  if (row.call_list_kind === 'call' || row.call_list_kind === 'walk_in') {
    const reason = row.call_list_kind === 'walk_in' ? copy.REASON_WALK_IN_LIST : copy.REASON_CALL_LIST;
    return { tier: 2, reason, reason_code: 'listed' };
  }
  if (!isTargetTrade(row.industry) || !isUtah(row)) return null;
  const mail = signal.mail;
  if (!mail || truthy(mail.replied) || truthy(mail.bounced) || truthy(mail.opted_out)) return null;
  if (mail.first_sent_at) {
    const days = calendarDaysBetween(denverYmd(mail.first_sent_at), today);
    if (days >= 3 && days <= 5) {
      return { tier: 3, reason: copy.reasonIntroDays(days), reason_code: 'intro_3_5d' };
    }
  }
  if (truthy(mail.any_sent) && !truthy(mail.sequence_open) && !signal.recentOutcome) {
    return { tier: 4, reason: copy.REASON_SEQUENCE_DONE, reason_code: 'sequence_done' };
  }
  return null;
}

function toItem(row, picked, signal) {
  const kind = resolveKind(row);
  if (!kind) return null;
  const phone = phoneFields(row.phone);
  const address = addressFields(row);
  const emailed = !!(signal.mail && truthy(signal.mail.emailed));
  const summary = signal.summary;
  const latest = summary.latest;
  const city = row.city == null || String(row.city).trim() === '' ? null : String(row.city).trim();
  return {
    prospect_id: Number(row.id),
    company: row.company,
    kind,
    phone: phone.phone,
    tel: phone.tel,
    address: address.address,
    city,
    maps_url: address.maps_url,
    reason: picked.reason,
    reason_code: picked.reason_code,
    emailed,
    script: copy.scriptFor(kind, emailed),
    voicemail_script: kind === 'call' ? copy.VOICEMAIL : null,
    ask: copy.ASK,
    open_task_id: signal.task ? Number(signal.task.id) : null,
    attempts: summary.attempts,
    last_outcome: latest ? latest.body : null,
    last_outcome_at: latest ? new Date(latest.created_at).toISOString() : null,
    tier: picked.tier,
    city_rank: cityRank(city),
    fit: row.fit_score == null ? null : Number(row.fit_score),
  };
}

async function buildCallList({ all }) {
  const at = now();
  const candidates = await loadCandidates();
  const ids = candidates.map((row) => row.id);
  const loaded = await loadSignals(ids, at);
  const ranked = [];
  for (const row of candidates) {
    const outcomeRows = loaded.outcomes.get(row.id) || [];
    const summary = summarize(outcomeRows);
    if (held(summary, at)) continue;
    const signal = {
      viewAt: loaded.views.get(row.id) || null,
      task: loaded.tasks.get(row.id) || null,
      mail: loaded.mail.get(row.id) || null,
      summary,
      recentOutcome: recentOutcome(outcomeRows, at),
    };
    const picked = chooseTier(row, signal, at);
    if (!picked) continue;
    const item = toItem(row, picked, signal);
    if (!item) continue;
    ranked.push(item);
  }
  ranked.sort((a, b) => {
    if (a.tier !== b.tier) return a.tier - b.tier;
    if (a.city_rank !== b.city_rank) return a.city_rank - b.city_rank;
    const af = a.fit == null ? Number.NEGATIVE_INFINITY : a.fit;
    const bf = b.fit == null ? Number.NEGATIVE_INFINITY : b.fit;
    if (af !== bf) return bf - af;
    return a.prospect_id - b.prospect_id;
  });
  const limit = all ? ALL_LIMIT : CAP;
  const more = Math.max(0, ranked.length - limit);
  const items = ranked.slice(0, limit).map((item) => {
    const out = { ...item };
    delete out.tier;
    delete out.city_rank;
    delete out.fit;
    return out;
  });
  return {
    enabled: true,
    date: denverYmd(at),
    cap: CAP,
    more,
    items,
  };
}

module.exports = {
  CAP,
  ALL_LIMIT,
  CITY_ORDER,
  buildCallList,
  cityRank,
};
