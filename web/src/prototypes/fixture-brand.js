import { BUNDLED_LOGO_ID } from './brand';

// Synthetic shop. No address, phone, email, or real customer.
export const TEST_BRAND = Object.freeze({
  name: 'TEST: Wasatch Heating',
  logoUrl: BUNDLED_LOGO_ID,
  colors: Object.freeze({
    primary: '#1F4E79',
    accent: '#8A4E12',
    ink: '#1E2A2F',
  }),
});

// Proof brands. Yellow fails text contrast, so accents fall back to juniper.
// The raw swatch still paints so the watermark can be checked against it.
export const YELLOW_BRAND = Object.freeze({
  name: 'TEST: Pale Yellow Shop',
  logoUrl: BUNDLED_LOGO_ID,
  colors: Object.freeze({
    primary: '#F5E050',
    accent: '#F5E050',
    ink: '#1E2A2F',
  }),
});

export const NAVY_BRAND = Object.freeze({
  name: 'TEST: Dark Navy Shop',
  logoUrl: BUNDLED_LOGO_ID,
  colors: Object.freeze({
    primary: '#14213D',
    accent: '#14213D',
    ink: '#F3F6F5',
  }),
});

// Hostile input used to prove sanitizing and the watermark. Still synthetic.
export const HOSTILE_BRAND = Object.freeze({
  name: 'TEST: <script>alert(1)</script>',
  logoUrl: 'javascript:alert(1)',
  colors: Object.freeze({
    primary: '#FFFFFF',
    accent: '#FFFFFF',
    ink: 'transparent',
    watermark: '#FFFFFF',
    background: 'white',
  }),
});
