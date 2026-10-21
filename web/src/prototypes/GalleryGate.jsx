import { lazy, Suspense, useEffect } from 'react';
import NotFound from '../NotFound';
import { FF_PROTOTYPE_GALLERY, flagEnabled } from '../flags';
import { useLoadFeatureFlags } from '../remote-flags';
import { galleryTokenOk } from './route';

const GalleryApp = lazy(() => import('./GalleryApp.jsx'));

function useNoindex() {
  useEffect(() => {
    const meta = document.createElement('meta');
    meta.name = 'robots';
    meta.content = 'noindex, nofollow';
    document.head.appendChild(meta);
    return () => meta.remove();
  }, []);
}

export default function GalleryGate({ route }) {
  useNoindex();
  useLoadFeatureFlags();
  const open = flagEnabled(FF_PROTOTYPE_GALLERY) && galleryTokenOk(route?.token);
  if (!open) return <NotFound />;
  return (
    <Suspense fallback={<main className="demo"><p className="demo-loading">Loading sample data…</p></main>}>
      <GalleryApp token={route.token} />
    </Suspense>
  );
}
