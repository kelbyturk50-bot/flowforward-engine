import { useEffect, useState } from 'react';
import { api } from '../api';
import { Drawer, ErrorNote, PROJECT_STATUSES, relDate, isOverdue, toast } from '../ui';

export default function ProjectDrawer({ id, onClose, bump, openLead }) {
  const [p, setP] = useState(null);
  const [error, setError] = useState(null);

  const load = (pid = id) => api.project(pid).then(setP).catch(setError);
  useEffect(() => { setP(null); setError(null); if (id) load(id); }, [id]); // eslint-disable-line react-hooks/exhaustive-deps

  const save = async (patch, msg) => {
    try { setP(await api.updateProject(p.id, patch)); if (msg) toast(msg); bump(); }
    catch (e) { toast(e.message); }
  };

  return (
    <Drawer open={!!id} onClose={onClose} label={p?.name || 'Project'}>
      {error && <div className="drawer-body"><ErrorNote error={error} /></div>}
      {!p && !error && <div className="drawer-body"><p className="muted">Loading…</p></div>}
      {p && p.id === id && <Body key={p.id} p={p} save={save} reload={() => { load(p.id); bump(); }} openLead={openLead}
        onDeleted={() => { onClose(); bump(); }} />}
    </Drawer>
  );
}

function Text({ label, value, onSave, multiline, type = 'text' }) {
  const [v, setV] = useState(value ?? '');
  useEffect(() => setV(value ?? ''), [value]);
  const props = { className: 'input', value: v, onChange: e => setV(e.target.value), onBlur: () => (value ?? '') !== v && onSave(v) };
  return <label>{label}{multiline ? <textarea rows={5} {...props} /> : <input type={type} {...props} />}</label>;
}

function Body({ p, save, reload, openLead, onDeleted }) {
  const [title, setTitle] = useState('');
  const [due, setDue] = useState('');

  const addTask = async (e) => {
    e.preventDefault();
    if (!title.trim()) return;
    try { await api.addTask(p.id, { title, due_date: due || null }); setTitle(''); setDue(''); reload(); }
    catch (e2) { toast(e2.message); }
  };
  const toggle = async (t) => { try { await api.updateTask(t.id, { done: !t.done }); reload(); } catch (e) { toast(e.message); } };
  const setTaskDue = async (t, d) => { try { await api.updateTask(t.id, { due_date: d || null }); reload(); } catch (e) { toast(e.message); } };
  const remove = async (t) => { try { await api.deleteTask(t.id); reload(); } catch (e) { toast(e.message); } };
  const del = async () => {
    if (!window.confirm(`Delete “${p.name}” and its tasks? This can't be undone.`)) return;
    try { await api.deleteProject(p.id); toast('Project deleted.'); onDeleted(); } catch (e) { toast(e.message); }
  };

  const open = p.tasks.filter(t => !t.done);
  const done = p.tasks.filter(t => t.done);

  return (
    <div className="drawer-body">
      <Text label="Project" value={p.name} onSave={v => v.trim() && save({ name: v })} />
      <p className="muted">
        {p.client_company
          ? <>Client: <button className="linklike" onClick={() => openLead(p.prospect_id)}>{p.client_company}</button></>
          : 'Internal project'}
      </p>

      <div className="two">
        <label>Status<select className="input" value={p.status} onChange={e => save({ status: e.target.value }, 'Status updated.')}>
          {PROJECT_STATUSES.map(s => <option key={s.id} value={s.id}>{s.label}</option>)}</select></label>
        <label>Priority<select className="input" value={p.priority} onChange={e => save({ priority: e.target.value })}>
          <option value="high">High</option><option value="medium">Medium</option><option value="low">Low</option></select></label>
      </div>
      <div className="two">
        <label>Start<input className="input" type="date" value={p.start_date || ''} onChange={e => save({ start_date: e.target.value })} /></label>
        <label>Due<input className="input" type="date" value={p.due_date || ''} onChange={e => save({ due_date: e.target.value })} /></label>
      </div>
      <Text label="Value ($)" type="number" value={p.value ?? ''} onSave={v => save({ value: v })} />

      <section className="block">
        <h3>Tasks <span className="muted">{done.length}/{p.tasks.length}</span></h3>
        <form className="log-form" onSubmit={addTask}>
          <input className="input grow" value={title} onChange={e => setTitle(e.target.value)} placeholder="Add a task" aria-label="New task" />
          <input className="input" type="date" value={due} onChange={e => setDue(e.target.value)} aria-label="Due date" />
          <button className="btn btn-sm" disabled={!title.trim()}>Add</button>
        </form>
        <ul className="task-list">
          {[...open, ...done].map(t => (
            <li key={t.id} className={`task ${t.done ? 'done' : ''}`}>
              <input type="checkbox" checked={t.done} onChange={() => toggle(t)} aria-label={`Mark ${t.title} ${t.done ? 'not done' : 'done'}`} />
              <span className="task-body">
                <span>{t.title}</span>
                {t.due_date && !t.done && <span className={`task-meta ${isOverdue(t.due_date) ? 'overdue' : ''}`}>{relDate(t.due_date)}</span>}
              </span>
              {!t.done && <input className="input input-date-sm" type="date" value={t.due_date || ''} onChange={e => setTaskDue(t, e.target.value)} aria-label={`Due date for ${t.title}`} />}
              <button className="icon-btn" onClick={() => remove(t)} aria-label={`Delete ${t.title}`}>×</button>
            </li>
          ))}
        </ul>
        {p.tasks.length === 0 && <p className="empty">Break the work into tasks. Dated tasks show up on Today.</p>}
      </section>

      <Text label="Scope and notes" multiline value={p.description} onSave={v => save({ description: v })} />

      <div className="danger-row"><button className="btn btn-danger btn-sm" onClick={del}>Delete project</button></div>
    </div>
  );
}
