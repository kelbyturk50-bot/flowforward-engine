import { publicApiBase, publicJson } from './public-client.js';

export const PUBLIC_FLAGS_PATH = '/api/public/flags';

const FLAG_ORDER = ['FF_PROTOTYPE_GALLERY', 'FF_LIVE_CHAT_DEMO'];

export function parsePublicFlags(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  const keys = Object.keys(data);
  if (keys.length !== FLAG_ORDER.length) return null;
  for (let index = 0; index < FLAG_ORDER.length; index += 1) {
    const key = FLAG_ORDER[index];
    if (keys[index] !== key || typeof data[key] !== 'boolean') return null;
  }
  return {
    FF_PROTOTYPE_GALLERY: data.FF_PROTOTYPE_GALLERY,
    FF_LIVE_CHAT_DEMO: data.FF_LIVE_CHAT_DEMO,
  };
}

export function publicFlagsOpen(flags) {
  return flags?.FF_PROTOTYPE_GALLERY === true && flags?.FF_LIVE_CHAT_DEMO === true;
}

// Null means the public flags are off or unreadable. Callers then use the
// preview override, or the not-found view.
export async function readPublicFlags() {
  const base = publicApiBase();
  if (!base.configured || !base.url) return null;
  try {
    const { status, data } = await publicJson('GET', PUBLIC_FLAGS_PATH);
    if (status !== 200) return null;
    return parsePublicFlags(data);
  } catch {
    return null;
  }
}
