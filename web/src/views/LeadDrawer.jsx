import { useEffect, useState } from 'react';
import { api } from '../api';
import { Drawer, FitBadge, STAGES, Stars, ErrorNote, money, relDate, isOverdue, timeAgo, addDays, telHref, mapsHref, statusLabel, toast } from '../ui';

const ACT_LABEL = { note: 'Note', call: 'Call', email: 'Email', meeting: 'Meeting', stage_change: 'Stage' };

export default function LeadDrawer({ id, onClose, bump, openProject }) {
  const [lead, setLead] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!id) { setLead(null); return; }
    let live = true; setError(null);
    api.prospect(id).then(d => live && setLead(d)).catch(e => live && setError(e));
    return () => { live = false; };
  }, [id]);

  const save = async (patch, msg) => {
    try {
      const updated = await api.updateLead(lead.id, patch);
      const fresh = await api.prospect(lead.id);
      setLead({ ...updated, activities: fresh.activities, projects: fresh.projects });
      if (msg) toast(msg);
      bump();
    } catch (e) { toast(e.message); }
  };

  return (
    <Drawer open={!!id} onClose={onClose} label={lead?.company || 'Lead'}>
      {error && <div className="drawer-body"><ErrorNote error={error} /></div>}
      {!lead && !error && <div className="drawer-body"><p className="muted">Loading…</p></div>}
      {lead && lead.id === id && <LeadBody key={lead.id} lead={lead} save={save} setLead={setLead} bump={bump} openProject={openProject} />}
    </Drawer>
  );
}

function Field({ label, value, onSave, type = 'text', placeholder, multiline }) {
  const [v, setV] = useState(value ?? '');
  useEffect(() => setV(value ?? ''), [value]);
  const commit = () => { if ((value ?? '') !== v) onSave(v); };
  const props = { className: 'input', value: v, placeholder, onChange: e => setV(e.target.value), onBlur: commit };
  return (
    <label>{label}
      {multiline ? <textarea rows={4} {...props} /> : <input type={type} {...props} onKeyDown={e => e.key === 'Enter' && e.currentTarget.blur()} />}
    </label>
  );
}

function LeadBody({ lead, save, setLead, bump, openProject }) {
  const [boost, setBoost] = useState(lead.fit_boost || 0);
  const [actType, setActType] = useState('call');
  const [actBody, setActBody] = useState('');
  const [converting, setConverting] = useState(false);

  const logActivity = async (e) => {
    e.preventDefault();
    if (!actBody.trim()) return;
    try {
      await api.logActivity(lead.id, { type: actType, body: actBody });
      setLead(await api.prospect(lead.id));
      setActBody('');
      bump();
    } catch (e2) { toast(e2.message); }
  };

  const convert = async () => {
    setConverting(true);
    try {
      const proj = await api.convertLead(lead.id);
      toast(`${lead.company} won. Project created.`);
      bump(); openProject(proj.id);
    } catch (e) { toast(e.message); setConverting(false); }
  };

  const quickDates = [['Tomorrow', 1], ['3 days', 3], ['1 week', 7], ['2 weeks', 14]];

  return (
    <div className="drawer-body">
      <header className="lead-head">
        <FitBadge score={lead.fit_score} tier={lead.fit_tier} size="lg" />
        <div>
          <h2>{lead.company}</h2>
          <p className="muted">{lead.industry}{lead.city ? `, ${lead.city}` : ''} <Stars rating={lead.rating} reviews={lead.review_count} /></p>
        </div>
      </header>

      <div className="link-row">
        {lead.phone && <a className="btn btn-sm" href={telHref(lead.phone)}>Call {lead.phone}</a>}
        {lead.email && <a className="btn btn-quiet btn-sm" href={`mailto:${lead.email}`}>Email</a>}
        {lead.website && <a className="btn btn-quiet btn-sm" href={lead.website} target="_blank" rel="noreferrer">Website</a>}
        <a className="btn btn-quiet btn-sm" href={mapsHref(lead)} target="_blank" rel="noreferrer">Map</a>
      </div>

      <section className="block">
        <label className="stage-pick">Stage
          <select className="input" value={lead.stage} onChange={e => save({ stage: e.target.value }, `Moved to ${STAGES.find(s => s.id === e.target.value)?.label}.`)}>
            {STAGES.map(s => <option key={s.id} value={s.id}>{s.label}</option>)}
          </select>
        </label>
      </section>

      <section className="block">
        <h3>Next step</h3>
        <div className="two">
          <Field label="What" value={lead.next_action} placeholder="Call back about scheduling" onSave={v => save({ next_action: v })} />
          <label>When
            <input className="input" type="date" value={lead.next_action_at || ''} onChange={e => save({ next_action_at: e.target.value || null })} />
          </label>
        </div>
        <div className="chips">
          {quickDates.map(([l, n]) => (
            <button key={l} type="button" className="chip" onClick={() => save({ next_action_at: addDays(n), next_action: lead.next_action || 'Follow up' }, `Follow-up set for ${relDate(addDays(n))}.`)}>{l}</button>
          ))}
          {lead.next_action_at && <button type="button" className="chip" onClick={() => save({ next_action_at: null }, 'Follow-up cleared.')}>Clear</button>}
        </div>
        {lead.next_action_at && (
          <p className={isOverdue(lead.next_action_at) ? 'overdue' : 'muted'}>Due {relDate(lead.next_action_at)}</p>
        )}
      </section>

      <section className="block">
        <h3>Log a touch</h3>
        <form className="log-form" onSubmit={logActivity}>
          <select className="input" value={actType} onChange={e => setActType(e.target.value)} aria-label="Type">
            <option value="call">Call</option><option value="email">Email</option>
            <option value="meeting">Meeting</option><option value="note">Note</option>
          </select>
          <input className="input grow" value={actBody} onChange={e => setActBody(e.target.value)} placeholder="What happened?" aria-label="Details" />
          <button className="btn btn-sm" disabled={!actBody.trim()}>Log</button>
        </form>
        {lead.activities?.length > 0 && (
          <ol className="timeline">
            {lead.activities.map(a => (
              <li key={a.id} className={`tl tl-${a.type}`}>
                <span className="tl-type">{ACT_LABEL[a.type] || a.type}</span>
                <span className="tl-body">{a.body}</span>
                <time className="muted" dateTime={a.created_at}>{timeAgo(a.created_at)}</time>
              </li>
            ))}
          </ol>
        )}
      </section>

      <section className="block">
        <h3>Why it ranks {lead.fit_score ?? '–'}</h3>
        <ul className="reasons">
          {(lead.fit_reasons || []).map(r => (
            <li key={r.label} className={r.points < 0 ? 'neg' : ''}>
              <span className="r-label">{r.label}</span>
              <span className="r-bar" aria-hidden="true">
                {r.max > 0 && <span style={{ width: `${Math.max(0, Math.min(100, (r.points / r.max) * 100))}%` }} />}
              </span>
              <span className="r-pts">{r.points > 0 ? '+' : ''}{r.points}</span>
              <span className="r-detail">{r.detail}</span>
            </li>
          ))}
        </ul>
        <label className="boost">Your adjustment: <strong>{boost > 0 ? '+' : ''}{boost}</strong>
          <input type="range" min={-20} max={20} step={5} value={boost}
            onChange={e => setBoost(Number(e.target.value))}
            onPointerUp={() => boost !== (lead.fit_boost || 0) && save({ fit_boost: boost }, 'Fit score updated.')}
            onKeyUp={() => boost !== (lead.fit_boost || 0) && save({ fit_boost: boost }, 'Fit score updated.')} />
        </label>
      </section>

      <section className="block">
        <h3>Details</h3>
        <div className="two">
          <Field label="Contact name" value={lead.contact_name} onSave={v => save({ contact_name: v })} />
          <Field label="Estimated value ($)" type="number" value={lead.est_value ?? ''} onSave={v => save({ est_value: v })} />
        </div>
        <div className="two">
          <Field label="Phone" type="tel" value={lead.phone} onSave={v => save({ phone: v })} />
          <Field label="Email" type="email" value={lead.email} onSave={v => save({ email: v })} />
        </div>
        <Field label="Website" type="url" value={lead.website} onSave={v => save({ website: v })} />
        <Field label="Notes" multiline value={lead.note} onSave={v => save({ note: v })} />
        {lead.address && <p className="muted small">{lead.address}</p>}
        <p className="muted small">Found {timeAgo(lead.discovered_at)} via {lead.source === 'manual' ? 'manual entry' : 'Google Places'}{lead.last_contacted_at ? `, last touched ${timeAgo(lead.last_contacted_at)}` : ''}.</p>
      </section>

      <section className="block">
        <h3>Projects</h3>
        {lead.projects?.length > 0 && (
          <ul className="plain">
            {lead.projects.map(p => (
              <li key={p.id}><button className="linklike" onClick={() => openProject(p.id)}>{p.name}</button> <span className="muted">{statusLabel(p.status)}</span></li>
            ))}
          </ul>
        )}
        <button className="btn" onClick={convert} disabled={converting}>
          {lead.stage === 'won' ? 'Start another project' : 'Mark won and start project'}
        </button>
        {lead.est_value && <span className="muted small"> Carries over {money(lead.est_value)}</span>}
      </section>
    </div>
  );
}
