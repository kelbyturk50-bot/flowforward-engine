import { UNCONFIGURED_MESSAGE } from './api-base.js';

export default function ApiBanner({ configured }) {
  if (configured) return null;
  return (
    <div className="api-banner" role="alert">
      <p>{UNCONFIGURED_MESSAGE}</p>
    </div>
  );
}
