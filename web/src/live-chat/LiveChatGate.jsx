import { lazy, Suspense, useEffect, useState } from 'react';
import NotFound from '../NotFound';
import { FF_LIVE_CHAT_DEMO, FF_PROTOTYPE_GALLERY, previewFlagsOverride } from '../flags';
import { publicFlagsOpen, readPublicFlags } from './public-flags.js';

const LiveChatDemo = lazy(() => import('./LiveChatDemo.jsx'));
const LiveChatConnected = lazy(() => import('./LiveChatConnected.jsx'));

function previewFlagOn(name) {
  const override = previewFlagsOverride();
  return override?.[name] === true;
}

function Loading() {
  return <main className="demo"><p className="demo-loading">Loading sample data…</p></main>;
}

// Production reads the public flags and then the chat API. A dev server or a
// Vercel preview does not call the API: both preview flags open the local
// fixture, and a token URL stays not-found. Preview hosts are not an API path.
export default function LiveChatGate({ token = '', malformed = false }) {
  const [phase, setPhase] = useState(malformed ? 'closed' : 'loading');

  useEffect(() => {
    if (malformed) return undefined;
    const preview = !token && previewFlagOn(FF_PROTOTYPE_GALLERY) && previewFlagOn(FF_LIVE_CHAT_DEMO);
    if (preview) {
      setPhase('fixture');
      return undefined;
    }
    let cancelled = false;
    readPublicFlags().then((flags) => {
      if (cancelled) return;
      setPhase(publicFlagsOpen(flags) ? 'live' : 'closed');
    });
    return () => { cancelled = true; };
  }, [token, malformed]);

  if (phase === 'loading') return <Loading />;
  if (phase === 'closed') return <NotFound />;
  if (phase === 'fixture') {
    return (
      <Suspense fallback={<Loading />}>
        <LiveChatDemo />
      </Suspense>
    );
  }
  return (
    <Suspense fallback={<Loading />}>
      <LiveChatConnected kind={token ? 'prototype' : 'sample'} token={token} />
    </Suspense>
  );
}
