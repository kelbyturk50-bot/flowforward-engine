import { lazy, Suspense } from 'react';
import NotFound from '../NotFound';
import { FF_LIVE_CHAT_DEMO, FF_PROTOTYPE_GALLERY, previewFlagsOverride } from '../flags';

// Local sources only. previewFlagsOverride is the dev or preview-build ?flags=
// query (and the session value it stored) on an allowed host. Anything else,
// including the remote GET /api/flags snapshot, stays off. Production builds
// ignore that query on every host. There is no public read-only flag source
// yet, so this route renders the not-found view in production.
const LiveChatDemo = lazy(() => import('./LiveChatDemo.jsx'));

function previewFlagOn(name) {
  const override = previewFlagsOverride();
  return override?.[name] === true;
}

export default function LiveChatGate() {
  const open = previewFlagOn(FF_PROTOTYPE_GALLERY) && previewFlagOn(FF_LIVE_CHAT_DEMO);
  if (!open) return <NotFound />;
  return (
    <Suspense fallback={<main className="demo"><p className="demo-loading">Loading sample data…</p></main>}>
      <LiveChatDemo />
    </Suspense>
  );
}
