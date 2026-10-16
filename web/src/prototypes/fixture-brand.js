// Synthetic shop. No address, phone, email, or real customer.
// Names use a TEST: prefix. The header is the name wordmark unless a bundled logo id is set.
export const TEST_BRAND = Object.freeze({
  name: 'TEST: Wasatch Heating',
  logoUrl: '',
  colors: Object.freeze({
    primary: '#1F4E79',
    accent: '#8A4E12',
    ink: '#1E2A2F',
  }),
});

// Proof brands. Yellow is too light for text on paper, so the light accent is darkened.
// Navy already passes on light paper, so that accent stays unchanged. Dark mode lightens it.
export const YELLOW_BRAND = Object.freeze({
  name: 'TEST: Pale Yellow Shop',
  logoUrl: '',
  colors: Object.freeze({
    primary: '#F5E050',
    accent: '#F5E050',
    ink: '#1E2A2F',
  }),
});

export const NAVY_BRAND = Object.freeze({
  name: 'TEST: Dark Navy Shop',
  logoUrl: '',
  colors: Object.freeze({
    primary: '#14213D',
    accent: '#14213D',
    ink: '#F3F6F5',
  }),
});

// Hostile input used to prove sanitizing and the watermark. Still synthetic.
export const HOSTILE_BRAND = Object.freeze({
  name: 'TEST: <script>alert(1)</script>',
  logoUrl: 'https://prospect.example/logo.png',
  colors: Object.freeze({
    primary: '#FFFFFF',
    accent: '#FFFFFF',
    ink: 'transparent',
    watermark: '#FFFFFF',
    background: 'white',
  }),
});
