const test = require('node:test');
const assert = require('node:assert/strict');
const { installMemoryOnlyTestGuard } = require('./helpers/memory-only-test-guard.cjs');

installMemoryOnlyTestGuard(test);

const Database = require('better-sqlite3');
const { registerTsLoader } = require('./helpers/register-ts-loader.cjs');

registerTsLoader();

const { __migrateForTests, __setDbForTests } = require('../src/lib/db.ts');
const { stopMemoryIndexProcessing } = require('../src/lib/memory-index-trigger.ts');
const { searchMessages } = require('../src/lib/message-search.ts');
const { getMemorySystemStatus } = require('../src/lib/memory-status.ts');
const { recallMemoriesByVector } = require('../src/lib/memory-extraction-reference.ts');
const { embeddingToBlob } = require('../src/lib/memory-embeddings.ts');

function createDb(t) {
  const db = new Database(':memory:');
  __migrateForTests(db);
  __setDbForTests(db);
  db.prepare(`INSERT INTO characters (id, name) VALUES ('char-1', 'Fixture')`).run();
  db.prepare(`INSERT INTO characters (id, name) VALUES ('char-2', 'Other')`).run();
  db.prepare(`INSERT INTO conversations (id, character_id, title) VALUES ('conv-1', 'char-1', 'First')`).run();
  db.prepare(`INSERT INTO conversations (id, character_id, title) VALUES ('conv-2', 'char-2', 'Second')`).run();
  t.after(() => {
    stopMemoryIndexProcessing();
    __setDbForTests(null);
    db.close();
  });
  return db;
}

function addMessage(db, id, conversationId, content, createdAt = '2026-03-30T12:00:00.000Z') {
  db.prepare(`
    INSERT INTO messages (id, conversation_id, role, content, created_at)
    VALUES (?, ?, 'user', ?, ?)
  `).run(id, conversationId, content, createdAt);
}

test('searchMessages finds keywords, filters by character and pages', t => {
  const db = createDb(t);
  addMessage(db, 'm1', 'conv-1', '今天想吃甜点');
  addMessage(db, 'm2', 'conv-2', '甜点也不错');
  addMessage(db, 'm3', 'conv-1', '甜点第二条');

  const all = searchMessages(db, { q: '甜点', characterId: null, limit: 10, offset: 0 });
  assert.equal(all.results.length, 3);
  assert.equal(all.hasMore, false);

  const scoped = searchMessages(db, { q: '甜点', characterId: 'char-1', limit: 1, offset: 0 });
  assert.equal(scoped.results.length, 1);
  assert.equal(scoped.results[0].characterId, 'char-1');
  assert.equal(scoped.hasMore, true);
  assert.deepEqual(scoped.results[0].highlightRanges.map(range => range.text), ['甜点']);
});

test('searchMessages parses a date query in the requested time zone', t => {
  const db = createDb(t);
  // 上海 3 月 30 日 00:30 = UTC 3 月 29 日 16:30
  addMessage(db, 'early', 'conv-1', 'no keyword here', '2026-03-29T16:30:00.000Z');
  addMessage(db, 'other-day', 'conv-1', 'no keyword here', '2026-03-29T15:30:00.000Z');

  const result = searchMessages(db, {
    q: '2026-03-30',
    characterId: null,
    limit: 10,
    offset: 0,
    timeZone: 'Asia/Shanghai',
  });
  assert.deepEqual(result.results.map(item => item.messageId), ['early']);
});

test('getMemorySystemStatus returns every section with zeroed counts', t => {
  const db = createDb(t);
  const status = getMemorySystemStatus(db);
  assert.deepEqual(Object.keys(status), [
    'character_id',
    'index',
    'tasks',
    'queues',
    'candidates',
    'profile',
    'archive',
  ]);
  assert.equal(status.character_id, null);
  assert.deepEqual(status.queues.extraction, { pending: 0, processing: 0, failed: 0 });
  assert.deepEqual(status.archive, { archived: 0, summarized: 0 });
  assert.deepEqual(status.profile, { exists: false, filled_fields: 0 });
});

test('getMemorySystemStatus scopes counts to a character', t => {
  const db = createDb(t);
  const insert = db.prepare(`
    INSERT INTO memories (id, character_id, category, content, status)
    VALUES (?, ?, 'preference', 'fixture', 'archived')
  `);
  insert.run('a1', 'char-1');
  insert.run('a2', 'char-2');
  assert.equal(getMemorySystemStatus(db).archive.archived, 2);
  const scoped = getMemorySystemStatus(db, 'char-1');
  assert.equal(scoped.character_id, 'char-1');
  assert.equal(scoped.archive.archived, 1);
});

test('getMemorySystemStatus reads settings from the same isolated database', t => {
  const db = createDb(t);
  db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(
    'memory_engine',
    JSON.stringify({ embedding_model: 'fixture-embedding', embedding_dimension: 2 }),
  );

  const status = getMemorySystemStatus(db);
  assert.equal(status.index.target_model, 'fixture-embedding');
  assert.equal(status.index.target_dimension, 2);
});

const VECTOR_CONFIG = {
  embedding_api_base: 'http://embedding.test/v1',
  embedding_api_key: 'test-key',
  embedding_model: 'model-a',
  embedding_dimension: 2,
  embedding_timeout_ms: 1000,
};

test('recallMemoriesByVector embeds the given anchors and merges by best score', async () => {
  let embedded;
  const rows = [
    { memory_id: 'near-first', embedding_blob: embeddingToBlob([1, 0]) },
    { memory_id: 'near-second', embedding_blob: embeddingToBlob([0, 1]) },
  ];
  const result = await recallMemoriesByVector('char-1', ['first anchor', 'second anchor'], VECTOR_CONFIG, {
    embedTexts: async texts => {
      embedded = texts;
      return [[1, 0], [0.6, 0.8]];
    },
    loadEmbeddingRows: () => rows,
    loadMemoriesByIds: ids => ids.map(id => ({ id })),
  });
  assert.deepEqual(embedded, ['first anchor', 'second anchor']);
  assert.equal(result.failure, undefined);
  assert.deepEqual(result.memories.map(memory => memory.id).sort(), ['near-first', 'near-second']);
  assert.equal(result.memories[0].id, 'near-first');
});

test('recallMemoriesByVector reports failures instead of throwing', async () => {
  const result = await recallMemoriesByVector('char-1', ['anchor'], VECTOR_CONFIG, {
    embedTexts: async () => {
      throw new Error('embedding down');
    },
  });
  assert.deepEqual(result, { memories: [], failure: 'embedding down' });
});

test('recallMemoriesByVector falls back to loading active memories from the database', async t => {
  const db = createDb(t);
  const insert = db.prepare(`
    INSERT INTO memories (id, character_id, category, content, status)
    VALUES (?, 'char-1', 'preference', 'fixture', ?)
  `);
  insert.run('active-one', 'active');
  insert.run('retired-one', 'superseded');
  const result = await recallMemoriesByVector('char-1', ['anchor'], VECTOR_CONFIG, {
    embedTexts: async () => [[1, 0]],
    loadEmbeddingRows: () => [
      { memory_id: 'active-one', embedding_blob: embeddingToBlob([1, 0]) },
      { memory_id: 'retired-one', embedding_blob: embeddingToBlob([1, 0]) },
    ],
  });
  assert.deepEqual(result.memories.map(memory => memory.id), ['active-one']);
});
