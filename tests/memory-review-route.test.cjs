const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');
const Database = require('better-sqlite3');

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
    // 清掉 route / plan / cluster 缓存，确保 mocks 与 cluster 分批参数生效。
    for (const key of Object.keys(require.cache)) {
      if (
        key.includes(`${path.sep}memory-review`)
        || key.includes(`${path.sep}memory-review-plan`)
        || key.includes(`${path.sep}memory-review-cluster`)
      ) {
        delete require.cache[key];
      }
    }
    const resolved = require.resolve(modulePath);
    delete require.cache[resolved];
    return require(modulePath);
  } finally {
    Module._load = originalLoad;
  }
}

/**
 * 强制按固定条数切批（跳过真实聚类）。
 * MEMORY_REVIEW_BATCH_SIZE 仍为 500，保证单次 HTTP 页可容纳多批 LLM 调用（并发/失败隔离用例）。
 */
function mockClusterChunkBy(chunkSize) {
  return {
    MEMORY_REVIEW_BATCH_SIZE: 500,
    MEMORY_REVIEW_ENTRY_CONTENT_CHAR_LIMIT: 4000,
    buildMemoryReviewBatches(memories) {
      const sorted = [...memories].sort((a, b) => {
        if (b.importance !== a.importance) return b.importance - a.importance;
        if (a.id < b.id) return -1;
        if (a.id > b.id) return 1;
        return 0;
      });
      const batches = [];
      for (let offset = 0; offset < sorted.length; offset += chunkSize) {
        batches.push(sorted.slice(offset, offset + chunkSize).map(memory => memory.id));
      }
      return batches;
    },
  };
}

function jsonResponseMock() {
  return {
    NextResponse: {
      json(body, init = {}) {
        return {
          status: init.status ?? 200,
          async json() {
            return body;
          },
        };
      },
    },
  };
}

function jsonRequest(body) {
  return {
    async json() {
      return body;
    },
  };
}

function createReviewDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE memories (
      id TEXT PRIMARY KEY,
      character_id TEXT NOT NULL,
      category TEXT NOT NULL,
      content TEXT NOT NULL,
      tags TEXT NOT NULL DEFAULT '[]',
      importance REAL NOT NULL DEFAULT 0.5,
      emotional_weight REAL NOT NULL DEFAULT 0,
      memory_kind TEXT NOT NULL DEFAULT 'general',
      status TEXT NOT NULL DEFAULT 'active',
      updated_at TEXT NOT NULL
    );

    INSERT INTO memories (
      id, character_id, category, content, tags, importance, emotional_weight, memory_kind, status, updated_at
    ) VALUES (
      'mem-a', 'char-a', '重要事件', '2026年6月4日，用户午饭吃了面。', '[]', 0.9, 0, 'general', 'active', '2026-06-04T00:00:00.000Z'
    );
  `);
  return db;
}

function insertReviewMemory(db, overrides = {}) {
  const memory = {
    id: 'mem-a',
    character_id: 'char-a',
    category: '重要事件',
    content: '2026年6月4日，用户午饭吃了面。',
    tags: [],
    importance: 0.9,
    emotional_weight: 0,
    memory_kind: 'general',
    status: 'active',
    updated_at: '2026-06-04T00:00:00.000Z',
    ...overrides,
  };

  db.prepare(`
    INSERT INTO memories (
      id, character_id, category, content, tags, importance, emotional_weight, memory_kind, status, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    memory.id,
    memory.character_id,
    memory.category,
    memory.content,
    JSON.stringify(memory.tags),
    memory.importance,
    memory.emotional_weight,
    memory.memory_kind,
    memory.status,
    memory.updated_at,
  );
}

function createEmptyReviewDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE memories (
      id TEXT PRIMARY KEY,
      character_id TEXT NOT NULL,
      category TEXT NOT NULL,
      content TEXT NOT NULL,
      tags TEXT NOT NULL DEFAULT '[]',
      importance REAL NOT NULL DEFAULT 0.5,
      emotional_weight REAL NOT NULL DEFAULT 0,
      memory_kind TEXT NOT NULL DEFAULT 'general',
      status TEXT NOT NULL DEFAULT 'active',
      updated_at TEXT NOT NULL
    );
  `);
  return db;
}

function createLargeReviewDb() {
  const db = createEmptyReviewDb();
  const insert = db.prepare(`
    INSERT INTO memories (
      id, character_id, category, content, tags, importance, emotional_weight, memory_kind, status, updated_at
    ) VALUES (?, 'char-a', '四季日常', ?, '[]', 0.5, 0, 'general', 'active', ?)
  `);
  const now = Date.parse('2026-06-04T00:00:00.000Z');
  for (let i = 0; i < 80; i++) {
    insert.run(
      `mem-${String(i).padStart(2, '0')}`,
      `这是一条用于确认全量发送的长记忆 ${i}。${'记忆内容'.repeat(80)}`,
      new Date(now - i * 1000).toISOString(),
    );
  }
  insert.run('tail-memory', '最后一条也必须进入 AI 整理 prompt。', '2026-06-03T00:00:00.000Z');
  return db;
}

function createBoundedReviewDb() {
  const db = createEmptyReviewDb();
  const insert = db.prepare(`
    INSERT INTO memories (
      id, character_id, category, content, tags, importance, emotional_weight, memory_kind, status, updated_at
    ) VALUES (?, 'char-a', '四季日常', ?, '[]', ?, 0, 'general', 'active', ?)
  `);
  for (let i = 0; i < 650; i += 1) {
    insert.run(
      `mem-${String(i).padStart(3, '0')}`,
      i < 500 ? `候选上限内记忆 ${i}` : `不应进入审核 prompt 的尾部记忆 ${i}`,
      i < 500 ? 0.9 : 0.1,
      i < 500
        ? `2026-06-04T00:${String(i % 60).padStart(2, '0')}:00.000Z`
        : `2026-06-01T00:${String(i % 60).padStart(2, '0')}:00.000Z`,
    );
  }
  return db;
}

test('/api/memory-review requeues and starts indexing after changing embedding-relevant memory fields', async () => {
  const db = createReviewDb();
  const enqueueCalls = [];
  let triggerCalls = 0;

  const route = requireFreshWithMocks('../src/app/api/memory-review/route.ts', {
    'next/server': jsonResponseMock(),
    '@/lib/db': { getDb: () => db },
    '@/lib/settings': {
      loadSettings: () => ({ api_base: 'https://llm.example/v1', api_key: 'secret', model: 'chat', max_tokens: 100 }),
      resolveBackgroundConfig: () => ({ api_base: 'https://llm.example/v1', api_key: 'secret', model: 'bg-model' }),
      buildBackgroundChatExtraBody: () => undefined,
      mergeSettingsForBackgroundLlm: (base, bg, patch = {}) => ({
        ...base,
        ...patch,
        api_base: bg.api_base,
        api_key: bg.api_key,
        model: bg.model,
        reasoning_effort: 'default',
      }),
    },
    '@/lib/api-client': {
      REASONING_SAFE_MAX_TOKENS: 4096,
      chatCompletion: async () => JSON.stringify({
        corrections: [{
          id: 'mem-a',
          category: '四季日常',
          tags: ['午餐'],
          importance: 0.4,
        }],
      }),
    },
    '@/lib/memory-embeddings': {
      enqueueMemoryEmbeddingTask: (memoryId, characterId, reason) => {
        enqueueCalls.push({ memoryId, characterId, reason });
        return true;
      },
    },
    '@/lib/memory-index-trigger': {
      triggerMemoryIndexProcessing: () => {
        triggerCalls += 1;
        return true;
      },
    },
  });

  const response = await route.POST(jsonRequest({ character_id: 'char-a' }));
  const payload = await response.json();
  const row = db.prepare('SELECT category, tags, importance FROM memories WHERE id = ?').get('mem-a');

  assert.equal(response.status, 200);
  assert.equal(payload.ok, true);
  assert.equal(payload.corrected, 1);
  assert.deepEqual(payload.changes, [{
    id: 'mem-a',
    fields: ['category→四季日常', 'tags→[午餐]', 'importance→0.4'],
    content: '2026年6月4日，用户午饭吃了面。',
  }]);
  assert.deepEqual(row, {
    category: '四季日常',
    tags: JSON.stringify(['午餐']),
    importance: 0.4,
  });
  assert.deepEqual(enqueueCalls, [{ memoryId: 'mem-a', characterId: 'char-a', reason: 'updated' }]);
  assert.equal(triggerCalls, 1);
});

test('/api/memory-review extracts one balanced object from prose with escaped delimiters and multiple JSON blocks', async () => {
  const db = createReviewDb();

  const route = requireFreshWithMocks('../src/app/api/memory-review/route.ts', {
    'next/server': jsonResponseMock(),
    '@/lib/db': { getDb: () => db },
    '@/lib/settings': {
      loadSettings: () => ({ api_base: 'https://llm.example/v1', api_key: 'secret', model: 'chat', max_tokens: 100 }),
      resolveBackgroundConfig: () => ({ api_base: 'https://llm.example/v1', api_key: 'secret', model: 'bg-model' }),
      buildBackgroundChatExtraBody: () => undefined,
      mergeSettingsForBackgroundLlm: (base, bg, patch = {}) => ({
        ...base,
        ...patch,
        api_base: bg.api_base,
        api_key: bg.api_key,
        model: bg.model,
        reasoning_effort: 'default',
      }),
    },
    '@/lib/api-client': {
      REASONING_SAFE_MAX_TOKENS: 4096,
      chatCompletion: async () => [
        '审核结果如下：',
        JSON.stringify({
          note: '字符串里的 } ] 和 "引号" 以及 C:\\tmp\\review 不影响边界',
          corrections: [{
            id: 'mem-a',
            category: '四季日常',
            tags: ['午餐'],
            importance: 0.4,
          }],
        }),
        '后续诊断块不属于 corrections：',
        JSON.stringify({ ignored: true, corrections: [{ id: 'not-in-page', importance: 0.1 }] }),
      ].join('\n'),
    },
    '@/lib/memory-embeddings': {
      enqueueMemoryEmbeddingTask: () => false,
    },
    '@/lib/memory-index-trigger': {
      triggerMemoryIndexProcessing: () => false,
    },
  });

  const response = await route.POST(jsonRequest({ character_id: 'char-a' }));
  const payload = await response.json();
  const row = db.prepare('SELECT category, tags, importance FROM memories WHERE id = ?').get('mem-a');

  assert.equal(response.status, 200);
  assert.equal(payload.corrected, 1);
  assert.deepEqual(row, {
    category: '四季日常',
    tags: JSON.stringify(['午餐']),
    importance: 0.4,
  });
});

test('/api/memory-review skips corrections when memories are no longer active after AI returns', async () => {
  const db = createEmptyReviewDb();
  insertReviewMemory(db, { id: 'mem-archived', content: '归档竞态记忆', status: 'active' });
  insertReviewMemory(db, { id: 'mem-summarized', content: '摘要竞态记忆', status: 'active' });
  insertReviewMemory(db, { id: 'mem-deleted', content: '删除竞态记忆', status: 'active' });
  const enqueueCalls = [];
  let triggerCalls = 0;

  const route = requireFreshWithMocks('../src/app/api/memory-review/route.ts', {
    'next/server': jsonResponseMock(),
    '@/lib/db': { getDb: () => db },
    '@/lib/settings': {
      loadSettings: () => ({ api_base: 'https://llm.example/v1', api_key: 'secret', model: 'chat', max_tokens: 100 }),
      resolveBackgroundConfig: () => ({ api_base: 'https://llm.example/v1', api_key: 'secret', model: 'bg-model' }),
      buildBackgroundChatExtraBody: () => undefined,
      mergeSettingsForBackgroundLlm: (base, bg, patch = {}) => ({
        ...base,
        ...patch,
        api_base: bg.api_base,
        api_key: bg.api_key,
        model: bg.model,
        reasoning_effort: 'default',
      }),
    },
    '@/lib/api-client': {
      REASONING_SAFE_MAX_TOKENS: 4096,
      chatCompletion: async () => {
        db.prepare("UPDATE memories SET status = 'archived' WHERE id = 'mem-archived'").run();
        db.prepare("UPDATE memories SET status = 'summarized' WHERE id = 'mem-summarized'").run();
        db.prepare("UPDATE memories SET status = 'deleted' WHERE id = 'mem-deleted'").run();
        return JSON.stringify({
          corrections: [
            { id: 'mem-archived', category: '四季日常', tags: ['归档后不应修改'], importance: 0.1 },
            { id: 'mem-summarized', category: '四季日常', tags: ['摘要后不应修改'], importance: 0.2 },
            { id: 'mem-deleted', category: '四季日常', tags: ['删除后不应修改'], importance: 0.3 },
          ],
        });
      },
    },
    '@/lib/memory-embeddings': {
      enqueueMemoryEmbeddingTask: (memoryId, characterId, reason) => {
        enqueueCalls.push({ memoryId, characterId, reason });
        return true;
      },
    },
    '@/lib/memory-index-trigger': {
      triggerMemoryIndexProcessing: () => {
        triggerCalls += 1;
        return true;
      },
    },
  });

  const response = await route.POST(jsonRequest({ character_id: 'char-a' }));
  const payload = await response.json();
  const rows = db.prepare(`
    SELECT id, category, tags, importance, status, updated_at
    FROM memories
    ORDER BY id
  `).all();

  assert.equal(response.status, 200);
  assert.equal(payload.corrected, 0);
  assert.deepEqual(payload.changes, []);
  assert.deepEqual(enqueueCalls, []);
  assert.equal(triggerCalls, 0);
  assert.deepEqual(rows, [
    {
      id: 'mem-archived',
      category: '重要事件',
      tags: '[]',
      importance: 0.9,
      status: 'archived',
      updated_at: '2026-06-04T00:00:00.000Z',
    },
    {
      id: 'mem-deleted',
      category: '重要事件',
      tags: '[]',
      importance: 0.9,
      status: 'deleted',
      updated_at: '2026-06-04T00:00:00.000Z',
    },
    {
      id: 'mem-summarized',
      category: '重要事件',
      tags: '[]',
      importance: 0.9,
      status: 'summarized',
      updated_at: '2026-06-04T00:00:00.000Z',
    },
  ]);
});

test('/api/memory-review ignores no-op corrections without refreshing updated_at or indexing', async () => {
  const db = createEmptyReviewDb();
  insertReviewMemory(db, {
    category: '四季日常',
    tags: ['午餐'],
    importance: 0.4,
    updated_at: '2026-06-04T01:02:03.000Z',
  });
  const enqueueCalls = [];
  let triggerCalls = 0;

  const route = requireFreshWithMocks('../src/app/api/memory-review/route.ts', {
    'next/server': jsonResponseMock(),
    '@/lib/db': { getDb: () => db },
    '@/lib/settings': {
      loadSettings: () => ({ api_base: 'https://llm.example/v1', api_key: 'secret', model: 'chat', max_tokens: 100 }),
      resolveBackgroundConfig: () => ({ api_base: 'https://llm.example/v1', api_key: 'secret', model: 'bg-model' }),
      buildBackgroundChatExtraBody: () => undefined,
      mergeSettingsForBackgroundLlm: (base, bg, patch = {}) => ({
        ...base,
        ...patch,
        api_base: bg.api_base,
        api_key: bg.api_key,
        model: bg.model,
        reasoning_effort: 'default',
      }),
    },
    '@/lib/api-client': {
      REASONING_SAFE_MAX_TOKENS: 4096,
      chatCompletion: async () => JSON.stringify({
        corrections: [{
          id: 'mem-a',
          category: '四季日常',
          tags: ['午餐'],
          importance: 0.4,
        }],
      }),
    },
    '@/lib/memory-embeddings': {
      enqueueMemoryEmbeddingTask: (memoryId, characterId, reason) => {
        enqueueCalls.push({ memoryId, characterId, reason });
        return true;
      },
    },
    '@/lib/memory-index-trigger': {
      triggerMemoryIndexProcessing: () => {
        triggerCalls += 1;
        return true;
      },
    },
  });

  const response = await route.POST(jsonRequest({ character_id: 'char-a' }));
  const payload = await response.json();
  const row = db.prepare('SELECT category, tags, importance, updated_at FROM memories WHERE id = ?').get('mem-a');

  assert.equal(response.status, 200);
  assert.equal(payload.corrected, 0);
  assert.deepEqual(payload.changes, []);
  assert.deepEqual(row, {
    category: '四季日常',
    tags: JSON.stringify(['午餐']),
    importance: 0.4,
    updated_at: '2026-06-04T01:02:03.000Z',
  });
  assert.deepEqual(enqueueCalls, []);
  assert.equal(triggerCalls, 0);
});

test('/api/memory-review treats tags empty array as an explicit tag clear', async () => {
  const db = createEmptyReviewDb();
  insertReviewMemory(db, {
    tags: ['午餐', '面条'],
    updated_at: '2026-06-04T01:02:03.000Z',
  });
  const enqueueCalls = [];

  const route = requireFreshWithMocks('../src/app/api/memory-review/route.ts', {
    'next/server': jsonResponseMock(),
    '@/lib/db': { getDb: () => db },
    '@/lib/settings': {
      loadSettings: () => ({ api_base: 'https://llm.example/v1', api_key: 'secret', model: 'chat', max_tokens: 100 }),
      resolveBackgroundConfig: () => ({ api_base: 'https://llm.example/v1', api_key: 'secret', model: 'bg-model' }),
      buildBackgroundChatExtraBody: () => undefined,
      mergeSettingsForBackgroundLlm: (base, bg, patch = {}) => ({
        ...base,
        ...patch,
        api_base: bg.api_base,
        api_key: bg.api_key,
        model: bg.model,
        reasoning_effort: 'default',
      }),
    },
    '@/lib/api-client': {
      REASONING_SAFE_MAX_TOKENS: 4096,
      chatCompletion: async () => JSON.stringify({
        corrections: [{
          id: 'mem-a',
          tags: [],
        }],
      }),
    },
    '@/lib/memory-embeddings': {
      enqueueMemoryEmbeddingTask: (memoryId, characterId, reason) => {
        enqueueCalls.push({ memoryId, characterId, reason });
        return true;
      },
    },
    '@/lib/memory-index-trigger': {
      triggerMemoryIndexProcessing: () => true,
    },
  });

  const response = await route.POST(jsonRequest({ character_id: 'char-a' }));
  const payload = await response.json();
  const row = db.prepare('SELECT tags, updated_at FROM memories WHERE id = ?').get('mem-a');

  assert.equal(response.status, 200);
  assert.equal(payload.corrected, 1);
  assert.deepEqual(payload.changes, [{
    id: 'mem-a',
    fields: ['tags→[]'],
    content: '2026年6月4日，用户午饭吃了面。',
  }]);
  assert.deepEqual(JSON.parse(row.tags), []);
  assert.notEqual(row.updated_at, '2026-06-04T01:02:03.000Z');
  assert.deepEqual(enqueueCalls, [{ memoryId: 'mem-a', characterId: 'char-a', reason: 'updated' }]);
});

test('/api/memory-review prompt asks AI to normalize similar tags on current memories', async () => {
  const db = createReviewDb();
  let capturedPrompt = '';

  const route = requireFreshWithMocks('../src/app/api/memory-review/route.ts', {
    'next/server': jsonResponseMock(),
    '@/lib/db': { getDb: () => db },
    '@/lib/settings': {
      loadSettings: () => ({ api_base: 'https://llm.example/v1', api_key: 'secret', model: 'chat', max_tokens: 100 }),
      resolveBackgroundConfig: () => ({ api_base: 'https://llm.example/v1', api_key: 'secret', model: 'bg-model' }),
      buildBackgroundChatExtraBody: () => undefined,
      mergeSettingsForBackgroundLlm: (base, bg, patch = {}) => ({
        ...base,
        ...patch,
        api_base: bg.api_base,
        api_key: bg.api_key,
        model: bg.model,
        reasoning_effort: 'default',
      }),
    },
    '@/lib/api-client': {
      REASONING_SAFE_MAX_TOKENS: 4096,
      chatCompletion: async (_settings, messages) => {
        capturedPrompt = messages[0].content;
        return JSON.stringify({ corrections: [] });
      },
    },
    '@/lib/memory-embeddings': {
      enqueueMemoryEmbeddingTask: () => false,
    },
    '@/lib/memory-index-trigger': {
      triggerMemoryIndexProcessing: () => false,
    },
  });

  const response = await route.POST(jsonRequest({ character_id: 'char-a' }));
  await response.json();

  assert.equal(response.status, 200);
  assert.match(capturedPrompt, /整理当前条目的已有标签/);
  assert.match(capturedPrompt, /统一意思相近的标签/);
  assert.match(capturedPrompt, /午饭[、/／]午餐/);
  assert.match(capturedPrompt, /最终 tags 应该是统一后的完整标签数组/);
});

test('/api/memory-review reviews every active memory in one count-based AI batch', async () => {
  const capturedPrompts = [];
  const capturedMaxTokens = [];

  const route = requireFreshWithMocks('../src/app/api/memory-review/route.ts', {
    'next/server': jsonResponseMock(),
    '@/lib/db': { getDb: () => createLargeReviewDb() },
    '@/lib/settings': {
      loadSettings: () => ({ api_base: 'https://llm.example/v1', api_key: 'secret', model: 'chat', max_tokens: 64000 }),
      resolveBackgroundConfig: () => ({ api_base: 'https://llm.example/v1', api_key: 'secret', model: 'bg-model' }),
      buildBackgroundChatExtraBody: () => undefined,
      mergeSettingsForBackgroundLlm: (base, bg, patch = {}) => ({
        ...base,
        ...patch,
        api_base: bg.api_base,
        api_key: bg.api_key,
        model: bg.model,
        reasoning_effort: 'default',
      }),
    },
    '@/lib/api-client': {
      REASONING_SAFE_MAX_TOKENS: 16384,
      chatCompletion: async (settings, messages) => {
        capturedPrompts.push(messages[0].content);
        capturedMaxTokens.push(settings.max_tokens);
        return JSON.stringify({ corrections: [] });
      },
    },
    '@/lib/memory-embeddings': {
      enqueueMemoryEmbeddingTask: () => false,
      loadReadyMemoryEmbeddings: () => [],
      blobToEmbedding: () => new Float32Array(0),
    },
    '@/lib/memory-index-trigger': {
      triggerMemoryIndexProcessing: () => false,
    },
  });

  const response = await route.POST(jsonRequest({ character_id: 'char-a' }));
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.equal(payload.reviewed, 81);
  // 默认每批 500 条：81 条应一次 LLM 调用装完，不再按字符切成几十批
  assert.equal(capturedPrompts.length, 1);
  assert.equal(payload.batch_count, 1);
  assert.deepEqual([...new Set(capturedMaxTokens)], [16384]);

  const combinedPrompt = capturedPrompts.join('\n');
  assert.match(combinedPrompt, /ID:mem-00/);
  assert.match(combinedPrompt, /ID:tail-memory/);
  assert.match(combinedPrompt, /最后一条也必须进入 AI 整理 prompt/);
});

test('/api/memory-review runs multi-batch AI review with concurrency of three', async () => {
  let activeCalls = 0;
  let maxActiveCalls = 0;
  let startedCalls = 0;

  const route = requireFreshWithMocks('../src/app/api/memory-review/route.ts', {
    'next/server': jsonResponseMock(),
    '@/lib/db': { getDb: () => createLargeReviewDb() },
    '@/lib/memory-review-cluster': mockClusterChunkBy(20),
    '@/lib/settings': {
      loadSettings: () => ({ api_base: 'https://llm.example/v1', api_key: 'secret', model: 'chat', max_tokens: 64000 }),
      resolveBackgroundConfig: () => ({ api_base: 'https://llm.example/v1', api_key: 'secret', model: 'bg-model' }),
      buildBackgroundChatExtraBody: () => undefined,
      mergeSettingsForBackgroundLlm: (base, bg, patch = {}) => ({
        ...base,
        ...patch,
        api_base: bg.api_base,
        api_key: bg.api_key,
        model: bg.model,
        reasoning_effort: 'default',
      }),
    },
    '@/lib/api-client': {
      REASONING_SAFE_MAX_TOKENS: 16384,
      chatCompletion: async () => {
        activeCalls += 1;
        startedCalls += 1;
        maxActiveCalls = Math.max(maxActiveCalls, activeCalls);
        await new Promise(resolve => setTimeout(resolve, 25));
        activeCalls -= 1;
        return JSON.stringify({ corrections: [] });
      },
    },
    '@/lib/memory-embeddings': {
      enqueueMemoryEmbeddingTask: () => false,
      loadReadyMemoryEmbeddings: () => [],
      blobToEmbedding: () => new Float32Array(0),
    },
    '@/lib/memory-index-trigger': {
      triggerMemoryIndexProcessing: () => false,
    },
  });

  const response = await route.POST(jsonRequest({ character_id: 'char-a' }));
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.equal(payload.reviewed, 81);
  // 81 / 20 → 5 批；并发上限 3
  assert.equal(startedCalls, 5);
  assert.equal(maxActiveCalls, 3);
});

test('/api/memory-review reads a bounded active-memory candidate set from the DB', async () => {
  const capturedPrompts = [];

  const route = requireFreshWithMocks('../src/app/api/memory-review/route.ts', {
    'next/server': jsonResponseMock(),
    '@/lib/db': { getDb: () => createBoundedReviewDb() },
    '@/lib/settings': {
      loadSettings: () => ({ api_base: 'https://llm.example/v1', api_key: 'secret', model: 'chat', max_tokens: 64000 }),
      resolveBackgroundConfig: () => ({ api_base: 'https://llm.example/v1', api_key: 'secret', model: 'bg-model' }),
      buildBackgroundChatExtraBody: () => undefined,
      mergeSettingsForBackgroundLlm: (base, bg, patch = {}) => ({
        ...base,
        ...patch,
        api_base: bg.api_base,
        api_key: bg.api_key,
        model: bg.model,
        reasoning_effort: 'default',
      }),
    },
    '@/lib/api-client': {
      REASONING_SAFE_MAX_TOKENS: 16384,
      chatCompletion: async (_settings, messages) => {
        capturedPrompts.push(messages[0].content);
        return JSON.stringify({ corrections: [] });
      },
    },
    '@/lib/memory-embeddings': {
      enqueueMemoryEmbeddingTask: () => false,
      loadReadyMemoryEmbeddings: () => [],
      blobToEmbedding: () => new Float32Array(0),
    },
    '@/lib/memory-index-trigger': {
      triggerMemoryIndexProcessing: () => false,
    },
  });

  const response = await route.POST(jsonRequest({ character_id: 'char-a' }));
  const payload = await response.json();
  const combinedPrompt = capturedPrompts.join('\n');

  assert.equal(response.status, 200);
  // plan 冻结全量 650；单请求最多约 500 条（按批累加，末批可略超）
  assert.ok(payload.reviewed >= 500, `reviewed=${payload.reviewed}`);
  assert.ok(payload.reviewed < 650, `reviewed should be bounded per request, got ${payload.reviewed}`);
  assert.equal(payload.total_active, 650);
  assert.equal(payload.has_more, true);
  assert.ok(typeof payload.plan_id === 'string');
  assert.ok(typeof payload.next_batch_index === 'number');
  assert.equal(payload.reviewed_offset, 0);
  assert.match(combinedPrompt, /候选上限内记忆/);
  assert.doesNotMatch(combinedPrompt, /不应进入审核 prompt 的尾部记忆/);
});

test('/api/memory-review can continue after the first plan page via plan_id + batch_index', async () => {
  const capturedPrompts = [];
  const db = createBoundedReviewDb();

  const route = requireFreshWithMocks('../src/app/api/memory-review/route.ts', {
    'next/server': jsonResponseMock(),
    '@/lib/db': { getDb: () => db },
    '@/lib/settings': {
      loadSettings: () => ({ api_base: 'https://llm.example/v1', api_key: 'secret', model: 'chat', max_tokens: 64000 }),
      resolveBackgroundConfig: () => ({ api_base: 'https://llm.example/v1', api_key: 'secret', model: 'bg-model' }),
      buildBackgroundChatExtraBody: () => undefined,
      mergeSettingsForBackgroundLlm: (base, bg, patch = {}) => ({
        ...base,
        ...patch,
        api_base: bg.api_base,
        api_key: bg.api_key,
        model: bg.model,
        reasoning_effort: 'default',
      }),
    },
    '@/lib/api-client': {
      REASONING_SAFE_MAX_TOKENS: 16384,
      chatCompletion: async (_settings, messages) => {
        capturedPrompts.push(messages[0].content);
        return JSON.stringify({ corrections: [] });
      },
    },
    '@/lib/memory-embeddings': {
      enqueueMemoryEmbeddingTask: () => false,
      loadReadyMemoryEmbeddings: () => [],
      blobToEmbedding: () => new Float32Array(0),
    },
    '@/lib/memory-index-trigger': {
      triggerMemoryIndexProcessing: () => false,
    },
  });

  const first = await route.POST(jsonRequest({ character_id: 'char-a' }));
  const firstPayload = await first.json();
  assert.equal(first.status, 200);
  assert.ok(firstPayload.plan_id);
  assert.equal(firstPayload.has_more, true);
  assert.ok(typeof firstPayload.next_batch_index === 'number');

  // 模拟整理改写了排序字段——plan 成员仍应完整覆盖，续跑不依赖 OFFSET
  db.prepare(`UPDATE memories SET importance = 0.01, updated_at = '2099-01-01T00:00:00.000Z' WHERE character_id = 'char-a'`).run();

  capturedPrompts.length = 0;
  const response = await route.POST(jsonRequest({
    character_id: 'char-a',
    plan_id: firstPayload.plan_id,
    batch_index: firstPayload.next_batch_index,
  }));
  const payload = await response.json();
  const combinedPrompt = capturedPrompts.join('\n');
  const reviewedTotal = firstPayload.reviewed + payload.reviewed;

  assert.equal(response.status, 200);
  assert.equal(payload.total_active, 650);
  assert.equal(payload.has_more, false);
  assert.equal(payload.next_batch_index, null);
  assert.equal(reviewedTotal, 650);
  assert.ok(payload.reviewed > 0);
  // 第二页应覆盖第一页未审的尾部 id
  assert.doesNotMatch(combinedPrompt, new RegExp(`ID:${firstPayload.plan_id}`));
});

test('/api/memory-review passes DeepSeek background thinking override to AI calls', async () => {
  const seenExtraBodies = [];

  const route = requireFreshWithMocks('../src/app/api/memory-review/route.ts', {
    'next/server': jsonResponseMock(),
    '@/lib/db': { getDb: () => createReviewDb() },
    '@/lib/settings': {
      loadSettings: () => ({
        api_base: 'https://llm.example/v1',
        api_key: 'secret',
        model: 'chat',
        max_tokens: 100,
        disable_deepseek_thinking_for_background: true,
      }),
      resolveBackgroundConfig: () => ({
        api_base: 'https://llm.example/v1',
        api_key: 'secret',
        model: 'deepseek-v4-pro',
      }),
      buildBackgroundChatExtraBody: () => ({ thinking: { type: 'disabled' } }),
      mergeSettingsForBackgroundLlm: (base, bg, patch = {}) => ({
        ...base,
        ...patch,
        api_base: bg.api_base,
        api_key: bg.api_key,
        model: bg.model,
        reasoning_effort: 'default',
      }),
    },
    '@/lib/api-client': {
      REASONING_SAFE_MAX_TOKENS: 4096,
      chatCompletion: async (_settings, _messages, _signal, extraBody) => {
        seenExtraBodies.push(extraBody);
        return JSON.stringify({ corrections: [] });
      },
    },
    '@/lib/memory-embeddings': {
      enqueueMemoryEmbeddingTask: () => false,
    },
    '@/lib/memory-index-trigger': {
      triggerMemoryIndexProcessing: () => false,
    },
  });

  const response = await route.POST(jsonRequest({ character_id: 'char-a' }));

  assert.equal(response.status, 200);
  assert.deepEqual(seenExtraBodies, [{ thinking: { type: 'disabled' } }]);
});

test('/api/memory-review preserves all tags returned by AI', async () => {
  const db = createReviewDb();

  const route = requireFreshWithMocks('../src/app/api/memory-review/route.ts', {
    'next/server': jsonResponseMock(),
    '@/lib/db': { getDb: () => db },
    '@/lib/settings': {
      loadSettings: () => ({ api_base: 'https://llm.example/v1', api_key: 'secret', model: 'chat', max_tokens: 100 }),
      resolveBackgroundConfig: () => ({ api_base: 'https://llm.example/v1', api_key: 'secret', model: 'bg-model' }),
      buildBackgroundChatExtraBody: () => undefined,
      mergeSettingsForBackgroundLlm: (base, bg, patch = {}) => ({
        ...base,
        ...patch,
        api_base: bg.api_base,
        api_key: bg.api_key,
        model: bg.model,
        reasoning_effort: 'default',
      }),
    },
    '@/lib/api-client': {
      REASONING_SAFE_MAX_TOKENS: 4096,
      chatCompletion: async () => JSON.stringify({
        corrections: [{
          id: 'mem-a',
          tags: ['午餐', '面条', '饮食', '日常'],
        }],
      }),
    },
    '@/lib/memory-embeddings': {
      enqueueMemoryEmbeddingTask: () => false,
    },
    '@/lib/memory-index-trigger': {
      triggerMemoryIndexProcessing: () => false,
    },
  });

  const response = await route.POST(jsonRequest({ character_id: 'char-a' }));
  const row = db.prepare('SELECT tags FROM memories WHERE id = ?').get('mem-a');

  assert.equal(response.status, 200);
  assert.deepEqual(JSON.parse(row.tags), ['午餐', '面条', '饮食', '日常']);
});

test('/api/memory-review returns structured JSON when the AI call fails', async () => {
  const route = requireFreshWithMocks('../src/app/api/memory-review/route.ts', {
    'next/server': jsonResponseMock(),
    '@/lib/db': { getDb: () => createReviewDb() },
    '@/lib/settings': {
      loadSettings: () => ({ api_base: 'https://llm.example/v1', api_key: 'secret', model: 'chat', max_tokens: 100 }),
      resolveBackgroundConfig: () => ({ api_base: 'https://llm.example/v1', api_key: 'secret', model: 'bg-model' }),
      buildBackgroundChatExtraBody: () => undefined,
      mergeSettingsForBackgroundLlm: (base, bg, patch = {}) => ({
        ...base,
        ...patch,
        api_base: bg.api_base,
        api_key: bg.api_key,
        model: bg.model,
        reasoning_effort: 'default',
      }),
    },
    '@/lib/api-client': {
      REASONING_SAFE_MAX_TOKENS: 4096,
      chatCompletion: async () => {
        throw new Error('API error 400: bad request');
      },
    },
    '@/lib/memory-embeddings': {
      enqueueMemoryEmbeddingTask: () => false,
    },
    '@/lib/memory-index-trigger': {
      triggerMemoryIndexProcessing: () => false,
    },
  });

  const response = await route.POST(jsonRequest({ character_id: 'char-a' }));
  const payload = await response.json();

  assert.equal(response.status, 500);
  assert.equal(payload.ok, false);
  assert.match(payload.error, /AI 调用失败（第 1\/1 批）: API error 400: bad request/);
});

test('/api/memory-review isolates a failed batch and still applies successful corrections', async () => {
  const db = createLargeReviewDb();
  let callCount = 0;

  const route = requireFreshWithMocks('../src/app/api/memory-review/route.ts', {
    'next/server': jsonResponseMock(),
    '@/lib/db': { getDb: () => db },
    '@/lib/memory-review-cluster': mockClusterChunkBy(20),
    '@/lib/settings': {
      loadSettings: () => ({ api_base: 'https://llm.example/v1', api_key: 'secret', model: 'chat', max_tokens: 64000 }),
      resolveBackgroundConfig: () => ({ api_base: 'https://llm.example/v1', api_key: 'secret', model: 'bg-model' }),
      buildBackgroundChatExtraBody: () => undefined,
      mergeSettingsForBackgroundLlm: (base, bg, patch = {}) => ({
        ...base,
        ...patch,
        api_base: bg.api_base,
        api_key: bg.api_key,
        model: bg.model,
        reasoning_effort: 'default',
      }),
    },
    '@/lib/api-client': {
      REASONING_SAFE_MAX_TOKENS: 16384,
      chatCompletion: async () => {
        callCount += 1;
        // 恰好让一批失败，其余批次正常返回对同一条记忆的修正。
        if (callCount === 1) throw new Error('API error 500: upstream down');
        return JSON.stringify({ corrections: [{ id: 'tail-memory', tags: ['回忆'] }] });
      },
    },
    '@/lib/memory-embeddings': {
      enqueueMemoryEmbeddingTask: () => true,
      loadReadyMemoryEmbeddings: () => [],
      blobToEmbedding: () => new Float32Array(0),
    },
    '@/lib/memory-index-trigger': {
      triggerMemoryIndexProcessing: () => true,
    },
  });

  const response = await route.POST(jsonRequest({ character_id: 'char-a' }));
  const payload = await response.json();
  const row = db.prepare('SELECT tags FROM memories WHERE id = ?').get('tail-memory');

  assert.equal(response.status, 200);
  assert.equal(payload.ok, true);
  assert.equal(payload.reviewed, 81);
  assert.equal(payload.failed_batches, 1);
  assert.equal(payload.failed_messages.length, 1);
  assert.match(payload.failed_messages[0], /API error 500: upstream down/);
  assert.equal(payload.corrected, 1);
  assert.deepEqual(JSON.parse(row.tags), ['回忆']);
});

test('/api/memory-review returns 500 only when every batch fails', async () => {
  const route = requireFreshWithMocks('../src/app/api/memory-review/route.ts', {
    'next/server': jsonResponseMock(),
    '@/lib/db': { getDb: () => createLargeReviewDb() },
    '@/lib/memory-review-cluster': mockClusterChunkBy(20),
    '@/lib/settings': {
      loadSettings: () => ({ api_base: 'https://llm.example/v1', api_key: 'secret', model: 'chat', max_tokens: 64000 }),
      resolveBackgroundConfig: () => ({ api_base: 'https://llm.example/v1', api_key: 'secret', model: 'bg-model' }),
      buildBackgroundChatExtraBody: () => undefined,
      mergeSettingsForBackgroundLlm: (base, bg, patch = {}) => ({
        ...base,
        ...patch,
        api_base: bg.api_base,
        api_key: bg.api_key,
        model: bg.model,
        reasoning_effort: 'default',
      }),
    },
    '@/lib/api-client': {
      REASONING_SAFE_MAX_TOKENS: 16384,
      chatCompletion: async () => {
        throw new Error('API error 429: rate limited');
      },
    },
    '@/lib/memory-embeddings': {
      enqueueMemoryEmbeddingTask: () => false,
      loadReadyMemoryEmbeddings: () => [],
      blobToEmbedding: () => new Float32Array(0),
    },
    '@/lib/memory-index-trigger': { triggerMemoryIndexProcessing: () => false },
  });

  const response = await route.POST(jsonRequest({ character_id: 'char-a' }));
  const payload = await response.json();

  assert.equal(response.status, 500);
  assert.equal(payload.ok, false);
  assert.ok(payload.failed_batches > 1, 'fixture should produce more than one failing batch');
  assert.match(payload.error, /API error 429: rate limited/);
});

test('/api/memory-review normalizes alias tags to canonical tags', async () => {
  const db = createReviewDb();

  const route = requireFreshWithMocks('../src/app/api/memory-review/route.ts', {
    'next/server': jsonResponseMock(),
    '@/lib/db': { getDb: () => db },
    '@/lib/settings': {
      loadSettings: () => ({ api_base: 'https://llm.example/v1', api_key: 'secret', model: 'chat', max_tokens: 100 }),
      resolveBackgroundConfig: () => ({ api_base: 'https://llm.example/v1', api_key: 'secret', model: 'bg-model' }),
      buildBackgroundChatExtraBody: () => undefined,
      mergeSettingsForBackgroundLlm: (base, bg, patch = {}) => ({
        ...base,
        ...patch,
        api_base: bg.api_base,
        api_key: bg.api_key,
        model: bg.model,
        reasoning_effort: 'default',
      }),
    },
    '@/lib/api-client': {
      REASONING_SAFE_MAX_TOKENS: 4096,
      chatCompletion: async () => JSON.stringify({
        corrections: [{ id: 'mem-a', tags: ['午饭', '聊天', '午餐'] }],
      }),
    },
    '@/lib/memory-embeddings': { enqueueMemoryEmbeddingTask: () => false },
    '@/lib/memory-index-trigger': { triggerMemoryIndexProcessing: () => false },
  });

  const response = await route.POST(jsonRequest({ character_id: 'char-a' }));
  const row = db.prepare('SELECT tags FROM memories WHERE id = ?').get('mem-a');

  assert.equal(response.status, 200);
  // 午饭→午餐、聊天→对话，且与已有"午餐"去重保序。
  assert.deepEqual(JSON.parse(row.tags), ['午餐', '对话']);
});

test('/api/memory-review injects the shared tag spec table into the prompt', async () => {
  let capturedPrompt = '';

  const route = requireFreshWithMocks('../src/app/api/memory-review/route.ts', {
    'next/server': jsonResponseMock(),
    '@/lib/db': { getDb: () => createReviewDb() },
    '@/lib/settings': {
      loadSettings: () => ({ api_base: 'https://llm.example/v1', api_key: 'secret', model: 'chat', max_tokens: 100 }),
      resolveBackgroundConfig: () => ({ api_base: 'https://llm.example/v1', api_key: 'secret', model: 'bg-model' }),
      buildBackgroundChatExtraBody: () => undefined,
      mergeSettingsForBackgroundLlm: (base, bg, patch = {}) => ({
        ...base,
        ...patch,
        api_base: bg.api_base,
        api_key: bg.api_key,
        model: bg.model,
        reasoning_effort: 'default',
      }),
    },
    '@/lib/api-client': {
      REASONING_SAFE_MAX_TOKENS: 4096,
      chatCompletion: async (_settings, messages) => {
        capturedPrompt = messages[0].content;
        return JSON.stringify({ corrections: [] });
      },
    },
    '@/lib/memory-embeddings': { enqueueMemoryEmbeddingTask: () => false },
    '@/lib/memory-index-trigger': { triggerMemoryIndexProcessing: () => false },
  });

  const response = await route.POST(jsonRequest({ character_id: 'char-a' }));
  await response.json();

  assert.equal(response.status, 200);
  assert.match(capturedPrompt, /标签规范表/);
  assert.match(capturedPrompt, /近义写法统一示例/);
});

test('/api/memory-review rejects non-object JSON bodies', async () => {
  const route = requireFreshWithMocks('../src/app/api/memory-review/route.ts', {
    'next/server': jsonResponseMock(),
  });

  const response = await route.POST(jsonRequest(null));
  const payload = await response.json();

  assert.equal(response.status, 400);
  assert.equal(payload.error, 'Body must be a JSON object');
});

test('/api/memory-review returns zero correction counts when there are no active memories', async () => {
  const route = requireFreshWithMocks('../src/app/api/memory-review/route.ts', {
    'next/server': jsonResponseMock(),
    '@/lib/db': { getDb: () => createEmptyReviewDb() },
  });

  const response = await route.POST(jsonRequest({ character_id: 'char-a' }));
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.equal(payload.ok, true);
  assert.equal(payload.reviewed, 0);
  assert.equal(payload.total_active, 0);
  assert.equal(payload.skipped_due_to_limit, 0);
  assert.equal(payload.reviewed_offset, 0);
  assert.equal(payload.has_more, false);
  assert.equal(payload.next_offset, null);
  assert.equal(payload.corrected, 0);
  assert.equal(payload.failed_batches, 0);
  assert.deepEqual(payload.failed_messages, []);
  assert.deepEqual(payload.changes, []);
  assert.deepEqual(payload.merge_suggestions, []);
  assert.ok(typeof payload.plan_id === 'string');
  assert.equal(payload.indexing_queued, 0);
  assert.equal(payload.indexing_started, false);
});

test('/api/memory-review uses one combined deadline signal for every concurrent batch', async () => {
  const controller = new AbortController();
  const combinedController = new AbortController();
  let deadlineCalls = 0;
  const seenSignals = [];

  class TestBackgroundLlmTimeoutError extends Error {}

  const route = requireFreshWithMocks('../src/app/api/memory-review/route.ts', {
    'next/server': jsonResponseMock(),
    '@/lib/db': { getDb: () => createLargeReviewDb() },
    '@/lib/memory-review-cluster': mockClusterChunkBy(20),
    '@/lib/settings': {
      loadSettings: () => ({
        api_base: 'https://llm.example/v1',
        api_key: 'secret',
        model: 'chat',
        max_tokens: 64000,
        memory_background_timeout_ms: 5_000,
      }),
      resolveBackgroundConfig: () => ({ api_base: 'https://llm.example/v1', api_key: 'secret', model: 'bg-model' }),
      buildBackgroundChatExtraBody: () => undefined,
      mergeSettingsForBackgroundLlm: (base, bg, patch = {}) => ({
        ...base,
        ...patch,
        api_base: bg.api_base,
        api_key: bg.api_key,
        model: bg.model,
        reasoning_effort: 'default',
      }),
    },
    '@/lib/background-llm-deadline': {
      BackgroundLlmTimeoutError: TestBackgroundLlmTimeoutError,
      runWithBackgroundLlmDeadline: async (timeoutMs, work, externalSignal) => {
        deadlineCalls += 1;
        assert.equal(timeoutMs, 5_000);
        assert.equal(externalSignal, controller.signal);
        return work(combinedController.signal);
      },
    },
    '@/lib/api-client': {
      REASONING_SAFE_MAX_TOKENS: 16384,
      chatCompletion: async (_settings, _messages, signal) => {
        seenSignals.push(signal);
        return JSON.stringify({ corrections: [] });
      },
    },
    '@/lib/memory-embeddings': {
      enqueueMemoryEmbeddingTask: () => false,
      loadReadyMemoryEmbeddings: () => [],
      blobToEmbedding: () => new Float32Array(0),
    },
    '@/lib/memory-index-trigger': { triggerMemoryIndexProcessing: () => false },
  });

  const response = await route.POST({
    ...jsonRequest({ character_id: 'char-a' }),
    signal: controller.signal,
  });

  assert.equal(response.status, 200);
  assert.equal(deadlineCalls, 1, 'one request must own one deadline timer, not one timer per batch');
  assert.ok(seenSignals.length > 1, 'fixture must produce multiple AI review batches');
  assert.ok(seenSignals.every(signal => signal === combinedController.signal));
});

test('/api/memory-review returns structured 504 when its shared server deadline expires', async () => {
  const seenSignals = [];
  const route = requireFreshWithMocks('../src/app/api/memory-review/route.ts', {
    'next/server': jsonResponseMock(),
    '@/lib/db': { getDb: () => createLargeReviewDb() },
    '@/lib/memory-review-cluster': mockClusterChunkBy(20),
    '@/lib/settings': {
      loadSettings: () => ({
        api_base: 'https://llm.example/v1',
        api_key: 'secret',
        model: 'chat',
        max_tokens: 64000,
        memory_background_timeout_ms: 10,
      }),
      resolveBackgroundConfig: () => ({ api_base: 'https://llm.example/v1', api_key: 'secret', model: 'bg-model' }),
      buildBackgroundChatExtraBody: () => undefined,
      mergeSettingsForBackgroundLlm: (base, bg, patch = {}) => ({
        ...base,
        ...patch,
        api_base: bg.api_base,
        api_key: bg.api_key,
        model: bg.model,
        reasoning_effort: 'default',
      }),
    },
    '@/lib/api-client': {
      REASONING_SAFE_MAX_TOKENS: 16384,
      chatCompletion: async (_settings, _messages, signal) => {
        seenSignals.push(signal);
        if (signal.aborted) throw signal.reason;
        return new Promise((_, reject) => {
          const fallback = setTimeout(() => reject(new Error('deadline signal was not applied')), 100);
          signal.addEventListener('abort', () => {
            clearTimeout(fallback);
            reject(signal.reason);
          }, { once: true });
        });
      },
    },
    '@/lib/memory-embeddings': {
      enqueueMemoryEmbeddingTask: () => false,
      loadReadyMemoryEmbeddings: () => [],
      blobToEmbedding: () => new Float32Array(0),
    },
    '@/lib/memory-index-trigger': { triggerMemoryIndexProcessing: () => false },
  });

  const response = await route.POST({
    ...jsonRequest({ character_id: 'char-a' }),
    signal: new AbortController().signal,
  });
  const payload = await response.json();

  assert.equal(response.status, 504);
  assert.deepEqual(payload, {
    ok: false,
    error: '记忆审核请求超过服务器处理时限',
    code: 'UPSTREAM_TIMEOUT',
  });
  assert.ok(seenSignals.length >= 2, 'concurrent batches should start before the shared deadline');
  assert.equal(new Set(seenSignals).size, 1);
  assert.equal(seenSignals[0].aborted, true);
});

test('/api/memory-review preserves one client cancellation across concurrent batches', async () => {
  const controller = new AbortController();
  const seenSignals = [];
  let markStarted;
  const started = new Promise(resolve => { markStarted = resolve; });
  const route = requireFreshWithMocks('../src/app/api/memory-review/route.ts', {
    'next/server': jsonResponseMock(),
    '@/lib/db': { getDb: () => createLargeReviewDb() },
    '@/lib/settings': {
      loadSettings: () => ({
        api_base: 'https://llm.example/v1',
        api_key: 'secret',
        model: 'chat',
        max_tokens: 64000,
        memory_background_timeout_ms: 1_000,
      }),
      resolveBackgroundConfig: () => ({ api_base: 'https://llm.example/v1', api_key: 'secret', model: 'bg-model' }),
      buildBackgroundChatExtraBody: () => undefined,
      mergeSettingsForBackgroundLlm: (base, bg, patch = {}) => ({
        ...base,
        ...patch,
        api_base: bg.api_base,
        api_key: bg.api_key,
        model: bg.model,
        reasoning_effort: 'default',
      }),
    },
    '@/lib/api-client': {
      REASONING_SAFE_MAX_TOKENS: 16384,
      chatCompletion: async (_settings, _messages, signal) => {
        seenSignals.push(signal);
        if (seenSignals.length === 3) markStarted();
        if (signal.aborted) throw signal.reason;
        return new Promise((_, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        });
      },
    },
    '@/lib/memory-review-cluster': mockClusterChunkBy(20),
    '@/lib/memory-embeddings': { enqueueMemoryEmbeddingTask: () => false },
    '@/lib/memory-index-trigger': { triggerMemoryIndexProcessing: () => false },
  });

  const responsePromise = route.POST({
    ...jsonRequest({ character_id: 'char-a' }),
    signal: controller.signal,
  });
  await started;
  controller.abort(new DOMException('client disconnected', 'AbortError'));
  const response = await responsePromise;
  await new Promise(resolve => setImmediate(resolve));

  assert.equal(response.status, 499);
  assert.equal(seenSignals.length, 3, 'request cancellation must stop queued batches from starting');
  assert.equal(new Set(seenSignals).size, 1);
  assert.notEqual(seenSignals[0], controller.signal);
  assert.equal(seenSignals[0].aborted, true);
  assert.equal(seenSignals[0].reason?.message, 'client disconnected');
});

test('buildTagOverview ranks tags by frequency then name and includes counts', () => {
  const route = requireFreshWithMocks('../src/app/api/memory-review/route.ts', {
    'next/server': jsonResponseMock(),
  });

  const overview = route.buildTagOverview([
    { id: 'a', category: '偏好习惯', content: 'x', tags: JSON.stringify(['午餐', '对话']), importance: 0.5, emotional_weight: 0, memory_kind: 'general' },
    { id: 'b', category: '偏好习惯', content: 'y', tags: JSON.stringify(['午餐', '咖啡']), importance: 0.5, emotional_weight: 0, memory_kind: 'general' },
    { id: 'c', category: '偏好习惯', content: 'z', tags: JSON.stringify(['对话']), importance: 0.5, emotional_weight: 0, memory_kind: 'general' },
  ]);

  // 午餐×2、对话×2 并列后按名升序；咖啡×1 在后。JS 字符串序：午 < 对。
  assert.equal(overview, '午餐×2、对话×2、咖啡×1');
});

test('buildTagOverview returns 无 when there are no tags and truncates long overviews', () => {
  const route = requireFreshWithMocks('../src/app/api/memory-review/route.ts', {
    'next/server': jsonResponseMock(),
  });

  assert.equal(route.buildTagOverview([
    { id: 'a', category: '偏好习惯', content: 'x', tags: '[]', importance: 0.5, emotional_weight: 0, memory_kind: 'general' },
  ]), '无');

  const manyTags = Array.from({ length: 200 }, (_, i) => `标签${String(i).padStart(3, '0')}`);
  const longOverview = route.buildTagOverview([
    {
      id: 'long',
      category: '偏好习惯',
      content: 'x',
      tags: JSON.stringify(manyTags),
      importance: 0.5,
      emotional_weight: 0,
      memory_kind: 'general',
    },
  ]);
  assert.ok(longOverview.length <= 1200 + 40, `overview should be truncated, got length ${longOverview.length}`);
  assert.match(longOverview, /已截断用于本次审核/);
});

test('parseMemoryReviewPayload extracts merge_suggestions and drops invalid ones', () => {
  const route = requireFreshWithMocks('../src/app/api/memory-review/route.ts', {
    'next/server': jsonResponseMock(),
  });

  const parsed = route.parseMemoryReviewPayload(JSON.stringify({
    corrections: [{ id: 'mem-a', tags: ['午餐'] }],
    merge_suggestions: [
      {
        source_ids: ['mem-a', 'mem-b'],
        merged_content: '用户喜欢美式咖啡',
        category: '偏好习惯',
        tags: ['咖啡'],
        importance: 0.7,
        kind: 'merge',
        reason: '重复偏好',
      },
      {
        source_ids: ['mem-c', 'mem-d'],
        merged_content: '互相矛盾的时序事实',
        kind: 'conflict',
        reason: '时间冲突',
      },
      { source_ids: ['only-one'], merged_content: '缺源', kind: 'merge' },
      { source_ids: ['a', 'b'], merged_content: '  ', kind: 'merge' },
      { source_ids: ['a', 'b'], merged_content: '无 kind' },
      null,
      'skip-me',
    ],
  }));

  assert.equal(parsed.corrections.length, 1);
  assert.equal(parsed.merge_suggestions.length, 2);
  assert.deepEqual(parsed.merge_suggestions[0], {
    source_ids: ['mem-a', 'mem-b'],
    merged_content: '用户喜欢美式咖啡',
    category: '偏好习惯',
    tags: ['咖啡'],
    importance: 0.7,
    kind: 'merge',
    reason: '重复偏好',
  });
  assert.equal(parsed.merge_suggestions[1].kind, 'conflict');
});

test('/api/memory-review prompt includes merge rules and returns merge_suggestions', async () => {
  const db = createEmptyReviewDb();
  // 近重复文案，确保文本相似度聚类进同一 plan 批（merge 建议只保留同批 source_ids）
  insertReviewMemory(db, {
    id: 'mem-a',
    content: '用户喜欢美式咖啡，几乎每天都喝。',
    tags: ['咖啡'],
    category: '偏好习惯',
  });
  insertReviewMemory(db, {
    id: 'mem-b',
    content: '用户喜欢美式咖啡，几乎每天都喝一杯。',
    tags: ['饮品'],
    category: '偏好习惯',
  });
  let capturedPrompt = '';

  const route = requireFreshWithMocks('../src/app/api/memory-review/route.ts', {
    'next/server': jsonResponseMock(),
    '@/lib/db': { getDb: () => db },
    '@/lib/settings': {
      loadSettings: () => ({ api_base: 'https://llm.example/v1', api_key: 'secret', model: 'chat', max_tokens: 100 }),
      resolveBackgroundConfig: () => ({ api_base: 'https://llm.example/v1', api_key: 'secret', model: 'bg-model' }),
      buildBackgroundChatExtraBody: () => undefined,
      mergeSettingsForBackgroundLlm: (base, bg, patch = {}) => ({
        ...base,
        ...patch,
        api_base: bg.api_base,
        api_key: bg.api_key,
        model: bg.model,
        reasoning_effort: 'default',
      }),
    },
    '@/lib/api-client': {
      REASONING_SAFE_MAX_TOKENS: 4096,
      chatCompletion: async (_settings, messages) => {
        capturedPrompt = messages[0].content;
        return JSON.stringify({
          corrections: [],
          merge_suggestions: [{
            source_ids: ['mem-a', 'mem-b'],
            merged_content: '用户喜欢美式咖啡',
            category: '偏好习惯',
            tags: ['咖啡'],
            importance: 0.7,
            kind: 'merge',
            reason: '重复描述同一偏好',
          }],
        });
      },
    },
    '@/lib/memory-embeddings': {
      enqueueMemoryEmbeddingTask: () => false,
      loadReadyMemoryEmbeddings: () => [],
      blobToEmbedding: () => new Float32Array(0),
    },
    '@/lib/memory-index-trigger': {
      triggerMemoryIndexProcessing: () => false,
    },
  });

  const response = await route.POST(jsonRequest({ character_id: 'char-a' }));
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.match(capturedPrompt, /合并建议铁律/);
  assert.match(capturedPrompt, /merge_suggestions/);
  assert.match(capturedPrompt, /kind=conflict/);
  assert.match(capturedPrompt, /标签×出现次数/);
  assert.match(capturedPrompt, /咖啡×1/);
  assert.deepEqual(payload.merge_suggestions, [{
    source_ids: ['mem-a', 'mem-b'],
    merged_content: '用户喜欢美式咖啡',
    category: '偏好习惯',
    tags: ['咖啡'],
    importance: 0.7,
    kind: 'merge',
    reason: '重复描述同一偏好',
  }]);
});

test('/api/memory-review drops merge_suggestions whose source_ids are outside the reviewed batch', async () => {
  const db = createEmptyReviewDb();
  // 近重复文案保证同批；ghost-id 不在候选中应被丢弃
  insertReviewMemory(db, { id: 'mem-a', content: '用户喜欢美式咖啡，几乎每天都喝。' });
  insertReviewMemory(db, { id: 'mem-b', content: '用户喜欢美式咖啡，几乎每天都喝一杯。' });

  const route = requireFreshWithMocks('../src/app/api/memory-review/route.ts', {
    'next/server': jsonResponseMock(),
    '@/lib/db': { getDb: () => db },
    '@/lib/settings': {
      loadSettings: () => ({ api_base: 'https://llm.example/v1', api_key: 'secret', model: 'chat', max_tokens: 100 }),
      resolveBackgroundConfig: () => ({ api_base: 'https://llm.example/v1', api_key: 'secret', model: 'bg-model' }),
      buildBackgroundChatExtraBody: () => undefined,
      mergeSettingsForBackgroundLlm: (base, bg, patch = {}) => ({
        ...base,
        ...patch,
        api_base: bg.api_base,
        api_key: bg.api_key,
        model: bg.model,
        reasoning_effort: 'default',
      }),
    },
    '@/lib/api-client': {
      REASONING_SAFE_MAX_TOKENS: 4096,
      chatCompletion: async () => JSON.stringify({
        corrections: [],
        merge_suggestions: [
          {
            source_ids: ['mem-a', 'ghost-id'],
            merged_content: '幽灵源',
            kind: 'merge',
          },
          {
            source_ids: ['mem-a', 'mem-b'],
            merged_content: '合法合并',
            kind: 'merge',
          },
        ],
      }),
    },
    '@/lib/memory-embeddings': {
      enqueueMemoryEmbeddingTask: () => false,
      loadReadyMemoryEmbeddings: () => [],
      blobToEmbedding: () => new Float32Array(0),
    },
    '@/lib/memory-index-trigger': {
      triggerMemoryIndexProcessing: () => false,
    },
  });

  const response = await route.POST(jsonRequest({ character_id: 'char-a' }));
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.equal(payload.merge_suggestions.length, 1);
  assert.deepEqual(payload.merge_suggestions[0].source_ids, ['mem-a', 'mem-b']);
});

test('/api/memory-review returns PLAN_NOT_FOUND for unknown plan_id', async () => {
  const route = requireFreshWithMocks('../src/app/api/memory-review/route.ts', {
    'next/server': jsonResponseMock(),
    '@/lib/db': { getDb: () => createEmptyReviewDb() },
  });

  const response = await route.POST(jsonRequest({
    character_id: 'char-a',
    plan_id: 'does-not-exist',
    batch_index: 0,
  }));
  const payload = await response.json();

  assert.equal(response.status, 404);
  assert.equal(payload.code, 'PLAN_NOT_FOUND');
  assert.match(payload.error, /整理计划不存在|过期/);
});
