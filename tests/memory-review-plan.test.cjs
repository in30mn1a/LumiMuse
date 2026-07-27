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
  createMemoryReviewPlan,
  getMemoryReviewPlanBatch,
  clearMemoryReviewPlanCacheForTests,
  PLAN_NOT_FOUND_CODE,
  MemoryReviewPlanError,
} = require('../src/lib/memory-review-plan');

test.beforeEach(() => {
  clearMemoryReviewPlanCacheForTests();
});

test('createMemoryReviewPlan freezes membership; importance edits do not change batch ids', () => {
  const memories = Array.from({ length: 12 }, (_, i) => ({
    id: `id-${i}`,
    content: `内容 ${i} ${i % 3 === 0 ? '咖啡爱好' : '其他话题' + i}`,
    importance: i / 12,
  }));
  const plan = createMemoryReviewPlan({
    characterId: 'char-1',
    memories,
    planId: 'plan-fixed',
    now: 1_000_000,
  });

  // 模拟整理后 importance 全改——计划内 batches 仍覆盖全部原始 id
  const mutated = memories.map((m, i) => ({ ...m, importance: 1 - i / 12 }));
  const plan2 = createMemoryReviewPlan({
    characterId: 'char-1',
    memories: mutated,
    planId: 'plan-other',
    now: 1_000_001,
  });

  const covered = new Set(plan.memoryIds);
  assert.equal(covered.size, 12);
  for (const m of memories) assert.ok(covered.has(m.id));

  // 取批不依赖外部排序
  const allFromBatches = [];
  for (let i = 0; i < plan.batches.length; i += 1) {
    const { batchIds } = getMemoryReviewPlanBatch({
      planId: plan.planId,
      characterId: 'char-1',
      batchIndex: i,
      now: 1_000_100,
    });
    allFromBatches.push(...batchIds);
  }
  assert.deepEqual(allFromBatches.slice().sort(), memories.map(m => m.id).sort());
  // plan2 是另一计划，不污染 plan-fixed
  assert.notEqual(plan2.planId, plan.planId);
});

test('getMemoryReviewPlanBatch: unknown plan → PLAN_NOT_FOUND', () => {
  assert.throws(
    () => getMemoryReviewPlanBatch({ planId: 'missing', characterId: 'c', batchIndex: 0 }),
    (err) => err instanceof MemoryReviewPlanError && err.code === PLAN_NOT_FOUND_CODE,
  );
});

test('getMemoryReviewPlanBatch: expired plan → PLAN_NOT_FOUND', () => {
  const plan = createMemoryReviewPlan({
    characterId: 'char-1',
    memories: [{ id: 'a', content: 'x', importance: 1 }],
    planId: 'expiring',
    now: 1000,
    ttlMs: 10,
  });
  assert.throws(
    () => getMemoryReviewPlanBatch({
      planId: plan.planId,
      characterId: 'char-1',
      batchIndex: 0,
      now: 1020,
    }),
    (err) => err instanceof MemoryReviewPlanError && err.code === PLAN_NOT_FOUND_CODE,
  );
});

test('getMemoryReviewPlanBatch: character mismatch → PLAN_NOT_FOUND', () => {
  const plan = createMemoryReviewPlan({
    characterId: 'char-1',
    memories: [{ id: 'a', content: 'x', importance: 1 }],
    planId: 'char-check',
    now: 5000,
  });
  assert.throws(
    () => getMemoryReviewPlanBatch({
      planId: plan.planId,
      characterId: 'char-2',
      batchIndex: 0,
      now: 5001,
    }),
    (err) => err instanceof MemoryReviewPlanError && err.code === PLAN_NOT_FOUND_CODE,
  );
});
