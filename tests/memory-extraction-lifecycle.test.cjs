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

function createExtractionDb() {
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
      emotional_weight REAL NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'active',
      pinned INTEGER NOT NULL DEFAULT 0,
      last_used_at TEXT,
      usage_count INTEGER NOT NULL DEFAULT 0,
      metadata TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
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
      result_committed INTEGER NOT NULL DEFAULT 0,
      result_insert_count INTEGER NOT NULL DEFAULT 0,
      result_merge_count INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
  return db;
}

const EXTRACTED = JSON.stringify({
  memories: [{
    category: '偏好习惯',
    memory_kind: 'user_preference',
    content: '用户最近迷上了做甜点，昨天烤了巴斯克蛋糕。',
    tags: ['甜点'],
    importance: 0.5,
    emotional_weight: 0.2,
    lifecycle_action: 'upsert',
  }],
});

function longConversation() {
  return '用户: 我最近迷上了做甜点，昨天烤了个巴斯克，成品还不错。'.repeat(4);
}

function settings() {
  return { limit_inject: true, memory_max_inject: 30 };
}

/** 依次返回预设响应；第 1 次是阶段一提取，第 2 次是阶段二生命周期判定 */
function loadEngineWithResponses(db, responses) {
  const calls = [];
  const engine = requireFreshWithMocks('../src/lib/memory-engine.ts', {
    '@/lib/db': { getDb: () => db },
    '@/lib/api-client': {
      chatCompletion: async (_settings, messages) => {
        calls.push(messages[0].content);
        const next = responses[calls.length - 1];
        if (typeof next === 'function') return next();
        return next ?? '';
      },
      REASONING_SAFE_MAX_TOKENS: 16384,
    },
    '@/lib/memory-index-trigger': { triggerMemoryIndexProcessing: () => false },
  });
  return { ...engine, calls };
}

function fakeReference(overrides = {}) {
  return {
    overview: { profileText: '记忆画像：\n关系状态：亲密伴侣', priorityText: 'E0. [关系动态] 我承诺先陪伴再分析。' },
    recallForLifecycle: async () => ({
      text: 'E0. [偏好习惯] 用户不喜欢吃甜的东西。',
      profileText: '记忆画像：\n关系状态：亲密伴侣',
      mode: 'vector',
      memoryIds: ['mem-sweet'],
      diagnostics: { recallCount: 1, priorityCount: 0, truncated: false },
    }),
    ...overrides,
  };
}

function insertExisting(db, overrides = {}) {
  db.prepare(`
    INSERT INTO memories (
      id, character_id, category, content, confidence, tags, source_msg_ids,
      memory_kind, importance, emotional_weight, status, pinned, last_used_at,
      usage_count, metadata, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?)
  `).run(
    overrides.id || 'mem-sweet',
    'char-a',
    overrides.category || '偏好习惯',
    overrides.content || '用户不喜欢吃甜的东西。',
    0.8,
    JSON.stringify(overrides.tags || ['口味']),
    JSON.stringify([]),
    overrides.memory_kind || 'user_preference',
    overrides.importance ?? 0.5,
    0,
    'active',
    0,
    0,
    '{}',
    '2026-06-01T00:00:00.000Z',
    '2026-06-01T00:00:00.000Z',
  );
}

test('stage two decision overrides the stage one lifecycle action', async () => {
  const db = createExtractionDb();
  const { extractMemories, calls } = loadEngineWithResponses(db, [
    EXTRACTED,
    JSON.stringify({ decisions: [{ index: 0, lifecycle_action: 'ignore' }] }),
  ]);

  const result = await extractMemories('char-a', longConversation(), settings(), {
    messageIds: ['msg-1'],
    reference: fakeReference(),
  });

  assert.equal(calls.length, 2, 'both stages must call the LLM');
  // 阶段二判 ignore → 不入库，落到候选表
  assert.equal(result.insertCount, 0);
  assert.equal(result.mergeCount, 0);
  const stored = db.prepare('SELECT COUNT(*) AS n FROM memories').get();
  assert.equal(stored.n, 0);
  const ignored = db.prepare("SELECT COUNT(*) AS n FROM memory_extraction_candidates WHERE status = 'ignored'").get();
  assert.equal(ignored.n, 1);
});

test('stage two prompt carries the candidate and the recalled memories', async () => {
  const db = createExtractionDb();
  const { extractMemories, calls } = loadEngineWithResponses(db, [
    EXTRACTED,
    JSON.stringify({ decisions: [{ index: 0, lifecycle_action: 'insert', target: null }] }),
  ]);

  await extractMemories('char-a', longConversation(), settings(), {
    messageIds: ['msg-1'],
    reference: fakeReference(),
  });

  const lifecyclePrompt = calls[1];
  assert.match(lifecyclePrompt, /迷上了做甜点/, 'candidate must be in the prompt');
  assert.match(lifecyclePrompt, /用户不喜欢吃甜的东西/, 'recalled memory must be in the prompt');
  assert.match(lifecyclePrompt, /亲密伴侣/, 'profile must be in the prompt');
  assert.match(lifecyclePrompt, /^0\. \[偏好习惯\]/m, 'candidates must be indexed');
  assert.match(lifecyclePrompt, /^E0\. \[偏好习惯\]/m, 'existing memories must carry E-numbers');

  // 阶段一 prompt 里不再塞全量已有记忆，只有画像 + 高优先级
  const extractionPrompt = calls[0];
  assert.match(extractionPrompt, /亲密伴侣/);
  assert.match(extractionPrompt, /我承诺先陪伴再分析/);
  assert.ok(!extractionPrompt.includes('用户不喜欢吃甜'), 'stage one must not receive the recall set');
});

// ── H1 回归防护 ────────────────────────────────────────────────
// 语义冲突的新旧记忆词法相似度极低（实测 ~0.04，门槛是 0.72/0.82），
// 若 supersede 只靠 findSimilarExistingMemories 找目标，会一条都匹配不上，
// 静默退化成 insert —— 与判 insert 的写库结果逐字节相同，整个阶段二白跑。
test('supersede actually retires the model-designated target memory', async () => {
  const db = createExtractionDb();
  insertExisting(db);
  const { extractMemories } = loadEngineWithResponses(db, [
    EXTRACTED,
    JSON.stringify({ decisions: [{ index: 0, lifecycle_action: 'supersede', target: 0 }] }),
  ]);

  const result = await extractMemories('char-a', longConversation(), settings(), {
    messageIds: ['msg-1'],
    reference: fakeReference(),
  });

  const old = db.prepare("SELECT status, metadata FROM memories WHERE id = 'mem-sweet'").get();
  assert.equal(old.status, 'superseded', '旧记忆必须被作废');
  const metadata = JSON.parse(old.metadata);
  assert.equal(metadata.previousStatus, 'active');
  assert.equal(metadata.supersededBy.action, 'memory_extraction_supersede');

  // 新记忆照常插入
  assert.equal(result.insertCount, 1);
  const active = db.prepare("SELECT content FROM memories WHERE status = 'active'").all();
  assert.equal(active.length, 1);
  assert.match(active[0].content, /迷上了做甜点/);
});

test('supersede without a usable target falls back to lexical matching', async () => {
  const db = createExtractionDb();
  // 词法上高度相似 → findSimilarExistingMemories 能兜住
  insertExisting(db, { id: 'mem-sweet', content: '用户最近迷上了做甜点，前几天烤了巴斯克蛋糕。' });
  const { extractMemories } = loadEngineWithResponses(db, [
    EXTRACTED,
    JSON.stringify({ decisions: [{ index: 0, lifecycle_action: 'supersede', target: null }] }),
  ]);

  await extractMemories('char-a', longConversation(), settings(), {
    messageIds: ['msg-1'],
    reference: fakeReference(),
  });

  const old = db.prepare("SELECT status FROM memories WHERE id = 'mem-sweet'").get();
  assert.equal(old.status, 'superseded', '无 target 时词法兜底仍须生效');
});

test('hallucinated out-of-range target is discarded, not applied to a wrong memory', async () => {
  const db = createExtractionDb();
  insertExisting(db);
  const { extractMemories } = loadEngineWithResponses(db, [
    EXTRACTED,
    // E9 不存在（召回列表只有 E0）
    JSON.stringify({ decisions: [{ index: 0, lifecycle_action: 'supersede', target: 9 }] }),
  ]);

  await extractMemories('char-a', longConversation(), settings(), {
    messageIds: ['msg-1'],
    reference: fakeReference(),
  });

  // 越界 target 被丢弃 → 回退词法匹配 → 相似度不够 → 旧记忆保持 active，绝不能误伤
  const old = db.prepare("SELECT status FROM memories WHERE id = 'mem-sweet'").get();
  assert.equal(old.status, 'active', '幻觉编号不得作废无关记忆');
});

test('target written as "E3" string is accepted, junk values are not', async () => {
  const db = createExtractionDb();
  insertExisting(db);
  const { extractMemories } = loadEngineWithResponses(db, [
    EXTRACTED,
    // 已有记忆在 prompt 里显示为 E0，模型很可能原样回填字符串
    JSON.stringify({ decisions: [{ index: 0, lifecycle_action: 'supersede', target: 'E0' }] }),
  ]);

  await extractMemories('char-a', longConversation(), settings(), {
    messageIds: ['msg-1'],
    reference: fakeReference(),
  });

  const old = db.prepare("SELECT status FROM memories WHERE id = 'mem-sweet'").get();
  assert.equal(old.status, 'superseded', '"E0" 写法必须能解析');
});

test('falsy junk target must not silently resolve to E0', async () => {
  const db = createExtractionDb();
  insertExisting(db);
  const { extractMemories } = loadEngineWithResponses(db, [
    EXTRACTED,
    // Number(false) === 0 / Number(' ') === 0：若用 Number() 解析会指向 E0，
    // 而 E0 恰是 pinned DESC 排序下最重要的那条记忆，误伤代价极高
    JSON.stringify({ decisions: [{ index: 0, lifecycle_action: 'supersede', target: false }] }),
  ]);

  await extractMemories('char-a', longConversation(), settings(), {
    messageIds: ['msg-1'],
    reference: fakeReference(),
  });

  const old = db.prepare("SELECT status FROM memories WHERE id = 'mem-sweet'").get();
  assert.equal(old.status, 'active', '垃圾 target 不得被当成 E0');
});

// ── 记忆丢失防护 ──────────────────────────────────────────────
// mergeMemories 的合并规则是「content 取更长的一方」，较短一方的独有信息会被丢弃。
// 该启发式只在「两条确实是近重复」时安全，所以 upsert 绝不能用模型指认的 target
// 绕过相似度阈值直接合并：模型判 upsert 的两条若措辞差异大，通常是同一对象的
// 不同事实，强行合并会静默丢掉新事实且仍报 mergeCount 成功。
test('upsert never silently drops a shorter new fact into a longer existing memory', async () => {
  const db = createExtractionDb();
  insertExisting(db, {
    id: 'mem-cat',
    category: '基础信息',
    content: '用户养了一只叫小白的白猫，是三年前在收容所领养的，特别黏人。',
    tags: ['宠物'],
  });

  const shortNewFact = JSON.stringify({
    memories: [{
      category: '基础信息',
      memory_kind: 'user_fact',
      content: '小白最近生病了，在打点滴。',
      tags: ['宠物'],
      importance: 0.5,
      emotional_weight: 0.3,
      lifecycle_action: 'upsert',
    }],
  });

  const { extractMemories } = loadEngineWithResponses(db, [
    shortNewFact,
    // 即便模型指认了目标，也不得据此合并掉这条更短的新事实
    JSON.stringify({ decisions: [{ index: 0, lifecycle_action: 'upsert', target: 0 }] }),
  ]);

  await extractMemories('char-a', longConversation(), settings(), {
    messageIds: ['msg-1'],
    reference: {
      overview: { profileText: '', priorityText: '' },
      recallForLifecycle: async () => ({
        text: 'E0. [基础信息] 用户养了一只叫小白的白猫，是三年前在收容所领养的，特别黏人。',
        profileText: '',
        mode: 'vector',
        memoryIds: ['mem-cat'],
      }),
    },
  });

  const contents = db.prepare("SELECT content FROM memories WHERE status = 'active'").all()
    .map((row) => row.content);
  assert.ok(
    contents.some((text) => text.includes('生病')),
    `新事实不得丢失，实际库内容: ${JSON.stringify(contents)}`,
  );
  assert.ok(contents.some((text) => text.includes('收容所')), '旧事实同样不得丢失');
});

test('junk decision index must not bind the verdict to candidate 0', async () => {
  const db = createExtractionDb();
  insertExisting(db, { id: 'mem-pin', content: '用户是独生女，父母住在苏州。', category: '基础信息' });
  const { extractMemories } = loadEngineWithResponses(db, [
    EXTRACTED,
    // Number(null) === 0：若用 Number() 解析，这条 supersede 会错绑到候选 0
    // 并作废 E0（pinned DESC 下最重要的那条），与候选内容毫无关系
    JSON.stringify({ decisions: [{ index: null, lifecycle_action: 'supersede', target: 0 }] }),
  ]);

  await extractMemories('char-a', longConversation(), settings(), {
    messageIds: ['msg-1'],
    reference: {
      overview: { profileText: '', priorityText: '' },
      recallForLifecycle: async () => ({
        text: 'E0. [基础信息] 用户是独生女，父母住在苏州。',
        profileText: '',
        mode: 'vector',
        memoryIds: ['mem-pin'],
      }),
    },
  });

  const pinned = db.prepare("SELECT status FROM memories WHERE id = 'mem-pin'").get();
  assert.equal(pinned.status, 'active', '垃圾 index 不得作废无关记忆');
});

test('stage two failure keeps the stage one result instead of losing the memory', async () => {
  const db = createExtractionDb();
  const { extractMemories } = loadEngineWithResponses(db, [EXTRACTED]);

  const result = await extractMemories('char-a', longConversation(), settings(), {
    messageIds: ['msg-1'],
    reference: fakeReference({
      recallForLifecycle: async () => { throw new Error('embedding upstream down'); },
    }),
  });

  assert.equal(result.insertCount, 1, 'memory must still be stored when stage two fails');
  const stored = db.prepare('SELECT content FROM memories').all();
  assert.equal(stored.length, 1);
  assert.match(stored[0].content, /迷上了做甜点/);
});

test('unparseable stage two response keeps the stage one action', async () => {
  const db = createExtractionDb();
  const { extractMemories } = loadEngineWithResponses(db, [
    EXTRACTED,
    '这不是 JSON，模型跑偏了。',
  ]);

  const result = await extractMemories('char-a', longConversation(), settings(), {
    messageIds: ['msg-1'],
    reference: fakeReference(),
  });

  assert.equal(result.insertCount, 1);
});

test('out-of-range decision index is ignored', async () => {
  const db = createExtractionDb();
  const { extractMemories } = loadEngineWithResponses(db, [
    EXTRACTED,
    JSON.stringify({ decisions: [{ index: 7, lifecycle_action: 'ignore' }, { index: -1, lifecycle_action: 'ignore' }] }),
  ]);

  const result = await extractMemories('char-a', longConversation(), settings(), {
    messageIds: ['msg-1'],
    reference: fakeReference(),
  });

  assert.equal(result.insertCount, 1, 'bogus indices must not drop the candidate');
});

test('empty recall skips the stage two LLM call entirely', async () => {
  const db = createExtractionDb();
  const { extractMemories, calls } = loadEngineWithResponses(db, [EXTRACTED]);

  const result = await extractMemories('char-a', longConversation(), settings(), {
    messageIds: ['msg-1'],
    reference: fakeReference({
      recallForLifecycle: async () => ({ text: '', profileText: '', mode: 'priority-only' }),
    }),
  });

  assert.equal(calls.length, 1, 'no memories to compare against means no second call');
  assert.equal(result.insertCount, 1);
});

test('without a reference provider the extraction stays single-stage', async () => {
  const db = createExtractionDb();
  const { extractMemories, calls } = loadEngineWithResponses(db, [EXTRACTED]);

  const result = await extractMemories('char-a', longConversation(), settings(), {
    messageIds: ['msg-1'],
  });

  assert.equal(calls.length, 1, 'legacy callers must not trigger stage two');
  assert.equal(result.insertCount, 1);
});
