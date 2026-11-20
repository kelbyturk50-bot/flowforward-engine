// Scout's approved F-010 copy (issue #144, comments 7029168563 and 7030252875).
// Reason lines are for Kelby. No opener mentions a view or an open.
// Once a lead has a call outcome, the reason names that outcome unless the
// row is tier 1, which keeps the demo-view line.

const { denverYmd, calendarDaysBetween, weekdayIndex } = require('./clock');

const CALL_EMAILED = 'Kelby Turk, local in Saratoga Springs. I sent you a note about missed calls and quiet estimates. What happens to a call you can\'t pick up?';
const CALL_NEVER_EMAILED = 'Kelby Turk, local in Saratoga Springs. I help shops catch missed calls and chase unsold estimates. What happens to a call you can\'t pick up?';
const VOICEMAIL = 'This is Kelby Turk, local in Saratoga Springs. I help shops catch missed calls and chase unsold estimates. I\'ll try you again in a couple of days.';
const WALK_IN = 'I\'m Kelby, up the road. I help shops answer every call and chase unsold estimates. Is the owner in? Two minutes.';
const ASK = 'Free, 15 minutes. I look at how calls and open estimates are handled and tell you the two spots losing you jobs. You keep what I find.';

const REASON_DEMO_TODAY = 'Viewed the demo today';
const REASON_DEMO_YESTERDAY = 'Viewed the demo yesterday';
const REASON_WALK_IN_LIST = 'On your walk-in list';
const REASON_CALL_LIST = 'On your call list';
const REASON_SEQUENCE_DONE = 'Emails finished, no reply';

function reasonDemoDays(days) {
  return `Viewed the demo ${days} days ago`;
}

function reasonIntroDays(days) {
  return `Intro email ${days} days ago, no reply`;
}

function scriptFor(kind, emailed) {
  if (kind === 'walk_in') return WALK_IN;
  return emailed ? CALL_EMAILED : CALL_NEVER_EMAILED;
}

const WEEKDAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// Weekday name for an outcome in the last 6 Denver days, including today.
// Older than that, a short date such as "Nov 19".
function outcomeWhen(at, todayYmd) {
  const ymd = typeof at === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(at) ? at : denverYmd(at);
  const days = calendarDaysBetween(ymd, todayYmd);
  if (days <= 6) return WEEKDAY_NAMES[weekdayIndex(ymd)];
  const month = Number(ymd.slice(5, 7));
  const day = Number(ymd.slice(8, 10));
  return `${MONTH_NAMES[month - 1]} ${day}`;
}

function reasonForOutcome(outcome, kind, at, todayYmd) {
  const when = outcomeWhen(at, todayYmd);
  if (kind === 'walk_in' && (outcome === 'no_answer' || outcome === 'voicemail')) {
    return `Stopped by ${when}, try again`;
  }
  if (outcome === 'no_answer') return `No answer ${when}, try again`;
  if (outcome === 'voicemail') return `Left a voicemail ${when}`;
  if (outcome === 'talked') return `Talked ${when}, follow up`;
  return null;
}

module.exports = {
  CALL_EMAILED,
  CALL_NEVER_EMAILED,
  VOICEMAIL,
  WALK_IN,
  ASK,
  REASON_DEMO_TODAY,
  REASON_DEMO_YESTERDAY,
  REASON_WALK_IN_LIST,
  REASON_CALL_LIST,
  REASON_SEQUENCE_DONE,
  reasonDemoDays,
  reasonIntroDays,
  scriptFor,
  outcomeWhen,
  reasonForOutcome,
};
