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
      jsx: ts.JsxEmit.ReactJSX,
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

function jsonRequest(body, url = 'http://test.local/api/test') {
  return {
    nextUrl: new URL(url),
    async json() {
      return body;
    },
  };
}

function createCandidateDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE memories (
      id TEXT PRIMARY KEY,
      character_id TEXT NOT NULL,
      category TEXT NOT NULL,
      content TEXT NOT NULL,
      confidence REAL,
      tags TEXT,
      source_msg_ids TEXT,
      memory_kind TEXT,
      importance REAL,
      emotional_weight REAL,
      status TEXT,
      pinned INTEGER,
      last_used_at TEXT,
      usage_count INTEGER,
      metadata TEXT,
      created_at TEXT,
      updated_at TEXT
    );

    CREATE TABLE memory_embedding_tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      memory_id TEXT NOT NULL,
      character_id TEXT NOT NULL,
      reason TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      retry_count INTEGER NOT NULL DEFAULT 0,
      error_message TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
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
  return db;
}

function seedCandidate(db, overrides = {}) {
  const now = overrides.created_at || '2026-01-01T00:00:00.000Z';
  const result = db.prepare(`
    INSERT INTO memory_extraction_candidates (
      task_id, character_id, conversation_id, raw_candidate_json, raw_response,
      status, error_reason, created_at, updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    overrides.task_id ?? 1,
    overrides.character_id ?? 'char-a',
    overrides.conversation_id ?? 'conv-a',
    JSON.stringify(overrides.raw_candidate_json ?? {
      category: '偏好习惯',
      content: '主人喜欢雨夜听轻音乐。',
      tags: ['雨夜'],
      importance: 0.7,
      emotional_weight: 0.2,
      memory_kind: 'user_preference',
    }),
    overrides.raw_response ?? '{"memories":[]}',
    overrides.status ?? 'repairable',
    overrides.error_reason ?? 'semantic_check_required',
    now,
    overrides.updated_at || now,
  );
  return result.lastInsertRowid;
}

function dbWithCandidateStatusRace(db, candidateId, racedStatus) {
  let raced = false;
  return {
    prepare(sql) {
      const statement = db.prepare(sql);
      if (sql.includes('SELECT id, character_id, raw_candidate_json, status FROM memory_extraction_candidates WHERE id = ?')) {
        return {
          get(...args) {
            const row = statement.get(...args);
            if (!raced) {
              raced = true;
              db.prepare('UPDATE memory_extraction_candidates SET status = ? WHERE id = ?')
                .run(racedStatus, candidateId);
            }
            return row;
          },
        };
      }
      return statement;
    },
    transaction: fn => db.transaction(fn),
  };
}

test('/api/memory-candidates GET 只列出 repairable 候选且不写入正式 memories', async () => {
  const db = createCandidateDb();
  const repairableId = seedCandidate(db, { status: 'repairable' });
  seedCandidate(db, { status: 'repaired', raw_candidate_json: { category: '话题历史', content: '已修复条目' } });
  seedCandidate(db, { status: 'discarded', raw_candidate_json: { category: '话题历史', content: '已丢弃条目' } });
  seedCandidate(db, {
    character_id: 'char-b',
    raw_candidate_json: { category: '话题历史', content: '其它角色条目' },
  });

  const route = requireFreshWithMocks('../src/app/api/memory-candidates/route.ts', {
    'next/server': jsonResponseMock(),
    '@/lib/db': { getDb: () => db },
  });

  const response = await route.GET(jsonRequest(null, 'http://test.local/api/memory-candidates?character_id=char-a'));
  const payload = await response.json();
  const memoryCount = db.prepare('SELECT COUNT(*) as n FROM memories').get();

  assert.equal(response.status, 200);
  assert.deepEqual(payload.candidates.map(candidate => candidate.id), [repairableId]);
  assert.equal(payload.candidates[0].raw_candidate.category, '偏好习惯');
  assert.equal(payload.candidates[0].raw_candidate.content, '主人喜欢雨夜听轻音乐。');
  assert.equal(memoryCount.n, 0);
});

test('/api/memory-candidates/[id] accept 将候选写入 memories、标记 repaired 并入队 embedding', async () => {
  const db = createCandidateDb();
  const candidateId = seedCandidate(db);
  const route = requireFreshWithMocks('../src/app/api/memory-candidates/[id]/route.ts', {
    'next/server': jsonResponseMock(),
    '@/lib/db': { getDb: () => db },
    '@/lib/memory-index-trigger': { triggerMemoryIndexProcessing: () => false },
  });

  const response = await route.POST(
    jsonRequest({ action: 'accept' }),
    { params: Promise.resolve({ id: String(candidateId) }) },
  );
  const payload = await response.json();
  const candidate = db.prepare('SELECT status FROM memory_extraction_candidates WHERE id = ?').get(candidateId);
  const memory = db.prepare('SELECT * FROM memories WHERE id = ?').get(payload.memory.id);
  const task = db.prepare('SELECT memory_id, character_id, reason, status FROM memory_embedding_tasks').get();

  assert.equal(response.status, 201);
  assert.equal(candidate.status, 'repaired');
  assert.equal(memory.character_id, 'char-a');
  assert.equal(memory.category, '偏好习惯');
  assert.equal(memory.content, '主人喜欢雨夜听轻音乐。');
  assert.equal(task.memory_id, payload.memory.id);
  assert.equal(task.character_id, 'char-a');
  assert.equal(task.reason, 'created');
  assert.equal(task.status, 'pending');
});

test('/api/memory-candidates/[id] accept 入队 embedding 后触发索引处理', async () => {
  const db = createCandidateDb();
  const candidateId = seedCandidate(db);
  let triggerCount = 0;
  const route = requireFreshWithMocks('../src/app/api/memory-candidates/[id]/route.ts', {
    'next/server': jsonResponseMock(),
    '@/lib/db': { getDb: () => db },
    '@/lib/memory-index-trigger': {
      triggerMemoryIndexProcessing: () => {
        triggerCount++;
        return true;
      },
    },
  });

  const response = await route.POST(
    jsonRequest({ action: 'accept' }),
    { params: Promise.resolve({ id: String(candidateId) }) },
  );
  const taskCount = db.prepare("SELECT COUNT(*) as n FROM memory_embedding_tasks WHERE status = 'pending'").get();

  assert.equal(response.status, 201);
  assert.equal(taskCount.n, 1);
  assert.equal(triggerCount, 1);
});

test('/api/memory-candidates/[id] accept 入队未创建新任务或入队异常时不触发索引处理', async () => {
  const originalConsoleError = console.error;
  console.error = () => {};
  try {
    for (const mode of ['false', 'throw']) {
      const db = createCandidateDb();
      const candidateId = seedCandidate(db, {
        raw_candidate_json: {
          category: '偏好习惯',
          content: `主人喜欢雨夜听轻音乐 ${mode}。`,
          tags: ['雨夜'],
          importance: 0.7,
          emotional_weight: 0.2,
          memory_kind: 'user_preference',
        },
      });
      let triggerCount = 0;
      const route = requireFreshWithMocks('../src/app/api/memory-candidates/[id]/route.ts', {
        'next/server': jsonResponseMock(),
        '@/lib/db': { getDb: () => db },
        '@/lib/memory-embeddings': {
          enqueueMemoryEmbeddingTask: () => {
            if (mode === 'throw') throw new Error('enqueue failed');
            return false;
          },
        },
        '@/lib/memory-index-trigger': {
          triggerMemoryIndexProcessing: () => {
            triggerCount++;
            return true;
          },
        },
      });

      const response = await route.POST(
        jsonRequest({ action: 'accept' }),
        { params: Promise.resolve({ id: String(candidateId) }) },
      );
      const payload = await response.json();
      const memory = db.prepare('SELECT * FROM memories WHERE id = ?').get(payload.memory.id);
      const taskCount = db.prepare('SELECT COUNT(*) as n FROM memory_embedding_tasks').get();

      assert.equal(response.status, 201, mode);
      assert.equal(memory.content, `主人喜欢雨夜听轻音乐 ${mode}。`, mode);
      assert.equal(taskCount.n, 0, mode);
      assert.equal(triggerCount, 0, mode);
    }
  } finally {
    console.error = originalConsoleError;
  }
});

test('/api/memory-candidates/[id] accept 使用事务和 repairable 状态守卫', () => {
  const routeSource = fs.readFileSync(path.join(root, 'src/app/api/memory-candidates/[id]/route.ts'), 'utf8');

  assert.ok(routeSource.includes('db.transaction(() => {'));
  assert.ok(routeSource.includes("WHERE id = ? AND status = 'repairable'"));
  assert.ok(routeSource.includes('if (statusUpdate.changes === 0)'));
});

test('/api/memory-candidates/[id] discard/ignore 并发遇到已 repaired 候选时返回 409 且不覆盖状态', async () => {
  for (const action of ['discard', 'ignore']) {
    const db = createCandidateDb();
    const candidateId = seedCandidate(db);
    const route = requireFreshWithMocks('../src/app/api/memory-candidates/[id]/route.ts', {
      'next/server': jsonResponseMock(),
      '@/lib/db': { getDb: () => dbWithCandidateStatusRace(db, candidateId, 'repaired') },
    });

    const response = await route.POST(
      jsonRequest({ action }),
      { params: Promise.resolve({ id: String(candidateId) }) },
    );
    const payload = await response.json();
    const candidate = db.prepare('SELECT status FROM memory_extraction_candidates WHERE id = ?').get(candidateId);
    const memoryCount = db.prepare('SELECT COUNT(*) as n FROM memories').get();
    const taskCount = db.prepare('SELECT COUNT(*) as n FROM memory_embedding_tasks').get();

    assert.equal(response.status, 409, action);
    assert.deepEqual(payload, { error: 'Candidate is not repairable' }, action);
    assert.equal(candidate.status, 'repaired', action);
    assert.equal(memoryCount.n, 0, action);
    assert.equal(taskCount.n, 0, action);
  }
});

test('/api/memory-candidates/[id] discard/ignore 使用 repairable 原子状态守卫', () => {
  const routeSource = fs.readFileSync(path.join(root, 'src/app/api/memory-candidates/[id]/route.ts'), 'utf8');
  const branchStart = routeSource.indexOf("if (action === 'discard' || action === 'ignore')");
  const branchEnd = routeSource.indexOf('const rawCandidate', branchStart);
  const discardIgnoreBranch = routeSource.slice(branchStart, branchEnd);

  assert.ok(discardIgnoreBranch.includes("WHERE id = ? AND status = 'repairable'"));
  assert.ok(discardIgnoreBranch.includes('if (statusUpdate.changes === 0)'));
});

test('/api/memory-candidates/[id] accept 会保留候选中的 source_msg_ids', async () => {
  const db = createCandidateDb();
  const candidateId = seedCandidate(db, {
    raw_candidate_json: {
      category: '偏好习惯',
      content: '主人难过时希望先被安静陪伴。',
      tags: ['陪伴'],
      importance: 0.8,
      emotional_weight: 0.6,
      memory_kind: 'user_preference',
      source_msg_ids: ['msg-user-source', 'msg-assistant-source'],
    },
  });
  const route = requireFreshWithMocks('../src/app/api/memory-candidates/[id]/route.ts', {
    'next/server': jsonResponseMock(),
    '@/lib/db': { getDb: () => db },
    '@/lib/memory-index-trigger': { triggerMemoryIndexProcessing: () => false },
  });

  const response = await route.POST(
    jsonRequest({ action: 'accept' }),
    { params: Promise.resolve({ id: String(candidateId) }) },
  );
  const payload = await response.json();
  const memory = db.prepare('SELECT source_msg_ids FROM memories WHERE id = ?').get(payload.memory.id);

  assert.equal(response.status, 201);
  assert.deepEqual(JSON.parse(memory.source_msg_ids), ['msg-user-source', 'msg-assistant-source']);
});


test('/api/memory-candidates/[id] accept 支持编辑后接纳', async () => {
  const db = createCandidateDb();
  const candidateId = seedCandidate(db);
  const route = requireFreshWithMocks('../src/app/api/memory-candidates/[id]/route.ts', {
    'next/server': jsonResponseMock(),
    '@/lib/db': { getDb: () => db },
    '@/lib/memory-index-trigger': { triggerMemoryIndexProcessing: () => false },
  });

  const response = await route.POST(
    jsonRequest({
      action: 'accept',
      memory: {
        category: '关系动态',
        content: '主人希望我难过时先陪伴再分析。',
        tags: ['陪伴方式'],
        importance: 0.9,
        emotional_weight: 0.8,
        memory_kind: 'relationship_event',
      },
    }),
    { params: Promise.resolve({ id: String(candidateId) }) },
  );
  const payload = await response.json();
  const memory = db.prepare('SELECT * FROM memories WHERE id = ?').get(payload.memory.id);

  assert.equal(response.status, 201);
  assert.equal(memory.category, '关系动态');
  assert.equal(memory.content, '主人希望我难过时先陪伴再分析。');
  assert.deepEqual(JSON.parse(memory.tags), ['陪伴方式']);
  assert.equal(memory.importance, 0.9);
  assert.equal(memory.emotional_weight, 0.8);
  assert.equal(memory.memory_kind, 'relationship_event');
});

test('/api/memory-candidates/[id] discard 只更新候选状态，不写 memories 或 embedding task', async () => {
  const db = createCandidateDb();
  const candidateId = seedCandidate(db);
  const route = requireFreshWithMocks('../src/app/api/memory-candidates/[id]/route.ts', {
    'next/server': jsonResponseMock(),
    '@/lib/db': { getDb: () => db },
  });

  const response = await route.POST(
    jsonRequest({ action: 'discard' }),
    { params: Promise.resolve({ id: String(candidateId) }) },
  );
  const payload = await response.json();
  const candidate = db.prepare('SELECT status FROM memory_extraction_candidates WHERE id = ?').get(candidateId);
  const memoryCount = db.prepare('SELECT COUNT(*) as n FROM memories').get();
  const taskCount = db.prepare('SELECT COUNT(*) as n FROM memory_embedding_tasks').get();

  assert.equal(response.status, 200);
  assert.deepEqual(payload, { ok: true, status: 'discarded' });
  assert.equal(candidate.status, 'discarded');
  assert.equal(memoryCount.n, 0);
  assert.equal(taskCount.n, 0);
});

test('/api/memory-candidates/[id] ignore 只更新候选状态，不写 memories 或 embedding task', async () => {
  const db = createCandidateDb();
  const candidateId = seedCandidate(db);
  const route = requireFreshWithMocks('../src/app/api/memory-candidates/[id]/route.ts', {
    'next/server': jsonResponseMock(),
    '@/lib/db': { getDb: () => db },
  });

  const response = await route.POST(
    jsonRequest({ action: 'ignore' }),
    { params: Promise.resolve({ id: String(candidateId) }) },
  );
  const payload = await response.json();
  const candidate = db.prepare('SELECT status FROM memory_extraction_candidates WHERE id = ?').get(candidateId);
  const memoryCount = db.prepare('SELECT COUNT(*) as n FROM memories').get();
  const taskCount = db.prepare('SELECT COUNT(*) as n FROM memory_embedding_tasks').get();

  assert.equal(response.status, 200);
  assert.deepEqual(payload, { ok: true, status: 'ignored' });
  assert.equal(candidate.status, 'ignored');
  assert.equal(memoryCount.n, 0);
  assert.equal(taskCount.n, 0);
});
