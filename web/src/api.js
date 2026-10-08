// Thin client for the FlowForward Engine API.
const DEFAULT_URL = import.meta.env.VITE_API_URL || 'https://flowforward-engine-production.up.railway.app';

function read(key, fallback = '') {
  try { return localStorage.getItem(key) ?? fallback; } catch { return fallback; }
}
function write(key, val) {
  try { val ? localStorage.setItem(key, val) : localStorage.removeItem(key); } catch { /* storage blocked */ }
}

export const settings = {
  get apiUrl() { return read('ff.apiUrl', DEFAULT_URL).replace(/\/+$/, ''); },
  set apiUrl(v) { write('ff.apiUrl', (v || '').trim()); },
  get apiKey() { return read('ff.apiKey'); },
  set apiKey(v) { write('ff.apiKey', (v || '').trim()); },
};

export class ApiError extends Error {
  constructor(message, status) { super(message); this.status = status; }
}

async function request(method, path, body) {
  let res;
  try {
    res = await fetch(settings.apiUrl + path, {
      method,
      headers: {
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...(settings.apiKey ? { 'x-api-key': settings.apiKey } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new ApiError(`Can't reach the API at ${settings.apiUrl}. Check the URL in Settings and that Railway is up.`, 0);
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
};
