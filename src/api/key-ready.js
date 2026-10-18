// Shared CRM_API_KEY strength check for pilot intake and GET/PUT /api/flags.
// Trim, then drop every whitespace character. 32 spaces, 31 characters plus
// a space, or a longer value whose inner spaces leave fewer than 32
// non-whitespace characters, are not ready. A missing value is not ready.

const MIN_API_KEY_LENGTH = 32;

function crmApiKeyReady() {
  const secret = process.env.CRM_API_KEY;
  const compact = typeof secret === 'string' ? secret.trim().replace(/\s/g, '') : '';
  return compact.length >= MIN_API_KEY_LENGTH;
}

module.exports = {
  MIN_API_KEY_LENGTH,
  crmApiKeyReady,
};
