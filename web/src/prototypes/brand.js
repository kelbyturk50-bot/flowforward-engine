// Brand input for a prototype screen: { name, logoUrl, colors }.
// Logos are a bundled id or an https URL. This build never requests the URL.
// Colors are hex only. The painted theme is contrast-checked for text.

export const BUNDLED_LOGO_ID = 'bundled:test-wasatch-heating';
export const BRAND_NAME_MAX = 80;
export const PAPER = '#F3F6F5';
export const SURFACE = '#FFFFFF';
// Same hex as the --juniper / --accent theme token.
export const JUNIPER_ACCENT = '#2F6B57';
export const FALLBACK_INK = '#1E2A2F';
export const FALLBACK_NAME = 'TEST: Wasatch Heating';

const ACCENT_BACKGROUNDS = Object.freeze([SURFACE, PAPER]);

const HEX = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;
const AA = 4.5;

function stripControls(value) {
  return Array.from(String(value ?? '')).filter((ch) => {
    const code = ch.codePointAt(0);
    return code > 0x1f && code !== 0x7f && code !== 0x2028 && code !== 0x2029;
  }).join('');
}

export function sanitizeName(value) {
  return stripControls(value).trim().slice(0, BRAND_NAME_MAX);
}

export function normalizeHex(value) {
  const raw = String(value ?? '').trim();
  if (!HEX.test(raw)) return '';
  const body = raw.slice(1);
  const full = body.length === 3 ? body.split('').map(ch => ch + ch).join('') : body;
  return `#${full.toUpperCase()}`;
}

function channel(hex, index) {
  return Number.parseInt(hex.slice(1 + index * 2, 3 + index * 2), 16);
}

function luminance(hex) {
  const parts = [0, 1, 2].map((index) => {
    const unit = channel(hex, index) / 255;
    return unit <= 0.03928 ? unit / 12.92 : ((unit + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * parts[0] + 0.7152 * parts[1] + 0.0722 * parts[2];
}

export function contrastRatio(a, b) {
  const left = luminance(normalizeHex(a) || a);
  const right = luminance(normalizeHex(b) || b);
  const lighter = Math.max(left, right);
  const darker = Math.min(left, right);
  return (lighter + 0.05) / (darker + 0.05);
}

export function paintAccent(value, backgrounds = ACCENT_BACKGROUNDS) {
  const color = normalizeHex(value);
  if (!color) return '';
  const passes = backgrounds.every(background => contrastRatio(color, background) >= AA);
  return passes ? color : '';
}

// Brand color is an accent on paper and card surfaces. A miss falls back to juniper.
export function resolveAccent(colors) {
  const bag = colorBag(colors);
  for (const value of [bag.accent, bag.primary]) {
    const color = paintAccent(value);
    if (color) return color;
  }
  return JUNIPER_ACCENT;
}

export function sanitizeLogoUrl(value, bundled = [BUNDLED_LOGO_ID]) {
  const raw = stripControls(value).trim();
  if (!raw) return '';
  if (bundled.includes(raw)) return raw;
  let url;
  try { url = new URL(raw); }
  catch { return ''; }
  if (url.protocol !== 'https:') return '';
  if (url.username || url.password) return '';
  if (!url.hostname) return '';
  return url.href;
}

function colorBag(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return value;
}

export function presentBrand(input, { fallbackName = FALLBACK_NAME } = {}) {
  const colors = colorBag(input?.colors);
  const name = sanitizeName(input?.name) || fallbackName;
  const logoUrl = sanitizeLogoUrl(input?.logoUrl);
  return {
    name,
    logoUrl,
    colors: {
      primary: normalizeHex(colors.primary),
      accent: normalizeHex(colors.accent),
      ink: normalizeHex(colors.ink),
    },
    theme: {
      accent: resolveAccent(colors),
    },
  };
}
