// List endpoint for Campaigns slice 1: GET /api/campaigns (PR #74, contract
// agreed on #67 Oct 18). This module is the only list call site.
// Nothing in this module sends email, SMS, or a proposal.
//
// Preview hosts (the same rule as ?flags=) can add ?campaigns=empty, error,
// loading, or fixture to show a state or the TEST: sample data without the
// API. Production hosts ignore that parameter and always read the API.

import { api } from '../api.js';
import { flagOverrideAllowed } from '../flags.js';
import { FIXTURE_CAMPAIGNS } from './fixture.js';
import { onlyTestCampaigns } from './metrics.js';

export const CAMPAIGNS_ENDPOINT = '/api/campaigns';

const PREVIEW_STATES = new Set(['empty', 'error', 'loading', 'fixture']);
const DAY = /^\d{4}-\d{2}-\d{2}$/;

function previewState(location, env) {
  if (!flagOverrideAllowed(location, env)) return '';
  const params = new URLSearchParams(location?.search || '');
  const value = params.get('campaigns');
  return PREVIEW_STATES.has(value) ? value : '';
}

function count(value) {
  return Number.isInteger(value) && value >= 0 ? value : 0;
}

function day(value) {
  return typeof value === 'string' && DAY.test(value) ? value : null;
}

// One API row -> the shape the view renders. Counts are leads; the view
// never recomputes them.
export function fromApiCampaign(row) {
  return {
    id: row.id,
    name: typeof row.name === 'string' ? row.name : '',
    channel: row.channel,
    segment: row.segment ?? null,
    status: row.status,
    startDate: day(row.start_date),
    endDate: day(row.end_date),
    costCents: Number.isInteger(row.cost_cents) ? row.cost_cents : null,
    counts: {
      enrolled: count(row.enrolled),
      touched: count(row.touched),
      responded: count(row.responded),
      converted: count(row.converted),
      openedNoReplyHuman: count(row.opened_no_response_human),
      openedNoReplyAll: count(row.opened_no_response_incl_machine),
      machineOpens: count(row.machine_opens),
      prototypeViews: count(row.prototype_views),
    },
  };
}

function query(range) {
  const params = new URLSearchParams();
  if (range?.from && DAY.test(range.from)) params.set('from', range.from);
  if (range?.to && DAY.test(range.to)) params.set('to', range.to);
  const text = params.toString();
  return text ? `?${text}` : '';
}

export function listCampaigns({
  range = null,
  location = typeof window !== 'undefined' ? window.location : { search: '' },
  env = import.meta.env,
  get = api.get,
} = {}) {
  const preview = previewState(location, env);
  if (preview === 'loading') return new Promise(() => {});
  if (preview === 'error') {
    return Promise.reject(Object.assign(new Error('campaigns_unavailable'), { status: 0 }));
  }
  if (preview === 'empty') return Promise.resolve({ campaigns: [], endpoint: CAMPAIGNS_ENDPOINT });
  if (preview === 'fixture') {
    return Promise.resolve({ campaigns: onlyTestCampaigns(FIXTURE_CAMPAIGNS), endpoint: CAMPAIGNS_ENDPOINT });
  }
  return Promise.resolve(get(`${CAMPAIGNS_ENDPOINT}${query(range)}`)).then((data) => {
    if (!data || typeof data !== 'object' || !Array.isArray(data.campaigns)) {
      throw Object.assign(new Error('campaigns_unavailable'), { status: 0 });
    }
    return {
      campaigns: data.campaigns.filter((row) => row && typeof row === 'object').map(fromApiCampaign),
      endpoint: CAMPAIGNS_ENDPOINT,
    };
  });
}
