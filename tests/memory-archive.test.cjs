const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');

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

const Database = require('better-sqlite3');

const {
  planMemorySummaryArchive,
  executeMemorySummaryArchive,
  listUndoableMemoryArchiveBatches,
  undoMemorySummaryArchiveBatch,
} = require('../src/lib/memory-archive');

function createArchiveTestDb() {
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
    created_at: '2026-06-02T09:00:00.000Z',
    updated_at: '2026-06-02T09:00:00.000Z',
    ...overrides,
  };

  db.prepare(`
    INSERT INTO memories (
      id, character_id, category, content, confidence, tags, source_msg_ids,
      memory_kind, importance, emotional_weight, status, pinned, last_used_at,
      usage_count, metadata, created_at, updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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

function getMemory(db, id) {
  const row = db.prepare('SELECT * FROM memories WHERE id = ?').get(id);
  if (!row) return null;
  return {
    ...row,
    tags: JSON.parse(row.tags),
    source_msg_ids: JSON.parse(row.source_msg_ids),
    pinned: row.pinned === 1,
    metadata: JSON.parse(row.metadata),
  };
}

test('plans one summary memory insert and reversible status updates for covered memories', () => {
  const result = planMemorySummaryArchive({
    batchId: 'archive-batch-2026-06-02',
    characterId: 'char-1',
    summaryMemoryId: 'summary-mem-1',
    summaryContent: '主人偏好夜间写作，近期在推进记忆系统升级。',
    now: '2026-06-02T10:00:00.000Z',
    sourceMemories: [
      {
        id: 'mem-pinned',
        category: '偏好习惯',
        content: '主人喜欢夜间写作。',
        confidence: 0.91,
        tags: ['writing', 'routine'],
        source_msg_ids: ['msg-1'],
        memory_kind: 'user_preference',
        importance: 88,
        emotional_weight: 12,
        status: 'active',
        pinned: true,
        metadata: { note: 'keep original metadata' },
      },
      {
        id: 'mem-normal',
        category: '重要事件',
        content: '主人正在推进记忆系统升级。',
        confidence: 0.84,
        tags: ['memory'],
        source_msg_ids: ['msg-2'],
        memory_kind: 'open_thread',
        importance: 72,
        emotional_weight: 20,
        status: 'active',
        pinned: false,
        metadata: {},
      },
    ],
  });

  assert.equal(result.summaryMemory.character_id, 'char-1');
  assert.equal(result.summaryMemory.id, 'summary-mem-1');
  assert.equal(result.summaryMemory.content, '主人偏好夜间写作，近期在推进记忆系统升级。');
  assert.equal(result.summaryMemory.category, '基础信息');
  assert.equal(result.summaryMemory.memory_kind, 'general');
  assert.equal(result.summaryMemory.status, 'active');
  assert.equal(result.summaryMemory.pinned, false);
  assert.deepEqual(result.summaryMemory.tags, ['archive-summary']);
  assert.deepEqual(result.summaryMemory.source_msg_ids, ['msg-1', 'msg-2']);
  assert.deepEqual(result.summaryMemory.metadata, {
    archiveBatchId: 'archive-batch-2026-06-02',
    archiveRole: 'summary',
    coveredMemoryIds: ['mem-pinned', 'mem-normal'],
  });

  assert.deepEqual(result.coveredMemoryUpdates, [
    {
      id: 'mem-pinned',
      status: 'summarized',
      metadata: {
        note: 'keep original metadata',
        archiveBatchId: 'archive-batch-2026-06-02',
        summarizedBy: result.summaryMemory.id,
        previousStatus: 'active',
      },
      updated_at: '2026-06-02T10:00:00.000Z',
    },
    {
      id: 'mem-normal',
      status: 'archived',
      metadata: {
        archiveBatchId: 'archive-batch-2026-06-02',
        summarizedBy: result.summaryMemory.id,
        previousStatus: 'active',
      },
      updated_at: '2026-06-02T10:00:00.000Z',
    },
  ]);
});

test('executes an archive plan by inserting a summary and status-marking covered memories', () => {
  const db = createArchiveTestDb();
  insertMemory(db, {
    id: 'mem-pinned',
    category: '偏好习惯',
    content: '主人喜欢夜间写作。',
    tags: ['writing'],
    source_msg_ids: ['msg-1'],
    memory_kind: 'user_preference',
    status: 'active',
    pinned: true,
    metadata: { note: 'keep me visible' },
  });
  insertMemory(db, {
    id: 'mem-normal',
    category: '重要事件',
    content: '主人正在推进记忆系统升级。',
    tags: ['memory'],
    source_msg_ids: ['msg-2'],
    memory_kind: 'open_thread',
    status: 'active',
    pinned: false,
  });

  const result = executeMemorySummaryArchive(db, {
    batchId: 'archive-batch-2026-06-02',
    characterId: 'char-1',
    summaryMemoryId: 'summary-mem-1',
    summaryContent: '主人偏好夜间写作，近期在推进记忆系统升级。',
    coveredMemoryIds: ['mem-pinned', 'mem-normal'],
    now: '2026-06-02T10:00:00.000Z',
  });

  assert.equal(result.summaryMemory.id, 'summary-mem-1');
  assert.deepEqual(result.coveredMemoryUpdates.map(update => [update.id, update.status]), [
    ['mem-pinned', 'summarized'],
    ['mem-normal', 'archived'],
  ]);

  const summary = getMemory(db, 'summary-mem-1');
  assert.equal(summary.status, 'active');
  assert.equal(summary.content, '主人偏好夜间写作，近期在推进记忆系统升级。');
  assert.deepEqual(summary.source_msg_ids, ['msg-1', 'msg-2']);
  assert.deepEqual(summary.metadata, {
    archiveBatchId: 'archive-batch-2026-06-02',
    archiveRole: 'summary',
    coveredMemoryIds: ['mem-pinned', 'mem-normal'],
  });

  const pinned = getMemory(db, 'mem-pinned');
  assert.equal(pinned.status, 'summarized');
  assert.equal(pinned.metadata.note, 'keep me visible');
  assert.equal(pinned.metadata.previousStatus, 'active');
  assert.equal(pinned.metadata.summarizedBy, 'summary-mem-1');

  const normal = getMemory(db, 'mem-normal');
  assert.equal(normal.status, 'archived');
  assert.equal(normal.metadata.previousStatus, 'active');
  assert.equal(normal.metadata.summarizedBy, 'summary-mem-1');
});

test('undoes an archive batch by restoring covered memories and retiring the summary', () => {
  const db = createArchiveTestDb();
  insertMemory(db, {
    id: 'mem-pinned',
    category: '偏好习惯',
    content: '主人喜欢夜间写作。',
    source_msg_ids: ['msg-1'],
    memory_kind: 'user_preference',
    status: 'active',
    pinned: true,
    metadata: { note: 'keep me visible' },
  });
  insertMemory(db, {
    id: 'mem-normal',
    category: '重要事件',
    content: '主人正在推进记忆系统升级。',
    source_msg_ids: ['msg-2'],
    memory_kind: 'open_thread',
    status: 'active',
    pinned: false,
  });
  executeMemorySummaryArchive(db, {
    batchId: 'archive-batch-2026-06-02',
    characterId: 'char-1',
    summaryMemoryId: 'summary-mem-1',
    summaryContent: '主人偏好夜间写作，近期在推进记忆系统升级。',
    coveredMemoryIds: ['mem-pinned', 'mem-normal'],
    now: '2026-06-02T10:00:00.000Z',
  });

  const result = undoMemorySummaryArchiveBatch(db, {
    batchId: 'archive-batch-2026-06-02',
    characterId: 'char-1',
    now: '2026-06-02T10:30:00.000Z',
  });

  assert.deepEqual(result.restoredMemoryIds, ['mem-pinned', 'mem-normal']);
  assert.equal(result.summaryMemoryId, 'summary-mem-1');

  const pinned = getMemory(db, 'mem-pinned');
  assert.equal(pinned.status, 'active');
  assert.deepEqual(pinned.metadata, { note: 'keep me visible' });

  const normal = getMemory(db, 'mem-normal');
  assert.equal(normal.status, 'active');
  assert.deepEqual(normal.metadata, {});

  const summary = getMemory(db, 'summary-mem-1');
  // 撤销时 summary 被直接删除，不再保留为 archived
  assert.equal(summary, null);
});

test('undo rejects invalid previousStatus without writing corrupted status to DB', () => {
  const db = createArchiveTestDb();
  insertMemory(db, { id: 'mem-normal', status: 'active' });
  executeMemorySummaryArchive(db, {
    batchId: 'archive-batch-2026-06-02',
    characterId: 'char-1',
    summaryMemoryId: 'summary-mem-1',
    summaryContent: '主人正在推进记忆系统升级。',
    coveredMemoryIds: ['mem-normal'],
    now: '2026-06-02T10:00:00.000Z',
  });

  const corruptedMetadata = getMemory(db, 'mem-normal').metadata;
  corruptedMetadata.previousStatus = 'deleted';
  db.prepare('UPDATE memories SET metadata = ? WHERE id = ?')
    .run(JSON.stringify(corruptedMetadata), 'mem-normal');

  assert.throws(
    () => undoMemorySummaryArchiveBatch(db, {
      batchId: 'archive-batch-2026-06-02',
      characterId: 'char-1',
      now: '2026-06-02T10:30:00.000Z',
    }),
    /Invalid archive previousStatus/,
  );

  const memory = getMemory(db, 'mem-normal');
  assert.equal(memory.status, 'archived');
  assert.equal(memory.metadata.previousStatus, 'deleted');
  assert.equal(memory.metadata.archiveBatchId, 'archive-batch-2026-06-02');
  assert.equal(getMemory(db, 'summary-mem-1').status, 'active');
});

test('lists undoable archive batches by character and hides batches after undo', () => {
  const db = createArchiveTestDb();
  insertMemory(db, {
    id: 'mem-pinned',
    category: '偏好习惯',
    content: '主人喜欢夜间写作。',
    source_msg_ids: ['msg-1'],
    memory_kind: 'user_preference',
    status: 'active',
    pinned: true,
  });
  insertMemory(db, {
    id: 'mem-normal',
    category: '重要事件',
    content: '主人正在推进记忆系统升级。',
    source_msg_ids: ['msg-2'],
    memory_kind: 'open_thread',
    status: 'active',
    pinned: false,
  });
  insertMemory(db, {
    id: 'mem-other-character',
    character_id: 'char-2',
    content: '另一个角色的记忆。',
  });

  executeMemorySummaryArchive(db, {
    batchId: 'archive-batch-2026-06-02',
    characterId: 'char-1',
    summaryMemoryId: 'summary-mem-1',
    summaryContent: '主人偏好夜间写作，近期在推进记忆系统升级。',
    coveredMemoryIds: ['mem-pinned', 'mem-normal'],
    now: '2026-06-02T10:00:00.000Z',
  });

  const batches = listUndoableMemoryArchiveBatches(db, 'char-1');
  assert.deepEqual(batches, [{
    batch_id: 'archive-batch-2026-06-02',
    summary_memory_id: 'summary-mem-1',
    summary_content: '主人偏好夜间写作，近期在推进记忆系统升级。',
    covered_count: 2,
    updated_at: '2026-06-02T10:00:00.000Z',
  }]);
  assert.deepEqual(listUndoableMemoryArchiveBatches(db, 'char-2'), []);

  undoMemorySummaryArchiveBatch(db, {
    batchId: 'archive-batch-2026-06-02',
    characterId: 'char-1',
    now: '2026-06-02T10:30:00.000Z',
  });

  assert.deepEqual(listUndoableMemoryArchiveBatches(db, 'char-1'), []);
});

test('归档拒绝把已是 summary 的记忆再次纳入新批次(防止 archiveBatchId 被覆盖、原批次撤销链路损坏)', () => {
  const db = createArchiveTestDb();
  insertMemory(db, { id: 'mem-a', status: 'active' });
  insertMemory(db, { id: 'mem-b', status: 'active' });

  executeMemorySummaryArchive(db, {
    batchId: 'batch-A',
    characterId: 'char-1',
    summaryMemoryId: 'summary-A',
    summaryContent: '批次 A 摘要',
    coveredMemoryIds: ['mem-a', 'mem-b'],
    now: '2026-06-02T10:00:00.000Z',
  });

  // summary-A 此时是 status='active' 的归档摘要;把它连同新记忆归档为批次 B 必须被拒绝。
  insertMemory(db, { id: 'mem-c', status: 'active' });
  assert.throws(
    () => executeMemorySummaryArchive(db, {
      batchId: 'batch-B',
      characterId: 'char-1',
      summaryMemoryId: 'summary-B',
      summaryContent: '批次 B 摘要',
      coveredMemoryIds: ['summary-A', 'mem-c'],
      now: '2026-06-02T11:00:00.000Z',
    }),
    /re-archived/,
  );

  // 原批次 A 的撤销链路完好:summary-A 的 archiveBatchId 未被篡改成 batch-B。
  const summaryRow = db.prepare("SELECT json_extract(metadata, '$.archiveBatchId') AS bid FROM memories WHERE id = 'summary-A'").get();
  assert.equal(summaryRow.bid, 'batch-A');
});

test('归档拒绝把非 active 记忆纳入(防止 previousStatus 被污染导致 undo 还原到错误状态)', () => {
  const db = createArchiveTestDb();
  insertMemory(db, { id: 'mem-archived', status: 'archived' });
  assert.throws(
    () => executeMemorySummaryArchive(db, {
      batchId: 'batch-X',
      characterId: 'char-1',
      summaryMemoryId: 'summary-X',
      summaryContent: '摘要',
      coveredMemoryIds: ['mem-archived'],
      now: '2026-06-02T10:00:00.000Z',
    }),
    /active/,
  );
});
