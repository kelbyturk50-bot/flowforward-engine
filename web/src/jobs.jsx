// Background drafting jobs (single-lead drafts and rewrites), shared app-wide.
// Polls the API while anything is running, toasts when a job finishes, and
// exposes per-lead status so any screen can show "Rewriting…" or "Ready".
import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { api, settings } from './api';
import { toast } from './ui';

const JobsContext = createContext({ jobs: [], unreviewed: 0, inboxWaiting: 0, inboxWorking: 0, refresh: () => {}, activeFor: () => null, finishedFor: () => null, dismiss: () => {} });
export const useJobs = () => useContext(JobsContext);

export function JobsProvider({ bump, version, children }) {
  const [state, setState] = useState({ jobs: [], unreviewed: 0, inboxWaiting: 0, inboxWorking: 0 });
  const prev = useRef(null);
  const timer = useRef(null);

  const refresh = useCallback(async () => {
    if (!settings.apiKey) return;
    let data;
    try { data = await api.proposalJobs(); } catch { return; }
    const before = prev.current;
    if (before) {
      for (const j of data.jobs) {
        const was = before.get(j.id);
        if (!was || was === j.status || !['queued', 'running'].includes(was)) continue;
        if (j.status === 'done') {
          toast(`${j.kind === 'rewrite' ? 'New version' : 'Draft'} ready for ${j.company}. It's in To review, marked New.`);
          bump();
        } else if (j.status === 'failed') {
          toast(`Couldn't finish ${j.company}: ${j.error || 'unknown error'}`);
          bump();
        }
      }
    }
    prev.current = new Map(data.jobs.map(j => [j.id, j.status]));
    setState({ jobs: data.jobs || [], unreviewed: data.unreviewed || 0, inboxWaiting: data.inbox_waiting || 0, inboxWorking: data.inbox_working || 0 });
  }, [bump]);

  const active = state.jobs.some(j => ['queued', 'running'].includes(j.status)) || state.inboxWorking > 0;
  useEffect(() => { refresh(); }, [refresh, version]);
  useEffect(() => {
    clearInterval(timer.current);
    timer.current = setInterval(refresh, active ? 5000 : 60000);
    return () => clearInterval(timer.current);
  }, [active, refresh]);

  const activeFor = useCallback((prospectId) =>
    state.jobs.find(j => j.prospect_id === prospectId && ['queued', 'running'].includes(j.status)) || null, [state.jobs]);
  const finishedFor = useCallback((prospectId) =>
    state.jobs.find(j => j.prospect_id === prospectId && ['done', 'failed'].includes(j.status) && !j.dismissed_at) || null, [state.jobs]);
  const dismiss = useCallback(async (id) => { try { await api.dismissJob(id); } catch { /* ignore */ } refresh(); }, [refresh]);

  return (
    <JobsContext.Provider value={{ ...state, refresh, activeFor, finishedFor, dismiss }}>
      {children}
    </JobsContext.Provider>
  );
}

export function elapsed(ts) {
  if (!ts) return '';
  const s = Math.max(0, Math.round((Date.now() - new Date(ts).getTime()) / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}
