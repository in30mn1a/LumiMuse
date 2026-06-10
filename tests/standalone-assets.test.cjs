const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { prepareStandaloneAssets } = require('../scripts/prepare-standalone-assets.js');

test('prepareStandaloneAssets copies Next static and public files into standalone output', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lumimuse-standalone-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const staticFile = path.join(root, '.next', 'static', 'chunks', 'app.js');
  const publicFile = path.join(root, 'public', 'fonts', 'lxgw.css');
  fs.mkdirSync(path.dirname(staticFile), { recursive: true });
  fs.mkdirSync(path.dirname(publicFile), { recursive: true });
  fs.mkdirSync(path.join(root, '.next', 'standalone'), { recursive: true });
  fs.writeFileSync(staticFile, 'console.log("asset");');
  fs.writeFileSync(publicFile, '@font-face {}');

  await prepareStandaloneAssets(root, { log: () => {} });

  assert.equal(
    fs.readFileSync(path.join(root, '.next', 'standalone', '.next', 'static', 'chunks', 'app.js'), 'utf8'),
    'console.log("asset");',
  );
  assert.equal(
    fs.readFileSync(path.join(root, '.next', 'standalone', 'public', 'fonts', 'lxgw.css'), 'utf8'),
    '@font-face {}',
  );
});
