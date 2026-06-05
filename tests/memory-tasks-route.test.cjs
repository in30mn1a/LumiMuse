const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
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

function request(url, body = {}) {
  return {
    nextUrl: new URL(url),
    async json() {
      return body;
    },
  };
}

function createMemoryTasksDb() {
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
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
  return db;
}

function createLegacyMemoryTasksDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE memory_tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      character_id TEXT NOT NULL,
      conversation_id TEXT NOT NULL,
      message_ids TEXT NOT NULL DEFAULT '[]',
      status TEXT NOT NULL DEFAULT 'pending',
      merge_count INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
  return db;
}

function loadRoute(db) {
  return requireFreshWithMocks('../src/app/api/memory-tasks/route.ts', {
    'next/server': jsonResponseMock(),
    '@/lib/db': { getDb: () => db },
    '@/lib/memory-queue': { enqueueExtraction: () => {} },
    '@/lib/messages': { serializeTypedMessages: messages => messages },
    '@/types': {},
  });
}

test('/api/memory-tasks GET exposes failed task diagnostics', async () => {
  const db = createMemoryTasksDb();
  db.prepare(`
    INSERT INTO memory_tasks (
      character_id, conversation_id, message_ids, status, merge_count,
      retry_count, error_message, created_at, updated_at
    ) VALUES (
      'char-a', 'conv-a', '[]', 'failed', 0,
      2, 'LLM 返回了无法解析的记忆 JSON', '2026-06-05T00:00:00.000Z', '2026-06-05T00:01:00.000Z'
    )
  `).run();

  const route = loadRoute(db);
  const response = await route.GET(request('http://test.local/api/memory-tasks?conversation_id=conv-a'));
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.deepEqual(payload, {
    status: 'failed',
    mergeCount: 0,
    retryCount: 2,
    errorMessage: 'LLM 返回了无法解析的记忆 JSON',
    updatedAt: '2026-06-05T00:01:00.000Z',
  });
});

test('/api/memory-tasks GET remains compatible when diagnostic columns are absent', async () => {
  const db = createLegacyMemoryTasksDb();
  db.prepare(`
    INSERT INTO memory_tasks (
      character_id, conversation_id, message_ids, status, merge_count,
      created_at, updated_at
    ) VALUES (
      'char-a', 'conv-legacy', '[]', 'failed', 0,
      '2026-06-05T00:00:00.000Z', '2026-06-05T00:01:00.000Z'
    )
  `).run();

  const route = loadRoute(db);
  const response = await route.GET(request('http://test.local/api/memory-tasks?conversation_id=conv-legacy'));
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.deepEqual(payload, {
    status: 'failed',
    mergeCount: 0,
    retryCount: 0,
    errorMessage: null,
    updatedAt: '2026-06-05T00:01:00.000Z',
  });
});

test('memory-queue stores retry count and error message when extraction fails', async () => {
  const db = createMemoryTasksDb();
  db.exec(`
    CREATE TABLE messages (
      id TEXT PRIMARY KEY,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      metadata TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      seq INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE characters (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL
    );
  `);
  db.prepare("INSERT INTO characters (id, name) VALUES ('char-a', '艾莉丝')").run();
  db.prepare(`
    INSERT INTO messages (id, role, content, metadata, created_at, seq)
    VALUES ('msg-user-fail', 'user', '请记住这件事。', '{}', '2026-06-05T00:00:00.000Z', 1)
  `).run();

  const queue = requireFreshWithMocks('../src/lib/memory-queue.ts', {
    '@/lib/db': { getDb: () => db },
    '@/lib/settings': { loadSettings: () => ({}) },
    '@/lib/memory-engine': {
      extractMemories: async () => {
        throw new Error('LLM 返回了无法解析的记忆 JSON');
      },
    },
    '@/lib/memory-profile': {
      enqueueMemoryProfilePatchExtraction: () => {},
      triggerMemoryProfileQueue: () => {},
    },
  });

  queue.enqueueExtraction('char-a', 'conv-fail', [{ id: 'msg-user-fail' }]);

  let row;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    row = db.prepare('SELECT status, retry_count, error_message FROM memory_tasks WHERE conversation_id = ?').get('conv-fail');
    if (row?.status === 'failed') break;
    await new Promise(resolve => setTimeout(resolve, 10));
  }

  assert.deepEqual(row, {
    status: 'failed',
    retry_count: 1,
    error_message: 'LLM 返回了无法解析的记忆 JSON',
  });
});

function loadRealDbInTempDir(tempDir) {
  const originalCwd = process.cwd();
  const originalSetImmediate = global.setImmediate;
  global.setImmediate = () => 0;

  try {
    process.chdir(tempDir);
    const dbModulePath = require.resolve('../src/lib/db.ts');
    delete require.cache[dbModulePath];
    const { getDb } = require('../src/lib/db.ts');
    return getDb();
  } finally {
    process.chdir(originalCwd);
    global.setImmediate = originalSetImmediate;
  }
}

test('real db migration creates memory task diagnostic columns', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumimuse-memory-tasks-'));
  const db = loadRealDbInTempDir(tempDir);
  const columns = db.prepare("PRAGMA table_info(memory_tasks)").all().map(column => column.name);
  db.close();

  assert.ok(columns.includes('retry_count'));
  assert.ok(columns.includes('error_message'));
});

test('real db migration backfills memory task diagnostic columns on legacy tables', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumimuse-memory-tasks-legacy-'));
  const dataDir = path.join(tempDir, 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  const legacyDb = new Database(path.join(dataDir, 'lumimuse.db'));
  legacyDb.exec(`
    CREATE TABLE memory_tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      character_id TEXT NOT NULL,
      conversation_id TEXT NOT NULL,
      message_ids TEXT NOT NULL DEFAULT '[]',
      status TEXT NOT NULL DEFAULT 'pending',
      merge_count INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
  legacyDb.close();

  const db = loadRealDbInTempDir(tempDir);
  const columns = db.prepare("PRAGMA table_info(memory_tasks)").all().map(column => column.name);
  db.close();

  assert.ok(columns.includes('retry_count'));
  assert.ok(columns.includes('error_message'));
});

test('memory-queue keeps legacy task rows usable when diagnostic columns are absent', async () => {
  const db = createLegacyMemoryTasksDb();
  db.exec(`
    CREATE TABLE messages (
      id TEXT PRIMARY KEY,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      metadata TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      seq INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE characters (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL
    );
  `);
  db.prepare("INSERT INTO characters (id, name) VALUES ('char-a', '艾莉丝')").run();
  db.prepare(`
    INSERT INTO messages (id, role, content, metadata, created_at, seq)
    VALUES ('msg-user-legacy-fail', 'user', '请记住这件事。', '{}', '2026-06-05T00:00:00.000Z', 1)
  `).run();

  const queue = requireFreshWithMocks('../src/lib/memory-queue.ts', {
    '@/lib/db': { getDb: () => db },
    '@/lib/settings': { loadSettings: () => ({}) },
    '@/lib/memory-engine': {
      extractMemories: async () => {
        throw new Error('legacy failure');
      },
    },
    '@/lib/memory-profile': {
      enqueueMemoryProfilePatchExtraction: () => {},
      triggerMemoryProfileQueue: () => {},
    },
  });

  queue.enqueueExtraction('char-a', 'conv-legacy-fail', [{ id: 'msg-user-legacy-fail' }]);

  let row;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    row = db.prepare('SELECT status FROM memory_tasks WHERE conversation_id = ?').get('conv-legacy-fail');
    if (row?.status === 'failed') break;
    await new Promise(resolve => setTimeout(resolve, 10));
  }

  assert.deepEqual(row, { status: 'failed' });
});

test('ChatView surfaces failed memory task diagnostics in toast text', () => {
  const source = fs.readFileSync(path.join(root, 'src/components/chat/ChatView.tsx'), 'utf8');
  const i18n = fs.readFileSync(path.join(root, 'src/lib/i18n.ts'), 'utf8');

  assert.match(source, /errorMessage\??:/);
  assert.match(source, /retryCount\??:/);
  assert.match(source, /errorMessage\?\.trim\(\)/);
  assert.match(source, /retryCount > 0/);
  assert.match(source, /formatTemplate\(t\('chat\.memoryExtractFailedDetail'\)/);
  assert.match(source, /showToast\([^;]*memoryExtractFailedDetail[^;]*'error'\);/s);
  assert.match(i18n, /'chat\.memoryExtractFailedDetail'/);
});
