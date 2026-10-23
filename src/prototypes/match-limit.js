// Per-prototype limit for POST /api/prototypes/:id/match-site.
// The API key is the other gate. This cap stops one prototype from
// fetching the lead's site in a loop. The counters stay in this process.

const hits = new Map();

let maxHits = 8;
let windowMs = 60 * 60 * 1000;

function allowMatch(id, now = Date.now()) {
  const key = String(id);
  const cutoff = now - windowMs;
  const recent = (hits.get(key) || []).filter((stamp) => stamp > cutoff);
  if (recent.length >= maxHits) {
    hits.set(key, recent);
    return false;
  }
  recent.push(now);
  hits.set(key, recent);
  if (hits.size > 1000) {
    for (const [stored, stamps] of hits) {
      const live = stamps.filter((stamp) => stamp > cutoff);
      if (!live.length) hits.delete(stored);
      else hits.set(stored, live);
    }
  }
  return true;
}

function _resetMatchLimitForTests() {
  if (process.env.NODE_ENV !== 'test') throw new Error('test only');
  hits.clear();
  maxHits = 8;
  windowMs = 60 * 60 * 1000;
}

function _setMatchLimitForTests(opts = {}) {
  if (process.env.NODE_ENV !== 'test') throw new Error('test only');
  if (opts.max != null) maxHits = opts.max;
  if (opts.windowMs != null) windowMs = opts.windowMs;
}

module.exports = {
  allowMatch,
  _resetMatchLimitForTests,
  _setMatchLimitForTests,
};
