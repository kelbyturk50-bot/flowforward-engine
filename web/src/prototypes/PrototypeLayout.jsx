import { PrototypeShell, SampleTag } from '../components/PrototypeWatermark';
import { BrandMark } from './logo';

// Shared chrome for every prototype screen. The ribbon is not optional.
export default function PrototypeLayout({ brand, children }) {
  return (
    <PrototypeShell brandName={brand.name} accent={brand.theme.accent}>
      <header className="prototype-brandbar">
        <BrandMark logoUrl={brand.logoUrl} />
        <p className="prototype-brand-name">
          <span>{brand.name}</span>
          <SampleTag />
        </p>
      </header>
      {children}
    </PrototypeShell>
  );
}
