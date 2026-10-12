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

function archiveRouteWithLlm(db, chatCompletion, { settings = {}, enqueueCalls = [] } = {}) {
  return requireFreshWithMocks('../src/app/api/memory-archive/route.ts', {
    'next/server': jsonResponseMock(),
    '@/lib/db': { getDb: () => db },
    '@/lib/settings': {
      loadSettings: () => ({
        api_base: 'https://llm.example/v1',
        api_key: 'llm-secret',
        model: 'chat-model',
        max_tokens: 1024,
        ...settings,
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
      chatCompletion,
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
}

function memoryStatuses(db) {
  return Object.fromEntries(
    db.prepare('SELECT id, status FROM memories ORDER BY id').all().map(row => [row.id, row.status]),
  );
}

test('/api/memory-archive ai_archive cancels the LLM call when the request is aborted', async () => {
  const db = createArchiveRouteDb();
  insertMemory(db, 'mem-ai-a');
  const controller = new AbortController();
  let abortedDuringCall = null;

  const route = archiveRouteWithLlm(db, async (_settings, _messages, signal) => {
    controller.abort();
    abortedDuringCall = signal.aborted;
    throw signal.reason;
  });

  const response = await route.POST({
    ...jsonRequest({ action: 'ai_archive', character_id: 'char-a' }),
    signal: controller.signal,
  });

  assert.equal(abortedDuringCall, true, 'aborting the request must abort the signal handed to the LLM call');
  assert.equal(response.status, 500);
  assert.deepEqual(memoryStatuses(db), { 'mem-ai-a': 'active' });
});

test('/api/memory-archive ai_archive stops waiting once the background LLM deadline passes', async () => {
  const db = createArchiveRouteDb();
  insertMemory(db, 'mem-ai-a');

  // 模拟挂死的上游：只有 deadline 触发的 abort 才能让这次调用结束。
  const route = archiveRouteWithLlm(
    db,
    (_settings, _messages, signal) => new Promise((_, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason));
    }),
    { settings: { memory_background_timeout_ms: 5 } },
  );

  const response = await route.POST(jsonRequest({ action: 'ai_archive', character_id: 'char-a' }));
  const payload = await response.json();

  assert.equal(response.status, 504);
  assert.equal(payload.ok, false);
  assert.equal(payload.code, 'UPSTREAM_TIMEOUT');
});

test('/api/memory-archive ai_archive only proposes groups, and every proposed group can then be executed', async () => {
  const db = createArchiveRouteDb();
  for (const id of ['mem-a', 'mem-b', 'mem-c', 'mem-d', 'mem-e', 'mem-f', 'mem-g', 'mem-h', 'mem-pinned']) {
    insertMemory(db, id);
  }
  db.prepare("UPDATE memories SET status = 'archived' WHERE id = 'mem-c'").run();
  db.prepare("UPDATE memories SET pinned = 1 WHERE id = 'mem-pinned'").run();
  const enqueueCalls = [];
  let prompt = '';

  const route = archiveRouteWithLlm(db, async (_settings, messages) => {
    prompt = messages.map(message => message.content).join('\n');
    return JSON.stringify({
      groups: [
        // 重复 ID、已归档的 mem-c、不存在的 ID 都应被剔除。
        { title: ' 日常闲聊 ', memory_ids: ['mem-a', 'mem-a', 'mem-c', 'mem-b', 'mem-missing'], summary: ' 第一组摘要 ' },
        // mem-b 已被第一组占用：两组若都带着它，执行完第一组后第二组必然失败。
        { title: '重叠', memory_ids: ['mem-b', 'mem-d', 'mem-e'], summary: '第二组摘要' },
        // 去掉已占用的 mem-a 后只剩一条：没有可合并的内容，丢弃。
        { title: '只剩一条', memory_ids: ['mem-a', 'mem-f'], summary: '第三组摘要' },
        { title: '没有摘要', memory_ids: ['mem-g', 'mem-h'], summary: '   ' },
        // 钉选记忆不在送审范围内。
        { title: '含钉选', memory_ids: ['mem-pinned', 'mem-g'], summary: '第五组摘要' },
      ],
    });
  }, { enqueueCalls });

  const before = memoryStatuses(db);
  const response = await route.POST(jsonRequest({ action: 'ai_archive', character_id: 'char-a' }));
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.equal(payload.ok, true);
  assert.equal(payload.status, 'proposed');
  assert.equal(payload.candidate_count, 7);
  assert.deepEqual(payload.groups, [
    {
      title: '日常闲聊',
      summary: '第一组摘要',
      memories: [
        { id: 'mem-a', category: '话题历史', content: '待归档记忆 mem-a' },
        { id: 'mem-b', category: '话题历史', content: '待归档记忆 mem-b' },
      ],
    },
    {
      title: '重叠',
      summary: '第二组摘要',
      memories: [
        { id: 'mem-d', category: '话题历史', content: '待归档记忆 mem-d' },
        { id: 'mem-e', category: '话题历史', content: '待归档记忆 mem-e' },
      ],
    },
  ]);
  assert.deepEqual(memoryStatuses(db), before, 'proposing must not archive anything');
  assert.deepEqual(enqueueCalls, []);

  assert.match(prompt, /ID:mem-a \| 日期:2026-06-04 \|/, 'the model needs dates to judge which memories are stale');
  assert.match(prompt, /今天是 \d{4}-\d{2}-\d{2}。/);
  assert.doesNotMatch(prompt, /\{today\}|\{memories\}/);
  assert.doesNotMatch(prompt, /ID:mem-pinned|ID:mem-c /);

  for (const group of payload.groups) {
    const executed = await route.POST(jsonRequest({
      action: 'execute',
      character_id: 'char-a',
      covered_memory_ids: group.memories.map(memory => memory.id),
      summary_content: group.summary,
    }));
    assert.equal(executed.status, 200, `proposed group "${group.title}" should be executable`);
  }
  const after = memoryStatuses(db);
  for (const id of ['mem-a', 'mem-b', 'mem-d', 'mem-e']) assert.equal(after[id], 'archived');
  for (const id of ['mem-f', 'mem-g', 'mem-h', 'mem-pinned']) assert.equal(after[id], 'active');
  assert.equal(enqueueCalls.length, 2, 'each executed group indexes its own summary memory');
});

test('/api/memory-archive ai_archive reports no_archive_needed when no usable group remains', async () => {
  const db = createArchiveRouteDb();
  insertMemory(db, 'mem-a');
  insertMemory(db, 'mem-b');

  for (const llmPayload of [
    { groups: [] },
    { archive_memory_ids: [], summary: '' },
    { groups: [{ title: '全是无效 ID', memory_ids: ['mem-x', 'mem-y'], summary: '摘要' }] },
  ]) {
    const route = archiveRouteWithLlm(db, async () => JSON.stringify(llmPayload));
    const response = await route.POST(jsonRequest({ action: 'ai_archive', character_id: 'char-a' }));
    const payload = await response.json();

    assert.equal(response.status, 200);
    assert.equal(payload.status, 'no_archive_needed');
    assert.deepEqual(payload.groups, []);
  }
  assert.deepEqual(memoryStatuses(db), { 'mem-a': 'active', 'mem-b': 'active' });
});

test('/api/memory-archive ai_archive extracts one balanced object from prose with escaped delimiters and multiple JSON blocks', async () => {
  const db = createArchiveRouteDb();
  insertMemory(db, 'mem-complex-a');
  insertMemory(db, 'mem-complex-b');
  insertMemory(db, 'mem-ignored-a');
  insertMemory(db, 'mem-ignored-b');
  const expectedSummary = '摘要含有 } ]、"引号" 与 C:\\tmp\\archive 路径';

  // 旧版单组格式 { archive_memory_ids, summary } 仍被接受，按一个分组处理。
  const route = archiveRouteWithLlm(db, async () => [
    '归档计划如下：',
    JSON.stringify({
      archive_memory_ids: ['mem-complex-a', 'mem-complex-b'],
      summary: expectedSummary,
    }),
    '以下是另一个不应合并进主对象的块：',
    JSON.stringify({ archive_memory_ids: ['mem-ignored-a', 'mem-ignored-b'], summary: '错误摘要' }),
  ].join('\n'));

  const response = await route.POST(jsonRequest({
    action: 'ai_archive',
    character_id: 'char-a',
  }));
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.equal(payload.status, 'proposed');
  assert.equal(payload.groups.length, 1);
  assert.equal(payload.groups[0].title, '');
  assert.equal(payload.groups[0].summary, expectedSummary);
  assert.deepEqual(payload.groups[0].memories.map(memory => memory.id), ['mem-complex-a', 'mem-complex-b']);
});

test('/api/memory-archive execute flags covered memories that can no longer be archived', async () => {
  const db = createArchiveRouteDb();
  insertMemory(db, 'mem-a');
  insertMemory(db, 'mem-b');
  db.prepare("UPDATE memories SET status = 'superseded' WHERE id = 'mem-b'").run();
  const route = archiveRouteWithLlm(db, async () => '{}');

  const notActive = await route.POST(jsonRequest({
    action: 'execute',
    character_id: 'char-a',
    covered_memory_ids: ['mem-a', 'mem-b'],
    summary_content: '摘要',
  }));
  assert.equal(notActive.status, 400);
  assert.equal((await notActive.json()).code, 'COVERED_NOT_ARCHIVABLE');

  const missing = await route.POST(jsonRequest({
    action: 'execute',
    character_id: 'char-a',
    covered_memory_ids: ['mem-a', 'mem-deleted'],
    summary_content: '摘要',
  }));
  assert.equal(missing.status, 404);
  assert.equal((await missing.json()).code, 'COVERED_NOT_ARCHIVABLE');

  assert.deepEqual(memoryStatuses(db), { 'mem-a': 'active', 'mem-b': 'superseded' });
});
