import { formatDenverDateTime } from '../live-chat/dates.js';

// FF_PROSPECT_VIEWS is env-only and is not on GET /api/flags. The list and
// the proposal read grow these keys only while it is on. Absent means the
// CRM keeps the legacy views / last_viewed_at line.
export function hasProspectViewFields(proposal) {
  return !!proposal && typeof proposal === 'object' && 'prospect_views' in proposal;
}

function denver(value) {
  if (value == null || value === '') return '';
  return formatDenverDateTime(value);
}

// Null counts mean the proposal is not tracked, including a row created
// before counting_since. Integers, including 0, are tracked. A team-only
// window is prospect 0 and internal greater than 0, not null.
export function prospectViewCopy(proposal) {
  if (!hasProspectViewFields(proposal)) return null;
  const prospect = proposal.prospect_views;
  const internal = proposal.internal_views;
  if (!Number.isInteger(prospect) || !Number.isInteger(internal)) {
    const since = denver(proposal.counting_since);
    return {
      tracked: false,
      main: 'Prospect views: not tracked',
      last: '',
      since: since ? `counting since ${since}` : '',
      secondary: '',
    };
  }
  const last = denver(proposal.last_prospect_view_at);
  return {
    tracked: true,
    main: `Prospect views ${prospect}`,
    last: last ? `last ${last}` : '',
    since: '',
    secondary: `Team/scanner views ${internal}`,
  };
}
