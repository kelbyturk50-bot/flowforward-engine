// List endpoint for Campaigns slice 1.
//
// Canyon has not published a campaigns API contract on issue #67 or in a PR.
// This function is the only place that would call one. Until that contract
// exists it returns the TEST: fixture and does not touch the network.
// Nothing in this module sends email, SMS, or a proposal.

import { flagOverrideAllowed } from '../flags.js';
import { FIXTURE_CAMPAIGNS } from './fixture.js';
import { onlyTestCampaigns } from './metrics.js';

export const CAMPAIGNS_ENDPOINT = '/api/campaigns';

function previewState(location, env) {
  if (!flagOverrideAllowed(location, env)) return '';
  const params = new URLSearchParams(location?.search || '');
  const value = params.get('campaigns');
  if (value === 'empty' || value === 'error' || value === 'loading') return value;
  return '';
}

export function listCampaigns({
  location = typeof window !== 'undefined' ? window.location : { search: '' },
  env = import.meta.env,
} = {}) {
  const preview = previewState(location, env);
  if (preview === 'loading') return new Promise(() => {});
  if (preview === 'error') {
    return Promise.reject(Object.assign(new Error('campaigns_unavailable'), { status: 0 }));
  }
  if (preview === 'empty') return Promise.resolve({ campaigns: [], endpoint: CAMPAIGNS_ENDPOINT });
  return Promise.resolve({
    campaigns: onlyTestCampaigns(FIXTURE_CAMPAIGNS),
    endpoint: CAMPAIGNS_ENDPOINT,
  });
}
