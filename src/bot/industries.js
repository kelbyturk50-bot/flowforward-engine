// Target industries for FlowForward home services discovery
// Each entry is a Google Places text search query fragment
// The bot pairs these with each TARGET_MARKET location

module.exports = [
  // HVAC
  { query: 'HVAC company',           industry: 'HVAC',        score: 8 },
  { query: 'air conditioning repair', industry: 'HVAC',        score: 8 },
  { query: 'heating and cooling',    industry: 'HVAC',        score: 8 },

  // Roofing
  { query: 'roofing contractor',     industry: 'Roofing',     score: 8 },
  { query: 'roofing company',        industry: 'Roofing',     score: 8 },

  // Landscaping / Lawn
  { query: 'landscaping company',    industry: 'Landscaping', score: 7 },
  { query: 'lawn care service',      industry: 'Landscaping', score: 7 },
  { query: 'lawn maintenance',       industry: 'Landscaping', score: 7 },

  // Plumbing
  { query: 'plumbing company',       industry: 'Plumbing',    score: 8 },
  { query: 'plumber',                industry: 'Plumbing',    score: 8 },

  // Electrical
  { query: 'electrician',            industry: 'Electrical',  score: 7 },
  { query: 'electrical contractor',  industry: 'Electrical',  score: 7 },

  // Pest Control
  { query: 'pest control company',   industry: 'Pest Control', score: 9 },
  { query: 'exterminator',           industry: 'Pest Control', score: 9 },

  // Cleaning
  { query: 'house cleaning service', industry: 'Cleaning',    score: 6 },
  { query: 'commercial cleaning',    industry: 'Cleaning',    score: 7 },

  // Painting
  { query: 'painting contractor',    industry: 'Painting',    score: 7 },
  { query: 'interior exterior painting', industry: 'Painting', score: 7 },

  // Gutters / Windows
  { query: 'gutter cleaning company', industry: 'Gutters',   score: 6 },
  { query: 'window cleaning service', industry: 'Windows',   score: 6 },

  // General Contractors
  { query: 'general contractor',     industry: 'Construction', score: 7 },
  { query: 'home remodeling',        industry: 'Construction', score: 7 },
];
