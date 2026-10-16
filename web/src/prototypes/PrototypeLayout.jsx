import { PrototypeShell, SampleTag } from '../components/PrototypeWatermark';
import { BUNDLED_LOGO_ID } from './brand';
import CtaPanel from './CtaPanel';
import { BrandMark } from './logo';

// Shared chrome for every prototype screen. The ribbon is not optional.
export default function PrototypeLayout({ brand, children }) {
  const accent = brand.theme.accent;
  const onAccent = brand.theme.onAccent;
  return (
    <PrototypeShell brandName={brand.name} accent={accent} onAccent={onAccent}>
      <div className="prototype-frame">
        <div className="prototype-column">
          <header className="prototype-brandbar">
            {brand.logoUrl === BUNDLED_LOGO_ID ? (
              <BrandMark logoUrl={brand.logoUrl} plate={brand.logoPlate} />
            ) : (
              <span
                className="prototype-wordmark"
                style={{ backgroundColor: accent, color: onAccent }}
              >
                {brand.name}
              </span>
            )}
            <p
              className="prototype-brand-name"
              style={{ backgroundColor: accent, color: onAccent }}
            >
              <span>{brand.name}</span>
              <SampleTag>Sample business</SampleTag>
            </p>
          </header>
          {children}
        </div>
        <CtaPanel />
      </div>
    </PrototypeShell>
  );
}
