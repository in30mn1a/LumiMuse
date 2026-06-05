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

const { inferMemoryDefaults } = require('../src/lib/memory-category.ts');

test('memory categories use the configured default importance values', () => {
  const expected = new Map([
    ['基础信息', 0.85],
    ['人格特质', 0.8],
    ['重要事件', 0.75],
    ['偏好习惯', 0.65],
    ['关系动态', 0.6],
    ['话题历史', 0.45],
    ['四季日常', 0.4],
  ]);

  for (const [category, importance] of expected) {
    assert.equal(inferMemoryDefaults(category).importance, importance, category);
  }
});
