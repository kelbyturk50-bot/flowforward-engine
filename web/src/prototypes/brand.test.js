import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { WATERMARK_BG, WATERMARK_FG } from '../components/PrototypeWatermark';
import {
  BUNDLED_LOGO_ID,
  DARK_PAPER,
  DARK_SURFACE,
  FALLBACK_NAME,
  JUNIPER_ACCENT,
  JUNIPER_DARK,
  PAPER,
  SLATE,
  SURFACE,
  chooseLogoPlate,
  contrastRatio,
  fixAccent,
  fixAccentDark,
  hexToOklch,
  pickOnAccent,
  presentBrand,
  sanitizeLogoUrl,
  sanitizeName,
} from './brand';
import { HOSTILE_BRAND, NAVY_BRAND, TEST_BRAND, YELLOW_BRAND } from './fixture-brand';

const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

describe('brand sanitizer', () => {
  it('keeps the bundled TEST fixture name, wordmark, and hex colors', () => {
    const brand = presentBrand(TEST_BRAND);
    expect(brand.name).toBe('TEST: Wasatch Heating');
    expect(brand.name.startsWith('TEST:')).toBe(true);
    expect(brand.name).not.toMatch(/\(Sample\)/);
    expect(brand.logoUrl).toBe('');
    expect(brand.logoPlate).toBe('text');
    expect(brand.colors).toEqual({
      primary: '#1F4E79',
      accent: '#8A4E12',
      ink: '#1E2A2F',
    });
    expect(brand.theme.accent).toBe('#8A4E12');
    expect(brand.theme.onAccent).toBe('#FFFFFF');
    const bundled = presentBrand({ ...TEST_BRAND, logoUrl: BUNDLED_LOGO_ID });
    expect(bundled.logoUrl).toBe(BUNDLED_LOGO_ID);
    expect(bundled.logoPlate).toBe('none');
    expect(contrastRatio(brand.theme.accent, SURFACE)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(brand.theme.accent, PAPER)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(WATERMARK_FG, WATERMARK_BG)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(JUNIPER_ACCENT, SURFACE)).toBeGreaterThanOrEqual(4.5);
  });

  it('renders hostile names as text and corrects a white brand color', () => {
    const brand = presentBrand(HOSTILE_BRAND);
    expect(brand.name).toBe('TEST: <script>alert(1)</script>');
    expect(brand.logoUrl).toBe('');
    expect(brand.logoPlate).toBe('text');
    expect(brand.colors.ink).toBe('');
    expect(brand.colors.primary).toBe('#FFFFFF');
    expect(brand.theme.accent).toBe('#6F6F6F');
    expect(brand.theme.onAccent).toBe('#FFFFFF');
    expect(contrastRatio(brand.theme.accent, SURFACE)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(brand.theme.accent, PAPER)).toBeGreaterThanOrEqual(4.5);
    expect(brand.theme).not.toHaveProperty('watermark');
  });

  it('allows a bundled logo id and rejects remote URLs', () => {
    expect(sanitizeLogoUrl('https://cdn.example/logo.png')).toBe('');
    expect(sanitizeLogoUrl('https://prospect.example/logo.png')).toBe('');
    expect(sanitizeLogoUrl(`  ${BUNDLED_LOGO_ID}  `)).toBe(BUNDLED_LOGO_ID);
    expect(sanitizeLogoUrl('http://cdn.example/logo.png')).toBe('');
    expect(sanitizeLogoUrl('javascript:alert(1)')).toBe('');
    expect(sanitizeLogoUrl('data:image/svg+xml,<svg></svg>')).toBe('');
    expect(sanitizeLogoUrl('//cdn.example/logo.png')).toBe('');
    expect(sanitizeLogoUrl('https://user:pass@cdn.example/logo.png')).toBe('');
    expect(sanitizeLogoUrl('/etc/passwd')).toBe('');
    const remote = presentBrand({
      name: 'TEST: Cedar Lane HVAC',
      logoUrl: 'https://prospect.example/logo.png',
      colors: { accent: '#1F4E79' },
    });
    expect(remote.name).toBe('TEST: Cedar Lane HVAC');
    expect(remote.logoUrl).toBe('');
    expect(remote.logoPlate).toBe('text');
    expect(remote.theme.accent).toBe('#1F4E79');
    expect(presentBrand({ name: '<b>TEST: Shop</b>' }).name).toBe('<b>TEST: Shop</b>');
    expect(presentBrand({ name: '  ' }).name).toBe(FALLBACK_NAME);
    expect(presentBrand({ colors: { primary: 'red', accent: '#abc' } }).colors).toEqual({
      primary: '',
      accent: '#AABBCC',
      ink: '',
    });
    const gray = presentBrand({ colors: { primary: '#777777' } }).theme;
    expect(gray.accent).not.toBe('#777777');
    expect(contrastRatio(gray.accent, SURFACE)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(gray.accent, PAPER)).toBeGreaterThanOrEqual(4.5);
    expect(presentBrand({ colors: { accent: '#FFFFFF', primary: '#1F4E79' } }).theme.accent).toBe('#6F6F6F');
    expect(fixAccent('#1F4E79')).toEqual({ accent: '#1F4E79', onAccent: '#FFFFFF' });
  });

  it('caps chroma, darkens yellow, and keeps navy', () => {
    const yellow = fixAccent('#F5E050');
    expect(yellow.accent).toBe('#7D7000');
    expect(yellow.onAccent).toBe('#FFFFFF');
    expect(contrastRatio(yellow.accent, PAPER)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(yellow.accent, SURFACE)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio('#F5E050', SURFACE)).toBeLessThan(4.5);
    expect(hexToOklch(yellow.accent).C).toBeLessThanOrEqual(0.20);
    expect(presentBrand(YELLOW_BRAND).theme).toEqual(yellow);

    const navy = fixAccent('#14213D');
    expect(navy).toEqual({ accent: '#14213D', onAccent: '#FFFFFF' });
    expect(presentBrand(NAVY_BRAND).theme).toEqual(navy);
    expect(contrastRatio('#14213D', PAPER)).toBeGreaterThanOrEqual(4.5);

    for (const neon of ['#00FF00', '#FF00FF']) {
      const fixed = fixAccent(neon);
      expect(fixed.accent).not.toBe(neon);
      expect(hexToOklch(fixed.accent).C).toBeLessThan(0.21);
      expect(hexToOklch(fixed.accent).C).toBeLessThan(hexToOklch(neon).C);
      expect(contrastRatio(fixed.accent, PAPER)).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(fixed.accent, SURFACE)).toBeGreaterThanOrEqual(4.5);
      expect(fixed.onAccent).toBe('#FFFFFF');
    }
    expect(fixAccent('#00FF00').accent).toBe('#008000');
    expect(fixAccent('#FF00FF').accent).toBe('#B23EB1');
    expect(fixAccent('')).toEqual({ accent: JUNIPER_ACCENT, onAccent: '#FFFFFF' });
    expect(fixAccent('red')).toEqual({ accent: JUNIPER_ACCENT, onAccent: '#FFFFFF' });
    expect(fixAccent('#FFFFFF').accent).toBe('#6F6F6F');
    expect(pickOnAccent('#F5E050')).toBe(SLATE);
    expect(pickOnAccent('#14213D')).toBe('#FFFFFF');
  });

  it('guards step text and accents on light and dark surfaces', () => {
    const text = 4.5;
    const indicator = 3;
    const modes = [
      { name: 'light', paper: PAPER, surface: SURFACE, theme: fixAccent },
      { name: 'dark', paper: DARK_PAPER, surface: DARK_SURFACE, theme: fixAccentDark },
    ];
    const sources = ['#F5E050', '#14213D', '#FFFFFF'];
    for (const mode of modes) {
      for (const source of sources) {
        const theme = mode.theme(source);
        expect(contrastRatio(theme.accent, mode.surface)).toBeGreaterThanOrEqual(text);
        expect(contrastRatio(theme.accent, mode.paper)).toBeGreaterThanOrEqual(text);
        expect(contrastRatio(theme.accent, mode.surface)).toBeGreaterThanOrEqual(indicator);
        expect(contrastRatio(theme.accent, mode.paper)).toBeGreaterThanOrEqual(indicator);
        expect(contrastRatio(theme.onAccent, theme.accent)).toBeGreaterThanOrEqual(text);
        expect(hexToOklch(theme.accent).C).toBeLessThan(0.21);
      }
    }

    expect(fixAccent('#F5E050')).toEqual({ accent: '#7D7000', onAccent: '#FFFFFF' });
    expect(fixAccentDark('#F5E050')).toEqual({ accent: '#F5E050', onAccent: SLATE });
    expect(fixAccent('#14213D')).toEqual({ accent: '#14213D', onAccent: '#FFFFFF' });
    expect(contrastRatio('#14213D', DARK_PAPER)).toBeLessThan(text);
    expect(fixAccentDark('#14213D')).toEqual({ accent: '#7E8FB2', onAccent: SLATE });
    expect(fixAccent('#FFFFFF')).toEqual({ accent: '#6F6F6F', onAccent: '#FFFFFF' });
    expect(fixAccentDark('#FFFFFF')).toEqual({ accent: '#FFFFFF', onAccent: SLATE });
    expect(fixAccentDark('')).toEqual({ accent: JUNIPER_DARK, onAccent: SLATE });
    expect(presentBrand(HOSTILE_BRAND).darkTheme.accent).toBe('#FFFFFF');
    expect(presentBrand(NAVY_BRAND).darkTheme).toEqual(fixAccentDark('#14213D'));
    expect(presentBrand(YELLOW_BRAND).darkTheme).toEqual(fixAccentDark('#F5E050'));

    const css = readFileSync(path.join(webRoot, 'src/styles.css'), 'utf8');
    const step = css.slice(css.indexOf('.prototype-screen .demo-steps li[aria-current="step"]'), css.indexOf('.prototype-screen .demo-options'));
    expect(step).toContain('background: var(--surface)');
    expect(step).toContain('color: var(--proto-accent, var(--accent))');
    expect(step).toContain('border-color: var(--proto-accent, var(--accent))');
    const root = css.slice(css.indexOf('.prototype-root {'), css.indexOf('.prototype-scroll'));
    expect(root).toContain('--paper: #F3F6F5');
    expect(root).toContain('--surface: #FFFFFF');
    expect(root).toContain('--ink: #1E2A2F');
    expect(root).toContain('color-scheme: light');
    const proto = css.slice(css.indexOf('/* ── Prototype gallery'), css.indexOf('/* prototype-watermark:'));
    expect(proto).not.toContain('--proto-accent-dark');
    expect(contrastRatio('#14213D', PAPER)).toBeGreaterThanOrEqual(text);
    expect(contrastRatio('#14213D', SURFACE)).toBeGreaterThanOrEqual(text);
  });

  it('strips bidi overrides and zero-width characters from names', () => {
    expect(sanitizeName('TEST: \u202ECedar\u202C Lane')).toBe('TEST: Cedar Lane');
    expect(sanitizeName('\u202A\u202B\u202C\u202D\u202ETEST: Shop')).toBe('TEST: Shop');
    expect(sanitizeName('\u2066\u2067\u2068\u2069TEST: Shop')).toBe('TEST: Shop');
    expect(sanitizeName('TEST:\u200E \u200FShop\u061C')).toBe('TEST: Shop');
    expect(sanitizeName('TE\u200BST:\u200C \u200DWa\u2060satch\uFEFF\u180E')).toBe('TEST: Wasatch');
    expect(sanitizeName('\u202E\u200B\u200C')).toBe('');
    expect(presentBrand({ name: 'TEST: \u202EHeating\u200B' }).name).toBe('TEST: Heating');
    expect(presentBrand({ name: '\u202E\u200B' }).name).toBe(FALLBACK_NAME);
  });

  it('chooses a logo plate from local color only', () => {
    expect(chooseLogoPlate('#1F4E79')).toBe('none');
    expect(chooseLogoPlate('#F5E050')).toBe('slate');
    expect(chooseLogoPlate('#FFFFFF')).toBe('slate');
    expect(chooseLogoPlate('')).toBe('text');
    expect(chooseLogoPlate('https://cdn.example/logo.png')).toBe('text');
  });

  it('keeps the ribbon on literal colors and the juniper accent token', () => {
    const css = readFileSync(path.join(webRoot, 'src/styles.css'), 'utf8');
    expect(css).toContain('--accent: var(--juniper)');
    const block = css.slice(css.indexOf('/* prototype-watermark:'), css.indexOf('/* ── Mobile'));
    expect(block).toContain('position: sticky !important');
    expect(block).toContain('top: 0 !important');
    expect(block).toContain('background-color: #1E2A2F !important');
    expect(block).toContain('color: #F3F6F5 !important');
    expect(block).toContain('font-weight: 600 !important');
    expect(block).toContain('font-size: 14px !important');
    expect(block).toContain('env(safe-area-inset-top, 0px)');
    expect(block).toContain('32px');
    expect(block).toContain('display: block !important');
    expect(block).toContain('opacity: 1 !important');
    expect(block).toContain('visibility: visible !important');
    expect(block).not.toMatch(/var\s*\(/);
    expect(block).not.toContain(JUNIPER_ACCENT);
    expect(block).toContain('-webkit-print-color-adjust: exact');
    expect(block).toContain('print-color-adjust: exact');
    expect(block).toContain('border: 2px solid #1E2A2F');
    const printAt = block.indexOf('@media print');
    const screenRibbon = block.slice(0, printAt);
    const print = block.slice(printAt);
    expect(screenRibbon).toContain('background-color: #1E2A2F !important');
    expect(screenRibbon).toContain('color: #F3F6F5 !important');
    expect(print).toContain('.prototype-ribbon');
    expect(print).toContain('background-color: #FFFFFF !important');
    expect(print).toContain('color: #1E2A2F !important');
    expect(print).toContain('-webkit-text-fill-color: #1E2A2F !important');
    expect(print).toContain('border: 2px solid #1E2A2F !important');
    expect(print).toContain('.prototype-root');
    expect(print).toContain('.prototype-scroll');
    expect(print).toMatch(/height:\s*auto\s*!important/);
    expect(print).toMatch(/overflow:\s*visible\s*!important/);
    expect(print).not.toMatch(/100dvh|100vh/);
    expect(print).not.toMatch(/overflow:\s*hidden/);
    expect(screenRibbon).toContain('html body .prototype-root > p.prototype-ribbon[data-prototype-ribbon][role="note"]');
    expect(print).toContain('html body .prototype-root > p.prototype-ribbon[data-prototype-ribbon][role="note"]');
    for (const selector of ['.prototype-wordmark', '.prototype-brand-name', '.prototype-open', '.demo-btn', '.prototype-cta-link', '.prototype-toast']) {
      expect(print).toContain(selector);
    }
    const source = readFileSync(path.join(webRoot, 'src/components/PrototypeWatermark.jsx'), 'utf8');
    const lock = source.slice(source.indexOf('const RIBBON_IMPORTANT'), source.indexOf('function lockStyle'));
    expect(lock).not.toContain('background-color');
    expect(lock).not.toContain('-webkit-text-fill-color');
    expect(lock).not.toMatch(/\n {2}color:/);
    expect(css).toContain("%3EPROTOTYPE%3C");
    expect(css).toContain("fill-opacity='0.05'");
    expect(css).toContain('pointer-events: none');
    const tile = css.slice(css.indexOf('.prototype-tile {'), css.indexOf('.prototype-foreground'));
    expect(tile).toContain('-webkit-print-color-adjust: exact');
    expect(tile).toContain('print-color-adjust: exact');
  });
});