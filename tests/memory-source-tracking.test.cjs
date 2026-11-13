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
