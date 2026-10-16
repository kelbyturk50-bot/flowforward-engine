import { BUNDLED_LOGO_ID } from './brand';

// Synthetic mark for the bundled TEST fixture. It is not a prospect logo.
export function TestWasatchMark() {
  return (
    <svg className="prototype-logo" viewBox="0 0 64 64" aria-hidden="true">
      <rect width="64" height="64" rx="14" fill="#1F4E79" />
      <path d="M8 46 L22 18 L32 32 L42 16 L56 46 Z" fill="#F4F7FB" />
      <path d="M8 50 H56" stroke="#C47B2B" strokeWidth="4" strokeLinecap="round" />
    </svg>
  );
}

export function BrandMark({ logoUrl, plate = 'none' }) {
  if (logoUrl !== BUNDLED_LOGO_ID) return null;
  const mark = <TestWasatchMark />;
  if (plate === 'slate' || plate === 'paper') {
    return <span className={`prototype-logo-plate is-${plate}`}>{mark}</span>;
  }
  return mark;
}
