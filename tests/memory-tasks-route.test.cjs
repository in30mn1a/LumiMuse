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

function invalidJsonRequest(url) {
  return {
    nextUrl: new URL(url),
    async json() {
      throw new SyntaxError('bad json');
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
      claim_token TEXT,
      lease_expires_at TEXT,
      started_at TEXT,
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

function addTaskPollingScopeTables(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS conversations (
      id TEXT PRIMARY KEY,
      parent_id TEXT,
      parent_seq_end INTEGER
    );
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL,
      seq INTEGER NOT NULL DEFAULT 0
    );
  `);
}

function addQueueSupportTables(db) {
  db.exec(`
    CREATE TABLE messages (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL DEFAULT 'conv-a',
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
    CREATE TABLE memory_extraction_candidates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id INTEGER,
      character_id TEXT NOT NULL,
      conversation_id TEXT,
      raw_candidate_json TEXT,
      raw_response TEXT,
      status TEXT NOT NULL,
      error_reason TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
  db.prepare("INSERT INTO characters (id, name) VALUES ('char-a', '艾莉丝')").run();
}

async function waitForTask(db, conversationId, predicate) {
  let row;
  for (let attempt = 0; attempt < 200; attempt += 1) {
    row = db.prepare('SELECT * FROM memory_tasks WHERE conversation_id = ?').get(conversationId);
    if (row && predicate(row)) return row;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  return row;
}

async function waitForNoActiveTasks(db) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const row = db.prepare(
      "SELECT COUNT(*) AS count FROM memory_tasks WHERE status IN ('pending', 'processing')"
    ).get();
    if (row.count === 0) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.fail('memory tasks did not drain');
}

function loadRoute(db, options = {}) {
  return requireFreshWithMocks('../src/app/api/memory-tasks/route.ts', {
    'next/server': jsonResponseMock(),
    '@/lib/db': { getDb: () => db },
    '@/lib/memory-queue': { enqueueExtraction: options.enqueueExtraction || (() => {}) },
    '@/types': {},
  });
}

function loadChatRoute(db, capturedEnqueues, settingsOverrides = {}) {
  return requireFreshWithMocks('../src/app/api/chat/route.ts', {
    '@/lib/db': { getDb: () => db },
    '@/lib/settings': {
      loadSettings: () => ({
        memory_trigger_interval_enabled: true,
        memory_interval: 1,
        memory_trigger_keyword_enabled: false,
        memory_trigger_time_enabled: false,
        ...settingsOverrides,
      }),
      recordClientTimezone: () => {},
    },
    '@/lib/chat-engine': {
      runChat: async (conversationId, content, settings, callbacks) => {
        await callbacks.onDone('', 0);
      },
    },
    '@/lib/memory-queue': {
      enqueueExtraction: (characterId, conversationId, messages) => {
        capturedEnqueues.push({
          characterId,
          conversationId,
          messageIds: messages.map(message => message.id),
        });
      },
    },
  });
}

function legacyChatExtractionBatch(db, conversationId, settings, now = Date.now()) {
  const messages = db.prepare(
    'SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at ASC, seq ASC'
  ).all(conversationId).map(message => ({
    ...message,
    metadata: (() => {
      try {
        const parsed = JSON.parse(message.metadata || '{}');
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
      } catch {
        return {};
      }
    })(),
  }));
  const isProcessed = message => Boolean(
    message.metadata.memory_extracted ||
    typeof message.metadata.memory_noop_extracted_at === 'string'
  );
  const unextracted = messages.filter(message => message.role === 'user' && !isProcessed(message));
  if (unextracted.length === 0) return null;

  const unextractedIds = new Set(unextracted.map(message => message.id));
  const extractionMessages = [];
  let includeNext = false;
  for (const message of messages) {
    if (message.metadata.isSummary) continue;
    if (unextractedIds.has(message.id)) {
      extractionMessages.push(message);
      includeNext = true;
    } else if (includeNext && message.role === 'assistant') {
      if (!isProcessed(message)) extractionMessages.push(message);
      includeNext = false;
    } else {
      includeNext = false;
    }
  }

  let shouldExtract = settings.memory_trigger_interval_enabled && unextracted.length >= settings.memory_interval;
  if (!shouldExtract && settings.memory_trigger_keyword_enabled && settings.memory_trigger_keywords) {
    const keywords = settings.memory_trigger_keywords.split(',').map(keyword => keyword.trim()).filter(Boolean);
    shouldExtract = keywords.some(keyword => unextracted.at(-1).content.includes(keyword));
  }
  if (!shouldExtract && settings.memory_trigger_time_enabled) {
    const lastExtracted = messages.filter(message => message.role === 'user' && isProcessed(message)).at(-1);
    const lastExtractedTime = lastExtracted ? new Date(lastExtracted.created_at).getTime() : 0;
    shouldExtract = now - lastExtractedTime >= (settings.memory_trigger_time_hours || 24) * 60 * 60 * 1000;
  }

  return shouldExtract ? extractionMessages.map(message => message.id) : null;
}

test('/api/memory-tasks GET exposes failed task diagnostics', async () => {
  const db = createMemoryTasksDb();
  addTaskPollingScopeTables(db);
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
    startedAt: null,
    isStuck: false,
    stuckMs: null,
    stuckThresholdMs: 300000,
    updatedAt: '2026-06-05T00:01:00.000Z',
  });
});

test('/api/memory-tasks GET marks long-running processing task as stuck', async () => {
  const db = createMemoryTasksDb();
  addTaskPollingScopeTables(db);
  db.prepare(`
    INSERT INTO memory_tasks (
      character_id, conversation_id, message_ids, status, merge_count,
      retry_count, error_message, started_at, created_at, updated_at
    ) VALUES (
      'char-a', 'conv-stuck', '[]', 'processing', 0,
      0, NULL, '2000-01-01T00:00:00.000Z', '2000-01-01T00:00:00.000Z', '2000-01-01T00:00:00.000Z'
    )
  `).run();

  const route = loadRoute(db);
  const response = await route.GET(request('http://test.local/api/memory-tasks?conversation_id=conv-stuck'));
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.equal(payload.status, 'processing');
  assert.equal(payload.startedAt, '2000-01-01T00:00:00.000Z');
  assert.equal(payload.isStuck, true);
  assert.equal(payload.stuckThresholdMs, 300000);
  assert.ok(payload.stuckMs >= 300000);
});

test('/api/memory-tasks GET remains compatible when diagnostic columns are absent', async () => {
  const db = createLegacyMemoryTasksDb();
  addTaskPollingScopeTables(db);
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
    startedAt: null,
    isStuck: false,
    stuckMs: null,
    stuckThresholdMs: 300000,
    updatedAt: '2026-06-05T00:01:00.000Z',
  });
});

test('/api/memory-tasks GET supports diagnostic stuck threshold override without aborting the task', async () => {
  const db = createMemoryTasksDb();
  addTaskPollingScopeTables(db);
  db.prepare(`
    INSERT INTO memory_tasks (
      character_id, conversation_id, message_ids, status, merge_count,
      retry_count, error_message, started_at, created_at, updated_at
    ) VALUES (
      'char-a', 'conv-threshold', '[]', 'processing', 0,
      0, NULL, ?, ?, ?
    )
  `).run(
    new Date(Date.now() - 50).toISOString(),
    new Date(Date.now() - 50).toISOString(),
    new Date(Date.now() - 50).toISOString(),
  );

  const route = loadRoute(db);
  const response = await route.GET(request('http://test.local/api/memory-tasks?conversation_id=conv-threshold&stuck_threshold_ms=1'));
  const payload = await response.json();
  const row = db.prepare('SELECT status FROM memory_tasks WHERE conversation_id = ?').get('conv-threshold');

  assert.equal(response.status, 200);
  assert.equal(payload.isStuck, true);
  assert.equal(payload.stuckThresholdMs, 1);
  assert.deepEqual(row, { status: 'processing' });
});

test('/api/memory-tasks GET follows the newest task intersecting the linked view', async () => {
  const db = createMemoryTasksDb();
  addTaskPollingScopeTables(db);
  db.prepare(`
    INSERT INTO conversations (id, parent_id, parent_seq_end)
    VALUES
      ('conv-parent-poll', NULL, NULL),
      ('conv-child-poll', 'conv-parent-poll', 2)
  `).run();
  db.prepare(`
    INSERT INTO messages (id, conversation_id, seq)
    VALUES
      ('shared-user-poll', 'conv-parent-poll', 1),
      ('shared-answer-poll', 'conv-parent-poll', 2),
      ('hidden-future-user-poll', 'conv-parent-poll', 3),
      ('child-user-poll', 'conv-child-poll', 3)
  `).run();

  const insertTask = db.prepare(`
    INSERT INTO memory_tasks (
      character_id, conversation_id, message_ids, status, merge_count,
      started_at, created_at, updated_at
    ) VALUES ('char-a', ?, ?, ?, ?, ?, ?, ?)
  `);
  const visibleTask = insertTask.run(
    'conv-parent-poll',
    JSON.stringify(['shared-user-poll', 'shared-answer-poll']),
    'processing',
    7,
    new Date().toISOString(),
    '2026-08-23T00:00:02.000Z',
    '2026-08-23T00:00:03.000Z',
  );
  // 让 child 的旧终态任务拥有更大的 id，证明完成后按 updated_at 跟随刚才的 parent 任务，
  // 而不是退回“当前 conversation_id 最新 id”的旧语义。
  insertTask.run(
    'conv-child-poll',
    JSON.stringify(['child-user-poll']),
    'done',
    1,
    null,
    '2026-08-23T00:00:00.000Z',
    '2026-08-23T00:00:01.000Z',
  );
  insertTask.run(
    'conv-parent-poll',
    JSON.stringify(['hidden-future-user-poll']),
    'processing',
    99,
    new Date().toISOString(),
    '2026-08-23T00:00:04.000Z',
    '2026-08-23T00:00:05.000Z',
  );

  const route = loadRoute(db);
  const processingResponse = await route.GET(request(
    'http://test.local/api/memory-tasks?conversation_id=conv-child-poll'
  ));
  const processingPayload = await processingResponse.json();
  assert.equal(processingPayload.status, 'processing');
  assert.equal(processingPayload.mergeCount, 7);

  db.prepare(`
    UPDATE memory_tasks
    SET status = 'done', updated_at = '2026-08-23T00:00:06.000Z'
    WHERE id = ?
  `).run(visibleTask.lastInsertRowid);

  const doneResponse = await route.GET(request(
    'http://test.local/api/memory-tasks?conversation_id=conv-child-poll'
  ));
  const donePayload = await doneResponse.json();
  assert.equal(donePayload.status, 'done');
  assert.equal(donePayload.mergeCount, 7);
  assert.equal(donePayload.updatedAt, '2026-08-23T00:00:06.000Z');
});

test('/api/memory-tasks POST rejects malformed JSON instead of treating it as an empty body', async () => {
  const route = loadRoute(createMemoryTasksDb());

  const response = await route.POST(invalidJsonRequest('http://test.local/api/memory-tasks'));
  const payload = await response.json();

  assert.equal(response.status, 400);
  assert.deepEqual(payload, { error: 'Invalid JSON body' });
});

test('/api/memory-tasks POST rejects non-object JSON bodies', async () => {
  const route = loadRoute(createMemoryTasksDb());

  const response = await route.POST(request('http://test.local/api/memory-tasks', null));
  const payload = await response.json();

  assert.equal(response.status, 400);
  assert.deepEqual(payload, { error: 'Invalid request body' });
});

test('/api/memory-tasks POST matches message-count semantics for non-boolean processed flags', async () => {
  const db = createMemoryTasksDb();
  addQueueSupportTables(db);
  db.exec(`
    CREATE TABLE conversations (
      id TEXT PRIMARY KEY,
      character_id TEXT NOT NULL,
      ignore_memory INTEGER NOT NULL DEFAULT 0,
      parent_id TEXT,
      parent_seq_end INTEGER
    );
  `);
  db.prepare("INSERT INTO conversations (id, character_id, ignore_memory) VALUES ('conv-bad-meta', 'char-a', 0)").run();
  db.prepare(`
    INSERT INTO messages (id, conversation_id, role, content, metadata, created_at, seq)
    VALUES ('msg-user-bad-meta', 'conv-bad-meta', 'user', '请记住这条。', ?, '2026-06-05T00:00:00.000Z', 1)
  `).run(JSON.stringify({ memory_extracted: 'true' }));

  const enqueued = [];
  const route = loadRoute(db, {
    enqueueExtraction: (characterId, conversationId, messages) => {
      enqueued.push({
        characterId,
        conversationId,
        messageIds: messages.map(message => message.id),
      });
    },
  });

  const response = await route.POST(request('http://test.local/api/memory-tasks', {
    conversation_id: 'conv-bad-meta',
  }));
  const payload = await response.json();

  assert.equal(response.status, 400);
  assert.deepEqual(payload, { error: '没有待提取的消息' });
  assert.deepEqual(enqueued, []);
});

test('/api/memory-tasks POST extracts the linked seq timeline and skips already processed inherited users', async () => {
  const db = createMemoryTasksDb();
  addQueueSupportTables(db);
  db.exec(`
    CREATE TABLE conversations (
      id TEXT PRIMARY KEY,
      character_id TEXT NOT NULL,
      ignore_memory INTEGER NOT NULL DEFAULT 0,
      parent_id TEXT,
      parent_seq_end INTEGER
    );
  `);
  db.prepare(`
    INSERT INTO conversations (id, character_id, ignore_memory, parent_id, parent_seq_end)
    VALUES
      ('conv-parent', 'char-a', 1, NULL, NULL),
      ('conv-child', 'char-a', 1, 'conv-parent', 4)
  `).run();
  db.prepare(`
    INSERT INTO messages (id, conversation_id, role, content, metadata, created_at, seq)
    VALUES
      ('parent-processed', 'conv-parent', 'user', '祖先已处理', '{"memory_noop_extracted_at":"2026-08-23T00:00:00.000Z"}', '2026-08-23T00:00:00.000Z', 1),
      ('parent-old-answer', 'conv-parent', 'assistant', '祖先旧回复', '{}', '2026-08-23T00:00:01.000Z', 2),
      ('parent-pending', 'conv-parent', 'user', '祖先待提取', '{}', '2026-08-23T00:00:02.000Z', 3),
      ('parent-answer', 'conv-parent', 'assistant', '祖先回复', '{}', '2026-08-23T00:00:10.000Z', 4),
      ('child-pending', 'conv-child', 'user', '子对话待提取', '{}', '2026-08-23T00:00:04.000Z', 5),
      ('child-answer', 'conv-child', 'assistant', '子对话回复', '{}', '2026-08-23T00:00:05.000Z', 6)
  `).run();

  const enqueued = [];
  const route = loadRoute(db, {
    enqueueExtraction: (characterId, conversationId, messages) => {
      enqueued.push({ characterId, conversationId, messageIds: messages.map(message => message.id) });
    },
  });

  const response = await route.POST(request('http://test.local/api/memory-tasks', {
    conversation_id: 'conv-child',
  }));

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, messageCount: 4 });
  assert.deepEqual(enqueued, [{
    characterId: 'char-a',
    conversationId: 'conv-child',
    messageIds: ['parent-pending', 'parent-answer', 'child-pending', 'child-answer'],
  }]);
});

test('memory-queue removes active-task message IDs across linked views and deduplicates the input batch', async () => {
  const db = createMemoryTasksDb();
  addQueueSupportTables(db);
  db.prepare(`
    INSERT INTO messages (id, conversation_id, role, content, metadata, created_at, seq)
    VALUES
      ('shared-user', 'conv-parent-view', 'user', '共享消息', '{}', '2026-08-23T00:00:00.000Z', 1),
      ('shared-answer', 'conv-parent-view', 'assistant', '共享回复', '{}', '2026-08-23T00:00:01.000Z', 2),
      ('child-user', 'conv-child-view', 'user', '子对话消息', '{}', '2026-08-23T00:00:02.000Z', 3),
      ('child-answer', 'conv-child-view', 'assistant', '子对话回复', '{}', '2026-08-23T00:00:03.000Z', 4)
  `).run();
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO memory_tasks (
      character_id, conversation_id, message_ids, status, created_at, updated_at
    ) VALUES ('char-a', 'conv-parent-view', ?, 'pending', ?, ?)
  `).run(JSON.stringify(['shared-user']), now, now);

  const queue = requireFreshWithMocks('../src/lib/memory-queue.ts', {
    '@/lib/db': { getDb: () => db },
    '@/lib/settings': { loadSettings: () => ({}) },
    '@/lib/memory-engine': {
      getCommittedExtractionResult: () => null,
      extractMemories: async () => ({ insertCount: 0, mergeCount: 0 }),
    },
    '@/lib/memory-profile': {
      enqueueMemoryProfilePatchExtraction: () => {},
      triggerMemoryProfileQueue: () => {},
    },
  });

  queue.enqueueExtraction('char-a', 'conv-child-view', [
    { id: 'shared-user', role: 'user' },
    { id: 'shared-answer', role: 'assistant' },
    { id: 'child-user', role: 'user' },
    { id: 'child-answer', role: 'assistant' },
    { id: 'child-user', role: 'user' },
  ]);

  const childTask = db.prepare(
    'SELECT message_ids FROM memory_tasks WHERE conversation_id = ? ORDER BY id DESC LIMIT 1'
  ).get('conv-child-view');
  assert.deepEqual(JSON.parse(childTask.message_ids), ['child-user', 'child-answer']);
  await waitForNoActiveTasks(db);
});

test('memory-queue keeps new message IDs when the same conversation already has an active task', async () => {
  const db = createMemoryTasksDb();
  addQueueSupportTables(db);
  db.prepare(`
    INSERT INTO messages (id, conversation_id, role, content, metadata, created_at, seq)
    VALUES
      ('blocker-user', 'conv-blocker', 'user', '阻塞任务', '{}', '2026-08-23T00:00:00.000Z', 1),
      ('old-user', 'conv-same', 'user', '旧任务消息', '{}', '2026-08-23T00:00:01.000Z', 2),
      ('old-answer', 'conv-same', 'assistant', '旧任务回复', '{}', '2026-08-23T00:00:02.000Z', 3),
      ('new-user', 'conv-same', 'user', '新任务消息', '{}', '2026-08-23T00:00:03.000Z', 4),
      ('new-answer', 'conv-same', 'assistant', '新任务回复', '{}', '2026-08-23T00:00:04.000Z', 5)
  `).run();
  const now = new Date().toISOString();
  const insertTask = db.prepare(`
    INSERT INTO memory_tasks (
      character_id, conversation_id, message_ids, status, created_at, updated_at
    ) VALUES ('char-a', ?, ?, 'pending', ?, ?)
  `);
  insertTask.run('conv-blocker', JSON.stringify(['blocker-user']), now, now);
  insertTask.run('conv-same', JSON.stringify(['old-user']), now, now);

  let releaseBlocker;
  const queue = requireFreshWithMocks('../src/lib/memory-queue.ts', {
    '@/lib/db': { getDb: () => db },
    '@/lib/settings': { loadSettings: () => ({}) },
    '@/lib/memory-engine': {
      getCommittedExtractionResult: () => null,
      extractMemories: async (_characterId, _text, _settings, options) => {
        if (options.conversationId === 'conv-blocker') {
          return new Promise(resolve => {
            releaseBlocker = () => resolve({ insertCount: 0, mergeCount: 0 });
          });
        }
        return { insertCount: 0, mergeCount: 0 };
      },
    },
    '@/lib/memory-profile': {
      enqueueMemoryProfilePatchExtraction: () => {},
      triggerMemoryProfileQueue: () => {},
    },
  });

  queue.enqueueExtraction('char-a', 'conv-same', [
    { id: 'old-user', role: 'user' },
    { id: 'old-answer', role: 'assistant' },
    { id: 'new-user', role: 'user' },
    { id: 'new-answer', role: 'assistant' },
  ]);

  const sameConversationTasks = db.prepare(
    'SELECT message_ids FROM memory_tasks WHERE conversation_id = ? ORDER BY id ASC'
  ).all('conv-same');
  assert.deepEqual(sameConversationTasks.map(row => JSON.parse(row.message_ids)), [
    ['old-user'],
    ['new-user', 'new-answer'],
  ]);

  releaseBlocker?.();
  await waitForNoActiveTasks(db);
});

test('memory-queue rechecks processed user metadata inside enqueue and skips its assistant group', () => {
  const db = createMemoryTasksDb();
  addQueueSupportTables(db);
  db.prepare(`
    INSERT INTO messages (id, conversation_id, role, content, metadata, created_at, seq)
    VALUES
      ('raced-user', 'conv-race', 'user', '路由读取后已被另一任务处理', '{"memory_extracted":true}', '2026-08-23T00:00:00.000Z', 1),
      ('raced-answer', 'conv-race', 'assistant', '不应形成孤立任务', '{}', '2026-08-23T00:00:01.000Z', 2)
  `).run();

  const queue = requireFreshWithMocks('../src/lib/memory-queue.ts', {
    '@/lib/db': { getDb: () => db },
    '@/lib/settings': { loadSettings: () => ({}) },
    '@/lib/memory-engine': {
      getCommittedExtractionResult: () => null,
      extractMemories: async () => ({ insertCount: 0, mergeCount: 0 }),
    },
    '@/lib/memory-profile': {
      enqueueMemoryProfilePatchExtraction: () => {},
      triggerMemoryProfileQueue: () => {},
    },
  });

  queue.enqueueExtraction('char-a', 'conv-race', [
    { id: 'raced-user', role: 'user' },
    { id: 'raced-answer', role: 'assistant' },
  ]);

  assert.equal(
    db.prepare('SELECT COUNT(*) AS count FROM memory_tasks').get().count,
    0,
  );
});

test('memory-queue preserves and processes more than 1000 user-assistant groups without SQL parameter caps', async () => {
  const db = createMemoryTasksDb();
  addQueueSupportTables(db);
  const inputMessages = [];
  const insertMessage = db.prepare(`
    INSERT INTO messages (id, conversation_id, role, content, metadata, created_at, seq)
    VALUES (?, 'conv-large-batch', ?, ?, '{}', ?, ?)
  `);
  db.transaction(() => {
    for (let index = 0; index < 1001; index += 1) {
      const userId = `large-user-${index}`;
      const assistantId = `large-answer-${index}`;
      insertMessage.run(
        userId,
        'user',
        `用户消息 ${index}`,
        '2026-08-23T00:00:00.000Z',
        index * 2 + 1,
      );
      insertMessage.run(
        assistantId,
        'assistant',
        `角色回复 ${index}`,
        '2026-08-23T00:00:00.000Z',
        index * 2 + 2,
      );
      inputMessages.push(
        { id: userId, role: 'user' },
        { id: assistantId, role: 'assistant' },
      );
    }
  })();

  let capturedMessageIds = [];
  const queue = requireFreshWithMocks('../src/lib/memory-queue.ts', {
    '@/lib/db': { getDb: () => db },
    '@/lib/settings': { loadSettings: () => ({ client_timezone: 'UTC' }) },
    '@/lib/memory-engine': {
      getCommittedExtractionResult: () => null,
      extractMemories: async (_characterId, _text, _settings, options) => {
        capturedMessageIds = options.messageIds;
        return { insertCount: 0, mergeCount: 0 };
      },
    },
    '@/lib/memory-profile': {
      enqueueMemoryProfilePatchExtraction: () => {},
      triggerMemoryProfileQueue: () => {},
    },
  });

  queue.enqueueExtraction('char-a', 'conv-large-batch', inputMessages);

  const doneTask = await waitForTask(
    db,
    'conv-large-batch',
    task => task.status === 'done',
  );
  const storedMessageIds = JSON.parse(doneTask.message_ids);
  assert.equal(storedMessageIds.length, 2002);
  assert.deepEqual(storedMessageIds.slice(0, 2), ['large-user-0', 'large-answer-0']);
  assert.deepEqual(storedMessageIds.slice(-2), ['large-user-1000', 'large-answer-1000']);
  assert.equal(capturedMessageIds.length, 2002);
  assert.equal(
    typeof JSON.parse(db.prepare(
      "SELECT metadata FROM messages WHERE id = 'large-user-1000'"
    ).get().metadata).memory_noop_extracted_at,
    'string',
  );
});

test('memory-queue stores retry count and error message when extraction fails', async () => {
  const db = createMemoryTasksDb();
  addQueueSupportTables(db);
  db.prepare(`
    INSERT INTO messages (id, conversation_id, role, content, metadata, created_at, seq)
    VALUES ('msg-user-fail', 'conv-fail', 'user', '请记住这件事。', '{}', '2026-06-05T00:00:00.000Z', 1)
  `).run();

  const queue = requireFreshWithMocks('../src/lib/memory-queue.ts', {
    '@/lib/db': { getDb: () => db },
    '@/lib/settings': { loadSettings: () => ({}) },
    '@/lib/memory-engine': {
      getCommittedExtractionResult: () => null,
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

  const row = await waitForTask(db, 'conv-fail', task => task.status === 'failed');

  assert.deepEqual({
    status: row.status,
    retry_count: row.retry_count,
    error_message: row.error_message,
  }, {
    status: 'failed',
    retry_count: 1,
    error_message: 'LLM 返回了无法解析的记忆 JSON',
  });
});

test('memory-queue records started_at while a background extraction is processing without aborting it', async () => {
  const db = createMemoryTasksDb();
  addQueueSupportTables(db);
  addTaskPollingScopeTables(db);
  db.prepare(`
    INSERT INTO messages (id, conversation_id, role, content, metadata, created_at, seq)
    VALUES ('msg-user-slow', 'conv-slow', 'user', '这是一段足够长的内容，用来模拟后台记忆提取请求一直等待上游返回。', '{}', '2026-06-05T00:00:00.000Z', 1)
  `).run();

  let releaseExtraction;
  const queue = requireFreshWithMocks('../src/lib/memory-queue.ts', {
    '@/lib/db': { getDb: () => db },
    '@/lib/settings': { loadSettings: () => ({}) },
    '@/lib/memory-engine': {
      getCommittedExtractionResult: () => null,
      extractMemories: async () => new Promise(resolve => {
        releaseExtraction = () => resolve({ insertCount: 0, mergeCount: 0 });
      }),
    },
    '@/lib/memory-profile': {
      enqueueMemoryProfilePatchExtraction: () => {},
      triggerMemoryProfileQueue: () => {},
    },
  });

  queue.enqueueExtraction('char-a', 'conv-slow', [{ id: 'msg-user-slow' }]);
  const processingRow = await waitForTask(db, 'conv-slow', task => task.status === 'processing' && task.started_at);

  assert.equal(processingRow.status, 'processing');
  assert.match(processingRow.started_at, /^\d{4}-\d{2}-\d{2}T/);

  db.prepare("UPDATE memory_tasks SET started_at = '2000-01-01T00:00:00.000Z' WHERE conversation_id = 'conv-slow'").run();
  const route = loadRoute(db);
  const response = await route.GET(request('http://test.local/api/memory-tasks?conversation_id=conv-slow'));
  const payload = await response.json();
  const stillProcessing = db.prepare('SELECT status FROM memory_tasks WHERE conversation_id = ?').get('conv-slow');

  assert.equal(payload.isStuck, true);
  assert.deepEqual(stillProcessing, { status: 'processing' });

  releaseExtraction();
  const doneRow = await waitForTask(db, 'conv-slow', task => task.status === 'done');
  assert.equal(doneRow.status, 'done');
});

test('memory-queue clears in-flight conversation when marking a task processing fails', async () => {
  const db = createMemoryTasksDb();
  addQueueSupportTables(db);
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO messages (id, conversation_id, role, content, metadata, created_at, seq)
    VALUES ('msg-user-processing-fail', 'conv-processing-fail', 'user', '请记住这条需要重试的消息。', '{}', '2026-06-05T00:00:00.000Z', 1)
  `).run();
  db.prepare(`
    INSERT INTO memory_tasks (
      character_id, conversation_id, message_ids, status,
      created_at, updated_at
    ) VALUES (
      'char-a', 'conv-processing-fail', ?, 'pending',
      ?, ?
    )
  `).run(JSON.stringify(['msg-user-processing-fail']), now, now);

  let failProcessingUpdate = true;
  const dbWithFailingProcessingUpdate = {
    prepare(sql) {
      const statement = db.prepare(sql);
      // DbTaskQueue claim 写入 status=processing + claim_token + lease_expires_at
      if (
        sql.includes('UPDATE "memory_tasks"')
        && sql.includes("status = 'processing'")
        && sql.includes('claim_token')
      ) {
        return {
          run(...args) {
            if (failProcessingUpdate) {
              failProcessingUpdate = false;
              throw new Error('processing update failed');
            }
            return statement.run(...args);
          },
        };
      }
      return statement;
    },
    transaction(fn) {
      return db.transaction(fn);
    },
  };
  const queue = requireFreshWithMocks('../src/lib/memory-queue.ts', {
    '@/lib/db': { getDb: () => dbWithFailingProcessingUpdate },
    '@/lib/settings': { loadSettings: () => ({}) },
    '@/lib/memory-engine': {
      getCommittedExtractionResult: () => null,
      extractMemories: async () => ({ insertCount: 0, mergeCount: 0 }),
    },
    '@/lib/memory-profile': {
      enqueueMemoryProfilePatchExtraction: () => {},
      triggerMemoryProfileQueue: () => {},
    },
  });

  await assert.rejects(queue.__processQueueForTest(), /processing update failed/);
  assert.equal(
    db.prepare('SELECT status FROM memory_tasks WHERE conversation_id = ?').get('conv-processing-fail').status,
    'pending',
  );

  await queue.__processQueueForTest();

  const row = await waitForTask(db, 'conv-processing-fail', task => task.status === 'done');
  assert.equal(row.status, 'done');
});

test('memory-queue marks successful no-value extraction as processed noop metadata', async () => {
  const db = createMemoryTasksDb();
  addQueueSupportTables(db);
  db.prepare(`
    INSERT INTO messages (id, conversation_id, role, content, metadata, created_at, seq)
    VALUES
      ('msg-user-noop', 'conv-noop', 'user', '今天只是普通闲聊，没有什么长期价值，但内容长度足够触发提取。', '{}', '2026-06-05T00:00:00.000Z', 1),
      ('msg-assistant-noop', 'conv-noop', 'assistant', '好的，我们就轻松聊聊。', '{}', '2026-06-05T00:00:01.000Z', 2)
  `).run();

  const queue = requireFreshWithMocks('../src/lib/memory-queue.ts', {
    '@/lib/db': { getDb: () => db },
    '@/lib/settings': { loadSettings: () => ({}) },
    '@/lib/memory-engine': {
      getCommittedExtractionResult: () => null,
      extractMemories: async () => ({ insertCount: 0, mergeCount: 0 }),
    },
    '@/lib/memory-profile': {
      enqueueMemoryProfilePatchExtraction: () => {},
      triggerMemoryProfileQueue: () => {},
    },
  });

  queue.enqueueExtraction('char-a', 'conv-noop', [{ id: 'msg-user-noop' }, { id: 'msg-assistant-noop' }]);

  const row = await waitForTask(db, 'conv-noop', task => task.status === 'done');
  const message = db.prepare('SELECT metadata FROM messages WHERE id = ?').get('msg-user-noop');
  const metadata = JSON.parse(message.metadata);

  assert.equal(row.status, 'done');
  assert.equal(metadata.memory_extracted, true);
  assert.match(metadata.memory_noop_extracted_at, /^\d{4}-\d{2}-\d{2}T/);
});

test('memory-queue keeps parse failures retryable instead of marking noop metadata', async () => {
  const db = createMemoryTasksDb();
  addQueueSupportTables(db);
  db.prepare(`
    INSERT INTO messages (id, conversation_id, role, content, metadata, created_at, seq)
    VALUES ('msg-user-parse-fail', 'conv-parse-fail', 'user', '请记住这件事，但模型会返回损坏 JSON。', '{}', '2026-06-05T00:00:00.000Z', 1)
  `).run();

  const queue = requireFreshWithMocks('../src/lib/memory-queue.ts', {
    '@/lib/db': { getDb: () => db },
    '@/lib/settings': { loadSettings: () => ({}) },
    '@/lib/memory-engine': {
      getCommittedExtractionResult: () => null,
      extractMemories: async (characterId, conversationText, settings, options) => {
        const now = new Date().toISOString();
        db.prepare(`
          INSERT INTO memory_extraction_candidates (
            task_id, character_id, conversation_id, raw_response,
            status, error_reason, created_at, updated_at
          ) VALUES (?, ?, ?, ?, 'repairable', 'parse_or_no_valid_memory', ?, ?)
        `).run(options.taskId, characterId, options.conversationId, 'not json', now, now);
        return { insertCount: 0, mergeCount: 0 };
      },
    },
    '@/lib/memory-profile': {
      enqueueMemoryProfilePatchExtraction: () => {},
      triggerMemoryProfileQueue: () => {},
    },
  });

  queue.enqueueExtraction('char-a', 'conv-parse-fail', [{ id: 'msg-user-parse-fail' }]);

  const row = await waitForTask(db, 'conv-parse-fail', task => task.status === 'failed');
  const message = db.prepare('SELECT metadata FROM messages WHERE id = ?').get('msg-user-parse-fail');

  assert.equal(row.retry_count, 1);
  assert.match(row.error_message, /repairable/i);
  assert.deepEqual(JSON.parse(message.metadata), {});
});

test('chat route skips noop processed old messages when rebuilding extraction batch', async () => {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE conversations (
      id TEXT PRIMARY KEY,
      character_id TEXT NOT NULL,
      ignore_memory INTEGER NOT NULL DEFAULT 0,
      parent_id TEXT,
      parent_seq_end INTEGER
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
  `);
  db.prepare("INSERT INTO conversations (id, character_id, ignore_memory) VALUES ('conv-chat-noop', 'char-a', 0)").run();
  db.prepare(`
    INSERT INTO messages (id, conversation_id, role, content, metadata, created_at, seq)
    VALUES
      ('msg-user-old-noop', 'conv-chat-noop', 'user', '普通闲聊旧消息。', '{"memory_noop_extracted_at":"2026-06-05T00:01:00.000Z"}', '2026-06-05T00:00:00.000Z', 1),
      ('msg-assistant-old-noop', 'conv-chat-noop', 'assistant', '旧回复。', '{}', '2026-06-05T00:00:01.000Z', 2),
      ('msg-user-new', 'conv-chat-noop', 'user', '这是一条新消息，应该单独入队。', '{}', '2026-06-05T00:02:00.000Z', 3),
      ('msg-assistant-new', 'conv-chat-noop', 'assistant', '新回复。', '{}', '2026-06-05T00:02:01.000Z', 4)
  `).run();

  const capturedEnqueues = [];
  const route = loadChatRoute(db, capturedEnqueues);
  const abort = new AbortController();
  const response = await route.POST({
    signal: abort.signal,
    async json() {
      return {
        conversation_id: 'conv-chat-noop',
        content: '触发记忆提取',
      };
    },
  });

  await response.text();

  assert.deepEqual(capturedEnqueues, [{
    characterId: 'char-a',
    conversationId: 'conv-chat-noop',
    messageIds: ['msg-user-new', 'msg-assistant-new'],
  }]);
});

test('chat route evaluates and enqueues the whole linked view when the current conversation allows extraction', async () => {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE conversations (
      id TEXT PRIMARY KEY,
      character_id TEXT NOT NULL,
      ignore_memory INTEGER NOT NULL DEFAULT 0,
      parent_id TEXT,
      parent_seq_end INTEGER
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
  `);
  db.prepare(`
    INSERT INTO conversations (id, character_id, ignore_memory, parent_id, parent_seq_end)
    VALUES
      ('conv-parent-auto', 'char-a', 1, NULL, NULL),
      ('conv-child-auto', 'char-a', 0, 'conv-parent-auto', 2)
  `).run();
  db.prepare(`
    INSERT INTO messages (id, conversation_id, role, content, metadata, created_at, seq)
    VALUES
      ('parent-user-auto', 'conv-parent-auto', 'user', '祖先待提取', '{}', '2026-08-23T00:00:00.000Z', 1),
      ('parent-answer-auto', 'conv-parent-auto', 'assistant', '祖先回复', '{}', '2026-08-23T00:00:01.000Z', 2),
      ('child-user-auto', 'conv-child-auto', 'user', '子对话待提取', '{}', '2026-08-23T00:00:02.000Z', 3),
      ('child-answer-auto', 'conv-child-auto', 'assistant', '子对话回复', '{}', '2026-08-23T00:00:03.000Z', 4)
  `).run();

  const capturedEnqueues = [];
  const route = loadChatRoute(db, capturedEnqueues);
  const response = await route.POST({
    signal: new AbortController().signal,
    async json() {
      return { conversation_id: 'conv-child-auto', content: '触发记忆提取' };
    },
  });
  await response.text();

  assert.deepEqual(capturedEnqueues, [{
    characterId: 'char-a',
    conversationId: 'conv-child-auto',
    messageIds: ['parent-user-auto', 'parent-answer-auto', 'child-user-auto', 'child-answer-auto'],
  }]);
});

test('chat time trigger chooses the latest processed linked message by seq instead of created_at', async () => {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE conversations (
      id TEXT PRIMARY KEY,
      character_id TEXT NOT NULL,
      ignore_memory INTEGER NOT NULL DEFAULT 0,
      parent_id TEXT,
      parent_seq_end INTEGER
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
    INSERT INTO conversations (id, character_id, ignore_memory, parent_id, parent_seq_end)
    VALUES
      ('conv-parent-time', 'char-a', 1, NULL, NULL),
      ('conv-child-time', 'char-a', 0, 'conv-parent-time', 2);
    INSERT INTO messages (id, conversation_id, role, content, metadata, created_at, seq)
    VALUES
      ('parent-processed-future', 'conv-parent-time', 'user', '较早序号但未来时间', '{"memory_extracted":true}', '2999-01-01T00:00:00.000Z', 1),
      ('parent-processed-answer', 'conv-parent-time', 'assistant', '祖先回复', '{}', '2999-01-01T00:00:01.000Z', 2),
      ('child-processed-old', 'conv-child-time', 'user', '较晚序号但旧时间', '{"memory_extracted":true}', '2000-01-01T00:00:00.000Z', 3),
      ('child-processed-answer', 'conv-child-time', 'assistant', '子对话旧回复', '{}', '2000-01-01T00:00:01.000Z', 4),
      ('child-pending-time', 'conv-child-time', 'user', '待提取消息', '{}', '2000-01-01T00:00:02.000Z', 5),
      ('child-pending-answer', 'conv-child-time', 'assistant', '待提取回复', '{}', '2000-01-01T00:00:03.000Z', 6);
  `);

  const capturedEnqueues = [];
  const route = loadChatRoute(db, capturedEnqueues, {
    memory_trigger_interval_enabled: false,
    memory_interval: 99,
    memory_trigger_keyword_enabled: false,
    memory_trigger_time_enabled: true,
    memory_trigger_time_hours: 1,
  });
  const response = await route.POST({
    signal: new AbortController().signal,
    async json() {
      return { conversation_id: 'conv-child-time', content: '触发按时间提取' };
    },
  });
  await response.text();

  assert.deepEqual(capturedEnqueues, [{
    characterId: 'char-a',
    conversationId: 'conv-child-time',
    messageIds: ['child-pending-time', 'child-pending-answer'],
  }]);
});

test('chat route suffix query preserves the legacy memory trigger and extraction batch semantics', async () => {
  const scenarios = [
    {
      name: 'interval',
      settings: {
        memory_trigger_interval_enabled: true,
        memory_interval: 2,
        memory_trigger_keyword_enabled: false,
        memory_trigger_time_enabled: false,
      },
    },
    {
      name: 'keyword',
      settings: {
        memory_trigger_interval_enabled: false,
        memory_interval: 99,
        memory_trigger_keyword_enabled: true,
        memory_trigger_keywords: '晚安,记住',
        memory_trigger_time_enabled: false,
      },
    },
    {
      name: 'time',
      settings: {
        memory_trigger_interval_enabled: false,
        memory_interval: 99,
        memory_trigger_keyword_enabled: false,
        memory_trigger_time_enabled: true,
        memory_trigger_time_hours: 1,
      },
    },
    {
      name: 'disabled',
      settings: {
        memory_trigger_interval_enabled: false,
        memory_interval: 99,
        memory_trigger_keyword_enabled: true,
        memory_trigger_keywords: '不存在的关键词',
        memory_trigger_time_enabled: false,
      },
    },
  ];

  for (const scenario of scenarios) {
    const db = new Database(':memory:');
    db.exec(`
      CREATE TABLE conversations (
        id TEXT PRIMARY KEY,
        character_id TEXT NOT NULL,
        ignore_memory INTEGER NOT NULL DEFAULT 0,
        parent_id TEXT,
        parent_seq_end INTEGER
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
    `);
    db.prepare('INSERT INTO conversations (id, character_id, ignore_memory) VALUES (?, ?, 0)')
      .run(`conv-${scenario.name}`, 'char-a');
    const insert = db.prepare(`
      INSERT INTO messages (id, conversation_id, role, content, metadata, created_at, seq)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    const conversationId = `conv-${scenario.name}`;
    const rows = [
      ['processed-user', 'user', '已经处理的旧消息', '{"memory_extracted":true}', '2000-01-01T00:00:00.000Z', 20],
      ['processed-assistant', 'assistant', '旧回复', '{}', '2000-01-01T00:00:01.000Z', 21],
      ['malformed-pending-user', 'user', '损坏 metadata 仍应视为待处理', '{bad', '2000-01-01T00:01:00.000Z', 40],
      ['malformed-pending-assistant', 'assistant', '损坏 metadata 用户的紧邻回复', '{}', '2000-01-01T00:01:01.000Z', 41],
      ['pending-user-1', 'user', '第一条待处理消息', '{}', '2000-01-01T00:02:00.000Z', 50],
      ['pending-assistant-1', 'assistant', '第一条紧邻回复', '{}', '2000-01-01T00:02:01.000Z', 2],
      ['summary', 'system', '摘要', '{"isSummary":true}', '2000-01-01T00:03:00.000Z', 60],
      ['pending-user-2', 'user', '第二条待处理消息，晚安', '{}', '2000-01-01T00:04:00.000Z', 3],
      ['processed-assistant-2', 'assistant', '已经处理的回复', '{"memory_extracted":true}', '2000-01-01T00:04:01.000Z', 70],
    ];
    for (const [id, role, content, metadata, createdAt, seq] of rows) {
      insert.run(id, conversationId, role, content, metadata, createdAt, seq);
    }

    const expectedIds = legacyChatExtractionBatch(db, conversationId, scenario.settings);
    const preparedSql = [];
    const tracedDb = new Proxy(db, {
      get(target, property) {
        if (property === 'prepare') {
          return sql => {
            preparedSql.push(sql.replace(/\s+/g, ' ').trim());
            return target.prepare(sql);
          };
        }
        const value = target[property];
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const capturedEnqueues = [];
    const route = loadChatRoute(tracedDb, capturedEnqueues, scenario.settings);
    const response = await route.POST({
      signal: new AbortController().signal,
      async json() {
        return { conversation_id: conversationId, content: '触发判定' };
      },
    });
    await response.text();

    assert.deepEqual(
      capturedEnqueues.map(entry => entry.messageIds),
      expectedIds ? [expectedIds] : [],
      `${scenario.name} trigger/batch must match the legacy full-read algorithm`,
    );
    assert.equal(
      preparedSql.some(sql => sql === 'SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at ASC, seq ASC'),
      false,
      `${scenario.name} must not read the entire conversation`,
    );
  }
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
  assert.ok(columns.includes('claim_token'));
  assert.ok(columns.includes('lease_expires_at'));
  assert.ok(columns.includes('started_at'));
  assert.ok(columns.includes('result_committed'));
  assert.ok(columns.includes('result_insert_count'));
  assert.ok(columns.includes('result_merge_count'));
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
    INSERT INTO memory_tasks (
      character_id, conversation_id, message_ids, status, merge_count,
      created_at, updated_at
    ) VALUES (
      'char-a', 'conv-old-processing', '[]', 'processing', 0,
      '2026-06-05T00:00:00.000Z', '2026-06-05T00:01:00.000Z'
    );
  `);
  legacyDb.close();

  const db = loadRealDbInTempDir(tempDir);
  const columns = db.prepare("PRAGMA table_info(memory_tasks)").all().map(column => column.name);
  const row = db.prepare('SELECT started_at FROM memory_tasks WHERE conversation_id = ?').get('conv-old-processing');
  db.close();

  assert.ok(columns.includes('retry_count'));
  assert.ok(columns.includes('error_message'));
  assert.ok(columns.includes('claim_token'));
  assert.ok(columns.includes('lease_expires_at'));
  assert.ok(columns.includes('started_at'));
  assert.ok(columns.includes('result_committed'));
  assert.ok(columns.includes('result_insert_count'));
  assert.ok(columns.includes('result_merge_count'));
  assert.equal(row.started_at, '2026-06-05T00:01:00.000Z');
});

test('memory-queue keeps legacy task rows usable when diagnostic columns are absent', async () => {
  // 旧库可无 retry_count/error_message/started_at，但 claim/lease 列由 migrate 保证存在；
  // 此处模拟「有 claim 列、无部分诊断列」的最小可用表。
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE memory_tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      character_id TEXT NOT NULL,
      conversation_id TEXT NOT NULL,
      message_ids TEXT NOT NULL DEFAULT '[]',
      status TEXT NOT NULL DEFAULT 'pending',
      merge_count INTEGER NOT NULL DEFAULT 0,
      claim_token TEXT,
      lease_expires_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
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
      getCommittedExtractionResult: () => null,
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
  for (let attempt = 0; attempt < 50; attempt += 1) {
    row = db.prepare('SELECT status FROM memory_tasks WHERE conversation_id = ?').get('conv-legacy-fail');
    if (row?.status === 'failed') break;
    await new Promise(resolve => setTimeout(resolve, 10));
  }

  assert.deepEqual(row, { status: 'failed' });
});

test('memory task polling surfaces failed diagnostics in toast text', () => {
  const source = fs.readFileSync(path.join(root, 'src/hooks/chat/useMemoryTaskPolling.ts'), 'utf8');
  const chatView = fs.readFileSync(path.join(root, 'src/components/chat/ChatView.tsx'), 'utf8');
  const i18n = fs.readFileSync(path.join(root, 'src/lib/i18n.ts'), 'utf8');

  assert.match(source, /errorMessage\??:/);
  assert.match(source, /retryCount\??:/);
  assert.match(source, /errorMessage\?\.trim\(\)/);
  assert.match(source, /retryCount > 0/);
  assert.match(source, /formatTemplate\(t\('chat\.memoryExtractFailedDetail'\)/);
  assert.match(source, /showToast\([^;]*memoryExtractFailedDetail[^;]*'error'\);/s);
  assert.match(chatView, /useMemoryTaskPolling\(/);
  assert.match(chatView, /pollMemoryTask/);
  assert.match(i18n, /'chat\.memoryExtractFailedDetail'/);
});
