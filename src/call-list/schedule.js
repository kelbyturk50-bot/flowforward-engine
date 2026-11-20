// When a lead comes back onto the list. no_answer and voicemail use Denver
// business days. Three of those in a row, and talked, use calendar days and
// then snap a weekend forward so back_on is a business day. Closing outcomes
// do not snooze; they leave the list.

const {
  denverYmd,
  addCalendarDays,
  addBusinessDays,
  snapBusinessDay,
} = require('./clock');

const OUTCOME_BODIES = Object.freeze([
  'no_answer',
  'voicemail',
  'talked',
  'audit_booked',
  'not_interested',
  'do_not_contact',
]);

const CLOSING = new Set(['audit_booked', 'not_interested', 'do_not_contact']);
const SNOOZE = new Set(['no_answer', 'voicemail', 'talked']);

function backOn(outcome, at, attempts) {
  const day = denverYmd(at);
  if (outcome === 'talked') return snapBusinessDay(addCalendarDays(day, 7));
  if (outcome === 'no_answer' || outcome === 'voicemail') {
    if (attempts >= 3) return snapBusinessDay(addCalendarDays(day, 14));
    return addBusinessDays(day, outcome === 'voicemail' ? 2 : 1);
  }
  return null;
}

// rows are newest first and already limited to outcome bodies.
function summarize(rows) {
  const latest = rows.length ? rows[0] : null;
  let attempts = 0;
  for (const row of rows) {
    if (row.body === 'no_answer' || row.body === 'voicemail') attempts += 1;
    else break;
  }
  return { latest, attempts };
}

function held(summary, now) {
  if (!summary.latest) return false;
  const body = summary.latest.body;
  if (CLOSING.has(body)) return true;
  if (!SNOOZE.has(body)) return false;
  const back = backOn(body, summary.latest.created_at, summary.attempts);
  if (!back) return false;
  return denverYmd(now) < back;
}

module.exports = {
  OUTCOME_BODIES,
  CLOSING,
  backOn,
  summarize,
  held,
};
