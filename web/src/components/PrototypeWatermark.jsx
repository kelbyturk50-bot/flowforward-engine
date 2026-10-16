// Stand-in for Ochre's watermark (#37). Ochre's component is not in the repo yet.
// The sentence is the copy from that issue. This file is flagged for Ochre's review.
// The label is fixed. Props, flags, query params, and brand data are ignored.

export const WATERMARK_TEXT = 'PROTOTYPE, not live. FlowForward can make this real in days.';

export const WATERMARK_BG = '#1E2A2F';
export const WATERMARK_FG = '#FFFFFF';
export const WATERMARK_EDGE = '#C9952F';

// Literal colors only. Brand CSS variables must not be able to restyle this.
export const WATERMARK_STYLE = {
  position: 'fixed',
  left: '8px',
  right: '8px',
  bottom: '8px',
  zIndex: 2147483000,
  display: 'block',
  visibility: 'visible',
  opacity: 1,
  backgroundColor: WATERMARK_BG,
  color: WATERMARK_FG,
  WebkitTextFillColor: WATERMARK_FG,
  border: `2px solid ${WATERMARK_EDGE}`,
  borderRadius: '10px',
  boxShadow: 'none',
  filter: 'none',
  mixBlendMode: 'normal',
  transform: 'none',
  padding: '10px 12px',
  margin: 0,
  minHeight: '44px',
  height: 'auto',
  width: 'auto',
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

export default function PrototypeWatermark() {
  return (
    <p
      className="prototype-watermark"
      role="note"
      data-prototype-watermark="true"
      style={WATERMARK_STYLE}
    >
      {WATERMARK_TEXT}
    </p>
  );
}
