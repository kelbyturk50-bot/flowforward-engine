// What the voice agent may say about the shop. Pure.
//
// Built from the facts the chat already uses: approved rows only (the caller
// passes them). The voice prompt gets a short block, not the whole sheet:
// long prompts slow a voice agent down, and digits and symbols are where
// voice models misspeak. Prices, warranties, guarantees, years in business,
// license numbers, reviews, and ratings are never passed to the voice agent.

const VOICE_FIELDS = Object.freeze([
  ['hours', 'Hours'],
  ['services', 'Services'],
  ['service_area', 'Towns served'],
  ['emergency_247', 'Offers 24/7 emergency service'],
  ['free_estimate', 'Offers free estimates'],
  ['financing', 'Offers financing'],
  ['maintenance_plan', 'Has a maintenance plan'],
  ['license', 'Licensed'],
  ['insurance', 'Insured'],
  ['bonding', 'Bonded'],
  ['phone', 'Office phone'],
]);

const MAX_BLOCK = 1500;
const HOSTILE = /[\u0000-\u001F\u007F<>{}​-‏‪-‮⁠-⁤⁦-⁩﻿]/g;

function clean(value, max) {
  const text = String(value ?? '').normalize('NFKC').replace(HOSTILE, ' ').replace(/\s+/g, ' ').trim();
  return [...text].slice(0, max).join('');
}

function factsBlock(facts) {
  const by = new Map((Array.isArray(facts) ? facts : []).map((fact) => [fact.field, fact.value]));
  const lines = [];
  for (const [field, label] of VOICE_FIELDS) {
    const value = by.get(field);
    if (!value) continue;
    lines.push(value === 'yes' ? `- ${label}.` : `- ${label}: ${clean(value, 300)}`);
  }
  let block = '';
  for (const line of lines) {
    if (block.length + line.length + 1 > MAX_BLOCK) break;
    block += (block ? '\n' : '') + line;
  }
  return block || '- No details on file. For anything specific, say the team will confirm.';
}

function voiceVariables({ businessName, facts }) {
  const name = clean(businessName, 120) || 'this business';
  const by = new Map((Array.isArray(facts) ? facts : []).map((fact) => [fact.field, fact.value]));
  const phone = clean(by.get('phone') || '', 40);
  const town = clean(String(by.get('service_area') || '').split(',')[0], 60);
  return {
    business_name: name,
    business_phone: phone || 'the number on their website',
    first_town: town || 'your area',
    business_facts: factsBlock(facts),
  };
}

// The first thing the caller hears. Sent as a per-call override, so the
// disclosure does not depend on how the agent was set up in Retell.
function beginMessage(businessName) {
  const name = clean(businessName, 120) || 'this business';
  return `Thanks for calling ${name}. Quick heads-up: I'm an AI receptionist demo FlowForward built for ${name}, and I'm not connected to their team. Nothing gets booked on this call. How can I help?`;
}

module.exports = { VOICE_FIELDS, voiceVariables, factsBlock, beginMessage };
