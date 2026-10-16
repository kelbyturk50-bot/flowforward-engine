import PrototypeWatermark from '../components/PrototypeWatermark';
import { BrandMark } from './logo';

// Shared chrome for every prototype screen. The watermark is not optional.
export default function PrototypeLayout({ brand, children }) {
  const theme = brand.theme;
  return (
    <div className="prototype-root">
      <PrototypeWatermark />
      <a className="skip" href="#prototype-main">Skip to content</a>
      <div
        className="prototype-screen"
        data-brand-primary={theme.primary}
        data-brand-on-primary={theme.onPrimary}
        style={{
          '--proto-primary': theme.primary,
          '--proto-on-primary': theme.onPrimary,
          '--proto-accent': theme.accent,
          '--proto-ink': theme.ink,
        }}
      >
        <header className="prototype-brandbar">
          <BrandMark logoUrl={brand.logoUrl} />
          <p className="prototype-brand-name">{brand.name}</p>
        </header>
        {children}
      </div>
    </div>
  );
}
