// Sample copy for the prototype homepage, by trade. Generic and literal,
// the way real contractor sites read ("Drain Cleaning in Lehi, UT"). No
// claims about the real business (hours, 24/7, licenses, guarantees,
// ratings, years, prices), no reviews or testimonials, no ROI figures.
// Customer names, phones, and amounts are samples.

const TRADES = {
  hvac: {
    match: /hvac|heating|cooling|air cond|furnace|\bac\b/i,
    label: 'Heating & Air',
    heroLine: 'Heating & Air Conditioning in {city}, Utah',
    sub: 'Furnace and AC repair, replacement, and tune-ups for {city} homes. Book a visit online or ask for a free estimate.',
    glyph: 'flame',
    services: [
      ['AC Repair', 'snowflake', ['Warm air or no air', 'Frozen lines', 'Won\'t turn on']],
      ['Furnace Repair', 'flame', ['No heat', 'Short cycling', 'Strange smells or noises']],
      ['AC & Furnace Install', 'unit', ['Good, better, best options', 'Old system removal']],
      ['Tune-Ups', 'wrench', ['Spring AC check', 'Fall furnace check']],
      ['Thermostats', 'thermostat', ['Smart thermostat installs', 'Setup and wiring']],
      ['Indoor Air Quality', 'fan', ['Filters and purifiers', 'Humidifiers']],
      ['Ductwork', 'duct', ['Duct repair', 'Airflow problems']],
    ],
    featured: ['No Heat or No AC?', 'Book the soonest open time online, or call and we\'ll text you back.'],
    band: 'Furnace acting up or AC blowing warm?',
    closer: 'Need heating or AC help in {city}?',
    estimate: { job: 'Furnace replacement', options: [['Good', 9800], ['Better', 14800], ['Best', 19600]], pick: 1 },
    formJobs: ['AC repair', 'Furnace repair', 'New AC or furnace', 'Tune-up', 'Something else'],
    urgent: { ask: 'AC stopped blowing cold and the upstairs is 84°. Can someone come out?', tag: 'No cooling' },
    question: 'Is there financing on the Better option?',
    nav: ['AC Repair', 'Furnace Repair', 'Installs'],
  },
  plumbing: {
    match: /plumb|drain|sewer|water heater|rooter/i,
    label: 'Plumbing & Drain',
    heroLine: 'Plumbing & Drain Cleaning in {city}, Utah',
    sub: 'Clogged drains, water heaters, leaks, and repipes for {city} homes. Book a visit online or ask for a free estimate.',
    glyph: 'drop',
    services: [
      ['Drain Cleaning', 'drain', ['Kitchen and bath clogs', 'Main line backups', 'Camera inspection']],
      ['Water Heaters', 'heater', ['Repair and replacement', 'Tank and tankless']],
      ['Leak Repair', 'drop', ['Pipes and fittings', 'Slab and wall leaks']],
      ['Sewer Lines', 'pipe', ['Root intrusion', 'Line repair']],
      ['Toilets & Faucets', 'faucet', ['Repairs and installs', 'Running toilets']],
      ['Water Softeners', 'softener', ['Installs and service', 'Hard water fixes']],
      ['Repiping', 'wrench', ['Whole-home repipes', 'Partial repipes']],
    ],
    featured: ['Clogged Drain or No Hot Water?', 'Book the soonest open time online, or call and we\'ll text you back.'],
    band: 'Got a clogged drain or no hot water?',
    closer: 'Need a plumber in {city}?',
    estimate: { job: 'Tankless water heater', options: [['Good', 3400], ['Better', 4600], ['Best', 5900]], pick: 1 },
    formJobs: ['Drain cleaning', 'Water heater', 'Leak', 'Sewer line', 'Something else'],
    urgent: { ask: 'Water heater is leaking all over the garage floor. Can you come today?', tag: 'Active leak' },
    question: 'How long does the install take?',
    nav: ['Drain Cleaning', 'Water Heaters', 'Leak Repair'],
  },
  electrical: {
    match: /electric/i,
    label: 'Electrical',
    heroLine: 'Electricians in {city}, Utah',
    sub: 'Panels, EV chargers, lighting, and repairs for {city} homes. Book a visit online or ask for a free estimate.',
    glyph: 'bolt',
    services: [
      ['Panel Upgrades', 'panel', ['More capacity', 'Old panel replacement']],
      ['EV Chargers', 'bolt', ['Level 2 installs', 'Dedicated circuits']],
      ['Lighting', 'bulb', ['Recessed and outdoor', 'Fixture installs']],
      ['Outlets & Switches', 'outlet', ['New circuits', 'GFCI and repairs']],
      ['Generators', 'unit', ['Standby hookups', 'Transfer switches']],
      ['Inspections', 'check', ['Older homes', 'Pre-sale checks']],
      ['Troubleshooting', 'wrench', ['Tripping breakers', 'Flickering lights']],
    ],
    featured: ['Breaker Keeps Tripping?', 'Book the soonest open time online, or call and we\'ll text you back.'],
    band: 'Lights flickering or a breaker that won\'t reset?',
    closer: 'Need an electrician in {city}?',
    estimate: { job: 'Panel upgrade to 200A', options: [['Good', 2600], ['Better', 3400], ['Best', 4200]], pick: 1 },
    formJobs: ['Panel upgrade', 'EV charger', 'Lighting', 'Repair', 'Something else'],
    urgent: { ask: 'Half the house just lost power and the breaker won\'t reset.', tag: 'Partial outage' },
    question: 'Do you pull the permit?',
    nav: ['Panels', 'EV Chargers', 'Lighting'],
  },
  roofing: {
    match: /roof/i,
    label: 'Roofing',
    heroLine: 'Roofing in {city}, Utah',
    sub: 'Repairs, replacements, and inspections for {city} homes. Book an inspection online or ask for a free estimate.',
    glyph: 'house',
    services: [
      ['Roof Repair', 'house', ['Leaks and missing shingles', 'Flashing']],
      ['Roof Replacement', 'house', ['Full tear-off', 'Material options']],
      ['Inspections', 'check', ['Pre-sale', 'Storm checks']],
      ['Gutters', 'pipe', ['Installs and repair', 'Gutter guards']],
      ['Skylights', 'bulb', ['Installs', 'Reseals']],
      ['Snow & Ice', 'snowflake', ['Ice dam prevention', 'Heat cables']],
      ['Storm Damage', 'wrench', ['Tarping', 'Insurance photos']],
    ],
    featured: ['Leak After the Storm?', 'Book the soonest inspection online, or call and we\'ll text you back.'],
    band: 'Missing shingles or a new leak?',
    closer: 'Need a roofer in {city}?',
    estimate: { job: 'Roof replacement', options: [['Good', 11800], ['Better', 14900], ['Best', 18700]], pick: 1 },
    formJobs: ['Roof repair', 'Replacement', 'Inspection', 'Gutters', 'Something else'],
    urgent: { ask: 'Water is coming through the ceiling after the storm.', tag: 'Active leak' },
    question: 'How long would the job take?',
    nav: ['Repair', 'Replacement', 'Inspections'],
  },
  landscaping: {
    match: /landscap|lawn|yard|tree|sprinkler|irrigation/i,
    label: 'Lawn & Landscape',
    heroLine: 'Lawn Care & Landscaping in {city}, Utah',
    sub: 'Maintenance, sprinklers, cleanups, and yard projects for {city} homes. Book a visit online or ask for a free estimate.',
    glyph: 'leaf',
    services: [
      ['Lawn Care', 'leaf', ['Mowing and edging', 'Fertilizing']],
      ['Sprinklers', 'drop', ['Startups and repairs', 'Fall blowouts']],
      ['Cleanups', 'wrench', ['Spring and fall', 'Leaf removal']],
      ['Planting', 'leaf', ['Trees and shrubs', 'Flower beds']],
      ['Hardscape', 'house', ['Patios and walls', 'Paths']],
      ['Snow Removal', 'snowflake', ['Driveways', 'Walks']],
      ['Tree Trimming', 'leaf', ['Pruning', 'Removal']],
    ],
    featured: ['Sprinkler Line Broke?', 'Book the soonest open time online, or call and we\'ll text you back.'],
    band: 'Yard getting away from you?',
    closer: 'Need yard help in {city}?',
    estimate: { job: 'Backyard refresh', options: [['Good', 4200], ['Better', 6800], ['Best', 9500]], pick: 1 },
    formJobs: ['Lawn care', 'Sprinklers', 'Cleanup', 'Landscape project', 'Something else'],
    urgent: { ask: 'A sprinkler line broke and it\'s flooding the side yard.', tag: 'Broken line' },
    question: 'When could you start?',
    nav: ['Lawn Care', 'Sprinklers', 'Projects'],
  },
  general: {
    match: /./,
    label: 'Home Services',
    heroLine: 'Home Repair & Service in {city}, Utah',
    sub: 'Repairs, installs, and maintenance for {city} homes. Book a visit online or ask for a free estimate.',
    glyph: 'house',
    services: [
      ['Repairs', 'wrench', ['Fast fixes', 'Same visit when possible']],
      ['Installs', 'unit', ['New equipment', 'Set up right']],
      ['Maintenance', 'check', ['Seasonal checkups', 'Service plans']],
      ['Estimates', 'clipboard', ['Clear options', 'Before work starts']],
      ['Projects', 'house', ['Bigger jobs', 'Planned with you']],
      ['Inspections', 'check', ['A second look', 'Written notes']],
      ['Emergencies', 'bolt', ['Urgent repairs', 'Call or text']],
    ],
    featured: ['Something Broke Today?', 'Book the soonest open time online, or call and we\'ll text you back.'],
    band: 'Something need fixing?',
    closer: 'Need help in {city}?',
    estimate: { job: 'Project estimate', options: [['Good', 2400], ['Better', 3600], ['Best', 4800]], pick: 1 },
    formJobs: ['Repair', 'Install', 'Maintenance', 'Something else'],
    urgent: { ask: 'Something broke this afternoon. Can someone take a look?', tag: 'Repair' },
    question: 'What does the Better option include?',
    nav: ['Repairs', 'Installs', 'Maintenance'],
  },
};

function tradeFor(industry) {
  const text = String(industry || '');
  for (const key of ['hvac', 'plumbing', 'electrical', 'roofing', 'landscaping']) {
    if (TRADES[key].match.test(text)) return { key, ...TRADES[key] };
  }
  return { key: 'general', ...TRADES.general };
}

// Nearby towns for the service-area list. Public place names only; the shop
// would confirm its real list. Unknown cities show just the city.
const AREAS = {
  'Utah County': ['Lehi', 'Saratoga Springs', 'Eagle Mountain', 'American Fork', 'Pleasant Grove', 'Lindon', 'Orem', 'Provo', 'Springville', 'Spanish Fork', 'Mapleton', 'Payson', 'Highland', 'Alpine', 'Cedar Hills', 'Salem', 'Vineyard'],
  'Salt Lake County': ['Salt Lake City', 'West Valley City', 'West Jordan', 'South Jordan', 'Sandy', 'Draper', 'Riverton', 'Herriman', 'Murray', 'Taylorsville', 'Midvale', 'Cottonwood Heights', 'Holladay', 'Bluffdale', 'Millcreek'],
  'Davis & Weber': ['Bountiful', 'Centerville', 'Farmington', 'Kaysville', 'Layton', 'Clearfield', 'Syracuse', 'Ogden', 'Roy', 'Riverdale', 'North Salt Lake', 'Woods Cross'],
};

function serviceArea(city) {
  const c = String(city || '').trim().toLowerCase();
  for (const [county, towns] of Object.entries(AREAS)) {
    const i = towns.findIndex(t => t.toLowerCase() === c);
    if (i < 0) continue;
    const others = towns.filter((_, j) => j !== i)
      .sort((a, b) => Math.abs(towns.indexOf(a) - i) - Math.abs(towns.indexOf(b) - i))
      .slice(0, 8);
    return { county, towns: [towns[i], ...others].sort() };
  }
  return { county: null, towns: city ? [String(city).trim()] : [] };
}

const AGENTS = {
  estimate_followup: { name: 'Estimate follow-up', how: 'Request a free estimate, then see the follow-up schedule' },
  speed_to_lead: { name: 'Instant reply to web leads', how: 'Fill out the free-estimate form' },
  receptionist: { name: 'Missed-call text-back', how: 'Tap any phone number' },
  scheduling: { name: 'Online booking', how: 'Tap any Schedule Service button' },
};

module.exports = { TRADES, tradeFor, serviceArea, AGENTS };
