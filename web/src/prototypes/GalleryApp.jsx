import { useEffect, useMemo, useState } from 'react';
import { buildDemo } from '../demo/fixture.js';
import { EstimateRecoveryFlow } from '../demo/EstimateRecovery';
import { SampleTag } from '../components/PrototypeWatermark';
import { presentBrand } from './brand';
import { HOSTILE_BRAND, TEST_BRAND } from './fixture-brand';
import PrototypeLayout from './PrototypeLayout';
import { followGalleryLink, galleryHref, galleryRouteFromPath } from './route';

function brandFromSearch(search) {
  const fixture = new URLSearchParams(String(search || '')).get('fixture');
  return presentBrand(fixture === 'hostile' ? HOSTILE_BRAND : TEST_BRAND);
}

function useGalleryLocation() {
  const [loc, setLoc] = useState(() => ({
    pathname: window.location.pathname,
    search: window.location.search,
  }));
  useEffect(() => {
    const sync = () => setLoc({
      pathname: window.location.pathname,
      search: window.location.search,
    });
    window.addEventListener('popstate', sync);
    return () => window.removeEventListener('popstate', sync);
  }, []);
  return loc;
}

export default function GalleryApp({ token }) {
  const loc = useGalleryLocation();
  const brand = useMemo(() => brandFromSearch(loc.search), [loc.search]);
  const screen = galleryRouteFromPath(loc.pathname)?.screen ?? 'unknown';

  useEffect(() => {
    const previous = document.title;
    document.title = `${brand.name} prototype`;
    return () => { document.title = previous; };
  }, [brand.name]);

  return (
    <PrototypeLayout brand={brand}>
      {screen === 'estimate-follow-up' && (
        <EstimateFollowUp token={token} search={loc.search} brand={brand} />
      )}
      {screen === 'index' && <GalleryIndex token={token} search={loc.search} />}
      {screen === 'unknown' && <UnknownPrototype />}
    </PrototypeLayout>
  );
}

function GalleryIndex({ token, search }) {
  const href = galleryHref(token, 'estimate-follow-up', search);
  return (
    <main id="prototype-main" className="prototype-index">
      <p className="demo-kicker">Simulated prototypes</p>
      <h1>Prototype gallery</h1>
      <p className="muted demo-lead">
        These screens are simulated previews on fictional jobs. They are not a live system, nothing is sent, and the sample shop has not endorsed them.
      </p>
      <article className="prototype-card">
        <h2>Estimate follow-up <SampleTag /></h2>
        <p>
          A walkthrough of unsold-estimate recovery for this brand. No email, text, or call goes out.
        </p>
        <a className="prototype-open" href={href} onClick={(event) => followGalleryLink(event, href)}>
          Open estimate follow-up
        </a>
      </article>
    </main>
  );
}

function EstimateFollowUp({ token, search, brand }) {
  const demo = useMemo(() => buildDemo({ company: brand.name }), [brand.name]);
  const back = galleryHref(token, 'index', search);
  return (
    <main id="prototype-main" className="demo prototype-demo">
      <a className="prototype-back" href={back} onClick={(event) => followGalleryLink(event, back)}>
        All prototypes
      </a>
      <EstimateRecoveryFlow demo={demo} />
    </main>
  );
}

function UnknownPrototype() {
  return (
    <main id="prototype-main">
      <h1>Prototype not in this build</h1>
      <p className="muted">That agent preview is not available. Nothing was sent.</p>
    </main>
  );
}
