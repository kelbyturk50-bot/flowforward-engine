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

// Public flags decide the live chat. The preview ?flags= override still opens
// the local fixture, and only when it is the reason the page is open: the
// public flags were not both true. That path makes no chat request.
export default function LiveChatGate({ token = '', malformed = false }) {
  const [phase, setPhase] = useState(malformed ? 'closed' : 'loading');

  useEffect(() => {
    if (malformed) return undefined;
    let cancelled = false;
    readPublicFlags().then((flags) => {
      if (cancelled) return;
      if (publicFlagsOpen(flags)) {
        setPhase('live');
        return;
      }
      const preview = !token && previewFlagOn(FF_PROTOTYPE_GALLERY) && previewFlagOn(FF_LIVE_CHAT_DEMO);
      setPhase(preview ? 'fixture' : 'closed');
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
