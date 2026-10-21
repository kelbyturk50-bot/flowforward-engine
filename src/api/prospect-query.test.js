const test = require('node:test');
const assert = require('node:assert/strict');
const { buildProspectListQuery, ProspectQueryError } = require('./prospect-query');

function rejects(query) {
  assert.throws(() => buildProspectListQuery(query), (err) => {
    assert.ok(err instanceof ProspectQueryError);
    assert.equal(err.status, 400);
    assert.equal(err.message, 'bad_request');
    return true;
  });
}

test('min_value happy path is a parameterized est_value comparison', () => {
  const q = buildProspectListQuery({ min_value: '1000000', sort: 'revenue' });
  assert.match(q.listSql, /est_value >= \$1/);
  assert.doesNotMatch(q.listSql, /est_value IS NULL/);
  assert.equal(q.params.length, 1);
  assert.equal(q.params[0], 1000000);
  assert.match(q.listSql, /ORDER BY est_value DESC NULLS LAST, fit_score DESC NULLS LAST, id/);
  assert.match(q.countSql, /est_value >= \$1/);
});

test('min_value=0 is a real filter and still excludes NULL estimates', () => {
  const q = buildProspectListQuery({ min_value: '0' });
  assert.match(q.listSql, /est_value >= \$1/);
  assert.doesNotMatch(q.listSql, /est_value IS NULL/);
  assert.match(q.listSql, /archived_at IS NULL/);
  assert.deepEqual(q.params, [0]);
  assert.match(q.listSql, /ORDER BY fit_score DESC NULLS LAST/);
});

test('omitted and empty min_value apply no value filter', () => {
  for (const query of [{}, { min_value: '' }, { min_value: undefined }]) {
    const q = buildProspectListQuery(query);
    assert.doesNotMatch(q.listSql, /est_value/);
    assert.deepEqual(q.params, []);
  }
});

test('invalid min_value is a 400', () => {
  for (const min_value of ['abc', '-5', '-0', 'Infinity', 'NaN', '1e3', '0x10', ' 0', '0 ', '   ', '\t', '1,000']) {
    rejects({ min_value });
  }
  rejects({ min_value: -5 });
  rejects({ min_value: Infinity });
  rejects({ min_value: Number.NaN });
});

test('unknown and prototype sort names are a 400', () => {
  for (const sort of ['constructor', 'toString', '__proto__', 'valueOf', 'not_a_column', 'fit;drop', '']) {
    rejects({ sort });
  }
  rejects({ sort: ['fit'] });
  rejects({ sort: { fit: true } });
});

test('a missing sort defaults to fit', () => {
  const q = buildProspectListQuery({});
  assert.match(q.listSql, /ORDER BY fit_score DESC NULLS LAST, review_count DESC NULLS LAST, id/);
});
