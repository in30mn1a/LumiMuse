const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');
const fontPackageName = 'lxgw-wenkai-screen-webfont';

function readJson(relativePath) {
  return JSON.parse(fs.readFileSync(path.join(root, relativePath), 'utf8'));
}

test('LXGW WenKai Screen is vendored under public/fonts', () => {
  const cssPath = path.join(root, 'public', 'fonts', 'lxgw', 'lxgwwenkaigbscreen.css');
  const filesDir = path.join(root, 'public', 'fonts', 'lxgw', 'files');

  assert.ok(fs.existsSync(cssPath));
  assert.ok(
    fs.readdirSync(filesDir).some((name) => name.endsWith('.woff2')),
    'expected vendored woff2 font subsets',
  );
});

test('vendored font package is not installed as a dev dependency', () => {
  const pkg = readJson('package.json');
  const lock = readJson('package-lock.json');

  assert.equal(pkg.devDependencies && pkg.devDependencies[fontPackageName], undefined);
  assert.equal(lock.packages['']?.devDependencies?.[fontPackageName], undefined);
  assert.equal(lock.packages[`node_modules/${fontPackageName}`], undefined);
});
