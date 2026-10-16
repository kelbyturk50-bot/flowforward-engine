// Shared prototype chrome. The gallery flag can hide the gallery.
// Nothing in props, flags, query params, or brand data can hide this watermark.
// Barlow 600 latin stays in this module so the prototype chunk keeps the face
// even though the CRM entry also self-hosts Barlow. The system font is the fallback.
import '@fontsource/barlow/latin-600.css';
import '../prototypes/barlow-600.css';

import { createContext, useContext, useEffect, useLayoutEffect, useRef, useState } from 'react';

export const WATERMARK_TEXT = 'PROTOTYPE, not live. FlowForward can make this real in days.';
export const ACTION_TOAST = 'In the live version this would send the email.';

export function liveToast(action) {
  return `In the live version this would ${action}.`;
}
export const FOOTER_LEAD = 'Concept by FlowForward, sample data, not affiliated with or endorsed by ';
export const FOOTER_BUSINESS_FALLBACK = 'this business';

// A bare "TEST:" prefix is not a business name. The wordmark still shows it.
export function footerBusinessName(name) {
  const raw = String(name ?? '').trim();
  const rest = raw.replace(/^TEST:\s*/, '').trim();
  return rest ? raw : FOOTER_BUSINESS_FALLBACK;
}

export const WATERMARK_BG = '#1E2A2F';
export const WATERMARK_FG = '#F3F6F5';

// Diagonal PROTOTYPE tile, slate at 5% opacity. Painted above brand fills.
export const TILE_IMAGE = "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='168' height='96'%3E%3Ctext x='6' y='58' fill='%231E2A2F' fill-opacity='0.05' font-family='sans-serif' font-size='15' font-weight='700' transform='rotate(-30 84 48)'%3EPROTOTYPE%3C/text%3E%3C/svg%3E\")";

// Literal colors only. Brand CSS variables must not be able to restyle the ribbon.
export const RIBBON_STYLE = {
  position: 'sticky',
  top: 0,
  zIndex: 2147483000,
  display: 'block',
  visibility: 'visible',
  opacity: 1,
  flexShrink: 0,
  boxShadow: 'none',
  filter: 'none',
  mixBlendMode: 'normal',
  transform: 'none',
  margin: 0,
  padding: '6px 12px',
  paddingTop: 'calc(6px + env(safe-area-inset-top, 0px))',
  minHeight: 'calc(32px + env(safe-area-inset-top, 0px))',
  width: '100%',
  maxWidth: 'none',
  overflow: 'visible',
  pointerEvents: 'none',
  textAlign: 'center',
  fontFamily: 'Barlow, system-ui, sans-serif',
  fontSize: '14px',
  fontWeight: 600,
  lineHeight: 1.3,
  WebkitPrintColorAdjust: 'exact',
  printColorAdjust: 'exact',
};

// Color, background, and text-fill stay out of this lock. The stylesheet owns
// them, and the print rule has to be able to override them. An inline
// !important color would win over @media print.
const RIBBON_IMPORTANT = {
  position: 'sticky',
  top: '0',
  'z-index': '2147483000',
  display: 'block',
  visibility: 'visible',
  opacity: '1',
  'flex-shrink': '0',
  'box-shadow': 'none',
  filter: 'none',
  'mix-blend-mode': 'normal',
  transform: 'none',
  margin: '0',
  padding: '6px 12px',
  'padding-top': 'calc(6px + env(safe-area-inset-top, 0px))',
  'min-height': 'calc(32px + env(safe-area-inset-top, 0px))',
  width: '100%',
  'max-width': 'none',
  overflow: 'visible',
  'pointer-events': 'none',
  'text-align': 'center',
  'font-family': 'Barlow, system-ui, sans-serif',
  'font-size': '14px',
  'font-weight': '600',
  'line-height': '1.3',
  '-webkit-print-color-adjust': 'exact',
  'print-color-adjust': 'exact',
};

function lockStyle(node, declarations) {
  if (!node) return;
  for (const [prop, value] of Object.entries(declarations)) {
    node.style.setProperty(prop, value, 'important');
  }
}

const PrototypeActionContext = createContext(null);
const PrototypeChromeContext = createContext(false);

export function usePrototypeNotify() {
  return useContext(PrototypeActionContext);
}

export function usePrototypeChrome() {
  return useContext(PrototypeChromeContext);
}

export function SampleTag({ children = 'Sample' }) {
  return <span className="prototype-sample">{children}</span>;
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
      {FOOTER_LEAD}<span className="prototype-business">{footerBusinessName(business)}</span>.<SampleTag />
    </p>
  );
}

const TILE_IMPORTANT = {
  position: 'absolute',
  inset: '0',
  'z-index': '1',
  display: 'block',
  visibility: 'visible',
  opacity: '1',
  'pointer-events': 'none',
  'background-image': TILE_IMAGE,
  'background-size': '168px 96px',
  'background-repeat': 'repeat',
  '-webkit-print-color-adjust': 'exact',
  'print-color-adjust': 'exact',
};

export function PrototypeTile() {
  const ref = useLayoutEffectLock(TILE_IMPORTANT);
  return (
    <div
      ref={ref}
      className="prototype-tile"
      data-prototype-tile="true"
      aria-hidden="true"
      style={{
        position: 'absolute',
        inset: 0,
        zIndex: 1,
        pointerEvents: 'none',
        backgroundImage: TILE_IMAGE,
        backgroundSize: '168px 96px',
        backgroundRepeat: 'repeat',
        WebkitPrintColorAdjust: 'exact',
        printColorAdjust: 'exact',
      }}
    />
  );
}

export default function PrototypeWatermark() {
  const ref = useLayoutEffectLock(RIBBON_IMPORTANT);
  return (
    <p
      ref={ref}
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

function useLayoutEffectLock(declarations) {
  const ref = useRef(null);
  useLayoutEffect(() => {
    lockStyle(ref.current, declarations);
  });
  return ref;
}

export function PrototypeShell({ brandName, accent, onAccent, darkAccent, darkOnAccent, children }) {
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
          {message ? (
            <p className="prototype-toast" role="status">{message}</p>
          ) : null}
          <div className="prototype-scroll">
            <div
              className="prototype-screen"
              data-brand-accent={accent}
              data-on-accent={onAccent}
              data-brand-accent-dark={darkAccent || accent}
              data-on-accent-dark={darkOnAccent || onAccent}
              style={{
                '--proto-accent-light': accent,
                '--proto-on-accent-light': onAccent,
                '--proto-accent-dark': darkAccent || accent,
                '--proto-on-accent-dark': darkOnAccent || onAccent,
              }}
            >
              <PrototypeTile />
              <div className="prototype-foreground">
                {children}
                <PrototypeFooter business={brandName} />
              </div>
            </div>
          </div>
        </div>
      </PrototypeActionContext.Provider>
    </PrototypeChromeContext.Provider>
  );
}
