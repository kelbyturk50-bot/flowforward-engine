// America/Denver calendar dates for the call list. Business days are
// Monday–Friday. No holiday calendar. Tests replace now() so a weekend
// snooze does not depend on the runner's clock.

const ZONE = 'America/Denver';

let clock = null;

function now() {
  if (clock) return new Date(clock());
  return new Date();
}

function _setClockForTests(fn) {
  if (process.env.NODE_ENV !== 'test') {
    throw new Error('_setClockForTests is only available when NODE_ENV=test');
  }
  clock = typeof fn === 'function' ? fn : null;
}

function parts(date) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    hourCycle: 'h23',
  });
  const bag = {};
  for (const part of fmt.formatToParts(date)) bag[part.type] = part.value;
  let hour = Number(bag.hour);
  if (hour === 24) hour = 0;
  return {
    year: Number(bag.year),
    month: Number(bag.month),
    day: Number(bag.day),
    hour,
  };
}

function pad(n) {
  return String(n).padStart(2, '0');
}

function denverYmd(date) {
  const p = parts(date instanceof Date ? date : new Date(date));
  return `${p.year}-${pad(p.month)}-${pad(p.day)}`;
}

function ymdUtc(ymd) {
  const [y, m, d] = ymd.split('-').map(Number);
  return Date.UTC(y, m - 1, d);
}

function addCalendarDays(ymd, n) {
  const dt = new Date(ymdUtc(ymd) + n * 86400000);
  return dt.toISOString().slice(0, 10);
}

function weekdayIndex(ymd) {
  return new Date(ymdUtc(ymd)).getUTCDay();
}

function calendarDaysBetween(fromYmd, toYmd) {
  return Math.round((ymdUtc(toYmd) - ymdUtc(fromYmd)) / 86400000);
}

function isWeekend(ymd) {
  const day = weekdayIndex(ymd);
  return day === 0 || day === 6;
}

function addBusinessDays(ymd, n) {
  let cur = ymd;
  let left = n;
  while (left > 0) {
    cur = addCalendarDays(cur, 1);
    if (!isWeekend(cur)) left -= 1;
  }
  return cur;
}

// A 7-day or 14-day return that lands on Saturday or Sunday moves to Monday
// so back_on is a Denver business day.
function snapBusinessDay(ymd) {
  let cur = ymd;
  while (isWeekend(cur)) cur = addCalendarDays(cur, 1);
  return cur;
}

// A UTC instant whose Denver wall date and hour match. Used by tests.
function instantInDenver(ymd, hour, minute = 0) {
  const [y, m, d] = ymd.split('-').map(Number);
  let utc = Date.UTC(y, m - 1, d, hour + 7, minute, 0);
  for (let i = 0; i < 8; i += 1) {
    const local = parts(new Date(utc));
    const got = Date.UTC(local.year, local.month - 1, local.day, local.hour, minute, 0);
    const want = Date.UTC(y, m - 1, d, hour, minute, 0);
    if (got === want) return new Date(utc);
    utc += want - got;
  }
  throw new Error('could not resolve America/Denver instant');
}

module.exports = {
  ZONE,
  now,
  denverYmd,
  addCalendarDays,
  addBusinessDays,
  snapBusinessDay,
  calendarDaysBetween,
  weekdayIndex,
  instantInDenver,
  _setClockForTests,
};
