import { FF_PILOT_ESTIMATE_RECOVERY, FF_PILOT_LINK_ON_ONEPAGER, flagEnabled } from '../flags';
import { DEMO_PREVIEW_TOKEN, demoHref } from './token';

function href() {
  return demoHref(DEMO_PREVIEW_TOKEN, window.location.search);
}

export function PreviewDemoLink({ className = 'btn btn-quiet' }) {
  if (!flagEnabled(FF_PILOT_ESTIMATE_RECOVERY)) return null;
  return <a className={className} href={href()}>Preview demo</a>;
}

export function TryLiveDemoLink({ className = 'btn btn-quiet' }) {
  if (!flagEnabled(FF_PILOT_ESTIMATE_RECOVERY) || !flagEnabled(FF_PILOT_LINK_ON_ONEPAGER)) return null;
  return <a className={className} href={href()}>Try a live demo</a>;
}
