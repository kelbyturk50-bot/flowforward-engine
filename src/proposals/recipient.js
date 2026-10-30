// One recipient check for follow-ups, mark-sent, and the claim.
// An address is refused when it contains a Unicode control (Cc), format (Cf),
// or separator (Z*) character, or when it is not a plausible address.
// web/src/recipient.js is the same functions. A test checks they match.

const PLAUSIBLE = /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i;
const FORBIDDEN = /[\p{Cc}\p{Cf}\p{Z}]/u;

function recipientText(email) {
  if (email == null) return '';
  return String(email);
}

function missingRecipient(email) {
  const text = recipientText(email);
  if (!text || FORBIDDEN.test(text)) return true;
  return !PLAUSIBLE.test(text);
}

function normalizeRecipient(email) {
  return missingRecipient(email) ? '' : recipientText(email);
}

function recipientHint(email) {
  if (recipientText(email).trim() === '') return 'Add a recipient email first';
  return 'Fix the recipient email';
}

module.exports = { missingRecipient, normalizeRecipient, recipientHint };
