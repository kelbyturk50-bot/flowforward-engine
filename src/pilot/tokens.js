// Demo tokens for the unsold-estimate recovery pilot.
//
// The token is the full 32-byte HMAC-SHA256 of
// `pilot-demo:v1:${proposal_id}:${generation}`, unpadded base64url.
// The HMAC key is HKDF-SHA256 over CRM_API_KEY with info `ff-pilot-demo`.
// CRM_API_KEY is the API's own shared secret. No new env var is required.
// CRM_API_KEY must be at least 32 characters. When it is missing or shorter,
// the pilot stays closed: no one-pager CTA, and the public demo routes
// return the same 404 as a flag that is off. The warning does not include
// the key. Rotating the key does not revoke links already issued — lookup
// is by hash — so a leaked key or leaked link also needs
// POST /api/proposals/:id/demo-token/revoke.
//
// The database stores the SHA-256 hash, the proposal, the generation, and
// timestamps. It does not store the raw token. A /p/:slug render recomputes
// the token from the active generation and does not insert a row, so a
// restart or another instance produces the same link. An authenticated mint
// bumps the generation and revokes the previous active row.
//
// proposals.demo_revoked_at sticks after revoke, including when the proposal
// is discarded. While it is set, nothing is derived and nothing is minted
// from a page view. Unknown, expired, revoked, discarded, and malformed
// tokens all come back as null — callers return one 404. A proposal with
// more than one active row also comes back as null. resolveToken also
// requires derived = true, the proposal's current active generation, and a
// stored hash equal to sha256 of the recomputed HMAC. A legacy random token
// stays null even if its row is still active. If boot finds the pilot schema
// unsafe, the pilot stays closed until a later boot is clean.
// The latch starts closed. openPilot runs only after the boot checks pass,
// so a request cannot use the demo before those invariants are verified.

const crypto = require('crypto');
const pool = require('../db/client');
const flags = require('./flags');

const TOKEN_BYTES = 32;
const MIN_SECRET_LENGTH = 32;
const TOKEN_RE = /^[A-Za-z0-9_-]{22,64}$/;
const DEFAULT_TTL_HOURS = 24 * 14;
const HKDF_INFO = 'ff-pilot-demo';
const TOKEN_LABEL = 'pilot-demo:v1';

const DUMMY_HASH = crypto.randomBytes(32);

let derivedKey = null;
let derivedFrom = null;
let missingSecretWarned = false;
let schemaClosed = true;

function ttlMs() {
  const raw = process.env.PILOT_DEMO_TOKEN_TTL_HOURS;
  if (raw == null || raw === '') return DEFAULT_TTL_HOURS * 3600 * 1000;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_TTL_HOURS * 3600 * 1000;
  const hours = Math.min(n, 24 * 365);
  return hours * 3600 * 1000;
}

function serverSecret() {
  const secret = process.env.CRM_API_KEY;
  if (typeof secret !== 'string' || secret.length < MIN_SECRET_LENGTH) return '';
  return secret;
}

function closePilot() {
  schemaClosed = true;
}

function openPilot() {
  schemaClosed = false;
}

function pilotReady() {
  if (schemaClosed) return false;
  if (serverSecret()) {
    missingSecretWarned = false;
    return true;
  }
  if (!missingSecretWarned) {
    missingSecretWarned = true;
    console.warn('[pilot] CRM_API_KEY must be at least 32 characters — the estimate-recovery demo stays off.');
  }
  return false;
}

function macKey() {
  const secret = serverSecret();
  if (!secret) return null;
  if (derivedKey && derivedFrom === secret) return derivedKey;
  derivedKey = Buffer.from(crypto.hkdfSync(
    'sha256',
    Buffer.from(secret, 'utf8'),
    Buffer.alloc(0),
    Buffer.from(HKDF_INFO, 'utf8'),
    TOKEN_BYTES
  ));
  derivedFrom = secret;
  return derivedKey;
}

function deriveToken(proposalId, generation) {
  const key = macKey();
  const id = Number(proposalId);
  const gen = Number(generation);
  if (!key || !Number.isInteger(id) || id < 1 || !Number.isInteger(gen) || gen < 1) return null;
  const message = `${TOKEN_LABEL}:${id}:${gen}`;
  return crypto.createHmac('sha256', key).update(message, 'utf8').digest().toString('base64url');
}

function hashToken(token) {
  return crypto.createHash('sha256').update(String(token), 'utf8').digest();
}

function hashesEqual(stored, computed) {
  const left = Buffer.isBuffer(stored) && stored.length === computed.length ? stored : DUMMY_HASH;
  const right = Buffer.isBuffer(computed) && computed.length === left.length ? computed : DUMMY_HASH;
  return crypto.timingSafeEqual(left, right) && left !== DUMMY_HASH && Buffer.isBuffer(stored);
}

function demoBase() {
  const raw = String(process.env.PILOT_DEMO_BASE_URL || '').trim().replace(/\/+$/, '');
  if (!raw) return '';
  try {
    const url = new URL(raw);
    if (url.username || url.password) return '';
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return '';
    return raw;
  } catch {
    return '';
  }
}

function publicDemoPath(token) {
  const path = `/demo/estimate-recovery/${encodeURIComponent(token)}`;
  const base = demoBase();
  return base ? `${base}${path}` : path;
}

function blockedProposal(proposal) {
  return !proposal || proposal.status === 'discarded' || proposal.demo_revoked_at != null;
}

async function resolveToken(raw) {
  if (!pilotReady()) return null;
  const wellFormed = typeof raw === 'string' && TOKEN_RE.test(raw);
  const computed = wellFormed ? hashToken(raw) : DUMMY_HASH;
  const { rows } = await pool.query(
    `SELECT t.id, t.proposal_id, t.prospect_id, t.generation, t.derived, t.token_hash,
            t.expires_at, t.revoked_at,
            pr.status AS proposal_status, pr.demo_revoked_at,
            p.archived_at
       FROM pilot_tokens t
       JOIN proposals pr ON pr.id = t.proposal_id
       JOIN prospects p ON p.id = t.prospect_id
      WHERE t.token_hash = $1`,
    [computed]
  );
  const row = rows[0] || null;
  const stored = row && row.token_hash ? Buffer.from(row.token_hash) : null;
  const recomputed = row ? deriveToken(row.proposal_id, row.generation) : null;
  const recomputedHash = recomputed ? hashToken(recomputed) : DUMMY_HASH;
  // Always compare, including the miss path, so a missing row still runs
  // timingSafeEqual against the dummy hash. The second compare is the
  // recomputed HMAC, so a legacy random hash cannot pass.
  const equal = hashesEqual(stored, computed);
  const macOk = hashesEqual(stored, recomputedHash);
  if (!wellFormed || !row || !equal || !macOk) return null;
  if (row.revoked_at) return null;
  if (row.derived !== true) return null;
  if (row.proposal_status === 'discarded') return null;
  if (row.demo_revoked_at) return null;
  if (row.archived_at != null) return null;
  if (new Date(row.expires_at).getTime() <= Date.now()) return null;
  const siblings = await pool.query(
    `SELECT COUNT(*)::int AS n, MAX(generation) AS generation,
            BOOL_AND(derived) AS derived
       FROM pilot_tokens
      WHERE proposal_id = $1 AND revoked_at IS NULL`,
    [row.proposal_id]
  );
  const active = siblings.rows[0];
  if (Number(active.n) !== 1) return null;
  if (active.derived !== true) return null;
  if (Number(active.generation) !== Number(row.generation)) return null;
  return {
    id: row.id,
    proposal_id: Number(row.proposal_id),
    prospect_id: Number(row.prospect_id),
  };
}

async function mintForProposal(proposalId) {
  if (!pilotReady()) return null;
  const id = Number(proposalId);
  if (!Number.isInteger(id) || id < 1) return null;

  const db = await pool.connect();
  try {
    await db.query('BEGIN');
    const { rows } = await db.query(
      `SELECT id, prospect_id, status FROM proposals WHERE id = $1 FOR UPDATE`,
      [id]
    );
    const proposal = rows[0];
    if (!proposal || proposal.status === 'discarded') {
      await db.query('ROLLBACK');
      return null;
    }
    const next = await db.query(
      `SELECT COALESCE(MAX(generation), 0) + 1 AS generation
         FROM pilot_tokens WHERE proposal_id = $1`,
      [proposal.id]
    );
    const generation = Number(next.rows[0].generation);
    const token = deriveToken(proposal.id, generation);
    if (!token || Buffer.from(token, 'base64url').length < 16) {
      throw new Error('Demo token was shorter than 16 bytes');
    }
    const expiresAt = new Date(Date.now() + ttlMs());
    const tokenHash = hashToken(token);
    await db.query(
      `UPDATE pilot_tokens SET revoked_at = NOW()
        WHERE proposal_id = $1 AND revoked_at IS NULL`,
      [proposal.id]
    );
    await db.query(
      `UPDATE proposals SET demo_revoked_at = NULL WHERE id = $1 AND demo_revoked_at IS NOT NULL`,
      [proposal.id]
    );
    const inserted = await db.query(
      `INSERT INTO pilot_tokens (proposal_id, prospect_id, generation, token_hash, expires_at, derived)
       VALUES ($1, $2, $3, $4, $5, TRUE)
       RETURNING id, expires_at, generation`,
      [proposal.id, proposal.prospect_id, generation, tokenHash, expiresAt]
    );
    await db.query('COMMIT');
    return {
      id: inserted.rows[0].id,
      token,
      expires_at: inserted.rows[0].expires_at,
      generation: Number(inserted.rows[0].generation),
      proposal_id: Number(proposal.id),
      prospect_id: Number(proposal.prospect_id),
    };
  } catch (err) {
    await db.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    db.release();
  }
}

async function revokeForProposal(proposalId) {
  const id = Number(proposalId);
  if (!Number.isInteger(id) || id < 1) return 0;
  const db = await pool.connect();
  try {
    await db.query('BEGIN');
    const found = await db.query('SELECT id FROM proposals WHERE id = $1 FOR UPDATE', [id]);
    if (!found.rows.length) {
      await db.query('ROLLBACK');
      return 0;
    }
    await db.query('UPDATE proposals SET demo_revoked_at = NOW() WHERE id = $1', [id]);
    const { rowCount } = await db.query(
      `UPDATE pilot_tokens SET revoked_at = NOW()
        WHERE proposal_id = $1 AND revoked_at IS NULL`,
      [id]
    );
    await db.query('COMMIT');
    return rowCount;
  } catch (err) {
    await db.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    db.release();
  }
}

async function demoHrefForProposal(req, proposalId) {
  if (!flags.masterOn() || !flags.linkOn() || !pilotReady()) return '';
  const id = Number(proposalId);
  if (!Number.isInteger(id) || id < 1) return '';

  const gateRow = await pool.query(
    `SELECT pr.status, pr.demo_revoked_at, p.archived_at
       FROM proposals pr
       JOIN prospects p ON p.id = pr.prospect_id
      WHERE pr.id = $1`,
    [id]
  );
  const gate = gateRow.rows[0];
  if (blockedProposal(gate) || (gate && gate.archived_at != null)) return '';

  const active = await pool.query(
    `SELECT generation, token_hash, expires_at, derived
       FROM pilot_tokens
      WHERE proposal_id = $1
        AND revoked_at IS NULL
      ORDER BY generation DESC`,
    [id]
  );
  if (active.rows.length !== 1) return '';
  const row = active.rows[0];
  if (row.derived !== true) return '';
  if (new Date(row.expires_at).getTime() <= Date.now()) return '';
  const token = deriveToken(id, row.generation);
  if (!token) return '';
  const stored = Buffer.from(row.token_hash);
  if (!hashesEqual(stored, hashToken(token))) return '';
  return publicDemoPath(token);
}

function _clearCacheForTests() {
  if (process.env.NODE_ENV !== 'test') {
    throw new Error('_clearCacheForTests is only available when NODE_ENV=test');
  }
  derivedKey = null;
  derivedFrom = null;
  missingSecretWarned = false;
  // Tests opt back in. A server process stays closed until openPilot().
  schemaClosed = false;
}

module.exports = {
  TOKEN_BYTES,
  TOKEN_RE,
  HKDF_INFO,
  hashToken,
  deriveToken,
  pilotReady,
  closePilot,
  openPilot,
  publicDemoPath,
  resolveToken,
  mintForProposal,
  revokeForProposal,
  demoHrefForProposal,
  _clearCacheForTests,
};
