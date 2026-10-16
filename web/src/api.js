// Thin client for the FlowForward Engine API.
// Base URL rules live in api-base.js.
import { resolveApiBase, UNCONFIGURED_MESSAGE } from './api-base.js';

function read(key, fallback = '') {
  try { return localStorage.getItem(key) ?? fallback; } catch { return fallback; }
}
function write(key, val) {
  try { val ? localStorage.setItem(key, val) : localStorage.removeItem(key); } catch { /* storage blocked */ }
}

function liveRuntime() {
  return {
    viteApiUrl: import.meta.env.VITE_API_URL,
    dev: import.meta.env.DEV,
    prod: import.meta.env.PROD,
    hostname: typeof window !== 'undefined' ? window.location.hostname : '',
    port: typeof window !== 'undefined' ? window.location.port : '',
    protocol: typeof window !== 'undefined' ? window.location.protocol : '',
    savedUrl: read('ff.apiUrl', ''),
  };
}

// Tests pass a runtime so production-host rules can run under Vitest,
// where `import.meta.env.DEV` is always true. The app never calls this.
let runtimeOverride = null;
export function _setRuntimeForTests(runtime) {
  runtimeOverride = runtime;
}

export function currentApiBase() {
  const live = liveRuntime();
  return resolveApiBase(runtimeOverride ? { ...live, ...runtimeOverride } : live);
}

export const settings = {
  get apiUrl() { return currentApiBase().url; },
  set apiUrl(v) { write('ff.apiUrl', (v || '').trim()); },
  get apiKey() { return read('ff.apiKey'); },
  set apiKey(v) { write('ff.apiKey', (v || '').trim()); },
};

export class ApiError extends Error {
  constructor(message, status) { super(message); this.status = status; }
}

async function request(method, path, body) {
  const base = currentApiBase();
  if (!base.configured || !base.url) throw new ApiError(UNCONFIGURED_MESSAGE, 0);
  let res;
  try {
    res = await fetch(base.url + path, {
      method,
      headers: {
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...(settings.apiKey ? { 'x-api-key': settings.apiKey } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new ApiError(`Can't reach the API at ${base.url}. Check the URL in Settings and that Railway is up.`, 0);
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 401) window.dispatchEvent(new CustomEvent('ff:unauthorized'));
    throw new ApiError(data.error || `Request failed (${res.status})`, res.status);
  }
  return data;
}

const qs = (o) => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(o)) if (v !== '' && v != null) p.set(k, v);
  const s = p.toString();
  return s ? '?' + s : '';
};

export const localToday = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

export const api = {
  health:        ()          => request('GET', '/health'),
  focus:         ()          => request('GET', `/api/focus${qs({ today: localToday() })}`),
  prospects:     (f = {})    => request('GET', `/api/prospects${qs(f)}`),
  prospect:      (id)        => request('GET', `/api/prospects/${id}`),
  meta:          ()          => request('GET', '/api/prospects/meta'),
  stats:         ()          => request('GET', '/api/prospects/stats'),
  createLead:    (b)         => request('POST', '/api/prospects', b),
  updateLead:    (id, b)     => request('PATCH', `/api/prospects/${id}`, b),
  logActivity:   (id, b)     => request('POST', `/api/prospects/${id}/activities`, b),
  convertLead:   (id, b={})  => request('POST', `/api/prospects/${id}/convert`, b),
  rescore:       ()          => request('POST', '/api/prospects/rescore'),
  projects:      (f = {})    => request('GET', `/api/projects${qs(f)}`),
  project:       (id)        => request('GET', `/api/projects/${id}`),
  createProject: (b)         => request('POST', '/api/projects', b),
  updateProject: (id, b)     => request('PATCH', `/api/projects/${id}`, b),
  deleteProject: (id)        => request('DELETE', `/api/projects/${id}`),
  addTask:       (pid, b)    => request('POST', `/api/projects/${pid}/tasks`, b),
  updateTask:    (id, b)     => request('PATCH', `/api/tasks/${id}`, b),
  deleteTask:    (id)        => request('DELETE', `/api/tasks/${id}`),
  runs:          ()          => request('GET', '/api/runs'),
  triggerRun:    ()          => request('POST', '/api/runs/trigger'),
  // Proposal bot
  proposals:         (f = {})       => request('GET', `/api/proposals${qs(f)}`),
  proposalSummary:   ()             => request('GET', '/api/proposals/summary'),
  proposal:          (id)           => request('GET', `/api/proposals/${id}`),
  draftProposal:     (prospect_id, instructions) => request('POST', '/api/proposals', { prospect_id, instructions }),
  updateProposal:    (id, b)        => request('PATCH', `/api/proposals/${id}`, b),
  sendProposal:      (id)           => request('POST', `/api/proposals/${id}/send`),
  regenerateProposal:(id, b)        => request('POST', `/api/proposals/${id}/regenerate`, b),
  proposalJobs:      ()             => request('GET', '/api/proposals/jobs'),
  dismissJob:        (id)           => request('POST', `/api/proposals/jobs/${id}/dismiss`),
  markProposalSeen:  (id)           => request('POST', `/api/proposals/${id}/seen`),
  markSentProposal:  (id, note)     => request('POST', `/api/proposals/${id}/mark-sent`, { note }),
  stopProposal:      (id, reason)   => request('POST', `/api/proposals/${id}/stop`, { reason }),
  repliedProposal:   (id, note)     => request('POST', `/api/proposals/${id}/replied`, { note }),
  discardProposal:   (id, b = {})   => request('POST', `/api/proposals/${id}/discard`, b),
  restoreProposal:   (id)           => request('POST', `/api/proposals/${id}/restore`),
  proposalRuns:      ()             => request('GET', '/api/proposals/runs'),
  triggerProposals:  (count)        => request('POST', '/api/proposals/runs/trigger', { count }),
  proposalSettings:  ()             => request('GET', '/api/proposals/settings'),
  saveProposalSettings: (b)         => request('PUT', '/api/proposals/settings', b),
  checkInbox:        ()             => request('POST', '/api/proposals/check-inbox'),
  gmailStatus:       ()             => request('GET', '/api/proposals/gmail/status'),
  gmailConnect:      (return_to)    => request('POST', '/api/proposals/gmail/connect', { return_to }),
  gmailDisconnect:   ()             => request('POST', '/api/proposals/gmail/disconnect'),
};
