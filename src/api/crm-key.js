// Strength rule shared with the pilot CSV routes.
// Trim, drop whitespace, then require at least 32 characters.
// 32 spaces stay closed. This does not compare a presented header
// and it does not log the key.

const MIN_API_KEY_LENGTH = 32;

function crmApiKeyReady() {
  const secret = process.env.CRM_API_KEY;
  const compact = typeof secret === 'string' ? secret.trim().replace(/\s/g, '') : '';
  return compact.length >= MIN_API_KEY_LENGTH;
}

module.exports = { MIN_API_KEY_LENGTH, crmApiKeyReady };
