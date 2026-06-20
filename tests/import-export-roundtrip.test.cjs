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

function importRequest(payload, query = '') {
  const raw = JSON.stringify(payload);
  const suffix = query ? `?${query}` : '';
  return {
    headers: {
      get(name) {
        return name.toLowerCase() === 'content-length' ? String(Buffer.byteLength(raw)) : null;
      },
    },
    nextUrl: new URL(`http://test.local/api/import${suffix}`),
    async text() {
      return raw;
    },
  };
}

function rawImportRequest(raw, query = '') {
  const suffix = query ? `?${query}` : '';
  return {
    headers: {
      get() {
        return null;
      },
    },
    nextUrl: new URL(`http://test.local/api/import${suffix}`),
    async text() {
      return raw;
    },
  };
}

function createImportDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE characters (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL
    );

    CREATE TABLE conversations (
      id TEXT PRIMARY KEY,
      character_id TEXT NOT NULL,
      title TEXT NOT NULL DEFAULT '',
      ignore_memory INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE messages (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      token_count INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      metadata TEXT NOT NULL DEFAULT '{}',
      seq INTEGER NOT NULL DEFAULT 0
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

    CREATE TABLE character_memory_profiles (
      character_id TEXT PRIMARY KEY,
      profile_name TEXT NOT NULL DEFAULT '',
      relationship_state TEXT NOT NULL DEFAULT '',
      recent_story_state TEXT NOT NULL DEFAULT '',
      emotional_baseline TEXT NOT NULL DEFAULT '',
      open_threads TEXT NOT NULL DEFAULT '[]',
      user_profile_summary TEXT NOT NULL DEFAULT '',
      pinned_summary TEXT NOT NULL DEFAULT '',
      updated_at TEXT NOT NULL
    );

    CREATE TABLE character_memory_profile_versions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      character_id TEXT NOT NULL,
      version_number INTEGER NOT NULL,
      snapshot_json TEXT NOT NULL,
      reason TEXT NOT NULL,
      task_id INTEGER,
      created_at TEXT NOT NULL
    );

    CREATE TABLE memory_embeddings (
      memory_id TEXT NOT NULL,
      character_id TEXT NOT NULL,
      provider TEXT NOT NULL,
      model TEXT NOT NULL,
      dimension INTEGER NOT NULL,
      embedding_blob BLOB NOT NULL,
      normalized INTEGER NOT NULL DEFAULT 1,
      embedding_text_hash TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'ready',
      error_message TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE UNIQUE INDEX idx_memory_embeddings_unique_model
      ON memory_embeddings(memory_id, provider, model, dimension);
  `);
  db.prepare('INSERT INTO characters (id, name) VALUES (?, ?)').run('target-char', '目标角色');
  return db;
}

function loadImportRoute(db) {
  return requireFreshWithMocks('../src/app/api/import/route.ts', {
    'next/server': jsonResponseMock(),
    '@/lib/db': { getDb: () => db },
    '@/lib/character-card-import': { normalizeCharacterCard: () => null },
  });
}

function loadExportRoute(db) {
  return requireFreshWithMocks('../src/app/api/export/route.ts', {
    'next/server': jsonResponseMock(),
    '@/lib/db': { getDb: () => db },
  });
}

function parseJson(value) {
  return JSON.parse(value);
}

test('/api/import round-trips memory v2 fields, source message ids, ignore_memory, and sparse seq', async () => {
  const db = createImportDb();
  const route = loadImportRoute(db);
  const archivedMetadata = {
    previousStatus: 'active',
    archived_at: '2026-06-06T08:00:00.000Z',
    reason: 'manual',
  };

  const payload = {
    version: 2,
    memories: [
      {
        id: 'old-mem-archived',
        character_id: 'old-char',
        category: '重要事件',
        content: '钉选归档记忆',
        confidence: 0.93,
        tags: ['承诺', '重要'],
        source_msg_ids: ['old-user-msg', 'missing-msg', 'old-assistant-msg'],
        memory_kind: 'relationship_event',
        importance: 0.91,
        emotional_weight: 0.72,
        status: 'archived',
        pinned: 1,
        last_used_at: '2026-06-06T10:00:00.000Z',
        usage_count: 5,
        metadata: JSON.stringify(archivedMetadata),
        created_at: '2026-06-05T10:00:00.000Z',
        updated_at: '2026-06-06T11:00:00.000Z',
      },
      {
        id: 'old-mem-summarized',
        character_id: 'old-char',
        category: '话题历史',
        content: '已摘要覆盖记忆',
        status: 'summarized',
        metadata: { summary_id: 'summary-1' },
        created_at: '2026-06-05T12:00:00.000Z',
        updated_at: '2026-06-06T12:00:00.000Z',
      },
    ],
    conversations: [
      {
        id: 'old-conv',
        character_id: 'old-char',
        title: '导出的对话',
        ignore_memory: 1,
        created_at: '2026-06-05T09:00:00.000Z',
        updated_at: '2026-06-05T09:10:00.000Z',
        messages: [
          {
            id: 'old-user-msg',
            role: 'user',
            content: '用户原消息',
            token_count: 7,
            created_at: '2026-06-05T09:01:00.000Z',
            metadata: { mood: 'curious' },
            seq: 10,
          },
          {
            id: 'old-assistant-msg',
            role: 'assistant',
            content: '助手原回复',
            token_count: 9,
            created_at: '2026-06-05T09:02:00.000Z',
            metadata: '{"tone":"warm"}',
            seq: 42,
          },
        ],
      },
    ],
  };

  const response = await route.POST(importRequest(
    payload,
    'target_character_id=target-char&include_character=0',
  ));
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.memoriesImported, 2);
  assert.equal(body.conversationsImported, 1);
  assert.equal(body.messagesImported, 2);

  const conversation = db.prepare('SELECT * FROM conversations WHERE title = ?').get('导出的对话');
  assert.equal(conversation.ignore_memory, 1);

  const userMessage = db.prepare('SELECT * FROM messages WHERE content = ?').get('用户原消息');
  const assistantMessage = db.prepare('SELECT * FROM messages WHERE content = ?').get('助手原回复');
  assert.equal(userMessage.seq, 10);
  assert.equal(assistantMessage.seq, 42);
  assert.notEqual(userMessage.id, 'old-user-msg');
  assert.notEqual(assistantMessage.id, 'old-assistant-msg');

  const archivedMemory = db.prepare('SELECT * FROM memories WHERE content = ?').get('钉选归档记忆');
  assert.equal(archivedMemory.memory_kind, 'relationship_event');
  assert.equal(archivedMemory.importance, 0.91);
  assert.equal(archivedMemory.emotional_weight, 0.72);
  assert.equal(archivedMemory.status, 'archived');
  assert.equal(archivedMemory.pinned, 1);
  assert.equal(archivedMemory.last_used_at, '2026-06-06T10:00:00.000Z');
  assert.equal(archivedMemory.usage_count, 5);
  assert.deepEqual(parseJson(archivedMemory.metadata), archivedMetadata);
  assert.deepEqual(parseJson(archivedMemory.tags), ['承诺', '重要']);
  assert.deepEqual(parseJson(archivedMemory.source_msg_ids), [userMessage.id, assistantMessage.id]);

  const summarizedMemory = db.prepare('SELECT * FROM memories WHERE content = ?').get('已摘要覆盖记忆');
  assert.equal(summarizedMemory.status, 'summarized');
  assert.deepEqual(parseJson(summarizedMemory.metadata), { summary_id: 'summary-1' });
});

test('/api/import fills v2 defaults for old packages without those fields', async () => {
  const db = createImportDb();
  const route = loadImportRoute(db);
  const payload = {
    memories: [
      {
        id: 'old-mem-legacy',
        character_id: 'old-char',
        category: '偏好习惯',
        content: '旧包偏好记忆',
        confidence: 0.77,
        tags: ['旧包'],
        created_at: '2026-06-04T10:00:00.000Z',
        updated_at: '2026-06-04T10:00:00.000Z',
      },
    ],
  };

  const response = await route.POST(importRequest(
    payload,
    'target_character_id=target-char&include_character=0',
  ));

  assert.equal(response.status, 200);
  const memory = db.prepare('SELECT * FROM memories WHERE content = ?').get('旧包偏好记忆');
  assert.equal(memory.memory_kind, 'user_preference');
  assert.equal(memory.importance, 0.65);
  assert.equal(memory.emotional_weight, 0);
  assert.equal(memory.status, 'active');
  assert.equal(memory.pinned, 0);
  assert.equal(memory.usage_count, 0);
  assert.equal(memory.last_used_at, null);
  assert.deepEqual(parseJson(memory.metadata), {});
});

test('/api/import enforces the secondary size limit by UTF-8 bytes, not UTF-16 string length', async () => {
  const db = createImportDb();
  const route = loadImportRoute(db);
  const raw = `"${'界'.repeat(17_500_000)}"`;

  assert.ok(raw.length < 50 * 1024 * 1024);
  assert.ok(Buffer.byteLength(raw, 'utf8') > 50 * 1024 * 1024);

  const response = await route.POST(rawImportRequest(raw));
  const body = await response.json();

  assert.equal(response.status, 413);
  assert.deepEqual(body, { error: '导入文件过大' });
});

test('/api/export downgrades malformed memory JSON arrays instead of blocking export', async () => {
  const db = {
    prepare(sql) {
      if (sql.includes('SELECT 1 AS exists_flag FROM sqlite_master')) {
        return { get: () => undefined }; // 所有表都不存在
      }
      if (sql.includes('SELECT * FROM characters ORDER BY updated_at DESC')) {
        return { all: () => [] };
      }
      if (sql.includes('SELECT * FROM memories ORDER BY character_id, updated_at DESC')) {
        return {
          all: () => [
            {
              id: 'bad-memory',
              character_id: 'char-1',
              category: '话题历史',
              content: '旧历史记忆',
              tags: '{',
              source_msg_ids: 'not json',
              updated_at: '2026-06-08T00:00:00.000Z',
            },
          ],
        };
      }
      if (sql.includes('SELECT * FROM conversations ORDER BY character_id, updated_at DESC')) {
        return { all: () => [] };
      }
      throw new Error(`unexpected sql: ${sql}`);
    },
  };
  const route = loadExportRoute(db);
  const request = {
    nextUrl: new URL('http://test.local/api/export?type=all'),
  };

  const response = await route.GET(request);
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.deepEqual(payload.memories[0].tags, []);
  assert.deepEqual(payload.memories[0].source_msg_ids, []);
});

test('/api/import round-trips memory profile, profile versions, and embeddings with id remapping', async () => {
  const db = createImportDb();
  const route = loadImportRoute(db);

  // 构造一个 embedding blob：4 个 float32 (16 字节)
  const embeddingBuffer = Buffer.alloc(16);
  embeddingBuffer.writeFloatLE(0.1, 0);
  embeddingBuffer.writeFloatLE(0.2, 4);
  embeddingBuffer.writeFloatLE(0.3, 8);
  embeddingBuffer.writeFloatLE(0.4, 12);

  const profileSnapshot = {
    character_id: 'old-char',
    profile_name: '旧画像名',
    relationship_state: '信任',
    recent_story_state: '一起冒险',
    emotional_baseline: '开心',
    open_threads: ['未完成约定'],
    user_profile_summary: '主人喜欢猫',
    pinned_summary: '承诺养猫',
    updated_at: '2026-06-01T00:00:00.000Z',
  };

  const payload = {
    version: 2,
    memories: [
      {
        id: 'old-mem-1',
        character_id: 'old-char',
        category: '重要事件',
        content: '一起养了猫',
        created_at: '2026-06-01T00:00:00.000Z',
        updated_at: '2026-06-01T00:00:00.000Z',
      },
    ],
    memory_profile: {
      character_id: 'old-char',
      profile_name: '旧画像名',
      relationship_state: '信任',
      recent_story_state: '一起冒险',
      emotional_baseline: '开心',
      open_threads: JSON.stringify(['未完成约定']),
      user_profile_summary: '主人喜欢猫',
      pinned_summary: '承诺养猫',
      updated_at: '2026-06-01T00:00:00.000Z',
    },
    memory_profile_versions: [
      {
        character_id: 'old-char',
        version_number: 1,
        snapshot_json: JSON.stringify(profileSnapshot),
        reason: 'initial',
        task_id: null,
        created_at: '2026-06-01T00:00:00.000Z',
      },
      {
        character_id: 'old-char',
        version_number: 2,
        snapshot_json: JSON.stringify({ ...profileSnapshot, relationship_state: '深厚信任' }),
        reason: 'profile_update',
        task_id: 42,
        created_at: '2026-06-02T00:00:00.000Z',
      },
    ],
    memory_embeddings: [
      {
        memory_id: 'old-mem-1',
        character_id: 'old-char',
        provider: 'openai-compatible',
        model: 'text-embedding-3-small',
        dimension: 4,
        embedding_blob: embeddingBuffer,
        normalized: 1,
        embedding_text_hash: 'hash-abc',
        status: 'ready',
        error_message: null,
        created_at: '2026-06-01T00:00:00.000Z',
        updated_at: '2026-06-01T00:00:00.000Z',
      },
    ],
  };

  const response = await route.POST(importRequest(
    payload,
    'target_character_id=target-char&include_character=0',
  ));
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.memoriesImported, 1);
  assert.equal(body.profilesImported, 1);
  assert.equal(body.profileVersionsImported, 2);
  assert.equal(body.embeddingsImported, 1);

  // 验证画像写入：character_id 重映射到 target-char，open_threads 保持 JSON 字符串
  const profile = db.prepare('SELECT * FROM character_memory_profiles WHERE character_id = ?').get('target-char');
  assert.equal(profile.profile_name, '旧画像名');
  assert.equal(profile.relationship_state, '信任');
  assert.equal(profile.user_profile_summary, '主人喜欢猫');
  assert.deepEqual(parseJson(profile.open_threads), ['未完成约定']);

  // 验证画像版本历史：character_id 重映射，version_number 保留，snapshot_json 透传
  const versions = db.prepare(
    'SELECT * FROM character_memory_profile_versions WHERE character_id = ? ORDER BY version_number ASC',
  ).all('target-char');
  assert.equal(versions.length, 2);
  assert.equal(versions[0].version_number, 1);
  assert.equal(versions[0].reason, 'initial');
  assert.equal(versions[1].version_number, 2);
  assert.equal(versions[1].reason, 'profile_update');
  assert.equal(versions[1].task_id, 42);
  assert.deepEqual(parseJson(versions[1].snapshot_json), { ...profileSnapshot, relationship_state: '深厚信任' });

  // 验证 embedding：memory_id 重映射到新记忆 id，character_id 重映射到 target-char
  const newMemory = db.prepare('SELECT * FROM memories WHERE content = ?').get('一起养了猫');
  const embedding = db.prepare('SELECT * FROM memory_embeddings WHERE memory_id = ?').get(newMemory.id);
  assert.equal(embedding.character_id, 'target-char');
  assert.equal(embedding.provider, 'openai-compatible');
  assert.equal(embedding.model, 'text-embedding-3-small');
  assert.equal(embedding.dimension, 4);
  assert.equal(embedding.embedding_text_hash, 'hash-abc');
  assert.equal(embedding.status, 'ready');
  // 验证 blob 内容还原正确（Float32 有精度损失，用近似比较）
  const restoredBuffer = embedding.embedding_blob;
  assert.ok(Math.abs(restoredBuffer.readFloatLE(0) - 0.1) < 1e-6);
  assert.ok(Math.abs(restoredBuffer.readFloatLE(4) - 0.2) < 1e-6);
  assert.ok(Math.abs(restoredBuffer.readFloatLE(8) - 0.3) < 1e-6);
  assert.ok(Math.abs(restoredBuffer.readFloatLE(12) - 0.4) < 1e-6);
});

test('/api/import skips embeddings whose memory was not imported (orphan vector)', async () => {
  const db = createImportDb();
  const route = loadImportRoute(db);

  const embeddingBuffer = Buffer.alloc(8);
  embeddingBuffer.writeFloatLE(0.5, 0);
  embeddingBuffer.writeFloatLE(0.6, 4);

  const payload = {
    version: 2,
    // 导入一条真实记忆，但 embedding 指向不存在的 memory id → 应该跳过
    memories: [
      {
        id: 'real-mem-1',
        character_id: 'old-char',
        category: '重要事件',
        content: '真实存在的记忆',
        created_at: '2026-06-01T00:00:00.000Z',
        updated_at: '2026-06-01T00:00:00.000Z',
      },
    ],
    memory_embeddings: [
      {
        memory_id: 'nonexistent-mem', // 这条 memory id 没有对应的记忆
        character_id: 'old-char',
        provider: 'openai-compatible',
        model: 'fake-model',
        dimension: 2,
        embedding_blob: embeddingBuffer,
        normalized: 1,
        embedding_text_hash: 'hash-orphan',
        status: 'ready',
        error_message: null,
        created_at: '2026-06-01T00:00:00.000Z',
        updated_at: '2026-06-01T00:00:00.000Z',
      },
    ],
  };

  const response = await route.POST(importRequest(
    payload,
    'target_character_id=target-char&include_character=0',
  ));
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.memoriesImported, 1);
  assert.equal(body.embeddingsImported, 0); // 孤儿向量被跳过
  // 确认没有写入任何 embedding
  const count = db.prepare('SELECT COUNT(*) as count FROM memory_embeddings').get().count;
  assert.equal(count, 0);
});

test('/api/import handles open_threads as array or JSON string', async () => {
  const db = createImportDb();
  const route = loadImportRoute(db);

  // 测试 open_threads 以数组形式提供（某些导出工具可能这样序列化）
  const payload = {
    version: 2,
    memory_profile: {
      character_id: 'old-char',
      profile_name: '数组格式画像',
      relationship_state: '',
      recent_story_state: '',
      emotional_baseline: '',
      open_threads: ['待办1', '待办2'],
      user_profile_summary: '',
      pinned_summary: '',
      updated_at: '2026-06-01T00:00:00.000Z',
    },
  };

  const response = await route.POST(importRequest(
    payload,
    'target_character_id=target-char&include_character=0',
  ));
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.profilesImported, 1);

  const profile = db.prepare('SELECT * FROM character_memory_profiles WHERE character_id = ?').get('target-char');
  assert.equal(profile.profile_name, '数组格式画像');
  assert.deepEqual(parseJson(profile.open_threads), ['待办1', '待办2']);
});

test('/api/import skips profile versions with duplicate version_number', async () => {
  const db = createImportDb();
  const route = loadImportRoute(db);

  // 先导入一次，建立 version 1
  const firstPayload = {
    version: 2,
    memory_profile_versions: [
      {
        character_id: 'old-char',
        version_number: 1,
        snapshot_json: JSON.stringify({ character_id: 'old-char', profile_name: 'v1' }),
        reason: 'initial',
        created_at: '2026-06-01T00:00:00.000Z',
      },
    ],
  };
  await route.POST(importRequest(firstPayload, 'target_character_id=target-char&include_character=0'));

  // 再导入一次，version 1 应该被跳过，version 2 应该写入
  const secondPayload = {
    version: 2,
    memory_profile_versions: [
      {
        character_id: 'old-char',
        version_number: 1,
        snapshot_json: JSON.stringify({ character_id: 'old-char', profile_name: 'v1-duplicate' }),
        reason: 'should-skip',
        created_at: '2026-06-02T00:00:00.000Z',
      },
      {
        character_id: 'old-char',
        version_number: 2,
        snapshot_json: JSON.stringify({ character_id: 'old-char', profile_name: 'v2' }),
        reason: 'should-import',
        created_at: '2026-06-02T00:00:00.000Z',
      },
    ],
  };
  const response = await route.POST(importRequest(secondPayload, 'target_character_id=target-char&include_character=0'));
  const body = await response.json();

  assert.equal(response.status, 200);
  // 第二次导入：version 1 冲突跳过，version 2 写入
  assert.equal(body.profileVersionsImported, 1);

  const versions = db.prepare(
    'SELECT * FROM character_memory_profile_versions WHERE character_id = ? ORDER BY version_number ASC',
  ).all('target-char');
  assert.equal(versions.length, 2);
  assert.equal(versions[0].version_number, 1);
  assert.equal(versions[0].reason, 'initial'); // 第一次的保留
  assert.equal(versions[1].version_number, 2);
  assert.equal(versions[1].reason, 'should-import');
});

test('/api/export includes memory profiles, profile versions, and embeddings for single character', async () => {
  const db = createImportDb();
  // 先插入一条画像 + 版本 + embedding，再导出
  db.prepare(`
    INSERT INTO character_memory_profiles (
      character_id, profile_name, relationship_state, recent_story_state,
      emotional_baseline, open_threads, user_profile_summary, pinned_summary, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run('target-char', '导出测试画像', '信任', '冒险', '开心', JSON.stringify(['线程1']), '用户摘要', '钉选摘要', '2026-06-01T00:00:00.000Z');

  db.prepare(`
    INSERT INTO character_memory_profile_versions (
      character_id, version_number, snapshot_json, reason, task_id, created_at
    ) VALUES (?, ?, ?, ?, ?, ?)
  `).run('target-char', 1, JSON.stringify({ character_id: 'target-char', profile_name: 'v1' }), 'initial', null, '2026-06-01T00:00:00.000Z');

  // 插入一条记忆 + embedding
  db.prepare(`
    INSERT INTO memories (id, character_id, category, content, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run('mem-export-1', 'target-char', '重要事件', '导出测试记忆', '2026-06-01T00:00:00.000Z', '2026-06-01T00:00:00.000Z');

  const embeddingBuffer = Buffer.alloc(8);
  embeddingBuffer.writeFloatLE(0.7, 0);
  embeddingBuffer.writeFloatLE(0.8, 4);
  db.prepare(`
    INSERT INTO memory_embeddings (
      memory_id, character_id, provider, model, dimension, embedding_blob,
      normalized, embedding_text_hash, status, error_message, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    'mem-export-1', 'target-char', 'openai-compatible', 'test-model', 2, embeddingBuffer,
    1, 'export-hash', 'ready', null, '2026-06-01T00:00:00.000Z', '2026-06-01T00:00:00.000Z',
  );

  const route = loadExportRoute(db);
  const request = {
    nextUrl: new URL('http://test.local/api/export?type=character&id=target-char'),
  };

  const response = await route.GET(request);
  const payload = await response.json();

  assert.equal(response.status, 200);
  // 验证画像导出
  assert.ok(payload.memory_profile);
  assert.equal(payload.memory_profile.profile_name, '导出测试画像');
  assert.equal(payload.memory_profile.relationship_state, '信任');

  // 验证画像版本导出
  assert.ok(Array.isArray(payload.memory_profile_versions));
  assert.equal(payload.memory_profile_versions.length, 1);
  assert.equal(payload.memory_profile_versions[0].version_number, 1);
  assert.equal(payload.memory_profile_versions[0].reason, 'initial');

  // 验证 embedding 导出
  assert.ok(Array.isArray(payload.memory_embeddings));
  assert.equal(payload.memory_embeddings.length, 1);
  assert.equal(payload.memory_embeddings[0].memory_id, 'mem-export-1');
  assert.equal(payload.memory_embeddings[0].model, 'test-model');
  assert.equal(payload.memory_embeddings[0].dimension, 2);
  // embedding_blob 应该是 { type: 'Buffer', data: [...] } 格式
  assert.ok(payload.memory_embeddings[0].embedding_blob);
  assert.equal(payload.memory_embeddings[0].embedding_blob.type, 'Buffer');
  assert.ok(Array.isArray(payload.memory_embeddings[0].embedding_blob.data));
  assert.equal(payload.memory_embeddings[0].embedding_blob.data.length, 8);
});

test('/api/export respects include_profiles=0 and include_embeddings=0', async () => {
  const db = createImportDb();
  db.prepare(`
    INSERT INTO character_memory_profiles (character_id, profile_name, updated_at)
    VALUES (?, ?, ?)
  `).run('target-char', '不应导出', '2026-06-01T00:00:00.000Z');

  const route = loadExportRoute(db);
  const request = {
    nextUrl: new URL('http://test.local/api/export?type=character&id=target-char&include_profiles=0&include_embeddings=0'),
  };

  const response = await route.GET(request);
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.equal(payload.memory_profile, null);
  assert.deepEqual(payload.memory_profile_versions, []);
  assert.deepEqual(payload.memory_embeddings, []);
});

test('/api/export skips embeddings when include_memories=0', async () => {
  const db = createImportDb();
  const route = loadExportRoute(db);
  // include_memories=0 时，即使 include_embeddings 默认开启，也应该跳过 embedding
  const request = {
    nextUrl: new URL('http://test.local/api/export?type=character&id=target-char&include_memories=0'),
  };

  const response = await route.GET(request);
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.deepEqual(payload.memories, []);
  assert.deepEqual(payload.memory_embeddings, []);
});
