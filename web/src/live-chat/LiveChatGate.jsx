import { lazy, Suspense, useEffect } from 'react';
import NotFound from '../NotFound';
import { FF_LIVE_CHAT_DEMO, flagEnabled } from '../flags';
import { useLoadFeatureFlags } from '../remote-flags';

const LiveChatDemo = lazy(() => import('./LiveChatDemo.jsx'));

function useChatMeta() {
  useEffect(() => {
    const robots = document.createElement('meta');
    robots.name = 'robots';
    robots.content = 'noindex, nofollow';
    const referrer = document.createElement('meta');
    referrer.name = 'referrer';
    referrer.content = 'no-referrer';
    document.head.append(robots, referrer);
    return () => {
      robots.remove();
      referrer.remove();
    };
  }, []);
}

export default function LiveChatGate() {
  useChatMeta();
  useLoadFeatureFlags();
  if (!flagEnabled(FF_LIVE_CHAT_DEMO)) return <NotFound />;
  return (
    <Suspense fallback={<main className="demo"><p className="demo-loading">Loading sample data…</p></main>}>
      <LiveChatDemo />
    </Suspense>
  );
}
