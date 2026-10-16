// Demo tokens for the unsold-estimate recovery pilot.
//
// The raw token is 16 bytes from crypto.randomBytes, encoded as unpadded
// base64url (22 characters). Only the SHA-256 hash is stored. Lookup hashes
// the presented token and compares with crypto.timingSafeEqual, including a
// dummy compare when no row matches, so the compare itself does not branch
// on secret length. Unknown, expired, revoked, and malformed tokens all
// come back as null — callers return one 404.

const crypto = require('crypto');
const pool = require('../db/client');
const flags = require('./flags');
const { clientIp, consume } = require('./rate-limit');

const TOKEN_BYTES = 16;
const TOKEN_RE = /^[A-Za-z0-9_-]{22,64}$/;
const DEFAULT_TTL_HOURS = 24 * 14;

// Process-local copy of a token this process just minted, so the one-pager
// can render the link again without storing the raw token in the database.
const cache = new Map();

const DUMMY_HASH = crypto.randomBytes(32);

function ttlMs() {
  const raw = process.env.PILOT_DEMO_TOKEN_TTL_HOURS;
  if (raw == null || raw === '') return DEFAULT_TTL_HOURS * 3600 * 1000;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_TTL_HOURS * 3600 * 1000;
  const hours = Math.min(n, 24 * 365);
  return hours * 3600 * 1000;
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

async function resolveToken(raw) {
  const wellFormed = typeof raw === 'string' && TOKEN_RE.test(raw);
  const computed = wellFormed ? hashToken(raw) : DUMMY_HASH;
  const { rows } = await pool.query(
    `SELECT id, proposal_id, prospect_id, token_hash, expires_at, revoked_at
       FROM pilot_tokens WHERE token_hash = $1`,
    [computed]
  );
  const row = rows[0] || null;
  const stored = row && row.token_hash ? Buffer.from(row.token_hash) : null;
  // Always compare, including the miss path, so a missing row still runs
  // timingSafeEqual against the dummy hash.
  const equal = hashesEqual(stored, computed);
  if (!wellFormed || !row || !equal) return null;
  if (row.revoked_at) return null;
  if (new Date(row.expires_at).getTime() <= Date.now()) return null;
  return {
    id: row.id,
    proposal_id: Number(row.proposal_id),
    prospect_id: Number(row.prospect_id),
  };
}

async function mintForProposal(proposalId) {
  const id = Number(proposalId);
  if (!Number.isInteger(id) || id < 1) return null;
  const { rows } = await pool.query(
    `SELECT id, prospect_id, status FROM proposals WHERE id = $1`,
    [id]
  );
  const proposal = rows[0];
  if (!proposal || proposal.status === 'discarded') return null;

  const token = crypto.randomBytes(TOKEN_BYTES).toString('base64url');
  if (Buffer.from(token, 'base64url').length < TOKEN_BYTES) {
    throw new Error('Demo token was shorter than 16 bytes');
  }
  const expiresAt = new Date(Date.now() + ttlMs());
  const inserted = await pool.query(
    `INSERT INTO pilot_tokens (proposal_id, prospect_id, token_hash, expires_at)
     VALUES ($1, $2, $3, $4)
     RETURNING id, expires_at`,
    [proposal.id, proposal.prospect_id, hashToken(token), expiresAt]
  );
  cache.set(Number(proposal.id), { token, expiresAt: expiresAt.getTime() });
  return {
    id: inserted.rows[0].id,
    token,
    expires_at: inserted.rows[0].expires_at,
    proposal_id: Number(proposal.id),
    prospect_id: Number(proposal.prospect_id),
  };
}

async function revokeForProposal(proposalId) {
  const id = Number(proposalId);
  if (!Number.isInteger(id) || id < 1) return 0;
  const { rowCount } = await pool.query(
    `UPDATE pilot_tokens SET revoked_at = NOW()
      WHERE proposal_id = $1 AND revoked_at IS NULL`,
    [id]
  );
  cache.delete(id);
  return rowCount;
}

async function demoHrefForProposal(req, proposalId) {
  if (!flags.masterOn() || !flags.linkOn()) return '';
  const id = Number(proposalId);
  const cached = cache.get(id);
  if (cached && cached.expiresAt > Date.now()) {
    const row = await resolveToken(cached.token);
    if (row && row.proposal_id === id) return publicDemoPath(cached.token);
    cache.delete(id);
  }
  const gate = consume(clientIp(req), 'mint');
  if (gate.limited) return '';
  const minted = await mintForProposal(id);
  if (!minted) return '';
  return publicDemoPath(minted.token);
}

function _clearCacheForTests() {
  if (process.env.NODE_ENV !== 'test') {
    throw new Error('_clearCacheForTests is only available when NODE_ENV=test');
  }
  cache.clear();
}

module.exports = {
  TOKEN_BYTES,
  TOKEN_RE,
  hashToken,
  publicDemoPath,
  resolveToken,
  mintForProposal,
  revokeForProposal,
  demoHrefForProposal,
  _clearCacheForTests,
};
