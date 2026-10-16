// Fit-score configuration — tune these to match how you sell.
//
// GTM beachhead until the Utah proof gate: residential HVAC is primary and
// plumbing is secondary, both aimed at owner-operated shops of about 2–15
// trucks that are not on ServiceTitan. Pest control stays excluded. Utah
// HOME_CITIES / HOME_STATE stay the geographic beachhead; do not widen them
// here. ServiceTitan is a soft penalty (SERVICETITAN_PENALTY, inside the
// accepted −12 to −18 band) read only from prospects.fsm_detected, which
// proposal research writes. computeFit and rescore never fetch a page.
// Jobber and Housecall Pro are not penalized. A missing or unknown cache
// is not treated as ServiceTitan, and the penalty never forces tier D.
// TIER_CAP_FOR then caps ServiceTitan and franchise matches at tier B
// (ceiling 77) after penalties and fit_boost. See that constant below.
//
// Business model being scored against: AI/workflow-automation consulting for
// owner-operated home service businesses in Utah. The ideal client is busy
// enough to feel the pain (steady call volume, lots of jobs), small enough that
// the owner makes the buying decision, reachable, and close enough to meet.

// Industry fit, 1–10. Defaults come from src/bot/industries.js; override here.
// Pest Control is intentionally absent: it is out of scope (see EXCLUDED_INDUSTRIES).
// Synonyms are normalized to that name in src/scoring/industry.js.
// HVAC+plumbing combo shops discovered on either query keep that query's label.
const INDUSTRY_FIT = {
  'HVAC':         10,  // primary beachhead: high ticket, dispatch + maintenance agreements
  'Plumbing':     9,   // secondary, including HVAC+plumbing combo shops
  'Electrical':   5,   // deprioritized for Pilot #1 (mostly construction)
  'Roofing':      5,   // deprioritized for Pilot #1
  'Landscaping':  3,   // weak wedge fit
  'Construction': 3,   // weak wedge fit
  'Painting':     3,   // weak wedge fit
  'Cleaning':     2,   // weak wedge fit
  'Gutters':      2,   // weak wedge fit; not in the discovery catalog
  'Windows':      2,   // weak wedge fit; not in the discovery catalog
};

// Soft downrank when cached research says ServiceTitan. Kept inside the
// F-002 band of −12 to −18. Applied after the 0–100 scale, same as franchise.
const SERVICETITAN_PENALTY = -15;

// After penalties and fit_boost, these signals cannot score above the named
// tier. computeFit derives the ceiling from TIERS: one point below the next
// higher tier, so B is 77 while A still starts at 78. The −15 and −20 still
// apply; a score already at or below the ceiling is left alone. This is not
// a hard exclusion and it does not force tier D.
//
// servicetitan: prospects.fsm_detected, case-insensitive, same match as
// SERVICETITAN_PENALTY. Null, blank, "none", Jobber, Housecall Pro, and any
// other value are not capped.
// franchise: FRANCHISE_PATTERNS on company, the same match as the −20.
// Both read the cache only. computeFit and rescore do not fetch.
const TIER_CAP_FOR = {
  servicetitan: 'B',
  franchise: 'B',
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
  'one hour heating', 'one hour air', 'one hour', 'aire serv', 'service experts', 'carrier', 'trane', 'lennox',
  'mr. electric', 'mr electric', 'mister sparky', 'mosquito joe', 'mosquito squad',
  'trugreen', 'lawn doctor', 'weed man', 'brightview', 'davey tree', 'bartlett tree',
  'merry maids', 'molly maid', 'the maids', 'servpro', 'servicemaster', 'stanley steemer', 'chem-dry',
  'certapro', 'five star painting', 'fish window', 'window genie', 'men in kilts', 'home depot', 'lowe\'s',
  'leaf filter', 'leaffilter', 'power home remodeling', 'bath fitter', 're-bath', 'neighborly',
];

// Generic hosts that mean "no real website".
const SOCIAL_HOSTS = ['facebook.com', 'instagram.com', 'yelp.com', 'nextdoor.com', 'google.com', 'business.site', 'linktr.ee', 'angi.com', 'homeadvisor.com', 'thumbtack.com'];

// Tier thresholds (fit_score 0–100).
// A = best fit: owner-operated, busy but not systemized, pain signals in reviews
// B = solid fit: worth outreach, may need more convincing
// C = marginal: worth a shot if pipeline is thin
// D = not a fit: too small, too big, franchise, or out of market
const TIERS = [
  { tier: 'A', min: 78 },
  { tier: 'B', min: 62 },
  { tier: 'C', min: 47 },
  { tier: 'D', min: 0 },
];

// Trades FlowForward does not sell to. One list, shared by discovery, fit scoring,
// and proposal drafting. Default is Pest Control. Override with
// EXCLUDED_INDUSTRIES="A,B" (comma-separated). An empty value clears the list.
const EXCLUDED_INDUSTRIES = (process.env.EXCLUDED_INDUSTRIES ?? 'Pest Control')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

module.exports = {
  INDUSTRY_FIT, SERVICETITAN_PENALTY, TIER_CAP_FOR, EXCLUDED_INDUSTRIES, HOME_CITIES, HOME_STATE,
  FRANCHISE_PATTERNS, SOCIAL_HOSTS, TIERS,
};
