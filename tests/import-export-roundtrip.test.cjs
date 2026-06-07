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

function importRequest(payload, query = '') {
  const raw = JSON.stringify(payload);
  const suffix = query ? `?${query}` : '';
  return {
    headers: {
      get(name) {
        return name.toLowerCase() === 'content-length' ? String(Buffer.byteLength(raw)) : null;
      },
    },
    nextUrl: new URL(`http://test.local/api/import${suffix}`),
    async text() {
      return raw;
    },
  };
}

function rawImportRequest(raw, query = '') {
  const suffix = query ? `?${query}` : '';
  return {
    headers: {
      get() {
        return null;
      },
    },
    nextUrl: new URL(`http://test.local/api/import${suffix}`),
    async text() {
      return raw;
    },
  };
}

function createImportDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE characters (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL
    );

    CREATE TABLE conversations (
      id TEXT PRIMARY KEY,
      character_id TEXT NOT NULL,
      title TEXT NOT NULL DEFAULT '',
      ignore_memory INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

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
  db.prepare('INSERT INTO characters (id, name) VALUES (?, ?)').run('target-char', '目标角色');
  return db;
}

function loadImportRoute(db) {
  return requireFreshWithMocks('../src/app/api/import/route.ts', {
    'next/server': jsonResponseMock(),
    '@/lib/db': { getDb: () => db },
    '@/lib/character-card-import': { normalizeCharacterCard: () => null },
  });
}

function loadExportRoute(db) {
  return requireFreshWithMocks('../src/app/api/export/route.ts', {
    'next/server': jsonResponseMock(),
    '@/lib/db': { getDb: () => db },
  });
}

function parseJson(value) {
  return JSON.parse(value);
}

test('/api/import round-trips memory v2 fields, source message ids, ignore_memory, and sparse seq', async () => {
  const db = createImportDb();
  const route = loadImportRoute(db);
  const archivedMetadata = {
    previousStatus: 'active',
    archived_at: '2026-06-06T08:00:00.000Z',
    reason: 'manual',
  };

  const payload = {
    version: 2,
    memories: [
      {
        id: 'old-mem-archived',
        character_id: 'old-char',
        category: '重要事件',
        content: '钉选归档记忆',
        confidence: 0.93,
        tags: ['承诺', '重要'],
        source_msg_ids: ['old-user-msg', 'missing-msg', 'old-assistant-msg'],
        memory_kind: 'relationship_event',
        importance: 0.91,
        emotional_weight: 0.72,
        status: 'archived',
        pinned: 1,
        last_used_at: '2026-06-06T10:00:00.000Z',
        usage_count: 5,
        metadata: JSON.stringify(archivedMetadata),
        created_at: '2026-06-05T10:00:00.000Z',
        updated_at: '2026-06-06T11:00:00.000Z',
      },
      {
        id: 'old-mem-summarized',
        character_id: 'old-char',
        category: '话题历史',
        content: '已摘要覆盖记忆',
        status: 'summarized',
        metadata: { summary_id: 'summary-1' },
        created_at: '2026-06-05T12:00:00.000Z',
        updated_at: '2026-06-06T12:00:00.000Z',
      },
    ],
    conversations: [
      {
        id: 'old-conv',
        character_id: 'old-char',
        title: '导出的对话',
        ignore_memory: 1,
        created_at: '2026-06-05T09:00:00.000Z',
        updated_at: '2026-06-05T09:10:00.000Z',
        messages: [
          {
            id: 'old-user-msg',
            role: 'user',
            content: '用户原消息',
            token_count: 7,
            created_at: '2026-06-05T09:01:00.000Z',
            metadata: { mood: 'curious' },
            seq: 10,
          },
          {
            id: 'old-assistant-msg',
            role: 'assistant',
            content: '助手原回复',
            token_count: 9,
            created_at: '2026-06-05T09:02:00.000Z',
            metadata: '{"tone":"warm"}',
            seq: 42,
          },
        ],
      },
    ],
  };

  const response = await route.POST(importRequest(
    payload,
    'target_character_id=target-char&include_character=0',
  ));
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.memoriesImported, 2);
  assert.equal(body.conversationsImported, 1);
  assert.equal(body.messagesImported, 2);

  const conversation = db.prepare('SELECT * FROM conversations WHERE title = ?').get('导出的对话');
  assert.equal(conversation.ignore_memory, 1);

  const userMessage = db.prepare('SELECT * FROM messages WHERE content = ?').get('用户原消息');
  const assistantMessage = db.prepare('SELECT * FROM messages WHERE content = ?').get('助手原回复');
  assert.equal(userMessage.seq, 10);
  assert.equal(assistantMessage.seq, 42);
  assert.notEqual(userMessage.id, 'old-user-msg');
  assert.notEqual(assistantMessage.id, 'old-assistant-msg');

  const archivedMemory = db.prepare('SELECT * FROM memories WHERE content = ?').get('钉选归档记忆');
  assert.equal(archivedMemory.memory_kind, 'relationship_event');
  assert.equal(archivedMemory.importance, 0.91);
  assert.equal(archivedMemory.emotional_weight, 0.72);
  assert.equal(archivedMemory.status, 'archived');
  assert.equal(archivedMemory.pinned, 1);
  assert.equal(archivedMemory.last_used_at, '2026-06-06T10:00:00.000Z');
  assert.equal(archivedMemory.usage_count, 5);
  assert.deepEqual(parseJson(archivedMemory.metadata), archivedMetadata);
  assert.deepEqual(parseJson(archivedMemory.tags), ['承诺', '重要']);
  assert.deepEqual(parseJson(archivedMemory.source_msg_ids), [userMessage.id, assistantMessage.id]);

  const summarizedMemory = db.prepare('SELECT * FROM memories WHERE content = ?').get('已摘要覆盖记忆');
  assert.equal(summarizedMemory.status, 'summarized');
  assert.deepEqual(parseJson(summarizedMemory.metadata), { summary_id: 'summary-1' });
});

test('/api/import fills v2 defaults for old packages without those fields', async () => {
  const db = createImportDb();
  const route = loadImportRoute(db);
  const payload = {
    memories: [
      {
        id: 'old-mem-legacy',
        character_id: 'old-char',
        category: '偏好习惯',
        content: '旧包偏好记忆',
        confidence: 0.77,
        tags: ['旧包'],
        created_at: '2026-06-04T10:00:00.000Z',
        updated_at: '2026-06-04T10:00:00.000Z',
      },
    ],
  };

  const response = await route.POST(importRequest(
    payload,
    'target_character_id=target-char&include_character=0',
  ));

  assert.equal(response.status, 200);
  const memory = db.prepare('SELECT * FROM memories WHERE content = ?').get('旧包偏好记忆');
  assert.equal(memory.memory_kind, 'user_preference');
  assert.equal(memory.importance, 0.65);
  assert.equal(memory.emotional_weight, 0);
  assert.equal(memory.status, 'active');
  assert.equal(memory.pinned, 0);
  assert.equal(memory.usage_count, 0);
  assert.equal(memory.last_used_at, null);
  assert.deepEqual(parseJson(memory.metadata), {});
});

test('/api/import enforces the secondary size limit by UTF-8 bytes, not UTF-16 string length', async () => {
  const db = createImportDb();
  const route = loadImportRoute(db);
  const raw = `"${'界'.repeat(17_500_000)}"`;

  assert.ok(raw.length < 50 * 1024 * 1024);
  assert.ok(Buffer.byteLength(raw, 'utf8') > 50 * 1024 * 1024);

  const response = await route.POST(rawImportRequest(raw));
  const body = await response.json();

  assert.equal(response.status, 413);
  assert.deepEqual(body, { error: '导入文件过大' });
});

test('/api/export downgrades malformed memory JSON arrays instead of blocking export', async () => {
  const db = {
    prepare(sql) {
      if (sql.includes('SELECT * FROM characters ORDER BY updated_at DESC')) {
        return { all: () => [] };
      }
      if (sql.includes('SELECT * FROM memories ORDER BY character_id, updated_at DESC')) {
        return {
          all: () => [
            {
              id: 'bad-memory',
              character_id: 'char-1',
              category: '话题历史',
              content: '旧历史记忆',
              tags: '{',
              source_msg_ids: 'not json',
              updated_at: '2026-06-08T00:00:00.000Z',
            },
          ],
        };
      }
      if (sql.includes('SELECT * FROM conversations ORDER BY character_id, updated_at DESC')) {
        return { all: () => [] };
      }
      throw new Error(`unexpected sql: ${sql}`);
    },
  };
  const route = loadExportRoute(db);
  const request = {
    nextUrl: new URL('http://test.local/api/export?type=all'),
  };

  const response = await route.GET(request);
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.deepEqual(payload.memories[0].tags, []);
  assert.deepEqual(payload.memories[0].source_msg_ids, []);
});
