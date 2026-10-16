import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { WATERMARK_BG, WATERMARK_FG } from '../components/PrototypeWatermark';
import {
  BUNDLED_LOGO_ID,
  FALLBACK_NAME,
  JUNIPER_ACCENT,
  PAPER,
  SLATE,
  SURFACE,
  chooseLogoPlate,
  contrastRatio,
  fixAccent,
  hexToOklch,
  pickOnAccent,
  presentBrand,
  sanitizeLogoUrl,
} from './brand';
import { HOSTILE_BRAND, NAVY_BRAND, TEST_BRAND, YELLOW_BRAND } from './fixture-brand';

const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

describe('brand sanitizer', () => {
  it('keeps the bundled TEST fixture name, logo, and hex colors', () => {
    const brand = presentBrand(TEST_BRAND);
    expect(brand.name).toBe('TEST: Wasatch Heating');
    expect(brand.name.startsWith('TEST:')).toBe(true);
    expect(brand.logoUrl).toBe(BUNDLED_LOGO_ID);
    expect(brand.colors).toEqual({
      primary: '#1F4E79',
      accent: '#8A4E12',
      ink: '#1E2A2F',
    });
    expect(brand.theme.accent).toBe('#8A4E12');
    expect(brand.theme.onAccent).toBe('#FFFFFF');
    expect(brand.logoPlate).toBe('none');
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

  it('allows https logo URLs and bundled ids, and rejects the rest', () => {
    expect(sanitizeLogoUrl('https://cdn.example/logo.png')).toBe('https://cdn.example/logo.png');
    expect(sanitizeLogoUrl(`  ${BUNDLED_LOGO_ID}  `)).toBe(BUNDLED_LOGO_ID);
    expect(sanitizeLogoUrl('http://cdn.example/logo.png')).toBe('');
    expect(sanitizeLogoUrl('javascript:alert(1)')).toBe('');
    expect(sanitizeLogoUrl('data:image/svg+xml,<svg></svg>')).toBe('');
    expect(sanitizeLogoUrl('//cdn.example/logo.png')).toBe('');
    expect(sanitizeLogoUrl('https://user:pass@cdn.example/logo.png')).toBe('');
    expect(sanitizeLogoUrl('/etc/passwd')).toBe('');
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
    expect(css).toContain("%3EPROTOTYPE%3C");
    expect(css).toContain("fill-opacity='0.05'");
    expect(css).toContain('pointer-events: none');
  });
});