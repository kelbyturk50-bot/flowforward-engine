// Brand colors from a shop's own website, for the prototype page.
//
// Kelby (Oct 20) asked for prototypes to match the shop's real colors. This
// reads colors only: no logo, no images, no text. Pages and stylesheets are
// fetched through src/net/safeFetch (the SSRF guard research.js uses), at
// most the homepage plus MAX_SHEETS stylesheets, each capped in size.
//
// extractPalette is pure: it scores every color it finds in the HTML and CSS
// and returns the strongest non-neutral ones. Strong signals:
//   - <meta name="theme-color"> / msapplication-TileColor
//   - CSS custom properties named like primary / brand / accent / main
//     (WordPress, Elementor, Divi, Wix, Squarespace, Webflow all use these)
//   - colors on buttons, headers, nav, links, and CTA-ish selectors
// Neutrals (whites, grays, near-black) are ignored. Similar shades merge.

const { safeFetch } = require('../net/safeFetch');

const MAX_SHEETS = 4;
const SHEET_BYTES = 1_500_000;
const UA = 'Mozilla/5.0 (compatible; FlowForwardBot/1.0; +https://flowforward-engine-six.vercel.app/about)';

// ── color math ──────────────────────────────────────────────────────────────
function clamp(n, lo, hi) { return Math.min(hi, Math.max(lo, n)); }
function toHex(r, g, b) {
  return '#' + [r, g, b].map(v => clamp(Math.round(v), 0, 255).toString(16).padStart(2, '0')).join('');
}
function parseColor(raw) {
  const s = String(raw).trim().toLowerCase();
  let m = s.match(/^#([0-9a-f]{3,8})$/);
  if (m) {
    let h = m[1];
    if (h.length === 3 || h.length === 4) h = h.slice(0, 3).split('').map(c => c + c).join('') + (h.length === 4 ? h[3] + h[3] : '');
    if (h.length === 8) { if (parseInt(h.slice(6, 8), 16) < 200) return null; h = h.slice(0, 6); }
    if (h.length !== 6) return null;
    return `#${h}`;
  }
  m = s.match(/^rgba?\(\s*(\d{1,3})[\s,]+(\d{1,3})[\s,]+(\d{1,3})(?:\s*[,/]\s*([\d.]+%?))?\s*\)$/);
  if (m) {
    if (m[4] != null) {
      const a = m[4].endsWith('%') ? parseFloat(m[4]) / 100 : parseFloat(m[4]);
      if (a < 0.8) return null;
    }
    return toHex(+m[1], +m[2], +m[3]);
  }
  return null;
}
function lin(c) { c /= 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; }
function oklab(hex) {
  const r = lin(parseInt(hex.slice(1, 3), 16)), g = lin(parseInt(hex.slice(3, 5), 16)), b = lin(parseInt(hex.slice(5, 7), 16));
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  const L = 0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s;
  const A = 1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s;
  const B = 0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s;
  return { L, a: A, b: B, C: Math.hypot(A, B), H: (Math.atan2(B, A) * 180 / Math.PI + 360) % 360 };
}
function isNeutral(hex) {
  const c = oklab(hex);
  if (c.L > 0.95) return true;              // white-ish
  if (c.C < 0.035) return true;             // gray, black, off-white
  if (c.L < 0.16 && c.C < 0.06) return true; // near-black with a tint
  return false;
}
function distance(x, y) {
  const a = oklab(x), b = oklab(y);
  return Math.hypot(a.L - b.L, a.a - b.a, a.b - b.b);
}
// Colors that appear on almost every site because of a plugin or embed,
// not the brand: Facebook/Google/WordPress admin/link blues, default alert colors.
const VENDOR = new Set(['#0073aa', '#0085ba', '#135e96', '#2271b1', '#3b5998', '#1877f2', '#4285f4', '#1da1f2', '#0a66c2',
  '#dc3232', '#46b450', '#ffb900', '#00a0d2', '#007bff', '#0d6efd', '#6c757d', '#28a745', '#198754', '#dc3545', '#ffc107', '#17a2b8',
  '#0dcaf0', '#e1306c', '#ff0000', '#00ff00', '#0000ff', '#25d366', '#34a853', '#ea4335', '#fbbc05']);

// ── extraction ──────────────────────────────────────────────────────────────
const COLOR_TOKEN = /#[0-9a-f]{3,8}\b|rgba?\([^)]{5,40}\)/gi;
const BRAND_VAR = /--[\w-]*(primary|brand|accent|main|secondary|theme|global-color-(?:primary|secondary|accent)|color[-_]?[12]\b|color_1[1-9])[\w-]*\s*:\s*([^;}{]+)/gi;
const STRONG_SEL = /(btn|button|cta|header|nav|menu|hero|banner|primary|brand|accent|call|phone|quote|book|top-?bar|footer)/i;

function addScore(map, hex, pts, why) {
  if (!hex || isNeutral(hex) || VENDOR.has(hex)) return;
  const row = map.get(hex) || { hex, score: 0, why: new Set() };
  row.score += pts;
  if (why) row.why.add(why);
  map.set(hex, row);
}

function scanCss(css, map, weight = 1) {
  const text = String(css || '').slice(0, 2_000_000);
  // Custom properties with brand-ish names.
  for (const m of text.matchAll(BRAND_VAR)) {
    const hex = parseColor(m[2].trim().split(/\s+/)[0]);
    const name = m[1].toLowerCase();
    addScore(map, hex, (name.includes('primary') || name.includes('brand') || name === 'main' ? 14 : 9) * weight, 'css variable');
  }
  // Rule by rule: colors on strong selectors count more.
  const ruleRe = /([^{}]{1,400})\{([^{}]{0,3000})\}/g;
  let m; let rules = 0;
  while ((m = ruleRe.exec(text)) && rules < 40000) {
    rules += 1;
    const sel = m[1]; const body = m[2];
    const strong = STRONG_SEL.test(sel);
    for (const decl of body.split(';')) {
      const i = decl.indexOf(':');
      if (i < 0) continue;
      const prop = decl.slice(0, i).trim().toLowerCase();
      if (!/^(background|background-color|color|border|border-color|border-top|border-bottom|fill|stroke|--)/.test(prop)) continue;
      for (const tok of decl.slice(i + 1).match(COLOR_TOKEN) || []) {
        const hex = parseColor(tok);
        const bg = prop.startsWith('background');
        addScore(map, hex, (strong ? (bg ? 5 : 3) : (bg ? 1.5 : 1)) * weight, strong ? 'button/header' : null);
      }
    }
  }
}

function extractPalette(html, cssTexts = []) {
  const map = new Map();
  const doc = String(html || '');
  for (const m of doc.matchAll(/<meta[^>]+(?:name|property)=["'](?:theme-color|msapplication-tilecolor|msapplication-navbutton-color)["'][^>]*>/gi)) {
    const c = (m[0].match(/content=["']([^"']+)["']/i) || [])[1];
    addScore(map, parseColor(c || ''), 40, 'theme-color');
  }
  for (const m of doc.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)) scanCss(m[1], map, 1.2);
  for (const m of doc.matchAll(/style=["']([^"']{0,600})["']/gi)) {
    for (const tok of m[1].match(COLOR_TOKEN) || []) addScore(map, parseColor(tok), 1.5, null);
  }
  for (const css of cssTexts) scanCss(css, map, 1);

  // Merge near-duplicates into the higher-scoring shade.
  const rows = [...map.values()].sort((a, b) => b.score - a.score);
  const merged = [];
  for (const row of rows) {
    const twin = merged.find(x => distance(x.hex, row.hex) < 0.07);
    if (twin) { twin.score += row.score * 0.8; row.why.forEach(w => twin.why.add(w)); } else merged.push(row);
  }
  merged.sort((a, b) => b.score - a.score);
  const swatches = merged.slice(0, 6).map(r => ({ hex: r.hex, score: Math.round(r.score), why: [...r.why] }));
  const primary = swatches[0] || null;
  // Secondary: the next strong color with a clearly different hue or lightness.
  const secondary = primary ? swatches.slice(1).find(s => {
    const a = oklab(primary.hex), b = oklab(s.hex);
    const dh = Math.min(Math.abs(a.H - b.H), 360 - Math.abs(a.H - b.H));
    return s.score >= primary.score * 0.08 && (dh > 35 || Math.abs(a.L - b.L) > 0.25);
  }) : null;
  const confident = !!primary && (primary.score >= 12 || primary.why.includes('theme-color') || primary.why.includes('css variable'));
  return {
    primary: primary ? primary.hex : null,
    secondary: secondary ? secondary.hex : null,
    confident,
    swatches,
  };
}

// ── fetch ───────────────────────────────────────────────────────────────────
async function getText(url, accept, maxBytes) {
  const res = await safeFetch(url, {
    timeoutMs: 10000, maxBytes, maxRedirects: 5,
    headers: { 'User-Agent': UA, Accept: accept, 'Accept-Language': 'en-US,en;q=0.9' },
  });
  if (res.status >= 400) throw new Error(`status ${res.status}`);
  return { text: Buffer.isBuffer(res.body) ? res.body.toString('utf8') : String(res.body || ''), finalUrl: res.finalUrl || url, type: String(res.headers['content-type'] || '') };
}

function stylesheetUrls(html, baseUrl) {
  const out = [];
  for (const m of String(html).matchAll(/<link\b[^>]*>/gi)) {
    const tag = m[0];
    if (!/rel=["']?[^"'>]*stylesheet/i.test(tag)) continue;
    const href = (tag.match(/href=["']([^"']+)["']/i) || [])[1];
    if (!href || /fonts\.googleapis|font-awesome|fontawesome|bootstrap(\.min)?\.css|jquery|wp-includes|dashicons|\/plugins\/(?!elementor)/i.test(href)) continue;
    try { out.push(new URL(href.replace(/&amp;/g, '&'), baseUrl).toString()); } catch { /* bad href */ }
  }
  // Theme and builder CSS first; they carry the brand colors.
  return out.sort((a, b) => Number(/theme|style|custom|elementor|global|main|site/i.test(b)) - Number(/theme|style|custom|elementor|global|main|site/i.test(a))).slice(0, MAX_SHEETS);
}

// Fetch the homepage (or reuse html already fetched) and up to MAX_SHEETS
// stylesheets, then score colors. Never throws; returns { error } instead.
async function detectBrandColors(website, { html: knownHtml, finalUrl: knownUrl } = {}) {
  try {
    let html = knownHtml; let base = knownUrl;
    if (!html) {
      let url = String(website || '').trim();
      if (!url) return { error: 'no website' };
      if (!/^https?:\/\//i.test(url)) url = `https://${url}`;
      const home = await getText(url, 'text/html,application/xhtml+xml', 3_000_000);
      html = home.text; base = home.finalUrl;
    }
    const sheets = [];
    for (const href of stylesheetUrls(html, base)) {
      try {
        const css = await getText(href, 'text/css,*/*;q=0.1', SHEET_BYTES);
        if (!css.type || /css|text\/plain/.test(css.type)) sheets.push(css.text);
      } catch { /* skip a sheet that fails */ }
    }
    return { ...extractPalette(html, sheets), sheets: sheets.length, source: base, detected_at: new Date().toISOString() };
  } catch (err) {
    return { error: `could not read the site (${err && err.code ? err.code : 'fetch failed'})` };
  }
}

module.exports = { extractPalette, detectBrandColors, stylesheetUrls, parseColor, isNeutral };
