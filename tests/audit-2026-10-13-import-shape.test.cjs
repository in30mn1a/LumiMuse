const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const Database = require('better-sqlite3');
const { registerTsLoader } = require('./helpers/register-ts-loader.cjs');

// 审计 2026-10-13 F06（import 部分）：/api/import 解析 JSON 后必须先校验形状。
// 合法 JSON 不一定是对象（null / 数组 / 字符串 / 数字），数组型字段里也可能混入
// null / 非对象元素；这些畸形输入不得触发未捕获的 TypeError（Next.js 中即 500）。

registerTsLoader();
const originalLoad = Module._load;
const { EXPORT_VERSION } = require('../src/lib/export-version.ts');

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

function createImportDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE characters (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      active_preset_id TEXT,
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
      memory_chat_injection_mode TEXT NOT NULL DEFAULT 'full'
        CHECK (memory_chat_injection_mode IN ('full', 'local', 'hybrid', 'vector')),
      background_model TEXT NOT NULL DEFAULT '',
      image_prompt_model TEXT NOT NULL DEFAULT '',
      background_provider_id TEXT NOT NULL DEFAULT '',
      background_reasoning_by_model TEXT NOT NULL DEFAULT '{}',
      image_prompt_reasoning_by_model TEXT NOT NULL DEFAULT '{}',
      background_system_prompt_by_model TEXT NOT NULL DEFAULT '{}',
      image_prompt_system_prompt_by_model TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT '',
      updated_at TEXT NOT NULL DEFAULT ''
    );

    CREATE TABLE conversations (
      id TEXT PRIMARY KEY,
      character_id TEXT NOT NULL,
      title TEXT NOT NULL DEFAULT '',
      ignore_memory INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      parent_id TEXT,
      parent_seq_end INTEGER
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

    CREATE TABLE character_model_preset_bindings (
      character_id TEXT NOT NULL,
      model TEXT NOT NULL,
      preset_id TEXT NOT NULL,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT '',
      updated_at TEXT NOT NULL DEFAULT '',
      PRIMARY KEY (character_id, model)
    );

    CREATE TABLE character_memory_configs (
      character_id TEXT PRIMARY KEY,
      enabled INTEGER,
      memory_package_token_budget INTEGER,
      profile_token_budget INTEGER,
      pinned_token_budget INTEGER,
      open_threads_token_budget INTEGER,
      retrieval_token_budget INTEGER,
      memory_max_inject_override INTEGER,
      vector_enabled_override INTEGER,
      reranker_enabled_override INTEGER,
      vector_top_k_override INTEGER,
      reranker_top_k_override INTEGER,
      embedding_model_override TEXT,
      reranker_model_override TEXT,
      updated_at TEXT NOT NULL
    );
  `);
  db.prepare('INSERT INTO characters (id, name) VALUES (?, ?)').run('target-char', '目标角色');
  return db;
}

function loadImportRoute(getDb) {
  return requireFreshWithMocks('../src/app/api/import/route.ts', {
    'next/server': jsonResponseMock(),
    '@/lib/db': { getDb },
    '@/lib/route-auth': { requireAuth: async () => null },
  });
}

/**
 * 发送原始请求体；路由处理器里未捕获的异常在 Next.js 中就是 500，这里折算成同样的结果，
 * 让断言统一写成「状态码是什么」。
 */
async function postRaw(route, raw, query = '') {
  const request = {
    headers: { get: () => null },
    nextUrl: new URL(`http://test.local/api/import${query ? `?${query}` : ''}`),
    text: async () => raw,
  };
  try {
    const response = await route.POST(request);
    return { status: response.status, body: await response.json() };
  } catch (error) {
    return { status: 500, body: { error: `uncaught ${error.name}: ${error.message}` } };
  }
}

function countRows(db) {
  const count = table => db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;
  return {
    characters: count('characters'),
    conversations: count('conversations'),
    messages: count('messages'),
    memories: count('memories'),
    profiles: count('character_memory_profiles'),
    profileVersions: count('character_memory_profile_versions'),
    embeddings: count('memory_embeddings'),
    configs: count('character_memory_configs'),
    bindings: count('character_model_preset_bindings'),
  };
}

// createImportDb 只预置了一条 target-char，其余表为空。
const PRISTINE_ROWS = {
  characters: 1,
  conversations: 0,
  messages: 0,
  memories: 0,
  profiles: 0,
  profileVersions: 0,
  embeddings: 0,
  configs: 0,
  bindings: 0,
};

test('F06: /api/import rejects valid JSON whose top level is not a plain object with 400', async () => {
  // 形状校验必须发生在任何数据库访问之前。
  const route = loadImportRoute(() => {
    throw new Error('Unexpected database access');
  });

  // 先收集全部结果再一次性断言，失败时能看到每种请求体各自的表现。
  const bodies = ['null', '[]', '"str"', '123', 'true', '[{"characters":[]}]'];
  const observed = {};
  for (const raw of bodies) {
    const result = await postRaw(route, raw);
    observed[raw] = { status: result.status, error: result.body.error };
  }

  assert.deepEqual(
    observed,
    Object.fromEntries(bodies.map(raw => [raw, { status: 400, error: '导入数据必须是 JSON 对象' }])),
  );
});

test('F06: /api/import skips a null conversation instead of throwing', async () => {
  const db = createImportDb();
  try {
    const route = loadImportRoute(() => db);
    const raw = JSON.stringify({ version: EXPORT_VERSION, conversations: [null] });

    const result = await postRaw(route, raw);
    assert.equal(result.status, 200, JSON.stringify(result.body));
    assert.equal(result.body.conversationsImported, 0);
    assert.equal(result.body.messagesImported, 0);
    assert.deepEqual(countRows(db), PRISTINE_ROWS);

    // 目标角色叠加导入：跳过后等同于空数组，沿用既有的「没有可导入的内容」。
    const overlay = await postRaw(route, raw, 'target_character_id=target-char');
    assert.equal(overlay.status, 400, JSON.stringify(overlay.body));
    assert.equal(overlay.body.error, '没有可导入的内容');
  } finally {
    db.close();
  }
});

test('F06: /api/import skips a null character instead of throwing', async () => {
  const db = createImportDb();
  try {
    const route = loadImportRoute(() => db);

    const result = await postRaw(route, JSON.stringify({ characters: [null] }));
    assert.equal(result.status, 200, JSON.stringify(result.body));
    assert.equal(result.body.imported, 0);
    assert.deepEqual(countRows(db), PRISTINE_ROWS);
  } finally {
    db.close();
  }
});

test('F06: /api/import skips null / non-object messages and still imports the valid ones in order', async () => {
  const db = createImportDb();
  try {
    const route = loadImportRoute(() => db);

    const result = await postRaw(route, JSON.stringify({
      characters: [{ id: 'old-char', name: '形状测试角色' }],
      conversations: [{
        id: 'old-conv',
        character_id: 'old-char',
        title: '夹杂坏条目的对话',
        messages: [
          null,
          { id: 'old-m1', role: 'user', content: '第一句', created_at: '2026-01-01T00:00:01.000Z' },
          'junk',
          42,
          ['nested'],
          { id: 'old-m2', role: 'assistant', content: '第二句', created_at: '2026-01-01T00:00:02.000Z' },
        ],
      }],
    }));

    assert.equal(result.status, 200, JSON.stringify(result.body));
    assert.equal(result.body.conversationsImported, 1);
    assert.equal(result.body.messagesImported, 2);
    assert.deepEqual(
      db.prepare('SELECT role, content, seq FROM messages ORDER BY seq').all(),
      [
        { role: 'user', content: '第一句', seq: 1 },
        { role: 'assistant', content: '第二句', seq: 2 },
      ],
    );
  } finally {
    db.close();
  }
});

test('F06: /api/import tolerates malformed message attachments and keeps well-formed ones intact', async () => {
  const db = createImportDb();
  try {
    const route = loadImportRoute(() => db);
    const goodAttachment = { id: 'att-1', type: 'text', name: 'notes.txt', data: '附件正文', mimeType: 'text/plain' };
    const message = (id, role, attachments) => ({
      id, role, content: id, created_at: '2026-01-01T00:00:00.000Z', metadata: { attachments },
    });

    const result = await postRaw(route, JSON.stringify({
      characters: [{ id: 'old-char', name: '附件形状测试角色' }],
      conversations: [{
        id: 'old-conv',
        character_id: 'old-char',
        messages: [
          message('number', 'user', 7),
          message('object', 'user', {}),
          message('string', 'assistant', 'x'),
          message('mixed', 'user', [null, goodAttachment, 'junk']),
          message('good', 'user', [goodAttachment]),
        ],
      }],
    }));

    assert.equal(result.status, 200, JSON.stringify(result.body));
    assert.equal(result.body.messagesImported, 5);
    const stored = Object.fromEntries(
      db.prepare('SELECT content, metadata FROM messages').all()
        .map(row => [row.content, JSON.parse(row.metadata).attachments]),
    );
    assert.deepEqual(stored, {
      number: [],
      object: [],
      string: [],
      mixed: [goodAttachment],
      good: [goodAttachment],
    });
  } finally {
    db.close();
  }
});

test('F06: /api/import never throws on a null element in any other array field', async () => {
  const cases = [
    { field: 'memories' },
    { field: 'memory_profiles' },
    { field: 'memory_profile_versions' },
    { field: 'memory_embeddings', query: 'include_embeddings=1' },
    { field: 'character_memory_configs' },
    { field: 'character_model_preset_bindings' },
    // 单角色格式：character.id 存在时会给每条绑定补 character_id，空元素同样不能炸。
    { field: 'model_preset_bindings', extra: { character: { id: 'old-char', name: '绑定角色' } }, characters: 2 },
    { field: 'prompt_presets' },
    { field: 'prompt_preset_entries' },
  ];

  // 先收集全部结果再一次性断言，失败时能看到每个字段各自的表现。
  const observed = {};
  const expected = {};
  for (const { field, query = '', extra = {}, characters = 1 } of cases) {
    const db = createImportDb();
    try {
      const route = loadImportRoute(() => db);
      const result = await postRaw(route, JSON.stringify({ ...extra, [field]: [null] }), query);

      observed[field] = {
        status: result.status,
        error: result.body.error,
        rows: countRows(db),
      };
      // 空元素不产生任何行（model_preset_bindings 用例里只多出它自带的那个角色）。
      expected[field] = {
        status: 200,
        error: undefined,
        rows: { ...PRISTINE_ROWS, characters },
      };
    } finally {
      db.close();
    }
  }

  assert.deepEqual(observed, expected);
});

test('F06: /api/import drops invalid elements but keeps their valid siblings', async () => {
  const db = createImportDb();
  try {
    const route = loadImportRoute(() => db);

    const result = await postRaw(route, JSON.stringify({
      characters: [null, { id: 'old-char', name: '幸存角色' }, 'junk'],
      memories: [null, { id: 'old-mem', character_id: 'old-char', category: '话题历史', content: '幸存记忆' }, 7],
    }));

    assert.equal(result.status, 200, JSON.stringify(result.body));
    assert.equal(result.body.imported, 1);
    assert.equal(result.body.memoriesImported, 1);
    assert.deepEqual(
      db.prepare("SELECT name FROM characters WHERE id <> 'target-char'").all(),
      [{ name: '幸存角色' }],
    );
    assert.deepEqual(db.prepare('SELECT content FROM memories').all(), [{ content: '幸存记忆' }]);
  } finally {
    db.close();
  }
});

test('F06: /api/import still imports a minimal well-formed backup', async () => {
  const db = createImportDb();
  try {
    const route = loadImportRoute(() => db);

    const result = await postRaw(route, JSON.stringify({
      version: EXPORT_VERSION,
      characters: [{ id: 'old-char', name: '最小角色', greeting: '你好呀' }],
      conversations: [{
        id: 'old-conv',
        character_id: 'old-char',
        title: '第一次聊天',
        created_at: '2026-01-01T00:00:00.000Z',
        updated_at: '2026-01-01T00:01:00.000Z',
        messages: [
          { id: 'old-m1', role: 'user', content: '在吗', created_at: '2026-01-01T00:00:10.000Z', seq: 1, metadata: {} },
          { id: 'old-m2', role: 'assistant', content: '在的', created_at: '2026-01-01T00:00:20.000Z', seq: 2, metadata: {} },
        ],
      }],
      memories: [{
        id: 'old-mem',
        character_id: 'old-char',
        category: '话题历史',
        content: '用户打了招呼',
        source_msg_ids: ['old-m1'],
      }],
    }));

    assert.equal(result.status, 200, JSON.stringify(result.body));
    assert.equal(result.body.ok, true);
    assert.equal(result.body.imported, 1);
    assert.equal(result.body.conversationsImported, 1);
    assert.equal(result.body.conversationsSkipped, 0);
    assert.equal(result.body.messagesImported, 2);
    assert.equal(result.body.memoriesImported, 1);
    assert.deepEqual(result.body.warnings, []);

    const character = db.prepare("SELECT id, name, greeting FROM characters WHERE id <> 'target-char'").get();
    assert.equal(character.name, '最小角色');
    assert.equal(character.greeting, '你好呀');
    assert.notEqual(character.id, 'old-char');

    const conversation = db.prepare('SELECT id, character_id, title, created_at, updated_at FROM conversations').get();
    assert.equal(conversation.character_id, character.id);
    assert.equal(conversation.title, '第一次聊天');
    assert.equal(conversation.created_at, '2026-01-01T00:00:00.000Z');
    assert.equal(conversation.updated_at, '2026-01-01T00:01:00.000Z');

    const messages = db.prepare(
      'SELECT id, conversation_id, role, content, created_at, seq FROM messages ORDER BY seq',
    ).all();
    assert.deepEqual(
      messages.map(({ id: _id, ...rest }) => rest),
      [
        { conversation_id: conversation.id, role: 'user', content: '在吗', created_at: '2026-01-01T00:00:10.000Z', seq: 1 },
        { conversation_id: conversation.id, role: 'assistant', content: '在的', created_at: '2026-01-01T00:00:20.000Z', seq: 2 },
      ],
    );

    const memory = db.prepare('SELECT character_id, category, content, status, source_msg_ids FROM memories').get();
    assert.equal(memory.character_id, character.id);
    assert.equal(memory.content, '用户打了招呼');
    assert.equal(memory.status, 'active');
    // 来源消息 id 重映射到新导入的消息
    assert.deepEqual(JSON.parse(memory.source_msg_ids), [messages[0].id]);
  } finally {
    db.close();
  }
});

test('F06: /api/import ignores a non-object single profile / config instead of blanking the target character', async () => {
  const db = createImportDb();
  try {
    db.prepare(
      "INSERT INTO character_memory_profiles (character_id, relationship_state, updated_at) VALUES ('target-char', '相识三年', '2026-01-01')",
    ).run();
    db.prepare(
      "INSERT INTO character_memory_configs (character_id, memory_package_token_budget, updated_at) VALUES ('target-char', 24000, '2026-01-01')",
    ).run();
    const route = loadImportRoute(() => db);

    const result = await postRaw(
      route,
      JSON.stringify({ memory_profile: 'junk', character_memory_config: 7 }),
      'target_character_id=target-char',
    );

    // 旧代码把这两个非对象值当成一条空记录 UPSERT 到目标角色上（返回 200），现有画像与预算被清空
    assert.deepEqual(result, { status: 400, body: { error: '没有可导入的内容' } });
    assert.deepEqual(
      db.prepare('SELECT relationship_state FROM character_memory_profiles').all(),
      [{ relationship_state: '相识三年' }],
    );
    assert.deepEqual(
      db.prepare('SELECT memory_package_token_budget FROM character_memory_configs').all(),
      [{ memory_package_token_budget: 24000 }],
    );
  } finally {
    db.close();
  }
});
