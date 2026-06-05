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

function requestFor(url, body) {
  return {
    nextUrl: new URL(url),
    async json() {
      if (body === undefined) throw new Error('No body');
      return body;
    },
  };
}

function createMemoryDb() {
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
      emotional_weight REAL NOT NULL DEFAULT 0.0,
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

function insertMemory(db, overrides = {}) {
  const memory = {
    id: 'mem-delete',
    character_id: 'char-a',
    category: '话题历史',
    content: '待删除记忆',
    confidence: 0.8,
    tags: [],
    source_msg_ids: [],
    memory_kind: 'general',
    importance: 0.5,
    emotional_weight: 0,
    status: 'active',
    pinned: false,
    last_used_at: null,
    usage_count: 0,
    metadata: {},
    created_at: '2026-06-04T00:00:00.000Z',
    updated_at: '2026-06-04T00:00:00.000Z',
    ...overrides,
  };

  db.prepare(`
    INSERT INTO memories (
      id, character_id, category, content, confidence, tags, source_msg_ids,
      memory_kind, importance, emotional_weight, status, pinned, last_used_at,
      usage_count, metadata, created_at, updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    memory.id,
    memory.character_id,
    memory.category,
    memory.content,
    memory.confidence,
    JSON.stringify(memory.tags),
    JSON.stringify(memory.source_msg_ids),
    memory.memory_kind,
    memory.importance,
    memory.emotional_weight,
    memory.status,
    memory.pinned ? 1 : 0,
    memory.last_used_at,
    memory.usage_count,
    JSON.stringify(memory.metadata),
    memory.created_at,
    memory.updated_at,
  );
}

function loadRoute(db) {
  return requireFreshWithMocks('../src/app/api/memories/[id]/route.ts', {
    'next/server': jsonResponseMock(),
    '@/lib/db': { getDb: () => db },
  });
}

async function deleteMemory(route, id, url, body) {
  return route.DELETE(requestFor(url, body), { params: Promise.resolve({ id }) });
}

function memoryExists(db, id) {
  return Boolean(db.prepare('SELECT id FROM memories WHERE id = ?').get(id));
}

test('DELETE /api/memories/[id] 缺少 character_id 时返回 400 且不删除', async () => {
  const db = createMemoryDb();
  insertMemory(db, { id: 'mem-no-character' });
  const route = loadRoute(db);

  const response = await deleteMemory(
    route,
    'mem-no-character',
    'http://test.local/api/memories/mem-no-character',
  );
  const payload = await response.json();

  assert.equal(response.status, 400);
  assert.equal(payload.error, 'character_id is required');
  assert.equal(memoryExists(db, 'mem-no-character'), true);
});

test('DELETE /api/memories/[id] 拒绝删除 active archive summary', async () => {
  const db = createMemoryDb();
  insertMemory(db, {
    id: 'summary-active',
    metadata: { archiveRole: 'summary', archiveBatchId: 'batch-a' },
  });
  const route = loadRoute(db);

  const response = await deleteMemory(
    route,
    'summary-active',
    'http://test.local/api/memories/summary-active?character_id=char-a',
  );
  const payload = await response.json();

  assert.equal(response.status, 409);
  assert.equal(payload.error, 'Cannot delete an active archive summary; undo its archive batch first');
  assert.equal(memoryExists(db, 'summary-active'), true);
});

test('DELETE /api/memories/[id] character_id 不匹配时返回 403 且不删除', async () => {
  const db = createMemoryDb();
  insertMemory(db, { id: 'mem-wrong-character', character_id: 'char-a' });
  const route = loadRoute(db);

  const response = await deleteMemory(
    route,
    'mem-wrong-character',
    'http://test.local/api/memories/mem-wrong-character?character_id=char-b',
  );
  const payload = await response.json();

  assert.equal(response.status, 403);
  assert.equal(payload.error, 'Forbidden');
  assert.equal(memoryExists(db, 'mem-wrong-character'), true);
});

test('DELETE /api/memories/[id] character_id 匹配时删除普通 active memory', async () => {
  const db = createMemoryDb();
  insertMemory(db, { id: 'mem-correct-character', character_id: 'char-a' });
  const route = loadRoute(db);

  const response = await deleteMemory(
    route,
    'mem-correct-character',
    'http://test.local/api/memories/mem-correct-character?character_id=char-a',
  );
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.deepEqual(payload, { ok: true });
  assert.equal(memoryExists(db, 'mem-correct-character'), false);
});

test('DELETE /api/memories/[id] 支持从 JSON body 读取 character_id', async () => {
  const db = createMemoryDb();
  insertMemory(db, { id: 'mem-body-character', character_id: 'char-a' });
  const route = loadRoute(db);

  const response = await deleteMemory(
    route,
    'mem-body-character',
    'http://test.local/api/memories/mem-body-character',
    { character_id: 'char-a' },
  );
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.deepEqual(payload, { ok: true });
  assert.equal(memoryExists(db, 'mem-body-character'), false);
});
