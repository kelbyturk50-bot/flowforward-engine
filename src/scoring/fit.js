// Fit scoring — ranks each lead 0–100 on how well it matches the consulting
// business model, with a human-readable breakdown stored in fit_reasons.
//
//   Industry fit      30  how much automation leverage the trade has (HVAC 10, plumbing 9)
//   Business size     25  review volume as a 2–15 truck proxy (max at 25–200 reviews)
//   Reputation        10  Google rating (3.8–4.3 = pain signal = highest score)
//   Reachability      15  real website + phone
//   Location          10  inside your drive-to market
//   Franchise        -20  national brands / franchises
//   ServiceTitan   −15    only when prospects.fsm_detected says ServiceTitan (no fetch)
//   Estimate signals      ESTIMATE_SIGNAL_POINTS from cached prospects.research only
//                         (replacement, installation, free estimate, financing,
//                         quote/contact form, job ad, search ads). Unknown = 0.
//                         HVAC only. A stored non-HVAC industry scores 0.
//                         Name and category count only when industry is empty.
//                         Plumbing and Plumber alone are not boosted. No fetch.
//   Manual boost  ±20     your own adjustment (fit_boost)
//   Tier cap             TIER_CAP_FOR: ServiceTitan, and a word-boundary franchise, cannot exceed tier B
//                         Applied after the estimate signals.
//   Excluded industry      EXCLUDED_INDUSTRIES (default Pest Control) → score 0, tier D
//
// Key insight: businesses with 600+ reviews and 4.7+ stars are already systemized.
// The winnable client has about 25–200 reviews (a busy 2–15 truck owner-op)
// and a 3.8–4.3 rating (good enough to keep getting work, bad enough to feel the pain).
// ServiceTitan is a weaker fit for an owned build. The −15 is soft and does not
// force tier D. Jobber / Housecall Pro are not penalized. After penalties,
// fit_boost, and the cached estimate signals, ServiceTitan and a word-boundary
// franchise match are capped at tier B. The −20 still uses a substring match;
// that is a separate follow-up. The estimate signals read prospects.research
// only, and only for an HVAC lead. A stored non-HVAC industry scores 0 even
// when the name or category matches. Name and category count only when the
// industry is empty, and only when that field has an HVAC term and no other
// trade word. Air Conditioning counts. Heating Oil Delivery and Pool
// Heating do not. A missing cache adds nothing. Plumbing, Plumber, and every
// other trade are not boosted. A verb negation can sit well before the phrase.
// A bare "no" or "without" negates only with an optional any, a, an, or the
// between it and the phrase.

const pool = require('../db/client');
const INDUSTRIES = require('../bot/industries');
const cfg = require('./config');
const { isExcludedIndustry, normalizeIndustry } = require('./industry');
const { isFranchise } = require('./prototypes');
const { estimateSignalAdjustment } = require('./estimate-signals');

const industryDefaults = {};
for (const { industry, score } of INDUSTRIES) {
  industryDefaults[industry] = Math.max(industryDefaults[industry] || 0, score);
}

function industryFit(industry) {
  return cfg.INDUSTRY_FIT[industry] ?? industryDefaults[industry] ?? 5;
}

// Rough proxy (tunable): shops with ~25–200 Google reviews ≈ busy 2–15 truck
// owner-ops; <10 too thin; >600 likely past the sweet spot / more systemized.
// There is no truck-count field. Points are out of 25.
//
//   reviews     pts   tone
//   0           2     low — brand new / inactive
//   1–9         6     low — too small / budget risk
//   10–24      14     mid — small but established
//   25–200     25     max — 2–15 truck sweet spot (was 25–150)
//   201–400    18     mid-high — growing; may be adding systems
//   401–600    11     mid — likely office staff / >15 trucks
//   601–1500    6     low — big player
//   >1500       2     minimal — enterprise
function sizePoints(reviews) {
  const n = Number(reviews) || 0;
  if (n === 0)    return [2,  'No reviews — may be brand new or inactive'];
  if (n < 10)     return [6,  `${n} reviews — very small, budget risk`];
  if (n < 25)     return [14, `${n} reviews — small but established`];
  if (n <= 200)   return [25, `${n} reviews — sweet spot: about 2–15 trucks, owner still juggling everything`];
  if (n <= 400)   return [18, `${n} reviews — growing; may be adding systems already`];
  if (n <= 600)   return [11, `${n} reviews — likely office staff or more than 15 trucks`];
  if (n <= 1500)  return [6,  `${n} reviews — big player, longer sales cycle`];
  return [2, `${n} reviews — enterprise-scale, not a fit`];
}

function reputationPoints(rating) {
  const r = rating == null ? null : parseFloat(rating);
  if (r == null || Number.isNaN(r)) return [3, 'No rating'];
  // 3.8–4.3 is the automation pitch sweet spot: complaints about scheduling/communication
  // are common, owner knows they have a problem, not yet polished enough to have solved it
  if (r >= 4.6) return [5,  `${r}★ — near-perfect rating, likely already systemized`];
  if (r >= 4.3) return [8,  `${r}★ — good reputation, some room to improve`];
  if (r >= 3.8) return [10, `${r}★ — automation pitch sweet spot: service issues, motivated owner`];
  if (r >= 3.3) return [6,  `${r}★ — struggling reviews, may be receptive but riskier`];
  if (r >= 3.0) return [3,  `${r}★ — poor reviews, risky engagement`];
  return [1, `${r}★ — very poor reviews, not a fit`];
}

function hostOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, '').toLowerCase(); } catch { return ''; }
}

function reachPoints(website, phone) {
  let pts = 0; const bits = [];
  if (website) {
    const host = hostOf(website);
    if (cfg.SOCIAL_HOSTS.some(h => host === h || host.endsWith('.' + h))) {
      pts += 5; bits.push('social/listing page only — easy digital win');
    } else {
      pts += 10; bits.push('has a website');
    }
  } else {
    bits.push('no website');
  }
  if (phone) { pts += 5; bits.push('phone listed'); } else { bits.push('no phone'); }
  return [pts, bits.join(', ')];
}

function locationPoints(city, state) {
  const c = (city || '').trim().toLowerCase();
  const s = (state || '').trim().toUpperCase();
  if (c && cfg.HOME_CITIES.includes(c)) return [10, `${city} — in your drive-to market`];
  if (s === cfg.HOME_STATE)             return [6,  `${city || 'Unknown city'}, ${s} — in state, farther out`];
  return [2, `${city || 'Unknown'}${s ? ', ' + s : ''} — out of market`];
}

// Substring match, unchanged. The tier cap does not use this. It uses
// isFranchise, the word-boundary check from the prototype picker. A name
// such as "Constrane" or "Carriero" still takes the −20 and is not capped.
// Aligning the penalty with word boundaries is out of scope for F-004.
function franchisePenalty(company) {
  const name = (company || '').toLowerCase();
  const hit = cfg.FRANCHISE_PATTERNS.find(p => name.includes(p));
  return hit ? [-20, `Looks like a national brand/franchise ("${hit}")`] : [0, null];
}

// Reads the cached research column only. Null, blank, Jobber, Housecall Pro,
// and any other value are not ServiceTitan. Does not fetch.
const ST_REASON = 'ServiceTitan detected — weaker fit for owned build';

function isServiceTitan(fsmDetected) {
  if (fsmDetected == null) return false;
  const name = String(fsmDetected).trim().toLowerCase();
  return name === 'servicetitan';
}

function serviceTitanPenalty(fsmDetected) {
  if (!isServiceTitan(fsmDetected)) return [0, null];
  return [cfg.SERVICETITAN_PENALTY, ST_REASON];
}

// Ceiling for a capped tier: one point below the next-higher tier in TIERS.
// B is 77 while A starts at 78. A, or a letter that is not in TIERS, has no ceiling.
function tierCeiling(letter) {
  if (!letter) return null;
  const index = cfg.TIERS.findIndex(t => t.tier === letter);
  if (index <= 0) return null;
  return cfg.TIERS[index - 1].min - 1;
}

function capDetail(tier, ceiling, kinds) {
  const names = kinds.map(kind => (kind === 'servicetitan' ? 'ServiceTitan' : 'franchise'));
  const subject = names.length === 1
    ? `${names[0]} leads are`
    : `${names.join(' and ')} leads are`;
  return `Capped at tier ${tier} (${ceiling}) — ${subject} not tier A buyers`;
}

// Applied after penalties, fit_boost, and the 0–100 clamp. A score already at
// or below the ceiling is unchanged and gets no extra reason.
function applyTierCap(score, reasons, { serviceTitan, franchise }) {
  const active = [];
  if (serviceTitan) {
    const letter = cfg.TIER_CAP_FOR.servicetitan;
    const ceiling = tierCeiling(letter);
    if (ceiling != null) active.push({ kind: 'servicetitan', ceiling, tier: letter });
  }
  if (franchise) {
    const letter = cfg.TIER_CAP_FOR.franchise;
    const ceiling = tierCeiling(letter);
    if (ceiling != null) active.push({ kind: 'franchise', ceiling, tier: letter });
  }
  if (!active.length) return score;
  const ceiling = Math.min(...active.map(row => row.ceiling));
  if (score <= ceiling) return score;
  const binding = active.filter(row => row.ceiling === ceiling);
  reasons.push({
    label: 'Tier cap',
    points: ceiling - score,
    max: 0,
    detail: capDetail(binding[0].tier, ceiling, binding.map(row => row.kind)),
  });
  return ceiling;
}

function tierFor(score) {
  return cfg.TIERS.find(t => score >= t.min).tier;
}

/** Compute fit for one prospect row. Pure function. */
function computeFit(p) {
  const industry = normalizeIndustry(p.industry);
  // Out-of-scope trades cannot rank as a fit. Other factors and fit_boost
  // do not apply; the row stays in the database and sorts to the bottom.
  // Pest synonyms (pest control, exterminator, termite control, …) normalize
  // to Pest Control before this check.
  if (isExcludedIndustry(industry)) {
    return {
      fit_score: 0,
      fit_tier: 'D',
      fit_reasons: [{
        label: 'Industry',
        points: 0,
        max: 30,
        detail: `${industry} — out of scope`,
      }],
    };
  }

  const reasons = [];
  const ind = industryFit(industry);
  const indPts = Math.round((ind / 10) * 30);
  reasons.push({ label: 'Industry', points: indPts, max: 30, detail: `${industry} — ${ind}/10 automation fit` });

  const [sz, szD] = sizePoints(p.review_count);
  reasons.push({ label: 'Size', points: sz, max: 25, detail: szD });

  const [rep, repD] = reputationPoints(p.rating);
  reasons.push({ label: 'Reputation', points: rep, max: 10, detail: repD });

  const [rch, rchD] = reachPoints(p.website, p.phone);
  reasons.push({ label: 'Reachability', points: rch, max: 15, detail: rchD });

  const [loc, locD] = locationPoints(p.city, p.state);
  reasons.push({ label: 'Location', points: loc, max: 10, detail: locD });

  const [fr, frD] = franchisePenalty(p.company);
  if (fr) reasons.push({ label: 'Franchise', points: fr, max: 0, detail: frD });

  // Soft penalty. Tier still follows the numeric score; this does not force D.
  const [st, stD] = serviceTitanPenalty(p.fsm_detected);
  if (st) reasons.push({ label: 'ServiceTitan', points: st, max: 0, detail: stD });

  const boost = Math.max(-20, Math.min(20, Number(p.fit_boost) || 0));
  if (boost) reasons.push({ label: 'Your boost', points: boost, max: 20, detail: 'Manual adjustment' });

  // Cached research only. 0 when the cache is missing or the industry is plumbing.
  const [sig, sigReasons] = estimateSignalAdjustment(p);
  for (const reason of sigReasons) reasons.push(reason);

  // Base max is 90; scale to 100 so a perfect lead reads 100.
  // Estimate signals are final-score points, same as the penalties and the boost.
  // The tier cap runs after all of them, including a positive signal boost.
  // Franchise cap is the picker's word-boundary match, not the −20 substring.
  const base = indPts + sz + rep + rch + loc;
  const raw = Math.max(0, Math.min(100, Math.round(base * (100 / 90)) + fr + st + boost + sig));
  const franchiseCap = isFranchise(p.company, cfg.FRANCHISE_PATTERNS);
  const score = applyTierCap(raw, reasons, { serviceTitan: st !== 0, franchise: franchiseCap });
  return { fit_score: score, fit_tier: tierFor(score), fit_reasons: reasons };
}

const RESCORE_COLUMNS = 'id, company, industry, website, phone, city, state, rating, review_count, fit_boost, fsm_detected, research';

/** Recompute and persist fit for prospects that are not archived.
 *  An archived row keeps the score it had. Does not fetch a homepage or any URL. */
async function rescore(ids = null) {
  const { rows } = ids
    ? await pool.query(`SELECT ${RESCORE_COLUMNS} FROM prospects WHERE archived_at IS NULL AND id = ANY($1::int[])`, [ids])
    : await pool.query(`SELECT ${RESCORE_COLUMNS} FROM prospects WHERE archived_at IS NULL`);
  if (!rows.length) return 0;

  const idArr = [], scoreArr = [], tierArr = [], reasonArr = [];
  for (const r of rows) {
    const f = computeFit(r);
    idArr.push(r.id); scoreArr.push(f.fit_score); tierArr.push(f.fit_tier); reasonArr.push(JSON.stringify(f.fit_reasons));
  }
  // Update in one statement; doesn't touch updated_at semantics beyond the trigger.
  await pool.query(
    `UPDATE prospects p SET fit_score = v.s, fit_tier = v.t, fit_reasons = v.r::jsonb
       FROM unnest($1::int[], $2::int[], $3::text[], $4::text[]) AS v(id, s, t, r)
      WHERE p.id = v.id
        AND p.archived_at IS NULL
        AND (p.fit_score IS DISTINCT FROM v.s OR p.fit_tier IS DISTINCT FROM v.t OR p.fit_reasons IS DISTINCT FROM v.r::jsonb)`,
    [idArr, scoreArr, tierArr, reasonArr]
  );
  return rows.length;
}

module.exports = { computeFit, rescore, sizePoints, ST_REASON };
