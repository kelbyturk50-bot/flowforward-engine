// Fit-score configuration — tune these to match how you sell.
//
// Business model being scored against: AI/workflow-automation consulting for
// owner-operated home service businesses in Utah. The ideal client is busy
// enough to feel the pain (steady call volume, lots of jobs), small enough that
// the owner makes the buying decision, reachable, and close enough to meet.

// Industry fit, 1–10. Defaults come from src/bot/industries.js; override here.
const INDUSTRY_FIT = {
  'Pest Control': 9,   // recurring service routes, heavy scheduling + follow-up
  'HVAC':         9,   // high ticket, dispatch + maintenance agreements
  'Plumbing':     8,
  'Roofing':      8,   // lead follow-up, estimates, insurance paperwork
  'Electrical':   7,
  'Landscaping':  7,   // recurring routes, seasonal booking surges
  'Construction': 6,
  'Painting':     6,
  'Cleaning':     6,
  'Gutters':      5,
  'Windows':      5,
};

// Cities you can meet in person (case-insensitive). Override with env
// FIT_HOME_CITIES="Saratoga Springs,Lehi,..."
const HOME_CITIES = (process.env.FIT_HOME_CITIES ||
  'Saratoga Springs,Lehi,Eagle Mountain,American Fork,Pleasant Grove,Lindon,Orem,Provo,' +
  'Springville,Spanish Fork,Highland,Alpine,Cedar Hills,Vineyard,Bluffdale,Draper,Riverton,' +
  'Herriman,South Jordan,West Jordan,Sandy,Midvale,Murray,Taylorsville,West Valley City,' +
  'Salt Lake City,Cottonwood Heights,Holladay,Millcreek,South Salt Lake,Kearns,Magna,Payson,Mapleton,Salem')
  .split(',').map(s => s.trim().toLowerCase()).filter(Boolean);

const HOME_STATE = (process.env.FIT_HOME_STATE || 'UT').toUpperCase();

// National brands / franchises — corporate ops teams, long sales cycles.
const FRANCHISE_PATTERNS = [
  'terminix', 'orkin', 'rollins', 'truly nolen', 'aptive', 'ecoshield', 'rentokil', 'abc home',
  'roto-rooter', 'roto rooter', 'mr. rooter', 'mr rooter', 'benjamin franklin plumbing',
  'one hour heating', 'one hour air', 'aire serv', 'service experts', 'carrier', 'trane', 'lennox',
  'mr. electric', 'mr electric', 'mister sparky', 'mosquito joe', 'mosquito squad',
  'trugreen', 'lawn doctor', 'weed man', 'brightview', 'davey tree', 'bartlett tree',
  'merry maids', 'molly maid', 'the maids', 'servpro', 'servicemaster', 'stanley steemer', 'chem-dry',
  'certapro', 'five star painting', 'fish window', 'window genie', 'men in kilts', 'home depot', 'lowe\'s',
  'leaf filter', 'leaffilter', 'power home remodeling', 'bath fitter', 're-bath', 'neighborly',
];

// Generic hosts that mean "no real website".
const SOCIAL_HOSTS = ['facebook.com', 'instagram.com', 'yelp.com', 'nextdoor.com', 'google.com', 'business.site', 'linktr.ee', 'angi.com', 'homeadvisor.com', 'thumbtack.com'];

const TIERS = [
  { tier: 'A', min: 80 },
  { tier: 'B', min: 65 },
  { tier: 'C', min: 50 },
  { tier: 'D', min: 0 },
];

module.exports = { INDUSTRY_FIT, HOME_CITIES, HOME_STATE, FRANCHISE_PATTERNS, SOCIAL_HOSTS, TIERS };
