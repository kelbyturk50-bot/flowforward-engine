import { useEffect, useState } from 'react';
import { readCompanyOverride } from '../flags';
import { getDemo } from './getDemo';

const STEP_MS = 280;

const STEPS = [
  { id: 1, label: 'Estimates' },
  { id: 2, label: 'Preview' },
  { id: 3, label: 'Reply' },
  { id: 4, label: 'Recovered' },
];

function formatDollars(amount) {
  return `$${Number(amount).toLocaleString('en-US')}`;
}

function prefersReducedMotion() {
  return !!window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches;
}

function downloadJson(filename, text) {
  const blob = new Blob([text], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

export default function EstimateRecovery({ token }) {
  const [demo, setDemo] = useState(null);
  const [failed, setFailed] = useState(false);
  const [step, setStep] = useState(1);
  const [approved, setApproved] = useState(false);

  useEffect(() => {
    const company = readCompanyOverride();
    let live = true;
    getDemo(token, { company }).then(data => {
      if (live) setDemo(data);
    }).catch(() => {
      if (live) setFailed(true);
    });
    return () => { live = false; };
  }, [token]);

  useEffect(() => {
    const previous = document.title;
    document.title = demo ? `${demo.company} estimate recovery demo` : 'Estimate recovery demo';
    return () => { document.title = previous; };
  }, [demo]);

  if (failed) {
    return (
      <main className="demo">
        <div className="demo-wrap">
          <h1>Page not found</h1>
          <p className="muted">The sample demo did not load.</p>
        </div>
      </main>
    );
  }

  if (!demo) {
    return <main className="demo" aria-busy="true"><p className="demo-loading">Loading sample data…</p></main>;
  }

  return (
    <main className="demo" data-step={step}>
      <div className="demo-wrap">
        <p className="demo-banner" role="note">
          Sample walkthrough for {demo.company}. The jobs and amounts are fictional. Nothing on this page is sent.
        </p>
        <ol className="demo-steps" aria-label="Demo progress">
          {STEPS.map(item => (
            <li key={item.id} aria-current={item.id === step ? 'step' : undefined}>{item.id} {item.label}</li>
          ))}
        </ol>
        {step === 1 && <Landing demo={demo} onSend={() => setStep(2)} />}
        {step === 2 && <Timeline demo={demo} onNext={() => setStep(3)} />}
        {step === 3 && (
          <Reply
            demo={demo}
            approved={approved}
            onApprove={() => setApproved(true)}
            onNext={() => setStep(4)}
          />
        )}
        {step === 4 && (
          <Summary
            demo={demo}
            onRestart={() => { setApproved(false); setStep(1); }}
          />
        )}
      </div>
    </main>
  );
}

function Landing({ demo, onSend }) {
  const furnace = demo.estimates.find(item => item.options);
  return (
    <section aria-labelledby="demo-step-title">
      <p className="demo-kicker">Step 1 of 4</p>
      <h1 id="demo-step-title">{demo.company}: {demo.openCount} open estimates, {formatDollars(demo.openTotal)}</h1>
      <p className="muted demo-lead">
        Three fictional open jobs. Send estimate plays the follow-up as previews on this page. No email, text, or call goes out.
      </p>
      <ul className="demo-estimates">
        {demo.estimates.map(item => (
          <li key={item.id}>
            <div className="demo-est-head">
              <span>{item.name}</span>
              <span className="demo-money">{formatDollars(item.amount)}</span>
            </div>
            {item.options && (
              <ul className="demo-options">
                {item.options.map(option => (
                  <li key={option.tier} className={option.amount === item.amount ? 'is-open' : undefined}>
                    {option.tier} {formatDollars(option.amount)}
                  </li>
                ))}
              </ul>
            )}
          </li>
        ))}
      </ul>
      {furnace && (
        <p className="muted small">
          The furnace job shows Good, Better, and Best. The open amount is the Better option, so the three jobs total {formatDollars(demo.openTotal)}.
        </p>
      )}
      <button type="button" className="demo-btn" onClick={onSend}>Send estimate</button>
    </section>
  );
}

function Timeline({ demo, onNext }) {
  const items = demo.timeline;
  const [count, setCount] = useState(() => (prefersReducedMotion() ? items.length : 1));

  useEffect(() => {
    if (count >= items.length) return undefined;
    const id = window.setTimeout(() => setCount(shown => shown + 1), STEP_MS);
    return () => window.clearTimeout(id);
  }, [count, items.length]);

  const done = count >= items.length;

  return (
    <section aria-labelledby="demo-step-title">
      <p className="demo-kicker">Step 2 of 4 · {demo.company}</p>
      <h1 id="demo-step-title">Preview — nothing is sent</h1>
      <p className="muted demo-lead">
        Email previews branded for {demo.company}. The day 5 card is an owner task, not a message to the homeowner.
      </p>
      <p role="status" className="demo-status">{done ? 'Preview finished. Nothing was sent.' : 'Playing the preview…'}</p>
      <ol className="demo-timeline" aria-label="Email previews">
        {items.slice(0, count).map(item => (
          <li key={item.id} className={`demo-mail demo-mail-${item.kind}`}>
            <div className="demo-mail-top">
              <span className="demo-when">{item.when}</span>
              <span className="demo-kind">{item.kind === 'task' ? 'Owner task' : 'Email preview'}</span>
            </div>
            <h2>{item.title}</h2>
            <p className="demo-from">{item.kind === 'task' ? `Task for ${demo.company}` : `From ${demo.company}`}</p>
            <p className="demo-subject">Subject: {item.subject}</p>
            <p>{item.body}</p>
          </li>
        ))}
      </ol>
      <button type="button" className="demo-btn" disabled={!done} onClick={onNext}>See the homeowner reply</button>
    </section>
  );
}

function Reply({ demo, approved, onApprove, onNext }) {
  const furnace = demo.estimates.find(item => item.id === 'furnace');
  return (
    <section aria-labelledby="demo-step-title">
      <p className="demo-kicker">Step 3 of 4 · {demo.company}</p>
      <h1 id="demo-step-title">{demo.reply.question}</h1>
      <p className="muted demo-lead">A simulated homeowner reply. The answer below is a draft waiting for the owner.</p>
      <blockquote className="demo-quote">{demo.reply.question}</blockquote>
      <article className="demo-draft" aria-label="Drafted answer">
        <h2>Draft awaiting owner approval</h2>
        <p>{demo.reply.draft}</p>
      </article>
      {!approved && <button type="button" className="demo-btn" onClick={onApprove}>Approve reply</button>}
      {approved && (
        <div className="demo-approved-block" role="status">
          <p className="demo-est-name">{furnace?.name}</p>
          <p className="demo-approved">Approved → schedule install</p>
          <p className="muted small">Approving updates this demo only. The reply was not sent.</p>
          <button type="button" className="demo-btn" onClick={onNext}>See the owner summary</button>
        </div>
      )}
    </section>
  );
}

function Summary({ demo, onRestart }) {
  const onExport = () => {
    import('./fixture.js').then(({ serializeDemo }) => {
      downloadJson('estimate-recovery-demo.json', serializeDemo(demo));
    });
  };
  return (
    <section aria-labelledby="demo-step-title">
      <p className="demo-kicker">Step 4 of 4 · {demo.company}</p>
      <h1 id="demo-step-title">Recovered: {formatDollars(demo.recovered)}. You own this workflow.</h1>
      <p className="muted demo-lead">
        That amount is the Better furnace option from the sample list. This page did not contact anyone, and the export stays on this device.
      </p>
      <ul className="demo-estimates">
        {demo.estimates.map(item => (
          <li key={item.id}>
            <div className="demo-est-head">
              <span>{item.name}</span>
              <span className="demo-money">{formatDollars(item.amount)}</span>
            </div>
            {item.id === 'furnace' && <p className="demo-approved">Approved → schedule install</p>}
          </li>
        ))}
      </ul>
      <button type="button" className="demo-btn" onClick={onExport}>Export sample data (JSON)</button>
      <button type="button" className="demo-btn demo-btn-quiet" onClick={onRestart}>Walk through again</button>
    </section>
  );
}
