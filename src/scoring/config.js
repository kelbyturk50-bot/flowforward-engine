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
// (ceiling 77) after penalties, fit_boost, and the F-003 estimate signals.
// See that constant below. Those signals read prospects.research only.
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
// franchise: word-boundary match on company via isFranchise in
// src/scoring/prototypes.js, the same rule as the prototype picker (#47).
// "Trane Heating" and "Carrier HVAC" cap. "Constrane" and "Carriero" do not.
// The −20 franchisePenalty still uses a substring includes() and can fire
// when the cap does not. That mismatch is a follow-up; F-004 does not change
// the penalty. Both signals are cache only. computeFit and rescore do not fetch.
const TIER_CAP_FOR = {
  servicetitan: 'B',
  franchise: 'B',
};

// F-003 soft positive signals for Unsold-Estimate Recovery (issue #23).
// Points are final-score points. computeFit adds them after the 100/90 scale,
// in the same step as the franchise penalty, the ServiceTitan penalty, and
// fit_boost. TIER_CAP_FOR still runs after that sum, so a ServiceTitan or
// franchise lead cannot clear tier B by collecting these points.
//
// Evidence is the cached prospects.research object only: page text research
// already stored, mention booleans research already stored, and signature
// arrays research already stored. Unknown or missing evidence adds 0. There
// is no fetch, no new Places query, and no new collector.
//
// Text matches are word-boundary matches. "preplacement", "reinstallation",
// "refinancing", "freeestimate", and "free estimated" do not match.
// A negated phrase does not count. Verb negations keep a wide window and may
// cross a comma ("we do not offer financing", "we don't offer financing",
// "not offering installation", "we do not offer, at this time, any kind of
// financing", and "financing not available" after the phrase). "not" followed
// by "only" is not a verb negation. A bare "no" or "without" negates only
// when the phrase comes next, or with just any, a, an, or the in between
// ("no free estimates", "without any financing"). A curly apostrophe counts
// (don’t, doesn’t). "no-hassle", "no interest", and "no-cost" are not negations.
//
// HVAC only (Scout, PR #51; Gauge on the industry gate). A stored industry
// that is a non-HVAC trade scores 0 no matter what the company name or
// category says. Name and category are read only when the industry is empty,
// and only when that field has an HVAC term and no other trade word (lawn,
// tree, electric, pool, roofing, cleaning, and the rest).
// An industry counts when it is HVAC, "Air Conditioning" (or
// "air-conditioning"), or a combination that says heating, cooling, HVAC,
// AC, or furnace on a word boundary ("Plumbing & Heating", "Heating &
// Cooling", "Heating and Air", "HVAC & Plumbing"). "Heating Oil Delivery"
// and "Pool Heating" are not HVAC. "Plumber" and "Plumbing" alone are not.
// Landscaping and every other trade get no points, so a non-beachhead shop
// does not enter tier A on these signals. Summit's binding condition is still
// no plumbing score change. INDUSTRY_FIT.Plumbing stays 9. These points do
// not retune any industry weight or any tier threshold.
//
// replacement (+4). The wedge is an unsold replacement estimate. A shop that
// says it replaces equipment is selling the high-ticket job the pilot follows
// up, not a service call. A Utah replacement is the roughly $8k–$18k motion.
//
// installation (+3). Installation is the same new-equipment motion. It weighs
// less than replacement because the word also shows up on small add-on jobs.
//
// free_estimate (+4). The phrase "free estimate" means they write estimates,
// which is the inventory Unsold-Estimate Recovery is for. A cached
// mentions.free_estimates true also counts: research already recorded it.
// The word-boundary scan itself requires the two words "free estimate".
//
// financing (+3). The word "financing", or a lender signature research already
// filed (GreenSky, Wisetack, and the other SIGNATURES.financing names), means
// they sell jobs large enough to finance. Those are the estimates that go
// cold. An empty or missing signature list is not a penalty.
//
// quote_form (+3). A quote or contact form with no follow-up promise in the
// cached text is the heuristic that estimate requests arrive and then sit.
// Sources already in the cache: has_contact_form true, a quote_form or
// contact_form mention, the words "quote form" or "contact form", or a cached
// page whose path names estimate, quote, or contact. A promise such as
// "we'll follow up" turns this one signal off. Unknown form means 0.
//
// job_ad (+2). A comfort advisor, sales advisor, comfort consultant, or sales
// consultant means a replacement sales motion. Only when that role, or a
// job_ads entry that names it, is already in the cache. A title that merely
// contains "comfort" or "sales" (Comfort Technician, Parts Sales Clerk) does
// not count. Generic mentions.hiring does not count. No job-board lookup.
//
// search_ads (+2). A slight boost. Local Services Ads or search ads mean they
// buy estimate leads. Counted only from cache: a Google Ads signature in
// analytics_ads, or the phrases "local services ads", "google ads", or "LSA".
// Google Analytics, Meta Pixel, and CallRail are not this signal.
const ESTIMATE_SIGNAL_POINTS = {
  replacement: 4,
  installation: 3,
  free_estimate: 4,
  financing: 3,
  quote_form: 3,
  job_ad: 2,
  search_ads: 2,
};

// Case-insensitive words that mark an HVAC industry, or — only when that
// industry is empty — an HVAC category or company name. "ac" is the whole
// word, so "face" and "Plumbing" do not match. "a/c" is the slashed form.
// "Air Conditioning" is mapped separately. "Heating Oil Delivery" and
// "Pool Heating" are blocked before this list, so "heating" does not make
// them HVAC.
const ESTIMATE_SIGNAL_HVAC_WORDS = ['hvac', 'heating', 'cooling', 'furnace', 'ac', 'a/c'];

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
  INDUSTRY_FIT, SERVICETITAN_PENALTY, TIER_CAP_FOR, ESTIMATE_SIGNAL_POINTS,
  ESTIMATE_SIGNAL_HVAC_WORDS, EXCLUDED_INDUSTRIES, HOME_CITIES, HOME_STATE,
  FRANCHISE_PATTERNS, SOCIAL_HOSTS, TIERS,
};
