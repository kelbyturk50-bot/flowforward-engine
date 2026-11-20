// Scout's approved copy (issue #144). Fixtures only. The UI renders script,
// voicemail_script, and ask from the row and does not keep this text itself.

export const SCOUT_COPY = Object.freeze({
  callEmailed: 'Kelby Turk, local in Saratoga Springs. I sent you a note about missed calls and quiet estimates. What happens to a call you can\'t pick up?',
  callNeverEmailed: 'Kelby Turk, local in Saratoga Springs. I help shops catch missed calls and chase unsold estimates. What happens to a call you can\'t pick up?',
  voicemail: 'This is Kelby Turk, local in Saratoga Springs. I help shops catch missed calls and chase unsold estimates. I\'ll try you again in a couple of days.',
  walkIn: 'I\'m Kelby, up the road. I help shops answer every call and chase unsold estimates. Is the owner in? Two minutes.',
  ask: 'Free, 15 minutes. I look at how calls and open estimates are handled and tell you the two spots losing you jobs. You keep what I find.',
});

// Server reason lines from src/call-list/copy.js. The UI prints `reason` as-is.
export const CALL_REASONS = Object.freeze({
  demo_today: 'Viewed the demo today',
  demo_view: 'Viewed the demo yesterday',
  demo_days: 'Viewed the demo 3 days ago',
  listedCall: 'On your call list',
  listedWalkIn: 'On your walk-in list',
  intro_3_5d: 'Intro email 4 days ago, no reply',
  sequence_done: 'Emails finished, no reply',
  no_answer: 'No answer Mon, try again',
  voicemail: 'Left a voicemail Tue',
  talked: 'Talked Nov 19, follow up',
  stoppedBy: 'Stopped by Wed, try again',
});

export function callListItem(extra = {}) {
  return {
    prospect_id: 41,
    company: 'TEST: Wasatch Heating',
    kind: 'call',
    phone: '(801) 555-0142',
    tel: 'tel:8015550142',
    address: '100 Test Street',
    city: 'Saratoga Springs',
    maps_url: 'https://www.google.com/maps/search/?api=1&query=TEST%3A%20Wasatch%20Heating%20100%20Test%20Street',
    reason: CALL_REASONS.demo_view,
    reason_code: 'demo_view',
    emailed: true,
    script: SCOUT_COPY.callEmailed,
    voicemail_script: SCOUT_COPY.voicemail,
    ask: SCOUT_COPY.ask,
    open_task_id: 7,
    attempts: 0,
    last_outcome: null,
    last_outcome_at: null,
    ...extra,
  };
}

export function walkInItem(extra = {}) {
  return callListItem({
    prospect_id: 42,
    company: 'TEST: Eagle Mountain Plumbing',
    kind: 'walk_in',
    phone: null,
    tel: null,
    address: '20 Test Road',
    city: 'Eagle Mountain',
    maps_url: 'https://www.google.com/maps/search/?api=1&query=TEST%3A%20Eagle%20Mountain%20Plumbing%2020%20Test%20Road',
    reason: CALL_REASONS.listedWalkIn,
    reason_code: 'listed',
    emailed: false,
    script: SCOUT_COPY.walkIn,
    voicemail_script: null,
    open_task_id: null,
    ...extra,
  });
}

export function enabledCallList(items, extra = {}) {
  return {
    enabled: true,
    date: '2026-11-20',
    cap: 8,
    more: 0,
    items,
    ...extra,
  };
}
