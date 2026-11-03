const test = require('node:test');
const assert = require('node:assert/strict');
const { installMemoryOnlyTestGuard } = require('./helpers/memory-only-test-guard.cjs');

installMemoryOnlyTestGuard(test);

const Database = require('better-sqlite3');
const { registerTsLoader } = require('./helpers/register-ts-loader.cjs');

registerTsLoader();

const { __migrateForTests, __setDbForTests } = require('../src/lib/db.ts');
const { stopMemoryIndexProcessing } = require('../src/lib/memory-index-trigger.ts');
const {
  applyMemoryUpdate,
  createMemoryRow,
  loadArchiveSources,
  memoryBusinessSnapshot,
} = require('../src/lib/memory-mutations.ts');

const NOW = '2026-11-03T00:00:00.000Z';

function createDb(t) {
  const db = new Database(':memory:');
  __migrateForTests(db);
  __setDbForTests(db);
  db.prepare(`INSERT INTO characters (id, name) VALUES ('char-1', 'Fixture')`).run();
  t.after(() => {
    stopMemoryIndexProcessing();
    __setDbForTests(null);
    db.close();
  });
  return db;
}

function addMemory(db, overrides = {}) {
  return createMemoryRow(db, {
    character_id: 'char-1',
    category: 'preference',
    content: 'fixture memory',
    ...overrides,
  }, NOW);
}

function rowById(db, id) {
  return db.prepare('SELECT * FROM memories WHERE id = ?').get(id);
}

function embeddingTasks(db, id) {
  return db.prepare('SELECT COUNT(*) AS count FROM memory_embedding_tasks WHERE memory_id = ?').get(id).count;
}

function snapshotText(row) {
  return JSON.stringify(memoryBusinessSnapshot(row));
}

test('snapshot covers business fields and excludes usage and time columns', t => {
  const db = createDb(t);
  const snapshot = memoryBusinessSnapshot(rowById(db, addMemory(db).id));
  assert.deepEqual(Object.keys(snapshot).sort(), [
    'category',
    'confidence',
    'content',
    'emotional_weight',
    'importance',
    'memory_kind',
    'metadata',
    'pinned',
    'source_msg_ids',
    'status',
    'tags',
  ]);
});

test('snapshot changes with source_msg_ids, confidence and metadata', t => {
  const db = createDb(t);
  const { id } = addMemory(db);
  const before = snapshotText(rowById(db, id));

  for (const sql of [
    `UPDATE memories SET source_msg_ids = '["m1"]' WHERE id = ?`,
    `UPDATE memories SET confidence = 0.1 WHERE id = ?`,
    `UPDATE memories SET metadata = '{"note":"x"}' WHERE id = ?`,
  ]) {
    const savepoint = rowById(db, id);
    db.prepare(sql).run(id);
    assert.notEqual(snapshotText(rowById(db, id)), before, sql);
    db.prepare('UPDATE memories SET source_msg_ids = ?, confidence = ?, metadata = ? WHERE id = ?')
      .run(savepoint.source_msg_ids, savepoint.confidence, savepoint.metadata, id);
  }
  assert.equal(snapshotText(rowById(db, id)), before);
});

test('snapshot ignores usage_count, last_used_at and timestamps', t => {
  const db = createDb(t);
  const { id } = addMemory(db);
  const before = snapshotText(rowById(db, id));
  db.prepare(`
    UPDATE memories
    SET usage_count = 99, last_used_at = '2030-01-01', created_at = '2030-01-01', updated_at = '2030-01-01'
    WHERE id = ?
  `).run(id);
  assert.equal(snapshotText(rowById(db, id)), before);
});

test('snapshot compares parsed JSON rather than its spelling', t => {
  const db = createDb(t);
  const { id } = addMemory(db);
  db.prepare(`UPDATE memories SET metadata = '{"a":1,"b":{"c":2,"d":3}}', tags = '["x"]' WHERE id = ?`).run(id);
  const before = snapshotText(rowById(db, id));
  db.prepare(`UPDATE memories SET metadata = '{ "b": { "d": 3, "c": 2 }, "a": 1 }', tags = '[ "x" ]' WHERE id = ?`).run(id);
  assert.equal(snapshotText(rowById(db, id)), before);
});

test('corrupt JSON stays distinguishable from an empty value', t => {
  const db = createDb(t);
  const { id } = addMemory(db);
  const before = snapshotText(rowById(db, id));
  db.prepare(`UPDATE memories SET metadata = 'not json' WHERE id = ?`).run(id);
  assert.notEqual(snapshotText(rowById(db, id)), before);
});

test('applyMemoryUpdate reports each outcome', t => {
  const db = createDb(t);
  const { id } = addMemory(db);
  assert.equal(applyMemoryUpdate(db, 'missing', { content: 'x' }, NOW), 'not_found');
  assert.equal(applyMemoryUpdate(db, id, {}, NOW), 'no_fields');
  assert.equal(applyMemoryUpdate(db, id, { content: 'changed', pinned: true }, '2026-11-04T00:00:00.000Z'), 'updated');
  const row = rowById(db, id);
  assert.equal(row.content, 'changed');
  assert.equal(row.pinned, 1);
  assert.equal(row.updated_at, '2026-11-04T00:00:00.000Z');
});

test('applyMemoryUpdate enqueues embedding only for fields that affect the index', t => {
  const db = createDb(t);
  const { id } = addMemory(db);
  db.prepare('DELETE FROM memory_embedding_tasks').run();

  applyMemoryUpdate(db, id, { usage_count: 3, confidence: 0.4 }, NOW);
  assert.equal(embeddingTasks(db, id), 0);

  applyMemoryUpdate(db, id, { status: 'superseded' }, NOW);
  assert.equal(embeddingTasks(db, id), 1);
});

test('createMemoryRow applies category defaults and enqueues embedding', t => {
  const db = createDb(t);
  const row = addMemory(db, { tags: ['a'], metadata: { note: 'n' } });
  assert.equal(row.character_id, 'char-1');
  assert.equal(row.confidence, 0.9);
  assert.equal(row.status, 'active');
  assert.equal(row.source_msg_ids, '[]');
  assert.equal(row.tags, '["a"]');
  assert.equal(row.created_at, NOW);
  assert.equal(embeddingTasks(db, row.id), 1);
});

test('loadArchiveSources validates ownership and archivability', t => {
  const db = createDb(t);
  db.prepare(`INSERT INTO characters (id, name) VALUES ('char-2', 'Other')`).run();
  const active = addMemory(db, { tags: ['a'] });
  const second = addMemory(db);
  const archived = addMemory(db, { status: 'archived' });
  const summary = addMemory(db, { metadata: { archiveRole: 'summary' } });
  const batched = addMemory(db, { metadata: { archiveBatchId: 'b1' } });
  const foreign = addMemory(db, { character_id: 'char-2' });

  const ok = loadArchiveSources(db, 'char-1', [second.id, active.id]);
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.sources.map(source => source.id), [second.id, active.id]);
  assert.deepEqual(ok.sources[1].tags, ['a']);
  assert.equal(ok.sources[1].pinned, false);

  assert.deepEqual(loadArchiveSources(db, 'char-1', [active.id, 'missing']), { ok: false, reason: 'not_found' });
  assert.deepEqual(loadArchiveSources(db, 'char-1', [active.id, foreign.id]), { ok: false, reason: 'not_found' });
  for (const invalid of [archived, summary, batched]) {
    assert.deepEqual(loadArchiveSources(db, 'char-1', [active.id, invalid.id]), { ok: false, reason: 'not_archivable' });
  }
});
