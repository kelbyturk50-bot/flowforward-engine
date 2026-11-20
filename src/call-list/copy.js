// Scout's approved F-010 copy (issue #144, comment 7029168563).
// Reason lines are for Kelby. No opener mentions a view or an open.

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
};
