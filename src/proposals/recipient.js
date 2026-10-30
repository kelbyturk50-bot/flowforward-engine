// One recipient check for drafts, edits, follow-ups, mark-sent, and replies.
// web/src/recipient.js is the same functions. A test checks they match.
//
// canonicalizeRecipient trims only the edges, then accepts a single address.
// A zero-width space is not edge whitespace, so it is rejected and not stored.
// Send paths refuse when the stored value is not already that canonical string.

const EDGE_CHARS = '\t\n\u000b\u000c\r \u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000';
const ADDRESS = /^[A-Za-z0-9!#$%&'*+/=?^_`{|}~.-]+@[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*\.[A-Za-z]{2,}$/;

function recipientText(email) {
  if (email == null) return '';
  return String(email);
}

function trimEdges(text) {
  let start = 0;
  let end = text.length;
  while (start < end && EDGE_CHARS.includes(text[start])) start += 1;
  while (end > start && EDGE_CHARS.includes(text[end - 1])) end -= 1;
  return text.slice(start, end);
}

function canonicalizeRecipient(raw) {
  const value = trimEdges(recipientText(raw));
  if (!value) return { ok: false, value: '', reason: 'empty' };
  if (!ADDRESS.test(value)) return { ok: false, value: '', reason: 'invalid' };
  return { ok: true, value, reason: null };
}

function missingRecipient(email) {
  const text = recipientText(email);
  const canonical = canonicalizeRecipient(email);
  if (!canonical.ok) return true;
  return canonical.value !== text;
}

function normalizeRecipient(email) {
  const text = recipientText(email);
  const canonical = canonicalizeRecipient(email);
  if (!canonical.ok || canonical.value !== text) return '';
  return canonical.value;
}

function recipientHint(email) {
  if (trimEdges(recipientText(email)) === '') return 'Add a recipient email first';
  return 'Fix the recipient email';
}

module.exports = { canonicalizeRecipient, missingRecipient, normalizeRecipient, recipientHint };
