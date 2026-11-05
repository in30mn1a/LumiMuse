const test = require('node:test');
const assert = require('node:assert/strict');
const { installMemoryOnlyTestGuard } = require('./helpers/memory-only-test-guard.cjs');

installMemoryOnlyTestGuard(test);

const Database = require('better-sqlite3');
const { registerTsLoader } = require('./helpers/register-ts-loader.cjs');

registerTsLoader();

const { __migrateForTests, __setDbForTests } = require('../src/lib/db.ts');
const { loadSettings } = require('../src/lib/settings.ts');
const { embeddingToBlob } = require('../src/lib/memory-embeddings.ts');
const { AGENT_READ_TOOLS, createSearchMemoriesTool } = require('../src/lib/agent/tools/index.ts');
const { parseToolArguments, toolDefinitions } = require('../src/lib/agent/tools/registry.ts');
const { REDACTED_PLACEHOLDER } = require('../src/lib/agent/tools/credentials.ts');
const { runReadTool } = require('../src/lib/agent/tools/shared.ts');
const { createMemoryReviewPlan } = require('../src/lib/memory-review-plan.ts');
const {
  QUERYABLE_TABLE_NAMES,
  allowedColumns,
  buildTableQuery,
} = require('../src/lib/agent/table-query.ts');

// 所有凭据共用同一前缀：结果里只要出现这个前缀，就说明有凭据漏了出去
const SENTINEL = 'sk-FAKE-SENTINEL-4c1e9b7a';
const SECRETS = {
  provider: `${SENTINEL}-provider`,
  main: `${SENTINEL}-main`,
  embedding: `${SENTINEL}-embedding`,
  reranker: `${SENTINEL}-reranker`,
  nai: `${SENTINEL}-nai`,
  custom: `${SENTINEL}-custom`,
  access: `${SENTINEL}-access-password`,
  auth: `${SENTINEL}-auth-secret`,
};

const T0 = '2026-10-01T00:00:00.000Z';
const TOOLS = new Map(AGENT_READ_TOOLS.map(tool => [tool.name, tool]));

function tool(name) {
  const found = TOOLS.get(name);
  assert.ok(found, `missing tool ${name}`);
  return found;
}

/** 走与 agent loop 相同的路径：参数字符串 → schema 校验（含默认值）→ execute。 */
async function call(target, args, ctx) {
  const resolved = typeof target === 'string' ? tool(target) : target;
  const parsed = parseToolArguments(resolved, JSON.stringify(args));
  assert.ok(parsed.ok, `${resolved.name} rejected ${JSON.stringify(args)}: ${parsed.error}`);
  const result = await resolved.execute(parsed.args, ctx);
  // 结果必须能原样序列化后交给模型
  assert.deepEqual(JSON.parse(JSON.stringify(result)), result);
  return result;
}

async function callOk(target, args, ctx) {
  const result = await call(target, args, ctx);
  assert.equal(result.ok, true, `${typeof target === 'string' ? target : target.name}: ${result.error}`);
  return result;
}

function fakeEmbedder(vector) {
  const calls = [];
  const embed = async texts => {
    calls.push(texts);
    return texts.map(() => vector);
  };
  return { embed, calls };
}

function plantEnv(t) {
  const saved = { ACCESS_PASSWORD: process.env.ACCESS_PASSWORD, AUTH_SECRET: process.env.AUTH_SECRET };
  process.env.ACCESS_PASSWORD = SECRETS.access;
  process.env.AUTH_SECRET = SECRETS.auth;
  t.after(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
}

function insertRow(db, table, row) {
  const columns = Object.keys(row);
  db.prepare(`INSERT INTO ${table} (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`)
    .run(...columns.map(column => row[column]));
}

function addMemory(db, memory) {
  insertRow(db, 'memories', {
    id: memory.id,
    character_id: memory.character_id || 'char-a',
    category: memory.category,
    content: memory.content,
    tags: JSON.stringify(memory.tags || []),
    source_msg_ids: JSON.stringify(memory.source || []),
    importance: memory.importance ?? 0.5,
    status: memory.status || 'active',
    pinned: memory.pinned ? 1 : 0,
    metadata: JSON.stringify(memory.metadata || {}),
    created_at: memory.created_at || T0,
    updated_at: memory.updated_at || T0,
  });
}

function addEmbedding(db, memoryId, characterId, vector) {
  insertRow(db, 'memory_embeddings', {
    memory_id: memoryId,
    character_id: characterId,
    provider: 'openai-compatible',
    model: 'fake-embed',
    dimension: vector.length,
    embedding_blob: embeddingToBlob(vector),
    normalized: 1,
    embedding_text_hash: `hash-${memoryId}`,
    status: 'ready',
    created_at: T0,
    updated_at: T0,
  });
}

function addMessage(db, id, conversationId, role, content, seq, createdAt, metadata = {}) {
  insertRow(db, 'messages', {
    id,
    conversation_id: conversationId,
    role,
    content,
    seq,
    created_at: createdAt,
    metadata: JSON.stringify(metadata),
  });
}

function writeSetting(db, key, value) {
  db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(key, JSON.stringify(value));
}

const hoursAgo = hours => new Date(Date.now() - hours * 3600 * 1000).toISOString();

/** 虚构数据。凭据只出现在 api_providers、settings 和环境变量里。 */
function seed(db) {
  insertRow(db, 'api_providers', {
    id: 'prov-1',
    name: 'Fixture Provider',
    api_base: 'http://llm.test/v1',
    api_key: SECRETS.provider,
    model: 'model-x',
  });
  writeSetting(db, 'api_key', SECRETS.main);
  writeSetting(db, 'client_timezone', 'Asia/Shanghai');
  writeSetting(db, 'memory_engine', {
    index_enabled: true,
    allow_external_memory_payloads: true,
    embedding_api_base: 'http://embedding.test/v1',
    embedding_api_key: SECRETS.embedding,
    embedding_model: 'fake-embed',
    embedding_dimension: 2,
    reranker_api_key: SECRETS.reranker,
  });
  writeSetting(db, 'image_gen', { nai_api_key: SECRETS.nai, custom_api_key: SECRETS.custom });

  insertRow(db, 'characters', {
    id: 'char-a',
    name: 'Aster',
    personality: '温柔、好奇',
    sort_order: 0,
    background_provider_id: 'prov-1',
    background_model: 'model-x',
    background_reasoning_by_model: JSON.stringify({ 'model-x': 'high' }),
    updated_at: '2026-10-05T00:00:00.000Z',
  });
  insertRow(db, 'characters', { id: 'char-b', name: 'Briar', sort_order: 1, updated_at: T0 });
  insertRow(db, 'character_model_preset_bindings', {
    character_id: 'char-a',
    model: 'model-x',
    preset_id: 'preset-1',
    sort_order: 0,
    created_at: T0,
    updated_at: T0,
  });

  insertRow(db, 'conversations', {
    id: 'conv-a1', character_id: 'char-a', title: '初遇', created_at: T0, updated_at: '2026-10-01T10:10:00.000Z',
  });
  insertRow(db, 'conversations', {
    id: 'conv-a2', character_id: 'char-a', title: '甜点日', created_at: T0, updated_at: '2026-10-03T09:10:00.000Z',
  });
  insertRow(db, 'conversations', {
    id: 'conv-b1', character_id: 'char-b', title: '新店', created_at: T0, updated_at: '2026-10-02T18:00:00.000Z',
  });
  // 从 conv-a1 第 4 条分出来的子对话：继承父对话 seq <= 4 的消息
  insertRow(db, 'conversations', {
    id: 'conv-a1-branch',
    character_id: 'char-a',
    title: '初遇·另一种走向',
    parent_id: 'conv-a1',
    parent_seq_end: 4,
    ignore_memory: 1,
    created_at: '2026-10-01T11:00:00.000Z',
    updated_at: '2026-10-01T12:00:00.000Z',
  });

  addMessage(db, 'msg-a1-1', 'conv-a1', 'user', '你好，我叫小满', 1, '2026-10-01T10:00:00.000Z');
  addMessage(db, 'msg-a1-2', 'conv-a1', 'assistant', '你好呀小满', 2, '2026-10-01T10:00:05.000Z');
  addMessage(db, 'msg-a1-3', 'conv-a1', 'user', '我其实不爱吃甜的东西', 3, '2026-10-01T10:01:00.000Z');
  addMessage(db, 'msg-a1-4', 'conv-a1', 'assistant', '记住啦，以后不给你推荐甜点', 4, '2026-10-01T10:01:05.000Z');
  addMessage(db, 'msg-a1-5', 'conv-a1', 'user', '周末我会去爬山', 5, '2026-10-01T10:02:00.000Z', { memory_extracted: true });
  addMessage(db, 'msg-a1-6', 'conv-a1', 'assistant', '注意安全', 6, '2026-10-01T10:02:05.000Z');
  addMessage(db, 'msg-a2-1', 'conv-a2', 'user', '最近我周末常常自己做甜点', 7, '2026-10-03T09:00:00.000Z');
  addMessage(db, 'msg-a2-2', 'conv-a2', 'assistant', '哇，好厉害', 8, '2026-10-03T09:00:05.000Z');
  addMessage(db, 'msg-b1-1', 'conv-b1', 'user', '甜点店开了新分店', 9, '2026-10-02T08:00:00.000Z');
  // UTC 10 月 2 日 17:30 = 上海 10 月 3 日 01:30：只有按主人时区才算 10 月 3 日
  addMessage(db, 'msg-b1-2', 'conv-b1', 'user', '深夜睡不着', 10, '2026-10-02T17:30:00.000Z');
  addMessage(db, 'msg-br-1', 'conv-a1-branch', 'user', '换个话题吧', 11, '2026-10-01T11:00:00.000Z');

  addMemory(db, {
    id: 'mem-sweet-dislike', category: '偏好习惯', content: '用户不爱吃甜', tags: ['饮食'],
    source: ['msg-a1-3'], importance: 0.7,
  });
  addMemory(db, {
    id: 'mem-baking', category: '偏好习惯', content: '用户周末常常自己做甜点', tags: ['爱好'],
    source: ['msg-a2-1'], importance: 0.6,
  });
  addMemory(db, {
    id: 'mem-hiking', category: '四季日常', content: '用户周末会去爬山', tags: ['运动'],
    source: ['msg-a1-5', 'msg-deleted'], importance: 0.5,
  });
  addMemory(db, {
    id: 'mem-name', category: '基础信息', content: '用户名叫小满', tags: ['名字'],
    source: ['msg-a1-1'], importance: 0.9, pinned: true,
  });
  addMemory(db, {
    id: 'mem-long', category: '话题历史', content: `长篇回忆：${'山间小路与晚风。'.repeat(600)}`, importance: 0.2,
  });
  addMemory(db, {
    id: 'mem-old-sweet', category: '偏好习惯', content: '用户以前每天做甜点', status: 'superseded',
    metadata: { superseded_by: 'mem-sweet-dislike' },
  });
  addMemory(db, { id: 'mem-archived', category: '重要事件', content: '用户搬过一次家', status: 'archived' });
  addMemory(db, { id: 'mem-b-1', character_id: 'char-b', category: '偏好习惯', content: '用户想去甜点店' });

  // mem-baking 没有向量（还在索引队列里），只有关键词召回能看到它
  addEmbedding(db, 'mem-sweet-dislike', 'char-a', [1, 0]);
  addEmbedding(db, 'mem-hiking', 'char-a', [0, 1]);
  addEmbedding(db, 'mem-name', 'char-a', [0, 1]);
  addEmbedding(db, 'mem-long', 'char-a', [0, 1]);
  addEmbedding(db, 'mem-b-1', 'char-b', [1, 0]);

  insertRow(db, 'character_memory_profiles', {
    character_id: 'char-a',
    profile_name: '小满',
    relationship_state: '刚认识的朋友',
    open_threads: JSON.stringify(['周末的爬山计划']),
    updated_at: T0,
  });
  insertRow(db, 'character_memory_profile_versions', {
    character_id: 'char-a', version_number: 1, snapshot_json: '{}', reason: 'fixture', created_at: T0,
  });

  insertRow(db, 'memory_tasks', {
    id: 1,
    character_id: 'char-a',
    conversation_id: 'conv-a1',
    message_ids: JSON.stringify(['msg-a1-3']),
    status: 'failed',
    error_message: 'upstream 500',
    claim_token: 'claim-fixture',
    created_at: '2026-10-01 10:00:00',
    updated_at: '2026-10-01 10:05:00',
  });
  insertRow(db, 'memory_tasks', {
    id: 2,
    character_id: 'char-a',
    conversation_id: 'conv-a2',
    message_ids: JSON.stringify(['msg-a2-1']),
    status: 'done',
    result_committed: 1,
    result_insert_count: 2,
    created_at: '2026-10-03 09:01:00',
    updated_at: '2026-10-03 09:02:00',
  });
  insertRow(db, 'character_memory_profile_update_tasks', {
    character_id: 'char-a',
    reason: 'extraction',
    patch_json: '{}',
    status: 'failed',
    error_message: 'profile model timeout',
    created_at: '2026-10-02T10:00:00.000Z',
    updated_at: '2026-10-02T10:00:00.000Z',
  });
  insertRow(db, 'memory_embedding_tasks', {
    memory_id: 'mem-b-1',
    character_id: 'char-b',
    reason: 'created',
    status: 'failed',
    error_message: 'embedding 401',
    created_at: '2026-10-03 08:00:00',
    updated_at: '2026-10-03 08:00:00',
  });

  insertRow(db, 'memory_extraction_candidates', {
    id: 1,
    task_id: 2,
    character_id: 'char-a',
    conversation_id: 'conv-a2',
    raw_response: '{"memories": [ 未闭合',
    status: 'repairable',
    error_reason: 'invalid_json',
    created_at: '2026-10-03T09:02:00.000Z',
    updated_at: '2026-10-03T09:02:00.000Z',
  });
  insertRow(db, 'memory_extraction_candidates', {
    id: 2,
    task_id: 2,
    character_id: 'char-a',
    conversation_id: 'conv-a2',
    raw_candidate_json: '{}',
    status: 'ignored',
    created_at: '2026-10-03T09:02:00.000Z',
    updated_at: '2026-10-03T09:02:00.000Z',
  });
  insertRow(db, 'memory_extraction_candidates', {
    id: 3,
    task_id: 999,
    character_id: 'char-b',
    conversation_id: 'conv-b1',
    raw_response: 'not json',
    status: 'repairable',
    error_reason: 'invalid_json',
    created_at: '2026-10-03T10:00:00.000Z',
    updated_at: '2026-10-03T10:00:00.000Z',
  });

  const event = (ts, level, name, extra = {}) => insertRow(db, 'app_events', {
    ts, level, event: name, character_id: 'char-a', ...extra,
  });
  event(hoursAgo(72), 'error', 'chat.reply_failed', { error_category: 'network' });
  event(hoursAgo(3), 'warn', 'memory.extraction.reference_degraded');
  event(hoursAgo(2), 'error', 'chat.reply_failed', { conversation_id: 'conv-a1', http_status: 500, error_category: 'upstream' });
  event(hoursAgo(1), 'error', 'chat.reply_failed', { character_id: 'char-b', http_status: 429, error_category: 'rate_limit' });
}

/**
 * 每个用例一份独立的 :memory: 库。工具只能用 ctx.db：全局单例换成一个空的诱饵库，
 * 工具若偷偷走 getDb()，读到的是空数据，断言会失败。数据写完后开启 query_only，
 * 任何写库都会抛错，从而证明工具只读。
 */
function createFixture(t, { seedData = seed } = {}) {
  plantEnv(t);
  const db = new Database(':memory:');
  __migrateForTests(db);
  seedData(db);
  createMemoryReviewPlan({
    characterId: 'char-a', planId: 'fixture-read-plan',
    memories: db.prepare("SELECT id, content, importance FROM memories WHERE character_id = 'char-a' AND status = 'active'").all(),
    clusterOptions: { batchSize: 40, keepClustersTogether: true },
  });
  __setDbForTests(db);
  const settings = loadSettings();

  const decoy = new Database(':memory:');
  __migrateForTests(decoy);
  __setDbForTests(decoy);
  db.pragma('query_only = ON');

  t.after(() => {
    __setDbForTests(null);
    decoy.close();
    db.close();
  });
  return { db, ctx: { db, settings, sessionId: 'test-session' } };
}

function withEngine(ctx, overrides) {
  return { ...ctx, settings: { ...ctx.settings, memory_engine: { ...ctx.settings.memory_engine, ...overrides } } };
}

const ids = rows => rows.map(row => row.id);

test('registry: 17 read tools with unique names and convertible schemas', () => {
  assert.equal(AGENT_READ_TOOLS.length, 17);
  assert.equal(TOOLS.size, 17);
  for (const item of AGENT_READ_TOOLS) assert.equal(item.kind, 'read');
  const definitions = toolDefinitions(AGENT_READ_TOOLS);
  assert.equal(definitions.length, 17);
  for (const definition of definitions) {
    assert.equal(definition.function.parameters.type, 'object');
    assert.equal(definition.function.parameters.$schema, undefined);
  }
});

test('parseToolArguments rejects invalid arguments and applies defaults', () => {
  const overLimit = parseToolArguments(tool('list_characters'), JSON.stringify({ limit: 51 }));
  assert.equal(overLimit.ok, false);
  assert.match(overLimit.error, /limit/);

  const missing = parseToolArguments(tool('search_memories'), JSON.stringify({ query: '甜点' }));
  assert.equal(missing.ok, false);
  assert.match(missing.error, /character_id/);

  const badStatus = parseToolArguments(tool('search_memories'), JSON.stringify({ character_id: 'c', query: 'q', status: 'deleted' }));
  assert.equal(badStatus.ok, false);

  const defaults = parseToolArguments(tool('search_memories'), JSON.stringify({ character_id: 'c', query: ' 甜点 ' }));
  assert.equal(defaults.ok, true);
  assert.deepEqual(defaults.args, { character_id: 'c', query: '甜点', status: 'active', limit: 20, offset: 0 });
});

test('list_characters pages with counts; get_character returns task config without keys', async t => {
  const { ctx } = createFixture(t);
  const first = await callOk('list_characters', { limit: 1 }, ctx);
  assert.deepEqual(first.characters.map(item => item.id), ['char-a']);
  assert.equal(first.characters[0].active_memory_count, 5);
  assert.equal(first.characters[0].conversation_count, 3);
  assert.equal(first.has_more, true);
  assert.equal(first.next_offset, 1);
  const second = await callOk('list_characters', { limit: 1, offset: 1 }, ctx);
  assert.deepEqual(second.characters.map(item => item.id), ['char-b']);
  assert.equal(second.has_more, false);
  assert.equal(second.next_offset, null);

  const character = await callOk('get_character', { character_id: 'char-a' }, ctx);
  assert.equal(character.character.name, 'Aster');
  assert.equal(character.task_config.background_provider_id, 'prov-1');
  assert.deepEqual(character.task_config.background_reasoning_by_model, { 'model-x': 'high' });
  assert.deepEqual(character.model_preset_bindings.map(item => item.preset_id), ['preset-1']);

  const missing = await call('get_character', { character_id: 'nobody' }, ctx);
  assert.equal(missing.ok, false);
  assert.match(missing.error, /nobody/);
});

test('search_memories: fake embedder recalls a lexically dissimilar memory, unioned with keyword hits', async t => {
  const { ctx } = createFixture(t);
  const embedder = fakeEmbedder([1, 0]);
  const searchTool = createSearchMemoriesTool({ embedTexts: embedder.embed });

  const result = await callOk(searchTool, { character_id: 'char-a', query: '用户迷上做甜点' }, ctx);
  assert.deepEqual(embedder.calls, [['用户迷上做甜点']]);
  assert.equal(result.vector_used, true);
  assert.equal(result.vector_unavailable_reason, null);
  // 语义冲突的旧记忆排在最前，且只有向量能找到它
  assert.equal(result.memories[0].id, 'mem-sweet-dislike');
  assert.deepEqual(result.memories[0].matched_by, ['vector']);
  // 向量还在排队的新记忆只能靠关键词：并集保证它不丢
  const baking = result.memories.find(memory => memory.id === 'mem-baking');
  assert.ok(baking, 'keyword-only memory missing from union');
  assert.deepEqual(baking.matched_by, ['keyword']);
  // 只看本角色的 active 记忆
  const returned = ids(result.memories);
  assert.ok(!returned.includes('mem-b-1'));
  assert.ok(!returned.includes('mem-old-sweet'));
  assert.equal(result.total, result.memories.length);

  // 同一查询只做关键词时找不到它：证明上面的命中确实来自向量
  const keywordOnly = await callOk(searchTool, { character_id: 'char-a', query: '用户迷上做甜点' }, withEngine(ctx, { index_enabled: false }));
  assert.equal(keywordOnly.vector_used, false);
  assert.match(keywordOnly.vector_unavailable_reason, /未开启/);
  assert.deepEqual(ids(keywordOnly.memories), ['mem-baking']);
  assert.equal(embedder.calls.length, 1, 'embedder must not run when the index is off');
});

test('search_memories falls back to keyword results when the embedder throws', async t => {
  const { ctx } = createFixture(t);
  const searchTool = createSearchMemoriesTool({
    embedTexts: async () => {
      throw new Error('embedding upstream down');
    },
  });
  const result = await callOk(searchTool, { character_id: 'char-a', query: '用户迷上做甜点' }, ctx);
  assert.equal(result.vector_used, false);
  assert.match(result.vector_unavailable_reason, /embedding upstream down/);
  assert.deepEqual(ids(result.memories), ['mem-baking']);
  assert.deepEqual(result.memories[0].matched_by, ['keyword']);
});

test('search_memories handles status/category filters, paging and full content', async t => {
  const { ctx } = createFixture(t);
  const searchTool = createSearchMemoriesTool({ embedTexts: fakeEmbedder([1, 0]).embed });

  const superseded = await callOk(searchTool, { character_id: 'char-a', query: '甜点', status: 'superseded' }, ctx);
  assert.equal(superseded.vector_used, false);
  assert.match(superseded.vector_unavailable_reason, /active/);
  assert.deepEqual(ids(superseded.memories), ['mem-old-sweet']);
  assert.equal(superseded.memories[0].status, 'superseded');

  const category = await callOk(searchTool, { character_id: 'char-a', query: '周末', category: '四季日常' }, ctx);
  assert.equal(category.vector_used, true);
  assert.deepEqual(ids(category.memories), ['mem-hiking']);

  const page1 = await callOk(searchTool, { character_id: 'char-a', query: '用户迷上做甜点', limit: 1 }, ctx);
  assert.equal(page1.memories.length, 1);
  assert.equal(page1.has_more, true);
  assert.equal(page1.next_offset, 1);
  const rest = await callOk(searchTool, { character_id: 'char-a', query: '用户迷上做甜点', offset: 1, limit: 50 }, ctx);
  assert.equal(rest.has_more, false);
  assert.equal(rest.next_offset, null);
  assert.equal(rest.memories.length, page1.total - 1);

  const long = await callOk(searchTool, { character_id: 'char-a', query: '山间小路' }, withEngine(ctx, { index_enabled: false }));
  assert.equal(long.memories[0].id, 'mem-long');
  assert.equal(long.memories[0].content.length, 5 + '山间小路与晚风。'.length * 600);

  const none = await callOk(searchTool, { character_id: 'char-a', query: '潜水' }, withEngine(ctx, { index_enabled: false }));
  assert.deepEqual(none.memories, []);
  assert.equal(none.has_more, false);
});

test('search_memories ranks vectors within the requested category without changing unfiltered recall', async t => {
  const otherIds = Array.from({ length: 12 }, (_, index) => `filter-other-${index}`);
  const { ctx } = createFixture(t, {
    seedData: db => {
      seed(db);
      insertRow(db, 'characters', { id: 'char-filter', name: 'Category Fixture' });
      for (const id of otherIds) {
        addMemory(db, { id, character_id: 'char-filter', category: '偏好习惯', content: 'Enjoys evening walks.' });
        addEmbedding(db, id, 'char-filter', [1, 0]);
      }
      addMemory(db, { id: 'filter-target', character_id: 'char-filter', category: '基础信息', content: 'Raised in Bergen.' });
      addEmbedding(db, 'filter-target', 'char-filter', [0.9, Math.sqrt(1 - 0.9 ** 2)]);
    },
  });
  const searchTool = createSearchMemoriesTool({ embedTexts: fakeEmbedder([1, 0]).embed });
  const args = { character_id: 'char-filter', query: '出生背景', limit: 50 };

  const unfiltered = await callOk(searchTool, args, ctx);
  assert.deepEqual(ids(unfiltered.memories).sort(), [...otherIds].sort());
  assert.equal(unfiltered.keyword_hit_count, 0);

  const filtered = await callOk(searchTool, { ...args, category: '基础信息' }, ctx);
  assert.equal(filtered.vector_used, true);
  assert.equal(filtered.keyword_hit_count, 0);
  assert.deepEqual(ids(filtered.memories), ['filter-target']);
  assert.deepEqual(filtered.memories[0].matched_by, ['vector']);
});

test('get_memories returns normalized full rows, honours the character filter and reports missing ids', async t => {
  const { ctx } = createFixture(t);
  const scoped = await callOk('get_memories', { memory_ids: ['mem-name', 'mem-missing', 'mem-b-1', 'mem-name'], character_id: 'char-a' }, ctx);
  assert.deepEqual(ids(scoped.memories), ['mem-name']);
  assert.deepEqual(scoped.missing_ids, ['mem-missing', 'mem-b-1']);
  assert.deepEqual(scoped.memories[0].tags, ['名字']);
  assert.deepEqual(scoped.memories[0].source_msg_ids, ['msg-a1-1']);
  assert.equal(scoped.memories[0].pinned, true);

  const all = await callOk('get_memories', { memory_ids: ['mem-old-sweet', 'mem-b-1', 'mem-long'] }, ctx);
  assert.deepEqual(ids(all.memories), ['mem-old-sweet', 'mem-b-1', 'mem-long']);
  assert.deepEqual(all.memories[0].metadata, { superseded_by: 'mem-sweet-dislike' });
  assert.equal(all.memories[2].content.length, 5 + '山间小路与晚风。'.length * 600);
  assert.deepEqual(all.missing_ids, []);
});

test('get_memory_sources returns source messages with surrounding context and missing sources', async t => {
  const { ctx } = createFixture(t);
  const result = await callOk('get_memory_sources', {
    memory_ids: ['mem-sweet-dislike', 'mem-hiking', 'mem-ghost'],
    context: 1,
  }, ctx);
  assert.deepEqual(result.missing_memory_ids, ['mem-ghost']);
  const [sweet, hiking] = result.memories;

  assert.equal(sweet.memory_id, 'mem-sweet-dislike');
  assert.equal(sweet.sources[0].conversation_id, 'conv-a1');
  assert.equal(sweet.sources[0].conversation_title, '初遇');
  assert.deepEqual(ids(sweet.sources[0].messages), ['msg-a1-2', 'msg-a1-3', 'msg-a1-4']);
  assert.deepEqual(sweet.sources[0].messages.map(message => message.is_source), [false, true, false]);
  assert.deepEqual(sweet.missing_source_ids, []);

  // 最后一条之后只剩一条；已删除的来源单独列出
  assert.deepEqual(ids(hiking.sources[0].messages), ['msg-a1-4', 'msg-a1-5', 'msg-a1-6']);
  assert.equal(hiking.sources[0].messages[1].memory_processed, true);
  assert.equal(hiking.sources[0].messages[0].memory_processed, false);
  assert.deepEqual(hiking.missing_source_ids, ['msg-deleted']);

  const defaultContext = await callOk('get_memory_sources', { memory_ids: ['mem-name'] }, ctx);
  assert.deepEqual(ids(defaultContext.memories[0].sources[0].messages), ['msg-a1-1', 'msg-a1-2', 'msg-a1-3']);

  const wrongCharacter = await callOk('get_memory_sources', { memory_ids: ['mem-b-1'], character_id: 'char-a' }, ctx);
  assert.deepEqual(wrongCharacter.memories, []);
  assert.deepEqual(wrongCharacter.missing_memory_ids, ['mem-b-1']);
});

test('get_memory_sources keeps one call within the output budget and pages through every source', async t => {
  const SOURCE_COUNT = 60;
  const { ctx } = createFixture(t, {
    seedData: db => {
      seed(db);
      insertRow(db, 'conversations', {
        id: 'conv-long', character_id: 'char-a', title: '长对话',
        created_at: '2026-10-05T10:00:00.000Z', updated_at: '2026-10-05T12:00:00.000Z',
      });
      const sourceIds = [];
      for (let i = 1; i <= SOURCE_COUNT; i += 1) {
        const id = `msg-long-${i}`;
        sourceIds.push(id);
        addMessage(db, id, 'conv-long', i % 2 ? 'user' : 'assistant', `第${i}条长消息：${'窗外的雨一直下到天亮。'.repeat(120)}`, i, `2026-10-05T10:${String(i).padStart(2, '0')}:00.000Z`);
      }
      addMemory(db, { id: 'mem-wide', category: '四季日常', content: '提取窗口很宽的记忆', source: [...sourceIds.slice(0, 30), 'msg-gone', ...sourceIds.slice(30)], importance: 0.5 });
      addMemory(db, { id: 'mem-wide-twin', category: '四季日常', content: '同一窗口的另一条记忆', source: sourceIds, importance: 0.5 });
    },
  });
  const { estimateTokens } = require('../src/lib/token-counter.ts');

  const seen = [];
  const missing = [];
  let offset = 0;
  let pages = 0;
  while (offset !== null) {
    const page = await callOk('get_memory_sources', { memory_ids: ['mem-wide'], context: 0, source_offset: offset }, ctx);
    pages += 1;
    const [memory] = page.memories;
    assert.equal(memory.source_total, SOURCE_COUNT + 1);
    assert.ok(memory.sources.length > 0, 'every page makes progress');
    const sourceTokens = memory.sources.reduce((sum, source) => sum + estimateTokens(JSON.stringify(source)), 0);
    assert.ok(sourceTokens <= 20_000, `page ${pages} stays within budget (${sourceTokens})`);
    assert.equal(page.truncated === true, memory.next_source_offset !== null);
    if (page.truncated) assert.match(page.note, /source_offset/);
    seen.push(...memory.sources.map(source => source.message_id));
    missing.push(...memory.missing_source_ids);
    offset = memory.next_source_offset;
    assert.ok(pages < 50, 'paging terminates');
  }
  assert.ok(pages > 1, 'the fixture must actually exceed one page');
  assert.deepEqual(seen, Array.from({ length: SOURCE_COUNT }, (_, i) => `msg-long-${i + 1}`), 'no source skipped or repeated');
  assert.deepEqual(missing, ['msg-gone']);

  // 预算在整次调用内共享：前一条记忆用满后，后面的记忆不给来源，但标明从哪开始读
  const shared = await callOk('get_memory_sources', { memory_ids: ['mem-wide', 'mem-wide-twin'], context: 0 }, ctx);
  assert.equal(shared.truncated, true);
  const sharedTokens = shared.memories.flatMap(memory => memory.sources)
    .reduce((sum, source) => sum + estimateTokens(JSON.stringify(source)), 0);
  assert.ok(sharedTokens <= 20_000);
  const twin = shared.memories.find(memory => memory.memory_id === 'mem-wide-twin');
  assert.deepEqual(twin.sources, []);
  assert.equal(twin.next_source_offset, 0);

  // 小结果不带截断标记
  const small = await callOk('get_memory_sources', { memory_ids: ['mem-name'] }, ctx);
  assert.equal(small.truncated, undefined);
  assert.equal(small.memories[0].next_source_offset, null);
  assert.equal(small.memories[0].source_total, 1);
});

test('get_memory_profile reads an existing profile and reports a missing one', async t => {
  const { ctx } = createFixture(t);
  const existing = await callOk('get_memory_profile', { character_id: 'char-a' }, ctx);
  assert.equal(existing.exists, true);
  assert.equal(existing.profile.relationship_state, '刚认识的朋友');
  assert.deepEqual(existing.profile.open_threads, ['周末的爬山计划']);

  const missing = await callOk('get_memory_profile', { character_id: 'char-b' }, ctx);
  assert.equal(missing.exists, false);
  assert.equal(missing.profile, null);
});

test('list_conversations lists newest first with character filter and paging', async t => {
  const { ctx } = createFixture(t);
  const all = await callOk('list_conversations', {}, ctx);
  assert.deepEqual(ids(all.conversations), ['conv-a2', 'conv-b1', 'conv-a1-branch', 'conv-a1']);
  assert.equal(all.has_more, false);

  const page = await callOk('list_conversations', { character_id: 'char-a', limit: 2 }, ctx);
  assert.deepEqual(ids(page.conversations), ['conv-a2', 'conv-a1-branch']);
  assert.equal(page.has_more, true);
  assert.equal(page.next_offset, 2);
  assert.equal(page.conversations[1].ignore_memory, true);
  assert.equal(page.conversations[1].own_message_count, 1);
  assert.equal(page.conversations[0].character_name, 'Aster');

  const last = await callOk('list_conversations', { character_id: 'char-a', limit: 2, offset: 2 }, ctx);
  assert.deepEqual(ids(last.conversations), ['conv-a1']);
  assert.equal(last.next_offset, null);
});

test('read_messages pages in conversation order and includes inherited parent messages', async t => {
  const { ctx } = createFixture(t);
  const first = await callOk('read_messages', { conversation_id: 'conv-a1', limit: 4 }, ctx);
  assert.equal(first.total, 6);
  assert.deepEqual(ids(first.messages), ['msg-a1-1', 'msg-a1-2', 'msg-a1-3', 'msg-a1-4']);
  assert.equal(first.has_more, true);
  assert.equal(first.next_offset, 4);
  const second = await callOk('read_messages', { conversation_id: 'conv-a1', limit: 4, offset: 4 }, ctx);
  assert.deepEqual(ids(second.messages), ['msg-a1-5', 'msg-a1-6']);
  assert.equal(second.has_more, false);
  assert.equal(second.next_offset, null);

  const branch = await callOk('read_messages', { conversation_id: 'conv-a1-branch' }, ctx);
  assert.equal(branch.total, 5);
  assert.deepEqual(ids(branch.messages), ['msg-a1-1', 'msg-a1-2', 'msg-a1-3', 'msg-a1-4', 'msg-br-1']);
  assert.equal(branch.messages[0].conversation_id, 'conv-a1');
  assert.equal(branch.chain_error, undefined);

  const missing = await call('read_messages', { conversation_id: 'conv-none' }, ctx);
  assert.equal(missing.ok, false);
});

test('search_messages returns full content, filters by character and uses the client time zone', async t => {
  const { ctx } = createFixture(t);
  const all = await callOk('search_messages', { query: '甜点' }, ctx);
  assert.deepEqual(all.results.map(item => item.message_id).sort(), ['msg-a1-4', 'msg-a2-1', 'msg-b1-1']);
  const baking = all.results.find(item => item.message_id === 'msg-a2-1');
  assert.equal(baking.content, '最近我周末常常自己做甜点');
  assert.equal(baking.conversation_title, '甜点日');
  assert.equal(baking.character_name, 'Aster');

  const scoped = await callOk('search_messages', { query: '甜点', character_id: 'char-a', limit: 1 }, ctx);
  assert.equal(scoped.results.length, 1);
  assert.equal(scoped.results[0].character_id, 'char-a');
  assert.equal(scoped.has_more, true);
  assert.equal(scoped.next_offset, 1);
  const scopedRest = await callOk('search_messages', { query: '甜点', character_id: 'char-a', limit: 1, offset: 1 }, ctx);
  assert.equal(scopedRest.has_more, false);
  assert.equal(scopedRest.next_offset, null);

  // 上海时区的 10 月 3 日包含 UTC 10 月 2 日 17:30 的那条
  const byDate = await callOk('search_messages', { query: '2026-10-03' }, ctx);
  assert.ok(byDate.results.some(item => item.message_id === 'msg-b1-2'));
  const utc = await callOk('search_messages', { query: '2026-10-03' }, { ...ctx, settings: { ...ctx.settings, client_timezone: 'UTC' } });
  assert.ok(!utc.results.some(item => item.message_id === 'msg-b1-2'));
});

test('get_system_status combines memory system status with 24h app event counts', async t => {
  const { ctx } = createFixture(t);
  const status = await callOk('get_system_status', {}, ctx);
  assert.deepEqual(status.app_events_last_24h.by_level, { warn: 1, error: 2 });
  const replyFailed = status.app_events_last_24h.top_events.find(item => item.event === 'chat.reply_failed');
  assert.equal(replyFailed.count, 2);
  assert.equal(status.memory_system.queues.extraction.failed, 1);
  assert.equal(status.memory_system.candidates.repairable, 2);

  const scoped = await callOk('get_system_status', { character_id: 'char-b' }, ctx);
  assert.equal(scoped.memory_system.character_id, 'char-b');
  assert.equal(scoped.memory_system.queues.extraction.failed, 0);
  assert.equal(scoped.memory_system.queues.embedding.failed, 1);
});

test('list_app_events filters, orders newest first, pages and rejects bad timestamps', async t => {
  const { ctx } = createFixture(t);
  const errors = await callOk('list_app_events', { level: 'error', limit: 2 }, ctx);
  assert.equal(errors.events.length, 2);
  assert.equal(errors.events[0].character_id, 'char-b');
  assert.equal(errors.events[1].http_status, 500);
  assert.equal(errors.has_more, true);
  assert.equal(errors.next_offset, 2);
  const lastError = await callOk('list_app_events', { level: 'error', limit: 2, offset: 2 }, ctx);
  assert.equal(lastError.events.length, 1);
  assert.equal(lastError.events[0].error_category, 'network');
  assert.equal(lastError.has_more, false);

  const recent = await callOk('list_app_events', { since: hoursAgo(24), character_id: 'char-a' }, ctx);
  assert.deepEqual(recent.events.map(item => item.event), ['chat.reply_failed', 'memory.extraction.reference_degraded']);
  const byConversation = await callOk('list_app_events', { conversation_id: 'conv-a1', event: 'chat.reply_failed' }, ctx);
  assert.equal(byConversation.events.length, 1);
  const old = await callOk('list_app_events', { until: hoursAgo(48) }, ctx);
  assert.equal(old.events.length, 1);

  const invalid = await call('list_app_events', { since: 'not-a-date' }, ctx);
  assert.equal(invalid.ok, false);
  assert.match(invalid.error, /since/);
});

test('list_failed_tasks merges the three task tables newest first with filters', async t => {
  const { ctx } = createFixture(t);
  const all = await callOk('list_failed_tasks', {}, ctx);
  assert.deepEqual(all.tasks.map(task => task.kind), ['embedding', 'profile', 'extraction']);
  const extraction = all.tasks[2];
  assert.equal(extraction.error_message, 'upstream 500');
  assert.deepEqual(extraction.message_ids, ['msg-a1-3']);
  assert.equal(all.tasks[0].memory_id, 'mem-b-1');

  const scoped = await callOk('list_failed_tasks', { character_id: 'char-a', limit: 1 }, ctx);
  assert.deepEqual(scoped.tasks.map(task => task.kind), ['profile']);
  assert.equal(scoped.has_more, true);
  assert.equal(scoped.next_offset, 1);

  const byKind = await callOk('list_failed_tasks', { kind: 'extraction' }, ctx);
  assert.equal(byKind.tasks.length, 1);
  assert.equal(byKind.has_more, false);
  const none = await callOk('list_failed_tasks', { kind: 'embedding', character_id: 'char-a' }, ctx);
  assert.deepEqual(none.tasks, []);
});

test('list_repairable_candidates includes raw_response and the extraction task state', async t => {
  const { ctx } = createFixture(t);
  const first = await callOk('list_repairable_candidates', { limit: 1 }, ctx);
  assert.deepEqual(ids(first.candidates), [3]);
  assert.equal(first.candidates[0].task, null);
  assert.equal(first.has_more, true);
  assert.equal(first.next_offset, 1);

  const scoped = await callOk('list_repairable_candidates', { character_id: 'char-a' }, ctx);
  assert.deepEqual(ids(scoped.candidates), [1]);
  assert.equal(scoped.candidates[0].raw_response, '{"memories": [ 未闭合');
  assert.deepEqual(scoped.candidates[0].task, {
    status: 'done',
    result_committed: true,
    result_insert_count: 2,
    message_ids: ['msg-a2-1'],
  });
});

test('query_table: columns, equality filters, null/boolean values, ordering and paging', async t => {
  const { ctx } = createFixture(t);
  const page = await callOk('query_table', {
    table: 'memories',
    columns: ['id', 'content'],
    filters: [{ column: 'character_id', value: 'char-a' }, { column: 'status', value: 'active' }],
    order_by: { column: 'id', direction: 'desc' },
    limit: 2,
  }, ctx);
  assert.deepEqual(page.columns, ['id', 'content']);
  assert.deepEqual(page.rows, [
    { id: 'mem-sweet-dislike', content: '用户不爱吃甜' },
    { id: 'mem-name', content: '用户名叫小满' },
  ]);
  assert.equal(page.has_more, true);
  assert.equal(page.next_offset, 2);
  const rest = await callOk('query_table', {
    table: 'memories',
    columns: ['id'],
    filters: [{ column: 'character_id', value: 'char-a' }, { column: 'status', value: 'active' }],
    order_by: { column: 'id', direction: 'desc' },
    limit: 50,
    offset: 2,
  }, ctx);
  assert.deepEqual(ids(rest.rows), ['mem-long', 'mem-hiking', 'mem-baking']);
  assert.equal(rest.has_more, false);
  assert.equal(rest.next_offset, null);

  const pinned = await callOk('query_table', { table: 'memories', columns: ['id'], filters: [{ column: 'pinned', value: true }] }, ctx);
  assert.deepEqual(ids(pinned.rows), ['mem-name']);
  const roots = await callOk('query_table', { table: 'conversations', columns: ['id'], filters: [{ column: 'parent_id', value: null }] }, ctx);
  assert.deepEqual(ids(roots.rows), ['conv-a1', 'conv-a2', 'conv-b1']);

  const allColumns = await callOk('query_table', { table: 'memory_tasks', limit: 1 }, ctx);
  assert.deepEqual(allColumns.columns, [...allowedColumns('memory_tasks')]);
  assert.ok(!('claim_token' in allColumns.rows[0]));
});

test('query_table rejects tables and identifiers outside the whitelist and binds values', async t => {
  const { db, ctx } = createFixture(t);
  const queryTool = tool('query_table');

  // 第一道：schema 只接受白名单表名
  for (const table of ['api_providers', 'settings', 'sqlite_master', 'memories; DROP TABLE memories', '__proto__']) {
    const parsed = parseToolArguments(queryTool, JSON.stringify({ table }));
    assert.equal(parsed.ok, false, `schema accepted table ${table}`);
    // 第二道：绕过 schema 直接执行，也必须拒绝
    const direct = await queryTool.execute({ table, limit: 20, offset: 0 }, ctx);
    assert.equal(direct.ok, false, `execute accepted table ${table}`);
    assert.match(direct.error, /不允许查询表/);
  }

  const injections = [
    { columns: ['id', 'content FROM memories UNION SELECT api_key FROM api_providers --'] },
    { columns: ['claim_token'], table: 'memory_tasks' },
    { columns: ['nonexistent'] },
    { filters: [{ column: 'id = id OR 1', value: 1 }] },
    { order_by: { column: 'id; DROP TABLE memories', direction: 'asc' } },
    { order_by: { column: '(SELECT api_key FROM api_providers)', direction: 'asc' } },
  ];
  for (const injection of injections) {
    const result = await call('query_table', { table: 'memories', ...injection }, ctx);
    assert.equal(result.ok, false, `accepted ${JSON.stringify(injection)}`);
    assert.match(result.error, /不允许列/);
  }

  const literal = await callOk('query_table', { table: 'memories', filters: [{ column: 'id', value: "x' OR 1=1 --" }] }, ctx);
  assert.deepEqual(literal.rows, []);
  assert.equal(literal.has_more, false);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM memories').get().count, 8);

  // 构造器本身也校验分页，SQL 里只有白名单标识符和占位符
  assert.equal(buildTableQuery({ table: 'memories', limit: 51, offset: 0 }).ok, false);
  assert.equal(buildTableQuery({ table: 'memories', limit: 1, offset: -1 }).ok, false);
  const built = buildTableQuery({ table: 'memories', columns: ['id'], filters: [{ column: 'id', value: "x' OR 1=1 --" }], limit: 1, offset: 0 });
  assert.equal(built.ok, true);
  assert.ok(!built.sql.includes('OR 1=1'));
  assert.deepEqual(built.params, ["x' OR 1=1 --", 2, 0]);
});

/** 每个工具的调用参数；query_table 覆盖每张白名单表的全部允许列。 */
function sweepCalls() {
  const memoryIds = ['mem-sweet-dislike', 'mem-baking', 'mem-hiking', 'mem-name', 'mem-long', 'mem-old-sweet', 'mem-archived', 'mem-b-1'];
  return {
    list_characters: [{ limit: 50 }],
    get_character: [{ character_id: 'char-a' }, { character_id: 'char-b' }],
    search_memories: [
      { character_id: 'char-a', query: '甜点', limit: 50 },
      { character_id: 'char-a', query: '甜点', status: 'superseded' },
    ],
    get_memories: [{ memory_ids: memoryIds }],
    get_memory_sources: [{ memory_ids: memoryIds, context: 10 }],
    get_memory_profile: [{ character_id: 'char-a' }, { character_id: 'char-b' }],
    list_conversations: [{ limit: 50 }],
    read_messages: ['conv-a1', 'conv-a2', 'conv-b1', 'conv-a1-branch'].map(id => ({ conversation_id: id, limit: 50 })),
    search_messages: [{ query: '甜点', limit: 50 }, { query: '2026-10-03', limit: 50 }],
    get_system_status: [{}, { character_id: 'char-a' }],
    list_app_events: [{ limit: 50 }],
    list_failed_tasks: [{ limit: 50 }],
    list_repairable_candidates: [{ limit: 50 }],
    load_skill: [{ name: 'memory-review' }],
    prepare_memory_review: [{ character_id: 'char-a' }],
    read_review_batch: [{ character_id: 'char-a', plan_id: 'fixture-read-plan', batch_index: 0 }],
    query_table: QUERYABLE_TABLE_NAMES.flatMap(table => [
      { table, limit: 50 },
      { table, columns: [...allowedColumns(table)], limit: 50 },
    ]),
  };
}

test('secrets sweep: no tool ever returns a credential', async t => {
  const { db, ctx } = createFixture(t);

  // 先证明这个测试有区分力：凭据确实就在库里和环境变量里
  assert.equal(db.prepare('SELECT api_key FROM api_providers').get().api_key, SECRETS.provider);
  const settingsDump = JSON.stringify(db.prepare('SELECT key, value FROM settings').all());
  for (const key of ['main', 'embedding', 'reranker', 'nai', 'custom']) {
    assert.ok(settingsDump.includes(SECRETS[key]), `fixture lost the ${key} secret`);
  }
  assert.equal(process.env.ACCESS_PASSWORD, SECRETS.access);
  assert.equal(process.env.AUTH_SECRET, SECRETS.auth);
  assert.equal(ctx.settings.memory_engine.embedding_api_key, SECRETS.embedding);

  const calls = sweepCalls();
  assert.deepEqual(Object.keys(calls).sort(), [...TOOLS.keys()].sort(), 'sweep must cover every tool');

  // 默认的 search_memories 会发真实 embedding 请求：关掉索引避免联网，向量路径用注入实例另测
  const offlineCtx = withEngine(ctx, { index_enabled: false });
  const runs = [];
  for (const [name, argList] of Object.entries(calls)) {
    for (const args of argList) runs.push({ target: name, args, ctx: offlineCtx });
  }
  const vectorSearch = createSearchMemoriesTool({ embedTexts: fakeEmbedder([1, 0]).embed });
  runs.push({ target: vectorSearch, args: { character_id: 'char-a', query: '甜点', limit: 50 }, ctx });

  let rowsSeen = 0;
  for (const run of runs) {
    const result = await callOk(run.target, run.args, run.ctx);
    const serialized = JSON.stringify(result);
    const label = `${typeof run.target === 'string' ? run.target : run.target.name} ${JSON.stringify(run.args)}`;
    assert.ok(!serialized.includes(SENTINEL), `credential leaked from ${label}`);
    // 结构上就不该碰到凭据：出现脱敏占位符说明是靠第二道防线兜住的
    assert.ok(!serialized.includes(REDACTED_PLACEHOLDER), `credential reached the redaction layer in ${label}`);
    if (Array.isArray(result.rows)) rowsSeen += result.rows.length;
  }
  // query_table 确实读到了数据（空表扫不出泄漏）
  for (const table of QUERYABLE_TABLE_NAMES) {
    assert.ok(db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count > 0, `fixture table ${table} is empty`);
  }
  assert.ok(rowsSeen > 0);
  // 整个扫描期间库处于 query_only：任何工具写库都会在上面直接失败
  assert.throws(() => db.prepare("INSERT INTO settings (key, value) VALUES ('probe', '1')").run(), /readonly/i);
});

test('credentials pasted into chat or memory content are redacted before reaching the model', async t => {
  const { ctx } = createFixture(t, {
    seedData: db => {
      seed(db);
      db.prepare("UPDATE memories SET content = ? WHERE id = 'mem-name'").run(`用户把密钥 ${SECRETS.provider} 发给了我`);
      db.prepare("UPDATE messages SET content = ? WHERE id = 'msg-a1-1'").run(`你好，我的口令是 ${SECRETS.access}`);
    },
  });

  const memories = await callOk('get_memories', { memory_ids: ['mem-name'] }, ctx);
  assert.equal(memories.memories[0].content, `用户把密钥 ${REDACTED_PLACEHOLDER} 发给了我`);

  const messages = await callOk('read_messages', { conversation_id: 'conv-a1', limit: 1 }, ctx);
  assert.equal(messages.messages[0].content, `你好，我的口令是 ${REDACTED_PLACEHOLDER}`);

  const rows = await callOk('query_table', { table: 'messages', columns: ['content'], filters: [{ column: 'id', value: 'msg-a1-1' }] }, ctx);
  assert.ok(!JSON.stringify(rows).includes(SENTINEL));
  assert.ok(JSON.stringify(rows).includes(REDACTED_PLACEHOLDER));
});

test('known short access passwords and API keys in readable content are redacted', async t => {
  const shortPassword = '246810';
  const shortProviderKey = 'p7key';
  const shortMainKey = 'main7';
  const { ctx } = createFixture(t, {
    seedData: db => {
      seed(db);
      db.prepare("UPDATE api_providers SET api_key = ? WHERE id = 'prov-1'").run(shortProviderKey);
      writeSetting(db, 'api_key', shortMainKey);
      db.prepare("UPDATE memories SET content = ? WHERE id = 'mem-name'")
        .run(`接口密钥 ${shortProviderKey} 和 ${shortMainKey}`);
      db.prepare("UPDATE messages SET content = ? WHERE id = 'msg-a1-1'")
        .run(`访问口令 ${shortPassword}`);
    },
  });
  // createFixture 的环境清理会恢复进入本用例前的值。
  process.env.ACCESS_PASSWORD = shortPassword;

  const memories = await callOk('get_memories', { memory_ids: ['mem-name'] }, ctx);
  const messages = await callOk('read_messages', { conversation_id: 'conv-a1', limit: 1 }, ctx);
  const serialized = JSON.stringify({ memories, messages });
  for (const credential of [shortPassword, shortProviderKey, shortMainKey]) {
    assert.ok(!serialized.includes(credential), 'known short credential reached the tool result');
  }
  assert.equal(messages.messages[0].content, `访问口令 ${REDACTED_PLACEHOLDER}`);
  assert.equal(memories.memories[0].content, `接口密钥 ${REDACTED_PLACEHOLDER} 和 ${REDACTED_PLACEHOLDER}`);
});

test('credentials in nested data object keys and values are redacted', async t => {
  const { ctx } = createFixture(t, {
    seedData: db => {
      seed(db);
      const metadata = {
        [SECRETS.provider]: {
          rows: [{ [`prefix-${SECRETS.main}`]: `value-${SECRETS.embedding}` }],
        },
      };
      db.prepare("UPDATE memories SET metadata = ? WHERE id = 'mem-name'").run(JSON.stringify(metadata));
    },
  });
  const result = await callOk('get_memories', { memory_ids: ['mem-name'] }, ctx);
  assert.ok(!JSON.stringify(result).includes(SENTINEL), 'credential in a data key or value reached the tool result');
  assert.deepEqual(result.memories[0].metadata, {
    [REDACTED_PLACEHOLDER]: {
      rows: [{ [`prefix-${REDACTED_PLACEHOLDER}`]: `value-${REDACTED_PLACEHOLDER}` }],
    },
  });
});

test('fixed result protocol keys remain usable while matching data keys are redacted', async t => {
  const { ctx } = createFixture(t, {
    seedData: db => {
      seed(db);
      db.prepare("UPDATE memories SET metadata = ? WHERE id = 'mem-name'")
        .run(JSON.stringify({ ok: 'data value' }));
    },
  });
  process.env.ACCESS_PASSWORD = 'ok';
  const success = await callOk('get_memories', { memory_ids: ['mem-name'] }, ctx);
  assert.equal(success.ok, true);
  assert.ok(!Object.hasOwn(success.memories[0].metadata, 'ok'));
  assert.equal(success.memories[0].metadata[REDACTED_PLACEHOLDER], 'data value');

  process.env.ACCESS_PASSWORD = 'error';
  const failure = await call('read_messages', { conversation_id: 'missing' }, ctx);
  assert.equal(failure.ok, false);
  assert.equal(typeof failure.error, 'string');
});

test('data key collisions after credential redaction fail closed instead of losing a value', async t => {
  const { ctx } = createFixture(t, {
    seedData: db => {
      seed(db);
      db.prepare("UPDATE memories SET metadata = ? WHERE id = 'mem-name'").run(JSON.stringify({
        [`key-${SECRETS.provider}`]: 'first value',
        [`key-${SECRETS.main}`]: 'second value',
      }));
    },
  });
  const result = await call('get_memories', { memory_ids: ['mem-name'] }, ctx);
  assert.equal(result.ok, false);
  assert.match(result.error, /脱敏失败/);
  assert.ok(!JSON.stringify(result).includes(SENTINEL));
  assert.ok(!Object.hasOwn(result, 'memories'));
});

test('redaction preserves __proto__ as an own data key without changing object prototypes', async t => {
  const { ctx } = createFixture(t, {
    seedData: db => {
      seed(db);
      const metadata = JSON.parse('{"__proto__":{"safe":"own data"},"constructor":{"value":"placeholder"}}');
      metadata.constructor.value = SECRETS.provider;
      db.prepare("UPDATE memories SET metadata = ? WHERE id = 'mem-name'").run(JSON.stringify(metadata));
    },
  });
  const result = await callOk('get_memories', { memory_ids: ['mem-name'] }, ctx);
  const metadata = result.memories[0].metadata;
  assert.ok(Object.hasOwn(metadata, '__proto__'));
  assert.equal(Object.getPrototypeOf(metadata), Object.prototype);
  assert.equal(metadata.__proto__.safe, 'own data');
  assert.equal(metadata.constructor.value, REDACTED_PLACEHOLDER);
  assert.ok(!JSON.stringify(result).includes(SENTINEL));
});

test('the redaction marker cannot reintroduce a known credential', async t => {
  const fakeCredential = 'REDACTED';
  const { ctx } = createFixture(t, {
    seedData: db => {
      seed(db);
      db.prepare("UPDATE messages SET content = ? WHERE id = 'msg-a1-1'")
        .run(`访问口令 ${fakeCredential}`);
    },
  });
  process.env.ACCESS_PASSWORD = fakeCredential;
  const result = await callOk('read_messages', { conversation_id: 'conv-a1', limit: 1 }, ctx);
  assert.ok(!JSON.stringify(result).includes(fakeCredential), 'redaction marker reintroduced a known credential');
});

test('redaction failure messages cannot reintroduce a known short credential', async t => {
  const shortKey = '失败';
  const { ctx } = createFixture(t, {
    seedData: db => {
      seed(db);
      writeSetting(db, 'api_key', shortKey);
      db.prepare("UPDATE memories SET metadata = ? WHERE id = 'mem-name'").run(JSON.stringify({
        [`key-${SECRETS.provider}`]: 'first value',
        [`key-${SECRETS.embedding}`]: 'second value',
      }));
    },
  });
  const result = await call('get_memories', { memory_ids: ['mem-name'] }, ctx);
  assert.deepEqual(Object.keys(result).sort(), ['error', 'ok'], 'discarded data must not survive in the fixed result protocol');
  assert.equal(result.ok, false);
  assert.equal(typeof result.error, 'string');
  assert.ok(!result.error.includes(shortKey), 'the fixed failure message reintroduced the short credential');
  assert.ok(!JSON.stringify(result).includes(SENTINEL));
});

test('unavailable redaction returns an empty error instead of unchecked fallback text or data', async t => {
  const { ctx } = createFixture(t);
  const unavailable = { ...ctx, db: { prepare() { throw new Error('credential store unavailable'); } } };
  const result = await runReadTool(unavailable, () => ({ ok: true, data: SECRETS.provider }));
  assert.deepEqual(result, { ok: false, error: '' });
  assert.ok(!JSON.stringify(result).includes(SENTINEL));
});

test('tools never throw: aborted signal and broken database become ok:false', async t => {
  const { ctx } = createFixture(t);
  const controller = new AbortController();
  controller.abort();
  const aborted = await call('list_characters', {}, { ...ctx, signal: controller.signal });
  assert.equal(aborted.ok, false);

  const bare = new Database(':memory:');
  t.after(() => bare.close());
  for (const item of AGENT_READ_TOOLS) {
    const result = await item.execute(
      parseToolArgumentsOrThrow(item, sweepCalls()[item.name][0]),
      { ...ctx, db: bare },
    );
    assert.equal(result.ok, false, `${item.name} did not report the broken database`);
    assert.equal(typeof result.error, 'string');
  }
});

function parseToolArgumentsOrThrow(item, args) {
  const parsed = parseToolArguments(item, JSON.stringify(args));
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.args;
}
