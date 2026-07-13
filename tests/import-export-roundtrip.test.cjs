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
      name TEXT NOT NULL,
      avatar_url TEXT,
      basic_info TEXT NOT NULL DEFAULT '',
      personality TEXT NOT NULL DEFAULT '',
      scenario TEXT NOT NULL DEFAULT '',
      greeting TEXT NOT NULL DEFAULT '',
      example_dialogue TEXT NOT NULL DEFAULT '',
      system_prompt TEXT NOT NULL DEFAULT '',
      other_info TEXT NOT NULL DEFAULT '',
      image_tags TEXT NOT NULL DEFAULT '',
      user_image_tags TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT '',
      updated_at TEXT NOT NULL DEFAULT ''
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

function loadImportRoute(db, useRealCardNormalizer = false) {
  const mocks = {
    'next/server': jsonResponseMock(),
    '@/lib/db': { getDb: () => db },
  };
  if (!useRealCardNormalizer) {
    mocks['@/lib/character-card-import'] = { normalizeCharacterCard: () => null };
  }
  return requireFreshWithMocks('../src/app/api/import/route.ts', mocks);
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

function assertImportTablesEmpty(db) {
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM characters WHERE id <> 'target-char'").get().count, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM conversations').get().count, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM messages').get().count, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM memories').get().count, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM character_memory_profiles').get().count, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM character_memory_profile_versions').get().count, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM memory_embeddings').get().count, 0);
}

test('/api/import accepts a real SillyTavern v2 character card fixture', async () => {
  const db = createImportDb();
  const route = loadImportRoute(db, true);
  const card = {
    spec: 'chara_card_v2',
    spec_version: '2.0',
    data: {
      name: '露米',
      description: '来自月光图书馆的记录员。',
      creator: 'fixture-author',
      character_version: '1.2',
      personality: '安静、敏锐',
      scenario: '深夜图书馆',
      first_mes: '你终于来了。',
      mes_example: '<START>\n用户：还没睡吗？\n露米：在等你。',
      system_prompt: '保持角色口吻。',
      post_history_instructions: '不要跳出角色。',
      creator_notes: '真实 v2 fixture',
      tags: ['librarian', '', 'moonlight'],
      avatar: '/cards/lumi.png',
    },
  };

  const response = await route.POST(importRequest(card));
  const payload = await response.json();
  const imported = db.prepare('SELECT * FROM characters WHERE name = ?').get('露米');

  assert.equal(response.status, 200);
  assert.equal(payload.imported, 1);
  assert.ok(imported);
  assert.equal(imported.avatar_url, '/cards/lumi.png');
  assert.equal(imported.personality, '安静、敏锐');
  assert.equal(imported.greeting, '你终于来了。');
  assert.equal(imported.image_tags, 'librarian, moonlight');
  assert.match(imported.basic_info, /【角色描述】\n来自月光图书馆的记录员。/);
  assert.match(imported.basic_info, /【创作者】\nfixture-author/);
  assert.match(imported.other_info, /【历史后置指令】\n不要跳出角色。/);
});

test('/api/import round-trips memory v2 fields, source message ids, ignore_memory, and rebuilds continuous seq', async () => {
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
  const { estimateTokens } = require('../src/lib/token-counter.ts');
  // 外部稀疏/非连续 seq 必须重建为会话内 1..N，保证游标分页不漏消息。
  assert.equal(userMessage.seq, 1);
  assert.equal(assistantMessage.seq, 2);
  assert.notEqual(userMessage.id, 'old-user-msg');
  assert.notEqual(assistantMessage.id, 'old-assistant-msg');
  assert.equal(userMessage.token_count, estimateTokens('用户原消息'));
  assert.equal(assistantMessage.token_count, estimateTokens('助手原回复'));
  assert.equal(parseJson(userMessage.metadata).token_count_provenance.source, 'server');
  assert.equal(parseJson(assistantMessage.metadata).token_count_provenance.source, 'server');

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

test('/api/import rejects explicit invalid role/status/memory_kind with record location before any writes', async (t) => {
  const basePayload = {
    version: 2,
    character: {
      id: 'invalid-enum-char',
      name: '非法枚举不应导入',
    },
    conversations: [
      {
        id: 'invalid-enum-conv',
        character_id: 'invalid-enum-char',
        title: '非法枚举测试',
        messages: [
          { id: 'valid-message', role: 'user', content: '有效前置消息' },
          { id: 'invalid-message', role: 'assistant', content: '待替换枚举值' },
        ],
      },
    ],
    memories: [
      {
        id: 'valid-memory',
        character_id: 'invalid-enum-char',
        category: '重要事件',
        content: '有效前置记忆',
        memory_kind: 'relationship_event',
        status: 'active',
      },
      {
        id: 'invalid-memory',
        character_id: 'invalid-enum-char',
        category: '偏好习惯',
        content: '待替换枚举值',
        memory_kind: 'user_preference',
        status: 'active',
      },
    ],
  };

  const cases = [
    {
      name: 'message role',
      mutate(payload) {
        payload.conversations[0].messages[1].role = 'tool';
      },
      expected: {
        error: '导入数据包含非法枚举值',
        collection: 'conversations[0].messages',
        index: 1,
        field: 'role',
        value: 'tool',
      },
    },
    {
      name: 'memory status',
      mutate(payload) {
        payload.memories[1].status = 'ACTIVE';
      },
      expected: {
        error: '导入数据包含非法枚举值',
        collection: 'memories',
        index: 1,
        field: 'status',
        value: 'ACTIVE',
      },
    },
    {
      name: 'memory kind',
      mutate(payload) {
        payload.memories[1].memory_kind = 'personal_fact';
      },
      expected: {
        error: '导入数据包含非法枚举值',
        collection: 'memories',
        index: 1,
        field: 'memory_kind',
        value: 'personal_fact',
      },
    },
  ];

  for (const testCase of cases) {
    await t.test(testCase.name, async () => {
      const db = createImportDb();
      const route = loadImportRoute(db);
      const payload = structuredClone(basePayload);
      testCase.mutate(payload);

      const response = await route.POST(importRequest(payload));
      const body = await response.json();

      assert.equal(response.status, 400);
      assert.deepEqual(body, testCase.expected);
      assertImportTablesEmpty(db);
    });
  }
});

test('/api/import prepares repeated insert and lookup statements once while preserving id remapping', async () => {
  const db = createImportDb();
  const originalPrepare = db.prepare.bind(db);
  const prepareCounts = new Map();
  db.prepare = function countedPrepare(sql) {
    const normalized = sql.replace(/\s+/g, ' ').trim();
    prepareCounts.set(normalized, (prepareCounts.get(normalized) || 0) + 1);
    return originalPrepare(sql);
  };
  const route = loadImportRoute(db);
  const payload = {
    version: 2,
    conversations: [
      {
        id: 'prepare-conv-1',
        character_id: 'ignored-for-target',
        title: '第一段',
        messages: [
          { id: 'prepare-user-1', role: 'user', content: '第一条', seq: 1 },
          { id: 'prepare-assistant-1', role: 'assistant', content: '第二条', seq: 2 },
        ],
      },
      {
        id: 'prepare-conv-2',
        character_id: 'ignored-for-target',
        title: '第二段',
        messages: [
          { id: 'prepare-user-2', role: 'user', content: '第三条', seq: 1 },
          { id: 'prepare-assistant-2', role: 'assistant', content: '第四条', seq: 2 },
        ],
      },
    ],
    memories: [
      {
        id: 'prepare-memory-1',
        character_id: 'ignored-for-target',
        category: '重要事件',
        content: '第一段完整引用',
        source_msg_ids: ['prepare-user-1', 'prepare-assistant-1'],
      },
      {
        id: 'prepare-memory-2',
        character_id: 'ignored-for-target',
        category: '重要事件',
        content: '第二段完整引用',
        source_msg_ids: ['prepare-user-2', 'prepare-assistant-2'],
      },
    ],
  };

  const response = await route.POST(importRequest(
    payload,
    'target_character_id=target-char&include_character=0',
  ));

  assert.equal(response.status, 200);
  for (const [sql, count] of prepareCounts) {
    if (/^(INSERT INTO|SELECT id FROM characters WHERE id = \?)/.test(sql)) {
      assert.equal(count, 1, `statement should be prepared once: ${sql}`);
    }
  }

  const memories = db.prepare('SELECT content, source_msg_ids FROM memories ORDER BY content').all();
  assert.equal(memories.length, 2);
  for (const memory of memories) {
    const sourceIds = parseJson(memory.source_msg_ids);
    assert.equal(sourceIds.length, 2);
    for (const sourceId of sourceIds) {
      assert.ok(db.prepare('SELECT 1 FROM messages WHERE id = ?').get(sourceId));
    }
  }
});

test('/api/import enforces the secondary size limit by UTF-8 bytes, not UTF-16 string length', async () => {
  const db = createImportDb();
  const route = loadImportRoute(db);
  // 70M 个「界」字：UTF-16 长度 70M < 200MB，但 UTF-8 字节数 210MB > 200MB
  const raw = `"${'界'.repeat(70_000_000)}"`;

  assert.ok(raw.length < 200 * 1024 * 1024);
  assert.ok(Buffer.byteLength(raw, 'utf8') > 200 * 1024 * 1024);

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
    'target_character_id=target-char&include_character=0&include_embeddings=1',
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

test('/api/import rebuilds duplicate/non-integer seq into continuous 1..N order', async () => {
  const db = createImportDb();
  const route = loadImportRoute(db);
  const payload = {
    version: 2,
    conversations: [
      {
        id: 'seq-conv',
        character_id: 'old-char',
        title: 'seq 重建',
        messages: [
          { id: 'm1', role: 'user', content: '第一条', created_at: '2026-06-05T09:01:00.000Z', seq: 7 },
          { id: 'm2', role: 'assistant', content: '重复 seq', created_at: '2026-06-05T09:02:00.000Z', seq: 7 },
          { id: 'm3', role: 'user', content: '非整数', created_at: '2026-06-05T09:03:00.000Z', seq: 3.5 },
          { id: 'm4', role: 'assistant', content: '缺失 seq', created_at: '2026-06-05T09:04:00.000Z' },
        ],
      },
    ],
  };

  const response = await route.POST(importRequest(
    payload,
    'target_character_id=target-char&include_character=0',
  ));
  assert.equal(response.status, 200);

  const rows = db.prepare(
    'SELECT content, seq FROM messages ORDER BY seq ASC',
  ).all();
  assert.deepEqual(rows.map(r => r.seq), [1, 2, 3, 4]);
  // 稳定顺序：合法整数 seq 优先，其次 created_at / 原下标
  assert.deepEqual(rows.map(r => r.content), ['第一条', '重复 seq', '非整数', '缺失 seq']);
});

test('/api/import rejects invalid profile snapshot_json before any writes', async () => {
  const db = createImportDb();
  const route = loadImportRoute(db);
  const payload = {
    version: 2,
    character: {
      id: 'snap-char',
      name: '快照非法角色',
    },
    memory_profile_versions: [
      {
        character_id: 'snap-char',
        version_number: 1,
        snapshot_json: '{not-json',
        reason: 'broken',
        created_at: '2026-06-01T00:00:00.000Z',
      },
    ],
  };

  const response = await route.POST(importRequest(payload));
  const body = await response.json();
  assert.equal(response.status, 400);
  assert.equal(body.error, '导入数据包含非法画像快照');
  assert.equal(body.collection, 'memory_profile_versions');
  assert.equal(body.index, 0);
  assert.equal(body.field, 'snapshot_json');
  assertImportTablesEmpty(db);
});

test('/api/export rejects invalid type and character export without id', async () => {
  const db = createImportDb();
  db.prepare(`
    INSERT INTO characters (id, name, created_at, updated_at)
    VALUES ('char-export', '导出角色', '2026-06-01T00:00:00.000Z', '2026-06-01T00:00:00.000Z')
  `).run();
  const route = loadExportRoute(db);

  const badType = await route.GET({
    nextUrl: new URL('http://test.local/api/export?type=everything'),
  });
  assert.equal(badType.status, 400);
  assert.match((await badType.json()).error, /Invalid type/);

  const missingId = await route.GET({
    nextUrl: new URL('http://test.local/api/export?type=character'),
  });
  assert.equal(missingId.status, 400);
  assert.match((await missingId.json()).error, /Missing id/);

  // 合法单角色导出仍应成功，不得误伤
  const ok = await route.GET({
    nextUrl: new URL('http://test.local/api/export?type=character&id=char-export'),
  });
  assert.equal(ok.status ?? 200, 200);
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
    'target_character_id=target-char&include_character=0&include_embeddings=1',
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
    nextUrl: new URL('http://test.local/api/export?type=character&id=target-char&include_embeddings=1'),
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

test('/api/export response imports unchanged into a second database with stable semantics and closed references', async () => {
  const sourceDb = createImportDb();
  const targetDb = createImportDb();
  const sourceCharacterId = 'source-char';
  const sourceConversationId = 'source-conv';
  const sourceUserMessageId = 'source-user-msg';
  const sourceAssistantMessageId = 'source-assistant-msg';
  const sourceMemoryId = 'source-memory';

  sourceDb.prepare(`
    INSERT INTO characters (
      id, name, avatar_url, basic_info, personality, scenario, greeting,
      example_dialogue, system_prompt, other_info, image_tags, user_image_tags,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    sourceCharacterId,
    '串联测试角色',
    '/api/files/avatars/source.png',
    '角色基本信息',
    '温柔而坚定',
    '雨夜咖啡馆',
    '欢迎回来',
    '用户：你好\n角色：晚上好',
    '始终保持角色表现',
    '稳定语义字段',
    'cat_ears, blue_hair',
    'black_hair',
    '2026-07-01T00:00:00.000Z',
    '2026-07-02T00:00:00.000Z',
  );
  sourceDb.prepare(`
    INSERT INTO conversations (id, character_id, title, ignore_memory, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    sourceConversationId,
    sourceCharacterId,
    '需要完整迁移的对话',
    1,
    '2026-07-03T00:00:00.000Z',
    '2026-07-03T00:02:00.000Z',
  );
  sourceDb.prepare(`
    INSERT INTO messages (id, conversation_id, role, content, token_count, created_at, metadata, seq)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    sourceUserMessageId,
    sourceConversationId,
    'user',
    '请记住我们的约定',
    8,
    '2026-07-03T00:01:00.000Z',
    JSON.stringify({ mood: 'hopeful', memory_extracted: true }),
    7,
  );
  sourceDb.prepare(`
    INSERT INTO messages (id, conversation_id, role, content, token_count, created_at, metadata, seq)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    sourceAssistantMessageId,
    sourceConversationId,
    'assistant',
    '我会一直记得',
    6,
    '2026-07-03T00:02:00.000Z',
    JSON.stringify({ tone: 'warm' }),
    19,
  );
  sourceDb.prepare(`
    INSERT INTO memories (
      id, character_id, category, content, confidence, tags, source_msg_ids,
      memory_kind, importance, emotional_weight, status, pinned, last_used_at,
      usage_count, metadata, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    sourceMemoryId,
    sourceCharacterId,
    '重要事件',
    '我们约定不会忘记彼此',
    0.96,
    JSON.stringify(['约定', '关系']),
    JSON.stringify([sourceUserMessageId, 'missing-message', sourceAssistantMessageId]),
    'relationship_event',
    0.92,
    0.81,
    'active',
    1,
    '2026-07-04T00:00:00.000Z',
    3,
    JSON.stringify({ origin: 'roundtrip' }),
    '2026-07-03T00:03:00.000Z',
    '2026-07-04T00:00:00.000Z',
  );
  sourceDb.prepare(`
    INSERT INTO character_memory_profiles (
      character_id, profile_name, relationship_state, recent_story_state,
      emotional_baseline, open_threads, user_profile_summary, pinned_summary, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    sourceCharacterId,
    '长期陪伴画像',
    '彼此信任',
    '刚刚确认约定',
    '安心',
    JSON.stringify(['下次继续咖啡馆的话题']),
    '用户重视长期连续性',
    '不能忘记约定',
    '2026-07-04T00:00:00.000Z',
  );
  const profileSnapshot = {
    character_id: sourceCharacterId,
    profile_name: '长期陪伴画像',
    relationship_state: '彼此信任',
  };
  sourceDb.prepare(`
    INSERT INTO character_memory_profile_versions (
      character_id, version_number, snapshot_json, reason, task_id, created_at
    ) VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    sourceCharacterId,
    4,
    JSON.stringify(profileSnapshot),
    'profile_update',
    27,
    '2026-07-04T00:00:00.000Z',
  );
  const embeddingBuffer = Buffer.alloc(12);
  embeddingBuffer.writeFloatLE(0.25, 0);
  embeddingBuffer.writeFloatLE(-0.5, 4);
  embeddingBuffer.writeFloatLE(0.75, 8);
  sourceDb.prepare(`
    INSERT INTO memory_embeddings (
      memory_id, character_id, provider, model, dimension, embedding_blob,
      normalized, embedding_text_hash, status, error_message, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    sourceMemoryId,
    sourceCharacterId,
    'openai-compatible',
    'roundtrip-embedding',
    3,
    embeddingBuffer,
    1,
    'roundtrip-hash',
    'ready',
    null,
    '2026-07-04T00:00:00.000Z',
    '2026-07-04T00:00:00.000Z',
  );

  const exportRoute = loadExportRoute(sourceDb);
  const exportResponse = await exportRoute.GET({
    nextUrl: new URL(`http://test.local/api/export?type=character&id=${sourceCharacterId}&include_embeddings=1`),
  });
  assert.equal(exportResponse.status, 200);
  const exportedResponseText = await exportResponse.text();
  const exportedPayload = JSON.parse(exportedResponseText);
  assert.equal(exportedResponseText, JSON.stringify(exportedPayload));
  assert.match(
    exportResponse.headers.get('content-disposition') || '',
    new RegExp(`filename="lumimuse-character-${sourceCharacterId}\\.json"`),
  );
  assert.equal(exportedPayload.character.name, '串联测试角色');

  const importRoute = loadImportRoute(targetDb);
  const importResponse = await importRoute.POST(rawImportRequest(
    exportedResponseText,
    'include_embeddings=1',
  ));
  const importResult = await importResponse.json();

  assert.equal(importResponse.status, 200);
  assert.equal(importResult.imported, 1);
  assert.equal(importResult.conversationsImported, 1);
  assert.equal(importResult.messagesImported, 2);
  assert.equal(importResult.memoriesImported, 1);
  assert.equal(importResult.profilesImported, 1);
  assert.equal(importResult.profileVersionsImported, 1);
  assert.equal(importResult.embeddingsImported, 1);

  const importedCharacter = targetDb.prepare('SELECT * FROM characters WHERE name = ?').get('串联测试角色');
  assert.ok(importedCharacter);
  assert.notEqual(importedCharacter.id, sourceCharacterId);
  assert.equal(importedCharacter.personality, '温柔而坚定');
  assert.equal(importedCharacter.system_prompt, '始终保持角色表现');
  assert.equal(importedCharacter.image_tags, 'cat_ears, blue_hair');
  assert.equal(importedCharacter.created_at, '2026-07-01T00:00:00.000Z');

  const importedConversation = targetDb.prepare(
    'SELECT * FROM conversations WHERE character_id = ? AND title = ?',
  ).get(importedCharacter.id, '需要完整迁移的对话');
  assert.ok(importedConversation);
  assert.notEqual(importedConversation.id, sourceConversationId);
  assert.equal(importedConversation.ignore_memory, 1);
  assert.equal(importedConversation.created_at, '2026-07-03T00:00:00.000Z');
  assert.equal(importedConversation.updated_at, '2026-07-03T00:02:00.000Z');

  const importedMessages = targetDb.prepare(
    'SELECT * FROM messages WHERE conversation_id = ? ORDER BY seq ASC',
  ).all(importedConversation.id);
  assert.equal(importedMessages.length, 2);
  assert.deepEqual(importedMessages.map(message => message.role), ['user', 'assistant']);
  assert.deepEqual(importedMessages.map(message => message.content), ['请记住我们的约定', '我会一直记得']);
  const { estimateTokens } = require('../src/lib/token-counter.ts');
  assert.deepEqual(importedMessages.map(message => message.token_count), [
    estimateTokens('请记住我们的约定'),
    estimateTokens('我会一直记得'),
  ]);
  // 导入端会把稀疏/导出 seq 重建为会话内连续 1..N，保证游标分页稳定。
  assert.deepEqual(importedMessages.map(message => message.seq), [1, 2]);
  assert.notEqual(importedMessages[0].id, sourceUserMessageId);
  assert.notEqual(importedMessages[1].id, sourceAssistantMessageId);
  assert.deepEqual(
    {
      mood: parseJson(importedMessages[0].metadata).mood,
      memory_extracted: parseJson(importedMessages[0].metadata).memory_extracted,
    },
    { mood: 'hopeful', memory_extracted: true },
  );
  assert.equal(parseJson(importedMessages[0].metadata).token_count_provenance.source, 'server');
  assert.equal(parseJson(importedMessages[1].metadata).tone, 'warm');
  assert.equal(parseJson(importedMessages[1].metadata).token_count_provenance.source, 'server');

  const importedMemory = targetDb.prepare(
    'SELECT * FROM memories WHERE character_id = ? AND content = ?',
  ).get(importedCharacter.id, '我们约定不会忘记彼此');
  assert.ok(importedMemory);
  assert.notEqual(importedMemory.id, sourceMemoryId);
  assert.equal(importedMemory.memory_kind, 'relationship_event');
  assert.equal(importedMemory.importance, 0.92);
  assert.equal(importedMemory.emotional_weight, 0.81);
  assert.equal(importedMemory.pinned, 1);
  assert.deepEqual(parseJson(importedMemory.tags), ['约定', '关系']);
  assert.deepEqual(parseJson(importedMemory.metadata), { origin: 'roundtrip' });
  assert.deepEqual(
    parseJson(importedMemory.source_msg_ids),
    importedMessages.map(message => message.id),
    'known message references should remap and missing references should be dropped',
  );

  const importedProfile = targetDb.prepare(
    'SELECT * FROM character_memory_profiles WHERE character_id = ?',
  ).get(importedCharacter.id);
  assert.equal(importedProfile.profile_name, '长期陪伴画像');
  assert.equal(importedProfile.relationship_state, '彼此信任');
  assert.deepEqual(parseJson(importedProfile.open_threads), ['下次继续咖啡馆的话题']);

  const importedVersion = targetDb.prepare(
    'SELECT * FROM character_memory_profile_versions WHERE character_id = ? AND version_number = ?',
  ).get(importedCharacter.id, 4);
  assert.equal(importedVersion.reason, 'profile_update');
  assert.equal(importedVersion.task_id, 27);
  assert.deepEqual(parseJson(importedVersion.snapshot_json), profileSnapshot);

  const importedEmbedding = targetDb.prepare(
    'SELECT * FROM memory_embeddings WHERE memory_id = ?',
  ).get(importedMemory.id);
  assert.equal(importedEmbedding.character_id, importedCharacter.id);
  assert.equal(importedEmbedding.provider, 'openai-compatible');
  assert.equal(importedEmbedding.model, 'roundtrip-embedding');
  assert.equal(importedEmbedding.dimension, 3);
  assert.equal(importedEmbedding.embedding_text_hash, 'roundtrip-hash');
  assert.deepEqual([...importedEmbedding.embedding_blob], [...embeddingBuffer]);

  for (const messageId of parseJson(importedMemory.source_msg_ids)) {
    assert.ok(targetDb.prepare('SELECT 1 FROM messages WHERE id = ?').get(messageId));
  }
  assert.equal(targetDb.prepare(`
    SELECT COUNT(*) AS count
    FROM conversations c
    LEFT JOIN characters ch ON ch.id = c.character_id
    WHERE ch.id IS NULL
  `).get().count, 0);
  assert.equal(targetDb.prepare(`
    SELECT COUNT(*) AS count
    FROM messages m
    LEFT JOIN conversations c ON c.id = m.conversation_id
    WHERE c.id IS NULL
  `).get().count, 0);
  assert.equal(targetDb.prepare(`
    SELECT COUNT(*) AS count
    FROM memories m
    LEFT JOIN characters ch ON ch.id = m.character_id
    WHERE ch.id IS NULL
  `).get().count, 0);
  assert.equal(targetDb.prepare(`
    SELECT COUNT(*) AS count
    FROM memory_embeddings e
    LEFT JOIN memories m ON m.id = e.memory_id
    LEFT JOIN characters ch ON ch.id = e.character_id
    WHERE m.id IS NULL OR ch.id IS NULL
  `).get().count, 0);
});

test('/api/import rolls back every related table when a deterministic mid-import write fails', async () => {
  const db = createImportDb();
  db.exec(`
    CREATE TRIGGER fail_second_memory_import
    BEFORE INSERT ON memories
    WHEN NEW.content = '__force_import_failure__'
    BEGIN
      SELECT RAISE(ABORT, 'forced import failure');
    END;
  `);
  const route = loadImportRoute(db);
  const embeddingBuffer = Buffer.alloc(8);
  embeddingBuffer.writeFloatLE(0.4, 0);
  embeddingBuffer.writeFloatLE(0.6, 4);
  const payload = {
    version: 2,
    character: {
      id: 'rollback-char',
      name: '不应残留的角色',
      personality: '用于事务回滚测试',
      created_at: '2026-07-05T00:00:00.000Z',
      updated_at: '2026-07-05T00:00:00.000Z',
    },
    conversations: [
      {
        id: 'rollback-conv',
        character_id: 'rollback-char',
        title: '不应残留的对话',
        created_at: '2026-07-05T00:00:00.000Z',
        updated_at: '2026-07-05T00:01:00.000Z',
        messages: [
          {
            id: 'rollback-user',
            role: 'user',
            content: '这条消息应被回滚',
            token_count: 5,
            created_at: '2026-07-05T00:00:30.000Z',
            metadata: {},
            seq: 1,
          },
          {
            id: 'rollback-assistant',
            role: 'assistant',
            content: '这条回复也应被回滚',
            token_count: 6,
            created_at: '2026-07-05T00:01:00.000Z',
            metadata: {},
            seq: 2,
          },
        ],
      },
    ],
    memories: [
      {
        id: 'rollback-memory-before-failure',
        character_id: 'rollback-char',
        category: '重要事件',
        content: '这条记忆会先成功写入再被回滚',
        source_msg_ids: ['rollback-user', 'rollback-assistant'],
        created_at: '2026-07-05T00:01:30.000Z',
        updated_at: '2026-07-05T00:01:30.000Z',
      },
      {
        id: 'rollback-memory-failure',
        character_id: 'rollback-char',
        category: '重要事件',
        content: '__force_import_failure__',
        created_at: '2026-07-05T00:02:00.000Z',
        updated_at: '2026-07-05T00:02:00.000Z',
      },
    ],
    memory_profile: {
      character_id: 'rollback-char',
      profile_name: '不应残留的画像',
      open_threads: ['不应残留'],
      updated_at: '2026-07-05T00:02:30.000Z',
    },
    memory_profile_versions: [
      {
        character_id: 'rollback-char',
        version_number: 1,
        snapshot_json: JSON.stringify({ character_id: 'rollback-char', profile_name: '不应残留的画像' }),
        reason: 'initial',
        created_at: '2026-07-05T00:02:30.000Z',
      },
    ],
    memory_embeddings: [
      {
        memory_id: 'rollback-memory-before-failure',
        character_id: 'rollback-char',
        provider: 'openai-compatible',
        model: 'rollback-model',
        dimension: 2,
        embedding_blob: embeddingBuffer,
        normalized: 1,
        embedding_text_hash: 'rollback-hash',
        status: 'ready',
        created_at: '2026-07-05T00:02:30.000Z',
        updated_at: '2026-07-05T00:02:30.000Z',
      },
    ],
  };

  await assert.rejects(
    route.POST(importRequest(payload, 'include_embeddings=1')),
    /forced import failure/,
  );

  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM characters WHERE id <> 'target-char'").get().count, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM conversations').get().count, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM messages').get().count, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM memories').get().count, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM character_memory_profiles').get().count, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM character_memory_profile_versions').get().count, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM memory_embeddings').get().count, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM characters WHERE id = 'target-char'").get().count, 1);
});

test('/api/export omits embeddings by default and respects include_profiles=0', async () => {
  const db = createImportDb();
  db.prepare(`
    INSERT INTO character_memory_profiles (character_id, profile_name, updated_at)
    VALUES (?, ?, ?)
  `).run('target-char', '不应导出', '2026-06-01T00:00:00.000Z');

  const route = loadExportRoute(db);
  // 不传 include_embeddings，默认应跳过 embedding（体积大且可重建）
  const request = {
    nextUrl: new URL('http://test.local/api/export?type=character&id=target-char&include_profiles=0'),
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
  // include_memories=0 时，即使显式传 include_embeddings=1，也应该跳过 embedding
  const request = {
    nextUrl: new URL('http://test.local/api/export?type=character&id=target-char&include_memories=0&include_embeddings=1'),
  };

  const response = await route.GET(request);
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.deepEqual(payload.memories, []);
  assert.deepEqual(payload.memory_embeddings, []);
});
