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
    return require(modulePath);
  } finally {
    Module._load = originalLoad;
  }
}

function createExtractionDb() {
  const db = new Database(':memory:');
  db.exec(`
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
      emotional_weight REAL NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'active',
      pinned INTEGER NOT NULL DEFAULT 0,
      last_used_at TEXT,
      usage_count INTEGER NOT NULL DEFAULT 0,
      metadata TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
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

    CREATE TABLE memory_extraction_candidates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id INTEGER,
      character_id TEXT NOT NULL,
      conversation_id TEXT,
      raw_candidate_json TEXT,
      raw_response TEXT,
      status TEXT NOT NULL,
      error_reason TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
  return db;
}

function settings() {
  return {
    limit_inject: true,
    memory_max_inject: 30,
  };
}

function longConversation() {
  return '用户: 请记住我难过时希望先被安静陪伴，再慢慢分析问题。'.repeat(4);
}

function loadMemoryEngine(db, response, mocks = {}) {
  return requireFreshWithMocks('../src/lib/memory-engine.ts', {
    '@/lib/db': { getDb: () => db },
    '@/lib/api-client': {
      chatCompletion: async () => response,
      REASONING_SAFE_MAX_TOKENS: 16384,
    },
    '@/lib/memory-index-trigger': { triggerMemoryIndexProcessing: () => false },
    ...mocks,
  });
}

function insertExisting(db, overrides = {}) {
  db.prepare(`
    INSERT INTO memories (
      id, character_id, category, content, confidence, tags, source_msg_ids,
      memory_kind, importance, emotional_weight, status, pinned, last_used_at,
      usage_count, metadata, created_at, updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?)
  `).run(
    overrides.id || 'mem-existing',
    overrides.character_id || 'char-a',
    overrides.category || '关系动态',
    overrides.content || '角色承诺以后主人难过时，会先安静陪伴主人。',
    overrides.confidence ?? 0.8,
    JSON.stringify(overrides.tags || ['陪伴']),
    JSON.stringify(overrides.source_msg_ids || ['msg-old']),
    overrides.memory_kind || 'character_promise',
    overrides.importance ?? 0.85,
    overrides.emotional_weight ?? 0.8,
    overrides.status || 'active',
    overrides.pinned ? 1 : 0,
    overrides.usage_count ?? 0,
    JSON.stringify(overrides.metadata || {}),
    overrides.created_at || '2026-06-01T00:00:00.000Z',
    overrides.updated_at || '2026-06-01T00:00:00.000Z',
  );
}

test('extractMemories 将队列提供的 messageIds 写入 source_msg_ids', async () => {
  const db = createExtractionDb();
  const { extractMemories } = loadMemoryEngine(db, JSON.stringify({
    memories: [{
      category: '偏好习惯',
      memory_kind: 'user_preference',
      content: '主人难过时希望先被安静陪伴。',
      tags: ['陪伴'],
      importance: 0.8,
      emotional_weight: 0.6,
      lifecycle_action: 'insert',
    }],
  }));

  const result = await extractMemories('char-a', longConversation(), settings(), {
    messageIds: ['msg-user-1', 'msg-assistant-1'],
  });
  const memory = db.prepare('SELECT source_msg_ids FROM memories').get();

  assert.equal(result.insertCount, 1);
  assert.deepEqual(JSON.parse(memory.source_msg_ids), ['msg-user-1', 'msg-assistant-1']);
});

test('extractMemories 成功入队 embedding task 后触发索引处理', async () => {
  const db = createExtractionDb();
  let triggerCount = 0;
  const { extractMemories } = loadMemoryEngine(db, JSON.stringify({
    memories: [{
      category: '偏好习惯',
      memory_kind: 'user_preference',
      content: '主人难过时希望先被安静陪伴。',
      tags: ['陪伴'],
      importance: 0.8,
      emotional_weight: 0.6,
      lifecycle_action: 'insert',
    }],
  }), {
    '@/lib/memory-index-trigger': {
      triggerMemoryIndexProcessing: () => {
        triggerCount++;
        return true;
      },
    },
  });

  const result = await extractMemories('char-a', longConversation(), settings(), {
    messageIds: ['msg-user-trigger'],
  });
  const taskCount = db.prepare("SELECT COUNT(*) as count FROM memory_embedding_tasks WHERE status = 'pending'").get();

  assert.equal(result.insertCount, 1);
  assert.equal(taskCount.count, 1);
  assert.equal(triggerCount, 1);
});

test('extractMemories 入队未创建新任务或入队异常时不触发索引处理', async () => {
  const originalConsoleError = console.error;
  console.error = () => {};
  try {
    for (const mode of ['false', 'throw']) {
      const db = createExtractionDb();
      let triggerCount = 0;
      const { extractMemories } = loadMemoryEngine(db, JSON.stringify({
        memories: [{
          category: '偏好习惯',
          memory_kind: 'user_preference',
          content: `主人难过时希望先被安静陪伴 ${mode}。`,
          tags: ['陪伴'],
          importance: 0.8,
          emotional_weight: 0.6,
          lifecycle_action: 'insert',
        }],
      }), {
        '@/lib/memory-embeddings': {
          enqueueMemoryEmbeddingTask: () => {
            if (mode === 'throw') throw new Error('enqueue failed');
            return false;
          },
        },
        '@/lib/memory-index-trigger': {
          triggerMemoryIndexProcessing: () => {
            triggerCount++;
            return true;
          },
        },
      });

      const result = await extractMemories('char-a', longConversation(), settings(), {
        messageIds: [`msg-user-${mode}`],
      });

      assert.deepEqual(result, { insertCount: 1, mergeCount: 0 }, mode);
      assert.equal(triggerCount, 0, mode);
    }
  } finally {
    console.error = originalConsoleError;
  }
});

test('LLM 非空响应但无法形成正式记忆时写入候选隔离区', async () => {
  const db = createExtractionDb();
  const rawResponse = '模型返回了一段无法解析为 JSON 的候选内容';
  const { extractMemories } = loadMemoryEngine(db, rawResponse);

  const result = await extractMemories('char-a', longConversation(), settings(), {
    messageIds: ['msg-user-2'],
  });
  const candidates = db.prepare('SELECT * FROM memory_extraction_candidates').all();
  const memoryCount = db.prepare('SELECT COUNT(*) as count FROM memories').get();
  const taskCount = db.prepare('SELECT COUNT(*) as count FROM memory_embedding_tasks').get();

  assert.deepEqual(result, { insertCount: 0, mergeCount: 0 });
  assert.equal(memoryCount.count, 0);
  assert.equal(taskCount.count, 0);
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].character_id, 'char-a');
  assert.equal(candidates[0].status, 'repairable');
  assert.equal(candidates[0].raw_response, rawResponse);
  assert.match(candidates[0].error_reason, /parse|valid/i);
});

test('lifecycle_action insert 跳过合并，supersede 会失效旧记忆后插入新记忆', async () => {
  const db = createExtractionDb();
  insertExisting(db, { id: 'mem-old-promise' });
  const { extractMemories } = loadMemoryEngine(db, JSON.stringify({
    memories: [
      {
        category: '关系动态',
        memory_kind: 'character_promise',
        content: '角色承诺以后主人难过时，会先安静陪伴主人。',
        tags: ['陪伴'],
        importance: 0.9,
        emotional_weight: 0.85,
        lifecycle_action: 'insert',
      },
      {
        category: '关系动态',
        memory_kind: 'character_promise',
        content: '角色承诺以后主人难过时，会先安静陪伴主人，再询问是否需要分析。',
        tags: ['陪伴'],
        importance: 0.9,
        emotional_weight: 0.85,
        lifecycle_action: 'supersede',
      },
    ],
  }));

  const result = await extractMemories('char-a', longConversation(), settings(), {
    messageIds: ['msg-user-3'],
  });
  const rows = db.prepare('SELECT id, status, metadata, content FROM memories ORDER BY created_at ASC, id ASC').all();
  const superseded = rows.find(row => row.id === 'mem-old-promise');
  const activeRows = rows.filter(row => row.status === 'active');

  assert.equal(result.insertCount, 2);
  assert.equal(result.mergeCount, 0);
  assert.equal(rows.length, 3);
  assert.equal(superseded.status, 'superseded');
  assert.equal(JSON.parse(superseded.metadata).supersededBy.action, 'memory_extraction_supersede');
  assert.equal(activeRows.length, 2);
  assert.ok(activeRows.some(row => row.content.includes('再询问是否需要分析')));
});

test('本地校正会抬升承诺权重，并避免把角色承诺写成用户事实', async () => {
  const db = createExtractionDb();
  const { extractMemories } = loadMemoryEngine(db, JSON.stringify({
    memories: [{
      category: '基础信息',
      memory_kind: 'user_fact',
      content: '我会记得以后主人难过时先安抚主人。',
      tags: ['承诺'],
      importance: 0.2,
      emotional_weight: 0.1,
      lifecycle_action: 'insert',
    }, {
      category: '话题历史',
      memory_kind: 'general',
      content: '主人随口聊过今天午饭吃了面。',
      tags: ['午饭'],
      importance: 0.95,
      emotional_weight: 0.4,
      lifecycle_action: 'insert',
    }],
  }));

  await extractMemories('char-a', longConversation(), settings(), {
    messageIds: ['msg-user-4'],
  });
  const rows = db.prepare('SELECT category, memory_kind, importance, emotional_weight, content FROM memories ORDER BY content').all();
  const promise = rows.find(row => row.content.includes('我会记得'));
  const casual = rows.find(row => row.content.includes('午饭'));

  assert.equal(promise.category, '关系动态');
  assert.equal(promise.memory_kind, 'character_promise');
  assert.ok(promise.importance >= 0.8);
  assert.ok(promise.emotional_weight >= 0.7);
  assert.equal(casual.memory_kind, 'general');
  assert.ok(casual.importance <= 0.6);
});

test('memory-queue drain 会把任务来源 messageIds 传给 extractMemories', async () => {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE memory_tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      character_id TEXT NOT NULL,
      conversation_id TEXT NOT NULL,
      message_ids TEXT NOT NULL DEFAULT '[]',
      status TEXT NOT NULL DEFAULT 'pending',
      merge_count INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE messages (
      id TEXT PRIMARY KEY,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      metadata TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      seq INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE characters (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL
    );
  `);
  db.prepare("INSERT INTO characters (id, name) VALUES ('char-a', '艾莉丝')").run();
  db.prepare(`
    INSERT INTO messages (id, role, content, metadata, created_at, seq)
    VALUES
      ('msg-user-queue', 'user', '请记住我难过时希望先被安静陪伴。', '{}', '2026-06-02T00:00:00.000Z', 1),
      ('msg-assistant-queue', 'assistant', '我会记得，以后会先安静陪伴主人。', '{}', '2026-06-02T00:00:01.000Z', 2)
  `).run();

  let captured = null;
  const extracted = new Promise(resolve => {
    const queue = requireFreshWithMocks('../src/lib/memory-queue.ts', {
      '@/lib/db': { getDb: () => db },
      '@/lib/settings': { loadSettings: () => settings() },
      '@/lib/memory-engine': {
        extractMemories: async (characterId, conversationText, loadedSettings, options) => {
          captured = { characterId, conversationText, loadedSettings, options };
          resolve();
          return { insertCount: 1, mergeCount: 0 };
        },
      },
    });

    queue.enqueueExtraction('char-a', 'conv-a', [
      { id: 'msg-user-queue' },
      { id: 'msg-assistant-queue' },
    ]);
  });

  await extracted;

  assert.equal(captured.characterId, 'char-a');
  assert.match(captured.conversationText, /艾莉丝/);
  assert.deepEqual(captured.options, {
    messageIds: ['msg-user-queue', 'msg-assistant-queue'],
    taskId: 1,
    conversationId: 'conv-a',
  });
});

test('extractMemories 为推理模型把 max_tokens 抬到安全下限', async () => {
  const db = createExtractionDb();
  let capturedMaxTokens = null;
  const { extractMemories } = requireFreshWithMocks('../src/lib/memory-engine.ts', {
    '@/lib/db': { getDb: () => db },
    '@/lib/api-client': {
      chatCompletion: async (passedSettings) => {
        capturedMaxTokens = passedSettings.max_tokens;
        return JSON.stringify({ memories: [] });
      },
      REASONING_SAFE_MAX_TOKENS: 16384,
    },
  });

  // 用户聊天 max_tokens 偏小（4096），提取请求应被抬到 >= 16384，避免推理模型思考耗尽 token
  await extractMemories('char-a', longConversation(), { ...settings(), max_tokens: 4096 }, {
    messageIds: ['msg-user-1'],
  });

  assert.equal(capturedMaxTokens, 16384);
});
