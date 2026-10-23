// Fixture responder for the chat demo. Chip ids and keyword buckets follow
// docs/LIVE_CHAT_DEMO.md §4 and §7. Replies stay off the claims-validator
// false-positive list (no "today", "right now", "immediately", or similar).
// Emergency and booking also return capture_lead so the sample CRM card
// fills from an enum. Typed text never becomes the customer name or phone.

import {
  CONFIRM_LINE,
  DECLINE_PRICE,
  FALLBACK_REPLY,
  IDENTITY_REPLY,
  SAMPLE_SLOTS,
  firstTown,
} from './fixture.js';

const SERVICE_LABEL = Object.freeze({
  water_heater: 'Water heater',
  furnace: 'Furnace',
  general: 'General question',
});

export function serviceLabel(service) {
  return SERVICE_LABEL[service] || 'General question';
}

export function asksIfAi(text) {
  const n = normalize(text);
  if (!/\bare you\b/.test(n)) return false;
  return /\b(bot|ai|human)\b/.test(n);
}

function normalize(text) {
  return String(text ?? '').normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
}

function serviceFor(message, chipId) {
  const n = normalize(message);
  if (n.includes('water heater')) return 'water_heater';
  if (n.includes('furnace')) return 'furnace';
  if (chipId === 'chip_emergency') return 'water_heater';
  if (chipId === 'chip_price') return 'furnace';
  return 'general';
}

function intentFor(message, facts) {
  const n = normalize(message);
  if (!n) return 'fallback';
  if (/\b(leak|leaking|flood|flooding|emergency|burst)\b/.test(n)) return 'emergency';
  if (n.includes('how much') || /\b(price|cost)\b/.test(n)) return 'price';
  if (/\b(open|hours)\b/.test(n)) return 'hours';
  const town = firstTown(facts?.service_area).toLowerCase();
  if (town && n.includes(town)) return 'area';
  if (/\b(book|appointment|schedule)\b/.test(n) || n.includes('come out')) return 'booking';
  return 'fallback';
}

function tool(name, service, urgency) {
  return { name, args: { service, urgency } };
}

function replyFor(intent, facts, service) {
  if (intent === 'emergency') {
    return {
      text: 'A water heater leak needs a person on your team. I marked this sample lead as an emergency. Nothing was sent.',
      tools: [
        tool('flag_emergency', service, 'emergency'),
        tool('capture_lead', service, 'emergency'),
        tool('handoff_to_human', service, 'emergency'),
      ],
    };
  }
  if (intent === 'booking') {
    return {
      text: 'Here are sample times. Nothing is booked from this screen.',
      tools: [
        tool('offer_sample_slots', service, 'normal'),
        tool('capture_lead', service, 'normal'),
      ],
    };
  }
  if (intent === 'price') {
    return { text: facts?.price ? `The site lists ${facts.price}; the team will confirm for your job.` : DECLINE_PRICE, tools: [] };
  }
  if (intent === 'hours') {
    return {
      text: facts?.hours ? `Hours on file are ${facts.hours}. The team will confirm anything outside those hours.` : CONFIRM_LINE,
      tools: [],
    };
  }
  if (intent === 'area') {
    const town = firstTown(facts?.service_area);
    return {
      text: town ? `${town} is in the service area on file.` : CONFIRM_LINE,
      tools: [],
    };
  }
  return {
    text: FALLBACK_REPLY,
    tools: [tool('handoff_to_human', service, 'normal')],
  };
}

const CHIP_INTENT = Object.freeze({
  chip_emergency: 'emergency',
  chip_booking: 'booking',
  chip_price: 'price',
  chip_hours: 'hours',
  chip_area: 'area',
});

let fixtureFailures = 0;

// Test seam. A countdown throws fixture_reply_failed before any reply is built.
// Production never calls this. The demo catches it and offers Retry.
export function _failNextFixtureReply(times = 1) {
  fixtureFailures = times;
}

export function respond({ facts, message, chipId }) {
  if (fixtureFailures > 0) {
    fixtureFailures -= 1;
    const error = new Error('fixture_reply_failed');
    error.code = 'fixture_reply_failed';
    throw error;
  }
  if (!chipId && asksIfAi(message)) {
    return { text: IDENTITY_REPLY, tools: [], source: 'fixture' };
  }
  const intent = CHIP_INTENT[chipId] || intentFor(message, facts);
  const service = serviceFor(message, chipId);
  const reply = replyFor(intent, facts, service);
  return { ...reply, slots: intent === 'booking' ? SAMPLE_SLOTS : [], source: 'fixture' };
}

export const INITIAL_LEAD = Object.freeze({
  customer: 'Sample customer',
  phone: '(801) 555-0199',
  service: 'Not chosen yet',
  urgency: 'normal',
  alerted: false,
  captured: false,
});

function rankUrgency(value) {
  return { low: 0, normal: 1, urgent: 2, emergency: 3 }[value] ?? 1;
}

export function nextLead(lead, tools) {
  const next = { ...lead };
  for (const item of tools || []) {
    const service = item?.args?.service ? serviceLabel(item.args.service) : next.service;
    const urgency = item?.args?.urgency;
    if (urgency && rankUrgency(urgency) > rankUrgency(next.urgency)) next.urgency = urgency;
    if (item?.args?.service) next.service = service;
    if (item?.name === 'flag_emergency') next.alerted = true;
    if (item?.name === 'capture_lead') next.captured = true;
  }
  next.customer = INITIAL_LEAD.customer;
  next.phone = INITIAL_LEAD.phone;
  return next;
}
