import { useEffect, useState } from 'react';
import { api } from '../api';
import { TryLiveDemoLink } from '../demo/DemoLinks';
import { Drawer, FitBadge, ProposalChip, ErrorNote, emailChecks, money2, relDate, timeAgo, toast, Stars } from '../ui';
import { useJobs, elapsed } from '../jobs';
import PrototypeCard from './PrototypeCard';

export default function ProposalDrawer({ id, onClose, bump, openLead, openProposal }) {
  const [p, setP] = useState(null);
  const [error, setError] = useState(null);

  const load = async (pid = id) => {
    try {
      setError(null);
      const data = await api.proposal(pid);
      setP(data);
      if (data.status === 'draft' && !data.reviewed_at) api.markProposalSeen(pid).then(() => bump()).catch(() => {});
    } catch (e) { setError(e); }
  };
  useEffect(() => { setP(null); if (id) load(id); }, [id]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <Drawer open={!!id} onClose={onClose} label={p?.company ? `Proposal for ${p.company}` : 'Proposal'} wide>
      {error && <div className="drawer-body"><ErrorNote error={error} onRetry={() => load()} /></div>}
      {!p && !error && <div className="drawer-body"><p className="muted">Loading…</p></div>}
      {p && p.id === id && <Body key={`${p.id}-${p.updated_at}`} p={p} reload={load} bump={bump} openLead={openLead} openProposal={openProposal} onClose={onClose} />}
    </Drawer>
  );
}

function Body({ p, reload, bump, openLead, openProposal, onClose }) {
  const editable = p.status === 'draft';
  const missingRecipient = !String(p.to_email || '').trim();
  const [busy, setBusy] = useState('');
  const [confirming, setConfirming] = useState(false);
  const [confirmingManual, setConfirmingManual] = useState(false);
  const [manualNote, setManualNote] = useState('');
  const [regen, setRegen] = useState(false);
  const { activeFor } = useJobs();
  const rewriting = !!activeFor(p.prospect_id);
  const a = p.analysis || {};

  const act = async (label, fn, msg, after) => {
    setBusy(label);
    try {
      const r = await fn();
      if (msg) toast(typeof msg === 'function' ? msg(r) : msg);
      bump();
      if (after) await after(r); else await reload(p.id);
    } catch (e) { toast(e.message); } finally { setBusy(''); }
  };
  const save = (patch, msg) => act('save', () => api.updateProposal(p.id, patch), msg);

  return (
    <div className="drawer-body">
      <header className="lead-head">
        <FitBadge score={p.fit_score} tier={p.fit_tier} size="lg" />
        <div>
          <h2>{p.company}</h2>
          <p className="muted">{p.industry}{p.city ? `, ${p.city}` : ''} <Stars rating={p.rating} reviews={p.review_count} /></p>
          <div className="head-chips">
            <ProposalChip status={p.status} verdict={a.fit_verdict} />
            {p.versions?.length > 1 ? (
              <select className="mini-select" value={p.id} onChange={e => openProposal(Number(e.target.value))} aria-label="Version">
                {p.versions.map(v => <option key={v.id} value={v.id}>v{v.version} · {v.status === 'superseded' ? 'older' : v.status}{v.instructions ? ' · w/ notes' : ''}</option>)}
              </select>
            ) : <span className="muted small">v{p.version}</span>}
            <span className="muted small">{money2(p.cost_usd)} · drafted {timeAgo(p.created_at)}</span>
            <button className="linklike small" onClick={() => { onClose(); openLead(p.prospect_id); }}>Open lead</button>
          </div>
        </div>
      </header>

      {p.error && <div className="error-note"><p>{p.error}</p></div>}
      {p.stop_reason && p.status !== 'draft' && <p className="muted">{p.stop_reason}</p>}

      {/* ── Actions ── */}
      <div className="action-bar">
        {editable && <>
          <button className="btn" disabled={!!busy || !p.to_email} onClick={() => setConfirming(true)}>Approve and send</button>
          <button
            className="btn btn-quiet"
            disabled={!!busy || missingRecipient}
            title={missingRecipient ? 'Add a recipient email first' : undefined}
            aria-describedby={missingRecipient ? 'mark-sent-needs-email' : undefined}
            onClick={() => setConfirmingManual(m => !m)}
          >Mark as manually sent…</button>
          {missingRecipient && <span id="mark-sent-needs-email" className="muted small" role="status">Add a recipient email first</span>}
          <button className="btn btn-quiet" disabled={!!busy || rewriting} onClick={() => setRegen(r => !r)}>{rewriting ? 'Rewriting…' : 'Rewrite…'}</button>
          <a className="btn btn-quiet" href={`${p.onepager_url}?preview=1`} target="_blank" rel="noreferrer">Preview one-pager</a>
          <TryLiveDemoLink className="btn btn-quiet" />
          <span className="spacer" />
          <button className="btn btn-quiet" disabled={!!busy} onClick={() => act('discard', () => api.discardProposal(p.id), 'Draft discarded.')}>Discard</button>
          <button className="btn btn-danger" disabled={!!busy} onClick={() => act('nf', () => api.discardProposal(p.id, { disqualify: true, reason: 'Not a fit (Kelby)' }), 'Marked not a fit.')}>Not a fit</button>
        </>}
        {p.status === 'sent' && <>
          <a className="btn btn-quiet" href={p.onepager_url} target="_blank" rel="noreferrer">Open one-pager</a>
          <TryLiveDemoLink className="btn btn-quiet" />
          <button className="btn btn-quiet" disabled={!!busy} onClick={() => act('replied', () => api.repliedProposal(p.id, 'They got in touch another way'), 'Marked replied. Follow-ups stopped.')}>They replied another way</button>
          <button className="btn btn-danger" disabled={!!busy} onClick={() => act('stop', () => api.stopProposal(p.id), 'Follow-ups stopped.')}>Stop follow-ups</button>
        </>}
        {['discarded', 'superseded'].includes(p.status) && (
          <button className="btn" disabled={!!busy} onClick={() => act('restore', () => api.restoreProposal(p.id), 'Back in your review queue.')}>Restore to review</button>
        )}
        {!editable && ['replied', 'finished', 'stopped', 'bounced', 'opted_out'].includes(p.status) && (
          <button className="btn btn-quiet" disabled={!!busy || rewriting} onClick={() => setRegen(r => !r)}>{rewriting ? 'Rewriting…' : 'Write a new version…'}</button>
        )}
      </div>

      {confirming && (
        <div className="confirm" role="alertdialog" aria-label="Confirm send">
          <p><strong>Send to {p.to_name ? `${p.to_name} <${p.to_email}>` : p.to_email}?</strong></p>
          <p className="muted">“{p.subject}” goes out now from your Gmail. Follow-ups are scheduled for day 3 and day 10 and stop automatically if they reply, book, bounce or opt out.</p>
          <div className="link-row">
            <button className="btn" disabled={!!busy} onClick={() => act('send', () => api.sendProposal(p.id), `Sent to ${p.to_email}.`, async () => { setConfirming(false); await reload(p.id); })}>
              {busy === 'send' ? 'Sending…' : 'Send it'}
            </button>
            <button className="btn btn-quiet" onClick={() => setConfirming(false)}>Cancel</button>
          </div>
        </div>
      )}
      {confirmingManual && (
        <div className="confirm" role="alertdialog" aria-label="Confirm manual send">
          <p><strong>Record this as manually sent?</strong></p>
          <p className="muted">{"Use this when you reached out via Facebook, a contact form, direct email, or in person. The proposal moves to \"Out\" and follow-up reminders are set for day 3 and day 10."}</p>
          <label>How did you reach out? (optional)
            <input className="input" value={manualNote} onChange={e => setManualNote(e.target.value)}
              placeholder="e.g. Sent via Facebook message, emailed through contact form…" />
          </label>
          <div className="link-row">
            <button className="btn" disabled={!!busy || missingRecipient} title={missingRecipient ? 'Add a recipient email first' : undefined} onClick={() =>
              act('mark-sent', () => api.markSentProposal(p.id, manualNote || undefined),
                'Marked as sent. Follow-ups scheduled.',
                async () => { setConfirmingManual(false); setManualNote(''); await reload(p.id); })}>
              {busy === 'mark-sent' ? 'Saving…' : 'Yes, mark as sent'}
            </button>
            <button className="btn btn-quiet" onClick={() => { setConfirmingManual(false); setManualNote(''); }}>Cancel</button>
          </div>
        </div>
      )}
      <JobBanner p={p} openProposal={openProposal} />
      {regen && <Regenerate p={p} done={() => setRegen(false)} />}
      {busy && !['save', 'send', 'mark-sent'].includes(busy) && <p className="muted" role="status">Working…</p>}

      {p.status === 'sent' || p.sent_at ? <Sequence p={p} /> : null}

      {!['discarded', 'superseded'].includes(p.status) && (
        <PrototypeCard prospectId={p.prospect_id} prototype={p.prototype} onChange={bump} />
      )}

      <div className="review-grid">
        {/* ── Left: what the bot found ── */}
        <section className="review-col">
          <h3 className="col-title">What the bot found</h3>
          {a.fit_verdict && a.fit_verdict !== 'good' && (
            <p className={`verdict verdict-${a.fit_verdict}`}><strong>{a.fit_verdict === 'disqualify' ? 'Not a fit' : 'Weak fit'}:</strong> {a.fit_reason}</p>
          )}
          {a.snapshot && <p>{a.snapshot}</p>}
          {a.confidence ? <p className="muted small">Personalization confidence: {a.confidence}/5</p> : null}

          <dl className="facts">
            <dt>Owner / contact</dt>
            <dd>{a.owner_name ? <>{a.owner_name}{a.owner_role ? `, ${a.owner_role}` : ''} <span className="muted small">({a.owner_source || 'source not given'})</span></> : <span className="muted">Not found</span>}</dd>
            <dt>Best email</dt>
            <dd>{a.best_email ? <>{a.best_email} <span className="muted small">({a.email_source || 'source not given'})</span></> : <span className="muted">None found. Add one, or use their contact form.</span>}</dd>
            {a.other_contacts?.length > 0 && <><dt>Other ways in</dt><dd>{a.other_contacts.join(' · ')}</dd></>}
            {a.tools_in_use?.length > 0 && <><dt>Tools they use</dt><dd>{a.tools_in_use.join(', ')}</dd></>}
          </dl>

          {a.pain_signals?.length > 0 && <>
            <h4>Pain signals</h4>
            <ul className="signals">{a.pain_signals.map((s, i) => (
              <li key={i}><strong>{s.signal}</strong><span>{s.evidence}{s.source ? <em> — {s.source}</em> : null}</span></li>
            ))}</ul>
          </>}
          {a.strengths?.length > 0 && <><h4>Strengths</h4><ul className="bullets">{a.strengths.map((x, i) => <li key={i}>{x}</li>)}</ul></>}
          {a.talking_points?.length > 0 && <><h4>For the first call</h4><ul className="bullets">{a.talking_points.map((x, i) => <li key={i}>{x}</li>)}</ul></>}
          {a.verify?.length > 0 && <><h4>Double-check before sending</h4><ul className="bullets warn-list">{a.verify.map((x, i) => <li key={i}>{x}</li>)}</ul></>}
          <RawFindings r={p.research} />
        </section>

        {/* ── Right: the copy ── */}
        <section className="review-col">
          <h3 className="col-title">Email sequence</h3>
          <div className="two">
            <Field label="To (email)" type="email" value={p.to_email} disabled={!editable} onSave={v => save({ to_email: v })} />
            <Field label="First name in greeting" value={p.to_name} disabled={!editable} onSave={v => save({ to_name: v })} />
          </div>
          <Field label="Subject" value={p.subject} disabled={!editable} onSave={v => save({ subject: v }, 'Saved.')} />
          <EmailField label="First email" hint="Sends when you approve" value={p.body} subject={p.subject} first disabled={!editable} onSave={v => save({ body: v }, 'Saved.')} addon={editable ? <PrototypeAddon p={p} which="first" /> : null} />
          <EmailField label="Follow-up 1" hint={p.followup1_sent_at ? `Sent ${timeAgo(p.followup1_sent_at)}` : 'Day 3, as a reply in the same thread'} value={p.followup1} disabled={!editable} onSave={v => save({ followup1: v }, 'Saved.')} addon={!p.followup1_sent_at && ['draft', 'sent'].includes(p.status) ? <PrototypeAddon p={p} which="followup1" /> : null} />
          <EmailField label="Follow-up 2 (last)" hint={p.followup2_sent_at ? `Sent ${timeAgo(p.followup2_sent_at)}` : 'Day 10'} value={p.followup2} disabled={!editable} onSave={v => save({ followup2: v }, 'Saved.')} />
          <details className="preview">
            <summary>{"Exactly what they'll receive"}</summary>
            <pre>{p.preview?.first}</pre>
          </details>

          <h3 className="col-title">One-pager</h3>
          <ThinOnepager p={p} reload={reload} bump={bump} />
          <OnePagerEditor p={p} editable={editable} save={save} />

          <Feedback p={p} save={save} />
        </section>
      </div>
    </div>
  );
}

function Field({ label, value, onSave, type = 'text', disabled, rows }) {
  const [v, setV] = useState(value ?? '');
  useEffect(() => setV(value ?? ''), [value]);
  const commit = () => { if ((value ?? '') !== v) onSave(v); };
  const props = { className: 'input', value: v, disabled, onChange: e => setV(e.target.value), onBlur: commit };
  return (
    <label>{label}
      {rows ? <textarea rows={rows} {...props} /> : <input type={type} {...props} onKeyDown={e => e.key === 'Enter' && e.currentTarget.blur()} />}
    </label>
  );
}

// The prototype line the server adds when the email sends (send.js
// withPrototype). Shown under the editor so it's clear it will be there.
function prototypeLine(p, which) {
  const proto = p.prototype;
  const body = which === 'first' ? p.body : p.followup1;
  if (!proto || !proto.url || proto.expired || /\{\{\s*PROTOTYPE_URL\s*\}\}/.test(body || '')) return null;
  const shop = String(p.company || '').replace(/^test:\s*/i, '').trim() || 'your shop';
  return which === 'first'
    ? `I also built a quick clickable prototype of what this could look like for ${shop}, on sample data:\n${proto.url}`
    : `If it's easier to see than read about, here's the clickable prototype I put together for ${shop}:\n${proto.url}`;
}

function PrototypeAddon({ p, which }) {
  // Server-computed (send.js addedLines) when available; older API: prototype only.
  const added = Array.isArray(p.additions?.[which])
    ? p.additions[which]
    : (prototypeLine(p, which) ? [{ where: which === 'first' ? 'after the one-pager link' : 'before your sign-off', text: prototypeLine(p, which) }] : []);
  const notes = [];
  if (which === 'first' && p.prototype && !p.prototype.url && p.prototype.link_problem) {
    notes.push(`No prototype link will be added: ${p.prototype.link_problem === 'key_missing' ? 'the CRM API key on Railway is shorter than 32 characters.' : 'the CRM API key changed. Make a new link on the Prototype card.'}`);
  }
  if (which === 'first' && p.prototype?.expired) notes.push('No prototype link will be added: it expired. Make a new link on the Prototype card.');
  if (!added.length && !notes.length) return null;
  return (
    <>
      {added.map((a, i) => (
        <div className="proto-addon" key={i}>
          <span className="muted small">Added {a.where} when it sends:</span>
          <pre>{a.text}</pre>
        </div>
      ))}
      {notes.map(n => <p key={n} className="proto-addon muted small">{n}</p>)}
    </>
  );
}

function EmailField({ label, hint, value, subject, first, disabled, onSave, addon }) {
  const [v, setV] = useState(value ?? '');
  useEffect(() => setV(value ?? ''), [value]);
  const { words, issues } = emailChecks({ subject: first ? subject : '', body: v }, { firstEmail: first });
  return (
    <label className="email-field">
      <span className="field-head"><span>{label}</span><span className="muted small">{hint} · {words} words</span></span>
      <textarea className="input mono-ish" rows={first ? 15 : 7} value={v} disabled={disabled}
        onChange={e => setV(e.target.value)} onBlur={() => (value ?? '') !== v && onSave(v)} />
      {!disabled && issues.length > 0 && <ul className="checks">{issues.map(x => <li key={x}>{x}</li>)}</ul>}
      {addon}
    </label>
  );
}

// A one-pager with no observations or opportunities came back malformed
// from the model. Offer to rewrite just the one-pager (same link, so a sent
// email's link shows the full page).
function ThinOnepager({ p, reload, bump }) {
  const [busy, setBusy] = useState(false);
  const o = p.onepager || {};
  const thin = !(o.observations || []).length && !(o.opportunities || []).length;
  if (!thin || ['discarded', 'superseded'].includes(p.status)) return null;
  const go = async () => {
    setBusy(true);
    try { await api.rebuildOnepager(p.id); toast('One-pager rebuilt. Same link.'); bump(); await reload(p.id); }
    catch (e) { toast(e.message); } finally { setBusy(false); }
  };
  return (
    <div className="error-note" role="status">
      <p>This one-pager came out empty (no &ldquo;What I noticed&rdquo; or &ldquo;Where I think I can help&rdquo;). Rebuild it with the same research. The link stays the same{p.sent_at ? ', so the email you already sent will show the full page' : ''}.</p>
      <button className="btn" disabled={busy} onClick={go}>{busy ? 'Rebuilding… (about a minute)' : 'Rebuild one-pager'}</button>
    </div>
  );
}

function OnePagerEditor({ p, editable, save }) {
  const o = p.onepager || {};
  const put = (patch) => save({ onepager: { ...o, ...patch } }, 'One-pager saved.');
  const putItem = (key, i, field, val) => {
    const items = [...(o[key] || [])]; items[i] = { ...items[i], [field]: val }; put({ [key]: items });
  };
  return (
    <div className="op-edit">
      <Field label="Headline" value={o.headline} disabled={!editable} onSave={v => put({ headline: v })} />
      <Field label="Intro" rows={4} value={o.intro} disabled={!editable} onSave={v => put({ intro: v })} />
      <fieldset><legend>What I noticed</legend>
        {(o.observations || []).map((x, i) => (
          <div key={i} className="op-item">
            <Field label="Title" value={x.title} disabled={!editable} onSave={v => putItem('observations', i, 'title', v)} />
            <Field label="Detail" rows={2} value={x.detail} disabled={!editable} onSave={v => putItem('observations', i, 'detail', v)} />
          </div>
        ))}
      </fieldset>
      <fieldset><legend>Where I can help</legend>
        {(o.opportunities || []).map((x, i) => (
          <div key={i} className="op-item">
            <Field label={`${i + 1}. Title`} value={x.title} disabled={!editable} onSave={v => putItem('opportunities', i, 'title', v)} />
            <Field label="What's happening" rows={2} value={x.problem} disabled={!editable} onSave={v => putItem('opportunities', i, 'problem', v)} />
            <Field label="What I'd build" rows={2} value={x.solution} disabled={!editable} onSave={v => putItem('opportunities', i, 'solution', v)} />
            <div className="two">
              <Field label="Rough impact" rows={2} value={x.impact} disabled={!editable} onSave={v => putItem('opportunities', i, 'impact', v)} />
              <Field label="Assumptions" rows={2} value={x.assumptions} disabled={!editable} onSave={v => putItem('opportunities', i, 'assumptions', v)} />
            </div>
          </div>
        ))}
      </fieldset>
      <Field label="Closing" rows={2} value={o.closing} disabled={!editable} onSave={v => put({ closing: v })} />
    </div>
  );
}

function JobBanner({ p, openProposal }) {
  const { activeFor, finishedFor, dismiss } = useJobs();
  const [, tick] = useState(0);
  const job = activeFor(p.prospect_id);
  const done = !job && finishedFor(p.prospect_id);
  useEffect(() => { if (!job) return; const t = setInterval(() => tick(n => n + 1), 1000); return () => clearInterval(t); }, [job]);
  if (job) {
    return (
      <div className="job-banner job-running" role="status" aria-live="polite">
        <span className="spinner" aria-hidden="true" />
        <div>
          <strong>{job.kind === 'rewrite' ? `Writing a new version${job.source_version ? ` from v${job.source_version}` : ''}…` : 'Drafting…'}</strong>
          <span className="muted small"> {job.status === 'queued' ? 'Waiting its turn' : `Running ${elapsed(job.started_at)}`}. Usually about a minute{job.fresh_research ? ' or two with fresh research' : ''}.</span>
          <p className="small">You can close this and keep working. It{"'"}ll show up in <strong>To review</strong> marked <strong>New</strong>.</p>
        </div>
      </div>
    );
  }
  if (done && done.status === 'done' && done.result_proposal_id && done.result_proposal_id !== p.id) {
    return (
      <div className="job-banner job-done" role="status">
        <div><strong>Version {done.result_version} is ready.</strong> <span className="muted small">Finished {timeAgo(done.finished_at)}.</span></div>
        <div className="link-row"><button className="btn btn-sm" onClick={() => openProposal(done.result_proposal_id)}>Open v{done.result_version}</button>
          <button className="btn btn-quiet btn-sm" onClick={() => dismiss(done.id)}>Dismiss</button></div>
      </div>
    );
  }
  if (done && done.status === 'failed') {
    return (
      <div className="job-banner job-failed" role="alert">
        <div><strong>{"The rewrite didn't finish."}</strong> <span className="small">{done.error}</span></div>
        <button className="btn btn-quiet btn-sm" onClick={() => dismiss(done.id)}>Dismiss</button>
      </div>
    );
  }
  return null;
}

function Regenerate({ p, done }) {
  const { refresh, activeFor } = useJobs();
  const [notes, setNotes] = useState('');
  const [fresh, setFresh] = useState(false);
  const [starting, setStarting] = useState(false);
  const running = !!activeFor(p.prospect_id);
  const start = async () => {
    setStarting(true);
    try {
      const r = await api.regenerateProposal(p.id, { instructions: notes || undefined, fresh_research: fresh });
      toast(r.existing ? 'Already rewriting this one. Hang tight.' : "Rewriting in the background. You can close this and keep working.");
      await refresh();
      done();
    } catch (e) { toast(e.message); } finally { setStarting(false); }
  };
  return (
    <div className="confirm">
      <label>What should change? (optional)
        <textarea className="input" rows={3} value={notes} onChange={e => setNotes(e.target.value)}
          placeholder="e.g. Lead with their maintenance plan, not after-hours calls. Shorter. Don't mention reviews." />
      </label>
      <label className="check"><input type="checkbox" checked={fresh} onChange={e => setFresh(e.target.checked)} /> Re-research their website and reviews too</label>
      <div className="link-row">
        <button className="btn" disabled={starting || running} onClick={start}>
          {starting ? 'Starting…' : running ? 'Already rewriting…' : 'Write new version'}
        </button>
        <button className="btn btn-quiet" onClick={done}>Cancel</button>
      </div>
      <p className="muted small">Your current version stays in the version list. Your notes here also teach the bot for this lead only; use Settings → Proposal voice for standing rules.</p>
    </div>
  );
}

function Sequence({ p }) {
  const step = (label, due, sentAt) => (
    <li className={sentAt ? 'done' : ''}><span>{label}</span>
      <span className="muted">{sentAt ? `sent ${timeAgo(sentAt)}` : due ? (p.status === 'sent' ? `due ${relDate(due)}` : 'cancelled') : '—'}</span></li>
  );
  return (
    <section className="sequence">
      <ol>
        {step('First email', null, p.sent_at)}
        {p.followup1 ? step('Follow-up 1', p.followup1_due_at, p.followup1_sent_at) : null}
        {p.followup2 ? step('Follow-up 2', p.followup2_due_at, p.followup2_sent_at) : null}
        {p.replied_at && <li className="done hot"><span>Replied</span><span className="muted">{timeAgo(p.replied_at)}</span></li>}
      </ol>
      <p className="muted small">One-pager opened {p.views || 0}×{p.last_viewed_at ? `, last ${timeAgo(p.last_viewed_at)}` : ''}. Email scanners can trigger a view, so treat this as a hint.</p>
    </section>
  );
}

function Feedback({ p, save }) {
  const [note, setNote] = useState(p.feedback_note || '');
  return (
    <section className="feedback">
      <h3 className="col-title">How was this draft?</h3>
      <div className="link-row">
        <button className={`btn btn-sm ${p.feedback_rating === 1 ? '' : 'btn-quiet'}`} aria-pressed={p.feedback_rating === 1}
          onClick={() => save({ feedback_rating: p.feedback_rating === 1 ? null : 1 }, 'Thanks. The bot will lean this way.')}>👍 Good</button>
        <button className={`btn btn-sm ${p.feedback_rating === -1 ? 'btn-danger' : 'btn-quiet'}`} aria-pressed={p.feedback_rating === -1}
          onClick={() => save({ feedback_rating: p.feedback_rating === -1 ? null : -1 }, 'Noted.')}>👎 Off</button>
      </div>
      <label>What would you change? The bot reads your recent notes on every new draft.
        <textarea className="input" rows={2} value={note} onChange={e => setNote(e.target.value)}
          onBlur={() => note !== (p.feedback_note || '') && save({ feedback_note: note }, 'Feedback saved.')}
          placeholder="e.g. Too salesy in the opener. The ROI number felt made up." />
      </label>
    </section>
  );
}

function RawFindings({ r }) {
  if (!r) return null;
  const site = r.site || {}; const g = r.google || {};
  return (
    <details className="raw">
      <summary>Raw research</summary>
      <dl className="facts">
        <dt>Website</dt><dd>{site.final_url || site.url || '—'}{site.error ? <span className="warn-text"> ({site.error})</span> : null}</dd>
        <dt>Pages read</dt><dd>{(site.pages || []).map(x => x.url).join(', ') || '—'}</dd>
        <dt>Emails on site</dt><dd>{site.emails?.join(', ') || '—'}</dd>
        <dt>Contact form</dt><dd>{site.has_contact_form ? 'Yes' : 'No'}</dd>
        <dt>Socials</dt><dd>{Object.entries(site.socials || {}).map(([k, v]) => <a key={k} href={v} target="_blank" rel="noreferrer" className="soc">{k}</a>)}{!Object.keys(site.socials || {}).length && '—'}</dd>
        <dt>Detected</dt><dd>{Object.entries(site.signals || {}).filter(([k]) => !['mentions', 'copyright_year'].includes(k)).map(([k, v]) => `${k.replace(/_/g, ' ')}: ${v.join(', ')}`).join(' · ') || '—'}</dd>
        <dt>Site mentions</dt><dd>{Object.entries(site.signals?.mentions || {}).filter(([, v]) => v).map(([k]) => k.replace(/_/g, ' ')).join(', ') || '—'}</dd>
        {site.signals?.copyright_year && <><dt>Copyright year</dt><dd>{site.signals.copyright_year}</dd></>}
        {g.hours && <><dt>Hours</dt><dd>{g.hours.join('; ')}</dd></>}
      </dl>
      {g.reviews?.length > 0 && <>
        <h4>Google reviews read</h4>
        <ul className="reviews">{g.reviews.map((x, i) => <li key={i}><strong>{'★'.repeat(x.rating || 0)}</strong> <span className="muted small">{x.when}</span><p>{x.text}</p></li>)}</ul>
      </>}
      <p className="muted small">Collected {timeAgo(r.collected_at)}.</p>
    </details>
  );
}
