// Approved demo businesses for the live chat facts sheet.
// Real names and brand colors. No logos. Phones are 555-01xx.
// These rows are not inserted on boot. The public demo reads this module.
// test_tag is the TEST: tag used if a row is written in a test.

const { banner, disclosure, perGoogle } = require('./copy');
const { brandNameOk } = require('../prototypes/brand-name');

const CHIPS = Object.freeze([
  Object.freeze({ id: 'chip_emergency', label: 'My water heater is leaking all over the garage' }),
  Object.freeze({ id: 'chip_booking', label: 'Can someone come out Tuesday?' }),
  Object.freeze({ id: 'chip_price', label: 'How much for a new furnace?' }),
  Object.freeze({ id: 'chip_hours', label: 'Are you open Saturday?' }),
]);

function areaChip(town) {
  return Object.freeze({
    id: 'chip_area',
    label: town ? `Do you service ${town}?` : 'Do you service this area?',
  });
}

function firstTown(serviceArea) {
  return String(serviceArea || '').split(',')[0].trim();
}

function fact(field, value) {
  return Object.freeze({
    field,
    value,
    source: 'fixture',
    source_url: null,
    snippet: null,
    per_google: false,
  });
}

function build(spec) {
  if (!brandNameOk(spec.business_name)) throw new Error('demo brand name');
  const facts = spec.facts.map((row) => Object.freeze({
    ...row,
    per_google: perGoogle(row),
  }));
  const byField = new Map(facts.map((row) => [row.field, row.value]));
  const town = firstTown(byField.get('service_area'));
  return Object.freeze({
    slug: spec.slug,
    business_name: spec.business_name,
    colors: Object.freeze({ primary: spec.primary, secondary: spec.secondary }),
    phone: spec.phone,
    test_tag: spec.test_tag,
    time_zone: byField.get('time_zone') || 'America/Denver',
    banner: banner(spec.business_name),
    disclosure: disclosure(spec.business_name, spec.phone),
    facts,
    chips: Object.freeze([...CHIPS, areaChip(town)]),
  });
}

const DEMOS = Object.freeze([
  build({
    slug: 'wasatch-heating',
    business_name: 'Wasatch Heating',
    primary: '#1b4f72',
    secondary: '#f4d03f',
    phone: '(801) 555-0101',
    test_tag: 'TEST:wasatch-heating',
    facts: [
      fact('business_name', 'Wasatch Heating'),
      fact('services', 'Heating and cooling, water heaters, furnaces'),
      fact('service_area', 'Salt Lake City, Provo'),
      fact('phone', '(801) 555-0101'),
      fact('hours', 'Monday–Friday, 8:00 AM–5:00 PM'),
      fact('time_zone', 'America/Denver'),
      fact('free_estimate', 'yes'),
      fact('emergency_247', 'yes'),
    ],
  }),
  build({
    slug: 'canyon-plumbing',
    business_name: 'Canyon Plumbing',
    primary: '#0e4d3a',
    secondary: '#e8f0ec',
    phone: '(801) 555-0102',
    test_tag: 'TEST:canyon-plumbing',
    facts: [
      fact('business_name', 'Canyon Plumbing'),
      fact('services', 'Water heaters, drain cleaning'),
      fact('service_area', 'Provo, Orem'),
      fact('phone', '(801) 555-0102'),
      fact('hours', 'Monday–Friday, 8:00 AM–5:00 PM'),
      fact('time_zone', 'America/Denver'),
    ],
  }),
]);

function listDemos() {
  return DEMOS;
}

function demoBySlug(slug) {
  return DEMOS.find((demo) => demo.slug === slug) || null;
}

function chipsFor(serviceArea) {
  return Object.freeze([...CHIPS, areaChip(firstTown(serviceArea))]);
}

function chipLabel(id, serviceArea) {
  const chip = chipsFor(serviceArea).find((item) => item.id === id);
  return chip ? chip.label : null;
}

module.exports = { DEMOS, listDemos, demoBySlug, chipLabel, chipsFor, firstTown };
