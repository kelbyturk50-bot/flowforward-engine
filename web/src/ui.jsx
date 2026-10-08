import { useEffect, useRef, useState } from 'react';
import { localToday } from './api';

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

export const addDays = (n) => {
  const d = new Date(); d.setDate(d.getDate() + n);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

export function Drawer({ open, onClose, children, label }) {
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
      <aside className="drawer" role="dialog" aria-modal="true" aria-label={label} tabIndex={-1} ref={ref}>
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

export function ErrorNote({ error, onRetry }) {
  if (!error) return null;
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
