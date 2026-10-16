// Brand object validation for v1. Accepts fixtures and manual entry.
// Rejects a bad hex color and any logo URL that is not http(s), including
// userinfo, javascript:, and data:. Does not fetch the URL and does not
// resolve DNS. A stored logoUrl is text until a later, separately approved
// fetcher exists.

const HEX_3 = /^#([0-9a-fA-F]{3})$/;
const HEX_6 = /^#([0-9a-fA-F]{6})$/;
const TEST_TAG = /^TEST:[a-z0-9]+(?:-[a-z0-9]+)*$/;
const NAME_MAX = 120;
const TAG_MAX = 80;
const URL_MAX = 300;
const COLOR_MAX = 8;
const SOURCES = new Set(['fixture', 'manual']);
// Markup, C0/C1 controls, bidi overrides and isolates, and zero-width characters.
const HOSTILE_TEXT = /[<>\u0000-\u001F\u007F-\u009F\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]/;
// Characters that would break out of a CSS url() if a later screen interpolates the value.
const CSS_BREAK = /[\s'"()\\;<>`{}\u0000-\u001F\u007F-\u009F\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]/;
const PHONE_SEPARATORS = /[\s().+\-/\u2010-\u2015\u2212]/g;

function fail(field, message) {
  return { ok: false, field, message };
}

function expandHex(value) {
  const text = String(value).trim();
  const short = HEX_3.exec(text);
  if (short) {
    const [r, g, b] = short[1].toLowerCase().split('');
    return `#${r}${r}${g}${g}${b}${b}`;
  }
  const long = HEX_6.exec(text);
  if (long) return `#${long[1].toLowerCase()}`;
  return null;
}

function validateColors(value) {
  if (!Array.isArray(value)) return fail('colors', 'colors must be an array of hex colors');
  if (value.length > COLOR_MAX) return fail('colors', `colors accepts at most ${COLOR_MAX} values`);
  const colors = [];
  for (const entry of value) {
    if (typeof entry !== 'string') return fail('colors', 'each color must be a #rgb or #rrggbb hex');
    const hex = expandHex(entry);
    if (!hex) return fail('colors', 'each color must be a #rgb or #rrggbb hex');
    colors.push(hex);
  }
  return { ok: true, colors };
}

function validateLogoUrl(value) {
  if (value == null) return { ok: true, logoUrl: null };
  if (typeof value !== 'string') return fail('logoUrl', 'logoUrl must be an http or https URL');
  const raw = value.trim();
  if (!raw) return { ok: true, logoUrl: null };
  if (raw.length > URL_MAX) return fail('logoUrl', 'logoUrl is too long');
  if (CSS_BREAK.test(raw)) return fail('logoUrl', 'logoUrl must be an http or https URL');
  if (!/^https?:\/\//i.test(raw)) return fail('logoUrl', 'logoUrl must be an http or https URL');
  let url;
  try { url = new URL(raw); }
  catch { return fail('logoUrl', 'logoUrl must be an http or https URL'); }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return fail('logoUrl', 'logoUrl must be an http or https URL');
  }
  if (url.username || url.password) return fail('logoUrl', 'logoUrl must not include userinfo');
  if (!url.hostname) return fail('logoUrl', 'logoUrl must be an http or https URL');
  if (CSS_BREAK.test(url.href)) return fail('logoUrl', 'logoUrl must be an http or https URL');
  const authority = raw.replace(/^https?:\/\//i, '').split(/[/?#]/)[0];
  if (authority.includes('@')) return fail('logoUrl', 'logoUrl must not include userinfo');
  return { ok: true, logoUrl: url.href };
}

function validateName(value) {
  if (typeof value !== 'string') return fail('name', 'name must start with TEST:');
  const name = value.trim();
  if (!name.startsWith('TEST:')) return fail('name', 'name must start with TEST:');
  if (name.length < 6 || name.length > NAME_MAX) return fail('name', 'name must start with TEST:');
  if (HOSTILE_TEXT.test(name)) return fail('name', 'name must not contain markup or hidden characters');
  const visible = name.slice(5).replace(/\s/g, '');
  if (!visible) return fail('name', 'name must include a visible character');
  if (name.includes('@')) return fail('name', 'name must not contain an email address');
  const digits = name.replace(PHONE_SEPARATORS, '');
  if (/\d{7,}/.test(digits)) return fail('name', 'name must not contain a phone number');
  return { ok: true, name };
}

function validateTestTag(value) {
  if (typeof value !== 'string') return fail('testTag', 'testTag must start with TEST:');
  const testTag = value.trim();
  if (testTag.length > TAG_MAX || !TEST_TAG.test(testTag)) {
    return fail('testTag', 'testTag must start with TEST: and use a lowercase slug');
  }
  return { ok: true, testTag };
}

function validateSource(value) {
  if (!SOURCES.has(value)) return fail('source', 'source must be fixture or manual');
  return { ok: true, source: value };
}

function validateProspectId(value) {
  if (value == null || value === '') return { ok: true, prospectId: null };
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 2147483647) {
    return fail('prospectId', 'prospectId must be a positive integer');
  }
  return { ok: true, prospectId: value };
}

function validateBrand(input) {
  const body = input && typeof input === 'object' ? input : {};
  const name = validateName(body.name);
  if (!name.ok) return name;
  const logo = validateLogoUrl(body.logoUrl);
  if (!logo.ok) return logo;
  const colors = validateColors(body.colors);
  if (!colors.ok) return colors;
  const source = validateSource(body.source);
  if (!source.ok) return source;
  const testTag = validateTestTag(body.testTag);
  if (!testTag.ok) return testTag;
  const prospect = validateProspectId(body.prospectId);
  if (!prospect.ok) return prospect;
  return {
    ok: true,
    brand: {
      name: name.name,
      logoUrl: logo.logoUrl,
      colors: colors.colors,
      source: source.source,
      testTag: testTag.testTag,
      prospectId: prospect.prospectId,
    },
  };
}

module.exports = {
  validateBrand,
  validateLogoUrl,
  validateColors,
};
