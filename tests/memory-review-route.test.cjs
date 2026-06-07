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
    const resolved = require.resolve(modulePath);
    delete require.cache[resolved];
    return require(modulePath);
  } finally {
    Module._load = originalLoad;
  }
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
  assert.deepEqual(row, {
    category: '四季日常',
    tags: JSON.stringify(['午餐']),
    importance: 0.4,
  });
  assert.deepEqual(enqueueCalls, [{ memoryId: 'mem-a', characterId: 'char-a', reason: 'updated' }]);
  assert.equal(triggerCalls, 1);
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
  assert.deepEqual(payload.changes, [{ id: 'mem-a', fields: ['tags→[]'] }]);
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

test('/api/memory-review reviews every active memory across bounded AI batches', async () => {
  const capturedPrompts = [];
  const capturedMaxTokens = [];

  const route = requireFreshWithMocks('../src/app/api/memory-review/route.ts', {
    'next/server': jsonResponseMock(),
    '@/lib/db': { getDb: () => createLargeReviewDb() },
    '@/lib/settings': {
      loadSettings: () => ({ api_base: 'https://llm.example/v1', api_key: 'secret', model: 'chat', max_tokens: 64000 }),
      resolveBackgroundConfig: () => ({ api_base: 'https://llm.example/v1', api_key: 'secret', model: 'bg-model' }),
      buildBackgroundChatExtraBody: () => undefined,
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
    },
    '@/lib/memory-index-trigger': {
      triggerMemoryIndexProcessing: () => false,
    },
  });

  const response = await route.POST(jsonRequest({ character_id: 'char-a' }));
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.equal(payload.reviewed, 81);
  assert.ok(capturedPrompts.length > 1, 'large reviews should be split into multiple AI calls');
  assert.ok(
    capturedPrompts.every(prompt => prompt.length <= 14000),
    `each review prompt should stay bounded, got lengths ${capturedPrompts.map(prompt => prompt.length).join(', ')}`,
  );
  assert.deepEqual([...new Set(capturedMaxTokens)], [16384]);

  const combinedPrompt = capturedPrompts.join('\n');
  assert.match(combinedPrompt, /ID:mem-00/);
  assert.match(combinedPrompt, /ID:tail-memory/);
  assert.match(combinedPrompt, /最后一条也必须进入 AI 整理 prompt/);
});

test('/api/memory-review runs large AI review batches with concurrency of three', async () => {
  let activeCalls = 0;
  let maxActiveCalls = 0;
  let startedCalls = 0;

  const route = requireFreshWithMocks('../src/app/api/memory-review/route.ts', {
    'next/server': jsonResponseMock(),
    '@/lib/db': { getDb: () => createLargeReviewDb() },
    '@/lib/settings': {
      loadSettings: () => ({ api_base: 'https://llm.example/v1', api_key: 'secret', model: 'chat', max_tokens: 64000 }),
      resolveBackgroundConfig: () => ({ api_base: 'https://llm.example/v1', api_key: 'secret', model: 'bg-model' }),
      buildBackgroundChatExtraBody: () => undefined,
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
    },
    '@/lib/memory-index-trigger': {
      triggerMemoryIndexProcessing: () => false,
    },
  });

  const response = await route.POST(jsonRequest({ character_id: 'char-a' }));
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.equal(payload.reviewed, 81);
  assert.ok(startedCalls > 3, 'fixture should create more than three AI review batches');
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
    },
    '@/lib/memory-index-trigger': {
      triggerMemoryIndexProcessing: () => false,
    },
  });

  const response = await route.POST(jsonRequest({ character_id: 'char-a' }));
  const payload = await response.json();
  const combinedPrompt = capturedPrompts.join('\n');

  assert.equal(response.status, 200);
  assert.equal(payload.reviewed, 500);
  assert.equal(payload.total_active, 650);
  assert.equal(payload.skipped_due_to_limit, 150);
  assert.equal(payload.has_more, true);
  assert.equal(payload.reviewed_offset, 0);
  assert.equal(payload.next_offset, 500);
  assert.match(combinedPrompt, /候选上限内记忆/);
  assert.doesNotMatch(combinedPrompt, /不应进入审核 prompt 的尾部记忆/);
});

test('/api/memory-review can continue after the first bounded candidate page', async () => {
  const capturedPrompts = [];

  const route = requireFreshWithMocks('../src/app/api/memory-review/route.ts', {
    'next/server': jsonResponseMock(),
    '@/lib/db': { getDb: () => createBoundedReviewDb() },
    '@/lib/settings': {
      loadSettings: () => ({ api_base: 'https://llm.example/v1', api_key: 'secret', model: 'chat', max_tokens: 64000 }),
      resolveBackgroundConfig: () => ({ api_base: 'https://llm.example/v1', api_key: 'secret', model: 'bg-model' }),
      buildBackgroundChatExtraBody: () => undefined,
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
    },
    '@/lib/memory-index-trigger': {
      triggerMemoryIndexProcessing: () => false,
    },
  });

  const response = await route.POST(jsonRequest({ character_id: 'char-a', offset: 500 }));
  const payload = await response.json();
  const combinedPrompt = capturedPrompts.join('\n');

  assert.equal(response.status, 200);
  assert.equal(payload.reviewed, 150);
  assert.equal(payload.total_active, 650);
  assert.equal(payload.skipped_due_to_limit, 0);
  assert.equal(payload.has_more, false);
  assert.equal(payload.reviewed_offset, 500);
  assert.equal(payload.next_offset, null);
  assert.doesNotMatch(combinedPrompt, /候选上限内记忆/);
  assert.match(combinedPrompt, /不应进入审核 prompt 的尾部记忆/);
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
  assert.deepEqual(payload, {
    ok: true,
    reviewed: 0,
    total_active: 0,
    skipped_due_to_limit: 0,
    reviewed_offset: 0,
    next_offset: null,
    has_more: false,
    corrected: 0,
    indexing_queued: 0,
    indexing_started: false,
    changes: [],
  });
});
