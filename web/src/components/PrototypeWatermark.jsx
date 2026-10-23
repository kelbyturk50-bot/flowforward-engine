// Shared prototype chrome. The gallery flag can hide the gallery.
// Nothing in props, flags, query params, or brand data can hide this watermark.
// The CRM entry already self-hosts Barlow 600. This chunk-local face is what
// keeps the prototype CSS pointing at it after Vite dedupes the shared import.
// The system font is the fallback.
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
  const rest = raw.replace(/^test:\s*/i, '').trim();
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

// Inline !important colors beat any author stylesheet, including a more
// specific !important rule. Print cannot override them from CSS, so the
// ribbon swaps these values when the page is printing.
const RIBBON_SCREEN_COLORS = {
  background: '#1E2A2F',
  color: '#F3F6F5',
  '-webkit-text-fill-color': '#F3F6F5',
  border: '0',
};

const RIBBON_PRINT_COLORS = {
  background: '#FFFFFF',
  color: '#1E2A2F',
  '-webkit-text-fill-color': '#1E2A2F',
  border: '2px solid #1E2A2F',
};

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
  const label = WATERMARK_TEXT;
  const ref = useRibbonColorLock();
  return (
    <p
      ref={ref}
      className="prototype-ribbon"
      role="note"
      aria-label={label}
      data-prototype-watermark="true"
      data-prototype-ribbon="true"
      style={RIBBON_STYLE}
    >
      {label}
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

// Screen colors stay inline. Print colors replace them while matchMedia('print')
// matches, and while the browser is in beforeprint. The ribbon stays rendered.
function useRibbonColorLock() {
  const ref = useRef(null);
  useLayoutEffect(() => {
    const node = ref.current;
    if (!node) return undefined;
    lockStyle(node, RIBBON_IMPORTANT);
    const media = window.matchMedia('print');
    const apply = (printing) => {
      lockStyle(node, printing ? RIBBON_PRINT_COLORS : RIBBON_SCREEN_COLORS);
    };
    const sync = () => apply(media.matches);
    const onBeforePrint = () => apply(true);
    const onAfterPrint = () => apply(media.matches);
    sync();
    media.addEventListener('change', sync);
    window.addEventListener('beforeprint', onBeforePrint);
    window.addEventListener('afterprint', onAfterPrint);
    return () => {
      media.removeEventListener('change', sync);
      window.removeEventListener('beforeprint', onBeforePrint);
      window.removeEventListener('afterprint', onAfterPrint);
    };
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
