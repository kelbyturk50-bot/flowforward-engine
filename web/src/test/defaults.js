import { flagRecords, savedFlag } from './flag-fixtures.js';
import { campaignsResponse } from './campaign-api.js';
import { api, settings } from './mock-api.js';
import { contactedLead, discoveryRun, focus, foundLead, project, proposal, summary } from './fixtures.js';

const TEST_URL = 'http://127.0.0.1:3000';

export function installApiDefaults() {
  for (const fn of Object.values(api)) fn.mockReset();

  settings.apiUrl = TEST_URL;
  settings.apiKey = 'test-key';

  api.health.mockResolvedValue({ ok: true });
  api.focus.mockResolvedValue(focus);
  api.meta.mockResolvedValue({ industries: ['HVAC', 'Plumbing'], cities: ['Provo', 'Ogden'] });
  api.stats.mockResolvedValue({ by_stage: [], by_tier: [] });
  api.prospect.mockImplementation(async (id) => ({ ...(id === contactedLead.id ? contactedLead : foundLead), id, activities: [], projects: [] }));
  api.prospects.mockImplementation(async (filters = {}) => {
    const stage = filters.stage || '';
    if (stage === 'found') return { total: 1, prospects: [foundLead] };
    if (stage.includes('contacted')) return { total: 1, prospects: [contactedLead] };
    if (stage.includes('won')) return { total: 1, prospects: [{ ...foundLead, stage: 'won' }] };
    return { total: 1, prospects: [foundLead] };
  });
  api.projects.mockResolvedValue({ projects: [project] });
  api.project.mockResolvedValue({ ...project, tasks: [] });
  api.proposals.mockImplementation(async (filters = {}) => {
    if (filters.view && filters.view !== 'review') return { proposals: [] };
    if (filters.prospect_id) return { proposals: [] };
    return { proposals: [proposal] };
  });
  api.proposalSummary.mockResolvedValue(summary);
  api.proposalJobs.mockResolvedValue({ jobs: [], unreviewed: 0 });
  api.proposal.mockResolvedValue(proposal);
  api.inbox.mockResolvedValue({ items: [], counts: { needs: 0, fyi: 0, handled: 0, working: 0, waiting: 0 } });
  api.markInboxSeen.mockResolvedValue({ ok: true });
  api.runs.mockResolvedValue([discoveryRun]);
  api.proposalRuns.mockResolvedValue([]);
  api.proposalSettings.mockResolvedValue({ style_notes: 'Keep the first email short.' });
  api.gmailStatus.mockResolvedValue({
    connected: false,
    configured: false,
    redirect_uri: `${TEST_URL}/oauth/google/callback`,
  });
  api.get.mockImplementation(async (path) => {
    if (String(path).startsWith('/api/campaigns')) return campaignsResponse();
    throw Object.assign(new Error(`No mock for GET ${path}`), { status: 404 });
  });
  api.flags.mockResolvedValue(flagRecords());
  api.setFlag.mockImplementation(async (name, enabled) => savedFlag(name, enabled));
  api.updateLead.mockResolvedValue(foundLead);
  api.updateTask.mockResolvedValue({});
  api.createLead.mockResolvedValue(foundLead);
  api.createProject.mockResolvedValue(project);
}
