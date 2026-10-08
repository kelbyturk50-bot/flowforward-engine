import { useEffect, useState } from 'react';
import { api } from '../api';
import { useAsync, ErrorNote, PROJECT_STATUSES, money, relDate, isOverdue, Drawer, toast } from '../ui';

const GROUPS = [
  { title: 'Active', ids: ['active'] },
  { title: 'Planning', ids: ['planning'] },
  { title: 'On hold', ids: ['on_hold'] },
  { title: 'Finished', ids: ['done', 'cancelled'], collapsed: true },
];

export default function Projects({ version, bump, openProject }) {
  const { data, error, loading, reload } = useAsync(() => api.projects(), [version]);
  const [creating, setCreating] = useState(false);
  const [showDone, setShowDone] = useState(false);

  const projects = data?.projects || [];
  const activeValue = projects.filter(p => ['active', 'planning'].includes(p.status)).reduce((s, p) => s + (Number(p.value) || 0), 0);

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1>Projects</h1>
          <p className="muted">Client builds and your own work{activeValue ? `, ${money(activeValue)} in active and planned` : ''}</p>
        </div>
        <button className="btn" onClick={() => setCreating(true)}>New project</button>
      </header>

      <ErrorNote error={error} onRetry={reload} />
      {loading && !data && <p className="muted pad">Loading projects…</p>}
      {data && projects.length === 0 && (
        <p className="empty pad">No projects yet. Start one here, or mark a lead won to open a client project automatically.</p>
      )}

      {GROUPS.map(g => {
        const list = projects.filter(p => g.ids.includes(p.status));
        if (!list.length) return null;
        const hidden = g.collapsed && !showDone;
        return (
          <section key={g.title} className="proj-group">
            <h2>
              {g.title} <span className="muted">{list.length}</span>
              {g.collapsed && <button className="btn btn-quiet btn-sm" onClick={() => setShowDone(s => !s)}>{showDone ? 'Hide' : 'Show'}</button>}
            </h2>
            {!hidden && (
              <ul className="proj-list">
                {list.map(p => {
                  const pct = p.task_total ? Math.round((p.task_done / p.task_total) * 100) : 0;
                  return (
                    <li key={p.id}>
                      <button className="proj-row" onClick={() => openProject(p.id)}>
                        <span className={`prio prio-${p.priority}`} title={`${p.priority} priority`} />
                        <span className="proj-main">
                          <span className="lead-name">{p.name}</span>
                          <span className="lead-sub">{p.client_company || 'Internal'}{p.value ? `, ${money(p.value)}` : ''}</span>
                        </span>
                        <span className="proj-progress" aria-label={`${p.task_done} of ${p.task_total} tasks done`}>
                          <span className="bar"><span style={{ width: `${pct}%` }} /></span>
                          <span className="muted small">{p.task_done}/{p.task_total}</span>
                        </span>
                        <span className={`proj-due ${isOverdue(p.due_date) && !['done', 'cancelled'].includes(p.status) ? 'overdue' : 'muted'}`}>
                          {p.task_overdue > 0 ? `${p.task_overdue} overdue` : p.due_date ? `Due ${relDate(p.due_date)}` : ''}
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
        );
      })}

      <NewProject open={creating} onClose={() => setCreating(false)}
        onCreated={(p) => { setCreating(false); bump(); openProject(p.id); toast(`Created ${p.name}.`); }} />
    </div>
  );
}

function NewProject({ open, onClose, onCreated }) {
  const empty = { name: '', prospect_id: '', status: 'planning', priority: 'medium', value: '', start_date: '', due_date: '', description: '' };
  const [b, setB] = useState(empty);
  const [clients, setClients] = useState([]);
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setB(empty); setErr(null);
    api.prospects({ stage: 'won,proposal,qualified,responded', sort: 'company', limit: 500 })
      .then(d => setClients(d.prospects)).catch(() => setClients([]));
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  const set = (k) => (e) => setB(x => ({ ...x, [k]: e.target.value }));
  const submit = async (e) => {
    e.preventDefault(); setBusy(true); setErr(null);
    try { onCreated(await api.createProject({ ...b, prospect_id: b.prospect_id || null })); }
    catch (e2) { setErr(e2); } finally { setBusy(false); }
  };

  return (
    <Drawer open={open} onClose={onClose} label="New project">
      <form className="drawer-body form" onSubmit={submit}>
        <h2>New project</h2>
        <label>Name<input className="input" required value={b.name} onChange={set('name')} placeholder="Missed-call text-back for Acme HVAC" /></label>
        <label>Client
          <select className="input" value={b.prospect_id} onChange={set('prospect_id')}>
            <option value="">None, internal project</option>
            {clients.map(c => <option key={c.id} value={c.id}>{c.company}</option>)}
          </select>
        </label>
        <div className="two">
          <label>Status<select className="input" value={b.status} onChange={set('status')}>
            {PROJECT_STATUSES.map(s => <option key={s.id} value={s.id}>{s.label}</option>)}</select></label>
          <label>Priority<select className="input" value={b.priority} onChange={set('priority')}>
            <option value="high">High</option><option value="medium">Medium</option><option value="low">Low</option></select></label>
        </div>
        <div className="two">
          <label>Start<input className="input" type="date" value={b.start_date} onChange={set('start_date')} /></label>
          <label>Due<input className="input" type="date" value={b.due_date} onChange={set('due_date')} /></label>
        </div>
        <label>Value ($)<input className="input" type="number" min="0" value={b.value} onChange={set('value')} /></label>
        <label>Scope<textarea className="input" rows={4} value={b.description} onChange={set('description')} /></label>
        <ErrorNote error={err} />
        <div className="form-actions"><button className="btn" disabled={busy}>{busy ? 'Creating…' : 'Create project'}</button></div>
      </form>
    </Drawer>
  );
}
