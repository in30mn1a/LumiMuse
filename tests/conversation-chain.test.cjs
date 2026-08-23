const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const Database = require('better-sqlite3');
const ts = require('typescript');

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
  ascendingMessageOrderSqlForChain,
  buildChainMessageScope,
  descendingMessageOrderSqlForChain,
  nextChainSeq,
  resolveConversationChain,
} = require('../src/lib/conversation-chain.ts');

test('message ordering keeps single-conversation legacy order and uses seq for linked views', () => {
  assert.equal(
    ascendingMessageOrderSqlForChain([{ conversationId: 'single', seqEnd: null }]),
    'created_at ASC, seq ASC',
  );
  assert.equal(
    ascendingMessageOrderSqlForChain([
      { conversationId: 'root', seqEnd: 3 },
      { conversationId: 'child', seqEnd: null },
    ]),
    'seq ASC, created_at ASC, id ASC',
  );
  assert.equal(
    descendingMessageOrderSqlForChain([{ conversationId: 'single', seqEnd: null }]),
    'created_at DESC, seq DESC',
  );
  assert.equal(
    descendingMessageOrderSqlForChain([
      { conversationId: 'root', seqEnd: 3 },
      { conversationId: 'child', seqEnd: null },
    ]),
    'seq DESC, created_at DESC, id DESC',
  );
});

function createDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE conversations (
      id TEXT PRIMARY KEY,
      parent_id TEXT,
      parent_seq_end INTEGER
    );
    CREATE TABLE messages (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL,
      seq INTEGER NOT NULL
    );
  `);
  return db;
}

function insertConversation(db, id, parentId = null, parentSeqEnd = null) {
  db.prepare(`
    INSERT INTO conversations (id, parent_id, parent_seq_end)
    VALUES (?, ?, ?)
  `).run(id, parentId, parentSeqEnd);
}

function insertMessage(db, id, conversationId, seq) {
  db.prepare(`INSERT INTO messages (id, conversation_id, seq) VALUES (?, ?, ?)`)
    .run(id, conversationId, seq);
}

test('resolveConversationChain returns every segment in a legal chain longer than 64', () => {
  const db = createDb();
  insertConversation(db, 'c0');
  for (let index = 1; index < 70; index += 1) {
    insertConversation(db, `c${index}`, `c${index - 1}`, 100);
  }

  const chain = resolveConversationChain(db, 'c69');

  assert.equal(chain.length, 70);
  assert.equal(chain[0].conversationId, 'c0');
  assert.equal(chain[69].conversationId, 'c69');
  assert.equal(chain[0].seqEnd, 100);
  assert.equal(chain[69].seqEnd, null);
});

test('message scope executes beyond SQLite inline expression depth without truncating the chain', () => {
  const db = createDb();
  const segmentCount = 1100;
  db.transaction(() => {
    insertConversation(db, 'deep-0');
    insertMessage(db, 'deep-message-0', 'deep-0', 1);
    for (let index = 1; index < segmentCount; index += 1) {
      insertConversation(db, `deep-${index}`, `deep-${index - 1}`, index);
      insertMessage(db, `deep-message-${index}`, `deep-${index}`, index + 1);
    }
  })();

  const chain = resolveConversationChain(db, `deep-${segmentCount - 1}`);
  const scope = buildChainMessageScope(chain);
  const visible = db.prepare(`
    SELECT COUNT(*) AS count
    FROM messages
    WHERE ${scope.sql}
  `).get(...scope.params);

  assert.equal(chain.length, segmentCount);
  assert.equal(scope.params.length, 1);
  assert.equal(visible.count, segmentCount);
});

test('descendant cutoff constrains the complete parent view all the way to the root', () => {
  const db = createDb();
  insertConversation(db, 'root');
  insertConversation(db, 'child', 'root', 5);
  insertConversation(db, 'grandchild', 'child', 4);
  for (let seq = 1; seq <= 5; seq += 1) insertMessage(db, `r-${seq}`, 'root', seq);

  const chain = resolveConversationChain(db, 'grandchild');
  assert.deepEqual(chain, [
    { conversationId: 'root', seqEnd: 4 },
    { conversationId: 'child', seqEnd: 4 },
    { conversationId: 'grandchild', seqEnd: null },
  ]);

  const scope = buildChainMessageScope(chain);
  const visible = db.prepare(`
    SELECT id FROM messages WHERE ${scope.sql} ORDER BY seq
  `).all(...scope.params).map(row => row.id);
  assert.deepEqual(visible, ['r-1', 'r-2', 'r-3', 'r-4']);
});

test('resolveConversationChain fails fast for cycles and broken parent links', () => {
  const cycleDb = createDb();
  insertConversation(cycleDb, 'a', 'b', 1);
  insertConversation(cycleDb, 'b', 'a', 1);
  assert.throws(
    () => resolveConversationChain(cycleDb, 'a'),
    /cycle detected/,
  );

  const missingDb = createDb();
  insertConversation(missingDb, 'child', 'missing-parent', 1);
  assert.throws(
    () => resolveConversationChain(missingDb, 'child'),
    /parent not found/,
  );
});

test('resolveConversationChain rejects inconsistent or invalid boundaries', () => {
  for (const row of [
    { id: 'missing-end', parentId: 'root', parentSeqEnd: null },
    { id: 'missing-parent', parentId: null, parentSeqEnd: 1 },
    { id: 'negative', parentId: 'root', parentSeqEnd: -1 },
    { id: 'fractional', parentId: 'root', parentSeqEnd: 1.5 },
  ]) {
    const db = createDb();
    insertConversation(db, 'root');
    insertConversation(db, row.id, row.parentId, row.parentSeqEnd);
    assert.throws(
      () => resolveConversationChain(db, row.id),
      /Invalid conversation chain link/,
      row.id,
    );
  }
});

test('a missing requested conversation preserves the legacy single empty scope', () => {
  const db = createDb();

  assert.deepEqual(resolveConversationChain(db, 'missing'), [
    { conversationId: 'missing', seqEnd: null },
  ]);
});

test('nextChainSeq does not reuse a deleted parent snapshot boundary', () => {
  const db = createDb();
  insertConversation(db, 'parent');
  insertConversation(db, 'child', 'parent', 5);
  for (let seq = 1; seq <= 5; seq += 1) insertMessage(db, `p-${seq}`, 'parent', seq);
  db.prepare(`DELETE FROM messages WHERE id = 'p-5'`).run();

  const nextSeq = nextChainSeq(db, 'parent');
  assert.equal(nextSeq, 6);
  insertMessage(db, 'p-new', 'parent', nextSeq);

  const childScope = buildChainMessageScope(resolveConversationChain(db, 'child'));
  const childVisible = db.prepare(`
    SELECT id FROM messages WHERE ${childScope.sql} ORDER BY seq
  `).all(...childScope.params).map(row => row.id);
  assert.deepEqual(childVisible, ['p-1', 'p-2', 'p-3', 'p-4']);
});

test('nextChainSeq keeps a child own tail beyond its inherited boundary after deletion', () => {
  const db = createDb();
  insertConversation(db, 'parent');
  insertConversation(db, 'child', 'parent', 5);
  for (let seq = 1; seq <= 5; seq += 1) insertMessage(db, `p-${seq}`, 'parent', seq);
  db.prepare(`DELETE FROM messages WHERE id = 'p-5'`).run();

  assert.equal(nextChainSeq(db, 'child'), 6);
});

test('nextChainSeq also respects a deleted tail frozen by a direct descendant', () => {
  const db = createDb();
  insertConversation(db, 'root');
  insertConversation(db, 'child', 'root', 3);
  insertConversation(db, 'grandchild', 'child', 10);
  insertMessage(db, 'r-1', 'root', 1);
  insertMessage(db, 'r-2', 'root', 2);
  insertMessage(db, 'r-3', 'root', 3);
  insertMessage(db, 'c-10', 'child', 10);
  db.prepare(`DELETE FROM messages WHERE id = 'c-10'`).run();

  assert.equal(nextChainSeq(db, 'child'), 11);
});
