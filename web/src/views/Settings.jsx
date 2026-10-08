import { useState } from 'react';
import { api, settings } from '../api';
import { useAsync, ErrorNote, timeAgo, toast } from '../ui';

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
    </div>
  );
}
