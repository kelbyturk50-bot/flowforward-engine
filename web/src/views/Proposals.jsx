import { useState } from 'react';
import { api } from '../api';
import { useAsync, ErrorNote, FitBadge, ProposalChip, money2, relDate, timeAgo, toast } from '../ui';

const TABS = [
  { id: 'review',  label: 'To review', note: 'Drafts the bot wrote. Read, edit, then approve and send.' },
  { id: 'out',     label: 'Out',       note: 'Sent. Follow-ups go out on day 3 and day 10 unless they reply, book, or you stop it.' },
  { id: 'replied', label: 'Replied',   note: 'They wrote back or booked a call. Follow-ups stopped.' },
  { id: 'flagged', label: 'Not a fit', note: 'The bot flagged these. Restore any you disagree with.' },
  { id: 'closed',  label: 'Closed',    note: 'No reply after the follow-ups, stopped, bounced, opted out, or discarded.' },
];

function readTab() {
  const m = window.location.hash.match(/[?&]tab=(\w+)/);
  return TABS.some(t => t.id === m?.[1]) ? m[1] : 'review';
}

function sequenceLine(p) {
  if (p.status === 'sending') return 'Sending…';
  if (p.status === 'replied') return `Replied ${timeAgo(p.replied_at)}${p.stop_reason ? ` · ${p.stop_reason}` : ''}`;
  if (p.status !== 'sent') return p.stop_reason || '';
  const parts = [`Sent ${timeAgo(p.sent_at)}`];
  if (p.followup1_due_at && !p.followup1_sent_at) parts.push(`follow-up 1 ${relDate(p.followup1_due_at)}`);
  else if (p.followup2_due_at && !p.followup2_sent_at) parts.push(`follow-up 2 ${relDate(p.followup2_due_at)}`);
  else if (p.followup2_sent_at) parts.push('both follow-ups sent');
  return parts.join(' · ');
}

export default function Proposals({ version, bump, openProposal }) {
  const [tab, setTab] = useState(readTab);
  const [busy, setBusy] = useState(false);
  const summary = useAsync(() => api.proposalSummary(), [version]);
  const list = useAsync(() => api.proposals({ view: tab }), [tab, version]);
  const s = summary.data;

  const go = (id) => { setTab(id); history.replaceState(null, '', `#/proposals?tab=${id}`); };

  const draftNow = async () => {
    setBusy(true);
    try {
      const r = await api.triggerProposals(s?.config?.nightly_count || 5);
      toast(r.message + ' They show up here in a few minutes.');
      setTimeout(() => { bump(); setBusy(false); }, 45000);
    } catch (e) { toast(e.message); setBusy(false); }
  };

  const current = TABS.find(t => t.id === tab);
  const rows = list.data?.proposals || [];

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1>Proposals</h1>
          <p className="muted">
            {s ? <>
              {s.eligible_leads} {s.config.tiers.join('/')}-tier leads waiting · {s.sent_today}/{s.daily_limit} emails sent today · {money2(s.spend_this_month)} on drafts this month
            </> : ' '}
          </p>
        </div>
        <button className="btn" onClick={draftNow} disabled={busy || s?.running || !s || s.setup.some(x => x.includes('ANTHROPIC'))}>
          {busy || s?.running ? 'Drafting…' : `Draft ${s?.config?.nightly_count || 5} now`}
        </button>
      </header>

      {s?.setup?.length > 0 && (
        <div className="setup-note" role="note">
          <strong>Finish setup in Railway</strong>
          <ul>{s.setup.map(x => <li key={x}>{x}</li>)}</ul>
        </div>
      )}

      <div className="tabs" role="tablist" aria-label="Proposal status">
        {TABS.map(t => (
          <button key={t.id} role="tab" aria-selected={tab === t.id} className={`tab ${tab === t.id ? 'active' : ''}`} onClick={() => go(t.id)}>
            {t.label}{s?.counts?.[t.id] ? <span className="tab-count">{s.counts[t.id]}</span> : null}
          </button>
        ))}
      </div>
      <p className="panel-note">{current.note}</p>

      <ErrorNote error={list.error || summary.error} onRetry={() => { list.reload(); summary.reload(); }} />

      <div className="table-wrap">
        {list.loading && !list.data && <p className="muted">Loading…</p>}
        {list.data && rows.length === 0 && (
          <p className="empty">{tab === 'review'
            ? `Nothing to review. The bot drafts ${s?.config?.nightly_count || 5} each night for new ${s?.config?.tiers?.join('/') || 'A'}-tier leads, or use "Draft now".`
            : 'Nothing here yet.'}</p>
        )}
        {rows.length > 0 && (
          <ul className="prop-list">
            {rows.map(p => (
              <li key={p.id}>
                <button className="prop-row" onClick={() => openProposal(p.id)}>
                  <FitBadge score={p.fit_score} tier={p.fit_tier} />
                  <span className="prop-main">
                    <span className="lead-name">{p.company}</span>
                    <span className="lead-sub">
                      {p.industry}{p.city ? <><span className="sep" />{p.city}</> : null}
                      {p.to_email ? <><span className="sep" />{p.to_email}</> : <><span className="sep" /><span className="warn-text">No email found</span></>}
                    </span>
                    {p.subject && <span className="prop-subject">“{p.subject}”</span>}
                    {tab !== 'review' && <span className="prop-seq">{sequenceLine(p)}{p.views ? ` · one-pager opened ${p.views}×` : ''}</span>}
                  </span>
                  <span className="prop-side">
                    <ProposalChip status={p.status} verdict={p.fit_verdict} />
                    {tab === 'review' && p.fit_verdict === 'weak' && <span className="pchip pchip-weak">Weak fit</span>}
                    {p.feedback_rating === 1 && <span aria-label="You liked this">👍</span>}
                    {p.feedback_rating === -1 && <span aria-label="You disliked this">👎</span>}
                    <span className="muted small">v{p.version} · {money2(p.cost_usd)}</span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
