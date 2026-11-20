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
import { noteLeadStage } from './lead-stage';

function rowKey(item) {
  return String(item?.prospect_id ?? 'row');
}

function neighborIds(list, id) {
  const index = list.findIndex((row) => sameId(row, id));
  if (index < 0) return { next: null, prev: null };
  const next = list[index + 1];
  const prev = list[index - 1];
  return {
    next: next ? String(next.prospect_id) : null,
    prev: prev ? String(prev.prospect_id) : null,
  };
}

function focusFellToBody(active) {
  return !active
    || active === document.body
    || active === document.documentElement
    || active.isConnected === false;
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
  const listGeneration = useRef(0);
  const listRequest = useRef(0);
  const pendingRef = useRef(new Map());
  const savingRef = useRef(saving);
  const commitRef = useRef(async () => {});
  const clockRef = useRef(null);
  const openRowRef = useRef(null);
  const cardMap = useRef(new Map());
  const heldFocusRef = useRef(new Set());
  const focusMoveRef = useRef(null);
  const headingRef = useRef(null);
  const rowsRef = useRef(rows);
  rowsRef.current = rows;
  savingRef.current = saving;

  function onCard(id, node) {
    const key = String(id ?? '');
    if (!key) return;
    if (node) cardMap.current.set(key, node);
    else cardMap.current.delete(key);
  }

  function rememberHeldFocus(id) {
    const key = String(id);
    const card = cardMap.current.get(key);
    const active = document.activeElement;
    if (card && active && card.contains(active)) heldFocusRef.current.add(key);
    else heldFocusRef.current.delete(key);
  }

  function scrollOpenRow() {
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
    try { openRowRef.current?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' }); } catch { /* jsdom */ }
  }

  useEffect(() => {
    onActiveChange?.(phase === 'ready' || phase === 'error');
  }, [phase, onActiveChange]);

  useEffect(() => {
    let live = true;
    const generation = listGeneration.current;
    const request = ++listRequest.current;
    api.todayCallList().then((data) => {
      if (!live || generation !== listGeneration.current || request !== listRequest.current) return;
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
      if (!live || generation !== listGeneration.current || request !== listRequest.current) return;
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
    const key = String(entry.id);
    const held = heldFocusRef.current.has(key);
    heldFocusRef.current.delete(key);
    const neighbors = neighborIds(rowsRef.current, key);
    if (alive.current) setSaving((current) => new Set(current).add(entry.id));
    try {
      const result = await api.recordCallOutcome(entry.id, { outcome: entry.outcome, kind: entry.kind });
      if (typeof result?.stage === 'string' && result.stage) noteLeadStage(entry.id, result.stage);
      listGeneration.current += 1;
      if (!alive.current) return;
      const back = backOnLabel(result?.back_on);
      if (result?.removed && !back && held) {
        focusMoveRef.current = { id: key, next: neighbors.next, prev: neighbors.prev };
      }
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
      rememberHeldFocus(id);
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
    if (!/^\d{1,9}$/.test(id)) return false;
    if (pendingRef.current.has(id) || savingRef.current.has(id)) return false;
    const timer = setTimeout(() => {
      const entry = pendingRef.current.get(id);
      if (!entry) return;
      rememberHeldFocus(id);
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
    return true;
  }

  async function showAll() {
    if (moreBusy || expanded) return;
    const generation = listGeneration.current;
    const request = ++listRequest.current;
    setMoreBusy(true);
    try {
      const data = await api.todayCallList({ all: true });
      if (!alive.current || generation !== listGeneration.current || request !== listRequest.current) return;
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
      if (!alive.current || generation !== listGeneration.current || request !== listRequest.current) return;
      setListError({ message: callListErrorMessage(error) });
    } finally {
      if (alive.current) setMoreBusy(false);
    }
  }

  function undo(id) {
    const entry = pendingRef.current.get(id);
    if (!entry) return false;
    clearTimeout(entry.timer);
    pendingRef.current.delete(id);
    heldFocusRef.current.delete(String(id));
    setUndoTick((n) => n + 1);
    return true;
  }

  useEffect(() => {
    const move = focusMoveRef.current;
    if (!move) return;
    if (rows.some((row) => sameId(row, move.id))) return;
    focusMoveRef.current = null;
    const active = document.activeElement;
    const card = cardMap.current.get(move.id);
    const inside = !!(card && active && card.contains(active));
    if (!inside && !focusFellToBody(active)) return;
    const nextId = [move.next, move.prev].find((id) => id && rows.some((row) => sameId(row, id)));
    const button = nextId ? cardMap.current.get(nextId)?.querySelector('button') : null;
    try { (button || headingRef.current)?.focus(); } catch { /* jsdom */ }
  }, [rows]);

  if (phase === 'loading' || phase === 'off') return null;

  const caution = CALL_OUTCOMES[CALL_OUTCOMES.length - 1];
  const ordinary = CALL_OUTCOMES.slice(0, -1);

  return (
    <section className="panel call-list-panel" aria-labelledby="call-list-heading">
      <h2 id="call-list-heading" tabIndex={-1} ref={headingRef}>Calls due / Walk-ins</h2>
      <p className="panel-note">Taps open your phone or Maps. Nothing is sent from here.</p>
      {listError && <ErrorNote error={listError} onRetry={() => setTick((n) => n + 1)} />}
      {rows.length === 0 && !listError && <p className="empty">{EMPTY_CALL_LIST}</p>}
      {rows.length > 0 && (
        <ul className="call-list-list">
          {rows.map((item) => (
            <CallListRow
              key={rowKey(item)}
              item={item}
              openLead={openLead}
              pending={pendingRef.current.get(String(item.prospect_id)) || null}
              saving={saving.has(String(item.prospect_id))}
              error={rowErrors.get(String(item.prospect_id)) || ''}
              open={openId === String(item.prospect_id)}
              rowRef={openId === String(item.prospect_id) ? openRowRef : null}
              onCard={onCard}
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

function CallListRow({ item, openLead, pending, saving, error, open, rowRef, onCard, onReveal, onArm, onUndo, ordinary, caution }) {
  const company = item.company || 'Lead';
  const [scriptOpen, setScriptOpen] = useState(false);
  const cardRef = useRef(null);
  const undoButtonRef = useRef(null);
  const logButtonRef = useRef(null);
  const swapRef = useRef(false);
  const cardPublish = useRef({ onCard, rowRef, id: item?.prospect_id });
  cardPublish.current = { onCard, rowRef, id: item?.prospect_id };
  const setCard = useRef((node) => {
    cardRef.current = node;
    const publish = cardPublish.current;
    publish.onCard(publish.id, node);
    if (publish.rowRef) publish.rowRef.current = node;
  }).current;
  if (rowRef && cardRef.current) rowRef.current = cardRef.current;

  useEffect(() => {
    const active = document.activeElement;
    const card = cardRef.current;
    const inside = !!(card && active && card.contains(active));
    // Set in the outcome or Undo click, before that button unmounts.
    // A countdown, a refresh, and the card's first paint do not set it.
    const fell = swapRef.current && focusFellToBody(active);
    swapRef.current = false;
    if (!inside && !fell) return;
    if (pending) {
      try { undoButtonRef.current?.focus(); } catch { /* jsdom */ }
      try { card?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' }); } catch { /* jsdom */ }
      return;
    }
    try { logButtonRef.current?.focus(); } catch { /* jsdom */ }
  }, [pending]);

  function armFromTap(outcome) {
    swapRef.current = true;
    if (onArm(item, outcome) !== true) swapRef.current = false;
  }

  function undoFromTap() {
    swapRef.current = true;
    if (onUndo(pending.id) !== true) swapRef.current = false;
  }

  if (item.settledBackOn) {
    return (
      <li className="call-list-card call-list-settled" ref={setCard}>
        <p className="call-list-company-text">{company}</p>
        <p className="call-list-back">{item.settledBackOn}</p>
      </li>
    );
  }

  if (pending) {
    const label = CALL_OUTCOME_LABELS[pending.outcome] || 'Outcome';
    return (
      <li className="call-list-card" ref={setCard}>
        <div className="call-list-undo">
          <p className="call-list-company-text">{company}</p>
          <p role="status">{`${label}. Undo to cancel.`}</p>
          <button type="button" className="btn" ref={undoButtonRef} aria-live="off" onClick={undoFromTap}>
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
    <li className={`call-list-card${open ? ' is-open' : ''}`} ref={setCard}>
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
        <button type="button" ref={logButtonRef} className="btn btn-quiet call-list-go is-secondary" aria-label={`Log ${company}`} onClick={onReveal}>
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
              onClick={() => armFromTap(outcome)}
            >
              {CALL_OUTCOME_LABELS[outcome]}
            </button>
          ))}
          <div className="call-list-hold">
            <button type="button" className="btn call-list-caution" onClick={() => armFromTap(caution)}>
              {CALL_OUTCOME_LABELS[caution]}
            </button>
          </div>
        </div>
      )}
    </li>
  );
}
