// Creates and reads prototype rows. Does not fetch, send, or enqueue work.
// recommendPrototypes is called on the module object so tests can stub it.

const pool = require('../db/client');
const scoring = require('../scoring/prototypes');
const { loadRubric } = require('../scoring/rubric-store');
const { prototypeOnDraft } = require('./flags');
const tokens = require('./tokens');

const PRIMARY_FALLBACK = '#2f6b57';
const SECONDARY_FALLBACK = '#1e2a2f';
const HEX = /^#[0-9a-fA-F]{6}$/;

// Raw tokens from inserts in this process. The database keeps only the hash,
// so a restart or another instance cannot rebuild the URL.
const issued = new Map();

function isServiceTitan(prospect) {
  return String(prospect && prospect.fsm_detected || '').trim().toLowerCase() === 'servicetitan';
}

// A shared top score is not an auto-pick. The rubric still orders those
// agents; this hook waits until one score is strictly ahead.
function resolvePick(result) {
  if (!result || result.disqualified) {
    return { agent: null, reason: (result && result.disqualified) || 'no_pick' };
  }
  const picks = Array.isArray(result.picks) ? result.picks : [];
  if (!picks.length) return { agent: null, reason: 'no_pick' };
  if (picks.length >= 2 && Number(picks[0].score) === Number(picks[1].score)) {
    return { agent: null, reason: 'tie' };
  }
  const agent = picks[0] && picks[0].agent;
  if (typeof agent !== 'string' || !/^[a-z0-9_]+$/.test(agent)) {
    return { agent: null, reason: 'no_pick' };
  }
  return { agent, reason: null };
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

async function colorsFor(prospectId) {
  const { rows } = await pool.query(
    `SELECT colors
       FROM prospect_brands
      WHERE prospect_id = $1
      ORDER BY updated_at DESC, id DESC
      LIMIT 1`,
    [prospectId]
  );
  const found = hexList(rows[0] && rows[0].colors);
  return {
    primary: found[0] || PRIMARY_FALLBACK,
    secondary: found[1] || SECONDARY_FALLBACK,
  };
}

function brandNameOf(prospect) {
  const name = String(prospect.company || '').trim();
  return name || null;
}

const ROW_COLS = `id, prospect_id, agent_type, brand_name, color_primary, color_secondary,
  token_hash, issued_at, expires_at, revoked_at, created_at`;

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

function linkFor(row) {
  if (!row || row.revoked_at) return null;
  const base = {
    url: null,
    agent_type: row.agent_type,
    issued_at: row.issued_at,
    expires_at: row.expires_at,
  };
  const token = issued.get(row.id);
  if (!token) return base;
  const stored = row.token_hash ? Buffer.from(row.token_hash) : null;
  if (!tokens.hashesEqual(stored, tokens.hashToken(token))) return base;
  return { ...base, url: tokens.publicPath(token), token };
}

async function insertRow(prospect, agent, colors) {
  const name = brandNameOf(prospect);
  if (!name) throw new Error('prototype brand name missing');
  for (let attempt = 0; attempt < 3; attempt++) {
    const minted = tokens.mintToken();
    if (Buffer.from(minted.token, 'base64url').length !== tokens.TOKEN_BYTES) {
      throw new Error('prototype token was not 32 bytes');
    }
    try {
      const { rows } = await pool.query(
        `WITH stamp AS (SELECT NOW() AS issued_at)
         INSERT INTO prototypes (
           prospect_id, agent_type, brand_name, color_primary, color_secondary,
           token_hash, issued_at, expires_at
         )
         SELECT $1, $2, $3, $4, $5, $6, issued_at, issued_at + INTERVAL '14 days'
           FROM stamp
         RETURNING ${ROW_COLS}`,
        [prospect.id, agent, name, colors.primary, colors.secondary, minted.hash]
      );
      const row = rows[0];
      issued.set(row.id, minted.token);
      return row;
    } catch (err) {
      if (err.code !== '23505') throw err;
      const active = await loadActive(prospect.id);
      if (active) return active;
    }
  }
  throw new Error('prototype insert conflict');
}

async function attachPrototype({ prospectId, research }) {
  if (!prototypeOnDraft()) return null;
  try {
    const { rows } = await pool.query('SELECT * FROM prospects WHERE id = $1', [prospectId]);
    const prospect = rows[0];
    if (!prospect) return null;
    prospect.research = research == null ? prospect.research : research;
    const existing = await loadActive(prospect.id);
    if (existing) {
      console.log(`[prototype] prospect ${prospect.id} reused active prototype ${existing.id}`);
      return existing;
    }
    const rubric = await loadRubric(pool);
    const pick = resolvePick(scoring.recommendPrototypes(prospect, rubric));
    if (!pick.agent || serviceTitanBlocked(prospect, pick.agent, rubric)) {
      let reason = pick.reason;
      if (!pick.agent && reason === 'below_min' && isServiceTitan(prospect)) reason = 'servicetitan';
      if (pick.agent && serviceTitanBlocked(prospect, pick.agent, rubric)) reason = 'servicetitan';
      console.log(`[prototype] prospect ${prospect.id} no pick (${reason})`);
      return null;
    }
    const colors = await colorsFor(prospect.id);
    const row = await insertRow(prospect, pick.agent, colors);
    console.log(`[prototype] prospect ${prospect.id} agent ${row.agent_type} prototype ${row.id}`);
    return row;
  } catch (err) {
    console.error('[prototype] hook failed:', err && err.code);
    return null;
  }
}

async function prototypeForProposal(prospectId) {
  const row = await loadActive(prospectId);
  if (!row) return null;
  const link = linkFor(row);
  if (!link) return null;
  return {
    url: link.url,
    agent_type: link.agent_type,
    issued_at: link.issued_at,
    expires_at: link.expires_at,
  };
}

// Unknown, malformed, and revoked are 404. Expired and still active is 410.
// A row that is both revoked and expired is 404.
async function readByToken(raw) {
  const wellFormed = tokens.tokenWellFormed(raw);
  const computed = wellFormed ? tokens.hashToken(raw) : tokens.DUMMY_HASH;
  const { rows } = await pool.query(
    `SELECT ${ROW_COLS}, (NOW() >= expires_at) AS expired
       FROM prototypes
      WHERE token_hash = $1`,
    [computed]
  );
  const row = rows[0] || null;
  const stored = row && row.token_hash ? Buffer.from(row.token_hash) : null;
  const equal = tokens.hashesEqual(stored, computed);
  if (!wellFormed || !row || !equal || row.revoked_at) {
    return { status: 404, body: { error: 'not_found' } };
  }
  if (row.expired === true) {
    return {
      status: 410,
      body: {
        error: 'link_expired',
        expires_at: new Date(row.expires_at).toISOString(),
      },
    };
  }
  return {
    status: 200,
    body: {
      brand_name: row.brand_name,
      colors: { primary: row.color_primary, secondary: row.color_secondary },
      agent_type: row.agent_type,
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
  if (rows[0]) issued.delete(id);
  return rows[0] || null;
}

function _clearIssuedForTests() {
  if (process.env.NODE_ENV !== 'test') {
    throw new Error('_clearIssuedForTests is only available when NODE_ENV=test');
  }
  issued.clear();
}

module.exports = {
  attachPrototype,
  prototypeForProposal,
  readByToken,
  revoke,
  resolvePick,
  _clearIssuedForTests,
};
