// Facts sheet from cached research. Pure: no I/O, no fetch, no model call.
//
// Input is the research object the proposal bot already stored
// (proposals.research or prospects.research): research.site.pages from the
// crawl, research.google from Place Details, research.business from the
// prospect row at research time. Output is a list of candidate facts, each
// tied to a source_url and a verbatim snippet from that source. Kelby
// approves them in the CRM before the chat can use them (review_status).
//
// Only what the site or Google literally says becomes a fact. A field the
// research does not show has no row. Prices, warranties, guarantees, years in
// business, and license numbers are never extracted here; Kelby can add them
// by hand. Reviews and ratings are never read.

const SNIPPET_MAX = 300;
const VALUE_MAX = 500;
const MAX_SERVICES = 8;
const MAX_TOWNS = 12;
const HOSTILE = /[\u0000-\u001F\u007F<>​-‏‪-‮⁠-⁤⁦-⁩﻿]/g;

// Service names a contractor site uses, longest first so "water heater repair"
// wins over "water heater". Matching is case-insensitive; the value keeps the
// site's own casing.
const SERVICE_PHRASES = [
  // HVAC
  'air conditioning repair', 'air conditioner repair', 'air conditioning installation', 'ac repair',
  'ac installation', 'ac replacement', 'furnace repair', 'furnace installation', 'furnace replacement',
  'heating repair', 'heat pump installation', 'heat pump repair', 'heat pumps', 'heat pump',
  'ductless mini-splits', 'ductless mini splits', 'ductless mini-split', 'ductless mini split', 'mini-splits',
  'duct cleaning', 'ductwork', 'thermostat installation', 'smart thermostats', 'indoor air quality',
  'air purifiers', 'humidifiers', 'evaporative coolers', 'swamp coolers', 'boiler repair', 'boilers',
  'hvac maintenance', 'furnace tune-ups', 'ac tune-ups', 'tune-ups', 'air conditioning', 'furnaces',
  // Plumbing
  'tankless water heaters', 'tankless water heater', 'water heater repair', 'water heater installation',
  'water heater replacement', 'water heaters', 'drain cleaning', 'hydro jetting', 'hydro-jetting',
  'sewer line repair', 'sewer line replacement', 'sewer repair', 'sewer lines', 'sewer camera inspection',
  'leak detection', 'leak repair', 'slab leak repair', 'repiping', 're-piping', 'water softeners',
  'water softener installation', 'water filtration', 'garbage disposals', 'garbage disposal repair',
  'toilet repair', 'faucet repair', 'gas line repair', 'gas lines', 'sump pumps', 'backflow testing',
  'frozen pipes',
  // Electrical
  'electrical panel upgrades', 'panel upgrades', 'panel upgrade', 'ev charger installation', 'ev chargers',
  'recessed lighting', 'lighting installation', 'outdoor lighting', 'ceiling fan installation',
  'whole-home generators', 'generator installation', 'generators', 'surge protection', 'rewiring',
  'outlet installation', 'electrical inspections', 'electrical repair',
  // Roofing
  'roof replacement', 'roof repair', 'roof inspections', 'roof inspection', 'metal roofing', 'flat roofs',
  'shingle roofing', 'gutter installation', 'gutter guards', 'gutters', 'skylights', 'storm damage repair',
  'hail damage', 'ice dam removal', 'roof leaks',
  // Landscaping
  'lawn care', 'lawn mowing', 'sprinkler repair', 'sprinkler installation', 'sprinkler blowouts',
  'sprinkler blowout', 'sprinkler systems', 'irrigation', 'aeration', 'fertilization', 'landscape design',
  'hardscaping', 'retaining walls', 'sod installation', 'tree trimming', 'tree removal', 'snow removal',
  'yard cleanup', 'spring cleanup', 'fall cleanup',
];

// Towns the Wasatch Front shops list. Case-sensitive on purpose: "Sandy" the
// city, not "sandy soil". Longest first so "South Salt Lake" is not read as
// "Salt Lake City".
const TOWNS = [
  'West Valley City', 'Cottonwood Heights', 'South Salt Lake', 'North Salt Lake', 'Saratoga Springs',
  'Salt Lake City', 'Eagle Mountain', 'American Fork', 'Pleasant Grove', 'Spanish Fork', 'Woodland Hills',
  'Washington Terrace', 'West Bountiful', 'Stansbury Park', 'Pleasant View', 'Fruit Heights',
  'South Jordan', 'West Jordan', 'South Ogden', 'North Ogden', 'Cedar Hills', 'Heber City', 'Park City',
  'West Valley', 'Woods Cross', 'Salt Lake County', 'Utah County', 'Davis County', 'Weber County',
  'Lehi', 'Orem', 'Provo', 'Alpine', 'Highland', 'Lindon', 'Vineyard', 'Mapleton', 'Springville',
  'Payson', 'Salem', 'Santaquin', 'Elk Ridge', 'Draper', 'Sandy', 'Riverton', 'Herriman', 'Bluffdale',
  'Midvale', 'Murray', 'Taylorsville', 'Holladay', 'Millcreek', 'Kearns', 'Magna', 'Bountiful',
  'Centerville', 'Farmington', 'Kaysville', 'Layton', 'Clearfield', 'Syracuse', 'Clinton', 'Ogden',
  'Roy', 'Riverdale', 'Harrisville', 'Hooper', 'Midway', 'Tooele', 'Grantsville', 'Logan',
];

const YES_PATTERNS = {
  emergency_247: /\b24\/7\b|\b24-7\b|\b24 hours a day\b|\b24-hour emergency\b|\bemergency (?:plumbing |hvac |heating |electrical |roofing )?services?\b/i,
  free_estimate: /\bfree (?:in-home )?(?:estimates?|quotes?)\b/i,
  financing: /\bfinancing (?:available|options?)\b|\b0% (?:apr|interest)\b|\bflexible financing\b|\bfinance options\b/i,
  maintenance_plan: /\bmaintenance (?:plans?|agreements?|club|membership|program)\b|\bservice (?:plans?|agreements?)\b|\bcomfort club\b|\bmembership plans?\b/i,
};

const LICENSED_INSURED = /\blicensed(?:,|\s+and|\s*&)\s*(?:bonded(?:,|\s+and|\s*&)\s*)?insured\b|\blicensed,\s*insured(?:,|\s+and|\s*&)\s*bonded\b/i;
const NEGATION = /\b(?:no|not|never|without|don't|do not|doesn't|does not)\b[^.]{0,20}$/i;

function escapeRe(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function phraseRe(phrase, flags) {
  const body = String(phrase).split(/[\s-]+/).filter(Boolean).map(escapeRe).join('[\\s-]+');
  return new RegExp(`(?<![A-Za-z0-9])${body}(?![A-Za-z0-9])`, flags);
}

// "Highland Drive" and "Murray Blvd" are streets, not service towns.
const STREET_AFTER = /^\s*(?:dr|drive|rd|road|blvd|boulevard|ave|avenue|st|street|pkwy|parkway|way|ln|lane|hwy|highway|cir|circle|ct|court)\b/i;

const SERVICE_RES = SERVICE_PHRASES.map((p) => ({ phrase: p, re: phraseRe(p, 'gi') }));
const TOWN_RES = TOWNS.map((t) => ({ phrase: t, re: phraseRe(t, 'g'), street: true }));

function clean(text, max) {
  const value = String(text ?? '').normalize('NFKC').replace(HOSTILE, ' ').replace(/\s+/g, ' ').trim();
  if (!value) return '';
  if ([...value].length <= max) return value;
  return [...value].slice(0, max).join('').trim();
}

// A verbatim window of page text around [start, end). It starts at the
// sentence that holds the match when that is close, else at a word edge, and
// ends at the next sentence end when there is one, else at a word edge.
function snippetAround(text, start, end) {
  const before = 120;
  const after = 160;
  let from = Math.max(0, start - before);
  let to = Math.min(text.length, end + after);
  const head = text.slice(from, start);
  const lead = Math.max(head.lastIndexOf('. '), head.lastIndexOf('! '), head.lastIndexOf('? '));
  if (lead !== -1) from += lead + 2;
  else if (from > 0) {
    const space = text.indexOf(' ', from);
    if (space !== -1 && space < start) from = space + 1;
  }
  const tail = text.slice(end, to);
  const stop = tail.search(/[.!?](\s|$)/);
  if (stop !== -1) to = end + stop + 1;
  else if (to < text.length) {
    const space = text.lastIndexOf(' ', to);
    if (space > end) to = space;
  }
  return clean(text.slice(from, to), SNIPPET_MAX);
}

function httpsUrl(value) {
  if (typeof value !== 'string' || value.length < 8 || value.length > 300) return null;
  if (!value.startsWith('https://') || /[\s\u0000-\u001F\u007F]/.test(value)) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password) return null;
    return value;
  } catch {
    return null;
  }
}

function googleUrl(research) {
  const url = httpsUrl(research?.google?.maps_url);
  if (!url) return null;
  const host = new URL(url).hostname.toLowerCase().replace(/\.$/, '');
  return host === 'google.com' || host.endsWith('.google.com') ? url : null;
}

function sitePages(research) {
  const pages = Array.isArray(research?.site?.pages) ? research.site.pages : [];
  return pages
    .map((page) => ({ url: httpsUrl(page?.url), text: typeof page?.text === 'string' ? page.text : '' }))
    .filter((page) => page.url && page.text);
}

function stripCompany(text, company) {
  const name = String(company || '').replace(/^TEST:\s*/i, '').trim();
  if (name.length < 3) return text;
  return text.replace(phraseRe(name, 'gi'), (m) => ' '.repeat(m.length));
}

// All non-overlapping hits of a phrase list on one page, in page order.
function hitsOn(text, list) {
  const taken = [];
  const hits = [];
  for (const { re, street } of list) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text)) !== null) {
      const start = m.index;
      const end = start + m[0].length;
      if (taken.some(([a, b]) => start < b && end > a)) continue;
      if (street && STREET_AFTER.test(text.slice(end, end + 12))) {
        taken.push([start, end]);
        continue;
      }
      taken.push([start, end]);
      hits.push({ start, end, text: m[0].replace(/\s+/g, ' ') });
    }
  }
  return hits.sort((a, b) => a.start - b.start);
}

function distinct(hits, limit) {
  const seen = new Set();
  const out = [];
  for (const hit of hits) {
    const key = hit.text.toLowerCase().replace(/[\s-]+/g, ' ');
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(hit);
    if (out.length >= limit) break;
  }
  return out;
}

// The page with the most distinct hits wins (the homepage on a tie), so the
// value, the source_url, and the snippet all come from one page.
function listFact(field, pages, list, limit, company) {
  let best = null;
  for (const page of pages) {
    const text = field === 'service_area' ? stripCompany(page.text, company) : page.text;
    const hits = distinct(hitsOn(text, list), limit);
    if (hits.length && (!best || hits.length > best.hits.length)) best = { page, hits };
  }
  if (!best) return null;
  const value = clean(best.hits.map((hit) => hit.text).join(', '), VALUE_MAX);
  const first = best.hits[0];
  const snippet = snippetAround(best.page.text, first.start, first.end);
  if (!value || !snippet) return null;
  return { field, value, source_url: best.page.url, snippet };
}

function yesFact(field, pages, re) {
  const global = new RegExp(re.source, 'gi');
  for (const page of pages) {
    global.lastIndex = 0;
    let m;
    while ((m = global.exec(page.text)) !== null) {
      const lead = page.text.slice(Math.max(0, m.index - 40), m.index);
      if (NEGATION.test(lead)) continue;
      const snippet = snippetAround(page.text, m.index, m.index + m[0].length);
      if (snippet) return { field, value: 'yes', source_url: page.url, snippet };
    }
  }
  return null;
}

function licenseFacts(pages) {
  for (const page of pages) {
    const m = LICENSED_INSURED.exec(page.text);
    if (!m) continue;
    const lead = page.text.slice(Math.max(0, m.index - 40), m.index);
    if (NEGATION.test(lead)) continue;
    const snippet = snippetAround(page.text, m.index, m.index + m[0].length);
    if (!snippet) continue;
    const out = [
      { field: 'license', value: 'yes', source_url: page.url, snippet },
      { field: 'insurance', value: 'yes', source_url: page.url, snippet },
    ];
    if (/bonded/i.test(m[0])) out.push({ field: 'bonding', value: 'yes', source_url: page.url, snippet });
    return out;
  }
  return [];
}

// "Monday: 8:00 AM – 5:00 PM" x7 -> "Monday–Friday: 8:00 AM – 5:00 PM; ..."
// Consecutive days with the same hours fold together. The snippet keeps
// Google's own lines.
function foldHours(lines) {
  const days = lines
    .map((line) => clean(line, 80))
    .map((line) => {
      const at = line.indexOf(':');
      return at > 0 ? { day: line.slice(0, at).trim(), hours: line.slice(at + 1).trim() } : null;
    });
  if (days.some((d) => !d || !d.day || !d.hours)) return clean(lines.join('; '), VALUE_MAX);
  const groups = [];
  for (const d of days) {
    const last = groups[groups.length - 1];
    if (last && last.hours === d.hours) last.to = d.day;
    else groups.push({ from: d.day, to: d.day, hours: d.hours });
  }
  return clean(groups.map((g) => `${g.from === g.to ? g.from : `${g.from}–${g.to}`}: ${g.hours}`).join('; '), VALUE_MAX);
}

function googleFacts(research) {
  const url = googleUrl(research);
  if (!url) return [];
  const out = [];
  const hours = research.google.hours;
  if (Array.isArray(hours) && hours.length && hours.every((line) => typeof line === 'string' && line.trim())) {
    const value = foldHours(hours);
    const snippet = clean(hours.join('; '), SNIPPET_MAX);
    if (value && snippet) out.push({ field: 'hours', value, source_url: url, snippet });
  }
  const business = research.business || {};
  const phone = clean(business.phone, 40);
  if (phone && /\d{3}.*\d{4}/.test(phone)) out.push({ field: 'phone', value: phone, source_url: url, snippet: phone });
  const address = clean(business.address, 200);
  if (address) out.push({ field: 'address', value: address, source_url: url, snippet: address });
  return out;
}

// A phone the site prints, when Google gave none.
function sitePhone(pages, phone) {
  const want = String(phone || '').replace(/\D/g, '').slice(-10);
  if (want.length !== 10) return null;
  const re = /\(?\b\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}\b/g;
  for (const page of pages) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(page.text)) !== null) {
      if (m[0].replace(/\D/g, '') !== want) continue;
      const snippet = snippetAround(page.text, m.index, m.index + m[0].length);
      if (snippet) return { field: 'phone', value: clean(m[0], 40), source_url: page.url, snippet };
    }
  }
  return null;
}

function extractFacts(research, { company = '' } = {}) {
  if (!research || typeof research !== 'object') return [];
  const pages = sitePages(research);
  const facts = [...googleFacts(research)];
  if (!facts.some((f) => f.field === 'phone')) {
    const phone = sitePhone(pages, research.business?.phone);
    if (phone) facts.push(phone);
  }
  const services = listFact('services', pages, SERVICE_RES, MAX_SERVICES, company);
  if (services) facts.push(services);
  const towns = listFact('service_area', pages, TOWN_RES, MAX_TOWNS, company || research.business?.company);
  if (towns) facts.push(towns);
  for (const [field, re] of Object.entries(YES_PATTERNS)) {
    const fact = yesFact(field, pages, re);
    if (fact) facts.push(fact);
  }
  facts.push(...licenseFacts(pages));
  return facts.map((fact) => ({ ...fact, source: 'cached_research' }));
}

module.exports = { extractFacts, foldHours, SERVICE_PHRASES, TOWNS };
