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

function jsonRequest(body) {
  return { json: async () => body };
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
    route.POST(jsonRequest({ mode: 'full' }), { params: Promise.resolve({ id: 'conv-original' }) }),
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

  const response = await route.POST(jsonRequest({ mode: 'full' }), { params: Promise.resolve({ id: 'conv-original' }) });
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

test('/api/conversations/[id]/duplicate preserves legacy full mode when the request body is empty', async () => {
  const db = createDb();
  const route = loadRoute(db);

  try {
    const response = await route.POST(
      new Request('http://test.local/api/conversations/conv-original/duplicate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      }),
      { params: Promise.resolve({ id: 'conv-original' }) },
    );
    const payload = await response.json();

    assert.equal(response.status, 201);
    assert.equal(payload.parent_id, null);
    assert.equal(
      db.prepare('SELECT COUNT(*) AS count FROM messages WHERE conversation_id = ?').get(payload.id).count,
      3,
    );
  } finally {
    db.close();
  }
});

test('/api/conversations/[id]/duplicate still rejects a non-empty malformed JSON body', async () => {
  const db = createDb();
  const route = loadRoute(db);

  try {
    const response = await route.POST(
      new Request('http://test.local/api/conversations/conv-original/duplicate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{',
      }),
      { params: Promise.resolve({ id: 'conv-original' }) },
    );

    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: 'Invalid JSON body' });
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM conversations').get().count, 1);
  } finally {
    db.close();
  }
});

test('/api/conversations/[id]/duplicate linked mode records the chain instead of copying messages', async () => {
  const db = createDb();
  const route = loadRoute(db);

  const response = await route.POST(
    jsonRequest({ mode: 'linked' }),
    { params: Promise.resolve({ id: 'conv-original' }) },
  );
  const payload = await response.json();

  assert.equal(response.status, 201);
  assert.equal(payload.parent_id, 'conv-original');
  // 继承上界 = 原对话当前最大 seq，新消息必须接在它之后
  assert.equal(payload.parent_seq_end, 11);

  // 一条消息都没有被复制
  assert.equal(
    db.prepare('SELECT COUNT(*) AS count FROM messages WHERE conversation_id = ?').get(payload.id).count,
    0,
  );
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM messages').get().count, 3);
});

test('/api/conversations/[id]/duplicate linked mode chains onto an existing linked conversation', async () => {
  const db = createDb();
  const route = loadRoute(db);

  const first = await (await route.POST(
    jsonRequest({ mode: 'linked' }),
    { params: Promise.resolve({ id: 'conv-original' }) },
  )).json();

  // 子对话再写入一条自己的消息（seq 接在继承上界之后）
  db.prepare(`
    INSERT INTO messages (id, conversation_id, role, content, token_count, created_at, seq, metadata)
    VALUES ('msg-4', ?, 'user', '第四条', 2, '2026-07-11T01:00:00.000Z', 12, '{}')
  `).run(first.id);

  const second = await (await route.POST(
    jsonRequest({ mode: 'linked' }),
    { params: Promise.resolve({ id: first.id }) },
  )).json();

  assert.equal(second.parent_id, first.id);
  // 上界要覆盖整条链的可见范围（含祖父对话的消息），而不是只看直接父对话
  assert.equal(second.parent_seq_end, 12);
});

test('/api/conversations/[id]/duplicate full mode materialises the whole chain', async () => {
  const db = createDb();
  const route = loadRoute(db);

  const linked = await (await route.POST(
    jsonRequest({ mode: 'linked' }),
    { params: Promise.resolve({ id: 'conv-original' }) },
  )).json();
  db.prepare(`
    INSERT INTO messages (id, conversation_id, role, content, token_count, created_at, seq, metadata)
    VALUES ('msg-4', ?, 'user', '第四条', 2, '2026-07-11T01:00:00.000Z', 12, '{}')
  `).run(linked.id);

  // 对链式对话做全量复制时，继承来的历史必须一并物化，否则副本会丢历史
  const full = await (await route.POST(
    jsonRequest({ mode: 'full' }),
    { params: Promise.resolve({ id: linked.id }) },
  )).json();

  const copied = db.prepare(
    'SELECT content, seq FROM messages WHERE conversation_id = ? ORDER BY seq ASC',
  ).all(full.id);
  assert.deepEqual(copied.map(row => row.content), ['第一条', '第二条', '第三条', '第四条']);
  assert.deepEqual(copied.map(row => row.seq), [1, 2, 3, 4]);
  assert.equal(full.parent_id, null);
});

test('/api/conversations/[id]/duplicate full mode preserves linked seq order for late inserted replies', async () => {
  const db = createDb();
  db.prepare(`
    INSERT INTO conversations (
      id, character_id, title, created_at, updated_at, parent_id, parent_seq_end
    ) VALUES (
      'conv-inserted', 'char-a', '插入式分支',
      '2026-07-12T00:00:00.000Z', '2026-07-12T00:00:02.000Z',
      'conv-original', 11
    )
  `).run();
  db.prepare(`
    INSERT INTO messages (id, conversation_id, role, content, token_count, created_at, seq, metadata)
    VALUES
      ('msg-inserted', 'conv-inserted', 'assistant', '插在第一条之后', 2, '2026-07-12T00:00:01.000Z', 8, '{}'),
      ('msg-tail', 'conv-inserted', 'user', '分支继续', 2, '2026-07-12T00:00:02.000Z', 12, '{}')
  `).run();
  const route = loadRoute(db);

  const full = await (await route.POST(
    jsonRequest({ mode: 'full' }),
    { params: Promise.resolve({ id: 'conv-inserted' }) },
  )).json();
  const copied = db.prepare(`
    SELECT content, seq
    FROM messages
    WHERE conversation_id = ?
    ORDER BY seq ASC
  `).all(full.id);

  assert.deepEqual(copied.map(row => row.content), [
    '第一条',
    '插在第一条之后',
    '第二条',
    '第三条',
    '分支继续',
  ]);
  assert.deepEqual(copied.map(row => row.seq), [1, 2, 3, 4, 5]);
  assert.equal(full.parent_id, null);
});
