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
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
  return db;
}

const noopMemoryEngine = { extractMemories: async () => ({ mergeCount: 0, insertCount: 0 }) };
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