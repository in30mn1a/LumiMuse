const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const Database = require('better-sqlite3');
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

const { allocateAssistantInsertAfterUser } = require('../src/lib/message-seq-insert.ts');
const { resolveConversationChain, buildChainMessageScope } = require('../src/lib/conversation-chain.ts');

function createSchema(db) {
  db.exec(`
    CREATE TABLE conversations (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL DEFAULT '',
      parent_id TEXT,
      parent_seq_end INTEGER
    );
    CREATE TABLE messages (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      token_count INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      seq INTEGER NOT NULL,
      metadata TEXT
    );
  `);
}

function seedConversation(db) {
  createSchema(db);
  db.prepare(`INSERT INTO conversations (id) VALUES ('conv-a')`).run();
  db.prepare(`
    INSERT INTO messages (id, conversation_id, role, content, token_count, created_at, seq, metadata)
    VALUES
      ('user-1', 'conv-a', 'user', 'first', 1, '2026-07-10T10:00:00.000Z', 1, '{}'),
      ('user-2', 'conv-a', 'user', 'second', 1, '2026-07-10T10:10:00.000Z', 3, '{}')
  `).run();
}

test('allocateAssistantInsertAfterUser shifts later messages and returns slot after anchor user', () => {
  const db = new Database(':memory:');
  seedConversation(db);

  // 调用方必须把 allocate 与 INSERT 包在同一事务里（本测试模拟完整插入）
  let slot;
  db.transaction(() => {
    slot = allocateAssistantInsertAfterUser(db, 'conv-a', 'user-1');
    assert.ok(slot);
    db.prepare(`
      INSERT INTO messages (id, conversation_id, role, content, token_count, created_at, seq, metadata)
      VALUES ('asst-mid', 'conv-a', 'assistant', 'inserted', 1, ?, ?, '{}')
    `).run(slot.createdAt, slot.seq);
  })();

  assert.equal(slot.seq, 2);

  const rows = db.prepare(`
    SELECT id, seq, created_at
    FROM messages
    WHERE conversation_id = 'conv-a'
    ORDER BY seq ASC
  `).all();

  assert.deepEqual(rows.map(row => row.id), ['user-1', 'asst-mid', 'user-2']);
  assert.deepEqual(rows.map(row => row.seq), [1, 2, 4]);
  assert.ok(Date.parse(slot.createdAt) > Date.parse('2026-07-10T10:00:00.000Z'));
  assert.ok(Date.parse(slot.createdAt) < Date.parse('2026-07-10T10:10:00.000Z'));
});

test('allocateAssistantInsertAfterUser returns null for missing or non-user anchor without writing', () => {
  const db = new Database(':memory:');
  seedConversation(db);

  const missing = allocateAssistantInsertAfterUser(db, 'conv-a', 'no-such-user');
  assert.equal(missing, null);

  const seqsBefore = db.prepare(`SELECT id, seq FROM messages WHERE conversation_id = 'conv-a' ORDER BY seq ASC`).all();
  assert.deepEqual(seqsBefore.map(row => row.seq), [1, 3]);
});

function seedChain(db) {
  createSchema(db);
  db.prepare(`INSERT INTO conversations (id, parent_id, parent_seq_end) VALUES ('parent', NULL, NULL)`).run();
  db.prepare(`INSERT INTO conversations (id, parent_id, parent_seq_end) VALUES ('child', 'parent', 3)`).run();
  db.prepare(`
    INSERT INTO messages (id, conversation_id, role, content, token_count, created_at, seq, metadata)
    VALUES
      ('p-1', 'parent', 'user',      'p1', 1, '2026-07-10T10:00:00.000Z', 1, '{}'),
      ('p-2', 'parent', 'assistant', 'p2', 1, '2026-07-10T10:01:00.000Z', 2, '{}'),
      ('p-3', 'parent', 'user',      'p3', 1, '2026-07-10T10:02:00.000Z', 3, '{}'),
      ('c-4', 'child',  'assistant', 'c4', 1, '2026-07-10T11:00:00.000Z', 4, '{}'),
      ('c-5', 'child',  'user',      'c5', 1, '2026-07-10T11:01:00.000Z', 5, '{}')
  `).run();
}

function visibleIds(db, conversationId) {
  const scope = buildChainMessageScope(resolveConversationChain(db, conversationId));
  return db.prepare(
    `SELECT id FROM messages WHERE ${scope.sql} ORDER BY seq ASC`,
  ).all(...scope.params).map(row => row.id);
}

test('inserting after an inherited message keeps the child chain intact by shifting parent_seq_end', () => {
  const db = new Database(':memory:');
  seedChain(db);
  assert.deepEqual(visibleIds(db, 'child'), ['p-1', 'p-2', 'p-3', 'c-4', 'c-5']);

  db.transaction(() => {
    // 锚点是从父对话继承来的历史消息
    const slot = allocateAssistantInsertAfterUser(db, 'child', 'p-1');
    assert.ok(slot);
    assert.equal(slot.seq, 2);
    db.prepare(`
      INSERT INTO messages (id, conversation_id, role, content, token_count, created_at, seq, metadata)
      VALUES ('asst-new', 'child', 'assistant', 'inserted', 1, ?, ?, '{}')
    `).run(slot.createdAt, slot.seq);
  })();

  // 父对话边界那条（p-3）被右移到 4，parent_seq_end 必须跟着变成 4，否则 child 会看不见它
  const parentSeqEnd = db.prepare(`SELECT parent_seq_end FROM conversations WHERE id = 'child'`).get().parent_seq_end;
  assert.equal(parentSeqEnd, 4);
  assert.deepEqual(visibleIds(db, 'child'), ['p-1', 'asst-new', 'p-2', 'p-3', 'c-4', 'c-5']);
});

test('inserting after the boundary message does not expand the inherited range', () => {
  const db = new Database(':memory:');
  seedChain(db);

  db.transaction(() => {
    // p-3 正是 parent_seq_end 指向的边界；新槽位归 child 所有，父边界不应扩张
    const slot = allocateAssistantInsertAfterUser(db, 'child', 'p-3');
    assert.ok(slot);
    assert.equal(slot.seq, 4);
    db.prepare(`
      INSERT INTO messages (id, conversation_id, role, content, token_count, created_at, seq, metadata)
      VALUES ('asst-tail', 'child', 'assistant', 'inserted', 1, ?, ?, '{}')
    `).run(slot.createdAt, slot.seq);
  })();

  const parentSeqEnd = db.prepare(`SELECT parent_seq_end FROM conversations WHERE id = 'child'`).get().parent_seq_end;
  assert.equal(parentSeqEnd, 3);
  assert.deepEqual(visibleIds(db, 'child'), ['p-1', 'p-2', 'p-3', 'asst-tail', 'c-4', 'c-5']);
});

function insertConversation(db, id, parentId = null, parentSeqEnd = null) {
  db.prepare(`
    INSERT INTO conversations (id, parent_id, parent_seq_end)
    VALUES (?, ?, ?)
  `).run(id, parentId, parentSeqEnd);
}

function insertMessage(db, id, conversationId, role, seq) {
  db.prepare(`
    INSERT INTO messages (id, conversation_id, role, content, token_count, created_at, seq, metadata)
    VALUES (?, ?, ?, ?, 1, ?, ?, '{}')
  `).run(
    id,
    conversationId,
    role,
    id,
    `2026-07-10T12:${String(seq).padStart(2, '0')}:00.000Z`,
    seq,
  );
}

function insertAfter(db, conversationId, anchorId, messageId) {
  db.transaction(() => {
    const slot = allocateAssistantInsertAfterUser(db, conversationId, anchorId);
    assert.ok(slot);
    db.prepare(`
      INSERT INTO messages (id, conversation_id, role, content, token_count, created_at, seq, metadata)
      VALUES (?, ?, 'assistant', ?, 1, ?, ?, '{}')
    `).run(messageId, conversationId, messageId, slot.createdAt, slot.seq);
  })();
}

function physicalSeqs(db, conversationId) {
  return db.prepare(`
    SELECT id, seq
    FROM messages
    WHERE conversation_id = ?
    ORDER BY seq ASC, id ASC
  `).all(conversationId);
}

test('inserting in a child shifts parent growth outside its snapshot without leaking it', () => {
  const db = new Database(':memory:');
  createSchema(db);
  insertConversation(db, 'parent');
  insertConversation(db, 'child', 'parent', 3);
  insertMessage(db, 'p-1', 'parent', 'user', 1);
  insertMessage(db, 'p-2', 'parent', 'assistant', 2);
  insertMessage(db, 'p-3', 'parent', 'user', 3);
  insertMessage(db, 'p-late', 'parent', 'assistant', 4);
  insertMessage(db, 'c-4', 'child', 'assistant', 4);

  insertAfter(db, 'child', 'p-1', 'c-inserted');

  assert.deepEqual(physicalSeqs(db, 'parent'), [
    { id: 'p-1', seq: 1 },
    { id: 'p-2', seq: 3 },
    { id: 'p-3', seq: 4 },
    { id: 'p-late', seq: 5 },
  ]);
  assert.deepEqual(physicalSeqs(db, 'child'), [
    { id: 'c-inserted', seq: 2 },
    { id: 'c-4', seq: 5 },
  ]);
  assert.equal(
    db.prepare(`SELECT parent_seq_end FROM conversations WHERE id = 'child'`).get().parent_seq_end,
    4,
  );
  assert.deepEqual(visibleIds(db, 'child'), ['p-1', 'c-inserted', 'p-2', 'p-3', 'c-4']);
});

test('inserting through one branch keeps sibling snapshots unique and isolated', () => {
  const db = new Database(':memory:');
  createSchema(db);
  insertConversation(db, 'root');
  insertConversation(db, 'branch-a', 'root', 3);
  insertConversation(db, 'branch-b', 'root', 3);
  insertMessage(db, 'r-1', 'root', 'user', 1);
  insertMessage(db, 'r-2', 'root', 'assistant', 2);
  insertMessage(db, 'r-3', 'root', 'user', 3);
  insertMessage(db, 'a-4', 'branch-a', 'assistant', 4);
  insertMessage(db, 'b-4', 'branch-b', 'assistant', 4);

  insertAfter(db, 'branch-a', 'r-1', 'a-inserted');

  assert.deepEqual(
    db.prepare(`SELECT id, parent_seq_end FROM conversations WHERE parent_id = 'root' ORDER BY id`).all(),
    [
      { id: 'branch-a', parent_seq_end: 4 },
      { id: 'branch-b', parent_seq_end: 4 },
    ],
  );
  assert.deepEqual(physicalSeqs(db, 'branch-a'), [
    { id: 'a-inserted', seq: 2 },
    { id: 'a-4', seq: 5 },
  ]);
  assert.deepEqual(physicalSeqs(db, 'branch-b'), [{ id: 'b-4', seq: 5 }]);
  assert.deepEqual(visibleIds(db, 'branch-a'), ['r-1', 'a-inserted', 'r-2', 'r-3', 'a-4']);
  assert.deepEqual(visibleIds(db, 'branch-b'), ['r-1', 'r-2', 'r-3', 'b-4']);
});

test('inserting through a multi-level descendant shifts every affected boundary and tail', () => {
  const db = new Database(':memory:');
  createSchema(db);
  insertConversation(db, 'root');
  insertConversation(db, 'middle', 'root', 3);
  insertConversation(db, 'leaf', 'middle', 4);
  insertMessage(db, 'r-1', 'root', 'user', 1);
  insertMessage(db, 'r-2', 'root', 'assistant', 2);
  insertMessage(db, 'r-3', 'root', 'user', 3);
  insertMessage(db, 'm-4', 'middle', 'assistant', 4);
  insertMessage(db, 'l-5', 'leaf', 'assistant', 5);

  insertAfter(db, 'leaf', 'r-1', 'l-inserted');

  assert.deepEqual(
    db.prepare(`SELECT id, parent_seq_end FROM conversations WHERE id IN ('middle', 'leaf') ORDER BY id`).all(),
    [
      { id: 'leaf', parent_seq_end: 5 },
      { id: 'middle', parent_seq_end: 4 },
    ],
  );
  assert.deepEqual(physicalSeqs(db, 'middle'), [{ id: 'm-4', seq: 5 }]);
  assert.deepEqual(physicalSeqs(db, 'leaf'), [
    { id: 'l-inserted', seq: 2 },
    { id: 'l-5', seq: 6 },
  ]);
  assert.deepEqual(visibleIds(db, 'leaf'), ['r-1', 'l-inserted', 'r-2', 'r-3', 'm-4', 'l-5']);
});

test('a sibling frozen exactly at the anchor does not shift or inherit the inserted reply', () => {
  const db = new Database(':memory:');
  createSchema(db);
  insertConversation(db, 'root');
  insertConversation(db, 'branch-a', 'root', 3);
  insertConversation(db, 'branch-b', 'root', 3);
  insertMessage(db, 'r-1', 'root', 'user', 1);
  insertMessage(db, 'r-2', 'root', 'assistant', 2);
  insertMessage(db, 'r-3', 'root', 'user', 3);
  insertMessage(db, 'a-4', 'branch-a', 'assistant', 4);
  insertMessage(db, 'b-4', 'branch-b', 'assistant', 4);

  insertAfter(db, 'branch-a', 'r-3', 'a-inserted');

  assert.deepEqual(physicalSeqs(db, 'branch-a'), [
    { id: 'a-inserted', seq: 4 },
    { id: 'a-4', seq: 5 },
  ]);
  assert.deepEqual(physicalSeqs(db, 'branch-b'), [{ id: 'b-4', seq: 4 }]);
  assert.deepEqual(visibleIds(db, 'branch-b'), ['r-1', 'r-2', 'r-3', 'b-4']);
});
