const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');
const Database = require('better-sqlite3');

const root = path.resolve(__dirname, '..');
const originalResolveFilename = Module._resolveFilename;

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

const {
  executeMemoryMerge,
  undoMemoryMergeBatch,
  listUndoableMemoryMergeBatches,
} = require('../src/lib/memory-merge');
const { MAX_MEMORY_CONTENT } = require('../src/lib/schemas');

function createMergeTestDb() {
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
  return db;
}

function insertMemory(db, overrides) {
  const memory = {
    id: 'mem-default',
    character_id: 'char-1',
    category: '话题历史',
    content: '默认记忆',
    confidence: 0.8,
    tags: [],
    source_msg_ids: [],
    memory_kind: 'general',
    importance: 0.5,
    emotional_weight: 0,
    status: 'active',
    pinned: false,
    last_used_at: null,
    usage_count: 0,
    metadata: {},
    created_at: '2026-07-28T00:00:00.000Z',
    updated_at: '2026-07-28T00:00:00.000Z',
    ...overrides,
  };
  db.prepare(`
    INSERT INTO memories (
      id, character_id, category, content, confidence, tags, source_msg_ids,
      memory_kind, importance, emotional_weight, status, pinned, last_used_at,
      usage_count, metadata, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    memory.id,
    memory.character_id,
    memory.category,
    memory.content,
    memory.confidence,
    JSON.stringify(memory.tags),
    JSON.stringify(memory.source_msg_ids),
    memory.memory_kind,
    memory.importance,
    memory.emotional_weight,
    memory.status,
    memory.pinned ? 1 : 0,
    memory.last_used_at,
    memory.usage_count,
    JSON.stringify(memory.metadata),
    memory.created_at,
    memory.updated_at,
  );
}

test('executeMemoryMerge: supersedes sources, unions source_msg_ids, undo restores', () => {
  const db = createMergeTestDb();
  insertMemory(db, { id: 's1', content: '喜欢美式', source_msg_ids: ['m1'], tags: ['咖啡'], importance: 0.6 });
  insertMemory(db, { id: 's2', content: '喜欢美式咖啡', source_msg_ids: ['m2', 'm1'], tags: ['饮品'], importance: 0.7 });

  const executed = executeMemoryMerge(db, {
    batchId: 'batch-1',
    characterId: 'char-1',
    resultMemoryId: 'result-1',
    sourceIds: ['s1', 's2'],
    mergedContent: '用户喜欢美式咖啡',
    category: '偏好习惯',
    tags: ['咖啡'],
    importance: 0.75,
    now: '2026-07-28T01:00:00.000Z',
  });

  assert.equal(executed.resultMemoryId, 'result-1');
  const result = db.prepare('SELECT * FROM memories WHERE id = ?').get('result-1');
  assert.equal(result.status, 'active');
  assert.deepEqual(JSON.parse(result.source_msg_ids).sort(), ['m1', 'm2']);
  const meta = JSON.parse(result.metadata);
  assert.equal(meta.mergeRole, 'result');
  assert.equal(meta.mergeBatchId, 'batch-1');

  for (const id of ['s1', 's2']) {
    const row = db.prepare('SELECT * FROM memories WHERE id = ?').get(id);
    assert.equal(row.status, 'superseded');
    const m = JSON.parse(row.metadata);
    assert.equal(m.mergedInto, 'result-1');
    assert.equal(m.previousStatus, 'active');
  }

  const listed = listUndoableMemoryMergeBatches(db, 'char-1');
  assert.equal(listed.length, 1);
  assert.equal(listed[0].batch_id, 'batch-1');

  const undo = undoMemoryMergeBatch(db, {
    batchId: 'batch-1',
    characterId: 'char-1',
    now: '2026-07-28T02:00:00.000Z',
  });
  assert.equal(undo.resultMemoryId, 'result-1');
  assert.deepEqual(undo.restoredMemoryIds.sort(), ['s1', 's2']);
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM memories WHERE id = ?').get('result-1').c, 0);
  for (const id of ['s1', 's2']) {
    const row = db.prepare('SELECT * FROM memories WHERE id = ?').get(id);
    assert.equal(row.status, 'active');
    const m = JSON.parse(row.metadata);
    assert.equal(m.mergeBatchId, undefined);
    assert.equal(m.mergedInto, undefined);
  }
});

test('executeMemoryMerge: rejects pinned source', () => {
  const db = createMergeTestDb();
  insertMemory(db, { id: 's1', content: 'a', pinned: true });
  insertMemory(db, { id: 's2', content: 'b' });
  assert.throws(
    () => executeMemoryMerge(db, {
      batchId: 'b',
      characterId: 'char-1',
      resultMemoryId: 'r',
      sourceIds: ['s1', 's2'],
      mergedContent: 'merged',
      now: '2026-07-28T01:00:00.000Z',
    }),
    /Pinned/,
  );
});

test('executeMemoryMerge: rejects non-active source', () => {
  const db = createMergeTestDb();
  insertMemory(db, { id: 's1', content: 'a', status: 'archived' });
  insertMemory(db, { id: 's2', content: 'b' });
  assert.throws(
    () => executeMemoryMerge(db, {
      batchId: 'b',
      characterId: 'char-1',
      resultMemoryId: 'r',
      sourceIds: ['s1', 's2'],
      mergedContent: 'merged',
      now: '2026-07-28T01:00:00.000Z',
    }),
    /Only active/,
  );
});

test('executeMemoryMerge: rejects second merge on same sources', () => {
  const db = createMergeTestDb();
  insertMemory(db, { id: 's1', content: 'a' });
  insertMemory(db, { id: 's2', content: 'b' });
  executeMemoryMerge(db, {
    batchId: 'b1',
    characterId: 'char-1',
    resultMemoryId: 'r1',
    sourceIds: ['s1', 's2'],
    mergedContent: 'merged once',
    now: '2026-07-28T01:00:00.000Z',
  });
  insertMemory(db, { id: 's3', content: 'c' });
  // 源已被 supersede 为非 active，或带 mergeBatchId——两种守卫都合法
  assert.throws(
    () => executeMemoryMerge(db, {
      batchId: 'b2',
      characterId: 'char-1',
      resultMemoryId: 'r2',
      sourceIds: ['s1', 's3'],
      mergedContent: 'merged twice',
      now: '2026-07-28T01:01:00.000Z',
    }),
    /Only active|re-merged|reserved/i,
  );
});

test('executeMemoryMerge: rejects overlong content', () => {
  const db = createMergeTestDb();
  insertMemory(db, { id: 's1', content: 'a' });
  insertMemory(db, { id: 's2', content: 'b' });
  assert.throws(
    () => executeMemoryMerge(db, {
      batchId: 'b',
      characterId: 'char-1',
      resultMemoryId: 'r',
      sourceIds: ['s1', 's2'],
      mergedContent: 'x'.repeat(MAX_MEMORY_CONTENT + 1),
      now: '2026-07-28T01:00:00.000Z',
    }),
    /MAX_MEMORY_CONTENT/,
  );
});

test('executeMemoryMerge: merged result timestamp matches latest source memory, not now', () => {
  const db = createMergeTestDb();
  insertMemory(db, {
    id: 's1',
    content: '较新记忆',
    created_at: '2026-07-01T00:00:00.000Z',
    updated_at: '2026-07-10T00:00:00.000Z',
  });
  insertMemory(db, {
    id: 's2',
    content: '较老记忆',
    created_at: '2026-06-01T00:00:00.000Z',
    updated_at: '2026-06-20T00:00:00.000Z',
  });

  const executed = executeMemoryMerge(db, {
    batchId: 'batch-ts',
    characterId: 'char-1',
    resultMemoryId: 'result-ts',
    sourceIds: ['s1', 's2'],
    mergedContent: '合并内容',
    now: '2026-07-28T01:00:00.000Z',
  });
  assert.equal(executed.resultMemoryId, 'result-ts');

  const result = db.prepare('SELECT created_at, updated_at FROM memories WHERE id = ?').get('result-ts');
  // 期望结果：合并产物不应被标到「当下」，而是取源记忆中最新的 updated_at（2026-07-10）。
  assert.equal(result.updated_at, '2026-07-10T00:00:00.000Z');
  assert.equal(result.created_at, '2026-07-10T00:00:00.000Z');
});

test('executeMemoryMerge: compares mixed SQLite and ISO timestamps chronologically', () => {
  const db = createMergeTestDb();
  insertMemory(db, {
    id: 's1',
    content: 'ISO 时间记忆',
    created_at: '2026-07-10T10:00:00.000Z',
    updated_at: '2026-07-10T11:00:00.000Z',
  });
  insertMemory(db, {
    id: 's2',
    content: 'SQLite 时间记忆',
    created_at: '2026-07-10 10:30:00',
    updated_at: '2026-07-10 12:00:00',
  });

  executeMemoryMerge(db, {
    batchId: 'batch-mixed-ts',
    characterId: 'char-1',
    resultMemoryId: 'result-mixed-ts',
    sourceIds: ['s1', 's2'],
    mergedContent: '合并内容',
    now: '2026-07-10T13:00:00.000Z',
  });

  const result = db.prepare('SELECT created_at, updated_at FROM memories WHERE id = ?')
    .get('result-mixed-ts');
  assert.equal(result.updated_at, '2026-07-10 12:00:00');
  assert.equal(result.created_at, '2026-07-10 12:00:00');
});

test('executeMemoryMerge: ignores empty and invalid source timestamps', () => {
  const db = createMergeTestDb();
  insertMemory(db, {
    id: 's1',
    content: '无效时间记忆',
    created_at: '',
    updated_at: 'not-a-timestamp',
  });
  insertMemory(db, {
    id: 's2',
    content: '有效时间记忆',
    created_at: '2026-07-09 10:00:00',
    updated_at: '2026-07-10T12:00:00.000Z',
  });

  executeMemoryMerge(db, {
    batchId: 'batch-invalid-ts',
    characterId: 'char-1',
    resultMemoryId: 'result-invalid-ts',
    sourceIds: ['s1', 's2'],
    mergedContent: '合并内容',
    now: '2026-07-10T13:00:00.000Z',
  });

  const result = db.prepare('SELECT created_at, updated_at FROM memories WHERE id = ?')
    .get('result-invalid-ts');
  assert.equal(result.updated_at, '2026-07-10T12:00:00.000Z');
  assert.equal(result.created_at, '2026-07-10T12:00:00.000Z');
});

test('executeMemoryMerge: rejects archive-marked memory', () => {
  const db = createMergeTestDb();
  insertMemory(db, { id: 's1', content: 'a', metadata: { archiveBatchId: 'arch-1' } });
  insertMemory(db, { id: 's2', content: 'b' });
  assert.throws(
    () => executeMemoryMerge(db, {
      batchId: 'b',
      characterId: 'char-1',
      resultMemoryId: 'r',
      sourceIds: ['s1', 's2'],
      mergedContent: 'merged',
      now: '2026-07-28T01:00:00.000Z',
    }),
    /reserved|re-merged/i,
  );
});
