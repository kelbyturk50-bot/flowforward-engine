// Shared CRM_API_KEY strength check for pilot intake.
// Trim, then drop every whitespace character. 32 spaces, or 31 characters
// plus a space, are not ready. A missing value is not ready.
// GET and PUT /api/flags use the trim-only guard in src/api/flags.js.

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
