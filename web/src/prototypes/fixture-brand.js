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
