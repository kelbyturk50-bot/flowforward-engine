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
