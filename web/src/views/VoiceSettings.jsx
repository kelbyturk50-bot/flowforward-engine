import { api } from '../api';
import { useAsync, ErrorNote, toast } from '../ui';

// Voice receptionist demo: whether calls are on (Railway env only), today's
// minutes, and what to paste into Retell. The Retell key and agent id never
// come back from the API.

const minutes = (seconds) => `${Math.round((Number(seconds) || 0) / 6) / 10} min`;

async function copy(text, label) {
  try { await navigator.clipboard.writeText(text); toast(`${label} copied.`); }
  catch { toast('Copy failed. Select the text and copy it.'); }
}

export default function VoiceSettings({ version }) {
  const st = useAsync(() => api.voiceStatus(), [version]);
  const v = st.data;
  return (
    <section className="panel" aria-label="Voice receptionist demo">
      <h2>Voice receptionist demo</h2>
      <ErrorNote error={st.error} />
      {v && (
        <>
          <p className={v.configured ? 'ok-note' : 'muted'}>
            {v.configured
              ? `On. Up to ${v.daily_minutes} minutes a day across all links. Each prototype link gets up to ${v.calls_per_link} calls and ${Math.round(v.seconds_per_link / 60)} minutes, and a call ends at ${Math.round(v.max_call_seconds / 60)} minutes.`
              : 'Off. Calls turn on when RETELL_API_KEY, RETELL_AGENT_ID and VOICE_DEMO_DAILY_MINUTES are all set in Railway.'}
          </p>
          <dl className="facts">
            <dt>Today</dt>
            <dd>{v.today.calls} call{v.today.calls === 1 ? '' : 's'} · {minutes(v.today.used_seconds)} used · {minutes(v.today.held_seconds)} held for calls still running or never reported</dd>
            <dt>Webhook</dt>
            <dd className="voice-webhook"><code>{v.webhook_url}</code></dd>
          </dl>
          <details className="voice-setup">
            <summary>Set up in Retell</summary>
            <ol className="small">
              <li>In Retell, create a Single Prompt agent with the voice you like, and paste the prompt below.</li>
              <li>Set the agent&apos;s webhook URL to the webhook above, with the call_ended event.</li>
              <li>In Railway, add RETELL_API_KEY, the agent&apos;s RETELL_AGENT_ID, and VOICE_DEMO_DAILY_MINUTES (for example 30).</li>
            </ol>
            <div className="link-row">
              <button type="button" className="btn btn-quiet" onClick={() => copy(v.prompt, 'Prompt')}>Copy prompt</button>
              <button type="button" className="btn btn-quiet" onClick={() => copy(v.webhook_url, 'Webhook URL')}>Copy webhook URL</button>
            </div>
            <pre className="voice-prompt">{v.prompt}</pre>
          </details>
        </>
      )}
    </section>
  );
}
