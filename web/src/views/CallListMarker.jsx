import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { applyMarkerResponse, callListErrorMessage, readCallListKind } from './call-list';

const ON_LIST_LINE = Object.freeze({
  call: 'On your call list \u00B7 Call',
  walk_in: 'On your call list \u00B7 Walk-in',
});

function leadKey(lead) {
  return lead?.id == null ? '' : String(lead.id);
}

export default function CallListMarker({ lead, onLead }) {
  const [enabled, setEnabled] = useState(false);
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const busyRef = useRef(false);
  const alive = useRef(true);
  const leadIdRef = useRef('');
  leadIdRef.current = leadKey(lead);

  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);

  useEffect(() => {
    let live = true;
    setReady(false);
    api.todayCallList().then((data) => {
      if (!live) return;
      setEnabled(data?.enabled === true);
      setReady(true);
    }).catch(() => {
      if (!live) return;
      setEnabled(false);
      setReady(true);
    });
    return () => { live = false; };
  }, [lead?.id]);

  if (!ready || !enabled || !lead) return null;

  const marker = readCallListKind(lead);
  if (!marker.present) return null;
  const onList = marker.kind === 'call' || marker.kind === 'walk_in';
  const keptOff = marker.kind === 'excluded';

  async function run(work, fallbackKind, success) {
    if (busyRef.current) return;
    const id = leadKey(lead);
    busyRef.current = true;
    setBusy(true);
    setError('');
    try {
      const result = await work();
      if (!alive.current || leadIdRef.current !== id) return;
      onLead((current) => (
        current && String(current.id) === id
          ? applyMarkerResponse(current, result, fallbackKind)
          : current
      ));
      if (!alive.current) return;
      setMessage(success);
    } catch (err) {
      if (!alive.current) return;
      setMessage('');
      setError(callListErrorMessage(err));
    } finally {
      busyRef.current = false;
      if (alive.current) setBusy(false);
    }
  }

  return (
    <section className="block call-list-marker" aria-labelledby="call-list-marker-heading">
      <h3 id="call-list-marker-heading">{onList ? 'Call list' : 'Add to call list'}</h3>
      {keptOff && <p className="call-list-hint">Kept off call list</p>}
      {onList && <p className="call-list-hint">{ON_LIST_LINE[marker.kind]}</p>}
      <div className="call-list-marker-actions">
        <button
          type="button"
          className="btn"
          aria-pressed={marker.kind === 'call'}
          disabled={busy}
          onClick={() => run(() => api.saveCallListKind(lead.id, 'call'), 'call', 'Added to the call list.')}
        >
          Call
        </button>
        <button
          type="button"
          className="btn btn-quiet"
          aria-pressed={marker.kind === 'walk_in'}
          disabled={busy}
          onClick={() => run(() => api.saveCallListKind(lead.id, 'walk_in'), 'walk_in', 'Added to the walk-in list.')}
        >
          Walk-in
        </button>
      </div>
      {onList && (
        <>
          <button
            type="button"
            className="btn btn-quiet"
            disabled={busy}
            onClick={() => run(() => api.removeCallList(lead.id), 'excluded', 'Kept off the call list.')}
          >
            Keep off call list
          </button>
          <p className="call-list-hint">Won&apos;t come back unless they view the demo</p>
        </>
      )}
      {message && <p className="call-list-feedback" role="status">{message}</p>}
      {error && <p className="call-list-row-error" role="alert">{error}</p>}
    </section>
  );
}
