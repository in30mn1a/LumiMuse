const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');
const Database = require('better-sqlite3');

const root = path.resolve(__dirname, '..');
const originalResolveFilename = Module._resolveFilename;

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

// 未注入的默认依赖会走 getDb()：用已迁移的内存库顶掉单例，避免打开真实数据库与后台队列
const { __migrateForTests, __setDbForTests } = require('../src/lib/db.ts');
const isolatedDb = new Database(':memory:');
isolatedDb.pragma('foreign_keys = ON');
__migrateForTests(isolatedDb);
__setDbForTests(isolatedDb);
test.after(() => isolatedDb.close());

const { createMemoryTimeCutoffFilter, parseStoredTimestamp } = require('../src/lib/memory-time-cutoff.ts');
const { retrieveWorkingMemoryPackage } = require('../src/lib/memory-retrieval.ts');
const { embeddingToBlob, normalizeEmbedding } = require('../src/lib/memory-embeddings.ts');

function memory(overrides) {
  return {
    character_id: 'char-a',
    category: '话题历史',
    confidence: 0.9,
    tags: [],
    source_msg_ids: [],
    importance: 0.5,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function baseSettings(memoryEngine = {}) {
  return {
    memory_inject: true,
    limit_inject: true,
    memory_max_inject: 30,
    memory_engine: {
      embedding_enabled: false,
      reranker_enabled: false,
      fallback_local_enabled: true,
      memory_package_token_budget: 4000,
      retrieval_token_budget: 4000,
      vector_top_k: 8,
      keyword_top_k: 8,
      reranker_top_k: 8,
      final_top_k: 8,
      embedding_timeout_ms: 50,
      reranker_timeout_ms: 50,
      ...memoryEngine,
    },
  };
}

const messageTimes = {
  'msg-before': '2026-03-01T10:00:00.000Z',
  'msg-target': '2026-03-01T12:00:00.000Z',
  'msg-after': '2026-03-02T09:00:00.000Z',
};
const lookup = id => messageTimes[id] ? { created_at: messageTimes[id] } : undefined;

test('parseStoredTimestamp reads ISO and SQLite UTC timestamps alike', () => {
  assert.equal(parseStoredTimestamp('2026-03-01 12:00:00'), Date.parse('2026-03-01T12:00:00Z'));
  assert.equal(parseStoredTimestamp('2026-03-01T12:00:00.000Z'), Date.parse('2026-03-01T12:00:00Z'));
  assert.equal(parseStoredTimestamp(''), null);
  assert.equal(parseStoredTimestamp('not a date'), null);
  assert.equal(parseStoredTimestamp(undefined), null);
});

test('cutoff dates a memory by its latest source message, not by when extraction wrote it', () => {
  const filter = createMemoryTimeCutoffFilter({ cutoff: messageTimes['msg-target'], inclusive: false }, lookup);

  // 提取延后：记忆行写于截止之后，但来源是截止之前的对话 → 保留
  assert.equal(filter(memory({ id: 'late-extracted', source_msg_ids: ['msg-before'], created_at: '2026-03-05T00:00:00.000Z' })), true);
  // 来源包含被重生成的那条回复本身 → 剔除（严格早于）
  assert.equal(filter(memory({ id: 'from-target', source_msg_ids: ['msg-before', 'msg-target'] })), false);
  // 来源在截止之后 → 剔除
  assert.equal(filter(memory({ id: 'future', source_msg_ids: ['msg-after'] })), false);
  // 来源全部查不到 → 退回记忆自身 created_at（SQLite 格式）
  assert.equal(filter(memory({ id: 'manual-old', source_msg_ids: ['deleted'], created_at: '2026-02-01 00:00:00' })), true);
  assert.equal(filter(memory({ id: 'manual-new', source_msg_ids: [], created_at: '2026-04-01 00:00:00' })), false);
  // 时间完全无法判断 → 保留，不让角色无端失忆
  assert.equal(filter(memory({ id: 'unknown', created_at: '' })), true);
});

test('inclusive cutoff keeps memories sourced from the anchor user message itself', () => {
  const strict = createMemoryTimeCutoffFilter({ cutoff: messageTimes['msg-target'], inclusive: false }, lookup);
  const inclusive = createMemoryTimeCutoffFilter({ cutoff: messageTimes['msg-target'], inclusive: true }, lookup);
  const anchored = memory({ id: 'anchored', source_msg_ids: ['msg-target'] });
  assert.equal(strict(anchored), false);
  assert.equal(inclusive(anchored), true);
  assert.equal(createMemoryTimeCutoffFilter({ cutoff: 'garbage', inclusive: false }, lookup), undefined);
});

test('chain sequence and external time combine without repeating shared source lookups', () => {
  const sources = {
    before: { seq: 1, created_at: messageTimes['msg-after'] },
    target: { seq: 2, created_at: messageTimes['msg-before'] },
    externalPast: { created_at: messageTimes['msg-before'] },
    externalFuture: { created_at: messageTimes['msg-after'] },
  };
  const calls = new Map();
  const filter = createMemoryTimeCutoffFilter({ cutoff: messageTimes['msg-target'], inclusive: false, seq: 2 }, id => {
    calls.set(id, (calls.get(id) || 0) + 1);
    return sources[id];
  });

  assert.equal(filter(memory({ source_msg_ids: ['before', 'externalPast'] })), true);
  assert.equal(filter(memory({ source_msg_ids: ['before', 'target'] })), false);
  assert.equal(filter(memory({ source_msg_ids: ['externalFuture', 'before'] })), false);
  assert.equal(calls.get('before'), 1);
});

const pastMemory = memory({ id: 'past', content: '用户三月初说过喜欢猫。', source_msg_ids: ['msg-before'] });
const futureMemory = memory({ id: 'future', content: '用户后来养了一只狗。', source_msg_ids: ['msg-after'] });
const futurePinned = memory({ id: 'future-pinned', content: '之后才许下的约定。', source_msg_ids: ['msg-after'], pinned: 1, importance: 0.95 });
const cutoffFilter = createMemoryTimeCutoffFilter({ cutoff: messageTimes['msg-target'], inclusive: false }, lookup);

test('full injection drops memories from after the cutoff', async () => {
  const result = await retrieveWorkingMemoryPackage({
    characterId: 'char-a',
    queryText: '随便聊聊',
    settings: baseSettings({ chat_injection_mode: 'full' }),
    memoryFilter: cutoffFilter,
    deps: {
      loadLegacyMemories: () => [futurePinned, pastMemory, futureMemory],
      tokenCounter: text => text.length,
      markMemoriesUsed: () => {},
    },
  });

  assert.equal(result.mode, 'full');
  assert.deepEqual(result.selectedMemories.map(item => item.id), ['past']);
  assert.ok(!result.text.includes('狗'));
});

test('retrieval paths filter before taking top-k so future memories cannot crowd out past ones', async () => {
  let localFilter;
  const result = await retrieveWorkingMemoryPackage({
    characterId: 'char-a',
    queryText: '宠物',
    settings: baseSettings({
      chat_injection_mode: 'vector',
      embedding_enabled: true,
      embedding_api_base: 'https://example.com/v1',
      embedding_api_key: 'test-key',
      embedding_model: 'fake-embedding',
      vector_top_k: 1,
    }),
    memoryFilter: cutoffFilter,
    deps: {
      embedText: async () => [1, 0],
      // 未来那条与查询最相似；不先过滤的话 top_k=1 会只召回它、过滤后一条不剩
      loadEmbeddingRows: () => [
        { memory_id: 'future', embedding_blob: embeddingToBlob(normalizeEmbedding([1, 0])) },
        { memory_id: 'past', embedding_blob: embeddingToBlob(normalizeEmbedding([0.6, 0.8])) },
      ],
      loadMemoriesByIds: ids => [futureMemory, pastMemory].filter(item => ids.includes(item.id)),
      loadPriorityMemories: () => [futurePinned],
      localRetrieve: (_query, _characterId, _limit, filter) => {
        localFilter = filter;
        return [];
      },
      tokenCounter: text => text.length,
      markMemoriesUsed: () => {},
    },
  });

  assert.deepEqual(result.selectedMemories.map(item => item.id), ['past']);
  if (localFilter) assert.equal(localFilter, cutoffFilter, 'local recall must receive the same filter');
});

test('without a filter retrieval is unchanged (normal chat path)', async () => {
  const result = await retrieveWorkingMemoryPackage({
    characterId: 'char-a',
    queryText: '随便聊聊',
    settings: baseSettings({ chat_injection_mode: 'full' }),
    deps: {
      loadLegacyMemories: () => [futurePinned, pastMemory, futureMemory],
      tokenCounter: text => text.length,
      markMemoriesUsed: () => {},
    },
  });

  assert.deepEqual(result.selectedMemories.map(item => item.id), ['future-pinned', 'past', 'future']);
});

test('historical vector recall loads over 32766 IDs through the production SQLite loader', async () => {
  const characterId = 'char-large-vector';
  isolatedDb.prepare('INSERT INTO characters (id, name) VALUES (?, ?)').run(characterId, '虚构向量角色');
  const insertMemory = isolatedDb.prepare(`
    INSERT INTO memories (id, character_id, category, content, status, created_at)
    VALUES (?, ?, '话题历史', ?, ?, ?)
  `);
  const rows = [];
  const futureEmbedding = embeddingToBlob(normalizeEmbedding([1, 0]));
  const pastEmbedding = embeddingToBlob(normalizeEmbedding([0.6, 0.8]));
  isolatedDb.transaction(() => {
    for (let index = 0; index < 32767; index++) {
      const id = `large-vector-${index}`;
      const isPast = index === 0 || index === 32766;
      insertMemory.run(
        id, characterId, isPast ? '过去的有效记忆' : '未来记忆',
        index === 0 ? 'archived' : 'active',
        isPast ? '2026-02-01T00:00:00Z' : '2026-04-01T00:00:00Z',
      );
      rows.push({ memory_id: id, embedding_blob: index === 32766 ? pastEmbedding : futureEmbedding });
    }
  })();

  const result = await retrieveWorkingMemoryPackage({
    characterId,
    queryText: '过去',
    settings: baseSettings({
      chat_injection_mode: 'vector',
      embedding_enabled: true,
      embedding_api_base: 'https://example.com/v1',
      embedding_model: 'fake-embedding',
      vector_top_k: 1,
      total_retrieval_timeout_ms: 10000,
    }),
    memoryFilter: cutoffFilter,
    deps: {
      embedText: async () => [1, 0],
      loadEmbeddingRows: () => rows,
      loadPriorityMemories: () => [],
      localRetrieve: () => [],
      tokenCounter: text => text.length,
      markMemoriesUsed: () => {},
      // 不替换 loadMemoriesByIds：必须经过生产 SQL，而非测试假加载器。
    },
  });

  assert.equal(result.usedFallback, false, JSON.stringify(result.diagnostics));
  assert.equal(result.mode, 'vector');
  assert.deepEqual(result.selectedMemories.map(item => item.id), ['large-vector-32766']);
});

for (const linked of [false, true]) {
  for (const generation of ['regenerate', 'insert']) {
    test(`runChat ${generation} respects same-timestamp source order in ${linked ? 'linked' : 'independent'} conversations`, async t => {
      const prefix = `${linked ? 'linked' : 'own'}-${generation}`;
      const characterId = `${prefix}-char`;
      const parentId = `${prefix}-parent`;
      const conversationId = linked ? `${prefix}-child` : parentId;
      const externalId = `${prefix}-external`;
      const timestamp = '2026-03-01T12:00:00.000Z';
      isolatedDb.prepare('INSERT INTO characters (id, name, memory_chat_injection_mode) VALUES (?, ?, ?)')
        .run(characterId, '虚构历史角色', 'full');
      const insertConversation = isolatedDb.prepare('INSERT INTO conversations (id, character_id, title) VALUES (?, ?, ?)');
      insertConversation.run(parentId, characterId, '父对话');
      insertConversation.run(externalId, characterId, '外部对话');
      if (linked) {
        isolatedDb.prepare(`
          INSERT INTO conversations (id, character_id, title, parent_id, parent_seq_end)
          VALUES (?, ?, '子对话', ?, 2)
        `).run(conversationId, characterId, parentId);
      }
      const insertMessage = isolatedDb.prepare(`
        INSERT INTO messages (id, conversation_id, role, content, created_at, seq)
        VALUES (?, ?, ?, '虚构对话内容', ?, ?)
      `);
      insertMessage.run(`${prefix}-anchor`, parentId, 'user', timestamp, 1);
      insertMessage.run(`${prefix}-target`, parentId, 'assistant', timestamp, 2);
      insertMessage.run(`${prefix}-later`, conversationId, 'user', timestamp, 3);
      insertMessage.run(`${prefix}-external-past`, externalId, 'user', '2026-03-01T11:59:59Z', 99);
      insertMessage.run(`${prefix}-external-future`, externalId, 'user', '2026-03-01T12:00:01Z', 1);
      if (linked) {
        insertMessage.run(`${prefix}-outside-boundary`, parentId, 'user', '2026-03-01T11:59:59Z', 3);
      }
      const insertMemory = isolatedDb.prepare(`
        INSERT INTO memories (id, character_id, category, content, source_msg_ids, created_at)
        VALUES (?, ?, '话题历史', ?, ?, '2026-04-01T00:00:00Z')
      `);
      const memorySources = [
        ['KEEP_ANCHOR_MEMORY', ['anchor']],
        ['DROP_TARGET_MEMORY', ['target']],
        ['DROP_LATER_MEMORY', ['later']],
        ['KEEP_EXTERNAL_PAST_MEMORY', ['external-past']],
        ['DROP_EXTERNAL_FUTURE_MEMORY', ['external-future']],
        ['DROP_MIXED_SOURCE_MEMORY', ['anchor', 'external-future']],
      ];
      if (linked) memorySources.push(['KEEP_OUTSIDE_VISIBLE_CHAIN_MEMORY', ['outside-boundary']]);
      for (const [marker, sources] of memorySources) {
        insertMemory.run(`${prefix}-${marker}`, characterId, marker, JSON.stringify(sources.map(id => `${prefix}-${id}`)));
      }

      const requests = [];
      t.mock.method(require('../src/lib/ssrf-guard.ts'), 'safeFetch', async (_url, init) => {
        requests.push(init.body);
        return new Response(JSON.stringify({
          choices: [{ message: { role: 'assistant', content: '虚构回复' }, finish_reason: 'stop' }],
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      });
      const settings = {
        ...require('../src/lib/settings.ts').loadSettings(),
        api_base: 'https://upstream.test/v1', api_key: 'test-key', model: 'test-model', streaming: false,
      };
      const errors = [];
      let completed = false;
      await require('../src/lib/chat-engine.ts').runChat(conversationId, '', settings, {
        onChunk() {},
        onDone() { completed = true; },
        onError(error) { errors.push(error.message); },
      }, generation === 'regenerate'
        ? { regenerateAssistantId: `${prefix}-target`, skipUserInsert: true }
        : { insertAssistantAfterUserId: `${prefix}-anchor`, skipUserInsert: true });

      assert.deepEqual(errors, []);
      assert.equal(completed, true);
      assert.equal(requests.length, 1);
      for (const [marker] of memorySources) {
        assert.equal(requests[0].includes(marker), marker.startsWith('KEEP_'), marker);
      }
    });
  }
}
