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
        const headers = new Headers(init.headers);
        return {
          status: init.status ?? 200,
          headers,
          async json() {
            return body;
          },
        };
      },
    },
  };
}

function requestFor(url) {
  return { nextUrl: new URL(url) };
}

function jsonRequest(body) {
  return {
    signal: new AbortController().signal,
    async json() {
      return body;
    },
  };
}

function createConversationDb(options = {}) {
  const { count = 40, includeOtherCharacter = false } = options;
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE conversations (
      id TEXT PRIMARY KEY,
      character_id TEXT NOT NULL,
      title TEXT NOT NULL,
      ignore_memory INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE characters (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL
    );
  `);
  db.prepare("INSERT INTO characters (id, name) VALUES ('char-a', '艾莉丝')").run();
  if (includeOtherCharacter) {
    db.prepare("INSERT INTO characters (id, name) VALUES ('char-b', '未选角色')").run();
    db.prepare(`
      INSERT INTO conversations (id, character_id, title, created_at, updated_at)
      VALUES ('conv-other', 'char-b', '其它角色对话', '2026-06-08T00:00:00.000Z', '2026-06-08T00:00:00.000Z')
    `).run();
  }
  const insert = db.prepare(`
    INSERT INTO conversations (id, character_id, title, created_at, updated_at)
    VALUES (?, 'char-a', ?, ?, ?)
  `);
  for (let i = 0; i < count; i += 1) {
    const ts = new Date(Date.UTC(2026, 5, 7, 0, 0, i)).toISOString();
    insert.run(`conv-${String(i).padStart(2, '0')}`, `对话 ${i}`, ts, ts);
  }
  return db;
}

function createConversationTieBreakerDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE conversations (
      id TEXT PRIMARY KEY,
      character_id TEXT NOT NULL,
      title TEXT NOT NULL,
      ignore_memory INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
  const insert = db.prepare(`
    INSERT INTO conversations (id, character_id, title, created_at, updated_at)
    VALUES (?, 'char-a', ?, ?, '2026-06-07T12:00:00.000Z')
  `);
  insert.run('conv-b', '同更新时间 B', '2026-06-07T11:59:59.000Z');
  insert.run('conv-a', '同更新时间 A', '2026-06-07T11:59:58.000Z');
  insert.run('conv-c', '同更新时间 C', '2026-06-07T11:59:59.000Z');
  return db;
}

function createConversationMessagesDb() {
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
    VALUES ('conv-a', 'char-a', '消息边界测试', '2026-07-11T00:00:00.000Z', '2026-07-11T00:00:00.000Z')
  `).run();
  return db;
}

function createSearchDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE characters (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      avatar_url TEXT
    );
    CREATE TABLE conversations (
      id TEXT PRIMARY KEY,
      character_id TEXT NOT NULL,
      title TEXT NOT NULL
    );
    CREATE TABLE messages (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at TEXT NOT NULL,
      seq INTEGER NOT NULL DEFAULT 0
    );
    CREATE VIRTUAL TABLE messages_fts USING fts5(
      id UNINDEXED,
      content,
      role UNINDEXED,
      conversation_id UNINDEXED,
      created_at UNINDEXED,
      seq UNINDEXED
    );
    CREATE VIRTUAL TABLE messages_fts_trigram USING fts5(
      id UNINDEXED,
      content,
      role UNINDEXED,
      conversation_id UNINDEXED,
      created_at UNINDEXED,
      seq UNINDEXED,
      tokenize = 'trigram'
    );
    CREATE INDEX idx_messages_created_at ON messages(created_at);
  `);
  db.prepare("INSERT INTO characters (id, name, avatar_url) VALUES ('char-a', '艾莉丝', NULL)").run();
  db.prepare("INSERT INTO conversations (id, character_id, title) VALUES ('conv-a', 'char-a', '搜索测试')").run();
  const insert = db.prepare(`
    INSERT INTO messages (id, conversation_id, role, content, created_at, seq)
    VALUES (?, 'conv-a', 'user', ?, ?, ?)
  `);
  insert.run('msg-literal-percent', '我真的输入了 100% 这个符号', '2026-06-07T00:00:00.000Z', 1);
  insert.run('msg-expanded-percent', '这里是 100X，被通配符误伤才会命中', '2026-06-07T00:01:00.000Z', 2);
  insert.run('msg-literal-underscore', '订单编号 A_B 是字面下划线', '2026-06-07T00:02:00.000Z', 3);
  insert.run('msg-expanded-underscore', '订单编号 AXB 不应被下划线通配符命中', '2026-06-07T00:03:00.000Z', 4);
  insert.run('msg-cjk-newest', '主人今天想吃拉面', '2026-06-07T00:07:00.000Z', 7);
  insert.run('msg-cjk-middle', '艾莉丝问主人今天开心吗', '2026-06-07T00:06:00.000Z', 6);
  insert.run('msg-cjk-oldest', '昨晚梦见主人今天来看我', '2026-06-07T00:06:00.000Z', 5);
  insert.run('msg-cjk-short-only', '主人明天再见', '2026-06-07T00:04:00.000Z', 8);
  insert.run('msg-system-cjk', '主人今天的系统备注', '2026-06-07T00:08:00.000Z', 9);
  db.prepare("UPDATE messages SET role = 'system' WHERE id = 'msg-system-cjk'").run();
  db.exec(`
    INSERT INTO messages_fts(id, content, role, conversation_id, created_at, seq)
    SELECT id, content, role, conversation_id, created_at, seq FROM messages;
    INSERT INTO messages_fts_trigram(id, content, role, conversation_id, created_at, seq)
    SELECT id, content, role, conversation_id, created_at, seq FROM messages;
  `);
  return db;
}

function loadRoute(modulePath, db) {
  return requireFreshWithMocks(modulePath, {
    'next/server': jsonResponseMock(),
    '@/lib/db': { getDb: () => db },
  });
}

function loadHealthRoute(mocks = {}) {
  try {
    delete require.cache[require.resolve('../src/lib/readiness.ts')];
  } catch {
    // RED 阶段 readiness helper 尚不存在时，路由仍应可被加载并暴露缺失行为。
  }
  return requireFreshWithMocks('../src/app/api/health/route.ts', {
    'next/server': jsonResponseMock(),
    ...mocks,
  });
}

test('/api/conversations GET returns a bounded first page by default', async () => {
  const route = loadRoute('../src/app/api/conversations/route.ts', createConversationDb());

  const response = await route.GET(requestFor('http://test.local/api/conversations'));
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.equal(payload.conversations.length, 20);
  assert.equal(payload.total, 40);
  assert.equal(payload.hasMore, true);
  assert.equal(payload.conversations[0].id, 'conv-39');
});

test('/api/conversations GET with character_id returns the default bounded array shape', async () => {
  const route = loadRoute('../src/app/api/conversations/route.ts', createConversationDb({ includeOtherCharacter: true }));

  const response = await route.GET(requestFor('http://test.local/api/conversations?character_id=char-a'));
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.equal(Array.isArray(payload), true);
  assert.equal(payload.length, 20);
  assert.equal(payload[0].id, 'conv-39');
  assert.equal(payload.at(-1).id, 'conv-20');
  assert.ok(payload.every(conversation => conversation.character_id === 'char-a'));
});

test('/api/conversations GET with character_id exposes pagination headers while preserving array compatibility', async () => {
  const route = loadRoute('../src/app/api/conversations/route.ts', createConversationDb({ count: 45 }));

  const response = await route.GET(requestFor('http://test.local/api/conversations?character_id=char-a&limit=10&offset=20'));
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.equal(Array.isArray(payload), true);
  assert.deepEqual(payload.map(conversation => conversation.id), [
    'conv-24',
    'conv-23',
    'conv-22',
    'conv-21',
    'conv-20',
    'conv-19',
    'conv-18',
    'conv-17',
    'conv-16',
    'conv-15',
  ]);
  assert.equal(response.headers.get('X-Total-Count'), '45');
  assert.equal(response.headers.get('X-Has-More'), 'true');
  assert.equal(response.headers.get('X-Page-Limit'), '10');
  assert.equal(response.headers.get('X-Page-Offset'), '20');
});

test('/api/conversations GET with character_id honors limit and offset while preserving newest-first order', async () => {
  const route = loadRoute('../src/app/api/conversations/route.ts', createConversationDb());

  const response = await route.GET(requestFor('http://test.local/api/conversations?character_id=char-a&limit=5&offset=3'));
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.deepEqual(payload.map(conversation => conversation.id), ['conv-36', 'conv-35', 'conv-34', 'conv-33', 'conv-32']);
});

test('/api/conversations GET default page uses stable tie-breakers for same updated_at rows', async () => {
  const route = loadRoute('../src/app/api/conversations/route.ts', createConversationTieBreakerDb());

  const response = await route.GET(requestFor('http://test.local/api/conversations?limit=2'));
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.deepEqual(payload.conversations.map(conversation => conversation.id), ['conv-c', 'conv-b']);
  assert.equal(payload.total, 3);
  assert.equal(payload.hasMore, true);
});

test('/api/conversations GET with character_id paginates same updated_at rows with stable tie-breakers', async () => {
  const route = loadRoute('../src/app/api/conversations/route.ts', createConversationTieBreakerDb());

  const response = await route.GET(requestFor('http://test.local/api/conversations?character_id=char-a&limit=2&offset=1'));
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.deepEqual(payload.map(conversation => conversation.id), ['conv-b', 'conv-a']);
  assert.equal(response.headers.get('X-Total-Count'), '3');
  assert.equal(response.headers.get('X-Has-More'), 'false');
  assert.equal(response.headers.get('X-Page-Limit'), '2');
  assert.equal(response.headers.get('X-Page-Offset'), '1');
});

test('/api/conversations GET with character_id clamps limit to the maximum page size', async () => {
  const route = loadRoute('../src/app/api/conversations/route.ts', createConversationDb({ count: 125 }));

  const response = await route.GET(requestFor('http://test.local/api/conversations?character_id=char-a&limit=500'));
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.equal(payload.length, 100);
  assert.equal(payload[0].id, 'conv-124');
  assert.equal(payload.at(-1).id, 'conv-25');
});

test('/api/conversations/[id] PUT writes ISO updated_at for title and ignore_memory changes', async () => {
  const db = createConversationDb({ count: 1 });
  const route = loadRoute('../src/app/api/conversations/[id]/route.ts', db);

  const titleResponse = await route.PUT(
    jsonRequest({ title: '重命名后的对话' }),
    { params: Promise.resolve({ id: 'conv-00' }) },
  );
  const titlePayload = await titleResponse.json();
  assert.equal(titleResponse.status, 200);
  assert.equal(titlePayload.title, '重命名后的对话');
  assert.match(titlePayload.updated_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);

  const ignoreResponse = await route.PUT(
    jsonRequest({ ignore_memory: true }),
    { params: Promise.resolve({ id: 'conv-00' }) },
  );
  const ignorePayload = await ignoreResponse.json();
  assert.equal(ignoreResponse.status, 200);
  assert.equal(ignorePayload.ignore_memory, 1);
  assert.match(ignorePayload.updated_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
});

test('/api/conversations/[id]/messages POST returns 404 without inserting for a missing conversation', async () => {
  const db = createConversationMessagesDb();
  const route = loadRoute('../src/app/api/conversations/[id]/messages/route.ts', db);

  const response = await route.POST(
    jsonRequest({ role: 'user', content: '不应写入', token_count: 3, metadata: { source: 'test' } }),
    { params: Promise.resolve({ id: 'missing-conversation' }) },
  );
  const payload = await response.json();

  assert.equal(response.status, 404);
  assert.equal(typeof payload.error, 'string');
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM messages').get().count, 0);
});

test('/api/conversations/[id]/messages POST preserves the existing 201 response for a valid conversation', async () => {
  const db = createConversationMessagesDb();
  const route = loadRoute('../src/app/api/conversations/[id]/messages/route.ts', db);
  const { estimateTokens } = require('../src/lib/token-counter.ts');

  const response = await route.POST(
    jsonRequest({ role: 'assistant', content: '有效回复', token_count: 5, metadata: { tone: 'warm' } }),
    { params: Promise.resolve({ id: 'conv-a' }) },
  );
  const payload = await response.json();

  assert.equal(response.status, 201);
  assert.equal(payload.conversation_id, 'conv-a');
  assert.equal(payload.role, 'assistant');
  assert.equal(payload.content, '有效回复');
  assert.equal(payload.token_count, estimateTokens('有效回复'));
  assert.equal(payload.seq, 1);
  assert.equal(payload.metadata.tone, 'warm');
  assert.equal(payload.metadata.token_count_provenance.source, 'server');
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM messages WHERE conversation_id = ?').get('conv-a').count, 1);
  assert.match(
    db.prepare('SELECT updated_at FROM conversations WHERE id = ?').get('conv-a').updated_at,
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
  );
});

test('/api/conversations/[id]/messages POST ignores external token provenance and stores a server count', async () => {
  const db = createConversationMessagesDb();
  const route = loadRoute('../src/app/api/conversations/[id]/messages/route.ts', db);
  const { estimateTokens } = require('../src/lib/token-counter.ts');

  const response = await route.POST(
    jsonRequest({
      role: 'user',
      content: 'short external message',
      token_count: 5000,
      metadata: {
        source: 'external',
        token_count_provenance: {
          source: 'server',
          version: 1,
          algorithm: 'forged',
          fingerprint: 'forged',
        },
      },
    }),
    { params: Promise.resolve({ id: 'conv-a' }) },
  );
  const payload = await response.json();

  assert.equal(response.status, 201);
  assert.equal(payload.token_count, estimateTokens('short external message'));
  assert.equal(payload.metadata.source, 'external');
  assert.equal(payload.metadata.token_count_provenance.source, 'server');
  assert.notEqual(payload.metadata.token_count_provenance.algorithm, 'forged');
});

test('/api/messages/[id] PUT refreshes token provenance after content and attachment edits', async () => {
  const db = createConversationMessagesDb();
  db.prepare(`
    INSERT INTO messages (id, conversation_id, role, content, token_count, created_at, seq, metadata)
    VALUES ('msg-edit', 'conv-a', 'user', 'old content', 5000, '2026-07-11T00:00:01.000Z', 1, '{}')
  `).run();
  const route = loadRoute('../src/app/api/messages/[id]/route.ts', db);
  const { estimateTokens } = require('../src/lib/token-counter.ts');
  const attachment = {
    type: 'text',
    name: 'note.txt',
    data: 'attachment text',
    mimeType: 'text/plain',
  };

  const response = await route.PUT(
    jsonRequest({ content: 'edited content', attachments: [attachment] }),
    { params: Promise.resolve({ id: 'msg-edit' }) },
  );
  const payload = await response.json();
  const expectedText = 'edited content\n\n[附件: note.txt]\nattachment text';

  assert.equal(response.status, 200);
  assert.equal(payload.token_count, estimateTokens(expectedText));
  assert.deepEqual(payload.metadata.attachments, [attachment]);
  assert.equal(payload.metadata.token_count_provenance.source, 'server');
});

test('/api/messages/[id] DELETE returns the owning conversation id for precise cache invalidation', async () => {
  const db = createConversationMessagesDb();
  db.prepare(`
    INSERT INTO messages (id, conversation_id, role, content, token_count, created_at, seq, metadata)
    VALUES ('msg-delete', 'conv-a', 'assistant', 'delete me', 2, '2026-07-11T00:00:01.000Z', 1, '{}')
  `).run();
  const route = loadRoute('../src/app/api/messages/[id]/route.ts', db);

  const response = await route.DELETE(
    jsonRequest({}),
    { params: Promise.resolve({ id: 'msg-delete' }) },
  );
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.deepEqual(payload, {
    ok: true,
    deleted: 'message',
    conversation_id: 'conv-a',
  });
});

test('/api/summarize uses one ISO timestamp for the summary message and conversation updated_at', async () => {
  let insertedAt;
  let updatedAt;
  let insertedSummary;
  const db = {
    prepare(sql) {
      if (sql.includes('SELECT * FROM conversations WHERE id = ?')) {
        return { get: () => ({ character_id: 'char-a', title: '测试对话' }) };
      }
      if (sql.includes('SELECT * FROM characters WHERE id = ?')) {
        return {
          get: () => ({
            id: 'char-a',
            name: '艾莉丝',
            basic_info: '',
            personality: '',
            scenario: '',
            other_info: '',
          }),
        };
      }
      if (sql.includes('SELECT * FROM messages WHERE conversation_id = ?')) {
        return {
          all: () => [
            { id: 'u-1', conversation_id: 'conv-a', role: 'user', content: '你好', token_count: 1, created_at: '2026-07-11T00:00:00.000Z', seq: 1, metadata: '{}' },
            { id: 'a-1', conversation_id: 'conv-a', role: 'assistant', content: '主人好', token_count: 1, created_at: '2026-07-11T00:00:01.000Z', seq: 2, metadata: '{}' },
          ],
        };
      }
      if (sql.includes('SELECT MAX(seq)')) {
        return { get: () => ({ m: 2 }) };
      }
      if (sql.includes('INSERT INTO messages')) {
        return {
          run(id, conversationId, content, tokenCount, createdAt, seq, metadata) {
            insertedAt = createdAt;
            insertedSummary = { id, conversationId, content, tokenCount, createdAt, seq, metadata };
          },
        };
      }
      if (sql.includes('UPDATE conversations SET updated_at')) {
        return {
          run(value, conversationId) {
            updatedAt = value;
            assert.equal(conversationId, 'conv-a');
          },
        };
      }
      throw new Error(`unexpected SQL: ${sql}`);
    },
    transaction(fn) {
      return (...args) => fn(...args);
    },
  };
  const route = requireFreshWithMocks('../src/app/api/summarize/route.ts', {
    'next/server': jsonResponseMock(),
    '@/lib/db': { getDb: () => db },
    '@/lib/settings': {
      loadSettings: () => ({ max_tokens: 1024, temperature: 0.7 }),
      resolveBackgroundConfig: () => ({ api_base: 'https://llm.example/v1', api_key: 'secret', model: 'model-a' }),
      buildBackgroundChatExtraBody: () => undefined,
    },
    '@/lib/api-client': {
      REASONING_SAFE_MAX_TOKENS: 1024,
      sanitizeUpstreamError: value => value,
    },
    '@/lib/ssrf-guard': {
      safeFetch: async () => ({ ok: true, body: { getReader: () => ({ cancel: async () => {} }) } }),
    },
    '@/lib/sse-parser': {
      parseSseStream: async (_reader, onEvent) => onEvent({ text: '这是总结。' }),
    },
    '@/lib/memory-profile': {
      readMemoryProfile: () => null,
      renderMemoryProfile: () => '',
    },
  });

  const response = await route.POST(jsonRequest({ conversation_id: 'conv-a' }));
  const payload = await response.json();

  assert.equal(response.status, 200, payload.error);
  assert.equal(payload.ok, true);
  assert.match(insertedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  assert.equal(updatedAt, insertedAt);
  assert.equal(payload.summarizedCount, 2);
  assert.equal(payload.message.role, 'system');
  assert.equal(payload.message.content, '这是总结。');
  const { estimateTokens } = require('../src/lib/token-counter.ts');
  assert.equal(payload.message.token_count, estimateTokens('这是总结。'));
  assert.deepEqual(payload.message.metadata.summarizedIds, ['u-1', 'a-1']);
  assert.equal(payload.message.metadata.isSummary, true);
  assert.equal(payload.message.metadata.token_count_provenance.source, 'server');
  assert.equal(insertedSummary.conversationId, 'conv-a');
  assert.equal(insertedSummary.content, '这是总结。');
  assert.equal(insertedSummary.tokenCount, estimateTokens('这是总结。'));
  assert.equal(insertedSummary.seq, 3);
  assert.deepEqual(JSON.parse(insertedSummary.metadata), payload.message.metadata);
});

test('/api/messages/search LIKE fallback treats percent and underscore as literal characters', async () => {
  const route = loadRoute('../src/app/api/messages/search/route.ts', createSearchDb());

  const percentResponse = await route.GET(requestFor('http://test.local/api/messages/search?q=100%25&limit=10'));
  const percentPayload = await percentResponse.json();
  const underscoreResponse = await route.GET(requestFor('http://test.local/api/messages/search?q=A_B&limit=10'));
  const underscorePayload = await underscoreResponse.json();

  assert.equal(percentResponse.status, 200);
  assert.deepEqual(percentPayload.results.map(result => result.messageId), ['msg-literal-percent']);
  assert.equal(underscoreResponse.status, 200);
  assert.deepEqual(underscorePayload.results.map(result => result.messageId), ['msg-literal-underscore']);
});

test('/api/messages/search keeps 1-2 code point Chinese queries on LIKE', async () => {
  const db = createSearchDb();
  const preparedSql = [];
  const route = loadRoute('../src/app/api/messages/search/route.ts', {
    prepare(sql) {
      preparedSql.push(sql);
      return db.prepare(sql);
    },
  });

  const response = await route.GET(requestFor(
    'http://test.local/api/messages/search?q=%E4%B8%BB%E4%BA%BA&limit=10',
  ));
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.deepEqual(
    payload.results.map(result => result.messageId),
    ['msg-cjk-newest', 'msg-cjk-middle', 'msg-cjk-oldest', 'msg-cjk-short-only'],
  );
  assert.equal(preparedSql.some(sql => sql.includes('messages_fts_trigram MATCH')), false);
  assert.ok(preparedSql.some(sql => sql.includes('m.content LIKE ?')));
});

test('/api/messages/search uses trigram for 3+ code point Chinese with LIKE-equivalent ordering and pagination', async () => {
  const db = createSearchDb();
  const preparedSql = [];
  const route = loadRoute('../src/app/api/messages/search/route.ts', {
    prepare(sql) {
      preparedSql.push(sql);
      return db.prepare(sql);
    },
  });
  const baseline = db.prepare(`
    SELECT m.id
    FROM messages m
    WHERE m.content LIKE ? ESCAPE '\\' AND m.role IN ('user', 'assistant')
    ORDER BY m.created_at DESC, m.seq DESC, m.id DESC
    LIMIT ? OFFSET ?
  `);

  for (const offset of [0, 1]) {
    const response = await route.GET(requestFor(
      `http://test.local/api/messages/search?q=%E4%B8%BB%E4%BA%BA%E4%BB%8A%E5%A4%A9&limit=2&offset=${offset}`,
    ));
    const payload = await response.json();
    const likeRows = baseline.all('%主人今天%', 3, offset);
    const expectedHasMore = likeRows.length > 2;

    assert.equal(response.status, 200);
    assert.deepEqual(
      payload.results.map(result => result.messageId),
      likeRows.slice(0, 2).map(row => row.id),
    );
    assert.equal(payload.hasMore, expectedHasMore);
  }

  assert.ok(preparedSql.some(sql => sql.includes('messages_fts_trigram MATCH')));
  assert.equal(preparedSql.some(sql => sql.includes('m.content LIKE ?')), false);
});

test('/api/messages/search indexed paths are visible to SQLite query planning', () => {
  const db = createSearchDb();
  const trigramPlan = db.prepare(`
    EXPLAIN QUERY PLAN
    SELECT m.id
    FROM messages_fts_trigram fts
    JOIN messages m ON m.id = fts.id
    WHERE messages_fts_trigram MATCH ? AND m.role IN ('user', 'assistant')
    ORDER BY m.created_at DESC
    LIMIT ? OFFSET ?
  `).all('"主人今天"', 3, 0);
  const datePlan = db.prepare(`
    EXPLAIN QUERY PLAN
    SELECT m.id
    FROM messages m
    WHERE m.created_at >= ? AND m.created_at <= ?
      AND m.role IN ('user', 'assistant')
    ORDER BY m.created_at ASC
    LIMIT ? OFFSET ?
  `).all('2026-06-07T00:00:00.000Z', '2026-06-07T23:59:59.999Z', 3, 0);

  assert.ok(trigramPlan.some(row => /SCAN fts VIRTUAL TABLE INDEX/.test(String(row.detail))));
  assert.ok(datePlan.some(row => String(row.detail).includes('idx_messages_created_at')));
  assert.equal(datePlan.some(row => String(row.detail).includes('USE TEMP B-TREE FOR ORDER BY')), false);
});

test('/api/messages GET floors a fractional page limit before binding it to SQLite', async () => {
  const db = createConversationMessagesDb();
  const insert = db.prepare(`
    INSERT INTO messages (id, conversation_id, role, content, token_count, created_at, seq, metadata)
    VALUES (?, 'conv-a', 'user', ?, 1, ?, ?, '{}')
  `);
  insert.run('msg-1', '第一条', '2026-07-11T00:00:01.000Z', 1);
  insert.run('msg-2', '第二条', '2026-07-11T00:00:02.000Z', 2);
  insert.run('msg-3', '第三条', '2026-07-11T00:00:03.000Z', 3);
  const route = loadRoute('../src/app/api/messages/route.ts', db);

  const response = await route.GET(requestFor(
    'http://test.local/api/messages?conversation_id=conv-a&limit=1.9',
  ));
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.deepEqual(payload.messages.map(message => message.id), ['msg-3']);
  assert.equal(payload.hasMore, true);
});

test('/api/messages older-page GET skips conversation-wide aggregates', async () => {
  const db = createConversationMessagesDb();
  const insert = db.prepare(`
    INSERT INTO messages (id, conversation_id, role, content, token_count, created_at, seq, metadata)
    VALUES (?, 'conv-a', 'user', ?, ?, ?, ?, '{}')
  `);
  insert.run('msg-1', '第一条', 1, '2026-07-11T00:00:01.000Z', 1);
  insert.run('msg-2', '第二条', 2, '2026-07-11T00:00:02.000Z', 2);
  insert.run('msg-3', '第三条', 3, '2026-07-11T00:00:03.000Z', 3);
  const preparedSql = [];
  const trackedDb = {
    prepare(sql) {
      preparedSql.push(sql);
      return db.prepare(sql);
    },
  };
  const route = loadRoute('../src/app/api/messages/route.ts', trackedDb);

  const response = await route.GET(requestFor(
    'http://test.local/api/messages?conversation_id=conv-a&limit=1&before_seq=3',
  ));
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.deepEqual(payload.messages.map(message => message.id), ['msg-2']);
  assert.equal(payload.hasMore, true);
  assert.equal(Object.hasOwn(payload, 'unextractedCount'), false);
  assert.equal(Object.hasOwn(payload, 'totalTokens'), false);
  assert.equal(preparedSql.some(sql => /COUNT\(\*\)|SUM\(token_count\)|isSummary/.test(sql)), false);
});

test('/api/messages/search floors fractional limit and offset before SQLite pagination', async () => {
  const route = loadRoute('../src/app/api/messages/search/route.ts', createSearchDb());

  const response = await route.GET(requestFor(
    'http://test.local/api/messages/search?q=%E8%AE%A2%E5%8D%95&limit=1.9&offset=0.9',
  ));
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.equal(payload.results.length, 1);
  assert.equal(payload.hasMore, true);
});

test('/api/memory-profile init_from_memories batches sampled messages instead of querying assistant replies per user message', async () => {
  let capturedSourceText = '';
  let assistantLookupCount = 0;
  const db = {
    prepare(sql) {
      if (sql.includes('SELECT * FROM characters WHERE id = ?')) {
        return {
          get(characterId) {
            assert.equal(characterId, 'char-a');
            return {
              name: '艾莉丝',
              basic_info: '',
              personality: '',
              scenario: '',
              other_info: '',
              system_prompt: '',
            };
          },
        };
      }
      if (sql.includes("FROM memories WHERE character_id = ? AND status = 'active'")) {
        return {
          all(characterId) {
            assert.equal(characterId, 'char-a');
            return [{ content: '主人正在整理画像', category: '话题历史', importance: 0.8 }];
          },
        };
      }
      if (sql.includes('SELECT id FROM conversations WHERE character_id = ?')) {
        return {
          all(characterId) {
            assert.equal(characterId, 'char-a');
            return [{ id: 'conv-a' }];
          },
        };
      }
      if (sql.includes("role = 'user'")) {
        return {
          all(conversationId) {
            assert.equal(conversationId, 'conv-a');
            return [
              { id: 'user-1', content: '用户消息 1', created_at: '2026-06-07T00:00:00.000Z', seq: 1 },
              { id: 'user-2', content: '用户消息 2', created_at: '2026-06-07T00:02:00.000Z', seq: 3 },
            ];
          },
        };
      }
      if (sql.includes("role = 'assistant' AND created_at > ?")) {
        assistantLookupCount += 1;
        return {
          get(_conversationId, userCreatedAt) {
            return {
              content: `逐条查询回复 ${userCreatedAt}`,
              created_at: '2026-06-07T00:03:00.000Z',
            };
          },
        };
      }
      if (sql.includes('WITH sampled_users')) {
        return {
          all(...args) {
            assert.equal(args.at(-1), 'conv-a');
            return [
              { user_id: 'user-1', content: '批量查询回复 1', created_at: '2026-06-07T00:01:00.000Z', seq: 2 },
              { user_id: 'user-2', content: '批量查询回复 2', created_at: '2026-06-07T00:03:00.000Z', seq: 4 },
            ];
          },
        };
      }
      if (sql.includes("role IN ('user','assistant')")) {
        return {
          all(conversationId) {
            assert.equal(conversationId, 'conv-a');
            return [
              { role: 'user', content: '用户消息 1', created_at: '2026-06-07T00:00:00.000Z', seq: 1 },
              { role: 'assistant', content: '批量查询回复 1', created_at: '2026-06-07T00:01:00.000Z', seq: 2 },
              { role: 'user', content: '用户消息 2', created_at: '2026-06-07T00:02:00.000Z', seq: 3 },
              { role: 'assistant', content: '批量查询回复 2', created_at: '2026-06-07T00:03:00.000Z', seq: 4 },
            ];
          },
        };
      }
      throw new Error(`unexpected sql: ${sql}`);
    },
  };
  const route = requireFreshWithMocks('../src/app/api/memory-profile/route.ts', {
    'next/server': jsonResponseMock(),
    '@/lib/db': { getDb: () => db },
    '@/lib/memory-profile': {
      deleteMemoryProfileVersion: () => 0,
      enqueueMemoryProfileUpdate: () => ({ id: 1 }),
      enqueueMemoryProfilePatchExtraction: (_characterId, sourceText) => {
        capturedSourceText = sourceText;
        return { id: 42 };
      },
      getMemoryProfileTaskSummaries: () => [],
      getMemoryProfileUpdateTasks: () => [{ id: 42, status: 'done' }],
      getMemoryProfileVersions: () => [],
      getOrCreateMemoryProfile: characterId => ({ character_id: characterId }),
      processMemoryProfileUpdateTasks: async () => ({ processed: 1, skipped: 0, failed: 0, remaining: 0 }),
      readMemoryProfile: characterId => ({ character_id: characterId }),
      rollbackMemoryProfile: characterId => ({ character_id: characterId }),
      triggerMemoryProfileQueue: () => {},
    },
  });

  const response = await route.POST({
    nextUrl: new URL('http://test.local/api/memory-profile'),
    async json() {
      return { action: 'init_from_memories', character_id: 'char-a' };
    },
  });
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.equal(payload.ok, true);
  assert.equal(assistantLookupCount, 0);
  assert.match(capturedSourceText, /批量查询回复 1/);
  assert.match(capturedSourceText, /批量查询回复 2/);
});

test('/api/health GET returns non-sensitive service liveness metadata', async () => {
  const previousBuildSha = process.env.LUMIMUSE_BUILD_SHA;
  delete process.env.LUMIMUSE_BUILD_SHA;
  let readinessCalls = 0;
  const route = loadHealthRoute({
    '@/lib/readiness': {
      async checkReadiness() {
        readinessCalls += 1;
        throw new Error('liveness must not run readiness checks');
      },
    },
  });

  try {
    const response = await route.GET(requestFor('http://test.local/api/health'));
    const payload = await response.json();

    assert.equal(response.status, 200);
    assert.equal(payload.ok, true);
    assert.equal(readinessCalls, 0);
    assert.equal(payload.build, 'local');
    assert.equal(Object.hasOwn(payload, 'version'), false);
    assert.ok(!('api_key' in payload));
    assert.ok(!('ACCESS_PASSWORD' in payload));
  } finally {
    if (previousBuildSha === undefined) delete process.env.LUMIMUSE_BUILD_SHA;
    else process.env.LUMIMUSE_BUILD_SHA = previousBuildSha;
  }
});

test('/api/health returns the same explicit safe build SHA for liveness and readiness', async () => {
  const previousBuildSha = process.env.LUMIMUSE_BUILD_SHA;
  const sha = '0123456789abcdef0123456789abcdef01234567';
  process.env.LUMIMUSE_BUILD_SHA = sha.toUpperCase();
  const route = loadHealthRoute({
    '@/lib/readiness': {
      async checkReadiness() {
        return { database: true, data: true, generated: true, avatars: true, attachments: true };
      },
      isReady: checks => Object.values(checks).every(Boolean),
    },
  });

  try {
    const liveness = await route.GET(requestFor('http://test.local/api/health'));
    const readiness = await route.GET(requestFor('http://test.local/api/health?ready=1'));
    const livePayload = await liveness.json();
    const readyPayload = await readiness.json();

    assert.equal(livePayload.build, sha);
    assert.equal(readyPayload.build, sha);
    assert.equal(readyPayload.ready, true);
  } finally {
    if (previousBuildSha === undefined) delete process.env.LUMIMUSE_BUILD_SHA;
    else process.env.LUMIMUSE_BUILD_SHA = previousBuildSha;
  }
});

test('/api/health?ready=1 checks SQLite and all persistent directories for writability', async () => {
  const preparedSql = [];
  const accessed = [];
  const route = loadHealthRoute({
    '@/lib/db': {
      getDb() {
        return {
          prepare(sql) {
            preparedSql.push(sql);
            return { get: () => ({ value: 1 }) };
          },
        };
      },
    },
    'node:fs/promises': {
      async access(target, mode) {
        accessed.push({ target, mode });
      },
    },
  });

  const response = await route.GET(requestFor('http://test.local/api/health?ready=1'));
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.equal(payload.ok, true);
  assert.equal(payload.ready, true);
  assert.deepEqual(payload.checks, {
    database: true,
    data: true,
    generated: true,
    avatars: true,
    attachments: true,
  });
  assert.deepEqual(preparedSql, ['SELECT 1']);
  assert.equal(accessed.length, 4);
  assert.deepEqual(
    accessed.map(entry => path.relative(root, entry.target).split(path.sep).join('/')),
    ['data', 'public/generated', 'public/avatars', 'public/attachments'],
  );
  assert.ok(accessed.every(entry => entry.mode === fs.constants.W_OK));
});

test('/api/health?ready=1 returns a safe 503 when SQLite is unavailable', async () => {
  const secret = 'SQLITE_CANTOPEN: E:\\private\\lumimuse.db?token=secret';
  const route = loadHealthRoute({
    '@/lib/db': {
      getDb() {
        throw new Error(secret);
      },
    },
    'node:fs/promises': { access: async () => {} },
  });

  const response = await route.GET(requestFor('http://test.local/api/health?ready=1'));
  const payload = await response.json();
  const serialized = JSON.stringify(payload);

  assert.equal(response.status, 503);
  assert.equal(payload.ok, false);
  assert.equal(payload.ready, false);
  assert.equal(payload.checks.database, false);
  assert.doesNotMatch(serialized, /private|lumimuse\.db|token|secret|SQLITE_CANTOPEN/i);
});

test('/api/health?ready=1 returns a safe 503 when a persistent directory is not writable', async () => {
  const secret = 'EACCES: permission denied, access E:\\private\\generated';
  const route = loadHealthRoute({
    '@/lib/db': {
      getDb() {
        return { prepare: () => ({ get: () => ({ value: 1 }) }) };
      },
    },
    'node:fs/promises': {
      async access(target) {
        if (target.endsWith(path.join('public', 'generated'))) throw new Error(secret);
      },
    },
  });

  const response = await route.GET(requestFor('http://test.local/api/health?ready=1'));
  const payload = await response.json();
  const serialized = JSON.stringify(payload);

  assert.equal(response.status, 503);
  assert.equal(payload.ok, false);
  assert.equal(payload.ready, false);
  assert.equal(payload.checks.generated, false);
  assert.equal(payload.checks.database, true);
  assert.doesNotMatch(serialized, /private|permission denied|EACCES/i);
});

test('Docker HEALTHCHECK uses readiness rather than liveness', () => {
  const dockerfile = fs.readFileSync(path.join(root, 'Dockerfile'), 'utf8');

  assert.match(dockerfile, /\/api\/health\?ready=1/);
});
