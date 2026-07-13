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

function memoryTasksDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE memory_tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      character_id TEXT NOT NULL,
      conversation_id TEXT NOT NULL,
      message_ids TEXT NOT NULL DEFAULT '[]',
      status TEXT NOT NULL DEFAULT 'pending',
      merge_count INTEGER NOT NULL DEFAULT 0,
      retry_count INTEGER NOT NULL DEFAULT 0,
      error_message TEXT,
      started_at TEXT,
      result_committed INTEGER NOT NULL DEFAULT 0,
      result_insert_count INTEGER NOT NULL DEFAULT 0,
      result_merge_count INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
  return db;
}

const noopMemoryEngine = {
  extractMemories: async () => ({ mergeCount: 0, insertCount: 0 }),
  getCommittedExtractionResult: () => null,
};
const noopSettings = { loadSettings: () => ({}) };
const noopProfile = {
  enqueueMemoryProfilePatchExtraction: () => {},
  triggerMemoryProfileQueue: () => {},
};

test('recoverStaleTasks leaves processing task with recent started_at', () => {
  const db = memoryTasksDb();
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO memory_tasks (character_id, conversation_id, message_ids, status, started_at, created_at, updated_at)
    VALUES ('c1', 'conv1', '[]', 'processing', ?, ?, ?)
  `).run(now, now, now);

  const { recoverStaleTasks } = requireFreshWithMocks('../src/lib/memory-queue.ts', {
    '@/lib/db': { getDb: () => db },
    '@/lib/memory-engine': noopMemoryEngine,
    '@/lib/settings': noopSettings,
    '@/lib/memory-profile': noopProfile,
  });
  recoverStaleTasks();

  const row = db.prepare('SELECT status, started_at FROM memory_tasks WHERE id = 1').get();
  assert.equal(row.status, 'processing');
  assert.ok(row.started_at);
});

test('recoverStaleTasks resets processing task with stale started_at', () => {
  const db = memoryTasksDb();
  const stale = new Date(Date.now() - 400_000).toISOString();
  db.prepare(`
    INSERT INTO memory_tasks (character_id, conversation_id, message_ids, status, started_at, created_at, updated_at)
    VALUES ('c1', 'conv1', '[]', 'processing', ?, ?, ?)
  `).run(stale, stale, stale);

  const { recoverStaleTasks } = requireFreshWithMocks('../src/lib/memory-queue.ts', {
    '@/lib/db': { getDb: () => db },
    '@/lib/memory-engine': noopMemoryEngine,
    '@/lib/settings': noopSettings,
    '@/lib/memory-profile': noopProfile,
  });
  recoverStaleTasks();

  const row = db.prepare('SELECT status, started_at FROM memory_tasks WHERE id = 1').get();
  assert.equal(row.status, 'pending');
  assert.equal(row.started_at, null);
});

test('processQueue resumes committed task without re-calling extractMemories', async () => {
  const db = memoryTasksDb();
  db.exec(`
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
    CREATE TABLE characters (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL
    );
  `);
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO characters (id, name) VALUES ('c1', '角色A')`).run();
  db.prepare(`
    INSERT INTO messages (id, conversation_id, role, content, created_at, metadata, seq)
    VALUES ('m1', 'conv1', 'user', '用户消息足够长以便通过提取门槛检查', ?, '{}', 1)
  `).run(now);
  db.prepare(`
    INSERT INTO memory_tasks (
      character_id, conversation_id, message_ids, status, started_at,
      result_committed, result_insert_count, result_merge_count, created_at, updated_at
    ) VALUES ('c1', 'conv1', ?, 'pending', NULL, 1, 2, 1, ?, ?)
  `).run(JSON.stringify(['m1']), now, now);

  let extractCalls = 0;
  const { __processQueueForTest } = requireFreshWithMocks('../src/lib/memory-queue.ts', {
    '@/lib/db': { getDb: () => db },
    '@/lib/memory-engine': {
      extractMemories: async () => {
        extractCalls += 1;
        return { mergeCount: 0, insertCount: 0 };
      },
      getCommittedExtractionResult: (taskId) => {
        const row = db.prepare(
          'SELECT result_committed, result_insert_count, result_merge_count FROM memory_tasks WHERE id = ?',
        ).get(taskId);
        if (!row || !row.result_committed) return null;
        return { insertCount: row.result_insert_count, mergeCount: row.result_merge_count };
      },
    },
    '@/lib/settings': noopSettings,
    '@/lib/memory-profile': noopProfile,
  });

  await __processQueueForTest();

  assert.equal(extractCalls, 0);
  const task = db.prepare('SELECT status, merge_count FROM memory_tasks WHERE id = 1').get();
  assert.equal(task.status, 'done');
  assert.equal(task.merge_count, 1);
  const msg = db.prepare('SELECT metadata FROM messages WHERE id = ?').get('m1');
  assert.equal(JSON.parse(msg.metadata).memory_extracted, true);
});