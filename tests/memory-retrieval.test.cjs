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
      jsx: ts.JsxEmit.ReactJSX,
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
    const memoryIndexTriggerPath = path.join(root, 'src/lib/memory-index-trigger.ts');
    if (require.cache[memoryIndexTriggerPath]) {
      delete require.cache[memoryIndexTriggerPath];
    }
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

function jsonRequest(body, url = 'http://test.local/api/test') {
  const raw = JSON.stringify(body);
  return {
    nextUrl: new URL(url),
    async text() {
      return raw;
    },
    async json() {
      return body;
    },
  };
}

function deepClone(value) {
  return JSON.parse(JSON.stringify(value));
}

const {
  retrieveWorkingMemoryPackage,
} = require('../src/lib/memory-retrieval.ts');
const {
  blobToEmbedding,
  clearMemoryIndex,
  dotProduct,
  embeddingToBlob,
  enqueueRebuildMemoryEmbeddings,
  enqueueUnindexedMemoryEmbeddings,
  ensureMemoryEmbeddingTables,
  getMemoryIndexStatus,
  normalizeEmbedding,
  processMemoryEmbeddingTasks,
  rankEmbeddingRows,
  retryFailedMemoryEmbeddings,
  stopCurrentMemoryIndexTasks,
} = require('../src/lib/memory-embeddings.ts');

function baseSettings(overrides = {}) {
  return {
    memory_inject: true,
    limit_inject: true,
    memory_max_inject: 30,
    memory_engine: {
      embedding_enabled: false,
      reranker_enabled: false,
      fallback_local_enabled: true,
      memory_package_token_budget: 120,
      retrieval_token_budget: 100,
      vector_top_k: 8,
      keyword_top_k: 8,
      reranker_top_k: 8,
      final_top_k: 8,
      embedding_timeout_ms: 50,
      reranker_timeout_ms: 50,
      ...overrides.memory_engine,
    },
    ...overrides,
  };
}

function memory(overrides) {
  return {
    id: overrides.id || crypto.randomUUID().slice(0, 8),
    character_id: 'char-a',
    category: overrides.category || '话题历史',
    content: overrides.content,
    confidence: 0.9,
    tags: overrides.tags || [],
    source_msg_ids: [],
    created_at: overrides.created_at || '2026-01-01T00:00:00.000Z',
    updated_at: overrides.updated_at || '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function createMemoryDb() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE characters (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL
    );

    CREATE TABLE memories (
      id TEXT PRIMARY KEY,
      character_id TEXT NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
      category TEXT NOT NULL,
      content TEXT NOT NULL,
      confidence REAL,
      tags TEXT,
      source_msg_ids TEXT,
      memory_kind TEXT,
      importance REAL,
      emotional_weight REAL,
      status TEXT,
      pinned INTEGER,
      last_used_at TEXT,
      usage_count INTEGER,
      metadata TEXT,
      created_at TEXT,
      updated_at TEXT
    );

    CREATE TABLE memory_embedding_tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      memory_id TEXT NOT NULL,
      character_id TEXT NOT NULL,
      reason TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      retry_count INTEGER NOT NULL DEFAULT 0,
      error_message TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    INSERT INTO characters (id, name) VALUES
      ('char-a', '艾莉丝'),
      ('char-b', '莉莉');
  `);
  return db;
}

test('memory_engine 隐私开关默认开启，并可通过 /api/settings 持久化关闭', async () => {
  const settingsRows = [];
  const db = {
    prepare(sql) {
      if (sql.startsWith('SELECT key, value FROM settings')) {
        return { all: () => settingsRows };
      }
      return {
        run(key, value) {
          const existing = settingsRows.find(row => row.key === key);
          if (existing) {
            existing.value = value;
          } else {
            settingsRows.push({ key, value });
          }
        },
      };
    },
    transaction(fn) {
      return () => fn();
    },
  };

  const settingsLib = requireFreshWithMocks('../src/lib/settings.ts', {
    '@/lib/db': { getDb: () => db },
  });
  assert.equal(settingsLib.loadSettings().memory_engine.allow_memory_context_in_chat, true);
  assert.equal(settingsLib.loadSettings().memory_engine.allow_external_memory_payloads, true);

  const route = requireFreshWithMocks('../src/app/api/settings/route.ts', {
    'next/server': jsonResponseMock(),
    '@/lib/db': { getDb: () => db },
    '@/lib/settings': settingsLib,
  });

  const response = await route.PUT(jsonRequest({
    memory_engine: {
      allow_memory_context_in_chat: false,
      allow_external_memory_payloads: false,
    },
  }));
  const payload = await response.json();
  const reloaded = settingsLib.loadSettings();

  assert.equal(response.status, 200);
  assert.equal(payload.memory_engine.allow_memory_context_in_chat, false);
  assert.equal(payload.memory_engine.allow_external_memory_payloads, false);
  assert.equal(reloaded.memory_engine.allow_memory_context_in_chat, false);
  assert.equal(reloaded.memory_engine.allow_external_memory_payloads, false);
});

test('/api/settings 脱敏 memory_engine 密钥，并在收到掩码时保留旧值', async () => {
  const API_KEY_MASK = '********';
  let settingsState = {
    api_key: '',
    api_base: 'https://llm.example/v1',
    image_gen: {
      nai_api_key: '',
      custom_api_key: '',
    },
    memory_engine: {
      enabled: true,
      embedding_enabled: true,
      embedding_api_base: 'https://embedding.example/v1',
      embedding_api_key: 'embedding-secret',
      embedding_model: 'embedding-model',
      embedding_dimension: 1024,
      embedding_timeout_ms: 1500,
      reranker_enabled: true,
      reranker_api_base: 'https://reranker.example/v1',
      reranker_api_key: 'reranker-secret',
      reranker_model: 'reranker-model',
      reranker_timeout_ms: 2000,
    },
  };
  const db = {
    prepare() {
      return {
        run(key, value) {
          settingsState[key] = JSON.parse(value);
        },
      };
    },
    transaction(fn) {
      return () => fn();
    },
  };

  const route = requireFreshWithMocks('../src/app/api/settings/route.ts', {
    'next/server': jsonResponseMock(),
    '@/lib/db': { getDb: () => db },
    '@/lib/settings': { loadSettings: () => deepClone(settingsState) },
  });

  const getPayload = await route.GET().then(response => response.json());
  assert.equal(getPayload.memory_engine.embedding_api_key, API_KEY_MASK);
  assert.equal(getPayload.memory_engine.reranker_api_key, API_KEY_MASK);

  const putResponse = await route.PUT(jsonRequest({
    memory_engine: {
      ...settingsState.memory_engine,
      embedding_api_key: API_KEY_MASK,
      reranker_api_key: API_KEY_MASK,
      embedding_model: 'embedding-model-v2',
    },
  }));
  const putPayload = await putResponse.json();

  assert.equal(settingsState.memory_engine.embedding_api_key, 'embedding-secret');
  assert.equal(settingsState.memory_engine.reranker_api_key, 'reranker-secret');
  assert.equal(settingsState.memory_engine.embedding_model, 'embedding-model-v2');
  assert.equal(putPayload.memory_engine.embedding_api_key, API_KEY_MASK);
  assert.equal(putPayload.memory_engine.reranker_api_key, API_KEY_MASK);
});

test('/api/settings 切换 embedding/reranker base 且未提供新密钥时清空旧密钥', async () => {
  const API_KEY_MASK = '********';
  let settingsState = {
    api_key: '',
    api_base: 'https://llm.example/v1',
    image_gen: {
      nai_api_key: '',
      custom_api_key: '',
    },
    memory_engine: {
      enabled: true,
      embedding_enabled: true,
      embedding_api_base: 'https://embedding-old.example/v1',
      embedding_api_key: 'old-embedding-secret',
      embedding_model: 'embedding-model',
      reranker_enabled: true,
      reranker_api_base: 'https://reranker-old.example/v1',
      reranker_api_key: 'old-reranker-secret',
      reranker_model: 'reranker-model',
    },
  };
  const db = {
    prepare() {
      return {
        run(key, value) {
          settingsState[key] = JSON.parse(value);
        },
      };
    },
    transaction(fn) {
      return () => fn();
    },
  };

  const route = requireFreshWithMocks('../src/app/api/settings/route.ts', {
    'next/server': jsonResponseMock(),
    '@/lib/db': { getDb: () => db },
    '@/lib/settings': { loadSettings: () => deepClone(settingsState) },
  });

  await route.PUT(jsonRequest({
    memory_engine: {
      ...settingsState.memory_engine,
      embedding_api_base: 'https://embedding-new.example/v1',
      embedding_api_key: API_KEY_MASK,
      reranker_api_base: 'https://reranker-new.example/v1',
      reranker_api_key: API_KEY_MASK,
    },
  }));

  assert.equal(settingsState.memory_engine.embedding_api_base, 'https://embedding-new.example/v1');
  assert.equal(settingsState.memory_engine.embedding_api_key, '');
  assert.equal(settingsState.memory_engine.reranker_api_base, 'https://reranker-new.example/v1');
  assert.equal(settingsState.memory_engine.reranker_api_key, '');
});

test('/api/settings embedding/reranker base 不变且收到掩码时保留旧密钥', async () => {
  const API_KEY_MASK = '********';
  let settingsState = {
    api_key: '',
    api_base: 'https://llm.example/v1',
    image_gen: {
      nai_api_key: '',
      custom_api_key: '',
    },
    memory_engine: {
      enabled: true,
      embedding_enabled: true,
      embedding_api_base: 'https://embedding.example/v1',
      embedding_api_key: 'embedding-secret',
      embedding_model: 'embedding-model',
      reranker_enabled: true,
      reranker_api_base: 'https://reranker.example/v1',
      reranker_api_key: 'reranker-secret',
      reranker_model: 'reranker-model',
    },
  };
  const db = {
    prepare() {
      return {
        run(key, value) {
          settingsState[key] = JSON.parse(value);
        },
      };
    },
    transaction(fn) {
      return () => fn();
    },
  };

  const route = requireFreshWithMocks('../src/app/api/settings/route.ts', {
    'next/server': jsonResponseMock(),
    '@/lib/db': { getDb: () => db },
    '@/lib/settings': { loadSettings: () => deepClone(settingsState) },
  });

  await route.PUT(jsonRequest({
    memory_engine: {
      ...settingsState.memory_engine,
      embedding_api_key: API_KEY_MASK,
      reranker_api_key: API_KEY_MASK,
      embedding_model: 'embedding-model-v2',
    },
  }));

  assert.equal(settingsState.memory_engine.embedding_api_key, 'embedding-secret');
  assert.equal(settingsState.memory_engine.reranker_api_key, 'reranker-secret');
  assert.equal(settingsState.memory_engine.embedding_model, 'embedding-model-v2');
});

test('/api/settings 保存时 embedding_dimension 允许 0（使用模型默认维度），兜底为非负整数', async () => {
  let settingsState = {
    api_key: '',
    api_base: 'https://llm.example/v1',
    image_gen: { nai_api_key: '', custom_api_key: '' },
    memory_engine: {
      enabled: true,
      embedding_enabled: true,
      embedding_api_base: 'https://embedding.example/v1',
      embedding_api_key: 'embedding-secret',
      embedding_model: 'embedding-model',
      embedding_dimension: 0,
    },
  };
  const db = {
    prepare() {
      return {
        run(key, value) {
          settingsState[key] = JSON.parse(value);
        },
      };
    },
    transaction(fn) {
      return () => fn();
    },
  };

  const route = requireFreshWithMocks('../src/app/api/settings/route.ts', {
    'next/server': jsonResponseMock(),
    '@/lib/db': { getDb: () => db },
    '@/lib/settings': { loadSettings: () => deepClone(settingsState) },
  });

  // 0 = 使用模型默认维度，不发送 dimensions 参数
  await route.PUT(jsonRequest({
    memory_engine: { ...settingsState.memory_engine, embedding_dimension: 0 },
  }));
  assert.equal(settingsState.memory_engine.embedding_dimension, 0);

  // NaN 兜底为 0
  await route.PUT(jsonRequest({
    memory_engine: { ...settingsState.memory_engine, embedding_dimension: Number.NaN },
  }));
  assert.equal(settingsState.memory_engine.embedding_dimension, 0);

  // 正常值保留
  await route.PUT(jsonRequest({
    memory_engine: { ...settingsState.memory_engine, embedding_dimension: 1536.9 },
  }));
  assert.equal(settingsState.memory_engine.embedding_dimension, 1536);
});

test('/api/models 用已保存的 memory_engine 密钥获取 embedding/reranker 模型列表', async () => {
  const seenRequests = [];
  const db = {
    prepare(sql) {
      if (sql.includes('SELECT models, cached_at FROM model_cache')) {
        return { get: () => undefined };
      }
      if (sql.includes('INSERT INTO model_cache')) {
        return { run: () => {} };
      }
      throw new Error(`unexpected sql: ${sql}`);
    },
  };
  const settingsState = {
    api_base: 'https://chat.example/v1',
    api_key: 'chat-secret',
    memory_engine: {
      embedding_api_base: 'https://embedding.example/v1',
      embedding_api_key: 'embedding-secret',
      reranker_api_base: 'https://reranker.example/v1',
      reranker_api_key: 'reranker-secret',
    },
  };
  const route = requireFreshWithMocks('../src/app/api/models/route.ts', {
    'next/server': jsonResponseMock(),
    '@/lib/db': { getDb: () => db },
    '@/lib/settings': { loadSettings: () => deepClone(settingsState) },
    '@/lib/ssrf-guard': {
      safeFetch: async (url, init) => {
        seenRequests.push({ url, auth: init.headers.Authorization });
        return {
          ok: true,
          async json() {
            return { data: [{ id: 'model-a' }] };
          },
        };
      },
    },
  });

  const embeddingResponse = await route.POST(jsonRequest({
    refresh: true,
    api_base: 'https://embedding.example/v1',
    api_key: '********',
    credential_source: 'embedding',
  }));
  const rerankerResponse = await route.POST(jsonRequest({
    refresh: true,
    api_base: 'https://reranker.example/v1',
    api_key: '********',
    credential_source: 'reranker',
  }));

  assert.equal(embeddingResponse.status, 200);
  assert.equal(rerankerResponse.status, 200);
  assert.deepEqual(seenRequests, [
    { url: 'https://embedding.example/v1/models', auth: 'Bearer embedding-secret' },
    { url: 'https://reranker.example/v1/models', auth: 'Bearer reranker-secret' },
  ]);
});

test('/api/memory-diagnostics 返回记忆索引、任务、候选、画像与归档概览', async () => {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE memories (
      id TEXT PRIMARY KEY,
      character_id TEXT NOT NULL,
      status TEXT NOT NULL
    );
    CREATE TABLE memory_embeddings (
      memory_id TEXT NOT NULL,
      character_id TEXT NOT NULL,
      status TEXT NOT NULL
    );
    CREATE TABLE memory_embedding_tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      character_id TEXT NOT NULL,
      status TEXT NOT NULL
    );
    CREATE TABLE memory_extraction_candidates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      character_id TEXT NOT NULL,
      status TEXT NOT NULL
    );
    CREATE TABLE character_memory_profiles (
      character_id TEXT PRIMARY KEY,
      relationship_state TEXT NOT NULL DEFAULT '',
      recent_story_state TEXT NOT NULL DEFAULT '',
      emotional_baseline TEXT NOT NULL DEFAULT '',
      open_threads TEXT NOT NULL DEFAULT '[]',
      user_profile_summary TEXT NOT NULL DEFAULT '',
      pinned_summary TEXT NOT NULL DEFAULT '',
      updated_at TEXT NOT NULL
    );

    INSERT INTO memories (id, character_id, status) VALUES
      ('mem-a', 'char-a', 'active'),
      ('mem-b', 'char-a', 'archived'),
      ('mem-c', 'char-a', 'summarized'),
      ('mem-other', 'char-b', 'active');
    INSERT INTO memory_embeddings (memory_id, character_id, status) VALUES
      ('mem-a', 'char-a', 'ready'),
      ('mem-b', 'char-a', 'failed'),
      ('mem-other', 'char-b', 'ready');
    INSERT INTO memory_embedding_tasks (character_id, status) VALUES
      ('char-a', 'pending'),
      ('char-a', 'processing'),
      ('char-a', 'failed'),
      ('char-b', 'pending');
    INSERT INTO memory_extraction_candidates (character_id, status) VALUES
      ('char-a', 'repairable'),
      ('char-a', 'ignored'),
      ('char-b', 'repairable');
    INSERT INTO character_memory_profiles (character_id, relationship_state, updated_at)
    VALUES ('char-a', '稳定陪伴', '2026-06-02T00:00:00.000Z');
  `);

  const route = requireFreshWithMocks('../src/app/api/memory-diagnostics/route.ts', {
    'next/server': jsonResponseMock(),
    '@/lib/db': { getDb: () => db },
  });

  const payload = await route.GET(jsonRequest(null, 'http://test.local/api/memory-diagnostics?character_id=char-a'))
    .then(response => response.json());

  assert.equal(payload.ok, true);
  assert.equal(payload.character_id, 'char-a');
  assert.deepEqual(payload.index, { total: 2, ready: 1, failed: 1 });
  assert.deepEqual(payload.tasks, { pending: 1, processing: 1, failed: 1 });
  assert.deepEqual(payload.candidates, { repairable: 1, ignored: 1 });
  assert.deepEqual(payload.profile, { exists: true, filled_fields: 1 });
  assert.deepEqual(payload.archive, { archived: 1, summarized: 1 });
});

test('triggerMemoryIndexProcessing 返回 false 时可读取配置阻塞原因', () => {
  const cases = [
    {
      name: 'memory_engine disabled',
      memory_engine: {
        enabled: false,
        allow_external_memory_payloads: true,
        embedding_enabled: true,
        embedding_api_base: 'https://embedding.example/v1',
        embedding_model: 'embedding-model',
      },
      reason: 'memory_engine_disabled',
    },
    {
      name: 'external payloads disabled',
      memory_engine: {
        enabled: true,
        allow_external_memory_payloads: false,
        embedding_enabled: true,
        embedding_api_base: 'https://embedding.example/v1',
        embedding_model: 'embedding-model',
      },
      reason: 'external_memory_payloads_disabled',
    },
    {
      name: 'embedding disabled',
      memory_engine: {
        enabled: true,
        allow_external_memory_payloads: true,
        embedding_enabled: false,
        embedding_api_base: 'https://embedding.example/v1',
        embedding_model: 'embedding-model',
      },
      reason: 'embedding_disabled',
    },
    {
      name: 'embedding api base missing',
      memory_engine: {
        enabled: true,
        allow_external_memory_payloads: true,
        embedding_enabled: true,
        embedding_api_base: '   ',
        embedding_model: 'embedding-model',
      },
      reason: 'embedding_api_base_missing',
    },
    {
      name: 'embedding model missing',
      memory_engine: {
        enabled: true,
        allow_external_memory_payloads: true,
        embedding_enabled: true,
        embedding_api_base: 'https://embedding.example/v1',
        embedding_model: '   ',
      },
      reason: 'embedding_model_missing',
    },
  ];

  for (const item of cases) {
    const trigger = requireFreshWithMocks('../src/lib/memory-index-trigger.ts', {
      '@/lib/settings': {
        loadSettings: () => ({ memory_engine: item.memory_engine }),
      },
      '@/lib/memory-embeddings': {
        ensureMemoryEmbeddingTables: () => {},
        getMemoryIndexStatus: () => ({ total: 0, ready: 0, pending: 0, processing: 0, failed: 0 }),
        processMemoryEmbeddingTasks: async () => ({ processed: 0, failed: 0 }),
      },
    });

    assert.equal(trigger.triggerMemoryIndexProcessing(), false, item.name);
    assert.equal(
      typeof trigger.getMemoryIndexProcessingBlockedReason,
      'function',
      `${item.name} should expose a blocked reason helper`,
    );
    assert.equal(trigger.getMemoryIndexProcessingBlockedReason(), item.reason, item.name);
  }
});

test('/api/memory-index 入队但配置阻塞时返回 processing_blocked_reason', async () => {
  const cases = [
    {
      action: 'rebuild',
      body: {},
      url: 'http://test.local/api/memory-index?character_id=char-a',
      reason: 'external_memory_payloads_disabled',
    },
    {
      action: 'retry_failed',
      body: { action: 'retry_failed' },
      url: 'http://test.local/api/memory-index?character_id=char-a',
      reason: 'external_memory_payloads_disabled',
    },
    {
      action: 'index_unindexed',
      body: { action: 'index_unindexed' },
      url: 'http://test.local/api/memory-index?character_id=char-a',
      reason: 'external_memory_payloads_disabled',
    },
  ];

  for (const item of cases) {
    const route = requireFreshWithMocks('../src/app/api/memory-index/route.ts', {
      'next/server': jsonResponseMock(),
      '@/lib/db': { getDb: () => ({}) },
      '@/lib/settings': {
        loadSettings: () => ({
          memory_engine: {
            enabled: true,
            allow_external_memory_payloads: false,
            embedding_enabled: true,
            embedding_api_base: 'https://embedding.example/v1',
            embedding_api_key: 'embedding-secret',
            embedding_model: 'embedding-model',
            embedding_dimension: 1024,
            embedding_timeout_ms: 1500,
          },
        }),
      },
      '@/lib/memory-embeddings': {
        ensureMemoryEmbeddingTables: () => {},
        enqueueRebuildMemoryEmbeddings: (characterId) => {
          assert.equal(characterId, 'char-a');
          return item.action === 'rebuild' ? 2 : 0;
        },
        retryFailedMemoryEmbeddings: (characterId) => {
          assert.equal(characterId, 'char-a');
          return item.action === 'retry_failed' ? 3 : 0;
        },
        enqueueUnindexedMemoryEmbeddings: (characterId, options) => {
          assert.equal(characterId, 'char-a');
          assert.equal(options.model, 'embedding-model');
          return item.action === 'index_unindexed' ? 4 : 0;
        },
        getMemoryIndexStatus: () => ({ total: 4, ready: 0, pending: 4, processing: 0, failed: 0 }),
        processMemoryEmbeddingTasks: async () => {
          throw new Error('drain should not start when config is blocked');
        },
      },
    });

    const response = await route.POST(jsonRequest(item.body, item.url));
    const payload = await response.json();

    assert.equal(response.status, 200, item.action);
    assert.ok(payload.queued > 0, item.action);
    assert.equal(payload.processing_started, false, item.action);
    assert.equal(payload.processing_blocked_reason, item.reason, item.action);
  }
});

test('/api/memory-index 重建入队后触发非阻塞 drain，并连续处理多个 batch', async () => {
  const originalSetTimeout = global.setTimeout;
  let scheduled;
  let processCalls = 0;
  let remaining = 17;
  let resolveDrainComplete;
  const drainComplete = new Promise(resolve => {
    resolveDrainComplete = resolve;
  });
  global.setTimeout = (fn, delay) => {
    scheduled = { fn, delay };
    return 0;
  };

  try {
    const route = requireFreshWithMocks('../src/app/api/memory-index/route.ts', {
      'next/server': jsonResponseMock(),
      '@/lib/db': { getDb: () => ({}) },
      '@/lib/settings': {
        loadSettings: () => ({
          memory_engine: {
            enabled: true,
            embedding_enabled: true,
            embedding_api_base: 'https://embedding.example/v1',
            embedding_api_key: 'embedding-secret',
            embedding_model: 'embedding-model',
            embedding_dimension: 1024,
            embedding_timeout_ms: 1500,
          },
        }),
      },
      '@/lib/memory-embeddings': {
        ensureMemoryEmbeddingTables: () => {},
        enqueueRebuildMemoryEmbeddings: (characterId) => {
          assert.equal(characterId, 'char-a');
          return 17;
        },
        getMemoryIndexStatus: () => ({ total: 17, ready: 17 - remaining, pending: remaining, processing: 0, failed: 0 }),
        processMemoryEmbeddingTasks: async (config, options) => {
          processCalls += 1;
          assert.equal(config.api_base, 'https://embedding.example/v1');
          assert.equal(config.model, 'embedding-model');
          assert.equal(config.timeout_ms, 10000);
          assert.equal(options.limit, 8);
          const processed = Math.min(options.limit, remaining);
          remaining -= processed;
          if (remaining === 0) resolveDrainComplete();
          return { processed, failed: 0 };
        },
      },
    });

    const response = await route.POST(jsonRequest({}, 'http://test.local/api/memory-index?character_id=char-a'));
    const payload = await response.json();

    assert.deepEqual(payload, {
      ok: true,
      queued: 17,
      character_id: 'char-a',
      processing_started: true,
    });
    assert.equal(processCalls, 0);
    assert.equal(scheduled.delay, 0);

    scheduled.fn();
    await drainComplete;
    await Promise.resolve();
    assert.equal(processCalls, 3);
    assert.equal(remaining, 0);
  } finally {
    global.setTimeout = originalSetTimeout;
  }
});

test('/api/memory-index 重复触发不会启动重叠 drain loop', async () => {
  const originalSetTimeout = global.setTimeout;
  const scheduled = [];
  let processCalls = 0;
  let releaseFirstBatch;
  let resolveDrainComplete;
  const firstBatchStarted = new Promise(resolve => {
    releaseFirstBatch = () => resolve();
  });
  const drainComplete = new Promise(resolve => {
    resolveDrainComplete = resolve;
  });

  global.setTimeout = (fn, delay) => {
    scheduled.push({ fn, delay });
    return scheduled.length;
  };

  try {
    const route = requireFreshWithMocks('../src/app/api/memory-index/route.ts', {
      'next/server': jsonResponseMock(),
      '@/lib/db': { getDb: () => ({}) },
      '@/lib/settings': {
        loadSettings: () => ({
          memory_engine: {
            enabled: true,
            embedding_enabled: true,
            embedding_api_base: 'https://embedding.example/v1',
            embedding_api_key: 'embedding-secret',
            embedding_model: 'embedding-model',
            embedding_dimension: 1024,
            embedding_timeout_ms: 1500,
          },
        }),
      },
      '@/lib/memory-embeddings': {
        ensureMemoryEmbeddingTables: () => {},
        enqueueRebuildMemoryEmbeddings: () => 8,
        getMemoryIndexStatus: () => ({
          total: 8,
          ready: processCalls > 0 ? 8 : 0,
          pending: processCalls > 0 ? 0 : 8,
          processing: 0,
          failed: 0,
        }),
        processMemoryEmbeddingTasks: async () => {
          processCalls += 1;
          if (processCalls === 1) {
            await firstBatchStarted;
            return { processed: 8, failed: 0 };
          }
          resolveDrainComplete();
          return { processed: 0, failed: 0 };
        },
      },
    });

    const firstResponse = await route.POST(jsonRequest({}, 'http://test.local/api/memory-index?character_id=char-a'));
    const firstPayload = await firstResponse.json();

    assert.equal(firstPayload.processing_started, true);
    assert.equal(scheduled.length, 1);
    assert.equal(scheduled[0].delay, 0);

    scheduled[0].fn();
    await Promise.resolve();
    assert.equal(processCalls, 1);

    const secondResponse = await route.POST(jsonRequest({}, 'http://test.local/api/memory-index?character_id=char-a'));
    const secondPayload = await secondResponse.json();

    assert.equal(secondPayload.processing_started, true);
    assert.equal(scheduled.length, 1);
    assert.equal(processCalls, 1);

    releaseFirstBatch();
    await drainComplete;
    await Promise.resolve();
  } finally {
    global.setTimeout = originalSetTimeout;
  }
});

test('/api/memory-index drain 达到批次上限后仍有 pending 会自动续跑', async () => {
  const originalSetTimeout = global.setTimeout;
  const scheduled = [];
  let processCalls = 0;
  let remaining = 300;
  let resolveRescheduled;
  let resolveAllDone;
  const rescheduled = new Promise(resolve => {
    resolveRescheduled = resolve;
  });
  const allDone = new Promise(resolve => {
    resolveAllDone = resolve;
  });

  global.setTimeout = (fn, delay) => {
    scheduled.push({ fn, delay });
    if (scheduled.length === 2) resolveRescheduled();
    return scheduled.length;
  };

  try {
    const route = requireFreshWithMocks('../src/app/api/memory-index/route.ts', {
      'next/server': jsonResponseMock(),
      '@/lib/db': { getDb: () => ({}) },
      '@/lib/settings': {
        loadSettings: () => ({
          memory_engine: {
            enabled: true,
            embedding_enabled: true,
            embedding_api_base: 'https://embedding.example/v1',
            embedding_api_key: 'embedding-secret',
            embedding_model: 'embedding-model',
            embedding_dimension: 1024,
            embedding_timeout_ms: 1500,
          },
        }),
      },
      '@/lib/memory-embeddings': {
        ensureMemoryEmbeddingTables: () => {},
        enqueueRebuildMemoryEmbeddings: () => 300,
        getMemoryIndexStatus: () => ({ total: 300, ready: 300 - remaining, pending: remaining, processing: 0, failed: 0 }),
        processMemoryEmbeddingTasks: async (_config, options) => {
          processCalls += 1;
          const processed = Math.min(options.limit, remaining);
          remaining -= processed;
          if (remaining === 0) resolveAllDone();
          return { processed, failed: 0 };
        },
      },
    });

    const response = await route.POST(jsonRequest({}, 'http://test.local/api/memory-index?character_id=char-a'));
    const payload = await response.json();

    assert.equal(payload.processing_started, true);
    assert.equal(scheduled.length, 1);

    scheduled[0].fn();
    const rescheduleResult = await Promise.race([
      rescheduled.then(() => 'rescheduled'),
      new Promise(resolve => originalSetTimeout(() => resolve('timeout'), 50)),
    ]);

    assert.equal(rescheduleResult, 'rescheduled');
    assert.equal(processCalls, 32);
    assert.equal(remaining, 44);
    assert.equal(scheduled[1].delay, 0);

    scheduled[1].fn();
    await allDone;
    await Promise.resolve();

    assert.equal(processCalls, 38);
    assert.equal(remaining, 0);
    assert.equal(scheduled.length, 2);
  } finally {
    global.setTimeout = originalSetTimeout;
  }
});

test('/api/memory-index drain 没有可处理任务但仍有 pending 时延迟续跑', async () => {
  const originalSetTimeout = global.setTimeout;
  const scheduled = [];
  let resolveRescheduled;
  const rescheduled = new Promise(resolve => {
    resolveRescheduled = resolve;
  });

  global.setTimeout = (fn, delay) => {
    scheduled.push({ fn, delay });
    if (scheduled.length === 2) resolveRescheduled();
    return scheduled.length;
  };

  try {
    const route = requireFreshWithMocks('../src/app/api/memory-index/route.ts', {
      'next/server': jsonResponseMock(),
      '@/lib/db': { getDb: () => ({}) },
      '@/lib/settings': {
        loadSettings: () => ({
          memory_engine: {
            enabled: true,
            embedding_enabled: true,
            embedding_api_base: 'https://embedding.example/v1',
            embedding_api_key: 'embedding-secret',
            embedding_model: 'embedding-model',
            embedding_dimension: 1024,
            embedding_timeout_ms: 1500,
          },
        }),
      },
      '@/lib/memory-embeddings': {
        ensureMemoryEmbeddingTables: () => {},
        enqueueRebuildMemoryEmbeddings: () => 1,
        getMemoryIndexStatus: () => ({ total: 1, ready: 0, pending: 1, processing: 0, failed: 0 }),
        processMemoryEmbeddingTasks: async () => ({ processed: 0, failed: 0 }),
      },
    });

    const response = await route.POST(jsonRequest({}, 'http://test.local/api/memory-index?character_id=char-a'));
    const payload = await response.json();

    assert.equal(payload.processing_started, true);
    assert.equal(scheduled.length, 1);
    assert.equal(scheduled[0].delay, 0);

    scheduled[0].fn();
    await rescheduled;

    assert.equal(scheduled.length, 2);
    assert.ok(scheduled[1].delay > 0);
  } finally {
    global.setTimeout = originalSetTimeout;
  }
});

test('重建索引会重试已有 failed 任务而不是为同一记忆重复堆积任务', () => {
  const db = createMemoryDb();
  db.exec(`
    INSERT INTO memories (
      id, character_id, category, content, confidence, tags, source_msg_ids,
      memory_kind, importance, emotional_weight, status, pinned, last_used_at,
      usage_count, metadata, created_at, updated_at
    )
    VALUES (
      'mem-failed', 'char-a', '话题历史', '需要重新构建索引的记忆。', 0.9, '[]', '[]',
      'general', 0.5, 0, 'active', 0, NULL, 0, '{}',
      '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'
    );

    INSERT INTO memory_embedding_tasks (
      memory_id, character_id, reason, status, retry_count, error_message, created_at, updated_at
    )
    VALUES (
      'mem-failed', 'char-a', 'rebuild', 'failed', 1, 'embedding API error 404: 404 page not found',
      '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'
    );
  `);

  const queued = enqueueRebuildMemoryEmbeddings('char-a', db);
  const tasks = db.prepare(`
    SELECT memory_id, character_id, reason, status, retry_count, error_message
    FROM memory_embedding_tasks
  `).all();

  assert.equal(queued, 1);
  assert.equal(tasks.length, 1);
  assert.deepEqual(tasks[0], {
    memory_id: 'mem-failed',
    character_id: 'char-a',
    reason: 'rebuild',
    status: 'pending',
    retry_count: 0,
    error_message: null,
  });
});

test('retryFailedMemoryEmbeddings 只重试当前未解决的 failed 任务', () => {
  const db = createMemoryDb();
  ensureMemoryEmbeddingTables(db);
  db.exec(`
    INSERT INTO memories (
      id, character_id, category, content, confidence, tags, source_msg_ids,
      memory_kind, importance, emotional_weight, status, pinned, last_used_at,
      usage_count, metadata, created_at, updated_at
    )
    VALUES
      (
        'mem-failed', 'char-a', '话题历史', '只重试这条失败记忆。', 0.9, '[]', '[]',
        'general', 0.5, 0, 'active', 0, NULL, 0, '{}',
        '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'
      ),
      (
        'mem-ready-with-old-fail', 'char-a', '话题历史', '已有 ready embedding 的旧失败不应重试。', 0.9, '[]', '[]',
        'general', 0.5, 0, 'active', 0, NULL, 0, '{}',
        '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'
      ),
      (
        'mem-active-task', 'char-a', '话题历史', '已有 pending 任务时不重复重试。', 0.9, '[]', '[]',
        'general', 0.5, 0, 'active', 0, NULL, 0, '{}',
        '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'
      ),
      (
        'mem-other-character', 'char-b', '话题历史', '其他角色失败任务不应被重试。', 0.9, '[]', '[]',
        'general', 0.5, 0, 'active', 0, NULL, 0, '{}',
        '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'
      );

    INSERT INTO memory_embeddings (
      memory_id, character_id, provider, model, dimension, embedding_blob,
      normalized, embedding_text_hash, status, created_at, updated_at
    )
    VALUES (
      'mem-ready-with-old-fail', 'char-a', 'openai-compatible', 'embedding-model', 2, X'000000000000803F',
      1, 'ready-hash', 'ready', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'
    );

    INSERT INTO memory_embedding_tasks (
      memory_id, character_id, reason, status, retry_count, error_message, created_at, updated_at
    )
    VALUES
      (
        'mem-failed', 'char-a', 'rebuild', 'failed', 2, 'embedding request timed out after 10000ms',
        '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:01.000Z'
      ),
      (
        'mem-ready-with-old-fail', 'char-a', 'rebuild', 'failed', 1, 'old failed row',
        '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:02.000Z'
      ),
      (
        'mem-active-task', 'char-a', 'rebuild', 'failed', 1, 'old failed row',
        '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:03.000Z'
      ),
      (
        'mem-active-task', 'char-a', 'updated', 'pending', 0, NULL,
        '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:04.000Z'
      ),
      (
        'mem-other-character', 'char-b', 'rebuild', 'failed', 1, 'other character failed row',
        '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:05.000Z'
      );
  `);

  const queued = retryFailedMemoryEmbeddings('char-a', db);
  const tasks = db.prepare(`
    SELECT memory_id, reason, status, retry_count, error_message
    FROM memory_embedding_tasks
    ORDER BY id ASC
  `).all();

  assert.equal(queued, 1);
  assert.deepEqual(tasks, [
    {
      memory_id: 'mem-failed',
      reason: 'retry_failed',
      status: 'pending',
      retry_count: 0,
      error_message: null,
    },
    {
      memory_id: 'mem-ready-with-old-fail',
      reason: 'rebuild',
      status: 'failed',
      retry_count: 1,
      error_message: 'old failed row',
    },
    {
      memory_id: 'mem-active-task',
      reason: 'rebuild',
      status: 'failed',
      retry_count: 1,
      error_message: 'old failed row',
    },
    {
      memory_id: 'mem-active-task',
      reason: 'updated',
      status: 'pending',
      retry_count: 0,
      error_message: null,
    },
    {
      memory_id: 'mem-other-character',
      reason: 'rebuild',
      status: 'failed',
      retry_count: 1,
      error_message: 'other character failed row',
    },
  ]);
});

test('retryFailedMemoryEmbeddings retries current target failures despite old ready embeddings', () => {
  const db = createMemoryDb();
  ensureMemoryEmbeddingTables(db);
  db.exec(`
    INSERT INTO memories (
      id, character_id, category, content, confidence, tags, source_msg_ids,
      memory_kind, importance, emotional_weight, status, pinned, last_used_at,
      usage_count, metadata, created_at, updated_at
    )
    VALUES
      (
        'mem-old-model-ready', 'char-a', '话题历史', '旧模型 ready 不能解决当前模型失败。', 0.9, '[]', '[]',
        'general', 0.5, 0, 'active', 0, NULL, 0, '{}',
        '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'
      ),
      (
        'mem-wrong-dimension-ready', 'char-a', '话题历史', '错误维度 ready 不能解决当前维度失败。', 0.9, '[]', '[]',
        'general', 0.5, 0, 'active', 0, NULL, 0, '{}',
        '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'
      ),
      (
        'mem-current-ready', 'char-a', '话题历史', '当前模型 ready 应解决失败。', 0.9, '[]', '[]',
        'general', 0.5, 0, 'active', 0, NULL, 0, '{}',
        '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'
      );

    INSERT INTO memory_embeddings (
      memory_id, character_id, provider, model, dimension, embedding_blob,
      normalized, embedding_text_hash, status, created_at, updated_at
    )
    VALUES
      (
        'mem-old-model-ready', 'char-a', 'openai-compatible', 'old-model', 2, X'000000000000803F',
        1, 'old-model-ready-hash', 'ready', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'
      ),
      (
        'mem-wrong-dimension-ready', 'char-a', 'openai-compatible', 'current-model', 3, X'000000000000803F00000040',
        1, 'wrong-dimension-ready-hash', 'ready', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'
      ),
      (
        'mem-current-ready', 'char-a', 'openai-compatible', 'current-model', 2, X'000000000000803F',
        1, 'current-ready-hash', 'ready', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'
      );

    INSERT INTO memory_embedding_tasks (
      memory_id, character_id, reason, status, retry_count, error_message, created_at, updated_at
    )
    VALUES
      (
        'mem-old-model-ready', 'char-a', 'rebuild', 'failed', 1, 'current model failed',
        '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:01.000Z'
      ),
      (
        'mem-wrong-dimension-ready', 'char-a', 'rebuild', 'failed', 1, 'current dimension failed',
        '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:02.000Z'
      ),
      (
        'mem-current-ready', 'char-a', 'rebuild', 'failed', 1, 'resolved by current ready',
        '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:03.000Z'
      );
  `);

  const queued = retryFailedMemoryEmbeddings('char-a', db, {
    provider: 'openai-compatible',
    model: 'current-model',
    dimension: 2,
  });
  const retried = db.prepare(`
    SELECT memory_id, reason, status, retry_count, error_message
    FROM memory_embedding_tasks
    WHERE reason = 'retry_failed'
    ORDER BY memory_id ASC
  `).all();

  assert.equal(queued, 2);
  assert.deepEqual(retried, [
    {
      memory_id: 'mem-old-model-ready',
      reason: 'retry_failed',
      status: 'pending',
      retry_count: 0,
      error_message: null,
    },
    {
      memory_id: 'mem-wrong-dimension-ready',
      reason: 'retry_failed',
      status: 'pending',
      retry_count: 0,
      error_message: null,
    },
  ]);
});

test('enqueueUnindexedMemoryEmbeddings 只为当前模型下缺少 ready 向量的记忆入队', () => {
  const db = createMemoryDb();
  ensureMemoryEmbeddingTables(db);
  db.exec(`
    INSERT INTO memories (
      id, character_id, category, content, confidence, tags, source_msg_ids,
      memory_kind, importance, emotional_weight, status, pinned, last_used_at,
      usage_count, metadata, created_at, updated_at
    )
    VALUES
      (
        'mem-ready-current', 'char-a', '话题历史', '已经有当前模型索引。', 0.9, '[]', '[]',
        'general', 0.5, 0, 'active', 0, NULL, 0, '{}',
        '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'
      ),
      (
        'mem-ready-old-model', 'char-a', '话题历史', '只有旧模型索引。', 0.9, '[]', '[]',
        'general', 0.5, 0, 'active', 0, NULL, 0, '{}',
        '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'
      ),
      (
        'mem-missing', 'char-a', '话题历史', '完全没有索引。', 0.9, '[]', '[]',
        'general', 0.5, 0, 'active', 0, NULL, 0, '{}',
        '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'
      ),
      (
        'mem-active-task', 'char-a', '话题历史', '已经在队列中。', 0.9, '[]', '[]',
        'general', 0.5, 0, 'active', 0, NULL, 0, '{}',
        '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'
      );

    INSERT INTO memory_embeddings (
      memory_id, character_id, provider, model, dimension, embedding_blob,
      normalized, embedding_text_hash, status, created_at, updated_at
    )
    VALUES
      (
        'mem-ready-current', 'char-a', 'openai-compatible', 'embedding-model', 2, X'000000000000803F',
        1, 'ready-current-hash', 'ready', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'
      ),
      (
        'mem-ready-old-model', 'char-a', 'openai-compatible', 'old-model', 2, X'000000000000803F',
        1, 'ready-old-hash', 'ready', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'
      );

    INSERT INTO memory_embedding_tasks (
      memory_id, character_id, reason, status, retry_count, error_message, created_at, updated_at
    )
    VALUES (
      'mem-active-task', 'char-a', 'created', 'pending', 0, NULL,
      '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'
    );
  `);

  const queued = enqueueUnindexedMemoryEmbeddings(undefined, {
    provider: 'openai-compatible',
    model: 'embedding-model',
    dimension: 2,
    db,
  });
  const tasks = db.prepare(`
    SELECT memory_id, reason, status
    FROM memory_embedding_tasks
    ORDER BY id ASC
  `).all();

  assert.equal(queued, 2);
  assert.deepEqual(tasks, [
    { memory_id: 'mem-active-task', reason: 'created', status: 'pending' },
    { memory_id: 'mem-ready-old-model', reason: 'semantic_backfill', status: 'pending' },
    { memory_id: 'mem-missing', reason: 'semantic_backfill', status: 'pending' },
  ]);
});

test('/api/memory-index retry_failed 只重试 failed 任务并启动 drain', async () => {
  const originalSetTimeout = global.setTimeout;
  let scheduled;
  let rebuildCalls = 0;
  let retryCalls = 0;
  let processCalls = 0;

  global.setTimeout = (fn, delay) => {
    scheduled = { fn, delay };
    return 0;
  };

  try {
    const route = requireFreshWithMocks('../src/app/api/memory-index/route.ts', {
      'next/server': jsonResponseMock(),
      '@/lib/db': { getDb: () => ({}) },
      '@/lib/settings': {
        loadSettings: () => ({
          memory_engine: {
            enabled: true,
            embedding_enabled: true,
            embedding_api_base: 'https://embedding.example/v1',
            embedding_api_key: 'embedding-secret',
            embedding_model: 'embedding-model',
            embedding_dimension: 1024,
            embedding_timeout_ms: 1500,
          },
        }),
      },
      '@/lib/memory-embeddings': {
        ensureMemoryEmbeddingTables: () => {},
        enqueueRebuildMemoryEmbeddings: () => {
          rebuildCalls += 1;
          return 0;
        },
        retryFailedMemoryEmbeddings: (characterId, _db, target) => {
          retryCalls += 1;
          assert.equal(characterId, 'char-a');
          assert.deepEqual(target, {
            provider: 'openai-compatible',
            model: 'embedding-model',
            dimension: 1024,
          });
          return 3;
        },
        getMemoryIndexStatus: () => ({ total: 10, ready: 7, pending: 0, processing: 0, failed: 0 }),
        processMemoryEmbeddingTasks: async () => {
          processCalls += 1;
          return { processed: 3, failed: 0 };
        },
      },
    });

    const response = await route.POST(jsonRequest(
      { action: 'retry_failed' },
      'http://test.local/api/memory-index?character_id=char-a',
    ));
    const payload = await response.json();

    assert.deepEqual(payload, {
      ok: true,
      queued: 3,
      character_id: 'char-a',
      processing_started: true,
      action: 'retry_failed',
    });
    assert.equal(rebuildCalls, 0);
    assert.equal(retryCalls, 1);
    assert.equal(scheduled.delay, 0);

    scheduled.fn();
    await Promise.resolve();
    assert.equal(processCalls, 1);
  } finally {
    global.setTimeout = originalSetTimeout;
  }
});

test('/api/memory-index index_unindexed 使用当前 embedding 模型入队并启动 drain', async () => {
  const originalSetTimeout = global.setTimeout;
  let scheduled;
  let unindexedCalls = 0;
  let processCalls = 0;

  global.setTimeout = (fn, delay) => {
    scheduled = { fn, delay };
    return 0;
  };

  try {
    const route = requireFreshWithMocks('../src/app/api/memory-index/route.ts', {
      'next/server': jsonResponseMock(),
      '@/lib/db': { getDb: () => ({}) },
      '@/lib/settings': {
        loadSettings: () => ({
          memory_engine: {
            enabled: true,
            embedding_enabled: true,
            embedding_api_base: 'https://embedding.example/v1',
            embedding_api_key: 'embedding-secret',
            embedding_model: 'embedding-model',
            embedding_dimension: 1024,
          },
        }),
      },
      '@/lib/memory-embeddings': {
        ensureMemoryEmbeddingTables: () => {},
        enqueueRebuildMemoryEmbeddings: () => {
          throw new Error('rebuild should not be called');
        },
        enqueueUnindexedMemoryEmbeddings: (characterId, options) => {
          unindexedCalls += 1;
          assert.equal(characterId, 'char-a');
          assert.equal(options.provider, 'openai-compatible');
          assert.equal(options.model, 'embedding-model');
          assert.equal(options.dimension, 1024);
          return 2;
        },
        retryFailedMemoryEmbeddings: () => 0,
        clearMemoryIndex: () => ({ cleared_embeddings: 0, cleared_tasks: 0 }),
        stopCurrentMemoryIndexTasks: () => ({ stopped: 0 }),
        getMemoryIndexStatus: () => ({ total: 10, ready: 8, pending: 0, processing: 0, failed: 0 }),
        processMemoryEmbeddingTasks: async () => {
          processCalls += 1;
          return { processed: 2, failed: 0 };
        },
      },
    });

    const response = await route.POST(jsonRequest(
      { action: 'index_unindexed' },
      'http://test.local/api/memory-index?character_id=char-a',
    ));
    const payload = await response.json();

    assert.deepEqual(payload, {
      ok: true,
      queued: 2,
      character_id: 'char-a',
      processing_started: true,
      action: 'index_unindexed',
    });
    assert.equal(unindexedCalls, 1);
    assert.equal(scheduled.delay, 0);

    scheduled.fn();
    await Promise.resolve();
    assert.equal(processCalls, 1);
  } finally {
    global.setTimeout = originalSetTimeout;
  }
});

test('/api/memory-index clear_index 清空指定角色索引和任务', async () => {
  const db = createMemoryDb();
  ensureMemoryEmbeddingTables(db);
  db.exec(`
    INSERT INTO memories (
      id, character_id, category, content, confidence, tags, source_msg_ids,
      memory_kind, importance, emotional_weight, status, pinned, last_used_at,
      usage_count, metadata, created_at, updated_at
    )
    VALUES
      (
        'mem-clear-a', 'char-a', '话题历史', '需要清空索引的记忆 A。', 0.9, '[]', '[]',
        'general', 0.5, 0, 'active', 0, NULL, 0, '{}',
        '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'
      ),
      (
        'mem-clear-b', 'char-a', '话题历史', '需要清空索引的记忆 B。', 0.9, '[]', '[]',
        'general', 0.5, 0, 'active', 0, NULL, 0, '{}',
        '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'
      ),
      (
        'mem-clear-other', 'char-b', '话题历史', '其他角色的索引不能被清空。', 0.9, '[]', '[]',
        'general', 0.5, 0, 'active', 0, NULL, 0, '{}',
        '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'
      );

    INSERT INTO memory_embeddings (
      memory_id, character_id, provider, model, dimension, embedding_blob,
      normalized, embedding_text_hash, status, created_at, updated_at
    )
    VALUES
      (
        'mem-clear-a', 'char-a', 'openai-compatible', 'embedding-model', 2, X'000000000000803F',
        1, 'clear-a-hash', 'ready', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'
      ),
      (
        'mem-clear-b', 'char-a', 'openai-compatible', 'embedding-model', 2, X'000000000000803F',
        1, 'clear-b-hash', 'failed', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'
      ),
      (
        'mem-clear-other', 'char-b', 'openai-compatible', 'embedding-model', 2, X'000000000000803F',
        1, 'clear-other-hash', 'ready', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'
      );

    INSERT INTO memory_embedding_tasks (
      memory_id, character_id, reason, status, retry_count, error_message, created_at, updated_at
    )
    VALUES
      ('mem-clear-a', 'char-a', 'rebuild', 'pending', 0, NULL, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:01.000Z'),
      ('mem-clear-b', 'char-a', 'rebuild', 'failed', 1, 'old failure', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:03.000Z'),
      ('mem-clear-b', 'char-a', 'rebuild', 'done', 0, NULL, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:04.000Z'),
      ('mem-clear-other', 'char-b', 'rebuild', 'pending', 0, NULL, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:05.000Z');
  `);

  delete require.cache[require.resolve('../src/lib/memory-embeddings.ts')];
  const route = requireFreshWithMocks('../src/app/api/memory-index/route.ts', {
    'next/server': jsonResponseMock(),
    '@/lib/db': { getDb: () => db },
    '@/lib/settings': { loadSettings: () => baseSettings() },
  });

  const response = await route.POST(jsonRequest(
    { action: 'clear_index', character_id: 'char-a' },
    'http://test.local/api/memory-index',
  ));
  const payload = await response.json();
  const remainingEmbeddings = db.prepare(`
    SELECT memory_id, character_id, status
    FROM memory_embeddings
    ORDER BY memory_id ASC
  `).all();
  const remainingTasks = db.prepare(`
    SELECT memory_id, character_id, status
    FROM memory_embedding_tasks
    ORDER BY id ASC
  `).all();

  assert.equal(response.status, 200);
  assert.equal(payload.ok, true);
  assert.equal(payload.action, 'clear_index');
  assert.equal(payload.character_id, 'char-a');
  assert.equal(payload.cleared_embeddings, 2);
  assert.equal(payload.cleared_tasks, 3);
  assert.deepEqual(remainingEmbeddings, [
    { memory_id: 'mem-clear-other', character_id: 'char-b', status: 'ready' },
  ]);
  assert.deepEqual(remainingTasks, [
    { memory_id: 'mem-clear-other', character_id: 'char-b', status: 'pending' },
  ]);
});

test('/api/memory-index stop_current 停止当前范围队列且不污染失败原因', async () => {
  const originalSetTimeout = global.setTimeout;
  const scheduled = [];
  let processCalls = 0;
  const db = createMemoryDb();
  ensureMemoryEmbeddingTables(db);
  db.exec(`
    INSERT INTO memories (
      id, character_id, category, content, confidence, tags, source_msg_ids,
      memory_kind, importance, emotional_weight, status, pinned, last_used_at,
      usage_count, metadata, created_at, updated_at
    )
    VALUES
      (
        'mem-stop-pending', 'char-a', '话题历史', '待停止的 pending 任务。', 0.9, '[]', '[]',
        'general', 0.5, 0, 'active', 0, NULL, 0, '{}',
        '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'
      ),
      (
        'mem-stop-processing', 'char-a', '话题历史', '待停止的 processing 任务。', 0.9, '[]', '[]',
        'general', 0.5, 0, 'active', 0, NULL, 0, '{}',
        '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'
      ),
      (
        'mem-stop-other', 'char-b', '话题历史', '其他角色的队列不能被停止。', 0.9, '[]', '[]',
        'general', 0.5, 0, 'active', 0, NULL, 0, '{}',
        '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'
      );

    INSERT INTO memory_embedding_tasks (
      memory_id, character_id, reason, status, retry_count, error_message, created_at, updated_at
    )
    VALUES
      ('mem-stop-pending', 'char-a', 'rebuild', 'pending', 0, NULL, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:01.000Z'),
      ('mem-stop-processing', 'char-a', 'rebuild', 'processing', 0, NULL, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:02.000Z'),
      ('mem-stop-other', 'char-b', 'rebuild', 'pending', 0, NULL, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:04.000Z');
  `);

  global.setTimeout = (fn, delay) => {
    scheduled.push({ fn, delay });
    return scheduled.length;
  };

  try {
    delete require.cache[require.resolve('../src/lib/memory-embeddings.ts')];
    const route = requireFreshWithMocks('../src/app/api/memory-index/route.ts', {
      'next/server': jsonResponseMock(),
      '@/lib/db': { getDb: () => db },
      '@/lib/settings': {
        loadSettings: () => ({
          memory_engine: {
            enabled: true,
            embedding_enabled: true,
            embedding_api_base: 'https://embedding.example/v1',
            embedding_model: 'embedding-model',
            allow_external_memory_payloads: true,
          },
        }),
      },
      '@/lib/memory-embeddings': {
        ...require('../src/lib/memory-embeddings.ts'),
        processMemoryEmbeddingTasks: async () => {
          processCalls += 1;
          return { processed: 1, failed: 0 };
        },
      },
    });

    const rebuildResponse = await route.POST(jsonRequest(
      {},
      'http://test.local/api/memory-index?character_id=char-a',
    ));
    const rebuildPayload = await rebuildResponse.json();
    assert.equal(rebuildPayload.processing_started, true);
    assert.equal(scheduled.length, 1);

    db.exec(`
      INSERT INTO memories (
        id, character_id, category, content, confidence, tags, source_msg_ids,
        memory_kind, importance, emotional_weight, status, pinned, last_used_at,
        usage_count, metadata, created_at, updated_at
      )
      VALUES (
        'mem-stop-failed', 'char-a', '话题历史', '已有失败任务应保留。', 0.9, '[]', '[]',
        'general', 0.5, 0, 'active', 0, NULL, 0, '{}',
        '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'
      );

      INSERT INTO memory_embedding_tasks (
        memory_id, character_id, reason, status, retry_count, error_message, created_at, updated_at
      )
      VALUES (
        'mem-stop-failed', 'char-a', 'rebuild', 'failed', 1, 'old failure',
        '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:03.000Z'
      );
    `);

    const stopResponse = await route.POST(jsonRequest(
      { action: 'stop_current', character_id: 'char-a' },
      'http://test.local/api/memory-index',
    ));
    const stopPayload = await stopResponse.json();
    const status = getMemoryIndexStatus('char-a', db);
    const remainingTasks = db.prepare(`
      SELECT memory_id, character_id, status, error_message
      FROM memory_embedding_tasks
      ORDER BY id ASC
    `).all();

    assert.equal(stopResponse.status, 200);
    assert.equal(stopPayload.ok, true);
    assert.equal(stopPayload.action, 'stop_current');
    assert.equal(stopPayload.character_id, 'char-a');
    assert.equal(stopPayload.stopped_tasks, 2);
    assert.equal(stopPayload.processing_started, false);
    assert.equal(status.pending, 0);
    assert.equal(status.processing, 0);
    assert.equal(status.failed, 1);
    assert.equal(status.latest_error, 'old failure');
    assert.deepEqual(remainingTasks, [
      { memory_id: 'mem-stop-other', character_id: 'char-b', status: 'pending', error_message: null },
      { memory_id: 'mem-stop-failed', character_id: 'char-a', status: 'failed', error_message: 'old failure' },
    ]);

    scheduled[0].fn();
    await Promise.resolve();
    assert.equal(processCalls, 0);
  } finally {
    global.setTimeout = originalSetTimeout;
  }
});

test('索引状态暴露最近的 embedding 失败原因', () => {
  const db = createMemoryDb();
  db.exec(`
    INSERT INTO memories (
      id, character_id, category, content, confidence, tags, source_msg_ids,
      memory_kind, importance, emotional_weight, status, pinned, last_used_at,
      usage_count, metadata, created_at, updated_at
    )
    VALUES (
      'mem-error', 'char-a', '话题历史', '失败原因应出现在索引状态中。', 0.9, '[]', '[]',
      'general', 0.5, 0, 'active', 0, NULL, 0, '{}',
      '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'
    );

    INSERT INTO memory_embedding_tasks (
      memory_id, character_id, reason, status, retry_count, error_message, created_at, updated_at
    )
    VALUES (
      'mem-error', 'char-a', 'rebuild', 'failed', 1, 'embedding API error 404: 404 page not found',
      '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:01.000Z'
    );
  `);

  const status = getMemoryIndexStatus('char-a', db);

  assert.equal(status.failed, 1);
  assert.equal(status.latest_error, 'embedding API error 404: 404 page not found');
});

test('getMemoryIndexStatus filters ready and unresolved failed by current embedding target', () => {
  const db = createMemoryDb();
  ensureMemoryEmbeddingTables(db);
  db.exec(`
    INSERT INTO memories (
      id, character_id, category, content, confidence, tags, source_msg_ids,
      memory_kind, importance, emotional_weight, status, pinned, last_used_at,
      usage_count, metadata, created_at, updated_at
    )
    VALUES
      (
        'mem-current-ready', 'char-a', '话题历史', '当前模型已经 ready。', 0.9, '[]', '[]',
        'general', 0.5, 0, 'active', 0, NULL, 0, '{}',
        '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'
      ),
      (
        'mem-old-model-ready', 'char-a', '话题历史', '只有旧模型 ready，当前模型失败。', 0.9, '[]', '[]',
        'general', 0.5, 0, 'active', 0, NULL, 0, '{}',
        '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'
      ),
      (
        'mem-wrong-dimension-ready', 'char-a', '话题历史', '只有错误维度 ready，当前维度失败。', 0.9, '[]', '[]',
        'general', 0.5, 0, 'active', 0, NULL, 0, '{}',
        '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'
      );

    INSERT INTO memory_embeddings (
      memory_id, character_id, provider, model, dimension, embedding_blob,
      normalized, embedding_text_hash, status, created_at, updated_at
    )
    VALUES
      (
        'mem-current-ready', 'char-a', 'openai-compatible', 'current-model', 2, X'000000000000803F',
        1, 'current-ready-hash', 'ready', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'
      ),
      (
        'mem-old-model-ready', 'char-a', 'openai-compatible', 'old-model', 2, X'000000000000803F',
        1, 'old-model-ready-hash', 'ready', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'
      ),
      (
        'mem-wrong-dimension-ready', 'char-a', 'openai-compatible', 'current-model', 3, X'000000000000803F00000040',
        1, 'wrong-dimension-ready-hash', 'ready', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'
      );

    INSERT INTO memory_embedding_tasks (
      memory_id, character_id, reason, status, retry_count, error_message, created_at, updated_at
    )
    VALUES
      (
        'mem-old-model-ready', 'char-a', 'rebuild', 'failed', 1, 'current model failed',
        '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:01.000Z'
      ),
      (
        'mem-wrong-dimension-ready', 'char-a', 'rebuild', 'failed', 1, 'current dimension failed',
        '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:02.000Z'
      );
  `);

  const currentStatus = getMemoryIndexStatus('char-a', db, {
    provider: 'openai-compatible',
    model: 'current-model',
    dimension: 2,
  });
  const flexibleDimensionStatus = getMemoryIndexStatus('char-a', db, {
    provider: 'openai-compatible',
    model: 'current-model',
    dimension: 0,
  });

  assert.equal(currentStatus.total, 3);
  assert.equal(currentStatus.ready, 1);
  assert.equal(currentStatus.failed, 2);
  assert.equal(currentStatus.latest_error, 'current dimension failed');
  assert.equal(flexibleDimensionStatus.ready, 2);
  assert.equal(flexibleDimensionStatus.failed, 1);
  assert.equal(flexibleDimensionStatus.latest_error, 'current model failed');
});

test('blank current embedding model does not match ready embeddings as a wildcard', () => {
  const db = createMemoryDb();
  ensureMemoryEmbeddingTables(db);
  db.exec(`
    INSERT INTO memories (
      id, character_id, category, content, confidence, tags, source_msg_ids,
      memory_kind, importance, emotional_weight, status, pinned, last_used_at,
      usage_count, metadata, created_at, updated_at
    )
    VALUES (
      'mem-old-ready', 'char-a', '话题历史', '旧模型 ready 不能被空当前模型通配。', 0.9, '[]', '[]',
      'general', 0.5, 0, 'active', 0, NULL, 0, '{}',
      '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'
    );

    INSERT INTO memory_embeddings (
      memory_id, character_id, provider, model, dimension, embedding_blob,
      normalized, embedding_text_hash, status, created_at, updated_at
    )
    VALUES (
      'mem-old-ready', 'char-a', 'openai-compatible', 'old-model', 2, X'000000000000803F',
      1, 'old-ready-hash', 'ready', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'
    );

    INSERT INTO memory_embedding_tasks (
      memory_id, character_id, reason, status, retry_count, error_message, created_at, updated_at
    )
    VALUES (
      'mem-old-ready', 'char-a', 'rebuild', 'failed', 1, 'current model missing',
      '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:01.000Z'
    );
  `);

  const target = { provider: 'openai-compatible', model: '   ', dimension: 2 };
  const status = getMemoryIndexStatus('char-a', db, target);
  const queued = retryFailedMemoryEmbeddings('char-a', db, target);

  assert.equal(status.ready, 0);
  assert.equal(status.failed, 1);
  assert.equal(status.latest_error, 'current model missing');
  assert.equal(queued, 1);
});

test('/api/memory-index GET 透传最近的 embedding 失败原因', async () => {
  const route = requireFreshWithMocks('../src/app/api/memory-index/route.ts', {
    'next/server': jsonResponseMock(),
    '@/lib/db': { getDb: () => ({}) },
    '@/lib/settings': {
      loadSettings: () => ({
        memory_engine: {
          enabled: true,
          embedding_enabled: true,
          embedding_api_base: 'https://embedding.example/v1',
          embedding_model: 'embedding-model',
          embedding_dimension: 1024,
        },
      }),
    },
    '@/lib/memory-embeddings': {
      ensureMemoryEmbeddingTables: () => {},
      enqueueRebuildMemoryEmbeddings: () => 0,
      getMemoryIndexStatus: (characterId, _db, target) => {
        assert.equal(characterId, undefined);
        assert.deepEqual(target, {
          provider: 'openai-compatible',
          model: 'embedding-model',
          dimension: 1024,
        });
        return {
          total: 1,
          ready: 0,
          pending: 0,
          processing: 0,
          failed: 1,
          latest_error: 'embedding API error 404: 404 page not found',
        };
      },
      processMemoryEmbeddingTasks: async () => ({ processed: 0, failed: 0 }),
    },
  });

  const response = await route.GET(jsonRequest({}, 'http://test.local/api/memory-index'));
  const payload = await response.json();

  assert.equal(payload.failed, 1);
  assert.equal(payload.latest_error, 'embedding API error 404: 404 page not found');
});

test('/api/memory-index GET reports blocked reason when queued tasks cannot drain', async () => {
  const route = requireFreshWithMocks('../src/app/api/memory-index/route.ts', {
    'next/server': jsonResponseMock(),
    '@/lib/db': { getDb: () => ({}) },
    '@/lib/settings': {
      loadSettings: () => ({
        memory_engine: {
          enabled: true,
          allow_external_memory_payloads: true,
          embedding_enabled: true,
          embedding_api_base: 'https://embedding.example/v1',
          embedding_model: '   ',
          embedding_dimension: 1024,
        },
      }),
    },
    '@/lib/memory-embeddings': {
      ensureMemoryEmbeddingTables: () => {},
      enqueueRebuildMemoryEmbeddings: () => 0,
      getMemoryIndexStatus: () => ({
        total: 3,
        ready: 0,
        pending: 2,
        processing: 0,
        failed: 0,
        latest_error: null,
      }),
      processMemoryEmbeddingTasks: async () => ({ processed: 0, failed: 0 }),
    },
  });

  const response = await route.GET(jsonRequest({}, 'http://test.local/api/memory-index'));
  const payload = await response.json();

  assert.equal(payload.queued, 2);
  assert.equal(payload.processing_blocked_reason, 'embedding_model_missing');
});

test('allow_memory_context_in_chat=false 时工作记忆包为空且不触发检索或外部增强', async () => {
  let localCalls = 0;
  let priorityCalls = 0;
  let embeddingCalls = 0;
  let rerankerCalls = 0;

  const result = await retrieveWorkingMemoryPackage({
    characterId: 'char-a',
    queryText: '不要把记忆放进聊天',
    settings: baseSettings({
      memory_engine: {
        allow_memory_context_in_chat: false,
        embedding_enabled: true,
        embedding_api_base: 'https://example.com/v1',
        embedding_api_key: 'test-key',
        embedding_model: 'fake-embedding',
        reranker_enabled: true,
        reranker_api_base: 'https://example.com/rerank',
        reranker_api_key: 'test-rerank-key',
        reranker_model: 'fake-reranker',
      },
    }),
    deps: {
      localRetrieve: () => {
        localCalls += 1;
        return [memory({ id: 'local-private', content: '不应注入的本地记忆。' })];
      },
      loadPriorityMemories: () => {
        priorityCalls += 1;
        return [memory({ id: 'priority-private', content: '不应注入的优先记忆。', pinned: 1 })];
      },
      embedText: async () => {
        embeddingCalls += 1;
        return [1, 0];
      },
      rerank: async () => {
        rerankerCalls += 1;
        return [];
      },
    },
  });

  assert.equal(result.text, '');
  assert.equal(result.selectedMemories.length, 0);
  assert.equal(result.diagnostics.candidateCount, 0);
  assert.equal(localCalls, 0);
  assert.equal(priorityCalls, 0);
  assert.equal(embeddingCalls, 0);
  assert.equal(rerankerCalls, 0);
});

test('allow_external_memory_payloads=false 时不调用 embedding/reranker，但保留本地工作记忆', async () => {
  let embeddingCalls = 0;
  let rerankerCalls = 0;

  const result = await retrieveWorkingMemoryPackage({
    characterId: 'char-a',
    queryText: '这轮只能本地检索',
    settings: baseSettings({
      memory_engine: {
        allow_external_memory_payloads: false,
        retrieval_mode: 'hybrid',
        embedding_enabled: true,
        embedding_api_base: 'https://example.com/v1',
        embedding_api_key: 'test-key',
        embedding_model: 'fake-embedding',
        reranker_enabled: true,
        reranker_api_base: 'https://example.com/rerank',
        reranker_api_key: 'test-rerank-key',
        reranker_model: 'fake-reranker',
      },
    }),
    deps: {
      embedText: async () => {
        embeddingCalls += 1;
        return [1, 0];
      },
      rerank: async () => {
        rerankerCalls += 1;
        return [];
      },
      localRetrieve: () => [
        memory({
          id: 'local-privacy',
          category: '偏好习惯',
          content: '主人要求关闭外部记忆载荷时，只使用本地记忆。',
          importance: 0.8,
        }),
      ],
      tokenCounter: text => Math.ceil(text.length / 4),
    },
  });

  assert.equal(embeddingCalls, 0);
  assert.equal(rerankerCalls, 0);
  assert.equal(result.mode, 'local');
  assert.match(result.text, /只使用本地记忆/);
});

test('/api/memories POST 成功后入队 created embedding task', async () => {
  const db = createMemoryDb();
  let triggerCalls = 0;
  const route = requireFreshWithMocks('../src/app/api/memories/route.ts', {
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
    character_id: 'char-a',
    category: '偏好习惯',
    content: '主人喜欢雨夜听轻音乐。',
    tags: ['雨夜'],
  }));
  const payload = await response.json();
  const task = db.prepare('SELECT memory_id, character_id, reason, status FROM memory_embedding_tasks').get();

  assert.equal(response.status, 201);
  assert.equal(task.memory_id, payload.id);
  assert.equal(task.character_id, 'char-a');
  assert.equal(task.reason, 'created');
  assert.equal(task.status, 'pending');
  assert.equal(triggerCalls, 1);
});

test('/api/memories/[id] PUT 仅在索引相关字段变更后入队 updated embedding task', async () => {
  const db = createMemoryDb();
  let triggerCalls = 0;
  db.prepare(`
    INSERT INTO memories (
      id, character_id, category, content, confidence, tags, source_msg_ids,
      memory_kind, importance, emotional_weight, status, pinned, last_used_at, usage_count, metadata,
      created_at, updated_at
    )
    VALUES (
      'mem-existing', 'char-a', '话题历史', '旧内容', 0.9, '[]', '[]',
      'general', 0.45, 0, 'active', 0, NULL, 0, '{}',
      '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'
    )
  `).run();

  const route = requireFreshWithMocks('../src/app/api/memories/[id]/route.ts', {
    'next/server': jsonResponseMock(),
    '@/lib/db': { getDb: () => db },
    '@/lib/memory-index-trigger': {
      triggerMemoryIndexProcessing: () => {
        triggerCalls += 1;
        return true;
      },
    },
  });

  await route.PUT(
    jsonRequest({ usage_count: 1 }),
    { params: Promise.resolve({ id: 'mem-existing' }) },
  );
  const afterUsageOnly = db.prepare('SELECT COUNT(*) as n FROM memory_embedding_tasks').get();
  assert.equal(afterUsageOnly.n, 0);
  assert.equal(triggerCalls, 0);

  const response = await route.PUT(
    jsonRequest({ content: '新内容', tags: ['更新'] }),
    { params: Promise.resolve({ id: 'mem-existing' }) },
  );
  const payload = await response.json();
  const task = db.prepare('SELECT memory_id, character_id, reason, status FROM memory_embedding_tasks').get();

  assert.equal(response.status, 200);
  assert.equal(payload.content, '新内容');
  assert.equal(task.memory_id, 'mem-existing');
  assert.equal(task.character_id, 'char-a');
  assert.equal(task.reason, 'updated');
  assert.equal(task.status, 'pending');
  assert.equal(triggerCalls, 1);
});

test('processMemoryEmbeddingTasks 并发 worker 不会重复处理同一批任务', async () => {
  const db = createMemoryDb();
  db.exec(`
    INSERT INTO memories (
      id, character_id, category, content, confidence, tags, source_msg_ids,
      memory_kind, importance, emotional_weight, status, pinned, last_used_at, usage_count, metadata,
      created_at, updated_at
    )
    VALUES
      (
        'mem-claim-a', 'char-a', '话题历史', '第一条待向量化记忆', 0.9, '[]', '[]',
        'general', 0.5, 0, 'active', 0, NULL, 0, '{}',
        '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'
      ),
      (
        'mem-claim-b', 'char-a', '话题历史', '第二条待向量化记忆', 0.9, '[]', '[]',
        'general', 0.5, 0, 'active', 0, NULL, 0, '{}',
        '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'
      );

    INSERT INTO memory_embedding_tasks (memory_id, character_id, reason, status, created_at, updated_at)
    VALUES
      ('mem-claim-a', 'char-a', 'rebuild', 'pending', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'),
      ('mem-claim-b', 'char-a', 'rebuild', 'pending', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
  `);

  let resolveFirstEmbedStarted;
  let releaseFirstEmbed;
  const firstEmbedStarted = new Promise(resolve => {
    resolveFirstEmbedStarted = resolve;
  });
  const firstEmbedReleased = new Promise(resolve => {
    releaseFirstEmbed = resolve;
  });
  const embeddedTexts = [];

  const embed = async (text) => {
    embeddedTexts.push(text);
    if (embeddedTexts.length === 1) {
      resolveFirstEmbedStarted();
      await firstEmbedReleased;
    }
    return [1, 0];
  };

  const firstWorker = processMemoryEmbeddingTasks(
    { api_base: 'https://embedding.example/v1', model: 'fake-embedding', dimension: 2 },
    { db, limit: 2, embed },
  );
  await firstEmbedStarted;

  const secondResult = await processMemoryEmbeddingTasks(
    { api_base: 'https://embedding.example/v1', model: 'fake-embedding', dimension: 2 },
    { db, limit: 2, embed },
  );
  releaseFirstEmbed();
  const firstResult = await firstWorker;

  const done = db.prepare("SELECT COUNT(*) as n FROM memory_embedding_tasks WHERE status = 'done'").get();
  const secondMemoryEmbeds = embeddedTexts.filter(text => text.includes('第二条待向量化记忆')).length;

  assert.equal(firstResult.processed + secondResult.processed, 2);
  assert.equal(done.n, 2);
  assert.equal(secondMemoryEmbeds, 1);
});

test('processMemoryEmbeddingTasks 后台任务优先批量生成 embedding', async () => {
  const db = createMemoryDb();
  db.exec(`
    INSERT INTO memories (
      id, character_id, category, content, confidence, tags, source_msg_ids,
      memory_kind, importance, emotional_weight, status, pinned, last_used_at, usage_count, metadata,
      created_at, updated_at
    )
    VALUES
      (
        'batch-mem-1', 'char-a', '偏好习惯', '批量记忆一。', 0.9, '[]', '[]',
        'user_preference', 0.8, 0, 'active', 0, NULL, 0, '{}',
        '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'
      ),
      (
        'batch-mem-2', 'char-a', '偏好习惯', '批量记忆二。', 0.9, '[]', '[]',
        'user_preference', 0.8, 0, 'active', 0, NULL, 0, '{}',
        '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'
      ),
      (
        'batch-mem-3', 'char-a', '偏好习惯', '批量记忆三。', 0.9, '[]', '[]',
        'user_preference', 0.8, 0, 'active', 0, NULL, 0, '{}',
        '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'
      );

    INSERT INTO memory_embedding_tasks (memory_id, character_id, reason, status, retry_count, created_at, updated_at)
    VALUES
      ('batch-mem-1', 'char-a', 'created', 'pending', 0, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'),
      ('batch-mem-2', 'char-a', 'created', 'pending', 0, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'),
      ('batch-mem-3', 'char-a', 'created', 'pending', 0, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
  `);

  const calls = [];
  const result = await processMemoryEmbeddingTasks(
    { provider: 'test-provider', model: 'batch-model', dimension: 2 },
    {
      db,
      limit: 8,
      embedBatch: async (texts) => {
        calls.push(texts);
        return texts.map((_text, index) => index === 0 ? [1, 0] : [0, 1]);
      },
    },
  );
  const readyRows = db.prepare('SELECT memory_id, status FROM memory_embeddings ORDER BY memory_id').all();

  assert.equal(result.processed, 3);
  assert.equal(result.failed, 0);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].length, 3);
  assert.deepEqual(readyRows.map(row => row.memory_id), ['batch-mem-1', 'batch-mem-2', 'batch-mem-3']);
});

test('processMemoryEmbeddingTasks 在 stop_current 删除已 claim 任务后不回写 embedding', async () => {
  const db = createMemoryDb();
  ensureMemoryEmbeddingTables(db);
  db.exec(`
    INSERT INTO memories (
      id, character_id, category, content, confidence, tags, source_msg_ids,
      memory_kind, importance, emotional_weight, status, pinned, last_used_at, usage_count, metadata,
      created_at, updated_at
    )
    VALUES (
      'mem-stop-claimed', 'char-a', '话题历史', '已 claim 后被停止的任务不应写回。', 0.9, '[]', '[]',
      'general', 0.5, 0, 'active', 0, NULL, 0, '{}',
      '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'
    );

    INSERT INTO memory_embedding_tasks (memory_id, character_id, reason, status, created_at, updated_at)
    VALUES ('mem-stop-claimed', 'char-a', 'rebuild', 'pending', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
  `);

  let resolveEmbedStarted;
  let releaseEmbed;
  const embedStarted = new Promise(resolve => {
    resolveEmbedStarted = resolve;
  });
  const embedReleased = new Promise(resolve => {
    releaseEmbed = resolve;
  });

  const worker = processMemoryEmbeddingTasks(
    { api_base: 'https://embedding.example/v1', model: 'fake-embedding', dimension: 2 },
    {
      db,
      limit: 1,
      embed: async () => {
        resolveEmbedStarted();
        await embedReleased;
        return [1, 0];
      },
    },
  );
  await embedStarted;

  const stopped = stopCurrentMemoryIndexTasks('char-a', db);
  releaseEmbed();
  const result = await worker;

  const embeddings = db.prepare('SELECT COUNT(*) as n FROM memory_embeddings').get();
  const tasks = db.prepare('SELECT COUNT(*) as n FROM memory_embedding_tasks').get();

  assert.deepEqual(stopped, { stopped_tasks: 1 });
  assert.deepEqual(result, { processed: 0, failed: 0 });
  assert.equal(embeddings.n, 0);
  assert.equal(tasks.n, 0);
});

test('processMemoryEmbeddingTasks 在 clear_index 删除已 claim 任务后不回写 embedding', async () => {
  const db = createMemoryDb();
  ensureMemoryEmbeddingTables(db);
  db.exec(`
    INSERT INTO memories (
      id, character_id, category, content, confidence, tags, source_msg_ids,
      memory_kind, importance, emotional_weight, status, pinned, last_used_at, usage_count, metadata,
      created_at, updated_at
    )
    VALUES (
      'mem-clear-claimed', 'char-a', '话题历史', '已 claim 后被清空索引的任务不应写回。', 0.9, '[]', '[]',
      'general', 0.5, 0, 'active', 0, NULL, 0, '{}',
      '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'
    );

    INSERT INTO memory_embedding_tasks (memory_id, character_id, reason, status, created_at, updated_at)
    VALUES ('mem-clear-claimed', 'char-a', 'rebuild', 'pending', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
  `);

  let resolveEmbedStarted;
  let releaseEmbed;
  const embedStarted = new Promise(resolve => {
    resolveEmbedStarted = resolve;
  });
  const embedReleased = new Promise(resolve => {
    releaseEmbed = resolve;
  });

  const worker = processMemoryEmbeddingTasks(
    { api_base: 'https://embedding.example/v1', model: 'fake-embedding', dimension: 2 },
    {
      db,
      limit: 1,
      embed: async () => {
        resolveEmbedStarted();
        await embedReleased;
        return [1, 0];
      },
    },
  );
  await embedStarted;

  const cleared = clearMemoryIndex('char-a', db);
  releaseEmbed();
  const result = await worker;

  const embeddings = db.prepare('SELECT COUNT(*) as n FROM memory_embeddings').get();
  const tasks = db.prepare('SELECT COUNT(*) as n FROM memory_embedding_tasks').get();

  assert.deepEqual(cleared, { cleared_embeddings: 0, cleared_tasks: 1 });
  assert.deepEqual(result, { processed: 0, failed: 0 });
  assert.equal(embeddings.n, 0);
  assert.equal(tasks.n, 0);
});

test('processMemoryEmbeddingTasks 遇到短暂超时会回到 pending 等待重试', async () => {
  const db = createMemoryDb();
  db.exec(`
    INSERT INTO memories (
      id, character_id, category, content, confidence, tags, source_msg_ids,
      memory_kind, importance, emotional_weight, status, pinned, last_used_at, usage_count, metadata,
      created_at, updated_at
    )
    VALUES (
      'mem-timeout-retry', 'char-a', '话题历史', '短暂超时后应该重新排队。', 0.9, '[]', '[]',
      'general', 0.5, 0, 'active', 0, NULL, 0, '{}',
      '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'
    );

    INSERT INTO memory_embedding_tasks (memory_id, character_id, reason, status, retry_count, created_at, updated_at)
    VALUES ('mem-timeout-retry', 'char-a', 'rebuild', 'pending', 0, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
  `);

  const result = await processMemoryEmbeddingTasks(
    { api_base: 'https://embedding.example/v1', model: 'fake-embedding', dimension: 2 },
    {
      db,
      limit: 1,
      embed: async () => {
        throw new Error('embedding request timed out after 10000ms');
      },
    },
  );
  const task = db.prepare('SELECT status, retry_count, error_message, claim_token FROM memory_embedding_tasks WHERE memory_id = ?')
    .get('mem-timeout-retry');

  assert.deepEqual(result, { processed: 0, failed: 0 });
  assert.deepEqual(task, {
    status: 'pending',
    retry_count: 1,
    error_message: 'embedding request timed out after 10000ms',
    claim_token: null,
  });
});

test('processMemoryEmbeddingTasks 不会立刻重试刚刚短暂超时的任务', async () => {
  const db = createMemoryDb();
  db.exec(`
    INSERT INTO memories (
      id, character_id, category, content, confidence, tags, source_msg_ids,
      memory_kind, importance, emotional_weight, status, pinned, last_used_at, usage_count, metadata,
      created_at, updated_at
    )
    VALUES (
      'mem-timeout-cooldown', 'char-a', '话题历史', '刚超时的任务。', 0.9, '[]', '[]',
      'general', 0.5, 0, 'active', 0, NULL, 0, '{}',
      '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'
    );

    INSERT INTO memory_embedding_tasks (memory_id, character_id, reason, status, retry_count, created_at, updated_at)
    VALUES ('mem-timeout-cooldown', 'char-a', 'rebuild', 'pending', 0, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
  `);

  let embedCalls = 0;
  await processMemoryEmbeddingTasks(
    { api_base: 'https://embedding.example/v1', model: 'fake-embedding', dimension: 2 },
    {
      db,
      limit: 1,
      embed: async () => {
        embedCalls += 1;
        throw new Error('embedding request timed out after 10000ms');
      },
    },
  );
  const secondResult = await processMemoryEmbeddingTasks(
    { api_base: 'https://embedding.example/v1', model: 'fake-embedding', dimension: 2 },
    {
      db,
      limit: 1,
      embed: async () => {
        embedCalls += 1;
        return [1, 0];
      },
    },
  );
  const task = db.prepare('SELECT status, retry_count FROM memory_embedding_tasks WHERE memory_id = ?')
    .get('mem-timeout-cooldown');

  assert.equal(embedCalls, 1);
  assert.deepEqual(secondResult, { processed: 0, failed: 0 });
  assert.deepEqual(task, { status: 'pending', retry_count: 1 });
});

test('processMemoryEmbeddingTasks 短暂超时超过最大尝试次数后才进入 failed', async () => {
  const db = createMemoryDb();
  db.exec(`
    INSERT INTO memories (
      id, character_id, category, content, confidence, tags, source_msg_ids,
      memory_kind, importance, emotional_weight, status, pinned, last_used_at, usage_count, metadata,
      created_at, updated_at
    )
    VALUES (
      'mem-timeout-final', 'char-a', '话题历史', '多次超时后才算失败。', 0.9, '[]', '[]',
      'general', 0.5, 0, 'active', 0, NULL, 0, '{}',
      '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'
    );

    INSERT INTO memory_embedding_tasks (memory_id, character_id, reason, status, retry_count, created_at, updated_at)
    VALUES ('mem-timeout-final', 'char-a', 'rebuild', 'pending', 2, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
  `);

  const result = await processMemoryEmbeddingTasks(
    { api_base: 'https://embedding.example/v1', model: 'fake-embedding', dimension: 2 },
    {
      db,
      limit: 1,
      embed: async () => {
        throw new Error('embedding request timed out after 10000ms');
      },
    },
  );
  const task = db.prepare('SELECT status, retry_count, error_message, claim_token FROM memory_embedding_tasks WHERE memory_id = ?')
    .get('mem-timeout-final');

  assert.deepEqual(result, { processed: 0, failed: 1 });
  assert.deepEqual(task, {
    status: 'failed',
    retry_count: 3,
    error_message: 'embedding request timed out after 10000ms',
    claim_token: null,
  });
});

test('embedText 按 OpenAI-compatible embedding 格式请求 float 向量', async () => {
  let requestUrl = '';
  let requestInit = null;
  const { embedText } = requireFreshWithMocks('../src/lib/memory-embeddings.ts', {
    '@/lib/ssrf-guard': {
      safeFetch: async (url, init) => {
        requestUrl = url;
        requestInit = init;
        return {
          ok: true,
          async json() {
            return { data: [{ embedding: [1, 0] }] };
          },
        };
      },
    },
  });

  const vector = await embedText('你好', {
    api_base: 'https://api-inference.modelscope.cn/v1',
    api_key: 'modelscope-token',
    model: 'Qwen/Qwen3-Embedding-8B',
    dimension: 2,
    timeout_ms: 500,
  });
  const body = JSON.parse(requestInit.body);

  assert.equal(requestUrl, 'https://api-inference.modelscope.cn/v1/embeddings');
  assert.equal(requestInit.method, 'POST');
  assert.equal(requestInit.headers.Authorization, 'Bearer modelscope-token');
  assert.deepEqual(body, {
    model: 'Qwen/Qwen3-Embedding-8B',
    input: '你好',
    encoding_format: 'float',
    dimensions: 2,
  });
  assert.deepEqual(Array.from(vector), [1, 0]);
});

test('embedText 超时失败时返回明确的超时原因', async () => {
  const { embedText } = requireFreshWithMocks('../src/lib/memory-embeddings.ts', {
    '@/lib/ssrf-guard': {
      safeFetch: async (_url, init) => new Promise((_resolve, reject) => {
        init.signal.addEventListener('abort', () => {
          reject(new Error('This operation was aborted'));
        });
      }),
    },
  });

  await assert.rejects(
    () => embedText('你好', {
      api_base: 'https://embedding.example/v1',
      model: 'embedding-model',
      timeout_ms: 1,
    }),
    /embedding request timed out after 1ms/,
  );
});

test('embedding 失败时回退到本地检索并继续生成工作记忆包', async () => {
  const result = await retrieveWorkingMemoryPackage({
    characterId: 'char-a',
    queryText: '我今天有点撑不住，想安静待一会儿',
    settings: baseSettings({
      memory_engine: {
        embedding_enabled: true,
        embedding_api_base: 'https://example.com/v1',
        embedding_api_key: 'test-key',
        embedding_model: 'fake-embedding',
      },
    }),
    deps: {
      embedText: async () => {
        throw new Error('embedding down');
      },
      localRetrieve: () => [
        memory({
          id: 'local-1',
          category: '偏好习惯',
          content: '主人难过时更希望先被安静陪伴，而不是立刻被讲道理。',
          importance: 0.8,
        }),
      ],
      tokenCounter: text => Math.ceil(text.length / 4),
    },
  });

  assert.equal(result.usedFallback, true);
  assert.match(result.text, /记忆上下文/);
  assert.match(result.text, /安静陪伴/);
  assert.doesNotMatch(result.text, /local-1|score/);
});

test('本地模式在未配置 embedding 时可用', async () => {
  const result = await retrieveWorkingMemoryPackage({
    characterId: 'char-a',
    queryText: '还记得我们之前约好的称呼吗',
    settings: baseSettings(),
    deps: {
      localRetrieve: () => [
        memory({
          id: 'local-2',
          category: '关系动态',
          content: '主人希望角色平时称呼自己为主人。',
          memory_kind: 'relationship_event',
          importance: 0.7,
        }),
      ],
      tokenCounter: text => Math.ceil(text.length / 4),
    },
  });

  assert.equal(result.mode, 'local');
  assert.match(result.text, /主人希望角色平时称呼自己为主人/);
});

test('工作记忆包会在预算内注入非空 memory profile', async () => {
  const result = await retrieveWorkingMemoryPackage({
    characterId: 'char-a',
    queryText: '我们现在关系怎么样',
    settings: baseSettings({
      memory_engine: {
        memory_package_token_budget: 80,
        profile_token_budget: 40,
      },
    }),
    deps: {
      localRetrieve: () => [
        memory({
          id: 'local-profile-context',
          category: '关系动态',
          content: '主人希望角色平时称呼自己为主人。',
          memory_kind: 'relationship_event',
          importance: 0.7,
        }),
      ],
      loadMemoryProfile: () => ({
        character_id: 'char-a',
        relationship_state: '主人和角色已经建立稳定亲密的陪伴关系。',
        recent_story_state: '',
        emotional_baseline: '',
        open_threads: ['毕业设计进度'],
        user_profile_summary: '',
        pinned_summary: '',
        updated_at: '2026-06-02T00:00:00.000Z',
      }),
      tokenCounter: text => Math.ceil(text.length / 4),
    },
  });

  assert.match(result.text, /### 记忆画像/);
  assert.match(result.text, /稳定亲密的陪伴关系/);
  assert.match(result.text, /毕业设计进度/);
  assert.match(result.text, /主人希望角色平时称呼自己为主人/);
  assert.ok(result.tokenCount <= 80);
});

test('空 memory profile 不改变无记忆检索的输出', async () => {
  const result = await retrieveWorkingMemoryPackage({
    characterId: 'char-a',
    queryText: '普通话题',
    settings: baseSettings(),
    deps: {
      localRetrieve: () => [],
      loadPriorityMemories: () => [],
      loadMemoryProfile: () => ({
        character_id: 'char-a',
        relationship_state: '',
        recent_story_state: '',
        emotional_baseline: '',
        open_threads: [],
        user_profile_summary: '',
        pinned_summary: '',
        updated_at: '2026-06-02T00:00:00.000Z',
      }),
      tokenCounter: text => Math.ceil(text.length / 4),
    },
  });

  assert.equal(result.text, '');
  assert.deepEqual(result.selectedMemories, []);
  assert.equal(result.tokenCount, 0);
});

test('memory_engine.enabled=false 且 limit_inject=false 时全量注入 active 记忆', async () => {
  let legacyCalls = 0;
  let localCalls = 0;
  let embeddingCalls = 0;
  let rerankerCalls = 0;

  const result = await retrieveWorkingMemoryPackage({
    characterId: 'char-a',
    queryText: '只匹配其中一条也要全量注入',
    settings: baseSettings({
      limit_inject: false,
      memory_engine: {
        enabled: false,
        retrieval_mode: 'hybrid',
        embedding_enabled: true,
        embedding_api_base: 'https://example.com/v1',
        embedding_api_key: 'test-key',
        embedding_model: 'fake-embedding',
        reranker_enabled: true,
        reranker_api_base: 'https://example.com/rerank',
        reranker_api_key: 'test-rerank-key',
        reranker_model: 'fake-reranker',
      },
    }),
    deps: {
      embedText: async () => {
        embeddingCalls += 1;
        return [1, 0];
      },
      loadEmbeddingRows: () => [],
      rerank: async () => {
        rerankerCalls += 1;
        return [];
      },
      loadLegacyMemories: () => {
        legacyCalls += 1;
        return [
          memory({ id: 'legacy-a', content: '第一条旧版全量记忆。' }),
          memory({ id: 'legacy-b', content: '第二条旧版全量记忆，即使 query 不相关也要进入。' }),
          memory({ id: 'legacy-c', content: '第三条旧版全量记忆。' }),
        ];
      },
      localRetrieve: () => {
        localCalls += 1;
        return [
          memory({
            id: 'local-should-not-be-used',
            category: '偏好习惯',
            content: '增强关闭且不限量时不应走本地检索。',
            importance: 0.75,
          }),
        ];
      },
      tokenCounter: text => Math.ceil(text.length / 4),
    },
  });

  assert.equal(legacyCalls, 1);
  assert.equal(localCalls, 0);
  assert.equal(embeddingCalls, 0);
  assert.equal(rerankerCalls, 0);
  assert.equal(result.mode, 'full');
  assert.equal(result.usedFallback, false);
  assert.deepEqual(result.selectedMemories.map(item => item.id), ['legacy-a', 'legacy-b', 'legacy-c']);
  assert.match(result.text, /第一条旧版全量记忆/);
  assert.match(result.text, /第二条旧版全量记忆/);
  assert.match(result.text, /第三条旧版全量记忆/);
  assert.doesNotMatch(result.text, /增强关闭且不限量时不应走本地检索/);
});

test('legacy full injection 遇到超长普通记忆会 skip 后继续扫描短记忆', async () => {
  const markedIds = [];
  const result = await retrieveWorkingMemoryPackage({
    characterId: 'char-a',
    queryText: '全量注入时不要被中间的超长普通记忆挡住',
    settings: baseSettings({
      limit_inject: false,
      memory_engine: {
        enabled: false,
        memory_package_token_budget: 70,
        final_top_k: 20,
      },
    }),
    deps: {
      loadLegacyMemories: () => [
        memory({ id: 'legacy-short-a', content: '第一条短旧版记忆。', importance: 0.3 }),
        memory({
          id: 'legacy-huge-ordinary',
          content: '这条超长普通旧版记忆会独占预算。'.repeat(80),
          importance: 0.2,
        }),
        memory({ id: 'legacy-short-b', content: '后续短旧版记忆仍应进入。', importance: 0.3 }),
      ],
      markMemoriesUsed: ids => {
        markedIds.push(...ids);
      },
      tokenCounter: text => (text.includes('超长普通旧版记忆') ? 999 : Math.ceil(text.length / 4)),
    },
  });
  await new Promise(resolve => setImmediate(resolve));

  assert.deepEqual(result.selectedMemories.map(item => item.id), ['legacy-short-a', 'legacy-short-b']);
  assert.match(result.text, /第一条短旧版记忆/);
  assert.match(result.text, /后续短旧版记忆仍应进入/);
  assert.doesNotMatch(result.text, /超长普通旧版记忆/);
  assert.deepEqual(markedIds, ['legacy-short-a', 'legacy-short-b']);
  assert.ok(result.tokenCount <= 70);
});

test('预算裁剪优先保留 pinned 与高 importance 记忆', async () => {
  const result = await retrieveWorkingMemoryPackage({
    characterId: 'char-a',
    queryText: '我需要你陪我一下',
    settings: baseSettings({
      limit_inject: false,
      memory_engine: {
        memory_package_token_budget: 70,
        final_top_k: 20,
      },
    }),
    deps: {
      localRetrieve: () => [
        memory({
          id: 'ordinary',
          content: '普通聊天记录：主人之前讨论过一个很长很长的日常话题，但它和当前陪伴需求关系不大。'.repeat(4),
          importance: 0.1,
        }),
      ],
      loadPriorityMemories: () => [
        memory({
          id: 'pinned',
          category: '关系动态',
          content: '角色承诺在主人情绪低落时，会先安静陪伴主人。',
          memory_kind: 'character_promise',
          pinned: 1,
          importance: 0.95,
          emotional_weight: 0.9,
        }),
        memory({
          id: 'important',
          category: '偏好习惯',
          content: '主人被安慰时更喜欢温柔短句和稳定陪伴。',
          memory_kind: 'user_preference',
          importance: 0.9,
          emotional_weight: 0.7,
        }),
      ],
      tokenCounter: text => Math.ceil(text.length / 4),
    },
  });

  assert.match(result.text, /先安静陪伴主人/);
  assert.match(result.text, /温柔短句和稳定陪伴/);
  assert.doesNotMatch(result.text, /很长很长的日常话题/);
  assert.ok(result.tokenCount <= 70);
});

test('token 硬预算会裁剪普通记忆，limit_inject=false 也不会无限注入', async () => {
  const result = await retrieveWorkingMemoryPackage({
    characterId: 'char-a',
    queryText: '普通话题',
    settings: baseSettings({
      limit_inject: false,
      memory_engine: {
        memory_package_token_budget: 54,
        final_top_k: 50,
      },
    }),
    deps: {
      localRetrieve: () => Array.from({ length: 20 }, (_, idx) => memory({
        id: `m-${idx}`,
        content: `普通相关回忆 ${idx}：这是一段会占用预算的内容。`,
        importance: 0.2,
      })),
      tokenCounter: text => Math.ceil(text.length / 4),
    },
  });

  assert.ok(result.selectedMemories.length < 20);
  assert.ok(result.tokenCount <= 54);
});

test('total_retrieval_timeout_ms 会限制整条增强检索链路并回退本地工作记忆', async () => {
  const startedAt = Date.now();
  let embeddingSignal;
  let embeddingSignalAbortEvent = false;
  let embeddingFinished = false;
  const result = await retrieveWorkingMemoryPackage({
    characterId: 'char-a',
    queryText: '增强检索很慢时也不能阻塞聊天',
    settings: baseSettings({
      memory_engine: {
        embedding_enabled: true,
        embedding_api_base: 'https://example.com/v1',
        embedding_api_key: 'test-key',
        embedding_model: 'slow-embedding',
        embedding_timeout_ms: 200,
        total_retrieval_timeout_ms: 10,
      },
    }),
    deps: {
      embedText: async (_text, config) => {
        embeddingSignal = config.signal;
        embeddingSignal?.addEventListener('abort', () => {
          embeddingSignalAbortEvent = true;
        });
        await new Promise(resolve => setTimeout(resolve, 80));
        embeddingFinished = true;
        return [1, 0];
      },
      loadEmbeddingRows: () => [],
      localRetrieve: () => [
        memory({
          id: 'timeout-fallback',
          category: '偏好习惯',
          content: '增强检索超时后，应快速使用本地记忆继续聊天。',
          importance: 0.8,
        }),
      ],
      tokenCounter: text => Math.ceil(text.length / 4),
    },
  });
  const elapsedMs = Date.now() - startedAt;

  assert.ok(elapsedMs < 70, `expected total timeout fallback before slow embedding finished, got ${elapsedMs}ms`);
  assert.equal(result.mode, 'local');
  assert.equal(result.usedFallback, true);
  assert.equal(result.diagnostics.totalRetrievalTimedOut, true);
  assert.match(result.text, /快速使用本地记忆继续聊天/);
  assert.ok(embeddingSignal, 'expected embedding call to receive an AbortSignal');
  assert.equal(embeddingSignal.aborted, true);
  assert.equal(embeddingSignalAbortEvent, true);
  assert.equal(embeddingFinished, false);
});

test('检索完成后只回写最终注入记忆的 usage 信息', async () => {
  const markedIds = [];
  const result = await retrieveWorkingMemoryPackage({
    characterId: 'char-a',
    queryText: '只统计真正注入的记忆',
    settings: baseSettings({
      memory_engine: {
        memory_package_token_budget: 90,
        final_top_k: 10,
      },
    }),
    deps: {
      localRetrieve: () => [
        memory({
          id: 'used-in-package',
          category: '偏好习惯',
          content: '这条短记忆会进入工作记忆包。',
          importance: 0.8,
        }),
        memory({
          id: 'not-in-package',
          category: '话题历史',
          content: '不应回写 usage 的超长候选。'.repeat(30),
          importance: 0.2,
        }),
      ],
      markMemoriesUsed: ids => {
        markedIds.push(...ids);
      },
      tokenCounter: text => (text.includes('不应回写 usage') ? 999 : Math.ceil(text.length / 4)),
    },
  });

  assert.deepEqual(result.selectedMemories.map(item => item.id), ['used-in-package']);
  assert.deepEqual(markedIds, ['used-in-package']);
});

test('默认 usage 回写会批量更新已注入记忆的 usage_count 和 last_used_at', async () => {
  const db = createMemoryDb();
  db.exec(`
    INSERT INTO memories (
      id, character_id, category, content, confidence, tags, source_msg_ids,
      memory_kind, importance, emotional_weight, status, pinned, last_used_at, usage_count, metadata,
      created_at, updated_at
    )
    VALUES
      (
        'db-used', 'char-a', '偏好习惯', '这条数据库记忆会进入工作记忆包。', 0.9, '[]', '[]',
        'user_preference', 0.8, 0, 'active', 0, NULL, 2, '{}',
        '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'
      ),
      (
        'db-unused', 'char-a', '话题历史', '这条数据库候选不会被注入。', 0.9, '[]', '[]',
        'general', 0.2, 0, 'active', 0, NULL, 5, '{}',
        '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'
      );
  `);
  const freshRetrieval = requireFreshWithMocks('../src/lib/memory-retrieval.ts', {
    '@/lib/db': { getDb: () => db },
  });

  await freshRetrieval.retrieveWorkingMemoryPackage({
    characterId: 'char-a',
    queryText: '真实回写 usage',
    settings: baseSettings({
      memory_engine: {
        memory_package_token_budget: 90,
        final_top_k: 10,
      },
    }),
    deps: {
      localRetrieve: () => [
        memory({
          id: 'db-used',
          category: '偏好习惯',
          content: '这条数据库记忆会进入工作记忆包。',
          importance: 0.8,
          usage_count: 2,
        }),
        memory({
          id: 'db-unused',
          category: '话题历史',
          content: '不应被注入的数据库候选。'.repeat(30),
          importance: 0.2,
          usage_count: 5,
        }),
      ],
      loadMemoryProfile: () => null,
      tokenCounter: text => (text.includes('不应被注入') ? 999 : Math.ceil(text.length / 4)),
    },
  });
  await new Promise(resolve => setImmediate(resolve));

  const used = db.prepare('SELECT usage_count, last_used_at FROM memories WHERE id = ?').get('db-used');
  const unused = db.prepare('SELECT usage_count, last_used_at FROM memories WHERE id = ?').get('db-unused');

  assert.equal(used.usage_count, 3);
  assert.equal(typeof used.last_used_at, 'string');
  assert.equal(unused.usage_count, 5);
  assert.equal(unused.last_used_at, null);
});

test('limit_inject=false 时最终注入不受 final_top_k 条数限制，只受 token 预算限制', async () => {
  const result = await retrieveWorkingMemoryPackage({
    characterId: 'char-a',
    queryText: '这些短记忆都能放进预算',
    settings: baseSettings({
      limit_inject: false,
      memory_engine: {
        memory_package_token_budget: 1000,
        keyword_top_k: 40,
        final_top_k: 3,
      },
    }),
    deps: {
      localRetrieve: (_query, _characterId, limit) => {
        assert.ok(limit >= 10);
        return Array.from({ length: 10 }, (_, idx) => memory({
          id: `limit-free-${idx}`,
          content: `短记忆 ${idx}。`,
          importance: 0.5,
        }));
      },
      tokenCounter: text => Math.ceil(text.length / 50),
    },
  });

  assert.ok(result.selectedMemories.length > 3);
  assert.ok(result.tokenCount <= 1000);
});

test('reranker 前优先传入召回相关性最高的候选，而不是业务分最高的候选', async () => {
  const rerankedDocs = [];
  await retrieveWorkingMemoryPackage({
    characterId: 'char-a',
    queryText: '语义上最相关的是向量候选',
    settings: baseSettings({
      memory_engine: {
        embedding_enabled: true,
        embedding_api_base: 'https://example.com/v1',
        embedding_api_key: 'test-key',
        embedding_model: 'fake-embedding',
        reranker_enabled: true,
        reranker_api_base: 'https://example.com/rerank',
        reranker_api_key: 'test-rerank-key',
        reranker_model: 'fake-reranker',
        vector_top_k: 1,
        reranker_top_k: 1,
      },
    }),
    deps: {
      embedText: async () => [1, 0],
      loadEmbeddingRows: () => [
        { memory_id: 'vector-relevant', embedding_blob: embeddingToBlob(normalizeEmbedding([1, 0])) },
      ],
      loadMemoriesByIds: () => [
        memory({
          id: 'vector-relevant',
          content: '这条候选的向量相关性最高。',
          importance: 0.2,
        }),
      ],
      loadPriorityMemories: () => [
        memory({
          id: 'pinned-business',
          category: '关系动态',
          content: '这条钉选记忆业务分很高，但召回相关性较低。',
          pinned: 1,
          importance: 0.95,
          emotional_weight: 0.9,
        }),
      ],
      localRetrieve: () => [],
      rerank: async (_query, docs) => {
        rerankedDocs.push(...docs.map(doc => doc.id));
        return docs.map(doc => ({ id: doc.id, score: 1 }));
      },
      tokenCounter: text => Math.ceil(text.length / 4),
    },
  });

  assert.deepEqual(rerankedDocs, ['vector-relevant']);
});

test('ready embedding 维度与配置不符时给出诊断并回退本地检索', async () => {
  const loadOptions = [];
  const result = await retrieveWorkingMemoryPackage({
    characterId: 'char-a',
    queryText: '维度不符时也要能回忆',
    settings: baseSettings({
      memory_engine: {
        embedding_enabled: true,
        embedding_api_base: 'https://example.com/v1',
        embedding_api_key: 'test-key',
        embedding_model: 'fake-embedding',
        embedding_dimension: 3,
      },
    }),
    deps: {
      embedText: async () => [1, 0, 0],
      loadEmbeddingRows: (_characterId, options) => {
        loadOptions.push(options);
        if (options.dimension === 3) return [];
        return [
          { memory_id: 'wrong-dimension', dimension: 2, embedding_blob: embeddingToBlob(normalizeEmbedding([1, 0])) },
        ];
      },
      loadMemoriesByIds: () => [
        memory({
          id: 'wrong-dimension',
          content: '这条维度不符的向量不应被使用。',
          importance: 0.9,
        }),
      ],
      localRetrieve: () => [
        memory({
          id: 'dimension-fallback',
          content: '向量维度不符时，应回退到本地记忆。',
          importance: 0.8,
        }),
      ],
      tokenCounter: text => Math.ceil(text.length / 4),
    },
  });

  assert.match(result.diagnostics.embeddingFailed, /dimension mismatch/i);
  assert.ok(loadOptions.some(option => option.dimension === 3));
  assert.ok(loadOptions.some(option => option.dimension === undefined));
  assert.match(result.text, /回退到本地记忆/);
  assert.doesNotMatch(result.text, /维度不符的向量不应被使用/);
});

test('embedding BLOB 可读写，并按归一化点积排序', () => {
  const query = normalizeEmbedding([1, 0, 0]);
  const rowA = { memory_id: 'a', embedding_blob: embeddingToBlob(normalizeEmbedding([0.2, 0.9, 0])) };
  const rowB = { memory_id: 'b', embedding_blob: embeddingToBlob(normalizeEmbedding([3, 0, 0])) };

  assert.deepEqual(Array.from(blobToEmbedding(rowB.embedding_blob)), [1, 0, 0]);
  assert.equal(dotProduct(query, blobToEmbedding(rowB.embedding_blob)), 1);

  const ranked = rankEmbeddingRows(query, [rowA, rowB], 2);
  assert.deepEqual(ranked.map(item => item.row.memory_id), ['b', 'a']);
});

test('后续超预算的高优先级记忆也会截断注入', async () => {
  const markedIds = [];
  const result = await retrieveWorkingMemoryPackage({
    characterId: 'char-a',
    queryText: '你还记得多个约定吗',
    settings: baseSettings({
      limit_inject: false,
      memory_engine: { memory_package_token_budget: 100, final_top_k: 20 },
    }),
    deps: {
      loadPriorityMemories: () => [
        memory({
          id: 'first-promise',
          category: '关系动态',
          content: '角色承诺会在主人焦虑时先稳定回应。',
          memory_kind: 'character_promise',
          pinned: 1,
          importance: 0.95,
        }),
        memory({
          id: 'second-promise',
          category: '关系动态',
          content: '第二个也必须兑现的承诺：角色会认真记录主人说过的重要边界。'.repeat(30),
          memory_kind: 'character_promise',
          pinned: 1,
          importance: 0.94,
        }),
      ],
      localRetrieve: () => [
        memory({ id: 'trivia', content: '主人随口提过喜欢苹果。', importance: 0.1 }),
      ],
      markMemoriesUsed: ids => {
        markedIds.push(...ids);
      },
      tokenCounter: text => Math.ceil(text.length / 4),
    },
  });
  await new Promise(resolve => setImmediate(resolve));

  assert.deepEqual(result.selectedMemories.map(item => item.id), ['first-promise', 'second-promise']);
  assert.match(result.text, /角色承诺会在主人焦虑时先稳定回应/);
  assert.match(result.text, /第二个也必须兑现的承诺/);
  assert.match(result.text, /…/);
  assert.doesNotMatch(result.text, /喜欢苹果/);
  assert.deepEqual(markedIds, ['first-promise', 'second-promise']);
  assert.ok(result.tokenCount <= 100);
});

test('单条超预算的高优先级记忆被截断注入,不被低优先级小记忆反超', async () => {
  const result = await retrieveWorkingMemoryPackage({
    characterId: 'char-a',
    queryText: '你还记得答应过我的约定吗',
    settings: baseSettings({
      limit_inject: false,
      memory_engine: { memory_package_token_budget: 100, final_top_k: 20 },
    }),
    deps: {
      loadPriorityMemories: () => [
        memory({
          id: 'big-promise',
          category: '关系动态',
          content: '记得答应过主人的约定。'.repeat(40),
          memory_kind: 'character_promise',
          pinned: 1,
          importance: 0.95,
        }),
      ],
      localRetrieve: () => [
        memory({ id: 'trivia', content: '主人随口提过喜欢苹果。', importance: 0.1 }),
      ],
      tokenCounter: text => Math.ceil(text.length / 4),
    },
  });

  // 高优先级承诺单条即超预算:应截断注入(含开头 + 省略号),而非整条丢弃让低优先级琐事反超。
  assert.equal(result.selectedMemories.length, 1);
  assert.equal(result.selectedMemories[0].id, 'big-promise');
  assert.match(result.text, /记得答应过主人的约定/);
  assert.match(result.text, /…/);
  assert.doesNotMatch(result.text, /喜欢苹果/);
  assert.ok(result.tokenCount <= 100);
});

test('memory_package_token_budget 超大值被钳制到硬上界,守住 token 预算硬上限', () => {
  const { resolveMemoryEngineConfig } = require('../src/lib/memory-retrieval.ts');
  const config = resolveMemoryEngineConfig({ memory_engine: { memory_package_token_budget: 999999 } });
  assert.equal(config.memory_package_token_budget, 32000);
});
