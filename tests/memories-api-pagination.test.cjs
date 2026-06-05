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

function requestFor(url) {
  return {
    nextUrl: new URL(url),
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

function insertMemory(db, overrides) {
  const memory = {
    id: 'mem-default',
    character_id: 'char-a',
    category: '话题历史',
    content: '默认记忆',
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
    created_at: '2026-06-02T09:00:00.000Z',
    updated_at: '2026-06-02T09:00:00.000Z',
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

test('/api/memories GET 支持管理选择器获取超过 100 条 active 记忆', async () => {
  const db = createMemoryDb();

  for (let i = 0; i < 125; i += 1) {
    insertMemory(db, {
      id: `active-${String(i).padStart(3, '0')}`,
      content: `可归档记忆 ${i}`,
      status: 'active',
      created_at: `2026-06-02T09:${String(i).padStart(2, '0')}:00.000Z`,
      updated_at: `2026-06-02T09:${String(i).padStart(2, '0')}:00.000Z`,
    });
  }
  for (let i = 0; i < 5; i += 1) {
    insertMemory(db, {
      id: `archived-${i}`,
      content: `已归档记忆 ${i}`,
      status: 'archived',
      created_at: `2026-06-02T10:${String(i).padStart(2, '0')}:00.000Z`,
      updated_at: `2026-06-02T10:${String(i).padStart(2, '0')}:00.000Z`,
    });
    insertMemory(db, {
      id: `summarized-${i}`,
      content: `已摘要覆盖记忆 ${i}`,
      status: 'summarized',
      created_at: `2026-06-02T11:${String(i).padStart(2, '0')}:00.000Z`,
      updated_at: `2026-06-02T11:${String(i).padStart(2, '0')}:00.000Z`,
    });
  }
  insertMemory(db, {
    id: 'other-character',
    character_id: 'char-b',
    content: '其它角色记忆',
    status: 'active',
  });

  const route = requireFreshWithMocks('../src/app/api/memories/route.ts', {
    'next/server': jsonResponseMock(),
    '@/lib/db': { getDb: () => db },
  });

  const response = await route.GET(requestFor(
    'http://test.local/api/memories?character_id=char-a&status=active&limit=120&offset=0',
  ));
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.equal(payload.total, 125);
  assert.equal(payload.memories.length, 120);
  assert.ok(payload.memories.every(memory => memory.character_id === 'char-a'));
  assert.ok(payload.memories.every(memory => memory.status === 'active'));
  assert.equal(payload.hasMore, true);
});

test('/api/memories GET 支持按多个 tag 精确同时筛选', async () => {
  const db = createMemoryDb();

  insertMemory(db, {
    id: 'matched',
    content: '真正带有午餐标签的记忆',
    tags: ['午餐', '饮食'],
  });
  insertMemory(db, {
    id: 'one-tag-only',
    content: '只带午餐标签，不应命中午餐+饮食组合筛选',
    tags: ['午餐'],
  });
  insertMemory(db, {
    id: 'partial-tag',
    content: '标签包含午餐会，但不应命中午餐',
    tags: ['午餐会', '饮食'],
  });

  const route = requireFreshWithMocks('../src/app/api/memories/route.ts', {
    'next/server': jsonResponseMock(),
    '@/lib/db': { getDb: () => db },
  });

  const response = await route.GET(requestFor(
    'http://test.local/api/memories?character_id=char-a&tag=%E5%8D%88%E9%A4%90&tag=%E9%A5%AE%E9%A3%9F&limit=20&offset=0',
  ));
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.equal(payload.total, 1);
  assert.deepEqual(payload.memories.map(memory => memory.id), ['matched']);
  assert.equal(payload.hasMore, false);
});
