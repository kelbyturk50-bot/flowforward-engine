import { useRef, useState } from 'react';
import { OPENS_CAVEAT, formatRatePercent } from './metrics.js';

export function OpenInfo() {
  const [open, setOpen] = useState(false);
  const pinned = useRef(false);

  const show = () => setOpen(true);
  const hide = (event) => {
    if (pinned.current) return;
    if (event?.relatedTarget && event.currentTarget.contains(event.relatedTarget)) return;
    setOpen(false);
  };

  return (
    <span className="open-info" onMouseEnter={show} onMouseLeave={hide} onBlur={hide}>
      <button
        type="button"
        className="info-btn"
        aria-label="About open counts"
        aria-expanded={open}
        onClick={() => {
          pinned.current = !pinned.current;
          setOpen(pinned.current);
        }}
        onFocus={show}
      >
        <span aria-hidden="true">i</span>
      </button>
      {open && <span role="tooltip" className="open-tip">{OPENS_CAVEAT}</span>}
    </span>
  );
}

export default function RateCell({ k, d, noun, approximate = false, machineOpens = null }) {
  return (
    <div className="rate-cell">
      <b className="rate-pct">{formatRatePercent(k, d)}</b>
      <span className="rate-of">{k} of {d} {noun}</span>
      {d > 0 && d < 30 && <span className="directional">Directional (n{'<'}30)</span>}
      {approximate && (
        <span className="rate-approx">
          <span className="approx">Approximate</span>
          <OpenInfo />
        </span>
      )}
      {machineOpens != null && (
        <span className="machine-opens">
          <span className="machine-opens-label">Machine opens</span>
          <span className="machine-opens-count">{machineOpens}</span>
        </span>
      )}
    </div>
  );
}
