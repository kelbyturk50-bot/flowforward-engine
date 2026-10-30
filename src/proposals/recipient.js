// One recipient check for follow-ups, mark-sent, and the follow-up claim.
// Invisible and control characters are removed, then the rest has to be a
// plausible address. The same rules are copied in web/src/recipient.js.

const PLAUSIBLE = /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i;

function isInvisible(code) {
  return (code >= 0 && code <= 0x1F)
    || code === 0x7F
    || (code >= 0x80 && code <= 0x9F)
    || code === 0xAD
    || code === 0x180E
    || (code >= 0x200B && code <= 0x200F)
    || (code >= 0x202A && code <= 0x202E)
    || (code >= 0x2060 && code <= 0x2064)
    || (code >= 0x2066 && code <= 0x2069)
    || code === 0xFEFF;
}

function normalizeRecipient(email) {
  let out = '';
  const text = String(email ?? '');
  for (const ch of text) {
    if (!isInvisible(ch.codePointAt(0))) out += ch;
  }
  return out.trim();
}

function missingRecipient(email) {
  return !PLAUSIBLE.test(normalizeRecipient(email));
}

module.exports = { normalizeRecipient, missingRecipient };
