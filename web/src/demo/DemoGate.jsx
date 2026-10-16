import { lazy, Suspense, useEffect } from 'react';
import NotFound from '../NotFound';
import { FF_PILOT_ESTIMATE_RECOVERY, flagEnabled } from '../flags';
import { isDemoToken } from './token';

const EstimateRecovery = lazy(() => import('./EstimateRecovery'));

function useNoindex() {
  useEffect(() => {
    const meta = document.createElement('meta');
    meta.name = 'robots';
    meta.content = 'noindex';
    document.head.appendChild(meta);
    return () => meta.remove();
  }, []);
}

export default function DemoGate({ token }) {
  useNoindex();
  const open = flagEnabled(FF_PILOT_ESTIMATE_RECOVERY) && isDemoToken(token);
  if (!open) return <NotFound />;
  return (
    <Suspense fallback={<main className="demo"><p className="demo-loading">Loading sample data…</p></main>}>
      <EstimateRecovery token={token} />
    </Suspense>
  );
}
