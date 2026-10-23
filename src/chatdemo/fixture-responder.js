// Fixture responder. Keyword intents, templated from the facts sheet.
// Copy stays off the claims-validator false-positive list.

const { normalize } = require('./copy');
const { firstTown } = require('./demos');

const SAMPLE_SLOTS = Object.freeze([
  'Tuesday 9:00 AM',
  'Tuesday 1:00 PM',
  'Wednesday 10:30 AM',
]);

const CONFIRM_LINE = 'The team will confirm.';
const DECLINE_PRICE = "I don't want to guess on that; the team will confirm.";
const FALLBACK_REPLY = 'Good question. The team will confirm that for you. Want me to have someone reach out?';

const CHIP_INTENT = Object.freeze({
  chip_emergency: 'emergency',
  chip_booking: 'booking',
  chip_price: 'price',
  chip_hours: 'hours',
  chip_area: 'area',
});

function factValue(facts, field) {
  const rows = Array.isArray(facts) ? facts : [];
  const row = rows.find((item) => item.field === field && item.value);
  return row ? String(row.value) : '';
}

function serviceFor(message, chipId) {
  const n = normalize(message);
  if (n.includes('water heater') || chipId === 'chip_emergency') return 'water_heater';
  if (n.includes('furnace') || chipId === 'chip_price') return 'furnace';
  if (n.includes('drain')) return 'drain';
  return 'general';
}

function intentFor(message, facts) {
  const n = normalize(message);
  if (!n) return 'fallback';
  if (/\b(leak|leaking|flood|flooding|emergency|burst)\b/.test(n)) return 'emergency';
  if (n.includes('how much') || /\b(price|cost)\b/.test(n)) return 'price';
  if (/\b(open|hours)\b/.test(n)) return 'hours';
  const town = firstTown(factValue(facts, 'service_area')).toLowerCase();
  if (town && n.includes(town)) return 'area';
  if (/\b(book|appointment|schedule)\b/.test(n) || n.includes('come out')) return 'booking';
  return 'fallback';
}

function tool(name, service, urgency, slot) {
  const args = { service, urgency };
  if (slot != null) args.slot = slot;
  return { name, args };
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
        tool('offer_sample_slots', service, 'normal', 0),
        tool('capture_lead', service, 'normal'),
      ],
      slots: SAMPLE_SLOTS,
    };
  }
  if (intent === 'price') {
    const price = factValue(facts, 'price');
    return {
      text: price ? `The site lists ${price}; the team will confirm for your job.` : DECLINE_PRICE,
      tools: [],
    };
  }
  if (intent === 'hours') {
    const hours = factValue(facts, 'hours');
    return {
      text: hours ? `Hours on file are ${hours}. The team will confirm anything outside those hours.` : CONFIRM_LINE,
      tools: [],
    };
  }
  if (intent === 'area') {
    const town = firstTown(factValue(facts, 'service_area'));
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

function fixtureRespond({ facts, message, chipId }) {
  const intent = CHIP_INTENT[chipId] || intentFor(message, facts);
  const service = serviceFor(message, chipId);
  const reply = replyFor(intent, facts, service);
  return {
    text: reply.text,
    tools: reply.tools,
    slots: reply.slots || [],
    source: 'fixture',
  };
}

module.exports = {
  SAMPLE_SLOTS,
  CONFIRM_LINE,
  DECLINE_PRICE,
  FALLBACK_REPLY,
  fixtureRespond,
};
