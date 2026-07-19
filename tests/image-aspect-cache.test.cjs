'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');

const root = path.resolve(__dirname, '..');
const originalResolveFilename = Module._resolveFilename;

Module._resolveFilename = function resolveFilename(request, parent, isMain, options) {
  if (request.startsWith('@/')) {
    const mapped = path.join(root, 'src', request.slice(2));
    for (const candidate of [mapped, `${mapped}.ts`, `${mapped}.tsx`, path.join(mapped, 'index.ts')]) {
      if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
    }
  }
  return originalResolveFilename.call(this, request, parent, isMain, options);
};

require.extensions['.ts'] = function loadTs(module, filename) {
  const source = fs.readFileSync(filename, 'utf8');
  const output = ts.transpileModule(source, {
    compilerOptions: {
      esModuleInterop: true,
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
    fileName: filename,
  });
  module._compile(output.outputText, filename);
};

const {
  DEFAULT_IMAGE_ASPECT_RATIO,
  peekImageAspectRatio,
  rememberImageAspectRatio,
  resetImageAspectCache,
  warmImageAspectRatio,
} = require('../src/lib/image-aspect-cache.ts');

test('image-aspect-cache: unknown urls return undefined', () => {
  resetImageAspectCache();
  assert.equal(peekImageAspectRatio('/api/files/generated/x.png'), undefined);
  assert.equal(peekImageAspectRatio(null), undefined);
  assert.equal(peekImageAspectRatio(undefined), undefined);
});

test('image-aspect-cache: remembers valid ratios and rejects invalid ones', () => {
  resetImageAspectCache();
  rememberImageAspectRatio('/a.png', 1.5);
  assert.equal(peekImageAspectRatio('/a.png'), 1.5);

  rememberImageAspectRatio('/b.png', 0);
  rememberImageAspectRatio('/c.png', -1);
  rememberImageAspectRatio('/d.png', Number.NaN);
  rememberImageAspectRatio('/e.png', 100);
  assert.equal(peekImageAspectRatio('/b.png'), undefined);
  assert.equal(peekImageAspectRatio('/c.png'), undefined);
  assert.equal(peekImageAspectRatio('/d.png'), undefined);
  assert.equal(peekImageAspectRatio('/e.png'), undefined);
});

test('image-aspect-cache: warm returns cached value immediately', async () => {
  resetImageAspectCache();
  rememberImageAspectRatio('/cached.png', 0.75);
  const ratio = await warmImageAspectRatio('/cached.png');
  assert.equal(ratio, 0.75);
});

test('image-aspect-cache: empty url falls back to default', async () => {
  resetImageAspectCache();
  const ratio = await warmImageAspectRatio('');
  assert.equal(ratio, DEFAULT_IMAGE_ASPECT_RATIO);
});
