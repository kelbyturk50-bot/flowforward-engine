// Creates and reads prototype rows. Does not fetch, send, or enqueue work.
// recommendPrototypes is called on the module object so tests can stub it.

const pool = require('../db/client');
const scoring = require('../scoring/prototypes');
const { loadRubric } = require('../scoring/rubric-store');
const { isPestCompanyName } = require('../scoring/industry');
const { prototypeOnDraft } = require('./flags');
const tokens = require('./tokens');
const palette = require('./palette');

const PRIMARY_FALLBACK = '#2f6b57';
const SECONDARY_FALLBACK = '#1e2a2f';
const HEX = /^#[0-9a-fA-F]{6}$/;

// Agent click-throughs the prototype page can show. The rubric can rank
// others (review requests, maintenance renewal, dispatch); those still get a
// prototype, featuring the first built agent or estimate follow-up.
const BUILT_AGENTS = Object.freeze(['estimate_followup', 'speed_to_lead', 'receptionist', 'scheduling']);
const DEFAULT_AGENT = 'estimate_followup';
// Rubric results a person can override from the CRM. Pest and franchise stay refused.
const HARD_REFUSALS = new Set(['pest', 'franchise']);

function httpError(status, message, code) {
  const err = new Error(message);
  err.status = status;
  err.userMessage = message;
  if (code) err.code = code;
  return err;
}

function isServiceTitan(prospect) {
  return String(prospect && prospect.fsm_detected || '').trim().toLowerCase() === 'servicetitan';
}

// The rubric already orders ties (estimate follow-up first, then cost tier,
// own-it fit, tieRank), so the first pick wins.
function resolvePick(result) {
  if (!result || result.disqualified) {
    return { agent: null, reason: (result && result.disqualified) || 'no_pick' };
  }
  const picks = (Array.isArray(result.picks) ? result.picks : [])
    .filter(p => p && typeof p.agent === 'string' && /^[a-z0-9_]+$/.test(p.agent));
  if (!picks.length) return { agent: null, reason: 'no_pick' };
  const built = picks.find(p => BUILT_AGENTS.includes(p.agent));
  return { agent: built ? built.agent : DEFAULT_AGENT, reason: null };
}

function serviceTitanBlocked(prospect, agent, rubric) {
  if (!isServiceTitan(prospect) || !agent) return false;
  const allow = Array.isArray(rubric && rubric.serviceTitanAllow) ? rubric.serviceTitanAllow : [];
  return !allow.includes(agent);
}

function hexList(colors) {
  const list = Array.isArray(colors) ? colors : [];
  const out = [];
  for (const value of list) {
    if (typeof value === 'string' && HEX.test(value)) out.push(value.toLowerCase());
  }
  return out;
}

function siteColors(research) {
  const c = research && research.site && research.site.brand_colors;
  if (!c || !c.primary || !HEX.test(c.primary)) return null;
  return { primary: c.primary.toLowerCase(), secondary: (c.secondary && HEX.test(c.secondary) ? c.secondary : SECONDARY_FALLBACK).toLowerCase() };
}

// Hand-entered TEST brand first, then the colors read from the shop's own
// site during research, then (CRM only) a live read of the site, then the
// FlowForward fallback.
async function colorsFor(prospect, { live = false } = {}) {
  const { rows } = await pool.query(
    `SELECT colors
       FROM prospect_brands
      WHERE prospect_id = $1
      ORDER BY updated_at DESC, id DESC
      LIMIT 1`,
    [prospect.id]
  );
  const found = hexList(rows[0] && rows[0].colors);
  if (found[0]) return { primary: found[0], secondary: found[1] || SECONDARY_FALLBACK };
  const cached = siteColors(prospect.research);
  if (cached) return cached;
  if (live && prospect.website) {
    const got = await palette.detectBrandColors(prospect.website);
    if (!got.error && got.primary) {
      await saveSiteColors(prospect.id, got);
      return { primary: got.primary, secondary: got.secondary || SECONDARY_FALLBACK };
    }
  }
  return { primary: PRIMARY_FALLBACK, secondary: SECONDARY_FALLBACK };
}

// Keep the detected palette on the lead's research cache so later
// prototypes and rescoring don't fetch again.
async function saveSiteColors(prospectId, got) {
  const value = { primary: got.primary, secondary: got.secondary, confident: got.confident, swatches: got.swatches || [], detected_at: got.detected_at };
  await pool.query(
    `UPDATE prospects SET research = jsonb_set(
        jsonb_set(COALESCE(research, '{}'::jsonb), '{site}', COALESCE(research->'site', '{}'::jsonb)),
        '{site,brand_colors}', $2::jsonb)
      WHERE id = $1`, [prospectId, JSON.stringify(value)]);
}

// CRM "Match their website": read the site now, apply the top two colors,
// and return the swatches so Kelby can pick a different one.
async function matchSiteColors(id) {
  const { rows } = await pool.query(
    `SELECT pt.id, pt.prospect_id, p.website FROM prototypes pt JOIN prospects p ON p.id = pt.prospect_id
      WHERE pt.id = $1 AND pt.revoked_at IS NULL`, [id]);
  if (!rows[0]) throw httpError(404, 'Prototype not found');
  if (!rows[0].website) throw httpError(400, 'This lead has no website on file.', 'no_website');
  const got = await palette.detectBrandColors(rows[0].website);
  if (got.error) throw httpError(502, `Couldn't read their site: ${got.error}.`, 'fetch_failed');
  if (!got.primary) throw httpError(422, 'No brand colors found on their site. Enter them by hand.', 'no_colors');
  await saveSiteColors(rows[0].prospect_id, got);
  const row = await setColors(id, { primary: got.primary, secondary: got.secondary || SECONDARY_FALLBACK });
  return { row, swatches: got.swatches, confident: got.confident };
}

function brandNameOf(prospect) {
  const name = String(prospect.company || '').trim();
  return name || null;
}

const ROW_COLS = `id, prospect_id, agent_type, brand_name, color_primary, color_secondary,
  token_hash, nonce, issued_at, expires_at, revoked_at, created_at`;

async function loadActive(prospectId) {
  const { rows } = await pool.query(
    `SELECT ${ROW_COLS}
       FROM prototypes
      WHERE prospect_id = $1 AND revoked_at IS NULL
      ORDER BY id DESC
      LIMIT 1`,
    [prospectId]
  );
  return rows[0] || null;
}

// Recompute the link from the stored nonce. Null when the key is missing or
// rotated (the recomputed token no longer matches the stored hash).
function tokenOf(row) {
  if (!row || row.revoked_at || !row.nonce) return null;
  const token = tokens.tokenFor(Buffer.from(row.nonce));
  if (!token) return null;
  const stored = row.token_hash ? Buffer.from(row.token_hash) : null;
  return tokens.hashesEqual(stored, tokens.hashToken(token)) ? token : null;
}

function publicBase() {
  // Same base the one-pager links use (falls back to the Railway URL when
  // PUBLIC_BASE_URL is unset). Links in emails must be absolute.
  return require('../proposals/config').PUBLIC_BASE_URL;
}

function linkFor(row) {
  if (!row || row.revoked_at) return null;
  const token = tokenOf(row);
  const expired = new Date(row.expires_at).getTime() <= Date.now();
  return {
    id: row.id,
    url: token ? `${publicBase()}${tokens.publicPath(token)}` : null,
    agent_type: row.agent_type,
    colors: { primary: row.color_primary, secondary: row.color_secondary },
    issued_at: row.issued_at,
    expires_at: row.expires_at,
    expired,
    link_problem: token ? null : (tokens.keyReady() ? 'key_changed' : 'key_missing'),
  };
}

async function insertRow(prospect, agent, colors) {
  const name = brandNameOf(prospect);
  if (!name) throw new Error('prototype brand name missing');
  for (let attempt = 0; attempt < 3; attempt++) {
    const minted = tokens.mintToken();
    if (!minted) throw httpError(503, 'Prototype links need CRM_API_KEY with at least 32 characters.', 'key_missing');
    try {
      const { rows } = await pool.query(
        `WITH stamp AS (SELECT NOW() AS issued_at)
         INSERT INTO prototypes (
           prospect_id, agent_type, brand_name, color_primary, color_secondary,
           token_hash, nonce, issued_at, expires_at
         )
         SELECT $1, $2, $3, $4, $5, $6, $7, issued_at, issued_at + INTERVAL '336 hours'
           FROM stamp
         RETURNING ${ROW_COLS}`,
        [prospect.id, agent, name, colors.primary, colors.secondary, minted.hash, minted.nonce]
      );
      return rows[0];
    } catch (err) {
      if (err.code !== '23505') throw err;
      const active = await loadActive(prospect.id);
      if (active) return active;
    }
  }
  throw new Error('prototype insert conflict');
}

async function loadProspect(prospectId, research) {
  const { rows } = await pool.query('SELECT * FROM prospects WHERE id = $1', [prospectId]);
  const prospect = rows[0];
  if (!prospect) return null;
  if (research != null) prospect.research = research;
  return prospect;
}

// Draft hook. Uses the rubric; no pick means no prototype.
async function attachPrototype({ prospectId, research }) {
  if (!(await prototypeOnDraft())) return null;
  try {
    const prospect = await loadProspect(prospectId, research);
    if (!prospect) return null;
    const existing = await loadActive(prospect.id);
    if (existing) {
      console.log(`[prototype] prospect ${prospect.id} reused active prototype ${existing.id}`);
      return existing;
    }
    if (prospect.archived_at || isPestCompanyName(prospect.company)) return null;
    const rubric = await loadRubric(pool);
    const pick = resolvePick(scoring.recommendPrototypes(prospect, rubric));
    if (!pick.agent || serviceTitanBlocked(prospect, pick.agent, rubric)) {
      const reason = pick.agent ? 'servicetitan' : pick.reason;
      console.log(`[prototype] prospect ${prospect.id} no pick (${reason})`);
      return null;
    }
    const colors = await colorsFor(prospect);
    const row = await insertRow(prospect, pick.agent, colors);
    console.log(`[prototype] prospect ${prospect.id} agent ${row.agent_type} prototype ${row.id}`);
    return row;
  } catch (err) {
    console.error('[prototype] hook failed:', err && err.code);
    return null;
  }
}

// From the CRM. Returns the active prototype, creating one when needed.
// With fresh: true, revokes the active one first (a new link).
// The rubric still picks the featured agent; a weak score falls back to
// estimate follow-up because Kelby asked for it. Pest and franchise refuse.
async function ensurePrototype(prospectId, { fresh = false } = {}) {
  const prospect = await loadProspect(prospectId);
  if (!prospect) throw httpError(404, 'Lead not found');
  if (prospect.archived_at) throw httpError(409, 'This lead is archived.', 'archived');
  if (isPestCompanyName(prospect.company)) throw httpError(409, 'Pest control is out of scope.', 'pest');
  const existing = await loadActive(prospect.id);
  if (existing && !fresh) return existing;
  const rubric = await loadRubric(pool);
  const result = scoring.recommendPrototypes(prospect, rubric);
  if (result && HARD_REFUSALS.has(result.disqualified)) {
    throw httpError(409, result.disqualified === 'pest' ? 'Pest control is out of scope.' : 'Franchises get no prototype (corporate systems).', result.disqualified);
  }
  let agent = resolvePick(result).agent || DEFAULT_AGENT;
  if (serviceTitanBlocked(prospect, agent, rubric)) agent = DEFAULT_AGENT;
  const colors = existing
    ? { primary: existing.color_primary, secondary: existing.color_secondary }
    : await colorsFor(prospect, { live: true });
  if (!tokens.keyReady()) throw httpError(503, 'Prototype links need CRM_API_KEY with at least 32 characters.', 'key_missing');
  if (existing) await revoke(existing.id);
  const row = await insertRow(prospect, agent, colors);
  console.log(`[prototype] prospect ${prospect.id} agent ${row.agent_type} prototype ${row.id} (from CRM)`);
  return row;
}

async function setColors(id, { primary, secondary }) {
  const p = String(primary || '').trim();
  const s = String(secondary || '').trim() || SECONDARY_FALLBACK;
  if (!HEX.test(p) || !HEX.test(s)) throw httpError(400, 'Colors must be hex like #1F4E79.');
  const { rows } = await pool.query(
    `UPDATE prototypes SET color_primary = $2, color_secondary = $3
      WHERE id = $1 AND revoked_at IS NULL RETURNING ${ROW_COLS}`,
    [id, p.toLowerCase(), s.toLowerCase()]
  );
  if (!rows[0]) throw httpError(404, 'Prototype not found');
  return rows[0];
}

async function setAgent(id, agent) {
  if (!BUILT_AGENTS.includes(agent)) throw httpError(400, 'Unknown agent.');
  const { rows } = await pool.query(
    `UPDATE prototypes SET agent_type = $2 WHERE id = $1 AND revoked_at IS NULL RETURNING ${ROW_COLS}`, [id, agent]);
  if (!rows[0]) throw httpError(404, 'Prototype not found');
  return rows[0];
}

async function prototypeForProposal(prospectId) {
  return linkFor(await loadActive(prospectId));
}

// The link to put in an email, or null (none, expired, or not recomputable).
async function liveLink(prospectId) {
  const link = linkFor(await loadActive(prospectId));
  return link && link.url && !link.expired ? link : null;
}

// Restart the 14 days when the link is first shared (the first email goes
// out), so a draft that sat in review does not send a link that is about to
// expire. Same token; only issued_at and expires_at move.
async function restartClock(prospectId) {
  const { rows } = await pool.query(
    `UPDATE prototypes SET issued_at = NOW(), expires_at = NOW() + INTERVAL '336 hours'
      WHERE prospect_id = $1 AND revoked_at IS NULL RETURNING ${ROW_COLS}`, [prospectId]);
  return rows[0] || null;
}

// Unknown, malformed, and revoked are 404. Expired and still active is 410.
// A row that is both revoked and expired is 404.
// `at` is the injected clock. Chat passes the engine clock. Callers that
// omit it use the process clock. The comparison is never SQL now().
async function lookupToken(raw, at) {
  const now = at instanceof Date && Number.isFinite(at.getTime()) ? at : new Date();
  const wellFormed = tokens.tokenWellFormed(raw);
  const computed = wellFormed ? tokens.hashToken(raw) : tokens.DUMMY_HASH;
  const { rows } = await pool.query(
    `SELECT pt.id, pt.prospect_id, pt.agent_type, pt.brand_name, pt.color_primary, pt.color_secondary,
            pt.token_hash, pt.issued_at, pt.expires_at, pt.revoked_at,
            ($2::timestamptz >= pt.expires_at) AS expired,
            p.industry, p.city, p.archived_at
       FROM prototypes pt JOIN prospects p ON p.id = pt.prospect_id
      WHERE pt.token_hash = $1`,
    [computed, now]
  );
  const row = rows[0] || null;
  const stored = row && row.token_hash ? Buffer.from(row.token_hash) : null;
  const equal = tokens.hashesEqual(stored, computed);
  if (!wellFormed || !row || !equal || row.revoked_at || row.archived_at) return { status: 404, row: null };
  if (row.expired === true) return { status: 410, row };
  return { status: 200, row };
}

async function readByToken(raw) {
  const { status, row } = await lookupToken(raw);
  if (status === 404) return { status, body: { error: 'not_found' } };
  if (status === 410) {
    return { status, body: { error: 'link_expired', expires_at: new Date(row.expires_at).toISOString() } };
  }
  return {
    status: 200,
    body: {
      brand_name: row.brand_name,
      colors: { primary: row.color_primary, secondary: row.color_secondary },
      agent_type: row.agent_type,
      industry: row.industry || null,
      city: row.city || null,
      watermark: true,
      issued_at: new Date(row.issued_at).toISOString(),
      expires_at: new Date(row.expires_at).toISOString(),
    },
  };
}

async function revoke(id) {
  const { rows } = await pool.query(
    `UPDATE prototypes
        SET revoked_at = COALESCE(revoked_at, NOW())
      WHERE id = $1
      RETURNING id, revoked_at`,
    [id]
  );
  return rows[0] || null;
}

module.exports = {
  BUILT_AGENTS,
  attachPrototype,
  ensurePrototype,
  setColors,
  matchSiteColors,
  setAgent,
  prototypeForProposal,
  liveLink,
  restartClock,
  linkFor,
  lookupToken,
  readByToken,
  revoke,
  resolvePick,
};
