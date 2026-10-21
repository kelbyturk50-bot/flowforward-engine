// Sample copy for the prototype page, by trade. Everything here is generic
// and fictional: no claims about the real business (hours, licenses,
// guarantees, ratings), no reviews or testimonials, no ROI figures.
// Customer names, phones, and amounts are samples and get a Sample tag.

const TRADES = {
  hvac: {
    match: /hvac|heating|cooling|air cond|furnace|\bac\b/i,
    noun: 'heating & air',
    hero: 'Heating and air for {city} homes',
    sub: 'Furnace and AC repair, replacement, and tune-ups. Book a visit online or ask for a free estimate.',
    services: [
      ['Furnace repair', 'No heat, short cycling, strange smells or noises.'],
      ['AC repair', 'Warm air, frozen lines, a unit that won\'t kick on.'],
      ['System replacement', 'Good, better, best options on new equipment.'],
      ['Tune-ups', 'Seasonal checkups before the first hot or cold week.'],
      ['Thermostats', 'Smart thermostat installs and setup.'],
      ['Indoor air quality', 'Filters, humidifiers, and air purifiers.'],
    ],
    estimate: { job: 'Furnace replacement', options: [['Good', 9800], ['Better', 14800], ['Best', 19600]], pick: 1 },
    leadJob: 'AC replacement quote',
    urgent: { ask: 'AC stopped blowing cold and the upstairs is 84°. Can someone come out?', tag: 'No cooling' },
    question: 'Is there financing on the Better option?',
  },
  plumbing: {
    match: /plumb|drain|sewer|water heater|rooter/i,
    noun: 'plumbing',
    hero: 'Plumbing for {city} homes',
    sub: 'Water heaters, drains, leaks, and repipes. Book a visit online or ask for a free estimate.',
    services: [
      ['Water heaters', 'Repair and replacement, tank and tankless.'],
      ['Drain cleaning', 'Slow or backed-up sinks, tubs, and main lines.'],
      ['Leak repair', 'Pipes, fixtures, and slab leaks.'],
      ['Repipes', 'Whole-home and partial repipes.'],
      ['Fixtures', 'Faucets, toilets, disposals installed.'],
      ['Sewer lines', 'Camera inspection and line repair.'],
    ],
    estimate: { job: 'Tankless water heater', options: [['Good', 3400], ['Better', 4600], ['Best', 5900]], pick: 1 },
    leadJob: 'Water heater replacement',
    urgent: { ask: 'Water heater is leaking all over the garage floor. Can you come today?', tag: 'Active leak' },
    question: 'How long does the install take?',
  },
  electrical: {
    match: /electric/i,
    noun: 'electrical',
    hero: 'Electrical work for {city} homes',
    sub: 'Panels, EV chargers, lighting, and repairs. Book a visit online or ask for a free estimate.',
    services: [
      ['Panel upgrades', 'More capacity for new appliances and additions.'],
      ['EV chargers', 'Level 2 charger installs.'],
      ['Lighting', 'Recessed, outdoor, and fixture installs.'],
      ['Outlets & switches', 'New circuits, GFCI, and repairs.'],
      ['Generators', 'Standby generator hookups.'],
      ['Inspections', 'Safety checks for older homes.'],
    ],
    estimate: { job: 'Panel upgrade to 200A', options: [['Good', 2600], ['Better', 3400], ['Best', 4200]], pick: 1 },
    leadJob: 'EV charger install',
    urgent: { ask: 'Half the house just lost power and the breaker won\'t reset.', tag: 'Partial outage' },
    question: 'Do you pull the permit?',
  },
  roofing: {
    match: /roof/i,
    noun: 'roofing',
    hero: 'Roofing for {city} homes',
    sub: 'Repairs, replacements, and inspections. Book a visit online or ask for a free estimate.',
    services: [
      ['Roof repair', 'Leaks, missing shingles, flashing.'],
      ['Replacement', 'Full tear-off and new roof.'],
      ['Inspections', 'Pre-sale and storm-season checks.'],
      ['Gutters', 'Install, repair, and guards.'],
      ['Skylights', 'Install and reseal.'],
      ['Snow & ice', 'Ice dam prevention.'],
    ],
    estimate: { job: 'Roof replacement', options: [['Good', 11800], ['Better', 14900], ['Best', 18700]], pick: 1 },
    leadJob: 'Roof inspection',
    urgent: { ask: 'Water is coming through the ceiling after the storm.', tag: 'Active leak' },
    question: 'How long would the job take?',
  },
  landscaping: {
    match: /landscap|lawn|yard|tree|sprinkler|irrigation/i,
    noun: 'landscaping',
    hero: 'Lawn and landscape care for {city} homes',
    sub: 'Maintenance, sprinklers, and yard projects. Book a visit online or ask for a free estimate.',
    services: [
      ['Lawn care', 'Mowing, edging, and fertilizing.'],
      ['Sprinklers', 'Startups, repairs, and blowouts.'],
      ['Cleanups', 'Spring and fall cleanups.'],
      ['Planting', 'Trees, shrubs, and beds.'],
      ['Hardscape', 'Patios, walls, and paths.'],
      ['Snow removal', 'Driveways and walks.'],
    ],
    estimate: { job: 'Backyard refresh', options: [['Good', 4200], ['Better', 6800], ['Best', 9500]], pick: 1 },
    leadJob: 'Sprinkler repair',
    urgent: { ask: 'A sprinkler line broke and it\'s flooding the side yard.', tag: 'Broken line' },
    question: 'When could you start?',
  },
  general: {
    match: /./,
    noun: 'home services',
    hero: 'Home services for {city}',
    sub: 'Repairs, installs, and maintenance. Book a visit online or ask for a free estimate.',
    services: [
      ['Repairs', 'Fast fixes for the things that break.'],
      ['Installs', 'New equipment, set up right.'],
      ['Maintenance', 'Seasonal checkups.'],
      ['Estimates', 'Clear options before any work starts.'],
      ['Projects', 'Bigger jobs, planned with you.'],
      ['Inspections', 'A second set of eyes.'],
    ],
    estimate: { job: 'Project estimate', options: [['Good', 2400], ['Better', 3600], ['Best', 4800]], pick: 1 },
    leadJob: 'Repair visit',
    urgent: { ask: 'Something broke this afternoon. Can someone take a look?', tag: 'Repair' },
    question: 'What does the Better option include?',
  },
};

function tradeFor(industry) {
  const text = String(industry || '');
  for (const key of ['hvac', 'plumbing', 'electrical', 'roofing', 'landscaping']) {
    if (TRADES[key].match.test(text)) return { key, ...TRADES[key] };
  }
  return { key: 'general', ...TRADES.general };
}

const AGENTS = {
  estimate_followup: {
    tab: 'Estimate follow-up',
    title: 'Every open estimate gets followed up',
    lead: 'A few emails from your own inbox after you send a quote. They stop the moment the customer replies, and you get a nudge to call when someone keeps opening it.',
  },
  speed_to_lead: {
    tab: 'Web lead reply',
    title: 'Website leads get an answer in under a minute',
    lead: 'When someone fills out your estimate form, even at 9pm, they get a reply right away with times to pick from.',
  },
  receptionist: {
    tab: 'Missed-call text-back',
    title: 'Missed calls get a text back',
    lead: 'If you can\'t pick up, the caller gets a text within a minute, and the job gets booked over text.',
  },
  scheduling: {
    tab: 'Online booking',
    title: 'Customers book a visit themselves',
    lead: 'Pick a service, pick a time, done. It shows up on your schedule with the details you need.',
  },
};

module.exports = { TRADES, tradeFor, AGENTS };
