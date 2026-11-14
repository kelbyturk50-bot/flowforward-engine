// Copy and checks for the Today call tasks (F-007). The list route is 404
// { error: "not_found" } while FF_DEMO_VIEW_TASK is off. This module does
// not fetch and does not import the API client.

const DENVER = 'America/Denver';

export function taskPathId(id) {
  if (typeof id === 'boolean' || id == null) return null;
  const text = typeof id === 'number' ? String(id) : String(id);
  if (!/^[1-9]\d{0,15}$/.test(text)) return null;
  const n = Number(text);
  if (!Number.isSafeInteger(n) || n < 1) return null;
  return String(n);
}

export function isTaskListHidden(error) {
  if (!error || error.status !== 404) return false;
  const message = error.message;
  return message == null || message === '' || message === 'not_found' || message === 'Request failed (404)';
}

export function tasksFromPayload(data) {
  if (!data || typeof data !== 'object' || !Array.isArray(data.tasks)) return [];
  return data.tasks.filter((row) => row && typeof row === 'object' && taskPathId(row.id));
}

export function companyName(task) {
  const name = String(task?.company ?? '').replace(/[\r\n]+/g, ' ').trim();
  return name || 'this lead';
}

export function viewCount(value) {
  if (typeof value === 'boolean' || value == null) return null;
  const n = typeof value === 'number' ? value : Number(String(value).trim());
  if (!Number.isInteger(n) || n < 1 || n > 1000000) return null;
  return n;
}

export function taskTitle(task) {
  const n = viewCount(task?.view_count);
  const times = n == null
    ? 'viewed your proposal'
    : n === 1
      ? 'viewed your proposal 1 time'
      : `viewed your proposal ${n} times`;
  return `Call ${companyName(task)}: ${times}`;
}

// Same digit keep as telHref in ui.jsx. A value with no dialable digits is
// not a phone, so the card can say "No phone on file" instead of a dead link.
export function callHref(phone) {
  if (phone == null) return null;
  const text = String(phone).replace(/[\r\n]+/g, ' ').trim();
  if (!text) return null;
  const digits = text.replace(/[^\d+]/g, '');
  if (!digits || digits === '+') return null;
  return `tel:${digits}`;
}

export function phoneText(phone) {
  if (!callHref(phone)) return '';
  return String(phone).replace(/[\r\n]+/g, ' ').trim();
}

export function viewedLabel(source) {
  if (source === 'onepager') return 'proposal';
  if (source === 'demo') return 'live demo';
  return '';
}

function partMap(date, options) {
  const fmt = new Intl.DateTimeFormat('en-US', { timeZone: DENVER, ...options });
  const out = {};
  for (const part of fmt.formatToParts(date)) {
    if (part.type !== 'literal') out[part.type] = part.value;
  }
  return out;
}

function dayKey(date) {
  const parts = partMap(date, { year: 'numeric', month: '2-digit', day: '2-digit' });
  if (!parts.year || !parts.month || !parts.day) return '';
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function shiftKey(key, days) {
  const [year, month, day] = key.split('-').map(Number);
  const utc = new Date(Date.UTC(year, month - 1, day + days));
  const mm = String(utc.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(utc.getUTCDate()).padStart(2, '0');
  return `${utc.getUTCFullYear()}-${mm}-${dd}`;
}

function meridian(value) {
  const raw = String(value || '').replace(/\./g, '').replace(/\s/g, '').toUpperCase();
  if (raw.startsWith('AM')) return 'AM';
  if (raw.startsWith('PM')) return 'PM';
  return '';
}

// "today 2:14 PM" / "yesterday 8:05 AM" on the America/Denver calendar.
// A later calendar day in the same year is "Nov 2, 2:14 PM".
export function denverWhen(value, now = new Date()) {
  if (!value) return '';
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const clock = partMap(date, { hour: 'numeric', minute: '2-digit', hour12: true });
  const suffix = meridian(clock.dayPeriod);
  if (!clock.hour || !clock.minute || !suffix) return '';
  const time = `${clock.hour}:${clock.minute} ${suffix}`;
  const day = dayKey(date);
  const today = dayKey(now);
  if (!day || !today) return time;
  if (day === today) return `today ${time}`;
  if (day === shiftKey(today, -1)) return `yesterday ${time}`;
  if (day === shiftKey(today, 1)) return `tomorrow ${time}`;
  const written = partMap(date, { month: 'short', day: 'numeric', year: 'numeric' });
  const sameYear = written.year === partMap(now, { year: 'numeric' }).year;
  const dateText = sameYear
    ? `${written.month} ${written.day}`
    : `${written.month} ${written.day}, ${written.year}`;
  return `${dateText}, ${time}`;
}

export function taskSubline(task, now = new Date()) {
  const parts = [];
  const when = denverWhen(task?.last_viewed_at, now);
  if (when) parts.push(when);
  const viewed = viewedLabel(task?.source);
  if (viewed) parts.push(viewed);
  const trade = String(task?.trade ?? '').replace(/[\r\n]+/g, ' ').trim();
  if (trade) parts.push(trade);
  const city = String(task?.city ?? '').replace(/[\r\n]+/g, ' ').trim();
  if (city) parts.push(city);
  return parts.join(' · ');
}

export function snoozeLabel(until, now = new Date()) {
  const when = denverWhen(until, now);
  return when ? `Snoozed until ${when}` : 'Snoozed for 1 day';
}

export function snoozeStillHeld(until, now = new Date()) {
  if (!until) return true;
  const date = new Date(until);
  if (Number.isNaN(date.getTime())) return true;
  return date.getTime() > now.getTime();
}

export function actionMessage(error) {
  if (error?.status === 409) return 'That call was already handled.';
  const message = typeof error?.message === 'string' ? error.message.trim() : '';
  if (message && !/^[a-z0-9_]+$/.test(message)) return message;
  return 'Something went wrong.';
}
