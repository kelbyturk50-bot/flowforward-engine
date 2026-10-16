// Observed headline math for the Campaigns list. Opens never change
// responded or converted. Touched means at least one sent or call_logged.

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export const CHANNEL_LABELS = Object.freeze({
  email: 'Email',
  phone: 'Phone',
  sms: 'SMS',
  prototype_link: 'Prototype link',
  in_person: 'In person',
  referral: 'Referral',
  other: 'Other',
});

export const STATUS_LABELS = Object.freeze({
  active: 'Active',
  paused: 'Paused',
  ended: 'Ended',
  draft: 'Draft',
});

export function channelLabel(channel) {
  return CHANNEL_LABELS[channel] || 'Other';
}

export function statusLabel(status) {
  return STATUS_LABELS[status] || status;
}

export function isTouchedLead(lead) {
  return (lead?.touches || []).some((touch) => touch.type === 'sent' || touch.type === 'call_logged');
}

export function formatRatePercent(k, d) {
  if (!d) return '—';
  const rounded = Math.round((k / d) * 1000) / 10;
  const text = Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
  return `${text}%`;
}

export function machineOpenLine(count, touched, included) {
  return `${count} of ${touched} machine opens, no reply, ${included ? 'included' : 'excluded'}`;
}

export function formatCampaignDate(iso) {
  if (!iso) return 'not set';
  const [year, month, day] = String(iso).split('-').map(Number);
  if (!year || !month || !day || month < 1 || month > 12) return 'not set';
  return `${MONTHS[month - 1]} ${day}`;
}

export function formatCampaignDates(start, end) {
  return `${formatCampaignDate(start)} – ${end ? formatCampaignDate(end) : 'not set'}`;
}

export function headlineMetrics(campaign, { includeMachineOpens = false } = {}) {
  const leads = campaign?.leads || [];
  const touched = leads.filter(isTouchedLead);
  const replied = (lead) => (lead.touches || []).some((touch) => touch.type === 'replied');
  const humanOpen = (lead) => (lead.touches || []).some((touch) => touch.type === 'opened' && !touch.machineOpen);
  const machineOpen = (lead) => (lead.touches || []).some((touch) => touch.type === 'opened' && touch.machineOpen === true);
  const openedNoReply = touched.filter((lead) => {
    if (replied(lead)) return false;
    if (includeMachineOpens) return humanOpen(lead) || machineOpen(lead);
    return humanOpen(lead);
  }).length;
  const machineOpens = touched.filter((lead) => !replied(lead) && machineOpen(lead)).length;
  const prototypeViews = leads.reduce((sum, lead) => (
    sum + (lead.touches || []).filter((touch) => touch.type === 'prototype_viewed').length
  ), 0);
  return {
    enrolled: leads.length,
    touched: touched.length,
    responded: touched.filter(replied).length,
    converted: touched.filter((lead) => (lead.touches || []).some((touch) => touch.type === 'won' || touch.type === 'mvp_sold')).length,
    openedNoReply,
    machineOpens,
    prototypeViews,
  };
}

export function untouchedMessage(metrics) {
  if (!metrics || metrics.touched > 0) return null;
  if (metrics.prototypeViews > 0) {
    const n = metrics.prototypeViews;
    const verb = n === 1 ? 'is' : 'are';
    const noun = n === 1 ? 'prototype view' : 'prototype views';
    return `No sent or call-logged touches yet. ${n} ${noun} ${verb} tracked but ${n === 1 ? "isn't" : "aren't"} a touch for these rates.`;
  }
  return 'No touches logged';
}

export function campaignMatchesStatus(campaign, status) {
  if (!status || status === 'all') return true;
  return campaign.status === status;
}

export function campaignInRange(campaign, range) {
  if (!range?.from || !range?.to) return true;
  const start = campaign.startDate || '0000-01-01';
  // No end date means the campaign is still open, so it overlaps every range that reaches its start.
  const end = campaign.endDate || '9999-12-31';
  return start <= range.to && end >= range.from;
}

/** Active campaigns first, then newest start date. */
export function sortCampaigns(rows) {
  return [...rows].sort((a, b) => {
    const groupA = a.status === 'active' ? 0 : 1;
    const groupB = b.status === 'active' ? 0 : 1;
    if (groupA !== groupB) return groupA - groupB;
    return String(b.startDate || '').localeCompare(String(a.startDate || ''));
  });
}

export function onlyTestCampaigns(rows) {
  return (rows || []).filter((row) => typeof row?.name === 'string' && row.name.startsWith('TEST:'));
}

export const OPENS_CAVEAT = 'Approximate, unreliable (Apple MPP). Opens are a soft signal and never count toward attribution or conversion. Apple Mail Privacy Protection prefetches images, so opens are inflated. Those are flagged as machine opens and excluded by default. Gmail\'s image proxy usually shows only the first open. Blocked images and plain-text clients undercount opens.';

export function footnote({ includeMachineOpens = false } = {}) {
  const opens = includeMachineOpens
    ? 'Opens: including machine opens.'
    : 'Opens: likely-human only (machine opens excluded).';
  return `Touched = leads with at least one Sent or Call logged touch in the range. ${opens} Opens are display-only and never used in attribution or conversion. Converted uses last-touch attribution, 90-day window.`;
}
