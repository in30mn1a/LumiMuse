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

const { normalizeTag, normalizeTags, TAG_SPEC_PROMPT_SECTION, CANONICAL_TAGS, TAG_ALIASES } = require('../src/lib/memory-tag-spec.ts');

test('normalizeTag maps known aliases to canonical tags', () => {
  assert.equal(normalizeTag('午饭'), '午餐');
  assert.equal(normalizeTag('聊天'), '对话');
  assert.equal(normalizeTag('健身'), '运动');
  assert.equal(normalizeTag(' 晚饭 '), '晚餐');
});

test('normalizeTag leaves unknown tags untouched and trims', () => {
  assert.equal(normalizeTag('面条'), '面条');
  assert.equal(normalizeTag('  日常  '), '日常');
  assert.equal(normalizeTag(''), '');
  assert.equal(normalizeTag(null), '');
});

test('normalizeTags dedupes after normalization while preserving order', () => {
  assert.deepEqual(normalizeTags(['午饭', '午餐', '聊天']), ['午餐', '对话']);
  assert.deepEqual(normalizeTags(['午餐', '面条', '饮食', '日常']), ['午餐', '面条', '饮食', '日常']);
  assert.deepEqual(normalizeTags([]), []);
  assert.deepEqual(normalizeTags(['  ', '', '运动', '锻炼']), ['运动']);
});

test('normalizeTags ignores non-array input', () => {
  assert.deepEqual(normalizeTags(null), []);
  assert.deepEqual(normalizeTags('午餐'), []);
});

test('every alias maps to a canonical tag and is not itself canonical', () => {
  const canonical = new Set(CANONICAL_TAGS);
  const entries = Object.entries(TAG_ALIASES);
  assert.ok(entries.length > 0, 'alias table should not be empty');
  for (const [alias, target] of entries) {
    assert.ok(canonical.has(target), `alias "${alias}" maps to non-canonical tag "${target}"`);
    // 别名 key 本身不应是标准标签，否则会把已经规范的词又改写、甚至造成链式映射。
    assert.ok(!canonical.has(alias), `alias key "${alias}" should not itself be a canonical tag`);
  }
});

test('prompt section lists groups and alias examples and stays compact', () => {
  assert.match(TAG_SPEC_PROMPT_SECTION, /标签规范表/);
  assert.match(TAG_SPEC_PROMPT_SECTION, /近义写法统一示例/);
  // prompt 体积需受控，避免顶到 memory-review 的整包长度上限。
  assert.ok(TAG_SPEC_PROMPT_SECTION.length < 1200, `tag spec section too long: ${TAG_SPEC_PROMPT_SECTION.length}`);
});
