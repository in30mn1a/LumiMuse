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

function createDb() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE conversations (
      id TEXT PRIMARY KEY,
      character_id TEXT NOT NULL,
      title TEXT NOT NULL,
      ignore_memory INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
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
  `);

  db.prepare(`
    INSERT INTO conversations (id, character_id, title, created_at, updated_at)
    VALUES ('conv-original', 'char-a', '原对话', '2026-07-11T00:00:00.000Z', '2026-07-11T00:00:03.000Z')
  `).run();

  const insertMessage = db.prepare(`
    INSERT INTO messages (id, conversation_id, role, content, token_count, created_at, seq, metadata)
    VALUES (?, 'conv-original', ?, ?, ?, ?, ?, ?)
  `);
  insertMessage.run('msg-1', 'user', '第一条', 3, '2026-07-11T00:00:01.000Z', 7, JSON.stringify({ source: 'original' }));
  insertMessage.run('msg-2', 'assistant', '第二条', 4, '2026-07-11T00:00:02.000Z', 9, JSON.stringify({ memory_extracted: true }));
  insertMessage.run('msg-3', 'user', '第三条', 5, '2026-07-11T00:00:03.000Z', 11, '{}');
  return db;
}

function withMessageInsertFailure(db, failAt) {
  let insertAttempts = 0;
  return {
    prepare(sql) {
      const statement = db.prepare(sql);
      if (!sql.includes('INSERT INTO messages')) return statement;
      return {
        run(...args) {
          insertAttempts += 1;
          if (insertAttempts === failAt) {
            throw new Error(`injected failure at copied message ${failAt}`);
          }
          return statement.run(...args);
        },
      };
    },
    transaction(fn) {
      return db.transaction(fn);
    },
    get insertAttempts() {
      return insertAttempts;
    },
  };
}

function loadRoute(db) {
  return requireFreshWithMocks('../src/app/api/conversations/[id]/duplicate/route.ts', {
    'next/server': jsonResponseMock(),
    '@/lib/db': { getDb: () => db },
  });
}

test('/api/conversations/[id]/duplicate rolls back the new conversation when the Nth message copy fails', async () => {
  const storage = createDb();
  const faultingDb = withMessageInsertFailure(storage, 2);
  const route = loadRoute(faultingDb);

  await assert.rejects(
    route.POST({}, { params: Promise.resolve({ id: 'conv-original' }) }),
    /injected failure at copied message 2/,
  );

  assert.equal(faultingDb.insertAttempts, 2);
  assert.equal(storage.prepare('SELECT COUNT(*) AS count FROM conversations').get().count, 1);
  assert.equal(
    storage.prepare("SELECT COUNT(*) AS count FROM messages WHERE conversation_id <> 'conv-original'").get().count,
    0,
  );
});

test('/api/conversations/[id]/duplicate preserves the successful 201 response and copied message order', async () => {
  const db = createDb();
  const route = loadRoute(db);

  const response = await route.POST({}, { params: Promise.resolve({ id: 'conv-original' }) });
  const payload = await response.json();

  assert.equal(response.status, 201);
  assert.equal(payload.character_id, 'char-a');
  assert.equal(payload.title, '原对话 (副本)');
  assert.equal(payload.ignore_memory, 0);
  assert.match(payload.created_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  assert.equal(payload.updated_at, payload.created_at);

  const copiedMessages = db.prepare(`
    SELECT role, content, token_count, created_at, seq, metadata
    FROM messages
    WHERE conversation_id = ?
    ORDER BY seq ASC
  `).all(payload.id);
  assert.deepEqual(copiedMessages, [
    {
      role: 'user',
      content: '第一条',
      token_count: 3,
      created_at: '2026-07-11T00:00:01.000Z',
      seq: 1,
      metadata: JSON.stringify({ source: 'original' }),
    },
    {
      role: 'assistant',
      content: '第二条',
      token_count: 4,
      created_at: '2026-07-11T00:00:02.000Z',
      seq: 2,
      metadata: JSON.stringify({ memory_extracted: true }),
    },
    {
      role: 'user',
      content: '第三条',
      token_count: 5,
      created_at: '2026-07-11T00:00:03.000Z',
      seq: 3,
      metadata: '{}',
    },
  ]);
});
