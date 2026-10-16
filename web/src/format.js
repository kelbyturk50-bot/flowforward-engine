/** Tab-bar counts. Zero hides the badge. Anything past 9 reads "9+". */
export function badgeCount(n) {
  const v = Math.floor(Number(n) || 0);
  if (v <= 0) return null;
  return v > 9 ? '9+' : String(v);
}

/**
 * Compact dollar amounts for a phone card: $1.2M, $850K, $450.
 * Empty stays an em dash so the trade line never drops the revenue slot.
 */
export function compactMoney(v) {
  if (v == null || v === '') return '—';
  const n = Number(v);
  if (!Number.isFinite(n)) return '—';
  const sign = n < 0 ? '-' : '';
  const a = Math.abs(n);
  const trim = (x) => {
    const s = (Math.round(x * 10) / 10).toFixed(1);
    return s.endsWith('.0') ? s.slice(0, -2) : s;
  };
  if (a >= 1_000_000) return `${sign}$${trim(a / 1_000_000)}M`;
  if (a >= 1_000) return `${sign}$${trim(a / 1_000)}K`;
  return `${sign}$${Math.round(a).toLocaleString('en-US')}`;
}
