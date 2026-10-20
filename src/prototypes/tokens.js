// Opaque prototype links.
//
// Each row gets a random 32-byte nonce. The link token is the full
// HMAC-SHA256 of `prototype:v1:<nonce>`, unpadded base64url (43 chars).
// The HMAC key is HKDF-SHA256 over CRM_API_KEY with info `ff-prototype`,
// the same pattern as the pilot demo tokens (src/pilot/tokens.js), so no new
// env var is needed. The database stores the nonce and the SHA-256 of the
// token, never the token itself. The CRM can show the link again after a
// restart because the server recomputes it from the nonce.
//
// CRM_API_KEY must have at least 32 non-whitespace characters. Without it,
// new prototypes are refused and existing links cannot be recomputed.
// Rotating CRM_API_KEY changes every recomputed link: old links stop
// matching their stored hash and return 404.

const crypto = require('crypto');
const { crmApiKeyReady } = require('../api/crm-key');

const TOKEN_BYTES = 32;
const NONCE_BYTES = 32;
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
const HKDF_INFO = 'ff-prototype';
const LABEL = 'prototype:v1:';

const DUMMY_HASH = crypto.randomBytes(32);

let cachedKey = null;
let cachedFrom = null;

function keyReady() {
  return crmApiKeyReady();
}

function hmacKey() {
  if (!keyReady()) return null;
  const secret = process.env.CRM_API_KEY;
  if (cachedKey && cachedFrom === secret) return cachedKey;
  cachedKey = Buffer.from(crypto.hkdfSync('sha256', Buffer.from(secret, 'utf8'), Buffer.alloc(0), Buffer.from(HKDF_INFO), 32));
  cachedFrom = secret;
  return cachedKey;
}

function tokenFor(nonce) {
  const key = hmacKey();
  if (!key || !Buffer.isBuffer(nonce) || nonce.length !== NONCE_BYTES) return null;
  return crypto.createHmac('sha256', key).update(LABEL + nonce.toString('base64url')).digest('base64url');
}

function hashToken(token) {
  return crypto.createHash('sha256').update(String(token), 'utf8').digest();
}

// Returns { nonce, token, hash } or null when CRM_API_KEY is not ready.
function mintToken() {
  const nonce = crypto.randomBytes(NONCE_BYTES);
  const token = tokenFor(nonce);
  if (!token) return null;
  return { nonce, token, hash: hashToken(token) };
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
  NONCE_BYTES,
  keyReady,
  tokenFor,
  mintToken,
  hashToken,
  hashesEqual,
  publicPath,
  tokenWellFormed,
  DUMMY_HASH,
};
