// GET /api/campaigns rows built from the TEST: fixture, so view tests go
// through the real client mapping (fromApiCampaign) with known numbers.
import { FIXTURE_CAMPAIGNS } from '../campaigns/fixture.js';
import { headlineMetrics } from '../campaigns/metrics.js';

export function toApiRow(campaign, id) {
  const human = headlineMetrics(campaign, { includeMachineOpens: false });
  const all = headlineMetrics(campaign, { includeMachineOpens: true });
  return {
    id,
    name: campaign.name,
    status: campaign.status,
    channel: campaign.channel,
    start_date: campaign.startDate || null,
    end_date: campaign.endDate || null,
    segment: campaign.segment || null,
    enrolled: human.enrolled,
    touched: human.touched,
    responded: human.responded,
    converted: human.converted,
    opened_no_response_human: human.openedNoReply,
    opened_no_response_incl_machine: all.openedNoReply,
    machine_opens: human.machineOpens,
    prototype_views: human.prototypeViews,
    cost_cents: campaign.costCents ?? null,
  };
}

export function campaignsResponse(campaigns = FIXTURE_CAMPAIGNS) {
  return {
    range: { from: null, to: null },
    attribution: { model: 'any' },
    campaigns: campaigns.map((campaign, index) => toApiRow(campaign, index + 1)),
  };
}
