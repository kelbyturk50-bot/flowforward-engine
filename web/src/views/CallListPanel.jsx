import { useEffect, useRef, useState } from 'react';
import { CALL_OUTCOMES, api } from '../api';
import { ErrorNote } from '../ui';
import {
  CALL_OUTCOME_LABELS,
  EMPTY_CALL_LIST,
  UNDO_MS,
  backOnLabel,
  callListErrorMessage,
  moreCount,
  rowAsk,
  rowScript,
  rowVoicemail,
  safeMaps,
  safeTel,
} from './call-list';

function rowKey(item, index) {
  return `${item?.prospect_id ?? 'row'}-${index}`;
}

function sameId(item, id) {
  return String(item?.prospect_id) === id;
}

export default function CallListPanel({ version, openLead, onActiveChange }) {
  const [phase, setPhase] = useState('loading');
  const [rows, setRows] = useState([]);
  const [more, setMore] = useState(0);
  const [expanded, setExpanded] = useState(false);
  const [moreBusy, setMoreBusy] = useState(false);
  const [listError, setListError] = useState(null);
  const [tick, setTick] = useState(0);
  const [, setUndoTick] = useState(0);
  const [openId, setOpenId] = useState(null);
  const [saving, setSaving] = useState(() => new Set());
  const [rowErrors, setRowErrors] = useState(() => new Map());
  const knownOn = useRef(false);
  const alive = useRef(true);
  const pendingRef = useRef(new Map());
  const savingRef = useRef(saving);
  const commitRef = useRef(async () => {});
  const clockRef = useRef(null);
  const openRowRef = useRef(null);
  savingRef.current = saving;

  function scrollOpenRow() {
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
    try { openRowRef.current?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' }); } catch { /* jsdom */ }
  }

  useEffect(() => {
    onActiveChange?.(phase === 'ready' || phase === 'error');
  }, [phase, onActiveChange]);

  useEffect(() => {
    let live = true;
    api.todayCallList().then((data) => {
      if (!live) return;
      if (data?.enabled === true) {
        knownOn.current = true;
        const items = Array.isArray(data.items) ? data.items : [];
        setRows(items);
        setMore(data.more);
        setExpanded(false);
        setListError(null);
        setPhase('ready');
        return;
      }
      knownOn.current = false;
      setRows([]);
      setListError(null);
      setPhase('off');
    }).catch((error) => {
      if (!live) return;
      if (error?.status === 404 || !knownOn.current) {
        knownOn.current = false;
        setRows([]);
        setListError(null);
        setPhase('off');
        return;
      }
      setListError(error);
      setPhase('error');
    });
    return () => { live = false; };
  }, [version, tick]);

  async function commit(entry) {
    if (alive.current) setSaving((current) => new Set(current).add(entry.id));
    try {
      const result = await api.recordCallOutcome(entry.id, { outcome: entry.outcome, kind: entry.kind });
      if (!alive.current) return;
      const back = backOnLabel(result?.back_on);
      setRows((list) => {
        if (result?.removed && back) {
          return list.map((row) => (sameId(row, entry.id) ? { ...row, settledBackOn: back, backNote: null } : row));
        }
        if (result?.removed) return list.filter((row) => !sameId(row, entry.id));
        if (back) return list.map((row) => (sameId(row, entry.id) ? { ...row, backNote: back } : row));
        return list;
      });
      setRowErrors((current) => {
        if (!current.has(entry.id)) return current;
        const next = new Map(current);
        next.delete(entry.id);
        return next;
      });
    } catch (error) {
      if (!alive.current) return;
      setRowErrors((current) => new Map(current).set(entry.id, callListErrorMessage(error)));
    } finally {
      if (alive.current) {
        setSaving((current) => {
          if (!current.has(entry.id)) return current;
          const next = new Set(current);
          next.delete(entry.id);
          return next;
        });
      }
    }
  }
  commitRef.current = commit;

  useEffect(() => {
    const pending = pendingRef.current;
    function flushOne(id) {
      const entry = pending.get(id);
      if (!entry) return;
      pending.delete(id);
      clearTimeout(entry.timer);
      if (alive.current) setUndoTick((n) => n + 1);
      commitRef.current(entry);
    }
    function flushAll() {
      for (const id of [...pending.keys()]) flushOne(id);
    }
    function onVis() {
      if (document.visibilityState === 'hidden') flushAll();
      else scrollOpenRow();
    }
    function onPageHide() { flushAll(); }
    function onFocus() { scrollOpenRow(); }
    alive.current = true;
    document.addEventListener('visibilitychange', onVis);
    window.addEventListener('pagehide', onPageHide);
    window.addEventListener('focus', onFocus);
    return () => {
      document.removeEventListener('visibilitychange', onVis);
      window.removeEventListener('pagehide', onPageHide);
      window.removeEventListener('focus', onFocus);
      if (clockRef.current) {
        clearInterval(clockRef.current);
        clockRef.current = null;
      }
      alive.current = false;
      flushAll();
    };
  }, []);

  function startClock() {
    if (clockRef.current) return;
    clockRef.current = setInterval(() => {
      if (pendingRef.current.size === 0) {
        clearInterval(clockRef.current);
        clockRef.current = null;
        return;
      }
      setUndoTick((n) => n + 1);
    }, 1000);
  }

  function arm(item, outcome) {
    const id = String(item?.prospect_id ?? '');
    if (!/^\d{1,9}$/.test(id)) return;
    if (pendingRef.current.has(id) || savingRef.current.has(id)) return;
    const timer = setTimeout(() => {
      const entry = pendingRef.current.get(id);
      if (!entry) return;
      pendingRef.current.delete(id);
      setUndoTick((n) => n + 1);
      commitRef.current(entry);
    }, UNDO_MS);
    pendingRef.current.set(id, {
      id,
      item,
      outcome,
      kind: item.kind === 'walk_in' ? 'walk_in' : 'call',
      timer,
      deadline: Date.now() + UNDO_MS,
    });
    startClock();
    setUndoTick((n) => n + 1);
  }

  async function showAll() {
    if (moreBusy || expanded) return;
    setMoreBusy(true);
    try {
      const data = await api.todayCallList({ all: true });
      if (!alive.current) return;
      if (data?.enabled !== true) {
        knownOn.current = false;
        setRows([]);
        setListError(null);
        setPhase('off');
        return;
      }
      setRows(Array.isArray(data.items) ? data.items : []);
      setMore(data.more);
      setExpanded(true);
      setListError(null);
    } catch (error) {
      if (!alive.current) return;
      setListError({ message: callListErrorMessage(error) });
    } finally {
      if (alive.current) setMoreBusy(false);
    }
  }

  function undo(id) {
    const entry = pendingRef.current.get(id);
    if (!entry) return;
    clearTimeout(entry.timer);
    pendingRef.current.delete(id);
    setUndoTick((n) => n + 1);
  }

  if (phase === 'loading' || phase === 'off') return null;

  const caution = CALL_OUTCOMES[CALL_OUTCOMES.length - 1];
  const ordinary = CALL_OUTCOMES.slice(0, -1);

  return (
    <section className="panel call-list-panel" aria-labelledby="call-list-heading">
      <h2 id="call-list-heading">Calls due / Walk-ins</h2>
      <p className="panel-note">Taps open your phone or Maps. Nothing is sent from here.</p>
      {listError && <ErrorNote error={listError} onRetry={() => setTick((n) => n + 1)} />}
      {rows.length === 0 && !listError && <p className="empty">{EMPTY_CALL_LIST}</p>}
      {rows.length > 0 && (
        <ul className="call-list-list">
          {rows.map((item, index) => (
            <CallListRow
              key={rowKey(item, index)}
              item={item}
              openLead={openLead}
              pending={pendingRef.current.get(String(item.prospect_id)) || null}
              saving={saving.has(String(item.prospect_id))}
              error={rowErrors.get(String(item.prospect_id)) || ''}
              open={openId === String(item.prospect_id)}
              rowRef={openId === String(item.prospect_id) ? openRowRef : null}
              onReveal={() => setOpenId(String(item.prospect_id))}
              onArm={arm}
              onUndo={undo}
              ordinary={ordinary}
              caution={caution}
            />
          ))}
        </ul>
      )}
      {!expanded && moreCount(more) > 0 && (
        <button type="button" className="btn btn-quiet call-list-more" onClick={showAll} disabled={moreBusy}>
          {moreBusy ? 'Loading…' : `Show ${moreCount(more)} more`}
        </button>
      )}
      {expanded && moreCount(more) > 0 && (
        <p className="call-list-hint">{`${moreCount(more)} more aren't on this list.`}</p>
      )}
    </section>
  );
}

function undoSeconds(deadline) {
  const remain = deadline - Date.now();
  if (remain <= 0) return 1;
  return Math.min(8, Math.ceil(remain / 1000));
}

function CallListRow({ item, openLead, pending, saving, error, open, rowRef, onReveal, onArm, onUndo, ordinary, caution }) {
  const company = item.company || 'Lead';
  const [scriptOpen, setScriptOpen] = useState(false);
  const undoRef = useRef(null);
  useEffect(() => {
    if (!pending) return;
    try { undoRef.current?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' }); } catch { /* jsdom */ }
  }, [pending]);

  if (item.settledBackOn) {
    return (
      <li className="call-list-card call-list-settled">
        <p className="call-list-company-text">{company}</p>
        <p className="call-list-back">{item.settledBackOn}</p>
      </li>
    );
  }

  if (pending) {
    const label = CALL_OUTCOME_LABELS[pending.outcome] || 'Outcome';
    return (
      <li className="call-list-card" ref={undoRef}>
        <div className="call-list-undo">
          <p className="call-list-company-text">{company}</p>
          <p role="status">{`${label}. Undo to cancel.`}</p>
          <button type="button" className="btn" aria-live="off" onClick={() => onUndo(pending.id)}>
            {`Undo ${label} (${undoSeconds(pending.deadline)})`}
          </button>
        </div>
      </li>
    );
  }

  const tel = safeTel(item);
  const maps = safeMaps(item);
  const script = rowScript(item);
  const voicemail = rowVoicemail(item);
  const ask = rowAsk(item);
  const extraLabel = voicemail && ask ? 'Voicemail and the ask' : voicemail ? 'Voicemail' : ask ? 'The ask' : '';
  const mapPrimary = !tel && Boolean(maps);

  return (
    <li className={`call-list-card${open ? ' is-open' : ''}`} ref={rowRef || undefined}>
      <div className="call-list-top">
        <button type="button" className="call-list-company" onClick={() => openLead(Number(item.prospect_id))}>
          {company}
        </button>
        <span className={`call-list-badge ${item.kind === 'walk_in' ? 'is-walk' : 'is-call'}`}>
          {item.kind === 'walk_in' ? 'Walk-in' : 'Call'}
        </span>
      </div>
      {item.reason ? <p className="call-list-reason">{item.reason}</p> : null}
      {script ? (
        <button
          type="button"
          className={`call-list-script${scriptOpen ? ' is-open' : ''}`}
          aria-expanded={scriptOpen ? 'true' : 'false'}
          onClick={() => setScriptOpen((value) => !value)}
        >
          {script}
        </button>
      ) : null}
      <div className="call-list-actions">
        {tel && (
          <a className="btn call-list-go is-primary" href={tel} aria-label={`Call ${company}`} onClick={onReveal}>
            Call
          </a>
        )}
        {maps && (
          <a
            className={`btn call-list-go${mapPrimary ? ' is-primary' : ' btn-quiet is-secondary'}`}
            href={maps}
            target="_blank"
            rel="noreferrer"
            aria-label={`Map for ${company}`}
            onClick={onReveal}
          >
            Map
          </a>
        )}
        <button type="button" className="btn btn-quiet call-list-go is-secondary" aria-label={`Log ${company}`} onClick={onReveal}>
          Log
        </button>
      </div>
      {item.backNote ? <p className="call-list-back">{item.backNote}</p> : null}
      {open && extraLabel && (
        <details className="call-list-extra">
          <summary className="call-list-fold">{extraLabel}</summary>
          {voicemail ? <p>{voicemail}</p> : null}
          {ask ? <p>{ask}</p> : null}
        </details>
      )}
      {open && saving && <p className="call-list-saving">Saving…</p>}
      {open && error && <p className="call-list-row-error" role="alert">{error}</p>}
      {open && !saving && (
        <div className="call-list-outcomes">
          {ordinary.map((outcome) => (
            <button
              key={outcome}
              type="button"
              className="btn btn-quiet"
              onClick={() => onArm(item, outcome)}
            >
              {CALL_OUTCOME_LABELS[outcome]}
            </button>
          ))}
          <div className="call-list-hold">
            <button type="button" className="btn call-list-caution" onClick={() => onArm(item, caution)}>
              {CALL_OUTCOME_LABELS[caution]}
            </button>
          </div>
        </div>
      )}
    </li>
  );
}
