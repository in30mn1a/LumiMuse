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

function jsonRequest(body) {
  return {
    async json() {
      return body;
    },
  };
}

function createMergeRouteDb() {
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

    CREATE TABLE memory_embedding_tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      memory_id TEXT NOT NULL,
      character_id TEXT NOT NULL,
      reason TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      claim_token TEXT,
      lease_expires_at TEXT,
      error TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  return db;
}

function insertMemory(db, overrides = {}) {
  const memory = {
    id: 'mem-default',
    character_id: 'char-a',
    category: '偏好习惯',
    content: '默认记忆',
    confidence: 0.8,
    tags: [],
    source_msg_ids: [],
    memory_kind: 'general',
    importance: 0.5,
    emotional_weight: 0,
    status: 'active',
    pinned: 0,
    last_used_at: null,
    usage_count: 0,
    metadata: {},
    created_at: '2026-07-28T00:00:00.000Z',
    updated_at: '2026-07-28T00:00:00.000Z',
    ...overrides,
  };
  db.prepare(`
    INSERT INTO memories (
      id, character_id, category, content, confidence, tags, source_msg_ids,
      memory_kind, importance, emotional_weight, status, pinned, last_used_at,
      usage_count, metadata, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
    memory.pinned,
    memory.last_used_at,
    memory.usage_count,
    JSON.stringify(memory.metadata),
    memory.created_at,
    memory.updated_at,
  );
}

test('/api/memory-merge execute supersedes sources, queues embedding, and list/undo work', async () => {
  const db = createMergeRouteDb();
  insertMemory(db, { id: 's1', content: '喜欢美式', source_msg_ids: ['m1'], tags: ['咖啡'] });
  insertMemory(db, { id: 's2', content: '喜欢美式咖啡', source_msg_ids: ['m2'], tags: ['饮品'] });
  const enqueueCalls = [];
  let triggerCalls = 0;

  const route = requireFreshWithMocks('../src/app/api/memory-merge/route.ts', {
    'next/server': jsonResponseMock(),
    '@/lib/db': { getDb: () => db },
    '@/lib/memory-embeddings': {
      enqueueMemoryEmbeddingTask: (memoryId, characterId, reason, dbArg) => {
        enqueueCalls.push({ memoryId, characterId, reason, hasDb: Boolean(dbArg) });
        db.prepare(`
          INSERT INTO memory_embedding_tasks (memory_id, character_id, reason, status)
          VALUES (?, ?, ?, 'pending')
        `).run(memoryId, characterId, reason);
        return true;
      },
    },
    '@/lib/memory-index-trigger': {
      triggerMemoryIndexProcessing: () => {
        triggerCalls += 1;
        return true;
      },
    },
  });

  const executeResponse = await route.POST(jsonRequest({
    action: 'execute',
    character_id: 'char-a',
    source_ids: ['s1', 's2'],
    merged_content: '用户喜欢美式咖啡',
    category: '偏好习惯',
    tags: ['咖啡'],
    importance: 0.8,
    batch_id: 'batch-merge-1',
    result_memory_id: 'result-1',
  }));
  const executePayload = await executeResponse.json();

  assert.equal(executeResponse.status, 200);
  assert.equal(executePayload.ok, true);
  assert.equal(executePayload.batch_id, 'batch-merge-1');
  assert.equal(executePayload.result_memory_id, 'result-1');
  assert.equal(executePayload.indexing_queued, 1);
  assert.equal(executePayload.indexing_started, true);
  assert.deepEqual(enqueueCalls, [{
    memoryId: 'result-1',
    characterId: 'char-a',
    reason: 'created',
    hasDb: true,
  }]);
  assert.equal(triggerCalls, 1);

  const result = db.prepare('SELECT status, content, metadata FROM memories WHERE id = ?').get('result-1');
  assert.equal(result.status, 'active');
  assert.equal(result.content, '用户喜欢美式咖啡');
  assert.equal(JSON.parse(result.metadata).mergeRole, 'result');
  assert.equal(db.prepare("SELECT status FROM memories WHERE id = 's1'").get().status, 'superseded');
  assert.equal(db.prepare("SELECT status FROM memories WHERE id = 's2'").get().status, 'superseded');

  const listResponse = await route.POST(jsonRequest({
    action: 'list',
    character_id: 'char-a',
  }));
  const listPayload = await listResponse.json();
  assert.equal(listResponse.status, 200);
  assert.equal(listPayload.ok, true);
  assert.equal(listPayload.batches.length, 1);
  assert.equal(listPayload.batches[0].batch_id, 'batch-merge-1');

  const undoResponse = await route.POST(jsonRequest({
    action: 'undo',
    character_id: 'char-a',
    batch_id: 'batch-merge-1',
  }));
  const undoPayload = await undoResponse.json();
  assert.equal(undoResponse.status, 200);
  assert.equal(undoPayload.ok, true);
  // route 直接展开 lib 返回值（camelCase）并附加 batch_id
  assert.equal(undoPayload.resultMemoryId, 'result-1');
  assert.deepEqual([...undoPayload.restoredMemoryIds].sort(), ['s1', 's2']);
  assert.equal(undoPayload.batch_id, 'batch-merge-1');
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM memories WHERE id = 'result-1'").get().c, 0);
  assert.equal(db.prepare("SELECT status FROM memories WHERE id = 's1'").get().status, 'active');
  assert.equal(db.prepare("SELECT status FROM memories WHERE id = 's2'").get().status, 'active');
});

test('/api/memory-merge execute rejects conflict kind and overlong content', async () => {
  const db = createMergeRouteDb();
  insertMemory(db, { id: 's1', content: 'a' });
  insertMemory(db, { id: 's2', content: 'b' });

  const route = requireFreshWithMocks('../src/app/api/memory-merge/route.ts', {
    'next/server': jsonResponseMock(),
    '@/lib/db': { getDb: () => db },
    '@/lib/memory-embeddings': {
      enqueueMemoryEmbeddingTask: () => {
        throw new Error('should not enqueue');
      },
    },
    '@/lib/memory-index-trigger': {
      triggerMemoryIndexProcessing: () => {
        throw new Error('should not start indexing');
      },
    },
  });

  const conflictResponse = await route.POST(jsonRequest({
    action: 'execute',
    character_id: 'char-a',
    source_ids: ['s1', 's2'],
    merged_content: '冲突内容',
    kind: 'conflict',
  }));
  const conflictPayload = await conflictResponse.json();
  assert.equal(conflictResponse.status, 400);
  assert.match(conflictPayload.error, /conflict/i);

  const overlongResponse = await route.POST(jsonRequest({
    action: 'execute',
    character_id: 'char-a',
    source_ids: ['s1', 's2'],
    merged_content: 'x'.repeat(8193),
  }));
  const overlongPayload = await overlongResponse.json();
  assert.equal(overlongResponse.status, 400);
  assert.match(overlongPayload.error, /MAX_MEMORY_CONTENT/);

  assert.equal(db.prepare("SELECT status FROM memories WHERE id = 's1'").get().status, 'active');
  assert.equal(db.prepare("SELECT status FROM memories WHERE id = 's2'").get().status, 'active');
});

test('/api/memory-merge validates action and source_ids', async () => {
  const db = createMergeRouteDb();
  const route = requireFreshWithMocks('../src/app/api/memory-merge/route.ts', {
    'next/server': jsonResponseMock(),
    '@/lib/db': { getDb: () => db },
  });

  const badAction = await route.POST(jsonRequest({
    action: 'plan',
    character_id: 'char-a',
  }));
  assert.equal(badAction.status, 400);
  assert.match((await badAction.json()).error, /action must be/);

  const missingCharacter = await route.POST(jsonRequest({
    action: 'list',
  }));
  assert.equal(missingCharacter.status, 400);
  assert.match((await missingCharacter.json()).error, /character_id/);

  const tooFewSources = await route.POST(jsonRequest({
    action: 'execute',
    character_id: 'char-a',
    source_ids: ['only-one'],
    merged_content: '不足两条',
  }));
  assert.equal(tooFewSources.status, 400);
  assert.match((await tooFewSources.json()).error, /source_ids/);
});
