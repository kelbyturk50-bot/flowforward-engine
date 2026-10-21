// Headline metrics for Campaigns slice 1. Computed on read from the effective
// touch stream. This module does not send mail.

const pool = require('../db/client');

const CHANNELS = Object.freeze([
  'email', 'phone', 'sms', 'prototype_link', 'in_person', 'referral', 'other',
]);
const CHANNEL_SET = new Set(CHANNELS);

const OPEN_LABEL = 'Approximate, unreliable (Apple MPP)';
const EVENT_COUNT_TYPES = Object.freeze([
  'prototype_viewed',
  'prototype_cta_clicked',
  'estimate_recovered',
]);

const QUERY_KEYS = new Set([
  'campaign_id',
  'variant_id',
  'channel',
  'from',
  'to',
  'include_machine_opens',
]);

const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;
const ISO_INSTANT = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/;

function invalidParam() {
  const err = new Error('invalid_param');
  err.status = 400;
  return err;
}

function parseId(value) {
  if (value == null || value === '') return null;
  if (typeof value !== 'string' || !/^[1-9][0-9]{0,8}$/.test(value)) throw invalidParam();
  return Number(value);
}

function parseFlag(value) {
  if (value == null || value === '' || value === 'false') return false;
  if (value === 'true') return true;
  throw invalidParam();
}

function parseBound(value, bound) {
  if (value == null || value === '') return null;
  if (typeof value !== 'string') throw invalidParam();
  const dateOnly = DATE_ONLY.exec(value);
  if (dateOnly) {
    const year = Number(dateOnly[1]);
    const month = Number(dateOnly[2]);
    const day = Number(dateOnly[3]);
    const utc = new Date(Date.UTC(year, month - 1, day));
    if (
      utc.getUTCFullYear() !== year
      || utc.getUTCMonth() !== month - 1
      || utc.getUTCDate() !== day
    ) throw invalidParam();
    if (bound === 'to') {
      return new Date(Date.UTC(year, month - 1, day, 23, 59, 59, 999));
    }
    return utc;
  }
  if (!ISO_INSTANT.test(value)) throw invalidParam();
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) throw invalidParam();
  return parsed;
}

function parseMetricsQuery(query) {
  const source = query || {};
  for (const key of Object.keys(source)) {
    if (!QUERY_KEYS.has(key) || Array.isArray(source[key])) throw invalidParam();
  }
  const campaignId = parseId(source.campaign_id);
  const variantId = parseId(source.variant_id);
  let channel = null;
  if (source.channel != null && source.channel !== '') {
    if (!CHANNEL_SET.has(source.channel)) throw invalidParam();
    channel = source.channel;
  }
  const from = parseBound(source.from, 'from');
  const to = parseBound(source.to, 'to');
  if (from && to && from.getTime() > to.getTime()) throw invalidParam();
  return {
    campaignId,
    variantId,
    channel,
    from,
    to,
    includeMachine: parseFlag(source.include_machine_opens),
  };
}

function rate(count, n, extra) {
  const body = {
    count,
    n,
    rate: n === 0 ? null : count / n,
    directional: n < 30,
  };
  if (extra) Object.assign(body, extra);
  return body;
}

function isBaseTouch(touch) {
  return touch.type === 'sent' || touch.type === 'call_logged';
}

function isConversion(touch) {
  return touch.type === 'won' || touch.type === 'mvp_sold';
}

function isHumanOrIncludedOpen(touch, includeMachine) {
  if (touch.type !== 'opened') return false;
  if (includeMachine) return true;
  return touch.machine_open !== true;
}

function groupTouches(rows) {
  const byLead = new Map();
  for (const row of rows) {
    const leadId = row.lead_id;
    if (!byLead.has(leadId)) byLead.set(leadId, []);
    byLead.get(leadId).push(row);
  }
  return byLead;
}

function leadRows(byLead, leadId) {
  return byLead.get(leadId) || [];
}

function hasReply(byLead, leadId) {
  return leadRows(byLead, leadId).some((touch) => touch.type === 'replied');
}

function hasReplyOnChannel(byLead, leadId, channel) {
  return leadRows(byLead, leadId).some((touch) => touch.type === 'replied' && touch.channel === channel);
}

function hasConversion(byLead, leadId, channel) {
  return leadRows(byLead, leadId).some((touch) => {
    if (!isConversion(touch)) return false;
    if (channel && touch.channel !== channel) return false;
    return true;
  });
}

function hasOpen(byLead, leadId, includeMachine, channel) {
  return leadRows(byLead, leadId).some((touch) => {
    if (!isHumanOrIncludedOpen(touch, includeMachine)) return false;
    if (channel && touch.channel !== channel) return false;
    return true;
  });
}

function countWhere(leadIds, pred) {
  let count = 0;
  for (const leadId of leadIds) {
    if (pred(leadId)) count += 1;
  }
  return count;
}

function headlineFor(leadIds, byLead, includeMachine, channel) {
  const n = leadIds.size;
  const ids = leadIds;
  const responded = countWhere(ids, (leadId) => (
    channel ? hasReplyOnChannel(byLead, leadId, channel) : hasReply(byLead, leadId)
  ));
  const converted = countWhere(ids, (leadId) => hasConversion(byLead, leadId, channel || null));
  const opened = countWhere(ids, (leadId) => (
    hasOpen(byLead, leadId, includeMachine, channel || null) && !hasReply(byLead, leadId)
  ));
  return {
    touched: n,
    responded: rate(responded, n),
    converted: rate(converted, n),
    opened_no_response: rate(opened, n, { label: OPEN_LABEL }),
  };
}

async function variantRows(db, params, touchedByVariant) {
  let rows;
  if (params.campaignId) {
    ({ rows } = await db.query(
      `SELECT id, campaign_id, label
         FROM campaign_variants
        WHERE campaign_id = $1
        ORDER BY label, id`,
      [params.campaignId]
    ));
  } else if (params.variantId) {
    ({ rows } = await db.query(
      `SELECT id, campaign_id, label
         FROM campaign_variants
        WHERE id = $1
        ORDER BY label, id`,
      [params.variantId]
    ));
  } else {
    const ids = [...touchedByVariant.keys()];
    if (!ids.length) return [];
    ({ rows } = await db.query(
      `SELECT id, campaign_id, label
         FROM campaign_variants
        WHERE id = ANY($1::int[])
        ORDER BY label, id`,
      [ids]
    ));
  }
  if (params.variantId) return rows.filter((row) => row.id === params.variantId);
  return rows;
}

// Archived leads (prospects.archived_at set, see #39/#66) are left out of
// every count: their touches, their enrollments, and their events.
async function headlineMetrics(params, db = pool) {
  const { rows } = await db.query(
    `SELECT t.origin, t.source_id, t.lead_id, t.campaign_id, t.variant_id, t.type, t.channel,
            t.occurred_at, t.source, t.machine_open
       FROM v_campaign_effective_touches t
       JOIN prospects p ON p.id = t.lead_id
      WHERE p.archived_at IS NULL
        AND ($1::int IS NULL OR t.campaign_id = $1)
        AND ($2::timestamptz IS NULL OR t.occurred_at >= $2)
        AND ($3::timestamptz IS NULL OR t.occurred_at <= $3)`,
    [params.campaignId, params.from, params.to]
  );

  const byLead = groupTouches(rows);
  const touched = new Set();
  const touchedByVariant = new Map();
  const touchedByChannel = new Map();

  for (const touch of rows) {
    if (!isBaseTouch(touch)) continue;
    if (params.variantId && touch.variant_id !== params.variantId) continue;
    if (params.channel && touch.channel !== params.channel) continue;
    touched.add(touch.lead_id);
    if (touch.variant_id != null) {
      if (!touchedByVariant.has(touch.variant_id)) touchedByVariant.set(touch.variant_id, new Set());
      touchedByVariant.get(touch.variant_id).add(touch.lead_id);
    }
    if (touch.channel) {
      if (!touchedByChannel.has(touch.channel)) touchedByChannel.set(touch.channel, new Set());
      touchedByChannel.get(touch.channel).add(touch.lead_id);
    }
  }

  const top = headlineFor(touched, byLead, params.includeMachine, params.channel);
  const variants = await variantRows(db, params, touchedByVariant);
  const byVariant = variants.map((variant) => {
    const leads = touchedByVariant.get(variant.id) || new Set();
    const metrics = headlineFor(leads, byLead, params.includeMachine, params.channel);
    return {
      campaign_id: variant.campaign_id,
      variant_id: variant.id,
      label: variant.label,
      touched: metrics.touched,
      responded: metrics.responded,
      converted: metrics.converted,
      opened_no_response: metrics.opened_no_response,
    };
  });

  const channelKeys = params.channel
    ? [params.channel]
    : CHANNELS.filter((channel) => (touchedByChannel.get(channel) || new Set()).size > 0);
  const byChannel = channelKeys.map((channel) => {
    const leads = touchedByChannel.get(channel) || new Set();
    const metrics = headlineFor(leads, byLead, params.includeMachine, channel);
    return {
      channel,
      touched: metrics.touched,
      responded: metrics.responded,
      converted: metrics.converted,
      opened_no_response: metrics.opened_no_response,
    };
  });

  const eventCounts = {};
  for (const touch of rows) {
    if (!EVENT_COUNT_TYPES.includes(touch.type)) continue;
    if (params.variantId && touch.variant_id !== params.variantId) continue;
    if (params.channel && touch.channel !== params.channel) continue;
    eventCounts[touch.type] = (eventCounts[touch.type] || 0) + 1;
  }

  return {
    touched: top.touched,
    include_machine_opens: params.includeMachine,
    responded: top.responded,
    converted: top.converted,
    opened_no_response: top.opened_no_response,
    by_variant: byVariant,
    by_channel: byChannel,
    event_counts: eventCounts,
  };
}

// ─── GET /api/campaigns (list) ────────────────────────────────────────────
// Contract agreed on #67 (Oct 18). from/to are optional YYYY-MM-DD dates
// (UTC, inclusive); omitted means lifetime. Every count is a number of
// leads. Touched (>= 1 sent or call_logged in the range) is the denominator.
// Converted is any won or mvp_sold for a touched lead, with no attribution
// to a touch in slice 1. Only touches recorded against the campaign count.

const LIST_KEYS = new Set(['from', 'to']);

function parseDateOnly(value, bound) {
  if (value == null || value === '') return { at: null, text: null };
  if (typeof value !== 'string' || !DATE_ONLY.test(value)) throw invalidParam();
  return { at: parseBound(value, bound), text: value };
}

function parseListQuery(query) {
  const source = query || {};
  for (const key of Object.keys(source)) {
    if (!LIST_KEYS.has(key) || Array.isArray(source[key])) throw invalidParam();
  }
  const from = parseDateOnly(source.from, 'from');
  const to = parseDateOnly(source.to, 'to');
  if (from.at && to.at && from.at.getTime() > to.at.getTime()) throw invalidParam();
  return { from: from.at, to: to.at, fromText: from.text, toText: to.text };
}

function listCounts(touches) {
  const byLead = groupTouches(touches);
  const touched = [];
  for (const [leadId, rows] of byLead) {
    if (rows.some(isBaseTouch)) touched.push(leadId);
  }
  const replied = (leadId) => hasReply(byLead, leadId);
  const opened = (leadId, pred) => leadRows(byLead, leadId).some((touch) => touch.type === 'opened' && pred(touch));
  const human = (touch) => touch.machine_open !== true;
  const machine = (touch) => touch.machine_open === true;
  const any = () => true;
  const count = (pred) => touched.filter(pred).length;
  return {
    touched: touched.length,
    responded: count(replied),
    converted: count((leadId) => hasConversion(byLead, leadId, null)),
    opened_no_response_human: count((leadId) => !replied(leadId) && opened(leadId, human)),
    opened_no_response_incl_machine: count((leadId) => !replied(leadId) && opened(leadId, any)),
    machine_opens: count((leadId) => !replied(leadId) && opened(leadId, machine)),
    prototype_views: touches.filter((touch) => touch.type === 'prototype_viewed').length,
  };
}

async function campaignList(params, db = pool) {
  const { rows: campaigns } = await db.query(
    `SELECT id, name, status, channel, segment, cost_cents,
            to_char(start_date, 'YYYY-MM-DD') AS start_date,
            to_char(end_date, 'YYYY-MM-DD') AS end_date
       FROM campaigns
      ORDER BY id`
  );
  const { rows: enrolledRows } = await db.query(
    `SELECT cl.campaign_id, COUNT(*)::int AS n
       FROM campaign_leads cl
       JOIN prospects p ON p.id = cl.lead_id
      WHERE p.archived_at IS NULL
      GROUP BY cl.campaign_id`
  );
  const { rows: touches } = await db.query(
    `SELECT t.lead_id, t.campaign_id, t.type, t.channel, t.machine_open
       FROM v_campaign_effective_touches t
       JOIN prospects p ON p.id = t.lead_id
      WHERE p.archived_at IS NULL
        AND t.campaign_id IS NOT NULL
        AND ($1::timestamptz IS NULL OR t.occurred_at >= $1)
        AND ($2::timestamptz IS NULL OR t.occurred_at <= $2)`,
    [params.from, params.to]
  );
  const enrolled = new Map(enrolledRows.map((row) => [row.campaign_id, row.n]));
  const touchesByCampaign = new Map();
  for (const touch of touches) {
    if (!touchesByCampaign.has(touch.campaign_id)) touchesByCampaign.set(touch.campaign_id, []);
    touchesByCampaign.get(touch.campaign_id).push(touch);
  }
  return {
    range: { from: params.fromText, to: params.toText },
    attribution: { model: 'any' },
    campaigns: campaigns.map((row) => ({
      id: row.id,
      name: row.name,
      status: row.status,
      channel: row.channel,
      start_date: row.start_date,
      end_date: row.end_date,
      segment: row.segment,
      enrolled: enrolled.get(row.id) || 0,
      ...listCounts(touchesByCampaign.get(row.id) || []),
      cost_cents: row.cost_cents,
    })),
  };
}

module.exports = {
  CHANNELS,
  OPEN_LABEL,
  parseMetricsQuery,
  parseListQuery,
  headlineMetrics,
  campaignList,
};
