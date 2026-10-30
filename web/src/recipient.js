// Same functions as src/proposals/recipient.js. An address is refused when it
// contains a Unicode control (Cc), format (Cf), or separator (Z*) character,
// or when it is not a plausible address.

const PLAUSIBLE = /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i;
const FORBIDDEN = /[\p{Cc}\p{Cf}\p{Z}]/u;

function recipientText(email) {
  if (email == null) return '';
  return String(email);
}

export function missingRecipient(email) {
  const text = recipientText(email);
  if (!text || FORBIDDEN.test(text)) return true;
  return !PLAUSIBLE.test(text);
}

export function normalizeRecipient(email) {
  return missingRecipient(email) ? '' : recipientText(email);
}

export function recipientHint(email) {
  if (recipientText(email).trim() === '') return 'Add a recipient email first';
  return 'Fix the recipient email';
}
