require('./preload');

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('child_process');
const path = require('path');

describe('test seams', () => {
  it('throws unless NODE_ENV is test', () => {
    const result = spawnSync(process.execPath, ['-e', `
      process.env.NODE_ENV = 'production';
      const places = require('./src/bot/google-places');
      const draft = require('./src/proposals/draft');
      const send = require('./src/proposals/send');
      const hooks = [
        ['_setSearch', () => places._setSearch(() => [])],
        ['_setClient', () => draft._setClient({})],
        ['_setTransport', () => send._setTransport({})],
      ];
      let failed = false;
      for (const [name, fn] of hooks) {
        try {
          fn();
          console.log('allowed ' + name);
          failed = true;
        } catch (err) {
          if (!/NODE_ENV=test/.test(err.message)) {
            console.log('wrong ' + name + ' ' + err.message);
            failed = true;
          } else {
            console.log('threw ' + name);
          }
        }
      }
      if (failed) process.exit(1);
    `], {
      encoding: 'utf8',
      cwd: path.join(__dirname, '..'),
      env: { ...process.env, NODE_ENV: 'production' },
    });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /threw _setSearch/);
    assert.match(result.stdout, /threw _setClient/);
    assert.match(result.stdout, /threw _setTransport/);
    assert.doesNotMatch(result.stdout, /allowed/);
  });
});
