// Coarse view classification. The raw user-agent string is an input to
// these functions and is never stored. BOT_UA is the same pattern the
// one-pager has always used to skip the views counter.

const BOT_UA = /bot|crawler|spider|preview|slurp|facebookexternalhit|google-?(read|inspection)|linkedin|skype|whatsapp|proofpoint|mimecast|barracuda|scanner/i;

const UA_CLASSES = Object.freeze(['empty', 'bot', 'browser', 'other']);

const REASONS = Object.freeze([
  'head',
  'prefetch',
  'preview',
  'internal_header',
  'internal_cookie',
  'bot_ua',
  'within_2m',
  'burst',
]);

// About one year. A cookie path is a single prefix. Path=/ is the prefix
// that covers both /p/ and the /demo/ routes on the API origin.
const INTERNAL_COOKIE = 'ff_internal=1; Max-Age=31536000; Path=/; HttpOnly; Secure; SameSite=Lax';
const TWO_MINUTES_MS = 2 * 60 * 1000;

function uaClass(ua) {
  const value = typeof ua === 'string' ? ua : '';
  if (!value.trim()) return 'empty';
  if (BOT_UA.test(value)) return 'bot';
  if (/Mozilla|Chrome|Safari|Firefox|Edg\//i.test(value)) return 'browser';
  return 'other';
}

function hasInternalCookie(cookie) {
  const header = typeof cookie === 'string' ? cookie : '';
  for (const part of header.split(';')) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const eq = trimmed.indexOf('=');
    const name = eq === -1 ? trimmed : trimmed.slice(0, eq);
    const value = eq === -1 ? '' : trimmed.slice(eq + 1);
    if (name === 'ff_internal' && value === '1') return true;
  }
  return false;
}

function isPrefetch(purpose, secPurpose) {
  const purposeText = String(purpose || '').toLowerCase();
  const secText = String(secPurpose || '').toLowerCase();
  if (purposeText.includes('prefetch')) return true;
  return secText.includes('prefetch') || secText.includes('prerender');
}

// First match wins. The internal header sits immediately after preview.
// It can only add an exclusion. A later rule never runs once it matches,
// and it never clears head, prefetch, or preview. Burst is applied after
// the row is stored, and only replaces a null reason. The window is
// BURST_WINDOW in store.js. Callers pass internalHeader only while
// FF_PROSPECT_VIEWS is on; the check itself is the exact value 1.
function exclusionReason({ method, ua, purpose, secPurpose, preview, internalHeader, cookie, sentAt, at }) {
  if (String(method || 'GET').toUpperCase() === 'HEAD') return 'head';
  if (isPrefetch(purpose, secPurpose)) return 'prefetch';
  if (preview === true || preview === '1') return 'preview';
  if (internalHeader === true || internalHeader === '1') return 'internal_header';
  if (hasInternalCookie(cookie)) return 'internal_cookie';
  if (BOT_UA.test(typeof ua === 'string' ? ua : '')) return 'bot_ua';
  if (sentAt != null) {
    const sent = new Date(sentAt).getTime();
    const viewed = new Date(at).getTime();
    // "2 minutes or less after sent_at": from the send through that instant.
    // A view timestamp before sent_at is not this window.
    if (Number.isFinite(sent) && Number.isFinite(viewed) && viewed >= sent && viewed - sent <= TWO_MINUTES_MS) {
      return 'within_2m';
    }
  }
  return null;
}

module.exports = {
  BOT_UA,
  UA_CLASSES,
  REASONS,
  INTERNAL_COOKIE,
  TWO_MINUTES_MS,
  uaClass,
  hasInternalCookie,
  isPrefetch,
  exclusionReason,
};
