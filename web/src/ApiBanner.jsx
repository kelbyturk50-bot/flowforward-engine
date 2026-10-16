import { UNCONFIGURED_MESSAGE } from './api-base.js';

export const API_BANNER_HELP = 'Add an API URL in Settings to connect this preview.';

export default function ApiBanner({ configured }) {
  if (configured) return null;
  return (
    <div className="api-banner" role="status">
      <p className="api-banner-title">{UNCONFIGURED_MESSAGE}</p>
      <p className="api-banner-help">{API_BANNER_HELP}</p>
      <a className="btn" href="#/settings">Open Settings</a>
    </div>
  );
}
