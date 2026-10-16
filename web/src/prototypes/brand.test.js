import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { WATERMARK_BG, WATERMARK_FG } from '../components/PrototypeWatermark';
import {
  BUNDLED_LOGO_ID,
  FALLBACK_INK,
  FALLBACK_NAME,
  FALLBACK_PRIMARY,
  PAPER,
  contrastRatio,
  presentBrand,
  sanitizeLogoUrl,
} from './brand';
import { HOSTILE_BRAND, TEST_BRAND } from './fixture-brand';

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
    expect(contrastRatio(brand.theme.primary, brand.theme.onPrimary)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(brand.theme.accent, PAPER)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(brand.theme.ink, PAPER)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(WATERMARK_FG, WATERMARK_BG)).toBeGreaterThanOrEqual(4.5);
  });

  it('renders hostile names as text and drops non-https logos', () => {
    const brand = presentBrand(HOSTILE_BRAND);
    expect(brand.name).toBe('TEST: <script>alert(1)</script>');
    expect(brand.logoUrl).toBe('');
    expect(brand.colors.ink).toBe('');
    expect(brand.colors.primary).toBe('#FFFFFF');
    expect(brand.theme.onPrimary).toBe(FALLBACK_INK);
    expect(contrastRatio(brand.theme.primary, brand.theme.onPrimary)).toBeGreaterThanOrEqual(4.5);
    expect(brand.theme.ink).toBe(FALLBACK_INK);
    expect(brand.theme.accent).toBe(FALLBACK_INK);
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
    expect(presentBrand({ colors: { primary: '#777777' } }).theme.primary).toBe(FALLBACK_PRIMARY);
  });

  it('keeps watermark styles off brand CSS variables', () => {
    const css = readFileSync(path.join(webRoot, 'src/styles.css'), 'utf8');
    const block = css.slice(css.indexOf('/* prototype-watermark:'), css.indexOf('/* ── Mobile'));
    expect(block).toContain('background-color: #1E2A2F !important');
    expect(block).toContain('color: #FFFFFF !important');
    expect(block).toContain('display: block !important');
    expect(block).toContain('opacity: 1 !important');
    expect(block).toContain('visibility: visible !important');
    expect(block).not.toMatch(/var\s*\(/);
  });
});
