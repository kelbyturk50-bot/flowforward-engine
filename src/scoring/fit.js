// Fit scoring — ranks each lead 0–100 on how well it matches the consulting
// business model, with a human-readable breakdown stored in fit_reasons.
//
//   Industry fit      30  how much automation leverage the trade has
//   Business size     25  review volume as a proxy for job volume (sweet spot 75–400)
//   Reputation        10  Google rating
//   Reachability      15  real website + phone
//   Location          10  inside your drive-to market
//   Franchise        -20  national brands / franchises
//   Manual boost  ±20     your own adjustment (fit_boost)

const pool = require('../db/client');
const INDUSTRIES = require('../bot/industries');
const cfg = require('./config');

const industryDefaults = {};
for (const { industry, score } of INDUSTRIES) {
  industryDefaults[industry] = Math.max(industryDefaults[industry] || 0, score);
}

function industryFit(industry) {
  return cfg.INDUSTRY_FIT[industry] ?? industryDefaults[industry] ?? 5;
}

function sizePoints(reviews) {
  const n = Number(reviews) || 0;
  if (n === 0)    return [2,  'No reviews — may be brand new or inactive'];
  if (n < 10)     return [6,  `${n} reviews — very small, budget risk`];
  if (n < 25)     return [14, `${n} reviews — small but established`];
  if (n < 75)     return [22, `${n} reviews — growing owner-operated shop`];
  if (n <= 400)   return [25, `${n} reviews — sweet spot: busy, owner still decides`];
  if (n <= 1000)  return [18, `${n} reviews — larger operation, may have office staff`];
  if (n <= 2500)  return [10, `${n} reviews — big player, longer sales cycle`];
  return [4, `${n} reviews — enterprise-scale`];
}

function reputationPoints(rating) {
  const r = rating == null ? null : parseFloat(rating);
  if (r == null || Number.isNaN(r)) return [3, 'No rating'];
  if (r >= 4.6) return [10, `${r}★ — strong reputation`];
  if (r >= 4.2) return [9,  `${r}★ — good reputation`];
  if (r >= 3.8) return [7,  `${r}★ — some service issues (automation pitch angle)`];
  if (r >= 3.0) return [4,  `${r}★ — struggling reviews`];
  return [2, `${r}★ — poor reviews, risky client`];
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

function franchisePenalty(company) {
  const name = (company || '').toLowerCase();
  const hit = cfg.FRANCHISE_PATTERNS.find(p => name.includes(p));
  return hit ? [-20, `Looks like a national brand/franchise ("${hit}")`] : [0, null];
}

function tierFor(score) {
  return cfg.TIERS.find(t => score >= t.min).tier;
}

/** Compute fit for one prospect row. Pure function. */
function computeFit(p) {
  const reasons = [];
  const ind = industryFit(p.industry);
  const indPts = Math.round((ind / 10) * 30);
  reasons.push({ label: 'Industry', points: indPts, max: 30, detail: `${p.industry} — ${ind}/10 automation fit` });

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

  const boost = Math.max(-20, Math.min(20, Number(p.fit_boost) || 0));
  if (boost) reasons.push({ label: 'Your boost', points: boost, max: 20, detail: 'Manual adjustment' });

  // Base max is 90; scale to 100 so a perfect lead reads 100.
  const base = indPts + sz + rep + rch + loc;
  const score = Math.max(0, Math.min(100, Math.round(base * (100 / 90)) + fr + boost));
  return { fit_score: score, fit_tier: tierFor(score), fit_reasons: reasons };
}

/** Recompute and persist fit for all prospects (or a list of ids). */
async function rescore(ids = null) {
  const { rows } = ids
    ? await pool.query('SELECT id, company, industry, website, phone, city, state, rating, review_count, fit_boost FROM prospects WHERE id = ANY($1::int[])', [ids])
    : await pool.query('SELECT id, company, industry, website, phone, city, state, rating, review_count, fit_boost FROM prospects');
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
        AND (p.fit_score IS DISTINCT FROM v.s OR p.fit_tier IS DISTINCT FROM v.t OR p.fit_reasons IS DISTINCT FROM v.r::jsonb)`,
    [idArr, scoreArr, tierArr, reasonArr]
  );
  return rows.length;
}

module.exports = { computeFit, rescore };
