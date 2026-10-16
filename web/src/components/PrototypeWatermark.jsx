// Shared prototype chrome. Ochre's spec doc may replace the styling later;
// keep the ribbon, tile, Sample tag, footer, and action toast in this file.
// The ribbon copy is fixed. Props, flags, query params, and brand data cannot hide it.
// Brand color is never applied here.

import { createContext, useContext, useEffect, useState } from 'react';

export const WATERMARK_TEXT = 'PROTOTYPE, not live. FlowForward can make this real in days.';
export const ACTION_TOAST = 'Prototype, nothing was sent';
export const FOOTER_LEAD = 'Concept by FlowForward, not affiliated with or endorsed by ';

export const WATERMARK_BG = '#1E2A2F';
export const WATERMARK_FG = '#FFFFFF';

// Literal colors only. Brand CSS variables must not be able to restyle the ribbon.
export const RIBBON_STYLE = {
  position: 'sticky',
  top: 0,
  zIndex: 2147483000,
  display: 'block',
  visibility: 'visible',
  opacity: 1,
  flexShrink: 0,
  backgroundColor: WATERMARK_BG,
  color: WATERMARK_FG,
  WebkitTextFillColor: WATERMARK_FG,
  boxShadow: 'none',
  filter: 'none',
  mixBlendMode: 'normal',
  transform: 'none',
  margin: 0,
  padding: '10px 12px',
  minHeight: '44px',
  width: '100%',
  maxWidth: 'none',
  overflow: 'visible',
  pointerEvents: 'none',
  textAlign: 'center',
  fontFamily: 'Barlow, system-ui, sans-serif',
  fontSize: '14px',
  fontWeight: 700,
  lineHeight: 1.35,
  letterSpacing: '0.01em',
};

const PrototypeActionContext = createContext(null);
const PrototypeChromeContext = createContext(false);

export function usePrototypeNotify() {
  return useContext(PrototypeActionContext);
}

export function usePrototypeChrome() {
  return useContext(PrototypeChromeContext);
}

export function SampleTag() {
  return <span className="prototype-sample" aria-hidden="true">Sample</span>;
}

export function SampleValue({ children }) {
  const on = usePrototypeChrome();
  if (!on) return children;
  return (
    <span className="prototype-value">
      {children}
      <SampleTag />
    </span>
  );
}

export function PrototypeFooter({ business }) {
  return (
    <p className="prototype-footer">
      {FOOTER_LEAD}<span className="prototype-business">{business}</span>
      <SampleTag />
    </p>
  );
}

export default function PrototypeWatermark() {
  return (
    <p
      className="prototype-ribbon"
      role="note"
      aria-label={WATERMARK_TEXT}
      data-prototype-watermark="true"
      data-prototype-ribbon="true"
      style={RIBBON_STYLE}
    >
      {WATERMARK_TEXT}
    </p>
  );
}

export function PrototypeShell({ brandName, accent, children }) {
  const [message, setMessage] = useState('');

  useEffect(() => {
    if (!message) return undefined;
    const id = window.setTimeout(() => setMessage(''), 4000);
    return () => window.clearTimeout(id);
  }, [message]);

  return (
    <PrototypeChromeContext.Provider value={true}>
      <PrototypeActionContext.Provider value={setMessage}>
        <div className="prototype-root">
          <a className="skip" href="#prototype-main">Skip to content</a>
          <PrototypeWatermark />
          <div className="prototype-scroll">
            <div
              className="prototype-screen prototype-tile"
              data-brand-accent={accent}
              style={{ '--proto-accent': accent }}
            >
              {children}
              <PrototypeFooter business={brandName} />
            </div>
          </div>
          {message ? (
            <p className="prototype-toast" role="status">{message}</p>
          ) : null}
        </div>
      </PrototypeActionContext.Provider>
    </PrototypeChromeContext.Provider>
  );
}
