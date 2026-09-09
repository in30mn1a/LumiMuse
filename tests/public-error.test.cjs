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
    signal: new AbortController().signal,
    async json() {
      return body;
    },
  };
}

function withSilencedConsoleError(callback) {
  const originalError = console.error;
  console.error = () => {};
  try {
    return callback();
  } finally {
    console.error = originalError;
  }
}

function requirePublicError() {
  return require('../src/lib/public-error.ts');
}

// ── helper 单元行为 ───────────────────────────────────────────

test('publicErrorMessage redacts real SqliteError messages (SQL text and db paths)', () => {
  const { publicErrorMessage } = requirePublicError();
  const db = new Database(':memory:');
  let thrown = null;
  try {
    db.prepare('SELECT * FROM definitely_missing_table WHERE path = ?').get('data/lumimuse.db');
  } catch (error) {
    thrown = error;
  }
  assert.ok(thrown, 'SQLite 查询应抛出异常');
  assert.equal(thrown.name, 'SqliteError');

  const message = withSilencedConsoleError(() => publicErrorMessage(thrown, '总结失败'));
  assert.equal(message, '总结失败');
  assert.doesNotMatch(message, /SqliteError|definitely_missing_table|lumimuse\.db/);
});

test('publicErrorMessage redacts Node system errors (fs paths) and non-Error values', () => {
  const { publicErrorMessage } = requirePublicError();
  const fsError = new Error("ENOENT: no such file or directory, open 'E:\\secret\\lumimuse\\public\\avatars\\x.png'");
  fsError.code = 'ENOENT';

  const fsMessage = withSilencedConsoleError(() => publicErrorMessage(fsError, '生图失败'));
  assert.equal(fsMessage, '生图失败');
  assert.doesNotMatch(fsMessage, /ENOENT|avatars|secret/);

  const nonErrorMessage = withSilencedConsoleError(() => publicErrorMessage({ leak: 'raw object' }, '失败'));
  assert.equal(nonErrorMessage, '失败');

  const undefinedMessage = withSilencedConsoleError(() => publicErrorMessage(undefined, '失败'));
  assert.equal(undefinedMessage, '失败');
});

test('publicErrorMessage passes through business validation and sanitized upstream errors', () => {
  const { publicErrorMessage } = requirePublicError();

  // 业务校验文案：普通 Error、无系统级 code
  assert.equal(
    publicErrorMessage(new Error('Only active memories can be merged'), 'fallback'),
    'Only active memories can be merged',
  );

  // 上游 LLM 错误：api-client 抛出前已过 sanitizeUpstreamError（脱敏 + 200 字符截断）
  const { sanitizeUpstreamError } = require('../src/lib/api-client.ts');
  const upstream = new Error(`API error 401: ${sanitizeUpstreamError('invalid api_key sk-1234567890abcdef')}`);
  const message = publicErrorMessage(upstream, 'fallback');
  assert.match(message, /API error 401/);
  assert.doesNotMatch(message, /sk-1234567890abcdef/);
});

// ── route 层回归：DB 异常不再直通响应体 ───────────────────────

// summarize route：完整表结构 + 固定 UUID（crypto mock）让总结消息 INSERT
// 撞主键约束，事务内抛 SqliteError，验证 catch 收口。
test('/api/summarize 500 body contains no SqliteError / db path when db throws', async () => {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE conversations (id TEXT PRIMARY KEY, character_id TEXT, title TEXT, parent_id TEXT, parent_seq_end INTEGER);
    CREATE TABLE characters (id TEXT PRIMARY KEY, name TEXT, basic_info TEXT, personality TEXT, scenario TEXT, other_info TEXT);
    CREATE TABLE messages (
      id TEXT PRIMARY KEY, conversation_id TEXT, role TEXT, content TEXT,
      token_count INTEGER, created_at TEXT, seq INTEGER, metadata TEXT
    );
    INSERT INTO conversations VALUES ('conv-err', 'char-err', 't', NULL, NULL);
    INSERT INTO characters VALUES ('char-err', 'A', NULL, NULL, NULL, NULL);
    INSERT INTO messages VALUES ('dup-summary', 'conv-err', 'user', 'hello', 5, '2026-09-09T00:00:00.000Z', 1, '{}');
    INSERT INTO messages VALUES ('m2', 'conv-err', 'assistant', 'hi', 5, '2026-09-09T00:00:01.000Z', 2, '{}');
  `);

  const route = requireFreshWithMocks('../src/app/api/summarize/route.ts', {
    'next/server': jsonResponseMock(),
    '@/lib/db': { getDb: () => db, ensureMemoryProfileTables: () => {} },
    '@/lib/settings': {
      loadSettings() {
        return {};
      },
      resolveBackgroundConfig() {
        return { api_base: 'https://llm.example/v1', api_key: 'k', model: 'm' };
      },
      buildBackgroundChatExtraBody() {
        return {};
      },
    },
    '@/lib/memory-profile': {
      readMemoryProfile() {
        return null;
      },
      renderMemoryProfile() {
        return '';
      },
    },
    '@/lib/ssrf-guard': {
      // 真实 SSE 流：返回一段总结内容，让 route 走到事务 INSERT
      safeFetch: async () => new Response(
        'data: {"choices":[{"delta":{"content":"总结内容"}}]}\n\ndata: [DONE]\n\n',
        { status: 200, headers: { 'content-type': 'text/event-stream' } },
      ),
    },
    crypto: { randomUUID: () => 'dup-summary-00000' },
  });

  const response = await withSilencedConsoleError(() => route.POST(jsonRequest({ conversation_id: 'conv-err' })));
  const payload = await response.json();
  const serialized = JSON.stringify(payload);

  assert.equal(response.status, 500);
  assert.doesNotMatch(serialized, /SqliteError|UNIQUE constraint|INSERT INTO/i);
  assert.doesNotMatch(serialized, /\.db\b/);
});

// memory-merge route undo：正常业务路径（批次不存在）返回业务文案，不含 SQL 细节
test('/api/memory-merge undo unknown batch returns business message without SQL details', async () => {
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

  const route = requireFreshWithMocks('../src/app/api/memory-merge/route.ts', {
    'next/server': jsonResponseMock(),
    '@/lib/db': { getDb: () => db },
  });

  const response = await route.POST(jsonRequest({
    action: 'undo',
    character_id: 'char-err',
    batch_id: 'missing-batch',
  }));
  const payload = await response.json();
  const serialized = JSON.stringify(payload);

  assert.equal(response.status, 200);
  assert.equal(payload.ok, true);
  assert.doesNotMatch(serialized, /SqliteError|SELECT|UPDATE/i);
});

// memory-merge execute：真实 DB 约束失败（SQLITE_CONSTRAINT）走 catch 收口
test('/api/memory-merge execute constraint failure body contains no SQL details', async () => {
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
    INSERT INTO memories (id, character_id, category, content, created_at, updated_at)
    VALUES ('dup-result', 'char-err', '偏好习惯', '占位', '2026-09-09T00:00:00.000Z', '2026-09-09T00:00:00.000Z');
    INSERT INTO memories (id, character_id, category, content, created_at, updated_at)
    VALUES ('s1', 'char-err', '偏好习惯', 'a', '2026-09-09T00:00:00.000Z', '2026-09-09T00:00:00.000Z');
    INSERT INTO memories (id, character_id, category, content, created_at, updated_at)
    VALUES ('s2', 'char-err', '偏好习惯', 'b', '2026-09-09T00:00:00.000Z', '2026-09-09T00:00:00.000Z');
  `);

  const route = requireFreshWithMocks('../src/app/api/memory-merge/route.ts', {
    'next/server': jsonResponseMock(),
    '@/lib/db': { getDb: () => db },
  });

  // result_memory_id 与已有 'dup-result' 冲突：INSERT 抛 SqliteError（UNIQUE 约束）
  const response = await withSilencedConsoleError(() => route.POST(jsonRequest({
    action: 'execute',
    character_id: 'char-err',
    source_ids: ['s1', 's2'],
    merged_content: '合并内容',
    batch_id: 'batch-err',
    result_memory_id: 'dup-result',
  })));
  const payload = await response.json();
  const serialized = JSON.stringify(payload);

  assert.equal(response.status, 400);
  assert.equal(payload.ok, false);
  assert.doesNotMatch(serialized, /SqliteError|UNIQUE constraint|INSERT INTO/i);
});

// memory-archive GET：listUndoableMemoryArchiveBatches 里的 SqliteError 收口
test('/api/memory-archive GET 500 detail contains no SqliteError when db throws', async () => {
  const db = new Database(':memory:');
  // 不建 memories 表：listUndoableMemoryArchiveBatches 的查询直接抛 SqliteError

  const route = requireFreshWithMocks('../src/app/api/memory-archive/route.ts', {
    'next/server': jsonResponseMock(),
    '@/lib/db': { getDb: () => db },
  });

  const response = await withSilencedConsoleError(() => route.GET({
    nextUrl: new URL('http://test.local/api/memory-archive?character_id=char-err'),
  }));
  const payload = await response.json();
  const serialized = JSON.stringify(payload);

  assert.equal(response.status, 500);
  assert.doesNotMatch(serialized, /SqliteError|no such table/i);
  assert.doesNotMatch(serialized, /\.db\b/);
});
