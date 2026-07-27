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

const { contentSimilarity, supersedeTextSimilarity } = require('../src/lib/text-similarity');

test('contentSimilarity: identical strings → 1', () => {
  assert.equal(contentSimilarity('喜欢吃苹果', '喜欢吃苹果'), 1);
});

test('contentSimilarity: empty → 0', () => {
  assert.equal(contentSimilarity('', 'abc'), 0);
  assert.equal(contentSimilarity('abc', ''), 0);
});

test('contentSimilarity: unrelated short strings stay low', () => {
  const score = contentSimilarity('喜欢猫', '讨厌狗');
  assert.ok(score < 0.5, `expected low similarity, got ${score}`);
});

test('supersedeTextSimilarity: containment of longer similar text is high', () => {
  // 较短方须 ≥20 字才会启用包含度；构造高度前缀重叠的一对
  const short = '用户非常喜欢在周末的时候去附近的公园散步放松心情';
  const long = '用户非常喜欢在周末的时候去附近的公园散步放松心情并且有时会带上相机拍照记录';
  const score = supersedeTextSimilarity(short, long);
  assert.ok(score >= 0.72, `expected high containment similarity, got ${score}`);
});

test('supersedeTextSimilarity: short texts do not get containment boost below 20 chars', () => {
  // 短串 bigram 重叠可能偏高，但包含度在 shorterLength < 20 时应关闭
  const a = '喜欢猫';
  const b = '喜欢猫粮';
  const jaccard = contentSimilarity(a, b);
  const supersede = supersedeTextSimilarity(a, b);
  assert.equal(supersede, jaccard);
});
