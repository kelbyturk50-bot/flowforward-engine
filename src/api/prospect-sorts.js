// Allowlisted ORDER BY clauses for GET /api/prospects?sort=
// Keep this free of other imports so tests can load it without a database.
const SORTS = {
  fit:         'fit_score DESC NULLS LAST, review_count DESC NULLS LAST',
  recent:      'discovered_at DESC',
  rating:      'rating DESC NULLS LAST, review_count DESC NULLS LAST',
  reviews:     'review_count DESC NULLS LAST',
  revenue:     'est_value DESC NULLS LAST, fit_score DESC NULLS LAST',
  next_action: 'next_action_at ASC NULLS LAST, fit_score DESC NULLS LAST',
  company:     'company ASC',
  updated:     'updated_at DESC',
};

module.exports = SORTS;
