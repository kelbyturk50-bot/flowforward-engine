// Fixture facts for the live chat demo. Nothing here is a real business,
// and nothing in this folder calls a model or sends a message.
// The 500-character cap matches CHAT_CAPS.maxMessageChars (code points after NFKC).

export const MAX_MESSAGE_CHARS = 500;

export const SAMPLE_BUSINESS = 'Sample Home Services';

export const SAMPLE_FACTS = Object.freeze({
  business_name: SAMPLE_BUSINESS,
  services: 'Heating and cooling, water heaters',
  service_area: 'Sample Town',
  phone: '(801) 555-0142',
  hours: 'Monday–Friday, 8:00 AM–5:00 PM',
  time_zone: 'America/Denver',
});

export const SAMPLE_BRAND = Object.freeze({
  name: SAMPLE_BUSINESS,
  logoUrl: '',
  colors: Object.freeze({
    primary: '#2F6B57',
    accent: '#2F6B57',
    ink: '#1E2A2F',
  }),
});

export const SAMPLE_CUSTOMER = 'Sample customer';
export const SAMPLE_CUSTOMER_PHONE = '(801) 555-0199';

export const SAMPLE_SLOTS = Object.freeze([
  'Tuesday 9:00 AM',
  'Tuesday 1:00 PM',
  'Wednesday 10:30 AM',
]);

// Saturday 8:12 PM in America/Denver. The office hours above are closed then,
// so the after-hours line does not depend on the viewer's clock.
export const DEMO_NOW = new Date('2026-10-25T02:12:00.000Z');

export const AI_DEMO_LABEL = 'AI demo';
export const IDENTITY_REPLY = "Yes, I'm an AI.";
export const DECLINE_PRICE = "I don't want to guess on that; the team will confirm.";
export const CONFIRM_LINE = 'The team will confirm.';
export const FALLBACK_REPLY = 'Good question. The team will confirm that for you. Want me to have someone reach out?';
export const HANDOFF_LINE = 'In the live version this would ring the on-call tech.';
export const SLOTS_LABEL = 'Sample times, not real availability.';
export const MOCK_ALERT_LABEL = 'Mock alert, not sent';
export const CRM_CARD_TITLE = 'Request created in your CRM (sample)';

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const WEEKDAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export function messageCodePoints(value) {
  return Array.from(String(value ?? '').normalize('NFKC')).length;
}

export function capMessage(value) {
  return Array.from(String(value ?? '').normalize('NFKC')).slice(0, MAX_MESSAGE_CHARS).join('');
}

export function disclosureText(business, phone) {
  const name = business || SAMPLE_BUSINESS;
  const call = phone ? `call ${phone}` : 'call the business directly';
  return `Hi! I'm an AI receptionist demo FlowForward built for ${name}. I'm not connected to their team. If you're a real customer, please ${call}.`;
}

export function affiliationBanner(business) {
  const name = business || SAMPLE_BUSINESS;
  return `Sample concept built by FlowForward for ${name}. Not affiliated with or operated by ${name}. No real bookings are made.`;
}

export function firstTown(serviceArea) {
  const town = String(serviceArea ?? '').split(',')[0].trim();
  return town;
}

export function chipsFor(facts) {
  const town = firstTown(facts?.service_area);
  return [
    { id: 'chip_emergency', label: 'My water heater is leaking all over the garage' },
    { id: 'chip_booking', label: 'Can someone come out Tuesday?' },
    { id: 'chip_price', label: 'How much for a new furnace?' },
    { id: 'chip_hours', label: 'Are you open Saturday?' },
    { id: 'chip_area', label: town ? `Do you service ${town}?` : 'Do you service this area?' },
  ];
}

function zonedParts(date, timeZone) {
  const zone = timeZone || 'America/Denver';
  let parts;
  try {
    parts = new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      weekday: 'short',
      hour: 'numeric',
      minute: '2-digit',
      hourCycle: 'h12',
    }).formatToParts(date);
  } catch {
    parts = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/Denver',
      weekday: 'short',
      hour: 'numeric',
      minute: '2-digit',
      hourCycle: 'h12',
    }).formatToParts(date);
  }
  const get = (type) => parts.find((part) => part.type === type)?.value || '';
  let hour = Number(get('hour'));
  const minute = Number(get('minute'));
  const dayPeriod = get('dayPeriod');
  let hour24 = hour % 12;
  if (dayPeriod === 'PM') hour24 += 12;
  if (dayPeriod === 'AM' && hour === 12) hour24 = 0;
  return {
    weekday: get('weekday'),
    hour,
    minute,
    dayPeriod,
    minutesOfDay: hour24 * 60 + minute,
  };
}

function titleDay(value) {
  const raw = String(value || '');
  return raw.slice(0, 1).toUpperCase() + raw.slice(1).toLowerCase();
}

function clockToMinutes(hourText, minuteText, meridiem) {
  let hour = Number(hourText);
  const minute = minuteText ? Number(minuteText) : 0;
  if (!Number.isInteger(hour) || !Number.isInteger(minute)) return null;
  if (hour < 1 || hour > 12 || minute < 0 || minute > 59) return null;
  const pm = String(meridiem).toUpperCase() === 'PM';
  if (hour === 12) hour = 0;
  if (pm) hour += 12;
  return hour * 60 + minute;
}

// "Monday–Friday, 8:00 AM–5:00 PM". Hyphen, en dash, or em dash. Unparseable
// hours do not claim the office is closed.
export function parseOfficeHours(text) {
  if (typeof text !== 'string') return null;
  const match = text.match(/^\s*(Sunday|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday)\s*[-–—]\s*(Sunday|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday)\s*,\s*(\d{1,2})(?::(\d{2}))?\s*(AM|PM)\s*[-–—]\s*(\d{1,2})(?::(\d{2}))?\s*(AM|PM)\s*$/i);
  if (!match) return null;
  const startDay = WEEKDAYS.indexOf(titleDay(match[1]));
  const endDay = WEEKDAYS.indexOf(titleDay(match[2]));
  const open = clockToMinutes(match[3], match[4], match[5]);
  const close = clockToMinutes(match[6], match[7], match[8]);
  if (startDay < 0 || endDay < 0 || open == null || close == null || open >= close) return null;
  return { startDay, endDay, open, close };
}

export function officeClosed(facts, now = DEMO_NOW) {
  const hours = parseOfficeHours(facts?.hours);
  if (!hours) return false;
  const parts = zonedParts(now, facts?.time_zone);
  const day = WEEKDAY_SHORT.indexOf(parts.weekday);
  if (day < 0) return false;
  const openToday = hours.startDay <= hours.endDay
    ? day >= hours.startDay && day <= hours.endDay
    : day >= hours.startDay || day <= hours.endDay;
  if (!openToday) return true;
  return parts.minutesOfDay < hours.open || parts.minutesOfDay >= hours.close;
}

export function afterHoursNotice(facts, now = DEMO_NOW) {
  if (!facts?.hours || !officeClosed(facts, now)) return '';
  const parts = zonedParts(now, facts.time_zone);
  const minute = String(parts.minute).padStart(2, '0');
  return `It's ${parts.hour}:${minute} ${parts.dayPeriod}. Your office is closed. The AI still answered.`;
}
