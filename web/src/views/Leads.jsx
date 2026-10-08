import { useEffect, useState } from 'react';
import { api } from '../api';
import { useAsync, ErrorNote, FitBadge, StageChip, Stars, STAGES, relDate, isOverdue, Drawer, toast } from '../ui';

const PAGE = 100;
const DEFAULTS = { q: '', stage: 'open', tier: '', industry: '', city: '', sort: 'fit' };

function loadFilters() {
  try { return { ...DEFAULTS, ...JSON.parse(localStorage.getItem('ff.leadFilters') || '{}') }; } catch { return DEFAULTS; }
}

export default function Leads({ version, bump, openLead }) {
  const [f, setF] = useState(loadFilters);
  const [q, setQ] = useState(f.q);
  const [pages, setPages] = useState(1);
  const [adding, setAdding] = useState(false);
  const meta = useAsync(() => api.meta(), []);

  useEffect(() => { try { localStorage.setItem('ff.leadFilters', JSON.stringify(f)); } catch { /* ignore */ } }, [f]);
  useEffect(() => { const t = setTimeout(() => setF(x => x.q === q ? x : { ...x, q }), 250); return () => clearTimeout(t); }, [q]);
  useEffect(() => setPages(1), [f]);

  const { data, error, loading, reload } = useAsync(
    () => api.prospects({ ...f, limit: PAGE * pages }), [f, pages, version]);

  const set = (k) => (e) => setF(x => ({ ...x, [k]: e.target.value }));
  const filtered = Object.entries(f).some(([k, v]) => k !== 'sort' && v !== DEFAULTS[k]);

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1>Leads</h1>
          <p className="muted">{data ? `${data.total.toLocaleString()} match` : ' '}, ranked by fit for your business</p>
        </div>
        <button className="btn" onClick={() => setAdding(true)}>Add lead</button>
      </header>

      <div className="filters" role="search">
        <input className="input grow" type="search" placeholder="Search company, contact or phone" value={q} onChange={e => setQ(e.target.value)} aria-label="Search leads" />
        <select className="input" value={f.stage} onChange={set('stage')} aria-label="Stage">
          <option value="open">All open</option>
          <option value="">All stages</option>
          {STAGES.map(s => <option key={s.id} value={s.id}>{s.label}</option>)}
          <option value="closed">Closed</option>
        </select>
        <select className="input" value={f.tier} onChange={set('tier')} aria-label="Fit tier">
          <option value="">Any fit</option>
          <option value="A">A only</option>
          <option value="A,B">A and B</option>
          <option value="C,D">C and D</option>
        </select>
        <select className="input" value={f.industry} onChange={set('industry')} aria-label="Industry">
          <option value="">All trades</option>
          {meta.data?.industries.map(i => <option key={i}>{i}</option>)}
        </select>
        <select className="input" value={f.city} onChange={set('city')} aria-label="City">
          <option value="">All cities</option>
          {meta.data?.cities.map(c => <option key={c}>{c}</option>)}
        </select>
        <select className="input" value={f.sort} onChange={set('sort')} aria-label="Sort">
          <option value="fit">Best fit</option>
          <option value="next_action">Next follow-up</option>
          <option value="recent">Newest</option>
          <option value="reviews">Most reviews</option>
          <option value="rating">Rating</option>
          <option value="updated">Recently updated</option>
          <option value="company">A–Z</option>
        </select>
        {filtered && <button className="btn btn-quiet" onClick={() => { setQ(''); setF(DEFAULTS); }}>Clear</button>}
      </div>

      <ErrorNote error={error} onRetry={reload} />

      <div className="table-wrap">
        <table className="leads">
          <thead>
            <tr><th>Fit</th><th>Company</th><th>Trade</th><th>City</th><th>Reviews</th><th>Stage</th><th>Next step</th></tr>
          </thead>
          <tbody>
            {data?.prospects.map(l => (
              <tr key={l.id} onClick={() => openLead(l.id)} tabIndex={0} onKeyDown={e => e.key === 'Enter' && openLead(l.id)}>
                <td><FitBadge score={l.fit_score} tier={l.fit_tier} /></td>
                <td className="t-company">
                  <span className="lead-name">{l.company}</span>
                  {l.contact_name && <span className="muted"> {l.contact_name}</span>}
                </td>
                <td className="t-trade">{l.industry}</td>
                <td className="t-city">{l.city}</td>
                <td className="t-rev"><Stars rating={l.rating} reviews={l.review_count} /></td>
                <td className="t-stage"><StageChip stage={l.stage} /></td>
                <td className={`t-next ${isOverdue(l.next_action_at) ? 'overdue' : ''}`}>
                  {l.next_action_at ? `${l.next_action || 'Follow up'}, ${relDate(l.next_action_at)}` : ''}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {data && data.prospects.length === 0 && (
          <p className="empty pad">No leads match these filters. {filtered && 'Clear filters to see everything.'}</p>
        )}
        {loading && <p className="muted pad">Loading leads…</p>}
        {data && data.prospects.length < data.total && !loading && (
          <button className="btn btn-quiet more" onClick={() => setPages(p => p + 1)}>
            Show {Math.min(PAGE, data.total - data.prospects.length)} more
          </button>
        )}
      </div>

      <AddLead open={adding} onClose={() => setAdding(false)} industries={meta.data?.industries || []}
        onCreated={(lead) => { setAdding(false); bump(); openLead(lead.id); toast(`Added ${lead.company}.`); }} />
    </div>
  );
}

function AddLead({ open, onClose, onCreated, industries }) {
  const empty = { company: '', industry: '', contact_name: '', phone: '', email: '', website: '', city: '', note: '' };
  const [b, setB] = useState(empty);
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (open) { setB(empty); setErr(null); } }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  const set = (k) => (e) => setB(x => ({ ...x, [k]: e.target.value }));
  const submit = async (e) => {
    e.preventDefault(); setBusy(true); setErr(null);
    try { onCreated(await api.createLead(b)); } catch (e2) { setErr(e2); } finally { setBusy(false); }
  };

  return (
    <Drawer open={open} onClose={onClose} label="Add lead">
      <form className="drawer-body form" onSubmit={submit}>
        <h2>Add a lead</h2>
        <p className="muted">For referrals and anyone discovery didn't find. It gets a fit score as soon as you save.</p>
        <label>Company<input className="input" required value={b.company} onChange={set('company')} /></label>
        <label>Trade
          <input className="input" required list="trade-list" value={b.industry} onChange={set('industry')} placeholder="HVAC, Plumbing…" />
          <datalist id="trade-list">{industries.map(i => <option key={i} value={i} />)}</datalist>
        </label>
        <div className="two">
          <label>Contact<input className="input" value={b.contact_name} onChange={set('contact_name')} /></label>
          <label>City<input className="input" value={b.city} onChange={set('city')} /></label>
        </div>
        <div className="two">
          <label>Phone<input className="input" type="tel" value={b.phone} onChange={set('phone')} /></label>
          <label>Email<input className="input" type="email" value={b.email} onChange={set('email')} /></label>
        </div>
        <label>Website<input className="input" type="url" placeholder="https://" value={b.website} onChange={set('website')} /></label>
        <label>Note<textarea className="input" rows={3} value={b.note} onChange={set('note')} /></label>
        <ErrorNote error={err} />
        <div className="form-actions"><button className="btn" disabled={busy}>{busy ? 'Saving…' : 'Save lead'}</button></div>
      </form>
    </Drawer>
  );
}
