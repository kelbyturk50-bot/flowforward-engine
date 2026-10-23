// Business name shown on a prototype and in the live-chat demo.
// Length and character checks match the prototypes.brand_name constraint.
// Ordinary words are allowed. The not-affiliated banner stays on the page.

const MAX_LEN = 120;
const HOSTILE = /[\u0000-\u001F\u007F<>\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]/;

function codePoints(value) {
  return Array.from(value).length;
}

function brandNameOk(value) {
  if (typeof value !== 'string') return false;
  const name = value.trim();
  if (name !== value) return false;
  const n = codePoints(name);
  if (n < 1 || n > MAX_LEN) return false;
  if (HOSTILE.test(name)) return false;
  return true;
}

// A stored name that fails the check is not shown. Callers still escape.
function publicBrandName(value) {
  const name = typeof value === 'string' ? value.trim() : '';
  return brandNameOk(name) ? name : 'this business';
}

module.exports = { MAX_LEN, brandNameOk, publicBrandName };
