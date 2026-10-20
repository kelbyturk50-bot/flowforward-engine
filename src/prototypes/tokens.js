// Opaque prototype links.
//
// The token is 32 bytes from crypto.randomBytes, unpadded base64url.
// The database stores only the SHA-256 of that token. The raw token is
// not derived from CRM_API_KEY, the prospect id, or issued_at, and it
// cannot be rebuilt later. Creating a prototype does not read the API key.

const crypto = require('crypto');

const TOKEN_BYTES = 32;
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

const DUMMY_HASH = crypto.randomBytes(32);

function mintToken() {
  const token = crypto.randomBytes(TOKEN_BYTES).toString('base64url');
  return { token, hash: hashToken(token) };
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
  mintToken,
  hashToken,
  hashesEqual,
  publicPath,
  tokenWellFormed,
  DUMMY_HASH,
};
