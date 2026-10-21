// Stand-in for src/api.js. Tests import this instead of the real client.
// No network, no production URL, no credentials.
import { vi } from 'vitest';

export const settings = {
  apiUrl: 'http://127.0.0.1:3000',
  apiKey: 'test-key',
};

export function currentApiBase() {
  return { url: settings.apiUrl, configured: true, source: 'test' };
}

export class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

export const localToday = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

const method = () => vi.fn(async () => ({}));

export const api = {
  get: method(),
  health: method(),
  focus: method(),
  prospects: method(),
  prospect: method(),
  meta: method(),
  stats: method(),
  createLead: method(),
  updateLead: method(),
  logActivity: method(),
  convertLead: method(),
  rescore: method(),
  projects: method(),
  project: method(),
  createProject: method(),
  updateProject: method(),
  deleteProject: method(),
  addTask: method(),
  updateTask: method(),
  deleteTask: method(),
  runs: method(),
  triggerRun: method(),
  proposals: method(),
  proposalSummary: method(),
  proposal: method(),
  draftProposal: method(),
  updateProposal: method(),
  sendProposal: method(),
  regenerateProposal: method(),
  rebuildOnepager: method(),
  proposalJobs: method(),
  inbox: method(),
  inboxItem: method(),
  updateInboxItem: method(),
  sendInboxReply: method(),
  rewriteInboxReply: method(),
  handleInboxItem: method(),
  discardInboxDraft: method(),
  reopenInboxItem: method(),
  applyInboxSuggestion: method(),
  markInboxSeen: method(),
  createPrototype: method(),
  updatePrototype: method(),
  revokePrototype: method(),
  matchPrototypeColors: method(),
  dismissJob: method(),
  markProposalSeen: method(),
  markSentProposal: method(),
  stopProposal: method(),
  repliedProposal: method(),
  discardProposal: method(),
  restoreProposal: method(),
  proposalRuns: method(),
  triggerProposals: method(),
  proposalSettings: method(),
  saveProposalSettings: method(),
  checkInbox: method(),
  gmailStatus: method(),
  gmailConnect: method(),
  gmailDisconnect: method(),
  flags: method(),
  setFlag: method(),
};
