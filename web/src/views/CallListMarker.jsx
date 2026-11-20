import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { applyMarkerResponse, callListErrorMessage, readCallListKind } from './call-list';

export default function CallListMarker({ lead, onLead }) {
  const [enabled, setEnabled] = useState(false);
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const busyRef = useRef(false);

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
    busyRef.current = true;
    setBusy(true);
    setError('');
    try {
      const result = await work();
      onLead(applyMarkerResponse(lead, result, fallbackKind));
      setMessage(success);
    } catch (err) {
      setMessage('');
      setError(callListErrorMessage(err));
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }

  return (
    <section className="block call-list-marker" aria-labelledby="call-list-marker-heading">
      <h3 id="call-list-marker-heading">Add to call list</h3>
      {keptOff && <p className="call-list-hint">Kept off call list</p>}
      {onList && (
        <p className="call-list-hint">{marker.kind === 'walk_in' ? 'On the walk-in list.' : 'On the call list.'}</p>
      )}
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
