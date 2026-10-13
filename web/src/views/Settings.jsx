import { useEffect, useState } from 'react';
import { api, settings } from '../api';
import { useAsync, ErrorNote, timeAgo, toast, money2 } from '../ui';

export default function Settings({ authProblem, onSaved, version }) {
  const [url, setUrl] = useState(settings.apiUrl);
  const [key, setKey] = useState(settings.apiKey);
  const [status, setStatus] = useState(null);
  const [busy, setBusy] = useState(false);

  const connected = !!settings.apiKey;
  const runs = useAsync(() => connected ? api.runs() : Promise.resolve(null), [version, connected]);

  const saveAndTest = async (e) => {
    e.preventDefault(); setBusy(true); setStatus(null);
    settings.apiUrl = url; settings.apiKey = key;
    try {
      await api.health();
      await api.stats();
      setStatus({ ok: true, msg: 'Connected. Your leads are loading.' });
      onSaved();
      setTimeout(() => { window.location.hash = '#/today'; }, 600);
    } catch (err) {
      setStatus({ ok: false, msg: err.status === 401 ? 'The API rejected that key. Check CRM_API_KEY in Railway Variables.' : err.message });
    } finally { setBusy(false); }
  };

  const trigger = async () => {
    try { await api.triggerRun(); toast('Discovery started. New leads appear in a few minutes.'); setTimeout(runs.reload, 4000); }
    catch (e) { toast(e.message); }
  };
  const rescore = async () => {
    try { const r = await api.rescore(); toast(`Re-ranked ${r.rescored} leads.`); onSaved(); }
    catch (e) { toast(e.message); }
  };

  return (
    <div className="page page-narrow">
      <header className="page-head"><div><h1>Settings</h1></div></header>

      {authProblem && <div className="error-note" role="alert"><p>The API needs a valid key. Enter the value of CRM_API_KEY from Railway.</p></div>}

      <form className="panel form" onSubmit={saveAndTest}>
        <h2>Connection</h2>
        <p className="muted">Saved on this device only. Enter it once on each phone or computer you use.</p>
        <label>API address<input className="input" value={url} onChange={e => setUrl(e.target.value)} placeholder="https://…up.railway.app" required /></label>
        <label>API key<input className="input" type="password" value={key} onChange={e => setKey(e.target.value)} autoComplete="off" placeholder="Value of CRM_API_KEY" /></label>
        {status && <p className={status.ok ? 'ok-note' : 'error-text'} role="status">{status.msg}</p>}
        <div className="form-actions"><button className="btn" disabled={busy}>{busy ? 'Checking…' : 'Save and connect'}</button></div>
      </form>

      {connected && (
        <section className="panel">
          <h2>Lead discovery</h2>
          <p className="muted">Runs every morning at 6. Kick off a run now, or re-rank every lead after changing the scoring settings.</p>
          <div className="link-row">
            <button className="btn" onClick={trigger}>Run discovery now</button>
            <button className="btn btn-quiet" onClick={rescore}>Re-rank all leads</button>
          </div>
          <ErrorNote error={runs.error} />
          {runs.data?.length > 0 && (
            <table className="runs">
              <thead><tr><th>Started</th><th>Status</th><th>Queries</th><th>Found</th><th>New</th><th>Errors</th></tr></thead>
              <tbody>
                {runs.data.map(r => (
                  <tr key={r.id}>
                    <td>{timeAgo(r.started_at)}</td>
                    <td className={`run-${r.status}`}>{r.status.replace(/_/g, ' ')}</td>
                    <td>{r.queries_run}</td><td>{r.found}</td><td>{r.new_added}</td><td>{r.errors}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      )}

      {connected && <ProposalSettings version={version} />}
    </div>
  );
}

function ProposalSettings({ version }) {
  const summary = useAsync(() => api.proposalSummary(), [version]);
  const runs = useAsync(() => api.proposalRuns(), [version]);
  const st = useAsync(() => api.proposalSettings(), []);
  const [notes, setNotes] = useState('');
  const [saving, setSaving] = useState(false);
  useEffect(() => { if (st.data) setNotes(st.data.style_notes || ''); }, [st.data]);
  const s = summary.data; const c = s?.config;

  const saveNotes = async (e) => {
    e.preventDefault(); setSaving(true);
    try { await api.saveProposalSettings({ style_notes: notes }); toast('Saved. New drafts will follow these notes.'); }
    catch (err) { toast(err.message); } finally { setSaving(false); }
  };
  const inbox = async () => {
    try { const r = await api.checkInbox(); toast(`Checked ${r.inbox?.checked || 0} messages, ${r.inbox?.matched || 0} matched. ${r.followups?.sent || 0} follow-ups sent.`); summary.reload(); }
    catch (err) { toast(err.message); }
  };

  return (
    <>
      <form className="panel form" onSubmit={saveNotes}>
        <h2>Proposal voice</h2>
        <p className="muted">Standing notes the bot follows on every draft. Write them the way you'd brief a new hire.</p>
        <textarea className="input" rows={7} value={notes} onChange={e => setNotes(e.target.value)}
          placeholder={'e.g.\n- Never open with "I hope this finds you well."\n- Mention I grew up working in the trades.\n- Roofers: lead with storm-season lead follow-up.\n- Keep first emails under 90 words.'} />
        <div className="form-actions"><button className="btn" disabled={saving || !st.data}>{saving ? 'Saving…' : 'Save notes'}</button></div>
      </form>

      <section className="panel">
        <h2>Proposal bot</h2>
        <ErrorNote error={summary.error} />
        {s?.setup?.length > 0 && <div className="setup-note"><strong>Finish setup in Railway</strong><ul>{s.setup.map(x => <li key={x}>{x}</li>)}</ul></div>}
        {c && (
          <dl className="facts">
            <dt>Drafting</dt><dd>{c.auto_draft
              ? <>Automatic: up to {c.nightly_count} new {c.tiers.join('/')}-tier leads {cronText(c.cron)} (Denver time).</>
              : <>On demand only, from the Proposals page or a lead.</>} {s.eligible_leads} {c.tiers.join('/')}-tier leads ready.</dd>
            <dt>Skips</dt><dd>{c.excluded.join(', ') || 'nothing'}</dd>
            <dt>Research</dt><dd>Website{c.reviews ? ', Google reviews' : ''}{c.web_search ? ', web search (owner, socials)' : ''}. Model: {c.model}.</dd>
            <dt>Sends from</dt><dd>{c.sender.name} &lt;{c.sender.email}&gt; · booking link {c.sender.calendly}</dd>
            <dt>Footer address</dt><dd>{c.sender.address || <span className="warn-text">Not set (SENDER_ADDRESS)</span>}</dd>
            <dt>Follow-ups</dt><dd>Day {c.followup_days.join(' and day ')}, weekdays 8am–5pm, stopped by any reply, booking, bounce or opt-out.</dd>
            <dt>Today</dt><dd>{s.sent_today} of {s.daily_limit} emails sent · {money2(s.spend_this_month)} spent on drafts this month</dd>
          </dl>
        )}
        <div className="link-row"><button className="btn btn-quiet" onClick={inbox}>Check inbox for replies now</button></div>
        {runs.data?.length > 0 && (
          <table className="runs">
            <thead><tr><th>Started</th><th>Status</th><th>Trigger</th><th>Drafted</th><th>Errors</th><th>Cost</th></tr></thead>
            <tbody>{runs.data.map(r => (
              <tr key={r.id} title={(r.log || []).filter(x => x.error).map(x => `${x.company}: ${x.error}`).join('\n')}>
                <td>{timeAgo(r.started_at)}</td><td className={`run-${r.status}`}>{r.status.replace(/_/g, ' ')}</td>
                <td>{r.trigger}</td><td>{r.drafted}</td><td>{r.errors}</td><td>{money2(r.cost_usd)}</td>
              </tr>))}</tbody>
          </table>
        )}
      </section>
    </>
  );
}

function cronText(expr) {
  const m = /^(\d+) (\d+) \* \* \*$/.exec(expr || '');
  if (!m) return expr;
  const h = Number(m[2]); const min = String(m[1]).padStart(2, '0');
  return `nightly at ${h % 12 || 12}${min !== '00' ? ':' + min : ''}${h < 12 ? 'am' : 'pm'}`;
}
