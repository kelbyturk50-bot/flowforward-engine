// Static brand fixtures for prototype v1. Synthetic TEST data only.
// No logos are fetched. logoUrl, when set, is a documentation host and is
// stored as text. Nothing in this module opens a socket.

const BRAND_FIXTURES = [
  {
    name: 'TEST: Wasatch Heating',
    logoUrl: null,
    colors: ['#1b4f72', '#f4d03f'],
    source: 'fixture',
    testTag: 'TEST:wasatch-heating',
  },
  {
    name: 'TEST: Canyon Plumbing',
    logoUrl: 'https://fixtures.example/test-canyon-logo.png',
    colors: ['#0e4d3a', '#e8f0ec'],
    source: 'fixture',
    testTag: 'TEST:canyon-plumbing',
  },
];

module.exports = { BRAND_FIXTURES };
