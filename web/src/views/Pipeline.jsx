import { useState } from 'react';
import { api } from '../api';
import { useAsync, ErrorNote, FitBadge, STAGES, stageLabel, money, relDate, isOverdue, toast } from '../ui';

const COLUMNS = ['found', 'contacted', 'responded', 'qualified', 'proposal'];
const OUTCOMES = ['won', 'lost', 'disqualified'];

export default function Pipeline({ version, bump, openLead, openProject }) {
  const { data, error, reload } = useAsync(async () => {
    const [active, found] = await Promise.all([
      api.prospects({ stage: COLUMNS.slice(1).join(','), sort: 'fit', limit: 1000 }),
      api.prospects({ stage: 'found', tier: 'A,B', sort: 'fit', limit: 25 }),
    ]);
    return { leads: [...found.prospects, ...active.prospects], foundTotal: found.total };
  }, [version]);

  const [dragId, setDragId] = useState(null);
  const [over, setOver] = useState(null);

  const move = async (lead, stage) => {
    if (!lead || lead.stage === stage) return;
    try {
      if (stage === 'won') {
        const proj = await api.convertLead(lead.id);
        toast(`${lead.company} won. Project created.`);
        bump(); openProject(proj.id);
      } else {
        await api.updateLead(lead.id, { stage });
        toast(`${lead.company} moved to ${stageLabel(stage)}.`);
        bump();
      }
    } catch (e) { toast(e.message); }
  };

  const byId = (id) => data?.leads.find(l => l.id === id);
  const dropProps = (stage) => ({
    onDragOver: (e) => { e.preventDefault(); setOver(stage); },
    onDragLeave: () => setOver(o => o === stage ? null : o),
    onDrop: (e) => { e.preventDefault(); setOver(null); move(byId(dragId), stage); setDragId(null); },
  });

  return (
    <div className="page page-wide">
      <header className="page-head">
        <div>
          <h1>Pipeline</h1>
          <p className="muted">Drag a card to move it, or use its menu. Dropping on Won starts a project.</p>
        </div>
      </header>
      <ErrorNote error={error} onRetry={reload} />

      <div className="board">
        {COLUMNS.map(stage => {
          const leads = data?.leads.filter(l => l.stage === stage) || [];
          const value = leads.reduce((s, l) => s + (Number(l.est_value) || 0), 0);
          return (
            <section key={stage} className={`col ${over === stage ? 'col-over' : ''}`} {...dropProps(stage)} aria-label={stageLabel(stage)}>
              <header className="col-head">
                <h2>{stageLabel(stage)}</h2>
                <span className="col-count">
                  {stage === 'found' && data ? `top ${leads.length} of ${data.foundTotal}` : leads.length}
                  {value > 0 && <> {money(value)}</>}
                </span>
              </header>
              <div className="col-cards">
                {leads.map(l => (
                  <article key={l.id} className={`card ${dragId === l.id ? 'dragging' : ''}`} draggable
                    onDragStart={() => setDragId(l.id)} onDragEnd={() => { setDragId(null); setOver(null); }}>
                    <button className="card-hit" onClick={() => openLead(l.id)}>
                      <FitBadge score={l.fit_score} tier={l.fit_tier} size="sm" />
                      <span className="card-main">
                        <span className="lead-name">{l.company}</span>
                        <span className="lead-sub">{l.industry}{l.city ? `, ${l.city}` : ''}</span>
                      </span>
                    </button>
                    <div className="card-foot">
                      <span className={isOverdue(l.next_action_at) ? 'overdue' : 'muted'}>
                        {l.next_action_at ? relDate(l.next_action_at) : l.est_value ? money(l.est_value) : ''}
                      </span>
                      <select className="mini-select" value="" aria-label={`Move ${l.company}`}
                        onChange={(e) => move(l, e.target.value)}>
                        <option value="" disabled>Move…</option>
                        {STAGES.filter(s => s.id !== l.stage).map(s => <option key={s.id} value={s.id}>{s.label}</option>)}
                      </select>
                    </div>
                  </article>
                ))}
                {data && leads.length === 0 && <p className="col-empty">Nothing here yet</p>}
              </div>
            </section>
          );
        })}
      </div>

      <div className="outcomes" aria-label="Close out">
        {OUTCOMES.map(o => (
          <div key={o} className={`outcome outcome-${o} ${over === o ? 'col-over' : ''}`} {...dropProps(o)}>
            Drop here: {stageLabel(o)}
          </div>
        ))}
      </div>
    </div>
  );
}
