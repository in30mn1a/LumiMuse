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

function createDb() {
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
  `);
  return db;
}

function createMessageDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE messages (
      id TEXT PRIMARY KEY,
      content TEXT NOT NULL,
      token_count INTEGER NOT NULL DEFAULT 0,
      metadata TEXT NOT NULL DEFAULT '{}'
    );
  `);
  return db;
}

function insertMemory(db, overrides) {
  db.prepare(`
    INSERT INTO memories (
      id, character_id, category, content, confidence, tags, source_msg_ids,
      memory_kind, importance, emotional_weight, status, pinned, last_used_at,
      usage_count, metadata, created_at, updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?)
  `).run(
    overrides.id,
    overrides.character_id || 'char-a',
    overrides.category || '偏好习惯',
    overrides.content,
    0.9,
    JSON.stringify(overrides.tags || []),
    JSON.stringify(overrides.source_msg_ids || []),
    overrides.memory_kind || 'user_preference',
    overrides.importance ?? 0.8,
    overrides.emotional_weight ?? 0.2,
    overrides.status || 'active',
    overrides.pinned ? 1 : 0,
    overrides.usage_count || 0,
    JSON.stringify(overrides.metadata || {}),
    overrides.created_at || '2026-06-02T00:00:00.000Z',
    overrides.updated_at || '2026-06-02T00:00:00.000Z',
  );
}

test('消息删除会反向标记由该消息支撑的记忆，并保留审计 metadata', () => {
  const db = createDb();
  insertMemory(db, {
    id: 'mem-delete',
    content: '主人喜欢雨夜听轻音乐。',
    source_msg_ids: ['msg-user-1'],
  });
  insertMemory(db, {
    id: 'mem-other',
    content: '主人喜欢热茶。',
    source_msg_ids: ['msg-user-2'],
  });

  const { invalidateMemoriesForSourceMessage } = require('../src/lib/memory-source-tracking.ts');
  const result = invalidateMemoriesForSourceMessage({
    db,
    messageId: 'msg-user-1',
    reason: 'deleted',
  });

  const invalidated = db.prepare('SELECT status, metadata FROM memories WHERE id = ?').get('mem-delete');
  const untouched = db.prepare('SELECT status, metadata FROM memories WHERE id = ?').get('mem-other');
  const metadata = JSON.parse(invalidated.metadata);

  assert.equal(result.updatedCount, 1);
  assert.equal(invalidated.status, 'superseded');
  assert.equal(metadata.sourceInvalidation.reason, 'deleted');
  assert.equal(metadata.sourceInvalidation.messageId, 'msg-user-1');
  assert.equal(metadata.previousStatus, 'active');
  assert.equal(untouched.status, 'active');
});

test('来源消息反向标记不会误伤相似 message id 的记忆', () => {
  const db = createDb();
  insertMemory(db, {
    id: 'mem-exact',
    content: '主人喜欢雨夜听轻音乐。',
    source_msg_ids: ['msg-1'],
  });
  insertMemory(db, {
    id: 'mem-similar',
    content: '主人喜欢雪夜喝热茶。',
    source_msg_ids: ['msg-10'],
  });

  const { invalidateMemoriesForSourceMessage } = require('../src/lib/memory-source-tracking.ts');
  const result = invalidateMemoriesForSourceMessage({
    db,
    messageId: 'msg-1',
    reason: 'deleted',
  });

  assert.equal(result.updatedCount, 1);
  assert.equal(db.prepare('SELECT status FROM memories WHERE id = ?').get('mem-exact').status, 'superseded');
  assert.equal(db.prepare('SELECT status FROM memories WHERE id = ?').get('mem-similar').status, 'active');
});

test('消息编辑和重新生成会标记相关记忆为 superseded，避免静默沿用旧事实', () => {
  const db = createDb();
  insertMemory(db, {
    id: 'mem-edit',
    content: '主人喜欢咖啡。',
    source_msg_ids: ['msg-user-edit'],
  });
  insertMemory(db, {
    id: 'mem-regen',
    category: '关系动态',
    content: '角色承诺明天提醒主人休息。',
    source_msg_ids: ['msg-assistant-old'],
    memory_kind: 'character_promise',
  });

  const { invalidateMemoriesForSourceMessage } = require('../src/lib/memory-source-tracking.ts');
  invalidateMemoriesForSourceMessage({
    db,
    messageId: 'msg-user-edit',
    reason: 'edited',
  });
  invalidateMemoriesForSourceMessage({
    db,
    messageId: 'msg-assistant-old',
    reason: 'regenerated',
    replacementMessageId: 'msg-assistant-old',
  });

  const edited = JSON.parse(db.prepare('SELECT metadata FROM memories WHERE id = ?').get('mem-edit').metadata);
  const regenerated = JSON.parse(db.prepare('SELECT metadata FROM memories WHERE id = ?').get('mem-regen').metadata);

  assert.equal(db.prepare('SELECT status FROM memories WHERE id = ?').get('mem-edit').status, 'superseded');
  assert.equal(edited.sourceInvalidation.reason, 'edited');
  assert.equal(db.prepare('SELECT status FROM memories WHERE id = ?').get('mem-regen').status, 'superseded');
  assert.equal(regenerated.sourceInvalidation.reason, 'regenerated');
  assert.equal(regenerated.sourceInvalidation.replacementMessageId, 'msg-assistant-old');
});

test('多版本消息删除和记忆失效在同一事务内提交', async () => {
  const db = createMessageDb();
  const originalMetadata = {
    versions: [
      { content: '旧版本', token_count: 3 },
      { content: '当前版本', token_count: 4 },
    ],
    activeVersion: 1,
  };
  db.prepare(`
    INSERT INTO messages (id, content, token_count, metadata)
    VALUES ('msg-versioned', '当前版本', 4, ?)
  `).run(JSON.stringify(originalMetadata));

  const route = requireFreshWithMocks('../src/app/api/messages/[id]/route.ts', {
    'next/server': {
      NextResponse: {
        json(body, init = {}) {
          return { status: init.status ?? 200, body, async json() { return body; } };
        },
      },
    },
    '@/lib/db': { getDb: () => db },
    '@/lib/character-file-utils': {
      collectLocalAssetUrlsFromContent: () => new Set(),
      collectLocalAssetUrlsFromMetadata: () => new Set(),
      deleteLocalAssetUrls: async () => {},
      filterUnreferencedLocalAssetUrls: () => new Set(),
    },
    '@/lib/memory-source-tracking': {
      invalidateMemoriesForSourceMessage: () => {
        throw new Error('invalidation failed');
      },
    },
  });

  await assert.rejects(
    () => route.DELETE({}, { params: Promise.resolve({ id: 'msg-versioned' }) }),
    /invalidation failed/,
  );

  const row = db.prepare('SELECT content, token_count, metadata FROM messages WHERE id = ?').get('msg-versioned');
  assert.equal(row.content, '当前版本');
  assert.equal(row.token_count, 4);
  assert.deepEqual(JSON.parse(row.metadata), originalMetadata);
});

test('本地记忆检索不会返回已失效的来源记忆', () => {
  const db = createDb();
  insertMemory(db, {
    id: 'mem-stale',
    content: '主人喜欢已经改掉的咖啡偏好。',
    tags: ['咖啡'],
    source_msg_ids: ['msg-old'],
    status: 'superseded',
  });
  insertMemory(db, {
    id: 'mem-active',
    content: '主人现在喜欢雨夜热茶。',
    tags: ['热茶'],
    source_msg_ids: ['msg-new'],
  });

  const { retrieveRelevantMemories } = requireFreshWithMocks('../src/lib/memory-engine.ts', {
    '@/lib/db': { getDb: () => db },
  });

  const memories = retrieveRelevantMemories('主人现在喜欢什么饮品', 'char-a', 10);

  assert.deepEqual(memories.map(memory => memory.id), ['mem-active']);
});
