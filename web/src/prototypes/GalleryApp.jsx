import '@fontsource/barlow/latin-600.css';
import { useEffect, useMemo, useState } from 'react';
import { buildDemo } from '../demo/fixture.js';
import { EstimateRecoveryFlow } from '../demo/EstimateRecovery';
import { SampleTag } from '../components/PrototypeWatermark';
import { presentBrand } from './brand';
import { HOSTILE_BRAND, NAVY_BRAND, TEST_BRAND, YELLOW_BRAND } from './fixture-brand';
import { BookkeepingPrototype, CallPrototype, SchedulingPrototype } from './agents';
import PrototypeLayout from './PrototypeLayout';
import { followGalleryLink, galleryHref, galleryRouteFromPath } from './route';

const FIXTURES = {
  hostile: HOSTILE_BRAND,
  yellow: YELLOW_BRAND,
  navy: NAVY_BRAND,
};

function brandFromSearch(search) {
  const fixture = new URLSearchParams(String(search || '')).get('fixture');
  return presentBrand(FIXTURES[fixture] || TEST_BRAND);
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
      {screen === 'scheduling' && <SchedulingPrototype />}
      {screen === 'call' && <CallPrototype />}
      {screen === 'bookkeeping' && <BookkeepingPrototype />}
      {screen === 'index' && <GalleryIndex token={token} search={loc.search} />}
      {screen === 'unknown' && <UnknownPrototype />}
    </PrototypeLayout>
  );
}

const AGENTS = [
  ['estimate-follow-up', 'Estimate follow-up', 'Open estimate follow-up', 'Emails from the owner mailbox. The sequence stops if the customer replies. A call appears only as a reminder to the owner.'],
  ['scheduling', 'Scheduling', 'Open scheduling', 'Sample visit slots for a fictional homeowner. Nothing is written to a calendar.'],
  ['call', 'Call', 'Open call', 'A missed-call card and a draft text-back. Nothing is dialed.'],
  ['bookkeeping', 'Bookkeeping', 'Open bookkeeping', 'Sample receipts from fictional vendors. Sync stays on this page.'],
];

function GalleryIndex({ token, search }) {
  return (
    <main id="prototype-main" className="prototype-index">
      <p className="demo-kicker">Simulated prototypes</p>
      <h1>Prototype gallery</h1>
      <p className="muted demo-lead">
        These screens are simulated previews on fictional jobs. They are not a live system, nothing is sent, and the sample shop has not endorsed them.
      </p>
      {AGENTS.map(([screen, title, label, body]) => {
        const href = galleryHref(token, screen, search);
        return (
          <article className="prototype-card" key={screen}>
            <h2>{title} <SampleTag /></h2>
            <p>{body}</p>
            <a className="prototype-open" href={href} onClick={(event) => followGalleryLink(event, href)}>
              {label}
            </a>
          </article>
        );
      })}
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
