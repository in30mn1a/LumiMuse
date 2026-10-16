const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

function runFixture(...args) {
  return spawnSync(process.execPath, [path.join(__dirname, 'helpers/react-dom-teardown-fixture.cjs'), ...args], {
    cwd: path.resolve(__dirname, '..'),
    encoding: 'utf8',
    env: { ...process.env, NODE_ENV: 'test' },
    timeout: 20_000,
    windowsHide: true,
  });
}

test('React DOM teardown drains real scheduled work before removing globals and exits naturally', () => {
  const result = runFixture();
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /REACT_DOM_TEARDOWN_OK/);
  assert.equal(result.stderr, '');
});

test('React DOM teardown does not suppress a genuine asynchronous exception', () => {
  const result = runFixture('--throw-after-cleanup');
  assert.ifError(result.error);
  assert.notEqual(result.status, 0);
  assert.match(result.stdout, /REACT_DOM_TEARDOWN_OK/);
  assert.match(result.stderr, /REACT_DOM_TEARDOWN_UNHANDLED/);
});
