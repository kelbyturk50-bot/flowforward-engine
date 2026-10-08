import { api } from '../api';
import { useAsync, ErrorNote, money, relDate, isOverdue, addDays, toast } from '../ui';
import LeadRow from './LeadRow';

function greeting() {
  const h = new Date().getHours();
  return h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening';
}

export default function Today({ version, bump, openLead, openProject }) {
  const { data, error, loading, reload } = useAsync(() => api.focus(), [version]);

  const act = async (fn, msg) => {
    try { await fn(); toast(msg); bump(); } catch (e) { toast(e.message); }
  };
  const markContacted = (lead) => act(
    () => api.updateLead(lead.id, { stage: 'contacted', next_action: 'Follow up', next_action_at: addDays(3) }),
    `${lead.company} moved to Contacted. Follow-up set for ${relDate(addDays(3))}.`);
  const snooze = (lead) => act(
    () => api.updateLead(lead.id, { next_action_at: addDays(3) }),
    `Follow-up moved to ${relDate(addDays(3))}.`);
  const doneTask = (t) => act(() => api.updateTask(t.id, { done: true }), `Checked off “${t.title}”.`);

  const c = data?.counts;
  const date = new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });

  return (
    <div className="page">
      <header className="today-head">
        <h1>{greeting()}, Kelby</h1>
        <p className="muted">{date}</p>
      </header>

      <ErrorNote error={error} onRetry={reload} />

      {c && (
        <dl className="tally">
          <div><dt>Follow-ups due</dt><dd className={data.followups_due.length ? 'hot' : ''}>{data.followups_due.length}</dd></div>
          <div><dt>Open A-tier leads</dt><dd>{c.a_tier_open}</dd></div>
          <div><dt>Qualified + proposal</dt><dd>{c.hot}{c.pipeline_value ? <small> {money(c.pipeline_value)}</small> : null}</dd></div>
          <div><dt>Active projects</dt><dd>{c.active_projects}</dd></div>
          <div><dt>New in 24h</dt><dd>{c.new_24h}</dd></div>
        </dl>
      )}

      {loading && !data && <p className="muted pad">Loading your day…</p>}

      {data && (
        <div className="today-grid">
          <section className="panel">
            <h2>Follow-ups due</h2>
            {data.followups_due.length === 0
              ? <p className="empty">Nothing due. Schedule follow-ups from any lead so they show up here.</p>
              : <ul className="lead-list">{data.followups_due.map(l => (
                  <LeadRow key={l.id} lead={l} onOpen={openLead} showNext
                    actions={<button className="btn btn-quiet btn-sm" onClick={() => snooze(l)}>+3 days</button>} />
                ))}</ul>}
          </section>

          <section className="panel">
            <h2>Call next</h2>
            <p className="panel-note">Highest-fit leads you haven't contacted yet.</p>
            {data.top_new_leads.length === 0
              ? <p className="empty">No untouched A or B leads. Run discovery from Settings or widen your markets.</p>
              : <ul className="lead-list">{data.top_new_leads.map(l => (
                  <LeadRow key={l.id} lead={l} onOpen={openLead} showStage={false}
                    actions={<button className="btn btn-sm" onClick={() => markContacted(l)}>Contacted</button>} />
                ))}</ul>}
          </section>

          {data.gone_quiet.length > 0 && (
            <section className="panel">
              <h2>Gone quiet</h2>
              <p className="panel-note">In conversation, no touch in 7+ days and no follow-up set.</p>
              <ul className="lead-list">{data.gone_quiet.map(l => (
                <LeadRow key={l.id} lead={l} onOpen={openLead}
                  actions={<button className="btn btn-quiet btn-sm" onClick={() => snooze(l)}>Follow up in 3 days</button>} />
              ))}</ul>
            </section>
          )}

          <section className="panel">
            <h2>Project tasks this week</h2>
            {data.task_queue.length === 0
              ? <p className="empty">No dated tasks due this week. Add due dates to project tasks to see them here.</p>
              : <ul className="task-list">{data.task_queue.map(t => (
                  <li key={t.id} className="task">
                    <input type="checkbox" aria-label={`Complete ${t.title}`} onChange={() => doneTask(t)} />
                    <button className="task-body linklike" onClick={() => openProject(t.project_id)}>
                      <span>{t.title}</span>
                      <span className="task-meta">
                        {t.client_company || t.project_name}
                        <span className={isOverdue(t.due_date) ? 'overdue' : ''}>, {relDate(t.due_date)}</span>
                      </span>
                    </button>
                  </li>
                ))}</ul>}
          </section>
        </div>
      )}
    </div>
  );
}
