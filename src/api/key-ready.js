// Shared CRM_API_KEY strength check. Pilot intake and flag writes both use it.
// Trim, then drop every whitespace character. 32 spaces, or 31 characters
// plus a space, are not ready. A missing value is not ready.

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
