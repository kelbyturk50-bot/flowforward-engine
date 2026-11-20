// Tiers 3 and 4 only. HVAC, plumbing, roofing, landscaping, and electrical,
// and a Utah address. Tiers 1 and 2 are not filtered here.

function fold(value) {
  return String(value || '').trim().replace(/\s+/g, ' ').toLowerCase();
}

function isTargetTrade(industry) {
  const key = fold(industry);
  if (!key) return false;
  if (/\b(pests?|exterminat(?:or|ors|ing|ion)?|termites?)\b/.test(key)) return false;
  if (/heating oil/.test(key) || /pool heating/.test(key)) return false;
  if (/\b(hvac|heating|cooling|furnace|air conditioning|air-conditioning|ac|a\/c)\b/.test(key)) return true;
  if (/\bplumb/.test(key)) return true;
  if (/\broof/.test(key)) return true;
  if (/\b(landscap\w*|lawn)\b/.test(key)) return true;
  if (/\belectric/.test(key)) return true;
  return false;
}

function isUtah(row) {
  const state = fold(row && row.state);
  if (state === 'ut' || state === 'utah') return true;
  if (state) return false;
  const address = String((row && row.address) || '');
  if (/\butah\b/i.test(address)) return true;
  if (/,\s*UT(?:\s+\d{5}(?:-\d{4})?)?\b/.test(address)) return true;
  return false;
}

module.exports = { isTargetTrade, isUtah };
