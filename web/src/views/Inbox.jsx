import { useCallback, useEffect, useState } from 'react';
import { api } from '../api';
import { useAsync, ErrorNote, FitBadge, timeAgo, toast } from '../ui';
import { useJobs } from '../jobs';

const TABS = [
  { id: 'needs', label: 'Needs a reply' },
  { id: 'fyi', label: 'FYI' },
  { id: 'handled', label: 'Handled' },
];
const WORKING = ['queued', 'triaging', 'rewrite_queued', 'rewriting'];
const PLACEHOLDER = /\[[^\]\n]{1,120}\]/g;

const KIND_CLASS = {
  interested: 'ichip-hot', question: 'ichip-hot', booked: 'ichip-booked', referral: 'ichip-hot',
  not_now: 'ichip-later', auto_reply: 'ichip-quiet', other: 'ichip-quiet',
  opt_out: 'ichip-out', not_interested: 'ichip-out', bounce: 'ichip-out',
};

function readSel() {
  const m = window.location.hash.match(/[?&]id=(\d+)/);
  return m ? Number(m[1]) : null;
}
function readTab() {
  const m = window.location.hash.match(/[?&]tab=(\w+)/);
  return TABS.some(t => t.id === m?.[1]) ? m[1] : 'needs';
}

function statusBadge(it) {
  if (WORKING.includes(it.status)) return { text: it.status.startsWith('rewrite') ? 'Rewriting…' : 'Reading…', cls: 'ibadge-working' };
  if (it.status === 'failed') return { text: "Couldn't draft", cls: 'ibadge-failed' };
  if (it.status === 'ready') return { text: 'Draft ready', cls: 'ibadge-ready' };
  if (it.status === 'sent') return { text: 'Replied', cls: 'ibadge-done' };
  if (it.status === 'handled') return { text: 'Handled', cls: 'ibadge-quiet' };
  if (it.status === 'discarded') return { text: 'Discarded', cls: 'ibadge-quiet' };
  if (it.status === 'fyi' && !it.reviewed_at) return { text: 'New', cls: 'ibadge-new' };
  return null;
}

export default function Inbox({ version, bump, openLead }) {
  const [tab, setTab] = useState(readTab);
  const [sel, setSel] = useState(readSel);
  const list = useAsync(() => api.inbox(tab), [tab, version]);
  const { inboxWorking } = useJobs();

  // Keep the list fresh while Claude is reading or rewriting something.
  useEffect(() => {
    if (!inboxWorking) return undefined;
    const t = setInterval(list.reload, 5000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inboxWorking]);

  const go = (nextTab, id = null) => {
    setTab(nextTab); setSel(id);
    history.replaceState(null, '', `#/inbox?tab=${nextTab}${id ? `&id=${id}` : ''}`);
  };
  const pick = (id) => { setSel(id); history.replaceState(null, '', `#/inbox?tab=${tab}&id=${id}`); };

  const items = list.data?.items || [];
  const counts = list.data?.counts || {};
  const current = sel ?? (items[0]?.id || null);

  return (
    <div className="page inbox-page">
      <header className="page-head">
        <div>
          <h1>Inbox</h1>
          <p className="muted">Replies to your proposals. Claude reads each one, sums it up, and drafts a response for you to review. Nothing sends until you click Send.</p>
        </div>
      </header>

      <div className="tabs" role="tablist" aria-label="Inbox filter">
        {TABS.map(t => (
          <button key={t.id} type="button" role="tab" aria-selected={tab === t.id} className={`tab ${tab === t.id ? 'active' : ''}`} onClick={() => go(t.id)}>
            {t.label}{counts[t.id] ? <span className="tab-count">{counts[t.id]}</span> : null}
          </button>
        ))}
      </div>

      <ErrorNote error={list.error} onRetry={list.reload} />

      <div className={`inbox-grid ${sel ? 'has-sel' : ''}`}>
        <section className="inbox-list" aria-label="Conversations">
          {list.loading && !list.data && <p className="muted pad-s">Loading…</p>}
          {list.data && items.length === 0 && (
            <p className="empty pad-s">{tab === 'needs' ? 'No replies waiting. When a lead writes back, it shows up here with a drafted response.' : 'Nothing here.'}</p>
          )}
          <ul className="plain">
            {items.map(it => {
              const b = statusBadge(it);
              return (
                <li key={it.id}>
                  <button type="button" className={`inbox-row ${it.id === current ? 'selected' : ''}`} aria-pressed={it.id === current} onClick={() => pick(it.id)}>
                    <span className="inbox-row-top"><span className="lead-name">{it.company}</span><span className="muted small">{timeAgo(it.received_at)}</span></span>
                    <span className="muted small">{it.contact_name || it.from_addr}</span>
                    <span className="inbox-chips">
                      {it.label && <span className={`ichip ${KIND_CLASS[it.kind] || 'ichip-quiet'}`}>{it.label}</span>}
                      {b && <span className={`ibadge ${b.cls}`}>{b.text}</span>}
                    </span>
                    <span className="inbox-preview">{(it.preview || '').replace(/\s+/g, ' ')}</span>
                  </button>
                </li>
              );
            })}
          </ul>
        </section>

        <section className="inbox-detail" aria-label="Conversation">
          {current
            ? <Detail key={current} id={current} bump={bump} openLead={openLead} onBack={() => go(tab)} onMoved={list.reload} />
            : list.data && <p className="muted pad-s">Pick a conversation.</p>}
        </section>
      </div>
    </div>
  );
}

function Detail({ id, bump, openLead, onBack, onMoved }) {
  const [it, setIt] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState('');
  const [body, setBody] = useState('');
  const [note, setNote] = useState('');
  const [showOlder, setShowOlder] = useState(false);

  const load = useCallback(async () => {
    try {
      const d = await api.inboxItem(id);
      setIt(d); setError(null);
      setBody(b => (d.status === 'ready' ? (d.reply_body || '') : b));
      if (!d.reviewed_at && !WORKING.includes(d.status)) api.markInboxSeen(id).then(() => bump()).catch(() => {});
    } catch (e) { setError(e); }
  }, [id, bump]);
  useEffect(() => { load(); }, [load]);

  const working = it && WORKING.includes(it.status);
  useEffect(() => {
    if (!working) return undefined;
    const t = setInterval(load, 4000);
    return () => clearInterval(t);
  }, [working, load]);

  if (error) return <ErrorNote error={error} onRetry={load} />;
  if (!it) return <p className="muted pad-s">Loading…</p>;

  const act = async (label, fn, msg) => {
    setBusy(label);
    try { await fn(); if (msg) toast(msg); bump(); onMoved(); await load(); }
    catch (e) { toast(e.message); }
    finally { setBusy(''); }
  };
  const saveBody = async () => {
    if (it.status !== 'ready' || body === (it.reply_body || '')) return;
    try { await api.updateInboxItem(it.id, { reply_body: body }); setIt(x => ({ ...x, reply_body: body })); }
    catch (e) { toast(e.message); }
  };
  const holes = body.match(PLACEHOLDER) || [];
  const words = body.trim() ? body.trim().split(/\s+/).length : 0;
  const thread = it.thread || [];
  const older = thread.slice(0, -1);
  const latest = thread[thread.length - 1];
  const editable = it.status === 'ready';
  const canDraftAnyway = it.status === 'fyi' && !['opt_out', 'bounce'].includes(it.kind) && !it.do_not_contact;

  return (
    <div className="inbox-detail-body">
      <button type="button" className="linklike inbox-back" onClick={onBack}>← All replies</button>
      <header className="inbox-head">
        <div>
          <h2>{it.company}</h2>
          <p className="muted">{[it.contact_name, it.from_addr, it.industry, it.city].filter(Boolean).join(' · ')}</p>
        </div>
        <div className="inbox-head-side">
          {it.label && <span className={`ichip ${KIND_CLASS[it.kind] || 'ichip-quiet'}`}>{it.label}</span>}
          <FitBadge score={it.fit_score} tier={it.fit_tier} size="sm" />
          <button type="button" className="linklike small" onClick={() => openLead(it.prospect_id)}>Open lead</button>
        </div>
      </header>

      {working && (
        <div className="job-banner job-running" role="status" aria-live="polite">
          <span className="spinner" aria-hidden="true" />
          <div><strong>{it.status.startsWith('rewrite') ? 'Rewriting your reply…' : 'Reading their message…'}</strong>
            <p className="small">Usually under a minute. You can switch to another reply.</p></div>
        </div>
      )}
      {it.status === 'failed' && (
        <div className="job-banner job-failed" role="alert">
          <div><strong>Couldn&apos;t draft a reply.</strong> <span className="small">{it.error}</span></div>
          <button type="button" className="btn btn-quiet btn-sm" disabled={!!busy} onClick={() => act('retry', () => api.rewriteInboxReply(it.id, 'Try again.'), 'Trying again in the background.')}>Try again</button>
        </div>
      )}
      {it.error && it.status === 'ready' && <div className="error-note"><p>{it.error}</p></div>}

      {it.summary && (
        <section className="panel inbox-read">
          <h3 className="col-title">What they&apos;re saying</h3>
          <p className="inbox-summary">{it.summary}</p>
          <div className="inbox-facts">
            <div><p className="fact-label">They&apos;re asking</p>
              {it.asks?.length ? <ul className="bullets">{it.asks.map((q, i) => <li key={i}>{q}</li>)}</ul> : <p className="muted">Nothing specific</p>}</div>
            <div><p className="fact-label">Timing</p><p>{it.timing || 'None'}</p></div>
            <div><p className="fact-label">Tone</p><p>{it.mood || '—'}</p></div>
          </div>
          {it.prep?.length > 0 && (
            <div className="inbox-prep"><p className="fact-label">Call prep</p><ul className="bullets">{it.prep.map((x, i) => <li key={i}>{x}</li>)}</ul></div>
          )}
          {it.suggestions?.length > 0 && (
            <div>
              <p className="fact-label">Suggested next steps <span className="muted">(nothing changes until you click)</span></p>
              <div className="chips">
                {it.suggestions.map((s, i) => {
                  const done = !!(it.applied && it.applied[String(i)]);
                  return (
                    <button key={i} type="button" className={`chip ${done ? 'chip-on' : ''}`} aria-pressed={done} disabled={done || !!busy}
                      onClick={() => act(`s${i}`, () => api.applyInboxSuggestion(it.id, i), `Done: ${s.label}`)}>
                      {done ? '✓ ' : ''}{s.label}
                    </button>
                  );
                })}
              </div>
            </div>
          )}
        </section>
      )}

      {it.notice && <div className="inbox-notice" role="note">{it.notice}</div>}

      <section className="inbox-thread" aria-label="Messages">
        <div className="inbox-thread-head">
          <h3>Conversation</h3>
          {older.length > 0 && <button type="button" className="linklike small" onClick={() => setShowOlder(v => !v)}>{showOlder ? 'Hide earlier messages' : `Show ${older.length} earlier message${older.length === 1 ? '' : 's'}`}</button>}
        </div>
        {showOlder && older.map((m, i) => <Message key={i} m={m} />)}
        {latest && <Message m={latest} />}
      </section>

      {editable && (
        <section className="panel inbox-editor">
          <div className="field-head"><h3>Your reply <span className="muted small">· drafted by Claude in your voice</span></h3><span className="muted small">{words} words</span></div>
          <p className="small muted">To <strong className="ink">{it.reply_to}</strong> · {it.reply_subject}</p>
          <label className="sr-only" htmlFor={`reply-${it.id}`}>Reply text</label>
          <textarea id={`reply-${it.id}`} className="input" rows={12} value={body} onChange={e => setBody(e.target.value)} onBlur={saveBody} />
          {holes.length > 0 && (
            <div className="inbox-holes">
              <p><strong>{holes.length === 1 ? '1 spot needs you' : `${holes.length} spots need you`}</strong> before this can go out. Replace each bracketed bit with your answer.</p>
              <div className="chips">{holes.map((h, i) => <code key={i} className="hole">{h}</code>)}</div>
            </div>
          )}
          <div className="link-row">
            <button type="button" className="btn" disabled={!!busy || holes.length > 0 || !body.trim()}
              onClick={() => act('send', async () => { await saveBody(); await api.sendInboxReply(it.id); }, `Sent to ${it.reply_to}.`)}>
              {busy === 'send' ? 'Sending…' : 'Send reply'}
            </button>
            <button type="button" className="btn btn-quiet" disabled={!!busy} onClick={() => act('handled', () => api.handleInboxItem(it.id, 'Handled another way'), 'Marked handled.')}>I handled it another way</button>
            <button type="button" className="btn btn-quiet btn-danger-text" disabled={!!busy} onClick={() => act('discard', () => api.discardInboxDraft(it.id), 'Draft discarded.')}>Discard draft</button>
          </div>
          <div className="inbox-rewrite">
            <label htmlFor={`note-${it.id}`}>Ask for a rewrite
              <input id={`note-${it.id}`} className="input" value={note} onChange={e => setNote(e.target.value)} placeholder="e.g. Shorter. Offer Wednesday instead. Don't mention price." />
            </label>
            <button type="button" className="btn btn-quiet" disabled={!!busy}
              onClick={() => act('rewrite', async () => { await saveBody(); await api.rewriteInboxReply(it.id, note || 'Rewrite it.'); setNote(''); }, 'Rewriting in the background.')}>Rewrite</button>
          </div>
        </section>
      )}

      {it.status === 'fyi' && (
        <div className="link-row">
          <button type="button" className="btn" disabled={!!busy} onClick={() => act('ok', () => api.handleInboxItem(it.id, 'Seen'), 'Moved to Handled.')}>Got it</button>
          {canDraftAnyway && <button type="button" className="btn btn-quiet" disabled={!!busy} onClick={() => act('anyway', () => api.rewriteInboxReply(it.id, 'Write a short, friendly reply.'), 'Drafting a reply in the background.')}>Write a reply anyway</button>}
        </div>
      )}

      {['sent', 'handled', 'discarded'].includes(it.status) && (
        <div className="inbox-done">
          <p>{it.status === 'sent' ? `Replied ${timeAgo(it.sent_at)} from flowforward50@gmail.com, in the same thread.` : (it.handled_note || (it.status === 'discarded' ? 'Draft discarded.' : 'Handled.'))}</p>
          {it.status !== 'sent' && <button type="button" className="btn btn-quiet btn-sm" disabled={!!busy} onClick={() => act('reopen', () => api.reopenInboxItem(it.id), 'Moved back.')}>Reopen</button>}
        </div>
      )}
    </div>
  );
}

function Message({ m }) {
  const mine = m.direction === 'out';
  const who = mine ? 'You' : m.who;
  const initials = mine ? 'You' : String(who || '?').replace(/@.*/, '').split(/[.\s_+-]/).filter(Boolean).slice(0, 2).map(w => w[0].toUpperCase()).join('') || '?';
  return (
    <article className={`imsg ${mine ? 'imsg-out' : 'imsg-in'}`}>
      <div className="imsg-avatar" aria-hidden="true">{initials}</div>
      <div className="imsg-body">
        <p className="imsg-meta"><strong>{who}</strong> · {timeAgo(m.at)}{m.is_auto ? ' · automatic reply' : ''}{m.source === 'followup' ? ' · follow-up' : ''}</p>
        <p className="imsg-text">{m.body}</p>
      </div>
    </article>
  );
}
