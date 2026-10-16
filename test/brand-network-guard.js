// Denies outbound I/O before any brand or rubric module loads, then requires
// those modules fresh. A load-time call is caught because the hooks are
// already in place. --mutate loads a generated module that try/catches every
// sink and exits 0 only when each one threw BRAND_NETWORK_LEAK.

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const https = require('https');
const net = require('net');
const tls = require('tls');
const dns = require('dns');
const cp = require('child_process');

const leaks = [];
const expected = [];

function deny(label) {
  return function brandNetworkDenied() {
    leaks.push(label);
    const err = new Error(`BRAND_NETWORK_LEAK ${label}`);
    err.code = 'BRAND_NETWORK_LEAK';
    throw err;
  };
}

function replaceFn(obj, key, label) {
  if (!obj) return;
  const desc = Object.getOwnPropertyDescriptor(obj, key);
  if (!desc || typeof desc.value !== 'function') return;
  const denied = deny(label);
  try {
    obj[key] = denied;
  } catch {
    Object.defineProperty(obj, key, { value: denied, writable: true, configurable: true });
  }
  expected.push(label);
}

function hookDns(obj, prefix) {
  const seen = new Set();
  let cursor = obj;
  while (cursor && cursor !== Object.prototype) {
    for (const key of Object.getOwnPropertyNames(cursor)) {
      if (seen.has(key)) continue;
      if (!/^(lookup|resolve|reverse)/.test(key)) continue;
      const desc = Object.getOwnPropertyDescriptor(cursor, key);
      if (!desc || typeof desc.value !== 'function') continue;
      seen.add(key);
      replaceFn(cursor, key, `${prefix}.${key}`);
    }
    cursor = Object.getPrototypeOf(cursor);
  }
}

replaceFn(http, 'request', 'http.request');
replaceFn(http, 'get', 'http.get');
replaceFn(https, 'request', 'https.request');
replaceFn(https, 'get', 'https.get');
replaceFn(net, 'connect', 'net.connect');
replaceFn(net, 'createConnection', 'net.createConnection');
replaceFn(net.Socket.prototype, 'connect', 'net.Socket.connect');
replaceFn(tls, 'connect', 'tls.connect');
if (typeof tls.TLSSocket === 'function') {
  const DeniedSocket = function DeniedTLSSocket() {
    deny('tls.TLSSocket')();
  };
  tls.TLSSocket = DeniedSocket;
  expected.push('tls.TLSSocket');
}
hookDns(dns, 'dns');
hookDns(dns.promises, 'dns.promises');
if (dns.Resolver) hookDns(dns.Resolver.prototype, 'dns.Resolver');
for (const key of ['exec', 'execFile', 'execSync', 'execFileSync', 'spawn', 'spawnSync', 'fork']) {
  replaceFn(cp, key, `child_process.${key}`);
}
global.fetch = deny('fetch');
expected.push('fetch');

let undici = null;
try { undici = require('undici'); } catch { undici = null; }
if (undici) {
  for (const key of ['fetch', 'request', 'stream', 'pipeline']) {
    replaceFn(undici, key, `undici.${key}`);
  }
}

try {
  const axios = require('axios');
  const resolved = require.resolve('axios');
  const stub = function axiosDenied() {
    deny('axios')();
  };
  for (const key of ['request', 'get', 'post', 'put', 'delete', 'head', 'patch']) {
    if (typeof axios[key] === 'function') stub[key] = deny(`axios.${key}`);
  }
  require.cache[resolved].exports = stub;
  expected.push('axios', 'axios.get', 'axios.post', 'axios.request');
} catch {
  // axios is a dev dependency of the suite. A missing module is itself a failed guard.
  expected.push('axios', 'axios.post');
}

function exprFor(label) {
  if (label.startsWith('dns.promises.')) {
    const name = label.slice('dns.promises.'.length);
    return `localRequire('dns').promises.${name}('example.com')`;
  }
  if (label.startsWith('dns.Resolver.')) {
    const name = label.slice('dns.Resolver.'.length);
    return `new (localRequire('node:dns').Resolver)().${name}('example.com', function () {})`;
  }
  if (label.startsWith('dns.')) {
    const name = label.slice('dns.'.length);
    return `localRequire('node:dns').${name}('example.com', function () {})`;
  }
  const table = {
    'http.request': "localRequire('node:http').request('http://example.com/')",
    'http.get': "localRequire('node:http').get('http://example.com/')",
    'https.request': "localRequire('node:https').request('https://example.com/')",
    'https.get': "(() => { const get = localRequire('node:https').get; get('https://example.com/'); })()",
    'net.connect': "localRequire('node:net').connect(80, 'example.com')",
    'net.createConnection': "localRequire('net').createConnection({ port: 80, host: 'example.com' })",
    'net.Socket.connect': "new (localRequire('net').Socket)().connect(80, 'example.com')",
    'tls.connect': "localRequire('node:tls').connect(443, 'example.com')",
    'tls.TLSSocket': "new (localRequire('tls').TLSSocket)()",
    'child_process.exec': "localRequire('child_process').exec('getent hosts example.com')",
    'child_process.execFile': "localRequire('child_process').execFile('getent', ['hosts', 'example.com'])",
    'child_process.execSync': "localRequire('child_process').execSync('getent hosts example.com')",
    'child_process.execFileSync': "localRequire('child_process').execFileSync('getent', ['hosts', 'example.com'])",
    'child_process.spawn': "localRequire('child_process').spawn('getent', ['hosts', 'example.com'])",
    'child_process.spawnSync': "localRequire('child_process').spawnSync('getent', ['hosts', 'example.com'])",
    'child_process.fork': "localRequire('child_process').fork('getent')",
    fetch: "fetch('https://example.com/')",
    'undici.fetch': "localRequire('undici').fetch('https://example.com/')",
    'undici.request': "localRequire('undici').request('https://example.com/')",
    'undici.stream': "localRequire('undici').stream('https://example.com/', { method: 'GET' }, function () {})",
    'undici.pipeline': "localRequire('undici').pipeline('https://example.com/', function () {})",
    axios: "localRequire('axios')('https://example.com/')",
    'axios.get': "localRequire('axios').get('https://example.com/')",
    'axios.post': "localRequire('axios').post('https://example.com/')",
    'axios.request': "localRequire('axios').request({ url: 'https://example.com/' })",
    'axios.put': "localRequire('axios').put('https://example.com/')",
    'axios.delete': "localRequire('axios').delete('https://example.com/')",
    'axios.head': "localRequire('axios').head('https://example.com/')",
    'axios.patch': "localRequire('axios').patch('https://example.com/')",
  };
  if (!table[label]) throw new Error(`no mutant expression for ${label}`);
  return table[label];
}

function runMutations() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'brand-leak-'));
  const file = path.join(dir, 'mutant.js');
  const lines = [
    "const { createRequire } = require('module');",
    `const localRequire = createRequire(${JSON.stringify(__filename)});`,
    'const results = [];',
    'function attempt(label, fn) {',
    '  try { fn(); results.push({ label, threw: false, code: null }); }',
    '  catch (err) { results.push({ label, threw: true, code: err && err.code || null }); }',
    '}',
  ];
  for (const label of expected) {
    const expr = exprFor(label);
    lines.push(`attempt(${JSON.stringify(label)}, () => { ${expr}; });`);
  }
  lines.push('global.__brandLeakResults = results;');
  fs.writeFileSync(file, lines.join('\n'));
  require(file);
  const results = global.__brandLeakResults || [];
  const caught = [...new Set(leaks)];
  const missed = expected.filter(label => !leaks.includes(label));
  const silent = results
    .filter(row => !row.threw || row.code !== 'BRAND_NETWORK_LEAK')
    .map(row => row.label);
  process.stdout.write(`${JSON.stringify({ caught, missed, silent })}\n`);
  fs.rmSync(dir, { recursive: true, force: true });
  process.exit(missed.length || silent.length ? 1 : 0);
}

if (process.argv.includes('--mutate')) runMutations();

const loaded = require.resolve('../src/brand/validate');
if (require.cache[loaded]) {
  process.stderr.write('brand modules loaded before the guard\n');
  process.exit(1);
}

const { validateBrand } = require('../src/brand/validate');
const { BRAND_FIXTURES } = require('../src/brand/fixtures');
const { pickPrototypes, recommendPrototypes } = require('../src/scoring/prototypes');
const { rubricFromParts } = require('../src/scoring/rubric-store');

for (const fixture of BRAND_FIXTURES) validateBrand(fixture);
validateBrand({
  name: 'TEST: No Fetch',
  logoUrl: 'https://fixtures.example/test-logo.png',
  colors: ['#112233'],
  source: 'manual',
  testTag: 'TEST:no-fetch',
});
const sample = {
  company: 'TEST: Sample Heating',
  industry: 'HVAC',
  state: 'Utah',
  website: 'https://sample.example',
  review_count: 80,
  rating: 4.6,
  fsm_detected: 'none',
  research: { signals: { mentions: { free_estimates: true } }, reviews: [] },
};
pickPrototypes(sample);
recommendPrototypes(sample);
rubricFromParts(
  { version: 1, min_score: 40, max_picks: 2, never_auto_pick: [], st_allow: [], spec_ref: 'docs/PROTOTYPE_PLAY.md' },
  [],
);

if (leaks.length) {
  process.stderr.write(`brand network leak: ${JSON.stringify([...new Set(leaks)])}\n`);
  process.exit(1);
}
process.exit(0);
