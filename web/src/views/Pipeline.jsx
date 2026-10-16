import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { useAsync, ErrorNote, FitBadge, STAGES, stageLabel, money, relDate, isOverdue, useNarrow, toast, presentError } from '../ui';
import { compactMoney } from '../format';

const COLUMNS = ['found', 'contacted', 'responded', 'qualified', 'proposal'];
const OUTCOMES = ['won', 'lost', 'disqualified'];
const CHIP_STAGES = [...COLUMNS, ...OUTCOMES];

export default function Pipeline({ version, bump, openLead, openProject }) {
  const { data, error, reload } = useAsync(async () => {
    const [active, found, closed, stats] = await Promise.all([
      api.prospects({ stage: COLUMNS.slice(1).join(','), sort: 'fit', limit: 1000 }),
      api.prospects({ stage: 'found', tier: 'A,B', sort: 'fit', limit: 25 }),
      api.prospects({ stage: OUTCOMES.join(','), sort: 'fit', limit: 200 }),
      api.stats().catch(() => null),
    ]);
    return { leads: [...found.prospects, ...active.prospects], closed: closed.prospects, foundTotal: found.total, stats };
  }, [version]);

  const [dragId, setDragId] = useState(null);
  const [over, setOver] = useState(null);
  const [stage, setStage] = useState('contacted');
  const narrow = useNarrow();

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
          <p className="muted desk-hint">Drag a card to move it, or use its menu. Dropping on Won starts a project.</p>
          <p className="muted phone-hint">Tap a stage to filter. Use a card{"'"}s menu to move it. Won starts a project.</p>
        </div>
      </header>
      <ErrorNote error={presentError(error)} onRetry={reload} />

      {narrow && <StageChips stage={stage} onPick={setStage} stats={data?.stats} leads={data?.leads} closed={data?.closed} />}
      {narrow && <div className="pipe-list">
        {stage === 'found' && data && data.foundTotal > (data.leads.filter(l => l.stage === 'found').length) && (
          <p className="panel-note">Showing the top {data.leads.filter(l => l.stage === 'found').length} A and B leads of {data.foundTotal}.</p>
        )}
        <PipeCards
          leads={(OUTCOMES.includes(stage) ? data?.closed : data?.leads)?.filter(l => l.stage === stage) || []}
          ready={!!data}
          stage={stage}
          move={move}
          openLead={openLead}
        />
      </div>}

      {!narrow && <div className="board">
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
      </div>}

      {!narrow && <div className="outcomes" aria-label="Close out">
        {OUTCOMES.map(o => (
          <div key={o} className={`outcome outcome-${o} ${over === o ? 'col-over' : ''}`} {...dropProps(o)}>
            Drop here: {stageLabel(o)}
          </div>
        ))}
      </div>}
    </div>
  );
}

function stageStat(id, stats, leads, closed) {
  const fromApi = stats?.stages?.[id];
  if (fromApi) return { count: fromApi.count || 0, value: Number(fromApi.value) || 0 };
  const rows = (OUTCOMES.includes(id) ? closed : leads)?.filter(l => l.stage === id) || [];
  return { count: rows.length, value: rows.reduce((s, l) => s + (Number(l.est_value) || 0), 0) };
}

function StageChips({ stage, onPick, stats, leads, closed }) {
  const ref = useRef(null);
  useEffect(() => {
    const el = ref.current?.querySelector('[aria-pressed="true"]');
    try { el?.scrollIntoView?.({ inline: 'nearest', block: 'nearest' }); } catch { /* jsdom has no scroll */ }
  }, [stage]);
  return (
    <div className="stage-scroller" ref={ref} role="toolbar" aria-label="Pipeline stages">
      {CHIP_STAGES.map(id => {
        const s = stageStat(id, stats, leads, closed);
        const on = stage === id;
        return (
          <button key={id} type="button" className={`stage-chip ${on ? 'active' : ''}`} aria-pressed={on} onClick={() => onPick(id)}>
            <span className="stage-chip-name">{stageLabel(id)}</span>
            <span className="stage-chip-meta">{s.count} · {compactMoney(s.value)}</span>
          </button>
        );
      })}
    </div>
  );
}

function PipeCards({ leads, ready, stage, move, openLead }) {
  if (ready && leads.length === 0) return <p className="empty">Nothing in {stageLabel(stage)} yet.</p>;
  return leads.map(l => (
    <article key={l.id} className="pipe-card">
      <button className="card-hit" onClick={() => openLead(l.id)}>
        <FitBadge score={l.fit_score} tier={l.fit_tier} size="sm" />
        <span className="card-main">
          <span className="lead-name">{l.company}</span>
          <span className="lead-sub">{l.industry}{l.city ? ` · ${l.city}` : ''}{l.est_value ? ` · ${compactMoney(l.est_value)}` : ''}</span>
        </span>
      </button>
      <div className="card-foot">
        <span className={isOverdue(l.next_action_at) ? 'overdue' : 'muted'}>
          {l.next_action_at ? relDate(l.next_action_at) : l.est_value ? compactMoney(l.est_value) : ''}
        </span>
        <select className="mini-select" value="" aria-label={`Move ${l.company}`} onChange={(e) => move(l, e.target.value)}>
          <option value="" disabled>Move…</option>
          {STAGES.filter(s => s.id !== l.stage).map(s => <option key={s.id} value={s.id}>{s.label}</option>)}
        </select>
      </div>
    </article>
  ));
}
