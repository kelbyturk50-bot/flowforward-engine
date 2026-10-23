// Banner, disclosure, and watermark for every live-chat demo payload.
// No logos. The watermark string is the prototype page constant.

const { WATERMARK_TEXT } = require('../prototypes/page');

const SAMPLE_LEAD_NAME = 'Sample customer';
const SAMPLE_LEAD_PHONE = '(801) 555-0199';
const CANNED_REPLY = "I don't want to guess on that; the team will confirm.";
const PAUSE_MESSAGE = "Demo paused. The live AI is resting for today; you're seeing sample replies.";
const IDENTITY_REPLY = "Yes, I'm an AI.";
const FLOWFORWARD_ZONE = 'America/Denver';

function banner(business) {
  const name = business || 'this business';
  return `Sample concept built by FlowForward for ${name}. Not affiliated with or operated by ${name}. No real bookings are made.`;
}

function disclosure(business, phone) {
  const name = business || 'this business';
  const call = phone ? `call ${phone}` : 'call the business directly';
  return `Hi! I'm an AI receptionist demo FlowForward built for ${name}. I'm not connected to their team. If you're a real customer, please ${call}.`;
}

function codePointLength(value) {
  return Array.from(String(value ?? '').normalize('NFKC')).length;
}

function normalize(value) {
  return String(value ?? '').normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
}

function zoneDay(date, timeZone) {
  const zone = timeZone || FLOWFORWARD_ZONE;
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: zone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(date);
  } catch {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: FLOWFORWARD_ZONE,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(date);
  }
}

function perGoogle(fact) {
  if (!fact || fact.source !== 'cached_research' || typeof fact.source_url !== 'string') return false;
  let host;
  try {
    host = new URL(fact.source_url).hostname;
  } catch {
    return false;
  }
  host = host.toLowerCase().replace(/\.$/, '');
  return host === 'google.com' || host.endsWith('.google.com');
}

function envelope(business, extra) {
  const body = {
    watermark: WATERMARK_TEXT,
    banner: banner(business && business.business_name),
    business_name: business ? business.business_name : undefined,
    colors: business ? { primary: business.colors.primary, secondary: business.colors.secondary } : undefined,
  };
  return Object.assign(body, extra);
}

module.exports = {
  WATERMARK_TEXT,
  SAMPLE_LEAD_NAME,
  SAMPLE_LEAD_PHONE,
  CANNED_REPLY,
  PAUSE_MESSAGE,
  IDENTITY_REPLY,
  FLOWFORWARD_ZONE,
  banner,
  disclosure,
  codePointLength,
  normalize,
  zoneDay,
  perGoogle,
  envelope,
};
