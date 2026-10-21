// Server copy of web/src/prototypes/brand.js color rules (prototype-system.md §2).
// Keep the two in step. Pure functions, no I/O.
const BUNDLED_LOGO_ID = 'bundled:test-wasatch-heating';
const BRAND_NAME_MAX = 80;
const PAPER = '#F3F6F5';
const SURFACE = '#FFFFFF';
// Dark-mode tokens from styles.css (`prefers-color-scheme: dark`).
const DARK_PAPER = '#141C1F';
const DARK_SURFACE = '#1C262A';
// Same hex as the --juniper / --accent theme token. Dark juniper is the dark-mode token.
const JUNIPER_ACCENT = '#2F6B57';
const JUNIPER_DARK = '#5FAE8E';
const SLATE = '#1E2A2F';
const FALLBACK_INK = SLATE;
const FALLBACK_NAME = 'TEST: Wasatch Heating';
const BUNDLED_MARK_COLOR = '#1F4E79';
const CHROMA_CAP = 0.20;
const LOGO_PLATE_MIN = 3;

const LIGHT_BACKGROUNDS = Object.freeze([SURFACE, PAPER]);
const DARK_BACKGROUNDS = Object.freeze([DARK_SURFACE, DARK_PAPER]);
const HEX = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;
const AA = 4.5;

function stripControls(value) {
  return Array.from(String(value ?? '')).filter((ch) => {
    const code = ch.codePointAt(0);
    return code > 0x1f && code !== 0x7f && code !== 0x2028 && code !== 0x2029;
  }).join('');
}

function isBidiOrZeroWidth(code) {
  if (code >= 0x202A && code <= 0x202E) return true;
  if (code >= 0x2066 && code <= 0x2069) return true;
  if (code === 0x200E || code === 0x200F || code === 0x061C) return true;
  return code === 0x200B || code === 0x200C || code === 0x200D || code === 0x2060 || code === 0xFEFF || code === 0x180E;
}

function sanitizeName(value) {
  const visible = Array.from(stripControls(value)).filter((ch) => !isBidiOrZeroWidth(ch.codePointAt(0))).join('');
  return visible.trim().slice(0, BRAND_NAME_MAX);
}

function normalizeHex(value) {
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

function contrastRatio(a, b) {
  const left = luminance(normalizeHex(a) || a);
  const right = luminance(normalizeHex(b) || b);
  const lighter = Math.max(left, right);
  const darker = Math.min(left, right);
  return (lighter + 0.05) / (darker + 0.05);
}

function srgbToLinear(channel) {
  const unit = channel / 255;
  return unit <= 0.04045 ? unit / 12.92 : ((unit + 0.055) / 1.055) ** 2.4;
}

function linearToByte(linear) {
  const unit = Math.min(1, Math.max(0, linear));
  const encoded = unit <= 0.0031308 ? 12.92 * unit : 1.055 * (unit ** (1 / 2.4)) - 0.055;
  return Math.round(Math.min(1, Math.max(0, encoded)) * 255);
}

function hexToRgb(hex) {
  return [0, 1, 2].map(index => channel(hex, index));
}

function hexToOklch(hex) {
  const [red, green, blue] = hexToRgb(hex).map(srgbToLinear);
  const l = 0.4122214708 * red + 0.5363325363 * green + 0.0514459929 * blue;
  const m = 0.2119034982 * red + 0.6806995451 * green + 0.1073969566 * blue;
  const s = 0.0883024619 * red + 0.2817188376 * green + 0.6299787005 * blue;
  const lRoot = Math.cbrt(l);
  const mRoot = Math.cbrt(m);
  const sRoot = Math.cbrt(s);
  const labA = 1.9779984951 * lRoot - 2.4285922050 * mRoot + 0.4505937099 * sRoot;
  const labB = 0.0259040371 * lRoot + 0.7827717662 * mRoot - 0.8086757660 * sRoot;
  let hue = Math.atan2(labB, labA) * 180 / Math.PI;
  if (hue < 0) hue += 360;
  return {
    L: 0.2104542553 * lRoot + 0.7936177850 * mRoot - 0.0040720468 * sRoot,
    C: Math.hypot(labA, labB),
    H: hue,
  };
}

function oklchToLinear(lightness, chroma, hue) {
  const radians = hue * Math.PI / 180;
  const labA = chroma * Math.cos(radians);
  const labB = chroma * Math.sin(radians);
  const lRoot = lightness + 0.3963377774 * labA + 0.2158037573 * labB;
  const mRoot = lightness - 0.1055613458 * labA - 0.0638541728 * labB;
  const sRoot = lightness - 0.0894841775 * labA - 1.2914855480 * labB;
  const l = lRoot ** 3;
  const m = mRoot ** 3;
  const s = sRoot ** 3;
  return {
    r: 4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    g: -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    b: -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s,
  };
}

function inGamut(color) {
  return [color.r, color.g, color.b].every(channelValue => channelValue >= -1e-4 && channelValue <= 1 + 1e-4);
}

function linearToHex(color) {
  const byte = (value) => linearToByte(value).toString(16).padStart(2, '0');
  return `#${byte(color.r)}${byte(color.g)}${byte(color.b)}`.toUpperCase();
}

function fitChroma(lightness, chroma, hue) {
  if (inGamut(oklchToLinear(lightness, chroma, hue))) return chroma;
  let low = 0;
  let high = chroma;
  for (let step = 0; step < 24; step += 1) {
    const mid = (low + high) / 2;
    if (inGamut(oklchToLinear(lightness, mid, hue))) low = mid;
    else high = mid;
  }
  return low;
}

function snapLightness(value) {
  return Math.round(value * 100) / 100;
}

function passesSurfaces(hex, backgrounds) {
  return backgrounds.every(background => contrastRatio(hex, background) >= AA);
}

// Same-hue search. `down` darkens from the source lightness and stops at the
// first color that clears the backgrounds. `up` lightens first, then darkens.
function paintAccent(normalized, backgrounds, direction) {
  const oklch = hexToOklch(normalized);
  if (oklch.C <= CHROMA_CAP && passesSurfaces(normalized, backgrounds)) {
    const onAccent = pickOnAccent(normalized);
    if (onAccent) return { accent: normalized, onAccent };
  }
  const chroma = Math.min(oklch.C, CHROMA_CAP);
  const start = snapLightness(oklch.L);
  const steps = [];
  const pushDown = () => {
    for (let lightness = start; lightness >= 0.05 - 1e-9; lightness = snapLightness(lightness - 0.01)) {
      steps.push(lightness);
    }
  };
  const pushUp = (includeStart) => {
    const first = includeStart ? start : snapLightness(start + 0.01);
    for (let lightness = first; lightness <= 0.98 + 1e-9; lightness = snapLightness(lightness + 0.01)) {
      steps.push(lightness);
    }
  };
  if (direction === 'up') {
    pushUp(true);
    for (let lightness = snapLightness(start - 0.01); lightness >= 0.05 - 1e-9; lightness = snapLightness(lightness - 0.01)) {
      steps.push(lightness);
    }
  } else {
    pushDown();
  }
  for (const lightness of steps) {
    const fitted = fitChroma(lightness, chroma, oklch.H);
    const hex = linearToHex(oklchToLinear(lightness, fitted, oklch.H));
    if (!passesSurfaces(hex, backgrounds)) continue;
    const onAccent = pickOnAccent(hex);
    if (onAccent) return { accent: hex, onAccent };
  }
  return null;
}

function pickOnAccent(accent) {
  const onWhite = contrastRatio(accent, SURFACE);
  const onSlate = contrastRatio(accent, SLATE);
  const choice = onWhite >= onSlate ? SURFACE : SLATE;
  const ratio = choice === SURFACE ? onWhite : onSlate;
  return ratio >= AA ? choice : '';
}

const JUNIPER_THEME = Object.freeze({ accent: JUNIPER_ACCENT, onAccent: SURFACE });

// Cap OKLCH chroma, then darken at the same hue until the accent is 4.5:1
// on paper and on white. A miss falls back to juniper.
function fixAccent(value) {
  const normalized = normalizeHex(value);
  if (!normalized) return { ...JUNIPER_THEME };
  return paintAccent(normalized, LIGHT_BACKGROUNDS, 'down') || { ...JUNIPER_THEME };
}

// Dark mode uses the same hue against the dark paper and surface. Lighten
// first. A miss falls back to the dark juniper token, then paper.
function fixAccentDark(value) {
  const normalized = normalizeHex(value);
  const found = normalized && paintAccent(normalized, DARK_BACKGROUNDS, 'up');
  if (found) return found;
  return paintAccent(JUNIPER_DARK, DARK_BACKGROUNDS, 'up')
    || paintAccent(PAPER, DARK_BACKGROUNDS, 'up')
    || { accent: PAPER, onAccent: SLATE };
}

module.exports = { normalizeHex, contrastRatio, fixAccent, pickOnAccent, sanitizeName, JUNIPER_ACCENT, PAPER, SURFACE, SLATE };
