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

function createCharacterDb() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
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
      active_preset_id TEXT,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE conversations (
      id TEXT PRIMARY KEY,
      character_id TEXT NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
      title TEXT NOT NULL DEFAULT '',
      ignore_memory INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      parent_id TEXT,
      parent_seq_end INTEGER
    );

    CREATE TABLE messages (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      token_count INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      seq INTEGER NOT NULL DEFAULT 0,
      metadata TEXT NOT NULL DEFAULT '{}'
    );

    CREATE TABLE memories (
      id TEXT PRIMARY KEY,
      character_id TEXT NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
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

    CREATE TABLE memory_embeddings (
      memory_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
      character_id TEXT NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
      provider TEXT NOT NULL,
      model TEXT NOT NULL,
      dimension INTEGER NOT NULL,
      embedding_blob BLOB NOT NULL,
      normalized INTEGER NOT NULL DEFAULT 1,
      embedding_text_hash TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'ready',
      error_message TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(memory_id, provider, model, dimension)
    );

    CREATE TABLE character_memory_profiles (
      character_id TEXT PRIMARY KEY REFERENCES characters(id) ON DELETE CASCADE,
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
      character_id TEXT NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
      version_number INTEGER NOT NULL,
      snapshot_json TEXT NOT NULL,
      reason TEXT NOT NULL,
      task_id INTEGER,
      created_at TEXT NOT NULL
    );

    CREATE TABLE character_model_preset_bindings (
      character_id TEXT NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
      model TEXT NOT NULL,
      preset_id TEXT NOT NULL,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (character_id, model)
    );

    CREATE TABLE character_memory_configs (
      character_id TEXT PRIMARY KEY REFERENCES characters(id) ON DELETE CASCADE,
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

    CREATE TABLE memory_tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      character_id TEXT NOT NULL,
      conversation_id TEXT NOT NULL,
      message_ids TEXT NOT NULL DEFAULT '[]',
      status TEXT NOT NULL
    );

    CREATE TABLE memory_embedding_tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      memory_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
      character_id TEXT NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
      reason TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      claim_token TEXT,
      lease_expires_at TEXT,
      retry_count INTEGER NOT NULL DEFAULT 0,
      error_message TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE character_memory_profile_update_tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      character_id TEXT NOT NULL,
      reason TEXT NOT NULL,
      patch_json TEXT NOT NULL,
      status TEXT NOT NULL
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

  const sourceCreatedAt = '2026-08-01T00:00:00.000Z';
  const sourceUpdatedAt = '2026-08-02T00:00:00.000Z';
  db.prepare(`
    INSERT INTO characters (
      id, name, avatar_url, basic_info, personality, scenario, greeting,
      example_dialogue, system_prompt, other_info, image_tags, user_image_tags,
      active_preset_id, sort_order, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    'char-source',
    '艾莉丝',
    '/api/files/avatars/source.png',
    '角色基本信息',
    '温柔可靠',
    '长期陪伴',
    '欢迎回来，主人。',
    '<START>\n示例',
    '始终保持角色表现',
    '补充信息',
    '1girl, blue eyes',
    '1boy, black hair',
    'preset-source',
    7,
    sourceCreatedAt,
    sourceUpdatedAt,
  );

  db.prepare(`
    INSERT INTO conversations (id, character_id, title, ignore_memory, created_at, updated_at)
    VALUES ('conv-source', 'char-source', '共同回忆', 1, ?, ?)
  `).run(sourceCreatedAt, sourceUpdatedAt);

  db.prepare(`
    INSERT INTO messages (id, conversation_id, role, content, token_count, created_at, seq, metadata)
    VALUES (?, 'conv-source', ?, ?, ?, ?, ?, ?)
  `).run(
    'msg-user',
    'user',
    '主人喜欢雨夜。',
    8,
    '2026-08-01T00:00:01.000Z',
    1,
    JSON.stringify({ marker: 'source-user' }),
  );
  db.prepare(`
    INSERT INTO messages (id, conversation_id, role, content, token_count, created_at, seq, metadata)
    VALUES (?, 'conv-source', ?, ?, ?, ?, ?, ?)
  `).run(
    'msg-assistant',
    'assistant',
    [
      '艾莉丝会一直记得。',
      '本地生成图 ![](/api/files/generated/source-image.png?view=1)',
      '本地附件 /api/files/attachments/source-note.txt#download',
      '本地头像 /api/files/avatars/source.png',
      '外链 https://cdn.example.com/generated/source-image.png',
      '外链查询 https://cdn.example.com/proxy?src=/api/files/generated/source-image.png',
    ].join('\n'),
    9,
    '2026-08-01T00:00:02.000Z',
    2,
    JSON.stringify({
      generatedImages: [{ id: 'image-1', url: '/api/files/generated/source-image.png', prompt: 'rainy night' }],
      summarizedIds: ['msg-user'],
      lineage: {
        messageId: 'msg-assistant',
        memoryId: 'mem-source',
        refs: ['msg-user', 'mem-result'],
      },
    }),
  );

  const insertMemory = db.prepare(`
    INSERT INTO memories (
      id, character_id, category, content, confidence, tags, source_msg_ids,
      memory_kind, importance, emotional_weight, status, pinned, last_used_at,
      usage_count, metadata, created_at, updated_at
    ) VALUES (?, 'char-source', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  insertMemory.run(
    'mem-source',
    '偏好习惯',
    '主人喜欢雨夜听轻音乐。',
    0.91,
    JSON.stringify(['雨夜', '音乐']),
    JSON.stringify(['msg-user', 'msg-assistant']),
    'preference',
    0.87,
    0.33,
    'archived',
    1,
    '2026-08-03T00:00:00.000Z',
    7,
    JSON.stringify({
      archiveBatchId: 'archive-batch',
      summarizedBy: 'mem-result',
      coveredMemoryIds: ['mem-source', 'mem-result'],
      supersededBy: { memoryId: 'mem-result', sourceMsgIds: ['msg-user'] },
      sourceInvalidation: { messageId: 'msg-user', replacementMessageId: 'msg-assistant' },
      lookup: { 'mem-result': { 'msg-user': 'mem-source' } },
    }),
    sourceCreatedAt,
    sourceUpdatedAt,
  );
  insertMemory.run(
    'mem-result',
    '基础信息',
    '雨夜是两人的重要共同回忆。',
    0.95,
    JSON.stringify(['共同回忆']),
    JSON.stringify(['msg-assistant']),
    'event',
    0.92,
    0.71,
    'active',
    0,
    null,
    2,
    JSON.stringify({ mergeRole: 'result', mergedFromIds: ['mem-source'] }),
    sourceCreatedAt,
    sourceUpdatedAt,
  );

  const insertEmbedding = db.prepare(`
    INSERT INTO memory_embeddings (
      memory_id, character_id, provider, model, dimension, embedding_blob,
      normalized, embedding_text_hash, status, error_message, created_at, updated_at
    ) VALUES (?, 'char-source', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  insertEmbedding.run(
    'mem-source',
    'openai-compatible',
    'embed-model',
    4,
    Buffer.from([1, 2, 3, 4]),
    0,
    'hash-ready',
    'ready',
    null,
    sourceCreatedAt,
    sourceUpdatedAt,
  );
  insertEmbedding.run(
    'mem-result',
    'openai-compatible',
    'embed-model',
    4,
    Buffer.from([9, 9, 9, 9]),
    1,
    'hash-failed',
    'failed',
    'old failure',
    sourceCreatedAt,
    sourceUpdatedAt,
  );

  db.prepare(`
    INSERT INTO character_memory_profiles (
      character_id, profile_name, relationship_state, recent_story_state,
      emotional_baseline, open_threads, user_profile_summary, pinned_summary, updated_at
    ) VALUES ('char-source', ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    '陪伴画像',
    '彼此信任',
    '正在回忆雨夜',
    '平静温柔',
    JSON.stringify(['一起听歌', '准备旅行']),
    '主人喜欢安静的陪伴',
    '优先安抚主人',
    sourceUpdatedAt,
  );

  const profileSnapshot = {
    character_id: 'char-source',
    profile_name: '陪伴画像',
    relationship_state: '彼此信任',
    recent_story_state: '正在回忆雨夜',
    emotional_baseline: '平静温柔',
    open_threads: ['一起听歌'],
    user_profile_summary: '主人喜欢安静的陪伴',
    pinned_summary: '优先安抚主人',
    updated_at: sourceUpdatedAt,
  };
  db.prepare(`
    INSERT INTO character_memory_profile_versions (
      character_id, version_number, snapshot_json, reason, task_id, created_at
    ) VALUES ('char-source', ?, ?, ?, ?, ?)
  `).run(1, JSON.stringify(profileSnapshot), 'memory_extraction', 41, sourceCreatedAt);
  db.prepare(`
    INSERT INTO character_memory_profile_versions (
      character_id, version_number, snapshot_json, reason, task_id, created_at
    ) VALUES ('char-source', ?, ?, ?, ?, ?)
  `).run(2, JSON.stringify({ ...profileSnapshot, relationship_state: '更加亲密' }), 'manual_edit', 42, sourceUpdatedAt);

  db.prepare(`
    INSERT INTO character_model_preset_bindings (
      character_id, model, preset_id, sort_order, created_at, updated_at
    ) VALUES ('char-source', 'claude-sonnet-4', 'preset-model', 0, ?, ?);
  `).run(sourceCreatedAt, sourceUpdatedAt);

  db.prepare(`
    INSERT INTO character_memory_configs (
      character_id, enabled, memory_package_token_budget, profile_token_budget,
      pinned_token_budget, open_threads_token_budget, retrieval_token_budget,
      memory_max_inject_override, vector_enabled_override, reranker_enabled_override,
      vector_top_k_override, reranker_top_k_override, embedding_model_override,
      reranker_model_override, updated_at
    ) VALUES ('char-source', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(1, 20000, 3000, 4000, 2500, 9000, null, 1, 0, 88, 44, 'embed-override', 'rerank-override', sourceUpdatedAt);

  db.prepare(`
    INSERT INTO memory_tasks (character_id, conversation_id, message_ids, status)
    VALUES ('char-source', 'conv-source', '["msg-user"]', 'done')
  `).run();
  db.prepare(`
    INSERT INTO memory_embedding_tasks (
      memory_id, character_id, reason, status, claim_token, lease_expires_at,
      retry_count, error_message, created_at, updated_at
    ) VALUES ('mem-result', 'char-source', 'updated', 'processing', 'source-claim', ?, 3, 'source retry', ?, ?)
  `).run('2026-08-02T00:05:00.000Z', sourceCreatedAt, sourceUpdatedAt);
  db.prepare(`
    INSERT INTO character_memory_profile_update_tasks (character_id, reason, patch_json, status)
    VALUES ('char-source', 'memory_extraction', '{}', 'pending')
  `).run();
  db.prepare(`
    INSERT INTO memory_extraction_candidates (
      task_id, character_id, conversation_id, raw_candidate_json, raw_response,
      status, error_reason, created_at, updated_at
    ) VALUES (1, 'char-source', 'conv-source', '{}', '{}', 'repairable', NULL, ?, ?)
  `).run(sourceCreatedAt, sourceUpdatedAt);

  return db;
}

function createAssetMocks({ failMetadataAt = 0 } = {}) {
  const copyCalls = [];
  const physicalCopies = [];
  const metadataCalls = [];
  const cleanupCalls = [];
  const indexTriggerCalls = [];
  let metadataCallCount = 0;

  const {
    collectLocalAssetUrlsFromContent,
  } = require('../src/lib/character-file-utils.ts');

  function duplicateMetadataValue(value, copiedUrls, generatedCharacterId) {
    if (Array.isArray(value)) {
      return value.map(item => duplicateMetadataValue(item, copiedUrls, generatedCharacterId));
    }
    if (!value || typeof value !== 'object') return value;

    const result = {};
    for (const [key, item] of Object.entries(value)) {
      if (
        (key === 'url' || key === 'data')
        && typeof item === 'string'
        && item.startsWith('/api/files/generated/')
      ) {
        const alreadyCopied = copiedUrls.get(item);
        if (alreadyCopied) {
          result[key] = alreadyCopied;
          continue;
        }
        const newUrl = generatedCharacterId
          ? `/api/files/generated/${generatedCharacterId}/copied-image.png`
          : '/api/files/generated/copied-image.png';
        physicalCopies.push(item);
        copiedUrls.set(item, newUrl);
        result[key] = newUrl;
      } else {
        result[key] = duplicateMetadataValue(item, copiedUrls, generatedCharacterId);
      }
    }
    return result;
  }

  return {
    copyCalls,
    physicalCopies,
    metadataCalls,
    cleanupCalls,
    indexTriggerCalls,
    collectLocalAssetUrlsFromContent,
    async copyLocalAssetUrl(url, copiedUrls, options = {}) {
      copyCalls.push({ url, options });
      if (typeof url !== 'string') return url;
      const alreadyCopied = copiedUrls.get(url);
      if (alreadyCopied) return alreadyCopied;
      const copied = url.startsWith('/api/files/generated/') || url.startsWith('/generated/')
        ? `/api/files/generated/${options.generatedCharacterId}/copied-image.png`
        : url.startsWith('/api/files/attachments/') || url.startsWith('/attachments/')
          ? '/api/files/attachments/copied-attachment.txt'
          : '/api/files/avatars/copied-avatar.png';
      physicalCopies.push(url);
      copiedUrls.set(url, copied);
      return copied;
    },
    async duplicateCharacterFilesInMetadata(metadata, copiedUrls, options = {}) {
      metadataCallCount += 1;
      metadataCalls.push({ metadata, options });
      const parsed = typeof metadata === 'string' ? JSON.parse(metadata) : metadata;
      const duplicated = duplicateMetadataValue(parsed, copiedUrls, options.generatedCharacterId);
      if (failMetadataAt === metadataCallCount) {
        throw new Error(`injected metadata copy failure ${metadataCallCount}`);
      }
      return JSON.stringify(duplicated);
    },
    async deleteLocalAssetUrls(urls) {
      cleanupCalls.push([...urls]);
    },
    remapJsonStringIds(value, idMap) {
      const parsed = JSON.parse(value);
      return JSON.stringify(parsed.map(item => typeof item === 'string' ? (idMap.get(item) || item) : item));
    },
  };
}

function withDbFaults(storage, { failEmbeddingInsert = false, failFinalCharacterRead = false } = {}) {
  let characterReadCount = 0;
  return {
    exec(sql) {
      return storage.exec(sql);
    },
    prepare(sql) {
      const normalized = sql.replace(/\s+/g, ' ').trim();
      const statement = storage.prepare(sql);

      if (failFinalCharacterRead && normalized === 'SELECT * FROM characters WHERE id = ?') {
        return {
          get(...args) {
            characterReadCount += 1;
            if (characterReadCount === 2) throw new Error('injected final response read failure');
            return statement.get(...args);
          },
        };
      }

      if (failEmbeddingInsert && normalized.startsWith('INSERT INTO memory_embeddings')) {
        return {
          run() {
            throw new Error('injected embedding insert failure');
          },
        };
      }

      return statement;
    },
    transaction(fn) {
      return storage.transaction(fn);
    },
  };
}

function loadDuplicateRoute(db, assetMocks) {
  let uuidCounter = 0;
  return requireFreshWithMocks('../src/app/api/characters/[id]/duplicate/route.ts', {
    'next/server': jsonResponseMock(),
    '@/lib/db': { getDb: () => db },
    '@/lib/character-file-utils': assetMocks,
    '@/lib/memory-index-trigger': {
      triggerMemoryIndexProcessing() {
        assetMocks.indexTriggerCalls.push('triggered');
        return true;
      },
    },
    crypto: {
      ...require('node:crypto'),
      randomUUID() {
        uuidCounter += 1;
        return `id-${String(uuidCounter).padStart(9, '0')}-0000-4000-8000-000000000000`;
      },
    },
  });
}

function countForCharacter(db, table, characterId) {
  return db.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE character_id = ?`).get(characterId).count;
}

test('/api/characters/[id]/duplicate copies committed memory authority and remaps nested ids', async () => {
  const db = createCharacterDb();
  const assets = createAssetMocks();
  const route = loadDuplicateRoute(db, assets);

  try {
    const response = await route.POST({}, { params: Promise.resolve({ id: 'char-source' }) });
    const payload = await response.json();

    assert.equal(response.status, 201);
    assert.equal(payload.id, 'id-000000001');
    assert.equal(payload.name, '艾莉丝（副本）');
    assert.equal(payload.active_preset_id, 'preset-source');
    assert.deepEqual(payload.model_preset_bindings, [
      { model: 'claude-sonnet-4', preset_id: 'preset-model' },
    ]);
    assert.equal(payload.basic_info, '角色基本信息');
    assert.equal(payload.user_image_tags, '1boy, black hair');

    assert.ok(assets.copyCalls.every(call => call.options.generatedCharacterId === payload.id));
    assert.ok(assets.metadataCalls.every(call => call.options.generatedCharacterId === payload.id));

    const copiedConversation = db.prepare(
      'SELECT * FROM conversations WHERE character_id = ?'
    ).get(payload.id);
    assert.equal(copiedConversation.title, '共同回忆');
    assert.equal(copiedConversation.ignore_memory, 1);

    const copiedMessages = db.prepare(
      'SELECT * FROM messages WHERE conversation_id = ? ORDER BY seq ASC'
    ).all(copiedConversation.id);
    assert.equal(copiedMessages[0].content, '主人喜欢雨夜。');
    assert.equal(copiedMessages[1].content, [
      '艾莉丝会一直记得。',
      `本地生成图 ![](/api/files/generated/${payload.id}/copied-image.png?view=1)`,
      '本地附件 /api/files/attachments/copied-attachment.txt#download',
      '本地头像 /api/files/avatars/copied-avatar.png',
      '外链 https://cdn.example.com/generated/source-image.png',
      '外链查询 https://cdn.example.com/proxy?src=/api/files/generated/source-image.png',
    ].join('\n'));
    assert.deepEqual(copiedMessages.map(row => row.seq), [1, 2]);
    const copiedUser = copiedMessages[0];
    const copiedAssistant = copiedMessages[1];
    const assistantMetadata = JSON.parse(copiedAssistant.metadata);
    const { resolveMessageTokenCount } = require('../src/lib/message-token-provenance.ts');
    const resolvedTokenCount = resolveMessageTokenCount({
      ...copiedAssistant,
      metadata: assistantMetadata,
    });
    assert.equal(resolvedTokenCount.reused, true);
    assert.equal(resolvedTokenCount.tokenCount, copiedAssistant.token_count);
    assert.notEqual(copiedAssistant.token_count, 9);
    assert.equal(
      assistantMetadata.generatedImages[0].url,
      `/api/files/generated/${payload.id}/copied-image.png`,
    );
    assert.deepEqual(assistantMetadata.summarizedIds, [copiedUser.id]);
    assert.equal(assistantMetadata.lineage.messageId, copiedAssistant.id);

    const copiedMemories = db.prepare(
      'SELECT * FROM memories WHERE character_id = ? ORDER BY content ASC'
    ).all(payload.id);
    assert.equal(copiedMemories.length, 2);
    const copiedSource = copiedMemories.find(row => row.content === '主人喜欢雨夜听轻音乐。');
    const copiedResult = copiedMemories.find(row => row.content === '雨夜是两人的重要共同回忆。');
    assert.ok(copiedSource);
    assert.ok(copiedResult);
    assert.notEqual(copiedSource.id, 'mem-source');
    assert.notEqual(copiedResult.id, 'mem-result');
    assert.equal(copiedSource.memory_kind, 'preference');
    assert.equal(copiedSource.importance, 0.87);
    assert.equal(copiedSource.emotional_weight, 0.33);
    assert.equal(copiedSource.status, 'archived');
    assert.equal(copiedSource.pinned, 1);
    assert.equal(copiedSource.last_used_at, '2026-08-03T00:00:00.000Z');
    assert.equal(copiedSource.usage_count, 7);
    assert.deepEqual(JSON.parse(copiedSource.source_msg_ids), [copiedUser.id, copiedAssistant.id]);

    const sourceMetadata = JSON.parse(copiedSource.metadata);
    assert.equal(sourceMetadata.summarizedBy, copiedResult.id);
    assert.deepEqual(sourceMetadata.coveredMemoryIds, [copiedSource.id, copiedResult.id]);
    assert.equal(sourceMetadata.supersededBy.memoryId, copiedResult.id);
    assert.deepEqual(sourceMetadata.supersededBy.sourceMsgIds, [copiedUser.id]);
    assert.equal(sourceMetadata.sourceInvalidation.messageId, copiedUser.id);
    assert.equal(sourceMetadata.sourceInvalidation.replacementMessageId, copiedAssistant.id);
    assert.equal(sourceMetadata.lookup[copiedResult.id][copiedUser.id], copiedSource.id);
    const resultMetadata = JSON.parse(copiedResult.metadata);
    assert.deepEqual(resultMetadata.mergedFromIds, [copiedSource.id]);
    assert.equal(assistantMetadata.lineage.memoryId, copiedSource.id);
    assert.deepEqual(assistantMetadata.lineage.refs, [copiedUser.id, copiedResult.id]);

    const copiedEmbedding = db.prepare(
      'SELECT * FROM memory_embeddings WHERE character_id = ?'
    ).get(payload.id);
    assert.equal(countForCharacter(db, 'memory_embeddings', payload.id), 1);
    assert.equal(copiedEmbedding.memory_id, copiedSource.id);
    assert.equal(copiedEmbedding.provider, 'openai-compatible');
    assert.equal(copiedEmbedding.model, 'embed-model');
    assert.equal(copiedEmbedding.dimension, 4);
    assert.equal(copiedEmbedding.normalized, 0);
    assert.equal(copiedEmbedding.embedding_text_hash, 'hash-ready');
    assert.equal(copiedEmbedding.status, 'ready');
    assert.deepEqual([...copiedEmbedding.embedding_blob], [1, 2, 3, 4]);
    assert.deepEqual(assets.physicalCopies, [
      '/api/files/avatars/source.png',
      '/api/files/generated/source-image.png',
      '/api/files/attachments/source-note.txt',
    ]);

    const copiedProfile = db.prepare(
      'SELECT * FROM character_memory_profiles WHERE character_id = ?'
    ).get(payload.id);
    assert.equal(copiedProfile.profile_name, '陪伴画像');
    assert.equal(copiedProfile.relationship_state, '彼此信任');
    assert.equal(copiedProfile.open_threads, JSON.stringify(['一起听歌', '准备旅行']));

    const copiedVersions = db.prepare(`
      SELECT version_number, snapshot_json, reason, task_id, created_at
      FROM character_memory_profile_versions
      WHERE character_id = ?
      ORDER BY version_number ASC
    `).all(payload.id);
    assert.equal(copiedVersions.length, 2);
    assert.deepEqual(copiedVersions.map(row => row.version_number), [1, 2]);
    assert.deepEqual(copiedVersions.map(row => row.reason), ['memory_extraction', 'manual_edit']);
    assert.ok(copiedVersions.every(row => row.task_id === null));
    assert.ok(copiedVersions.every(row => JSON.parse(row.snapshot_json).character_id === payload.id));

    const copiedConfig = db.prepare(
      'SELECT * FROM character_memory_configs WHERE character_id = ?'
    ).get(payload.id);
    assert.equal(copiedConfig.enabled, 1);
    assert.equal(copiedConfig.memory_package_token_budget, 20000);
    assert.equal(copiedConfig.vector_top_k_override, 88);
    assert.equal(copiedConfig.embedding_model_override, 'embed-override');

    const copiedBindings = db.prepare(
      'SELECT model, preset_id FROM character_model_preset_bindings WHERE character_id = ?',
    ).all(payload.id);
    assert.deepEqual(copiedBindings, [
      { model: 'claude-sonnet-4', preset_id: 'preset-model' },
    ]);

    for (const table of [
      'memory_tasks',
      'character_memory_profile_update_tasks',
      'memory_extraction_candidates',
    ]) {
      assert.equal(countForCharacter(db, table, payload.id), 0, table);
    }
  } finally {
    db.close();
  }
});

test('/api/characters/[id]/duplicate creates fresh index work for active memories without a ready embedding', async () => {
  const db = createCharacterDb();
  // 同时保留一个已有 ready embedding 的 active memory，确保只给真正缺索引者排新任务。
  db.prepare("UPDATE memories SET status = 'active' WHERE id = 'mem-source'").run();
  const assets = createAssetMocks();
  const route = loadDuplicateRoute(db, assets);

  try {
    const response = await route.POST({}, { params: Promise.resolve({ id: 'char-source' }) });
    const payload = await response.json();

    assert.equal(response.status, 201);
    const copiedResult = db.prepare(`
      SELECT id FROM memories
      WHERE character_id = ? AND content = '雨夜是两人的重要共同回忆。'
    `).get(payload.id);
    const copiedEmbeddingTask = db.prepare(`
      SELECT memory_id, reason, status, claim_token, lease_expires_at,
             retry_count, error_message
      FROM memory_embedding_tasks
      WHERE character_id = ?
    `).get(payload.id);
    assert.deepEqual(copiedEmbeddingTask, {
      memory_id: copiedResult.id,
      reason: 'rebuild',
      status: 'pending',
      claim_token: null,
      lease_expires_at: null,
      retry_count: 0,
      error_message: null,
    });
    assert.deepEqual(assets.indexTriggerCalls, ['triggered']);
  } finally {
    db.close();
  }
});

test('/api/characters/[id]/duplicate compensates files when pre-transaction asset copying fails', async () => {
  const db = createCharacterDb();
  const assets = createAssetMocks({ failMetadataAt: 2 });
  const route = loadDuplicateRoute(db, assets);

  try {
    const response = await route.POST({}, { params: Promise.resolve({ id: 'char-source' }) });
    const payload = await response.json();

    assert.equal(response.status, 500);
    assert.match(payload.error, /injected metadata copy failure/);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM characters WHERE id <> 'char-source'").get().count, 0);
    assert.equal(assets.cleanupCalls.length, 1);
    assert.deepEqual(new Set(assets.cleanupCalls[0]), new Set([
      '/api/files/avatars/copied-avatar.png',
      '/api/files/generated/id-000000001/copied-image.png',
    ]));
    assert.deepEqual(assets.indexTriggerCalls, []);
  } finally {
    db.close();
  }
});

test('/api/characters/[id]/duplicate rolls back all rows and compensates files when a late insert fails', async () => {
  const storage = createCharacterDb();
  const db = withDbFaults(storage, { failEmbeddingInsert: true });
  const assets = createAssetMocks();
  const route = loadDuplicateRoute(db, assets);

  try {
    const response = await route.POST({}, { params: Promise.resolve({ id: 'char-source' }) });
    const payload = await response.json();

    assert.equal(response.status, 500);
    assert.match(payload.error, /injected embedding insert failure/);
    assert.equal(storage.prepare("SELECT COUNT(*) AS count FROM characters WHERE id <> 'char-source'").get().count, 0);
    assert.equal(storage.prepare("SELECT COUNT(*) AS count FROM conversations WHERE character_id <> 'char-source'").get().count, 0);
    assert.equal(storage.prepare("SELECT COUNT(*) AS count FROM memories WHERE character_id <> 'char-source'").get().count, 0);
    assert.equal(storage.prepare("SELECT COUNT(*) AS count FROM character_memory_profiles WHERE character_id <> 'char-source'").get().count, 0);
    assert.equal(assets.cleanupCalls.length, 1);
    assert.ok(assets.cleanupCalls[0].includes('/api/files/avatars/copied-avatar.png'));
    assert.ok(assets.cleanupCalls[0].includes('/api/files/generated/id-000000001/copied-image.png'));
    assert.deepEqual(assets.indexTriggerCalls, []);
  } finally {
    storage.close();
  }
});

test('/api/characters/[id]/duplicate does not delete committed files when the final response read fails', async () => {
  const storage = createCharacterDb();
  const db = withDbFaults(storage, { failFinalCharacterRead: true });
  const assets = createAssetMocks();
  const route = loadDuplicateRoute(db, assets);

  try {
    const response = await route.POST({}, { params: Promise.resolve({ id: 'char-source' }) });
    const payload = await response.json();

    assert.equal(response.status, 500);
    assert.match(payload.error, /injected final response read failure/);
    assert.equal(storage.prepare("SELECT COUNT(*) AS count FROM characters WHERE id <> 'char-source'").get().count, 1);
    assert.equal(assets.cleanupCalls.length, 0);
    assert.deepEqual(assets.indexTriggerCalls, ['triggered']);
  } finally {
    storage.close();
  }
});

test('/api/characters/[id]/duplicate preserves a linked snapshot when its parent later grows', async () => {
  const db = createCharacterDb();
  // 在源角色上补一段「仅索引」子对话：自身只有 1 条消息，历史继承自 conv-source
  db.prepare(`
    INSERT INTO conversations (id, character_id, title, ignore_memory, created_at, updated_at, parent_id, parent_seq_end)
    VALUES ('conv-linked', 'char-source', '续篇', 0, '2026-08-02T00:00:00.000Z', '2026-08-02T00:00:00.000Z', 'conv-source', 2)
  `).run();
  db.prepare(`
    INSERT INTO messages (id, conversation_id, role, content, token_count, created_at, seq, metadata)
    VALUES ('msg-linked', 'conv-linked', 'user', '续篇第一句', 5, '2026-08-02T00:00:01.000Z', 3, '{}')
  `).run();
  // 子对话只继承到 seq=2；之后父对话继续追加的 seq=3 不属于子对话快照。
  db.prepare(`
    INSERT INTO messages (id, conversation_id, role, content, token_count, created_at, seq, metadata)
    VALUES ('msg-root-later', 'conv-source', 'assistant', '父对话后来追加', 6, '2026-08-03T00:00:01.000Z', 3, '{}')
  `).run();

  const assets = createAssetMocks();
  const route = loadDuplicateRoute(db, assets);

  try {
    const response = await route.POST({}, { params: Promise.resolve({ id: 'char-source' }) });
    const payload = await response.json();
    assert.equal(response.status, 201);

    const copied = db.prepare(
      'SELECT * FROM conversations WHERE character_id = ? ORDER BY created_at ASC',
    ).all(payload.id);
    assert.equal(copied.length, 2);

    const [copiedRoot, copiedChild] = copied;
    assert.equal(copiedRoot.parent_id, null);
    assert.equal(copiedRoot.parent_seq_end, null);
    // 子对话必须指向复制后的新父对话，而不是原角色的对话
    assert.equal(copiedChild.parent_id, copiedRoot.id);
    assert.equal(copiedChild.parent_seq_end, 2);

    // 父对话副本包含后续追加的消息，但子对话仍只继承前两条。
    assert.deepEqual(
      db.prepare('SELECT seq FROM messages WHERE conversation_id = ? ORDER BY seq ASC').all(copiedRoot.id).map(r => r.seq),
      [1, 2, 3],
    );
    assert.deepEqual(
      db.prepare('SELECT seq, content FROM messages WHERE conversation_id = ? ORDER BY seq ASC').all(copiedChild.id),
      [{ seq: 3, content: '续篇第一句' }],
    );

    // 副本的子对话沿链能看到完整历史
    const { resolveConversationChain, buildChainMessageScope } = require('../src/lib/conversation-chain.ts');
    const scope = buildChainMessageScope(resolveConversationChain(db, copiedChild.id));
    const visible = db.prepare(
      `SELECT seq, content FROM messages WHERE ${scope.sql} ORDER BY seq ASC`,
    ).all(...scope.params);
    assert.deepEqual(visible.map(r => r.seq), [1, 2, 3]);
    assert.equal(visible.at(-1).content, '续篇第一句');
    assert.equal(visible.some(r => r.content === '父对话后来追加'), false);
  } finally {
    db.close();
  }
});

test('/api/characters/[id]/duplicate preserves inserted child messages inside inherited seq order', async () => {
  const db = createCharacterDb();
  // 模拟在根消息 seq=1 后通过子分支插入回复：原根 seq=2 被右移到 3，
  // 子对话边界同步右移到 3，而插入回复物理属于子对话、seq 保持为 2。
  db.prepare(`UPDATE messages SET seq = 3 WHERE id = 'msg-assistant'`).run();
  db.prepare(`
    INSERT INTO conversations (id, character_id, title, ignore_memory, created_at, updated_at, parent_id, parent_seq_end)
    VALUES ('conv-inserted-child', 'char-source', '插入式续篇', 0, '2026-08-02T00:00:00.000Z', '2026-08-02T00:00:00.000Z', 'conv-source', 3)
  `).run();
  db.prepare(`
    INSERT INTO messages (id, conversation_id, role, content, token_count, created_at, seq, metadata)
    VALUES
      ('msg-child-inserted', 'conv-inserted-child', 'assistant', '插在祖先回复之前', 6, '2026-08-01T00:00:01.500Z', 2, '{}'),
      ('msg-child-tail', 'conv-inserted-child', 'user', '子对话继续', 5, '2026-08-02T00:00:01.000Z', 4, '{}'),
      ('msg-root-suffix', 'conv-source', 'assistant', '父对话分支后的追加', 7, '2026-08-03T00:00:01.000Z', 4, '{}')
  `).run();

  const { resolveConversationChain, buildChainMessageScope } = require('../src/lib/conversation-chain.ts');
  const visibleContents = conversationId => {
    const scope = buildChainMessageScope(resolveConversationChain(db, conversationId));
    return db.prepare(
      `SELECT content FROM messages WHERE ${scope.sql} ORDER BY seq ASC`,
    ).all(...scope.params).map(row => row.content);
  };
  const sourceVisible = visibleContents('conv-inserted-child');
  const firstLines = contents => contents.map(content => content.split('\n')[0]);
  assert.deepEqual(firstLines(sourceVisible), [
    '主人喜欢雨夜。',
    '插在祖先回复之前',
    '艾莉丝会一直记得。',
    '子对话继续',
  ]);

  const assets = createAssetMocks();
  const route = loadDuplicateRoute(db, assets);

  try {
    const response = await route.POST({}, { params: Promise.resolve({ id: 'char-source' }) });
    const payload = await response.json();
    assert.equal(response.status, 201);

    const copied = db.prepare(`
      SELECT * FROM conversations
      WHERE character_id = ?
      ORDER BY created_at ASC
    `).all(payload.id);
    const copiedRoot = copied.find(row => row.parent_id === null);
    const copiedChild = copied.find(row => row.parent_id === copiedRoot?.id);
    assert.ok(copiedRoot);
    assert.ok(copiedChild);
    assert.equal(copiedChild.parent_seq_end, 3);
    assert.deepEqual(
      db.prepare('SELECT seq FROM messages WHERE conversation_id = ? ORDER BY seq ASC').all(copiedRoot.id).map(row => row.seq),
      [1, 3, 4],
    );
    assert.deepEqual(
      db.prepare('SELECT seq FROM messages WHERE conversation_id = ? ORDER BY seq ASC').all(copiedChild.id).map(row => row.seq),
      [2, 4],
    );

    const copiedVisible = visibleContents(copiedChild.id);
    assert.deepEqual(firstLines(copiedVisible), firstLines(sourceVisible));
    assert.equal(copiedVisible.includes('父对话分支后的追加'), false);
  } finally {
    db.close();
  }
});

test('/api/characters/[id]/duplicate fails fast instead of silently dropping broken linked history', async () => {
  for (const scenario of [
    {
      name: 'missing parent',
      setup(db) {
        db.prepare(`
          INSERT INTO conversations (
            id, character_id, title, ignore_memory, created_at, updated_at, parent_id, parent_seq_end
          ) VALUES (
            'conv-broken', 'char-source', '坏链', 0,
            '2026-08-02T00:00:00.000Z', '2026-08-02T00:00:00.000Z',
            'conv-missing', 2
          )
        `).run();
      },
      error: /parent not found/,
    },
    {
      name: 'cycle',
      setup(db) {
        db.prepare(`
          INSERT INTO conversations (
            id, character_id, title, ignore_memory, created_at, updated_at, parent_id, parent_seq_end
          ) VALUES (
            'conv-cycle', 'char-source', '环链', 0,
            '2026-08-02T00:00:00.000Z', '2026-08-02T00:00:00.000Z',
            'conv-source', 2
          )
        `).run();
        db.prepare(`
          UPDATE conversations
          SET parent_id = 'conv-cycle', parent_seq_end = 2
          WHERE id = 'conv-source'
        `).run();
      },
      error: /cycle detected/,
    },
  ]) {
    const db = createCharacterDb();
    scenario.setup(db);
    const assets = createAssetMocks();
    const route = loadDuplicateRoute(db, assets);

    try {
      const response = await route.POST({}, { params: Promise.resolve({ id: 'char-source' }) });
      const payload = await response.json();
      assert.equal(response.status, 500, scenario.name);
      assert.match(payload.error, scenario.error, scenario.name);
      assert.equal(
        db.prepare("SELECT COUNT(*) AS count FROM characters WHERE id <> 'char-source'").get().count,
        0,
        scenario.name,
      );
      assert.equal(
        db.prepare("SELECT COUNT(*) AS count FROM conversations WHERE character_id <> 'char-source'").get().count,
        0,
        scenario.name,
      );
      assert.deepEqual(assets.physicalCopies, [], scenario.name);
    } finally {
      db.close();
    }
  }
});
