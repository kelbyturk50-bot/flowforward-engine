// Brand input for a prototype screen: { name, logoUrl, colors }.
// Logos are a bundled id or an https URL. This build never requests the URL.
// Colors are hex only. The painted theme is contrast-checked for text.

export const BUNDLED_LOGO_ID = 'bundled:test-wasatch-heating';
export const BRAND_NAME_MAX = 80;
export const PAPER = '#F3F6F5';
export const FALLBACK_PRIMARY = '#2F6B57';
export const FALLBACK_INK = '#1E2A2F';
export const FALLBACK_NAME = 'TEST: Wasatch Heating';

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

function readableOn(background) {
  if (contrastRatio(background, '#FFFFFF') >= AA) return '#FFFFFF';
  if (contrastRatio(background, FALLBACK_INK) >= AA) return FALLBACK_INK;
  return '';
}

export function paintPrimary(value) {
  const color = normalizeHex(value);
  if (color && readableOn(color)) return color;
  return FALLBACK_PRIMARY;
}

export function onPrimary(primary) {
  return readableOn(primary) || '#FFFFFF';
}

export function paintText(value, background = PAPER) {
  const color = normalizeHex(value);
  if (color && contrastRatio(color, background) >= AA) return color;
  return FALLBACK_INK;
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
  const primary = paintPrimary(colors.primary);
  return {
    name,
    logoUrl,
    colors: {
      primary: normalizeHex(colors.primary),
      accent: normalizeHex(colors.accent),
      ink: normalizeHex(colors.ink),
    },
    theme: {
      primary,
      onPrimary: onPrimary(primary),
      accent: paintText(colors.accent),
      ink: paintText(colors.ink),
    },
  };
}
