export const DENVER_ZONE = 'America/Denver';

export function formatDenverDate(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat('en-US', {
    timeZone: DENVER_ZONE,
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  }).format(date);
}

// Absolute Mountain Time, labeled MT in both standard and daylight time.
export function formatDenverDateTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const formatted = new Intl.DateTimeFormat('en-US', {
    timeZone: DENVER_ZONE,
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(date);
  return `${formatted} MT`;
}
