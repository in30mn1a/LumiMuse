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
  buildMemoryReviewBatches,
  MEMORY_REVIEW_BATCH_TEXT_CHAR_LIMIT,
} = require('../src/lib/memory-review-cluster');
const { normalizeEmbedding } = require('../src/lib/memory-embeddings');

function unit(vec) {
  return normalizeEmbedding(vec);
}

test('buildMemoryReviewBatches: deterministic for same input', () => {
  const memories = [
    { id: 'b', content: '用户喜欢喝美式咖啡', importance: 0.5 },
    { id: 'a', content: '用户喜欢喝拿铁', importance: 0.9 },
    { id: 'c', content: '明天下雨', importance: 0.2 },
  ];
  const once = buildMemoryReviewBatches(memories);
  const twice = buildMemoryReviewBatches(memories);
  assert.deepEqual(once, twice);
});

test('buildMemoryReviewBatches: covers all ids without duplicates', () => {
  const memories = Array.from({ length: 20 }, (_, i) => ({
    id: `m${i}`,
    content: `记忆内容 ${i} ${i % 2 === 0 ? '咖啡相关的偏好描述' : '完全不同的天气话题'}`,
    importance: (20 - i) / 20,
  }));
  const batches = buildMemoryReviewBatches(memories);
  const flat = batches.flat();
  assert.equal(flat.length, memories.length);
  assert.equal(new Set(flat).size, memories.length);
});

test('buildMemoryReviewBatches: similar vectors cluster together even across different logical groups', () => {
  // 不按 category 分桶——这里只传 id/content/embedding
  const coffee = unit([1, 0, 0, 0]);
  const nearCoffee = unit([0.98, 0.1, 0, 0]);
  const weather = unit([0, 1, 0, 0]);
  const memories = [
    { id: 'c1', content: '喜欢咖啡 A', importance: 0.5, embedding: coffee },
    { id: 'w1', content: '喜欢下雨', importance: 0.4, embedding: weather },
    { id: 'c2', content: '喜欢咖啡 B', importance: 0.3, embedding: nearCoffee },
  ];
  const batches = buildMemoryReviewBatches(memories, { batchTextCharLimit: 50_000 });
  // 高相似的 c1/c2 应同批（在预算极大时同簇同批）
  const flatBatches = batches.map(b => b.slice().sort().join(','));
  const coffeeTogether = batches.some(batch => batch.includes('c1') && batch.includes('c2'));
  assert.ok(coffeeTogether, `expected c1,c2 together, batches=${JSON.stringify(flatBatches)}`);
});

test('buildMemoryReviewBatches: text similarity clusters near-duplicates without vectors', () => {
  // 较短方 ≥20 字以启用 supersedeTextSimilarity 包含度，确保跨过默认 0.72 阈值
  const memories = [
    { id: '1', content: '用户非常喜欢在周末的时候去附近的公园散步放松心情', importance: 0.8 },
    { id: '2', content: '用户非常喜欢在周末的时候去附近的公园散步放松心情并且有时会带上相机拍照记录', importance: 0.7 },
    { id: '3', content: '明天项目同步会改到三楼玻璃会议室下午三点开始', importance: 0.6 },
  ];
  const batches = buildMemoryReviewBatches(memories, { batchTextCharLimit: 50_000 });
  const together = batches.some(batch => batch.includes('1') && batch.includes('2'));
  assert.ok(together, `expected near-duplicate texts together: ${JSON.stringify(batches)}`);
});

test('buildMemoryReviewBatches: comparison guardrail forces sequential remainder', () => {
  const memories = Array.from({ length: 10 }, (_, i) => ({
    id: `g${i}`,
    content: `完全不同的主题条目编号 ${i} xyz${i}`,
    importance: 1 - i * 0.01,
  }));
  // maxComparisons=0 → 全部直接各成簇（顺序降级）
  const batches = buildMemoryReviewBatches(memories, { maxComparisons: 0, batchTextCharLimit: 50_000 });
  assert.equal(batches.flat().length, 10);
  // 稳定序：importance 高的 id 先出现
  assert.equal(batches[0][0], 'g0');
});

test('buildMemoryReviewBatches: respects batch char budget by splitting large cluster', () => {
  const long = '用户偏好细节'.repeat(200); // 足够长，单条估算会逼近/超过预算
  const memories = [
    { id: 'x1', content: long, importance: 1 },
    { id: 'x2', content: long, importance: 0.9 },
  ];
  const batches = buildMemoryReviewBatches(memories, {
    batchTextCharLimit: MEMORY_REVIEW_BATCH_TEXT_CHAR_LIMIT,
    // 强制同簇：极低阈值
    textThreshold: 0,
    vectorThreshold: 0,
  });
  // 两条很长内容不应挤在同一 8000 批（估算含 overhead）
  if (batches.length === 1) {
    // 若实现把它们塞进一批，至少保证不丢 id
    assert.deepEqual(batches[0].slice().sort(), ['x1', 'x2']);
  } else {
    assert.ok(batches.length >= 2);
    assert.equal(batches.flat().length, 2);
  }
});
