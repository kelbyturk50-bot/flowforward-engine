const test = require('node:test');
const assert = require('node:assert/strict');
const SORTS = require('./prospect-sorts');

test('revenue sort is an allowlisted est_value ordering', () => {
  assert.equal(SORTS.revenue, 'est_value DESC NULLS LAST, fit_score DESC NULLS LAST');
  assert.equal(SORTS.not_a_column, undefined);
  for (const sql of Object.values(SORTS)) {
    assert.doesNotMatch(sql, /;|--|\/\*/);
  }
});
