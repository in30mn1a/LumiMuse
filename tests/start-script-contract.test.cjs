const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

test('npm start targets the standalone server while local next start stays explicit', () => {
  assert.equal(pkg.scripts.start, 'npm run start:standalone');
  assert.equal(pkg.scripts['start:standalone'], 'node .next/standalone/server.js');
  assert.equal(pkg.scripts['start:local'], 'next start');
});

test('npm build prepares static assets for standalone startup', () => {
  assert.equal(pkg.scripts.postbuild, 'node scripts/prepare-standalone-assets.js');
});

test('npm test uses a cross-platform runner instead of shell globs', () => {
  // Windows PowerShell/cmd 不会展开 tests/*.test.cjs；必须由脚本自行枚举文件。
  assert.equal(pkg.scripts.test, 'node scripts/run-tests.js');
  const runner = fs.readFileSync(path.join(root, 'scripts', 'run-tests.js'), 'utf8');
  assert.match(runner, /readdirSync/);
  assert.match(runner, /endsWith\('\.test\.cjs'\)/);
  assert.match(runner, /endsWith\('-smoke\.cjs'\)/);
  assert.match(runner, /\['--test', \.\.\.files\]/);
  // package.json 不得再把 shell glob 直接交给 node --test
  assert.doesNotMatch(pkg.scripts.test, /\*/);
});

test('README files document local and standalone start commands', () => {
  const readmeZh = fs.readFileSync(path.join(root, 'README.md'), 'utf8');
  const readmeEn = fs.readFileSync(path.join(root, 'README.en.md'), 'utf8');

  for (const content of [readmeZh, readmeEn]) {
    assert.match(content, /npm run start:local/);
    assert.match(content, /npm run start:standalone/);
    assert.match(content, /node server\.js/);
  }
});
