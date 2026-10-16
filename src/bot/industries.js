// Target industries for FlowForward home services discovery.
// Each entry is a Google Places text search query fragment.
// The bot pairs these with each TARGET_MARKET location.
//
// GTM beachhead: HVAC is primary, plumbing is secondary. The catalog stays at
// or under 20 query types (the post-F-001 non-pest baseline) so Places spend
// does not grow. Queries were reallocated toward HVAC and plumbing; markets
// and RESULTS_PER_QUERY are unchanged. Pest control is not searched.
// `score` is the legacy prospects.score seed and matches INDUSTRY_FIT.

module.exports = [
  // HVAC — primary beachhead
  { query: 'HVAC company',                 industry: 'HVAC',         score: 10 },
  { query: 'air conditioning repair',      industry: 'HVAC',         score: 10 },
  { query: 'heating and cooling',          industry: 'HVAC',         score: 10 },
  { query: 'furnace repair',               industry: 'HVAC',         score: 10 },
  { query: 'AC installation',              industry: 'HVAC',         score: 10 },
  { query: 'heating and air conditioning', industry: 'HVAC',         score: 10 },

  // Plumbing — secondary, including HVAC+plumbing combo shops
  { query: 'plumbing company',             industry: 'Plumbing',     score: 9 },
  { query: 'plumber',                      industry: 'Plumbing',     score: 9 },
  { query: 'drain cleaning',               industry: 'Plumbing',     score: 9 },
  { query: 'water heater repair',          industry: 'Plumbing',     score: 9 },

  // One query each. Gutters and windows are not searched.
  { query: 'electrician',                  industry: 'Electrical',   score: 5 },
  { query: 'roofing contractor',           industry: 'Roofing',      score: 5 },
  { query: 'landscaping company',          industry: 'Landscaping',  score: 3 },
  { query: 'house cleaning service',       industry: 'Cleaning',     score: 2 },
  { query: 'painting contractor',          industry: 'Painting',     score: 3 },
  { query: 'general contractor',           industry: 'Construction', score: 3 },
];
