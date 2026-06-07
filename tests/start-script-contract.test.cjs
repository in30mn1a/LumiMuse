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

test('README files document local and standalone start commands', () => {
  const readmeZh = fs.readFileSync(path.join(root, 'README.md'), 'utf8');
  const readmeEn = fs.readFileSync(path.join(root, 'README.en.md'), 'utf8');

  for (const content of [readmeZh, readmeEn]) {
    assert.match(content, /npm run start:local/);
    assert.match(content, /npm run start:standalone/);
    assert.match(content, /node server\.js/);
  }
});
