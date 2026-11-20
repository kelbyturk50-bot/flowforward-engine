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
  const [saving, setSaving] = useState(() => new Set());
  const [rowErrors, setRowErrors] = useState(() => new Map());
  const knownOn = useRef(false);
  const alive = useRef(true);
  const pendingRef = useRef(new Map());
  const savingRef = useRef(saving);
  const commitRef = useRef(async () => {});
  savingRef.current = saving;

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
    function onHide() {
      if (document.visibilityState === 'hidden') flushAll();
    }
    function onPageHide() { flushAll(); }
    alive.current = true;
    document.addEventListener('visibilitychange', onHide);
    window.addEventListener('pagehide', onPageHide);
    return () => {
      document.removeEventListener('visibilitychange', onHide);
      window.removeEventListener('pagehide', onPageHide);
      alive.current = false;
      flushAll();
    };
  }, []);

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
    });
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
      <p className="panel-note">A call opens your phone. A map opens Google Maps. Nothing is sent from here.</p>
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

function CallListRow({ item, openLead, pending, saving, error, onArm, onUndo, ordinary, caution }) {
  const company = item.company || 'Lead';
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
        <div className="call-list-undo" role="status">
          <p className="call-list-company-text">{company}</p>
          <p>{`${label}. Undo to cancel.`}</p>
          <button type="button" className="btn" onClick={() => onUndo(pending.id)}>
            {`Undo ${label}`}
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
  const phone = typeof item.phone === 'string' ? item.phone.trim() : '';

  return (
    <li className="call-list-card">
      <div className="call-list-top">
        <button type="button" className="call-list-company" onClick={() => openLead(Number(item.prospect_id))}>
          {company}
        </button>
        <span className={`call-list-badge ${item.kind === 'walk_in' ? 'is-walk' : 'is-call'}`}>
          {item.kind === 'walk_in' ? 'Walk-in' : 'Call'}
        </span>
      </div>
      {item.reason ? <p className="call-list-reason">{item.reason}</p> : null}
      {tel && (
        <a className="btn call-list-action" href={tel}>
          {phone ? `Call ${phone}` : 'Call'}
        </a>
      )}
      {maps && (
        <a className="btn btn-quiet call-list-action" href={maps} target="_blank" rel="noreferrer">
          Map
        </a>
      )}
      {script ? <p className="call-list-script">{script}</p> : null}
      {item.backNote ? <p className="call-list-back">{item.backNote}</p> : null}
      {extraLabel && (
        <details className="call-list-extra">
          <summary className="call-list-fold">{extraLabel}</summary>
          {voicemail ? <p>{voicemail}</p> : null}
          {ask ? <p>{ask}</p> : null}
        </details>
      )}
      {saving && <p className="call-list-saving">Saving…</p>}
      {error && <p className="call-list-row-error" role="alert">{error}</p>}
      {!saving && (
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
