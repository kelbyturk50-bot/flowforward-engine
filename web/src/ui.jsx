import { useEffect, useRef, useState } from 'react';
import { localToday } from './api';
import { UNCONFIGURED_MESSAGE } from './api-base.js';

export const STAGES = [
  { id: 'found',        label: 'Found' },
  { id: 'contacted',    label: 'Contacted' },
  { id: 'responded',    label: 'Responded' },
  { id: 'qualified',    label: 'Qualified' },
  { id: 'proposal',     label: 'Proposal' },
  { id: 'won',          label: 'Won' },
  { id: 'lost',         label: 'Lost' },
  { id: 'disqualified', label: 'Not a fit' },
];
export const stageLabel = (id) => STAGES.find(s => s.id === id)?.label || id;

export const PROJECT_STATUSES = [
  { id: 'planning',  label: 'Planning' },
  { id: 'active',    label: 'Active' },
  { id: 'on_hold',   label: 'On hold' },
  { id: 'done',      label: 'Done' },
  { id: 'cancelled', label: 'Cancelled' },
];
export const statusLabel = (id) => PROJECT_STATUSES.find(s => s.id === id)?.label || id;

/** The ticket-stub fit badge: tier letter + score. */
export function FitBadge({ score, tier, size = 'md' }) {
  if (score == null) return <span className={`fit fit-${size} fit-none`} title="Not scored yet">–</span>;
  return (
    <span className={`fit fit-${size} fit-${tier}`} title={`Fit ${score}/100, tier ${tier}`}>
      <span className="fit-tier">{tier}</span>
      <span className="fit-score">{score}</span>
    </span>
  );
}

export function StageChip({ stage }) {
  return <span className={`stage stage-${stage}`}>{stageLabel(stage)}</span>;
}

export function Stars({ rating, reviews }) {
  if (rating == null && !reviews) return <span className="muted">No reviews</span>;
  return <span className="stars">{rating != null ? `${Number(rating).toFixed(1)}★` : ''} <span className="muted">({reviews || 0})</span></span>;
}

export const money = (v) => v == null || v === '' ? '' :
  Number(v).toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });

export function relDate(dateStr) {
  if (!dateStr) return '';
  const today = localToday();
  const d = dateStr.slice(0, 10);
  const diff = Math.round((new Date(d + 'T12:00') - new Date(today + 'T12:00')) / 86400000);
  if (diff === 0) return 'today';
  if (diff === -1) return 'yesterday';
  if (diff === 1) return 'tomorrow';
  if (diff < 0) return `${-diff} days overdue`;
  if (diff < 7) return new Date(d + 'T12:00').toLocaleDateString('en-US', { weekday: 'long' });
  return new Date(d + 'T12:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}
export const isOverdue = (d) => d && d.slice(0, 10) < localToday();

export function timeAgo(ts) {
  if (!ts) return '';
  const s = (Date.now() - new Date(ts).getTime()) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 86400 * 30) return `${Math.floor(s / 86400)}d ago`;
  return new Date(ts).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

/** True when the viewport is at or under the CRM phone breakpoint. */
export function useNarrow(query = '(max-width: 860px)') {
  const get = () => typeof window.matchMedia === 'function' && window.matchMedia(query).matches;
  const [matches, setMatches] = useState(get);
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return undefined;
    const mq = window.matchMedia(query);
    const on = () => setMatches(mq.matches);
    on();
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, [query]);
  return matches;
}

export const addDays = (n) => {
  const d = new Date(); d.setDate(d.getDate() + n);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

const TABBABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled])';

function tabbables(root) {
  return [...root.querySelectorAll(TABBABLE)].filter((el) => el.tabIndex !== -1);
}

/** Phone bottom sheet. Focus enters on open, stays inside while open, and returns to the opener on close. */
export function BottomSheet({ open, onClose, title, children }) {
  const ref = useRef(null);
  const onCloseRef = useRef(onClose);
  const returnFocus = useRef(null);
  onCloseRef.current = onClose;
  useEffect(() => {
    if (!open) return undefined;
    returnFocus.current = document.activeElement;
    const onKey = (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onCloseRef.current();
        return;
      }
      if (e.key !== 'Tab' || !ref.current) return;
      const items = tabbables(ref.current);
      if (items.length === 0) {
        e.preventDefault();
        ref.current.focus();
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement;
      if (e.shiftKey && (active === first || active === ref.current || !ref.current.contains(active))) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (active === last || !ref.current.contains(active))) {
        e.preventDefault();
        first.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    ref.current?.focus();
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = prev;
      const back = returnFocus.current;
      if (back instanceof HTMLElement) back.focus();
    };
  }, [open]);
  if (!open) return null;
  return (
    <div className="sheet-wrap" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="sheet" role="dialog" aria-modal="true" aria-label={title} tabIndex={-1} ref={ref}>
        <div className="sheet-grab" aria-hidden="true" />
        <header className="sheet-head">
          <h2>{title}</h2>
          <button type="button" className="btn btn-quiet btn-sm" onClick={onClose}>Done</button>
        </header>
        {children}
      </div>
    </div>
  );
}

export function Drawer({ open, onClose, children, label, wide }) {
  const ref = useRef(null);
  useEffect(() => {
    if (!open) return;
    const onKey = (e) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    ref.current?.focus();
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="drawer-wrap" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <aside className={`drawer ${wide ? 'drawer-wide' : ''}`} role="dialog" aria-modal="true" aria-label={label} tabIndex={-1} ref={ref}>
        <button className="drawer-close" onClick={onClose} aria-label="Close">×</button>
        {children}
      </aside>
    </div>
  );
}

export function useAsync(fn, deps) {
  const [state, set] = useState({ loading: true, error: null, data: null });
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let live = true;
    set(s => ({ ...s, loading: true, error: null }));
    fn().then(data => live && set({ loading: false, error: null, data }))
        .catch(error => live && set(s => ({ loading: false, error, data: s.data })));
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick]);
  return { ...state, reload: () => setTick(t => t + 1) };
}

/** A 400 from the leads or pipeline list is a bad filter, not a crash. */
export function presentError(error) {
  if (!error) return null;
  if (error.status === 400) return { message: 'Those filters are not valid. Clear them and try again.' };
  return error;
}

export function ErrorNote({ error, onRetry }) {
  if (!error || error.message === UNCONFIGURED_MESSAGE) return null;
  return (
    <div className="error-note" role="alert">
      <p>{error.message}</p>
      {onRetry && <button className="btn btn-quiet" onClick={onRetry}>Try again</button>}
    </div>
  );
}

let toastSet = null;
export function toast(msg) { toastSet?.(msg); }
export function Toaster() {
  const [msg, setMsg] = useState(null);
  useEffect(() => { toastSet = (m) => { setMsg(m); }; return () => { toastSet = null; }; }, []);
  useEffect(() => { if (!msg) return; const t = setTimeout(() => setMsg(null), 2600); return () => clearTimeout(t); }, [msg]);
  return <div className={`toast ${msg ? 'show' : ''}`} role="status" aria-live="polite">{msg}</div>;
}

export const telHref = (p) => p ? 'tel:' + p.replace(/[^\d+]/g, '') : null;
export const mapsHref = (lead) => 'https://www.google.com/maps/search/?api=1&query=' +
  encodeURIComponent([lead.company, lead.address || lead.city, lead.state].filter(Boolean).join(' '));

// ── Proposal bot ─────────────────────────────────────────
export const PROPOSAL_STATUS = {
  draft: 'To review', sending: 'Sending', sent: 'Out', replied: 'Replied', bounced: 'Bounced', opted_out: 'Opted out',
  finished: 'No reply', stopped: 'Stopped', discarded: 'Discarded', superseded: 'Older version',
};
export function ProposalChip({ status, verdict }) {
  const label = status === 'discarded' && verdict === 'disqualify' ? 'Not a fit' : (PROPOSAL_STATUS[status] || status);
  return <span className={`pchip pchip-${status}`}>{label}</span>;
}

export const money2 = (v) => v == null ? '' : `$${Number(v).toFixed(2)}`;

// Lightweight cold-email checks: things that hurt deliverability or reads.
const SPAMMY = ['guarantee', 'act now', 'limited time', 'no obligation', 'risk-free', 'click here', '100%', 'winner',
  'urgent', 'cash', 'earn', 'increase sales', 'synergy', 'leverage', 'cutting-edge', 'revolutionize', 'game-changer', 'unlock'];
export function emailChecks({ subject = '', body = '' }, { firstEmail = true } = {}) {
  const out = [];
  const words = body.trim() ? body.trim().split(/\s+/).length : 0;
  const links = (body.match(/https?:\/\/|\{\{\s*(ONEPAGER|CALENDLY)_URL\s*\}\}/gi) || []).length;
  if (firstEmail && words > 130) out.push(`${words} words. Under ~110 gets read more.`);
  if (!firstEmail && words > 80) out.push(`${words} words. Follow-ups work best under ~60.`);
  if (firstEmail && links === 0) out.push('No link to the one-pager ({{ONEPAGER_URL}}).');
  if (links > 1 && firstEmail) out.push(`${links} links. One link is safest for a cold email.`);
  if (subject && subject.length > 60) out.push('Long subject line.');
  if (/!/.test(subject)) out.push('Exclamation mark in the subject.');
  if (subject && subject === subject.toUpperCase() && /[A-Z]/.test(subject)) out.push('Subject is all caps.');
  const text = `${subject} ${body}`.toLowerCase();
  const hits = SPAMMY.filter(w => /^[\w -]+$/.test(w) ? new RegExp(`\\b${w.replace(/-/g, '[- ]?')}\\b`).test(text) : text.includes(w));
  if (hits.length) out.push(`Watch these words: ${hits.join(', ')}.`);
  if (/\$\d|\d%/.test(subject)) out.push('Dollar amounts or percents in the subject.');
  if (/\bfree\b/i.test(subject)) out.push('"Free" in the subject line trips spam filters; keep it in the body.');
  return { words, links, issues: out };
}
