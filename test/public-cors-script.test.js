require('./preload');

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');

function productionOrigins(source) {
  const start = source.indexOf('const PRODUCTION_CRM_ORIGINS');
  const end = source.indexOf('const HASH_PREVIEW_ORIGIN');
  const block = source.slice(start, end);
  return [...block.matchAll(/'(https:\/\/[^']+)'/g)].map((match) => match[1]);
}

function scriptOrigins(source) {
  const start = source.indexOf('case "$CRM" in');
  const end = source.indexOf('*)', start);
  const block = source.slice(start, end);
  return [...block.matchAll(/https:\/\/[a-z0-9.-]+/g)].map((match) => match[0]);
}

describe('public CORS check script', () => {
  it('lists the same production origins as the API allowlist', () => {
    const cors = fs.readFileSync(path.join(root, 'src/chatdemo/cors.js'), 'utf8');
    const script = fs.readFileSync(path.join(root, 'scripts/check-public-cors.sh'), 'utf8');
    const apiOrigins = productionOrigins(cors);
    const checkOrigins = scriptOrigins(script);
    assert.ok(apiOrigins.length >= 3);
    assert.deepEqual(checkOrigins, apiOrigins);
  });
});
