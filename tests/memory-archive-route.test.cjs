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
          body,
          async json() {
            return body;
          },
        };
      },
    },
  };
}

function jsonRequest(body, url = 'http://test.local/api/memory-archive') {
  return {
    nextUrl: new URL(url),
    async json() {
      return body;
    },
  };
}

function createArchiveRouteDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE characters (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL
    );

    CREATE TABLE memories (
      id TEXT PRIMARY KEY,
      character_id TEXT NOT NULL,
      category TEXT NOT NULL,
      content TEXT NOT NULL,
      confidence REAL NOT NULL DEFAULT 0.8,
      tags TEXT NOT NULL DEFAULT '[]',
      source_msg_ids TEXT NOT NULL DEFAULT '[]',
      memory_kind TEXT NOT NULL DEFAULT 'general',
      importance REAL NOT NULL DEFAULT 0.5,
      emotional_weight REAL NOT NULL DEFAULT 0.0,
      status TEXT NOT NULL DEFAULT 'active',
      pinned INTEGER NOT NULL DEFAULT 0,
      last_used_at TEXT,
      usage_count INTEGER NOT NULL DEFAULT 0,
      metadata TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    INSERT INTO characters (id, name) VALUES ('char-a', '测试角色');
  `);
  return db;
}

function insertMemory(db, id) {
  db.prepare(`
    INSERT INTO memories (
      id, character_id, category, content, confidence, tags, source_msg_ids,
      memory_kind, importance, emotional_weight, status, pinned, last_used_at,
      usage_count, metadata, created_at, updated_at
    )
    VALUES (?, 'char-a', '话题历史', ?, 0.8, '[]', '[]', 'general', 0.45, 0, 'active', 0, NULL, 0, '{}', ?, ?)
  `).run(id, `待归档记忆 ${id}`, '2026-06-04T00:00:00.000Z', '2026-06-04T00:00:00.000Z');
}

test('/api/memory-archive execute queues and starts indexing for the generated summary memory', async () => {
  const db = createArchiveRouteDb();
  insertMemory(db, 'mem-a');
  insertMemory(db, 'mem-b');
  let triggerCalls = 0;

  const route = requireFreshWithMocks('../src/app/api/memory-archive/route.ts', {
    'next/server': jsonResponseMock(),
    '@/lib/db': { getDb: () => db },
    '@/lib/memory-index-trigger': {
      triggerMemoryIndexProcessing: () => {
        triggerCalls += 1;
        return true;
      },
    },
  });

  const response = await route.POST(jsonRequest({
    action: 'execute',
    character_id: 'char-a',
    covered_memory_ids: ['mem-a', 'mem-b'],
    summary_content: '归档摘要内容',
    summary_memory_id: 'summary-a',
    batch_id: 'batch-a',
  }));
  const payload = await response.json();
  const task = db.prepare('SELECT memory_id, character_id, reason, status FROM memory_embedding_tasks').get();

  assert.equal(response.status, 200);
  assert.equal(payload.ok, true);
  assert.equal(payload.indexing_queued, true);
  assert.equal(payload.indexing_started, true);
  assert.deepEqual(task, {
    memory_id: 'summary-a',
    character_id: 'char-a',
    reason: 'created',
    status: 'pending',
  });
  assert.equal(triggerCalls, 1);
});

test('/api/memory-archive execute rejects overlong summary_content before writing memories', async () => {
  const db = createArchiveRouteDb();
  insertMemory(db, 'mem-overlong-a');
  insertMemory(db, 'mem-overlong-b');

  const route = requireFreshWithMocks('../src/app/api/memory-archive/route.ts', {
    'next/server': jsonResponseMock(),
    '@/lib/db': { getDb: () => db },
    '@/lib/memory-index-trigger': {
      triggerMemoryIndexProcessing: () => {
        throw new Error('indexing should not start for invalid summary content');
      },
    },
  });

  const response = await route.POST(jsonRequest({
    action: 'execute',
    character_id: 'char-a',
    covered_memory_ids: ['mem-overlong-a', 'mem-overlong-b'],
    summary_content: 'x'.repeat(8193),
    summary_memory_id: 'summary-overlong',
    batch_id: 'batch-overlong',
  }));
  const payload = await response.json();
  const summary = db.prepare("SELECT id FROM memories WHERE id = 'summary-overlong'").get();
  const sourceRows = db.prepare(`
    SELECT id, status FROM memories
    WHERE id IN ('mem-overlong-a', 'mem-overlong-b')
    ORDER BY id
  `).all();

  assert.equal(response.status, 400);
  assert.equal(payload.error, 'summary_content is too long');
  assert.equal(summary, undefined);
  assert.deepEqual(sourceRows, [
    { id: 'mem-overlong-a', status: 'active' },
    { id: 'mem-overlong-b', status: 'active' },
  ]);
});

test('/api/memory-archive ai_archive passes request signal to LLM call', async () => {
  const db = createArchiveRouteDb();
  insertMemory(db, 'mem-ai-a');
  const controller = new AbortController();
  let seenSignal = null;

  const route = requireFreshWithMocks('../src/app/api/memory-archive/route.ts', {
    'next/server': jsonResponseMock(),
    '@/lib/db': { getDb: () => db },
    '@/lib/settings': {
      loadSettings: () => ({
        api_base: 'https://llm.example/v1',
        api_key: 'llm-secret',
        model: 'chat-model',
        max_tokens: 1024,
      }),
      resolveBackgroundConfig: () => ({
        api_base: 'https://llm.example/v1',
        api_key: 'llm-secret',
        model: 'chat-model',
      }),
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
      chatCompletion: async (_settings, _messages, signal) => {
        seenSignal = signal;
        return JSON.stringify({ archive_memory_ids: [], summary: '' });
      },
    },
  });

  const request = {
    ...jsonRequest({
      action: 'ai_archive',
      character_id: 'char-a',
    }),
    signal: controller.signal,
  };
  const response = await route.POST(request);
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.equal(payload.status, 'no_archive_needed');
  assert.equal(seenSignal, controller.signal);
});

test('/api/memory-archive ai_archive deduplicates valid LLM archive IDs before execution', async () => {
  const db = createArchiveRouteDb();
  insertMemory(db, 'mem-a');
  insertMemory(db, 'mem-b');
  insertMemory(db, 'mem-c');
  const queuedEmbeddingTasks = [];
  let triggerCalls = 0;

  db.prepare("UPDATE memories SET status = 'archived' WHERE id = 'mem-c'").run();

  const route = requireFreshWithMocks('../src/app/api/memory-archive/route.ts', {
    'next/server': jsonResponseMock(),
    '@/lib/db': { getDb: () => db },
    '@/lib/settings': {
      loadSettings: () => ({
        api_base: 'https://llm.example/v1',
        api_key: 'llm-secret',
        model: 'chat-model',
        max_tokens: 1024,
      }),
      resolveBackgroundConfig: () => ({
        api_base: 'https://llm.example/v1',
        api_key: 'llm-secret',
        model: 'chat-model',
      }),
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
        archive_memory_ids: ['mem-a', 'mem-a', 'mem-c', 'mem-b', 'mem-b', 'mem-missing'],
        summary: '去重后的 AI 归档摘要',
      }),
    },
    '@/lib/memory-embeddings': {
      enqueueMemoryEmbeddingTask: (memoryId, characterId, reason) => {
        queuedEmbeddingTasks.push({ memoryId, characterId, reason });
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

  const response = await route.POST(jsonRequest({
    action: 'ai_archive',
    character_id: 'char-a',
  }));
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.equal(payload.ok, true);
  assert.equal(payload.status, 'archived');
  assert.equal(payload.archive_count, 2);
  assert.equal(payload.indexing_queued, true);
  assert.equal(payload.indexing_started, true);
  assert.deepEqual(payload.plan.summaryMemory.metadata.coveredMemoryIds, ['mem-a', 'mem-b']);
  assert.deepEqual(
    payload.plan.coveredMemoryUpdates.map(update => update.id),
    ['mem-a', 'mem-b'],
  );
  assert.deepEqual(queuedEmbeddingTasks, [{
    memoryId: payload.plan.summaryMemory.id,
    characterId: 'char-a',
    reason: 'created',
  }]);
  assert.equal(triggerCalls, 1);
});

test('/api/memory-archive ai_archive extracts one balanced object from prose with escaped delimiters and multiple JSON blocks', async () => {
  const db = createArchiveRouteDb();
  insertMemory(db, 'mem-complex');
  insertMemory(db, 'mem-ignored');
  const expectedSummary = '摘要含有 } ]、"引号" 与 C:\\tmp\\archive 路径';

  const route = requireFreshWithMocks('../src/app/api/memory-archive/route.ts', {
    'next/server': jsonResponseMock(),
    '@/lib/db': { getDb: () => db },
    '@/lib/settings': {
      loadSettings: () => ({
        api_base: 'https://llm.example/v1',
        api_key: 'llm-secret',
        model: 'chat-model',
        max_tokens: 1024,
      }),
      resolveBackgroundConfig: () => ({
        api_base: 'https://llm.example/v1',
        api_key: 'llm-secret',
        model: 'chat-model',
      }),
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
        '归档计划如下：',
        JSON.stringify({
          archive_memory_ids: ['mem-complex'],
          summary: expectedSummary,
        }),
        '以下是另一个不应合并进主对象的块：',
        JSON.stringify({ archive_memory_ids: ['mem-ignored'], summary: '错误摘要' }),
      ].join('\n'),
    },
    '@/lib/memory-embeddings': {
      enqueueMemoryEmbeddingTask: () => false,
    },
    '@/lib/memory-index-trigger': {
      triggerMemoryIndexProcessing: () => false,
    },
  });

  const response = await route.POST(jsonRequest({
    action: 'ai_archive',
    character_id: 'char-a',
  }));
  const payload = await response.json();
  const rows = db.prepare(`
    SELECT id, status
    FROM memories
    WHERE id IN ('mem-complex', 'mem-ignored')
    ORDER BY id
  `).all();

  assert.equal(response.status, 200);
  assert.equal(payload.status, 'archived');
  assert.equal(payload.summary, expectedSummary);
  assert.deepEqual(payload.plan.summaryMemory.metadata.coveredMemoryIds, ['mem-complex']);
  assert.deepEqual(rows, [
    { id: 'mem-complex', status: 'archived' },
    { id: 'mem-ignored', status: 'active' },
  ]);
});
