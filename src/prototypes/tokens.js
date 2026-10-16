// Opaque prototype links.
//
// The token is the 32-byte HMAC-SHA256 of
// `prototype:v1:${prospect_id}:${issued_at_ms}`, unpadded base64url.
// The HMAC key is HKDF-SHA256 over CRM_API_KEY with info `ff-prototype`.
// CRM_API_KEY must be at least 32 characters. When it is missing or shorter,
// no link is minted and a later read cannot rebuild one. The warning does
// not include the key.
//
// The database stores the SHA-256 of that token. It does not store the raw
// token. A later GET recomputes the HMAC from the prospect and issued_at.
// 32 bytes is 256 bits. Rotating CRM_API_KEY makes an old link fail the
// recomputed check, so a leaked link still needs
// POST /api/prototypes/:id/revoke.

const crypto = require('crypto');

const TOKEN_BYTES = 32;
const MIN_SECRET_LENGTH = 32;
const HKDF_INFO = 'ff-prototype';
const TOKEN_LABEL = 'prototype:v1';
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

const DUMMY_HASH = crypto.randomBytes(32);

let derivedKey = null;
let derivedFrom = null;
let missingSecretWarned = false;

function serverSecret() {
  const secret = process.env.CRM_API_KEY;
  if (typeof secret !== 'string' || secret.length < MIN_SECRET_LENGTH) return '';
  return secret;
}

function macKey() {
  const secret = serverSecret();
  if (!secret) {
    if (!missingSecretWarned) {
      missingSecretWarned = true;
      console.warn('[prototype] CRM_API_KEY must be at least 32 characters — prototype links stay off.');
    }
    return null;
  }
  missingSecretWarned = false;
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

function issuedStamp(issuedAt) {
  const ms = new Date(issuedAt).getTime();
  if (!Number.isFinite(ms)) return null;
  return String(ms);
}

function deriveToken(prospectId, issuedAt) {
  const key = macKey();
  const id = Number(prospectId);
  const stamp = issuedStamp(issuedAt);
  if (!key || !Number.isInteger(id) || id < 1 || !stamp) return null;
  const message = `${TOKEN_LABEL}:${id}:${stamp}`;
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

function publicPath(token) {
  return `/demo/prototype/${token}`;
}

function tokenWellFormed(raw) {
  return typeof raw === 'string' && TOKEN_RE.test(raw);
}

module.exports = {
  TOKEN_BYTES,
  deriveToken,
  hashToken,
  hashesEqual,
  publicPath,
  tokenWellFormed,
  DUMMY_HASH,
};
