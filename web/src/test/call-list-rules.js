// The same stage rules as src/call-list/outcomes.js. The CRM UI does not
// import this. The test mock does, and returns the stage on the POST body.

const OPEN = Object.freeze(['found', 'contacted', 'responded', 'qualified', 'proposal']);
const OUTCOMES = new Set([
  'no_answer',
  'voicemail',
  'talked',
  'audit_booked',
  'not_interested',
  'do_not_contact',
]);

function stageAfterOutcome(current, outcome) {
  if (outcome === 'talked') return forward(current, 'responded');
  if (outcome === 'audit_booked') return forward(current, 'qualified');
  if (outcome === 'not_interested') {
    if (OPEN.includes(current)) return 'lost';
    return current;
  }
  return current;
}

function forward(current, target) {
  const from = OPEN.indexOf(current);
  const to = OPEN.indexOf(target);
  if (from === -1 || to === -1 || from >= to) return current;
  return target;
}

const leads = new Map();
let enabled = false;

function fail(status, error) {
  const err = new Error(error);
  err.status = status;
  err.body = { error };
  throw err;
}

export function resetCallListMock() {
  leads.clear();
  enabled = false;
}

export function setMockCallListEnabled(on) {
  enabled = on === true;
}

export function seedCallListLead(lead) {
  leads.set(String(lead.id), {
    stage: typeof lead.stage === 'string' && lead.stage ? lead.stage : 'found',
    do_not_contact: lead.do_not_contact === true,
    archived: lead.archived === true || lead.archived_at != null,
  });
}

export function mockLeadStage(id) {
  return leads.get(String(id))?.stage;
}

function denverYmd(date) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Denver',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const pick = (type) => parts.find((part) => part.type === type).value;
  return `${pick('year')}-${pick('month')}-${pick('day')}`;
}

function addCalendarDays(ymd, count) {
  const [year, month, day] = ymd.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day) + count * 86400000).toISOString().slice(0, 10);
}

function isWeekend(ymd) {
  const [year, month, day] = ymd.split('-').map(Number);
  return [0, 6].includes(new Date(Date.UTC(year, month - 1, day)).getUTCDay());
}

function addBusinessDays(ymd, count) {
  let cursor = ymd;
  let left = count;
  while (left > 0) {
    cursor = addCalendarDays(cursor, 1);
    if (!isWeekend(cursor)) left -= 1;
  }
  return cursor;
}

function snapBusinessDay(ymd) {
  let cursor = ymd;
  while (isWeekend(cursor)) cursor = addCalendarDays(cursor, 1);
  return cursor;
}

// First snooze only, matching src/call-list/schedule.js. No streak is stored,
// so three no-answers in a row still use one or two business days.
function backOnForOutcome(outcome, at = new Date()) {
  const day = denverYmd(at);
  if (outcome === 'talked') return snapBusinessDay(addCalendarDays(day, 7));
  if (outcome === 'voicemail') return addBusinessDays(day, 2);
  if (outcome === 'no_answer') return addBusinessDays(day, 1);
  return null;
}

function stored(id, fallbackStage) {
  const key = String(id);
  if (!leads.has(key)) {
    leads.set(key, {
      stage: fallbackStage || 'found',
      do_not_contact: false,
      archived: false,
    });
  }
  return leads.get(key);
}

export function mockSaveCallListKind(id, kind) {
  if (!enabled) fail(404, 'not_found');
  if (kind !== 'call' && kind !== 'walk_in') fail(400, 'invalid_kind');
  const current = leads.get(String(id));
  if (!current) fail(404, 'not_found');
  if (current.do_not_contact) fail(409, 'do_not_contact');
  if (current.archived) fail(409, 'archived');
  return {
    call_list_kind: kind,
    call_list_set_at: '2026-11-20T18:00:00.000Z',
  };
}

export function mockRemoveCallList(id) {
  if (!enabled) fail(404, 'not_found');
  if (!leads.has(String(id))) fail(404, 'not_found');
  return {
    call_list_kind: 'excluded',
    call_list_set_at: '2026-11-20T18:00:00.000Z',
  };
}

export function mockRecordCallOutcome(id, body, fallbackStage = 'found') {
  if (!enabled) fail(404, 'not_found');
  const outcome = body?.outcome;
  const kind = body?.kind;
  if (!OUTCOMES.has(outcome)) fail(400, 'invalid_outcome');
  if (kind !== 'call' && kind !== 'walk_in') fail(400, 'invalid_kind');
  const current = stored(id, fallbackStage);
  const stage = stageAfterOutcome(current.stage, outcome);
  current.stage = stage;
  if (outcome === 'do_not_contact') current.do_not_contact = true;
  return {
    activity_id: 1,
    removed: true,
    back_on: backOnForOutcome(outcome),
    stage,
  };
}

// Flag off drops the keys. Flag on keeps them, including null.
export function presentProspectKeys(lead, flagOn) {
  const out = { ...lead };
  if (!flagOn) {
    delete out.call_list_kind;
    delete out.call_list_set_at;
    return out;
  }
  out.call_list_kind = out.call_list_kind == null || out.call_list_kind === '' ? null : out.call_list_kind;
  out.call_list_set_at = out.call_list_set_at == null || out.call_list_set_at === '' ? null : out.call_list_set_at;
  return out;
}
