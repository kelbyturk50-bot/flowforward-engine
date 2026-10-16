import { useEffect, useState } from 'react';
import { api, settings } from '../api';
import { acceptedApiUrl, apiUrlIssue, shouldStoreApiUrl } from '../api-base.js';
import { useAsync, ErrorNote, timeAgo, toast, money2 } from '../ui';

export default function Settings({ authProblem, onSaved, version }) {
  const [baseline, setBaseline] = useState(() => settings.apiUrl);
  const [url, setUrl] = useState(baseline);
  const [key, setKey] = useState(settings.apiKey);
  const [urlError, setUrlError] = useState('');
  const [status, setStatus] = useState(null);
  const [busy, setBusy] = useState(false);

  const connected = !!settings.apiKey;
  const runs = useAsync(() => connected ? api.runs() : Promise.resolve(null), [version, connected]);

  const onAddress = (e) => {
    const next = e.target.value;
    setUrl(next);
    setUrlError(next.trim() ? apiUrlIssue(next) : '');
    setStatus(null);
  };

  const saveAndTest = async (e) => {
    e.preventDefault();
    const trimmed = url.trim();
    const accepted = acceptedApiUrl(trimmed);
    if (trimmed && !accepted) { setUrlError(apiUrlIssue(trimmed)); setStatus(null); return; }
    setUrlError('');
    setBusy(true); setStatus(null);
    if (!trimmed) settings.apiUrl = '';
    else if (shouldStoreApiUrl(trimmed, baseline)) settings.apiUrl = accepted;
    settings.apiKey = key;
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

  const resetAddress = () => {
    settings.apiUrl = '';
    const next = settings.apiUrl;
    setBaseline(next);
    setUrl(next);
    setUrlError('');
    setStatus(null);
    onSaved?.();
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
        <p className="muted">{"Saved on this device only. Use an https address (http is fine for localhost). Reset goes back to this environment's default."}</p>
        <label>API address<input className="input" value={url} onChange={onAddress} placeholder="https://…" aria-invalid={urlError ? 'true' : undefined} aria-describedby={urlError ? 'api-url-error' : undefined} /></label>
        {urlError && <p id="api-url-error" className="error-text" role="alert">{urlError}</p>}
        <label>API key<input className="input" type="password" value={key} onChange={e => setKey(e.target.value)} autoComplete="off" placeholder="Value of CRM_API_KEY" /></label>
        {status && !urlError && <p className={status.ok ? 'ok-note' : 'error-text'} role="status">{status.msg}</p>}
        <div className="form-actions">
          <button type="button" className="btn btn-quiet" onClick={resetAddress} disabled={busy}>Reset</button>
          <button className="btn" disabled={busy || !!urlError}>{busy ? 'Checking…' : 'Save and connect'}</button>
        </div>
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
            <div className="runs-scroll">
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
            </div>
          )}
        </section>
      )}

      {connected && <EmailSettings />}
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
        <p className="muted">{"Standing notes the bot follows on every draft. Write them the way you'd brief a new hire."}</p>
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

function EmailSettings() {
  const st = useAsync(() => api.gmailStatus(), []);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const m = window.location.hash.match(/gmail=(connected|error)/);
    if (!m) return;
    toast(m[1] === 'connected' ? 'Gmail connected.' : 'Gmail did not connect. Try again.');
    history.replaceState(null, '', '#/settings');
  }, []);
  const g = st.data;
  const connect = async () => {
    setBusy(true);
    try { const { url } = await api.gmailConnect(window.location.origin + window.location.pathname); window.location.href = url; }
    catch (e) { toast(e.message); setBusy(false); }
  };
  const disconnect = async () => {
    setBusy(true);
    try { await api.gmailDisconnect(); toast('Gmail disconnected.'); st.reload(); } catch (e) { toast(e.message); } finally { setBusy(false); }
  };
  return (
    <section className="panel">
      <h2>Email sending</h2>
      <p className="muted">{"Proposals go out from your Gmail through Google's API, and replies are picked up from its inbox."}</p>
      <ErrorNote error={st.error} onRetry={st.reload} />
      {g && (
        <>
          <dl className="facts">
            <dt>Status</dt>
            <dd>{g.connected ? <span className="ok-note">Connected as {g.email}</span>
              : !g.configured ? <span className="warn-text">Not set up. Add GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in Railway first.</span>
              : <span className="warn-text">Not connected</span>}</dd>
            {g.connected_at && <><dt>Since</dt><dd>{timeAgo(g.connected_at)}</dd></>}
            {g.error && <><dt>Problem</dt><dd className="warn-text">{g.error}</dd></>}
            {!g.connected && <><dt>Redirect URI</dt><dd><code>{g.redirect_uri}</code> <span className="muted small">(paste this into the Google OAuth client)</span></dd></>}
          </dl>
          <div className="link-row">
            {g.configured && <button className="btn" onClick={connect} disabled={busy}>{g.connected || g.error ? 'Reconnect Gmail' : 'Connect Gmail'}</button>}
            {g.connected && <button className="btn btn-quiet" onClick={disconnect} disabled={busy}>Disconnect</button>}
          </div>
        </>
      )}
    </section>
  );
}
