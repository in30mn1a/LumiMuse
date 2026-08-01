const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');

const root = path.resolve(__dirname, '..');
const originalResolveFilename = Module._resolveFilename;
const originalLoad = Module._load;

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

function requireFreshWithMocks(modulePath, mocks) {
  Module._load = function loadWithMocks(request, parent, isMain) {
    if (Object.prototype.hasOwnProperty.call(mocks, request)) {
      return mocks[request];
    }
    return originalLoad.call(this, request, parent, isMain);
  };

  try {
    const resolved = require.resolve(modulePath);
    delete require.cache[resolved];
    return require(modulePath);
  } finally {
    Module._load = originalLoad;
  }
}

function loadReferenceModule() {
  return requireFreshWithMocks('../src/lib/memory-extraction-reference.ts', {
    '@/lib/db': { getDb: () => { throw new Error('db should not be touched when deps are injected'); } },
  });
}

const { embeddingToBlob } = require('../src/lib/memory-embeddings.ts');

function memory(overrides = {}) {
  return {
    id: overrides.id || 'mem-1',
    character_id: 'char-a',
    category: overrides.category || '偏好习惯',
    content: overrides.content || '用户不爱吃甜。',
    confidence: 0.8,
    tags: overrides.tags || [],
    source_msg_ids: [],
    memory_kind: overrides.memory_kind || 'user_preference',
    importance: overrides.importance ?? 0.5,
    emotional_weight: 0,
    status: 'active',
    pinned: overrides.pinned ?? false,
    last_used_at: null,
    usage_count: 0,
    metadata: {},
    created_at: '2026-06-01T00:00:00.000Z',
    updated_at: '2026-06-01T00:00:00.000Z',
  };
}

// 增强记忆 + 向量检索开启
function vectorSettings(overrides = {}) {
  return {
    memory_engine: {
      enabled: true,
      embedding_enabled: true,
      embedding_model: 'test-embed',
      embedding_dimension: 2,
      memory_package_token_budget: 12000,
      ...overrides,
    },
  };
}

const CANDIDATES = [
  { category: '偏好习惯', content: '用户最近迷上了做甜点，昨天烤了巴斯克。', tags: ['甜点'] },
];

test('lifecycle recall anchors on the candidate, not the conversation text', async () => {
  const { buildLifecycleReference } = loadReferenceModule();
  const seenTexts = [];

  const result = await buildLifecycleReference('char-a', CANDIDATES, vectorSettings(), {
    loadPriorityMemories: () => [],
    loadMemoryProfile: () => null,
    embedTexts: async (texts) => {
      seenTexts.push(...texts);
      return [Float32Array.from([1, 0])];
    },
    loadEmbeddingRows: () => [
      { memory_id: 'mem-sweet', embedding_blob: embeddingToBlob([1, 0]) },
      { memory_id: 'mem-grad', embedding_blob: embeddingToBlob([0, 1]) },
    ],
    loadMemoriesByIds: (ids) => ids.map((id) => memory({
      id,
      content: id === 'mem-sweet' ? '用户不爱吃甜。' : '用户在读研究生。',
    })),
  });

  // 锚点文本必须来自候选条目本身
  assert.equal(seenTexts.length, 1);
  assert.match(seenTexts[0], /迷上了做甜点/);
  assert.match(seenTexts[0], /偏好习惯/);

  assert.equal(result.mode, 'vector');
  // 相似度最高的 mem-sweet 排在前面
  assert.equal(result.memories[0].id, 'mem-sweet');
  assert.match(result.text, /用户不爱吃甜/);
});

test('embedding failure falls back to keyword recall instead of returning nothing', async () => {
  const { buildLifecycleReference } = loadReferenceModule();
  let keywordQueried = null;

  const result = await buildLifecycleReference('char-a', CANDIDATES, vectorSettings(), {
    loadPriorityMemories: () => [],
    loadMemoryProfile: () => null,
    embedTexts: async () => { throw new Error('embedding upstream down'); },
    localRetrieve: (queryText) => {
      keywordQueried = queryText;
      return [memory({ id: 'mem-sweet', content: '用户不爱吃甜。' })];
    },
  });

  assert.equal(result.mode, 'local');
  assert.equal(result.diagnostics.embeddingFailed, 'embedding upstream down');
  assert.match(keywordQueried, /迷上了做甜点/);
  assert.equal(result.memories[0].id, 'mem-sweet');
});

test('priority memories are always included and rank ahead of recall results', async () => {
  const { buildLifecycleReference } = loadReferenceModule();

  const result = await buildLifecycleReference('char-a', CANDIDATES, vectorSettings(), {
    loadPriorityMemories: () => [
      memory({ id: 'mem-promise', content: '我承诺难过时先陪伴再分析。', memory_kind: 'character_promise', importance: 0.9 }),
    ],
    loadMemoryProfile: () => null,
    embedTexts: async () => [Float32Array.from([1, 0])],
    loadEmbeddingRows: () => [{ memory_id: 'mem-sweet', embedding_blob: embeddingToBlob([1, 0]) }],
    loadMemoriesByIds: (ids) => ids.map((id) => memory({ id, content: '用户不爱吃甜。' })),
  });

  assert.equal(result.memories[0].id, 'mem-promise', 'priority memory must come first');
  assert.equal(result.memories[1].id, 'mem-sweet');
  assert.equal(result.diagnostics.priorityCount, 1);
});

test('priority memory recalled by vector is not duplicated', async () => {
  const { buildLifecycleReference } = loadReferenceModule();

  const result = await buildLifecycleReference('char-a', CANDIDATES, vectorSettings(), {
    loadPriorityMemories: () => [memory({ id: 'mem-sweet', content: '用户不爱吃甜。', importance: 0.9 })],
    loadMemoryProfile: () => null,
    embedTexts: async () => [Float32Array.from([1, 0])],
    loadEmbeddingRows: () => [{ memory_id: 'mem-sweet', embedding_blob: embeddingToBlob([1, 0]) }],
    loadMemoriesByIds: (ids) => ids.map((id) => memory({ id, content: '用户不爱吃甜。' })),
  });

  assert.equal(result.memories.length, 1);
});

test('reference is trimmed to the memory package token budget', async () => {
  const { buildLifecycleReference } = loadReferenceModule();
  const many = Array.from({ length: 50 }, (_, i) => memory({ id: `mem-${i}`, content: `记忆条目 ${i}` }));

  const result = await buildLifecycleReference(
    'char-a',
    CANDIDATES,
    vectorSettings({ memory_package_token_budget: 40, embedding_enabled: false }),
    {
      loadPriorityMemories: () => many,
      loadMemoryProfile: () => null,
      tokenCounter: (text) => text.length,
    },
  );

  assert.ok(result.tokenCount <= 40, `expected <= 40, got ${result.tokenCount}`);
  assert.ok(result.memories.length < 50);
  assert.equal(result.diagnostics.truncated, true);
});

test('no candidates yields priority-only reference without calling the embedder', async () => {
  const { buildLifecycleReference } = loadReferenceModule();
  let embedCalled = false;

  const result = await buildLifecycleReference('char-a', [], vectorSettings(), {
    loadPriorityMemories: () => [memory({ id: 'mem-promise' })],
    loadMemoryProfile: () => null,
    embedTexts: async () => { embedCalled = true; return []; },
  });

  assert.equal(embedCalled, false);
  assert.equal(result.mode, 'priority-only');
  assert.equal(result.memories.length, 1);
});

test('overview exposes profile text and priority memories separately', () => {
  const { buildExtractionOverview } = loadReferenceModule();

  const overview = buildExtractionOverview('char-a', vectorSettings(), {
    loadMemoryProfile: () => ({
      character_id: 'char-a',
      profile_name: '',
      relationship_state: '亲密伴侣',
      recent_story_state: '',
      emotional_baseline: '',
      open_threads: [],
      user_profile_summary: '研究生在读',
      pinned_summary: '',
    }),
    loadPriorityMemories: () => [memory({ id: 'mem-promise', content: '我承诺先陪伴再分析。' })],
  });

  assert.match(overview.profileText, /亲密伴侣/);
  assert.match(overview.profileText, /研究生在读/);
  assert.match(overview.priorityText, /我承诺先陪伴再分析/);
  // 画像与记忆分属两个占位符，不能混在一起
  assert.ok(!overview.priorityText.includes('亲密伴侣'));
});

test('embedding disabled skips vector recall and uses keyword recall', async () => {
  const { buildLifecycleReference } = loadReferenceModule();
  let embedCalled = false;

  const result = await buildLifecycleReference(
    'char-a',
    CANDIDATES,
    vectorSettings({ embedding_enabled: false }),
    {
      loadPriorityMemories: () => [],
      loadMemoryProfile: () => null,
      embedTexts: async () => { embedCalled = true; return []; },
      localRetrieve: () => [memory({ id: 'mem-sweet' })],
    },
  );

  assert.equal(embedCalled, false);
  assert.equal(result.mode, 'local');
  assert.equal(result.memories[0].id, 'mem-sweet');
});

// ── M1 回归防护 ────────────────────────────────────────────────
// 刚写入的记忆其 embedding 还在队列里 pending，loadReadyMemoryEmbeddings 硬过滤
// status='ready' 看不见它。若关键词召回只在向量「零结果」时兜底，这条近重复就漏了，
// 而「连续几轮聊同一话题」正是重复提取风险最高的窗口。
test('vector and keyword recall are unioned, not either-or', async () => {
  const { buildLifecycleReference } = loadReferenceModule();

  const result = await buildLifecycleReference('char-a', CANDIDATES, vectorSettings(), {
    loadPriorityMemories: () => [],
    loadMemoryProfile: () => null,
    embedTexts: async () => [Float32Array.from([1, 0])],
    loadEmbeddingRows: () => [{ memory_id: 'mem-indexed', embedding_blob: embeddingToBlob([1, 0]) }],
    loadMemoriesByIds: (ids) => ids.map((id) => memory({ id, content: '用户不爱吃甜。' })),
    // 尚未建索引的近重复记忆，只有关键词召回看得到
    localRetrieve: () => [memory({ id: 'mem-pending', content: '用户昨天做了甜点。' })],
  });

  assert.equal(result.mode, 'hybrid');
  const ids = result.memories.map((m) => m.id);
  assert.ok(ids.includes('mem-indexed'), 'vector hit must survive');
  assert.ok(ids.includes('mem-pending'), 'keyword-only hit must not be dropped');
});

test('fallback_local_enabled=false suppresses the keyword union', async () => {
  const { buildLifecycleReference } = loadReferenceModule();

  const result = await buildLifecycleReference(
    'char-a',
    CANDIDATES,
    vectorSettings({ fallback_local_enabled: false }),
    {
      loadPriorityMemories: () => [],
      loadMemoryProfile: () => null,
      embedTexts: async () => [Float32Array.from([1, 0])],
      loadEmbeddingRows: () => [{ memory_id: 'mem-indexed', embedding_blob: embeddingToBlob([1, 0]) }],
      loadMemoriesByIds: (ids) => ids.map((id) => memory({ id })),
      localRetrieve: () => [memory({ id: 'mem-pending' })],
    },
  );

  assert.equal(result.mode, 'vector');
  assert.deepEqual(result.memories.map((m) => m.id), ['mem-indexed']);
});

// ── M2 回归防护 ────────────────────────────────────────────────
// character_promise 无条件进 priority 且只增不减，长期陪伴后可能填满整个预算，
// 把语义召回结果全部挤出 prompt，而 mode 仍报 vector，日志看不出异常。
test('a large priority set cannot squeeze out the recall results', async () => {
  const { buildLifecycleReference } = loadReferenceModule();
  const manyPromises = Array.from({ length: 200 }, (_, i) => memory({
    id: `mem-promise-${i}`,
    category: '关系动态',
    content: `我承诺以后会做到第 ${i} 件事情，一定不会忘记。`,
    memory_kind: 'character_promise',
  }));

  const result = await buildLifecycleReference(
    'char-a',
    CANDIDATES,
    vectorSettings({ memory_package_token_budget: 400 }),
    {
      loadPriorityMemories: () => manyPromises,
      loadMemoryProfile: () => null,
      embedTexts: async () => [Float32Array.from([1, 0])],
      loadEmbeddingRows: () => [{ memory_id: 'mem-sweet', embedding_blob: embeddingToBlob([1, 0]) }],
      loadMemoriesByIds: (ids) => ids.map((id) => memory({ id, content: '用户不爱吃甜。' })),
      tokenCounter: (text) => text.length,
    },
  );

  const ids = result.memories.map((m) => m.id);
  assert.ok(ids.includes('mem-sweet'), '召回结果必须有预留份额，不能被 priority 挤光');
  assert.ok(result.tokenCount <= 400);
});

// ── F1 回归防护 ────────────────────────────────────────────────
// 被向量命中的记忆若恰好也在 priority 尾部，会同时遭遇「已从召回集去重」+
// 「被 priority 预算截断」，结果是唯一的语义命中一条都没进 prompt，
// 而 mode 仍报 vector、recallCount>0 —— H1 的危害换条路复现。
test('a recalled memory sitting at the tail of priority still reaches the prompt', async () => {
  const { buildLifecycleReference } = loadReferenceModule();
  const priority = Array.from({ length: 30 }, (_, i) => memory({
    id: `mem-p${i}`,
    category: '关系动态',
    content: `我承诺以后会做到第 ${i} 件事情，绝对不会忘记这件事。`,
    memory_kind: 'character_promise',
  }));

  const result = await buildLifecycleReference(
    'char-a',
    CANDIDATES,
    vectorSettings({ memory_package_token_budget: 400 }),
    {
      loadPriorityMemories: () => priority,
      loadMemoryProfile: () => null,
      embedTexts: async () => [Float32Array.from([1, 0])],
      // 向量唯一命中的是 priority 的最后一条
      loadEmbeddingRows: () => [{ memory_id: 'mem-p29', embedding_blob: embeddingToBlob([1, 0]) }],
      loadMemoriesByIds: (ids) => ids.map((id) => priority.find((m) => m.id === id)),
      tokenCounter: (text) => text.length,
    },
  );

  const ids = result.memories.map((m) => m.id);
  assert.ok(ids.includes('mem-p29'), '语义命中不得因 priority 截断而消失');
  // 且不能重复出现
  assert.equal(ids.filter((id) => id === 'mem-p29').length, 1);
});

// ── F2 回归防护 ────────────────────────────────────────────────
// 召回池上限是 12×候选数，通常只有几条；硬预留半个预算会让 priority 白白少装一半。
test('unused recall reserve flows back to priority instead of idling', async () => {
  const { buildLifecycleReference } = loadReferenceModule();
  const priority = Array.from({ length: 40 }, (_, i) => memory({
    id: `mem-p${i}`,
    category: '关系动态',
    content: `承诺第 ${i} 条内容，占位文本。`,
    memory_kind: 'character_promise',
  }));

  const result = await buildLifecycleReference(
    'char-a',
    CANDIDATES,
    vectorSettings({ memory_package_token_budget: 400 }),
    {
      loadPriorityMemories: () => priority,
      loadMemoryProfile: () => null,
      embedTexts: async () => [Float32Array.from([1, 0])],
      loadEmbeddingRows: () => [{ memory_id: 'mem-r0', embedding_blob: embeddingToBlob([1, 0]) }],
      loadMemoriesByIds: (ids) => ids.map((id) => memory({ id, content: '短召回。' })),
      tokenCounter: (text) => text.length,
    },
  );

  // 召回只吃掉很少 token，剩余预算应几乎全部用于 priority
  // （修复前 priority 被硬限制在 400-200=200 token ≈ 7 条；修复后 ≈ 13 条）
  assert.ok(result.tokenCount > 360, `预算利用率过低: ${result.tokenCount}/400`);
  assert.ok(result.tokenCount <= 400);
  assert.ok(result.memories.some((m) => m.id === 'mem-r0'), '召回结果仍须保留');
  assert.ok(
    result.memories.filter((m) => m.id.startsWith('mem-p')).length > 10,
    'priority 应吃到回流的余额，而不是被硬限制在半个预算',
  );
});

// E 编号是模型指认 supersede/upsert 目标的唯一凭据；与 memories 数组错位会作废错误的记忆
test('E-numbers are contiguous and align with the memories array', async () => {
  const { buildLifecycleReference } = loadReferenceModule();

  const result = await buildLifecycleReference('char-a', CANDIDATES, vectorSettings(), {
    loadPriorityMemories: () => [
      memory({ id: 'mem-p0', content: '承诺零。' }),
      memory({ id: 'mem-p1', content: '承诺一。' }),
    ],
    loadMemoryProfile: () => null,
    embedTexts: async () => [Float32Array.from([1, 0])],
    loadEmbeddingRows: () => [
      { memory_id: 'mem-r0', embedding_blob: embeddingToBlob([1, 0]) },
      { memory_id: 'mem-r1', embedding_blob: embeddingToBlob([0.9, 0.1]) },
    ],
    loadMemoriesByIds: (ids) => ids.map((id) => memory({ id, content: `召回 ${id}` })),
  });

  const lines = result.text.split('\n');
  assert.equal(lines.length, result.memories.length);
  lines.forEach((line, index) => {
    assert.ok(line.startsWith(`E${index}. `), `line ${index} must start with E${index}.`);
    // 第 index 行的内容必须来自 memories[index]
    assert.ok(line.includes(result.memories[index].content));
  });
});
