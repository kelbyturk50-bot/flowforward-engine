// Public fixture preview. The flag gate is the only switch. A matching path
// does not authenticate anyone. The route sits under /demo so the existing
// X-Robots-Tag on /demo/:path* covers it.

const LIVE_CHAT = /^\/demo\/live-chat\/?$/;

export const LIVE_CHAT_PATH = '/demo/live-chat';

export function liveChatRouteFromPath(pathname) {
  return LIVE_CHAT.test(String(pathname ?? '')) ? { screen: 'live-chat' } : null;
}

function encodeList(value) {
  return String(value)
    .split(',')
    .map((part) => encodeURIComponent(part.trim()))
    .filter(Boolean)
    .join(',');
}

export function liveChatHref(search = '') {
  const current = new URLSearchParams(String(search || '').replace(/^\?/, ''));
  const flags = current.get('flags');
  if (!flags) return LIVE_CHAT_PATH;
  return `${LIVE_CHAT_PATH}?flags=${encodeList(flags)}`;
}
