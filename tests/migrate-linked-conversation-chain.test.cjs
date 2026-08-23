const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');

const {
  MigrationError,
  parseArgs,
  runMigrationOnDatabase,
} = require('../scripts/migrate-linked-conversation-chain.cjs');

const TARGET_CHARACTER_ID = 'fixture-character';
const TARGET_CONVERSATIONS = Object.freeze({
  root: Object.freeze({ id: 'fixture-root', title: '2026.5.12-2026.5.31' }),
  part3: Object.freeze({ id: 'fixture-part3', title: '2026.6.1-2026.7.2' }),
  part4: Object.freeze({ id: 'fixture-part4', title: '2026.7.3 - 2026.8.2' }),
  part5: Object.freeze({ id: 'fixture-part5', title: '2026.8.3 -' }),
});

function createSchema(db) {
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE characters (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL
    );
    CREATE TABLE conversations (
      id TEXT PRIMARY KEY,
      character_id TEXT NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      parent_id TEXT REFERENCES conversations(id),
      parent_seq_end INTEGER
    );
    CREATE INDEX idx_conversations_parent
      ON conversations(parent_id) WHERE parent_id IS NOT NULL;

    CREATE TABLE messages (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      token_count INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      seq INTEGER NOT NULL,
      metadata TEXT NOT NULL DEFAULT '{}'
    );
    CREATE INDEX idx_messages_seq ON messages(conversation_id, seq);

    CREATE TABLE memories (
      id TEXT PRIMARY KEY,
      character_id TEXT NOT NULL,
      source_msg_ids TEXT NOT NULL DEFAULT '[]',
      metadata TEXT NOT NULL DEFAULT '{}'
    );
    CREATE TABLE memory_tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      character_id TEXT NOT NULL,
      conversation_id TEXT NOT NULL,
      message_ids TEXT NOT NULL DEFAULT '[]',
      status TEXT NOT NULL
    );
    CREATE TABLE memory_extraction_candidates (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL,
      raw_candidate_json TEXT NOT NULL,
      raw_response TEXT NOT NULL,
      status TEXT NOT NULL
    );

    CREATE VIRTUAL TABLE messages_fts USING fts5(
      id UNINDEXED,
      content,
      role UNINDEXED,
      conversation_id UNINDEXED,
      created_at UNINDEXED,
      seq UNINDEXED
    );
    CREATE VIRTUAL TABLE messages_fts_trigram USING fts5(
      id UNINDEXED,
      content,
      role UNINDEXED,
      conversation_id UNINDEXED,
      created_at UNINDEXED,
      seq UNINDEXED,
      tokenize = 'trigram'
    );
    CREATE TRIGGER messages_fts_ai AFTER INSERT ON messages BEGIN
      INSERT INTO messages_fts(rowid, id, content, role, conversation_id, created_at, seq)
      VALUES (new.rowid, new.id, new.content, new.role, new.conversation_id, new.created_at, new.seq);
    END;
    CREATE TRIGGER messages_fts_au AFTER UPDATE OF content, role, conversation_id, created_at, seq ON messages BEGIN
      DELETE FROM messages_fts WHERE rowid = old.rowid;
      INSERT INTO messages_fts(rowid, id, content, role, conversation_id, created_at, seq)
      VALUES (new.rowid, new.id, new.content, new.role, new.conversation_id, new.created_at, new.seq);
    END;
    CREATE TRIGGER messages_fts_ad AFTER DELETE ON messages BEGIN
      DELETE FROM messages_fts WHERE rowid = old.rowid;
    END;
    CREATE TRIGGER messages_fts_trigram_ai AFTER INSERT ON messages BEGIN
      INSERT INTO messages_fts_trigram(rowid, id, content, role, conversation_id, created_at, seq)
      VALUES (new.rowid, new.id, new.content, new.role, new.conversation_id, new.created_at, new.seq);
    END;
    CREATE TRIGGER messages_fts_trigram_au AFTER UPDATE OF content, role, conversation_id, created_at, seq ON messages BEGIN
      DELETE FROM messages_fts_trigram WHERE rowid = old.rowid;
      INSERT INTO messages_fts_trigram(rowid, id, content, role, conversation_id, created_at, seq)
      VALUES (new.rowid, new.id, new.content, new.role, new.conversation_id, new.created_at, new.seq);
    END;
    CREATE TRIGGER messages_fts_trigram_ad AFTER DELETE ON messages BEGIN
      DELETE FROM messages_fts_trigram WHERE rowid = old.rowid;
    END;
  `);
}

function insertMessage(db, row) {
  db.prepare(`
    INSERT INTO messages (
      id, conversation_id, role, content, token_count, created_at, seq, metadata
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    row.id,
    row.conversationId,
    row.role,
    row.content,
    row.tokenCount,
    row.createdAt,
    row.seq,
    row.metadata,
  );
}

function copyConversationMessages(db, parentId, childId, idPrefix) {
  const rows = db.prepare(`
    SELECT role, content, token_count, created_at, metadata
    FROM messages
    WHERE conversation_id = ?
    ORDER BY created_at ASC, seq ASC, rowid ASC
  `).all(parentId);
  rows.forEach((row, index) => insertMessage(db, {
    id: `${idPrefix}${index + 1}`,
    conversationId: childId,
    role: row.role,
    content: row.content,
    tokenCount: row.token_count,
    createdAt: row.created_at,
    seq: index + 1,
    metadata: row.metadata,
  }));
}

function createFixture(options = {}) {
  const db = new Database(':memory:');
  createSchema(db);
  db.prepare('INSERT INTO characters (id, name) VALUES (?, ?)')
    .run(TARGET_CHARACTER_ID, '篠澤広');
  const insertConversation = db.prepare(`
    INSERT INTO conversations (id, character_id, title, parent_id, parent_seq_end)
    VALUES (?, ?, ?, NULL, NULL)
  `);
  for (const item of Object.values(TARGET_CONVERSATIONS)) {
    insertConversation.run(item.id, TARGET_CHARACTER_ID, item.title);
  }

  const rootId = TARGET_CONVERSATIONS.root.id;
  const part3Id = TARGET_CONVERSATIONS.part3.id;
  const part4Id = TARGET_CONVERSATIONS.part4.id;
  const part5Id = TARGET_CONVERSATIONS.part5.id;

  insertMessage(db, {
    id: 'r1', conversationId: rootId, role: 'user', content: 'fixture-root-one',
    tokenCount: 1,
    createdAt: options.createdSeqDivergence
      ? '2026-01-01T00:00:02.000Z'
      : '2026-01-01T00:00:01.000Z',
    seq: 1,
    metadata: '{}',
  });
  insertMessage(db, {
    id: 'r2', conversationId: rootId, role: 'assistant', content: 'fixture-root-two',
    tokenCount: 2,
    createdAt: options.createdSeqDivergence
      ? '2026-01-01T00:00:01.000Z'
      : '2026-01-01T00:00:02.000Z',
    seq: 2,
    metadata: '{}',
  });

  copyConversationMessages(db, rootId, part3Id, 'b');
  insertMessage(db, {
    id: 'b3', conversationId: part3Id, role: 'user', content: 'fixture-part-three-a',
    tokenCount: 3, createdAt: '2026-01-01T00:00:03.000Z', seq: 3, metadata: '{}',
  });
  // Deliberate gap at seq=4. The migration must close it before linking the next part.
  insertMessage(db, {
    id: 'b4', conversationId: part3Id, role: 'assistant', content: 'fixture-part-three-b',
    tokenCount: 4, createdAt: '2026-01-01T00:00:04.000Z', seq: 5, metadata: '{}',
  });

  copyConversationMessages(db, part3Id, part4Id, 'c');
  insertMessage(db, {
    id: 'c5', conversationId: part4Id, role: 'user', content: 'fixture-part-four-a',
    tokenCount: 5, createdAt: '2026-01-01T00:00:05.000Z', seq: 5, metadata: '{}',
  });
  // Deliberate gap at seq=6.
  insertMessage(db, {
    id: 'c6', conversationId: part4Id, role: 'assistant', content: 'fixture-part-four-b',
    tokenCount: 6, createdAt: '2026-01-01T00:00:06.000Z', seq: 7, metadata: '{}',
  });

  copyConversationMessages(db, part4Id, part5Id, 'd');
  insertMessage(db, {
    id: 'd7',
    conversationId: part5Id,
    role: 'system',
    content: 'fixture-summary',
    tokenCount: 7,
    createdAt: '2026-01-01T00:00:07.000Z',
    seq: 7,
    metadata: JSON.stringify({ isSummary: true, summarizedIds: ['d5', 'd6'] }),
  });
  insertMessage(db, {
    id: 'd8', conversationId: part5Id, role: 'user', content: 'fixture-part-five-tail',
    tokenCount: 8, createdAt: '2026-01-01T00:00:08.000Z', seq: 8, metadata: '{}',
  });

  // Exercise every approved JSON authority with ids that will be deleted.
  db.prepare(`
    INSERT INTO memories (id, character_id, source_msg_ids, metadata)
    VALUES ('mem-1', ?, ?, ?)
  `).run(
    TARGET_CHARACTER_ID,
    JSON.stringify(['d5']),
    JSON.stringify({ sourceInvalidation: { messageId: 'd6' } }),
  );
  db.prepare(`
    INSERT INTO memory_tasks (character_id, conversation_id, message_ids, status)
    VALUES (?, ?, ?, 'done')
  `).run(TARGET_CHARACTER_ID, part5Id, JSON.stringify(['d5']));
  db.prepare(`
    INSERT INTO memory_extraction_candidates (
      id, conversation_id, raw_candidate_json, raw_response, status
    ) VALUES ('candidate-1', ?, ?, '{}', 'ignored')
  `).run(part5Id, JSON.stringify({ source_msg_ids: ['d6'] }));

  if (options.prefixMismatch) {
    db.prepare("UPDATE messages SET content = 'fixture-mismatch' WHERE id = 'c2'").run();
  }
  return db;
}

function persistedSnapshot(db) {
  return JSON.stringify({
    conversations: db.prepare(`
      SELECT id, parent_id, parent_seq_end
      FROM conversations
      ORDER BY id
    `).all(),
    messages: db.prepare(`
      SELECT id, conversation_id, seq, role, content, token_count, created_at, metadata
      FROM messages
      ORDER BY conversation_id, seq, id
    `).all(),
    memories: db.prepare('SELECT id, source_msg_ids, metadata FROM memories ORDER BY id').all(),
    tasks: db.prepare('SELECT id, message_ids, status FROM memory_tasks ORDER BY id').all(),
    candidates: db.prepare(`
      SELECT id, raw_candidate_json, status
      FROM memory_extraction_candidates
      ORDER BY id
    `).all(),
    ftsCount: db.prepare('SELECT COUNT(*) AS count FROM messages_fts').get().count,
    trigramCount: db.prepare('SELECT COUNT(*) AS count FROM messages_fts_trigram').get().count,
  });
}

test('migration CLI defaults to dry-run', () => {
  const args = parseArgs([]);
  assert.equal(args.apply, false);
  assert.equal(args.vacuum, false);
});

test('CLI rejects the misleading --dry-run --vacuum combination', () => {
  assert.throws(
    () => parseArgs(['--dry-run', '--vacuum']),
    error => error instanceof MigrationError && error.code === 'INVALID_ARGUMENT',
  );
});

test('dry-run proves the dynamic prefix map without changing any persisted row', () => {
  const db = createFixture();
  try {
    const before = persistedSnapshot(db);
    const result = runMigrationOnDatabase(db);

    assert.equal(result.mode, 'dry-run');
    assert.equal(result.stateBefore, 'pending');
    assert.equal(result.stateAfter, 'pending');
    assert.equal(result.applied, false);
    assert.equal(result.plan.counts.globalMessagesBefore, 20);
    assert.equal(result.plan.counts.globalMessagesAfter, 8);
    assert.equal(result.plan.counts.rowsDeleted, 12);
    assert.equal(result.plan.counts.finalVisibleMessages, 8);
    assert.deepEqual(
      result.plan.conversations.map(item => item.prefixRowsDeleted),
      [0, 2, 4, 6],
    );

    const references = new Map(
      result.plan.jsonReferences.map(item => [item.field, item.references]),
    );
    assert.equal(references.get('messages.metadata'), 2);
    assert.equal(references.get('memories.source_msg_ids'), 1);
    assert.equal(references.get('memories.metadata'), 1);
    assert.equal(references.get('memory_tasks.message_ids'), 1);
    assert.equal(references.get('memory_extraction_candidates.raw_candidate_json'), 1);

    assert.equal(persistedSnapshot(db), before);
    const publicOutput = JSON.stringify(result);
    assert.doesNotMatch(publicOutput, /fixture-root-one|fixture-summary|fixture-part-five-tail/);
  } finally {
    db.close();
  }
});

test('apply removes exact duplicate rows, closes seq gaps, and rewrites JSON references losslessly', () => {
  const db = createFixture();
  try {
    const result = runMigrationOnDatabase(db, { apply: true });
    assert.equal(result.applied, true);
    assert.equal(result.stateBefore, 'pending');
    assert.equal(result.stateAfter, 'already_applied');
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM messages').get().count, 8);

    const conversationRows = db.prepare(`
      SELECT id, parent_id, parent_seq_end
      FROM conversations
      ORDER BY CASE id
        WHEN ? THEN 1 WHEN ? THEN 2 WHEN ? THEN 3 WHEN ? THEN 4 END
    `).all(
      TARGET_CONVERSATIONS.root.id,
      TARGET_CONVERSATIONS.part3.id,
      TARGET_CONVERSATIONS.part4.id,
      TARGET_CONVERSATIONS.part5.id,
    );
    assert.deepEqual(conversationRows, [
      { id: TARGET_CONVERSATIONS.root.id, parent_id: null, parent_seq_end: null },
      { id: TARGET_CONVERSATIONS.part3.id, parent_id: TARGET_CONVERSATIONS.root.id, parent_seq_end: 2 },
      { id: TARGET_CONVERSATIONS.part4.id, parent_id: TARGET_CONVERSATIONS.part3.id, parent_seq_end: 4 },
      { id: TARGET_CONVERSATIONS.part5.id, parent_id: TARGET_CONVERSATIONS.part4.id, parent_seq_end: 6 },
    ]);

    const physical = db.prepare(`
      SELECT conversation_id, GROUP_CONCAT(seq, ',') AS seqs
      FROM (SELECT conversation_id, seq FROM messages ORDER BY conversation_id, seq)
      GROUP BY conversation_id
    `).all();
    const seqsByConversation = new Map(physical.map(row => [row.conversation_id, row.seqs]));
    assert.equal(seqsByConversation.get(TARGET_CONVERSATIONS.root.id), '1,2');
    assert.equal(seqsByConversation.get(TARGET_CONVERSATIONS.part3.id), '3,4');
    assert.equal(seqsByConversation.get(TARGET_CONVERSATIONS.part4.id), '5,6');
    assert.equal(seqsByConversation.get(TARGET_CONVERSATIONS.part5.id), '7,8');

    const visibleIds = db.prepare(`
      SELECT id
      FROM messages
      WHERE conversation_id = ?
         OR (conversation_id = ? AND seq <= 2)
         OR (conversation_id = ? AND seq <= 4)
         OR (conversation_id = ? AND seq <= 6)
      ORDER BY seq ASC
    `).all(
      TARGET_CONVERSATIONS.part5.id,
      TARGET_CONVERSATIONS.root.id,
      TARGET_CONVERSATIONS.part3.id,
      TARGET_CONVERSATIONS.part4.id,
    ).map(row => row.id);
    assert.deepEqual(visibleIds, ['r1', 'r2', 'b3', 'b4', 'c5', 'c6', 'd7', 'd8']);

    const summaryMetadata = JSON.parse(
      db.prepare("SELECT metadata FROM messages WHERE id = 'd7'").get().metadata,
    );
    assert.deepEqual(summaryMetadata.summarizedIds, ['c5', 'c6']);
    assert.equal(new Set(summaryMetadata.summarizedIds).size, 2);
    assert.deepEqual(
      JSON.parse(db.prepare("SELECT source_msg_ids FROM memories WHERE id = 'mem-1'").get().source_msg_ids),
      ['c5'],
    );
    assert.equal(
      JSON.parse(db.prepare("SELECT metadata FROM memories WHERE id = 'mem-1'").get().metadata)
        .sourceInvalidation.messageId,
      'c6',
    );
    assert.deepEqual(
      JSON.parse(db.prepare('SELECT message_ids FROM memory_tasks').get().message_ids),
      ['c5'],
    );
    assert.deepEqual(
      JSON.parse(db.prepare('SELECT raw_candidate_json FROM memory_extraction_candidates').get().raw_candidate_json)
        .source_msg_ids,
      ['c6'],
    );

    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM messages_fts').get().count, 8);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM messages_fts_trigram').get().count, 8);
    assert.equal(db.prepare('PRAGMA quick_check').get().quick_check, 'ok');
  } finally {
    db.close();
  }
});

test('apply is idempotent and reports an exact already-applied state', () => {
  const db = createFixture();
  try {
    runMigrationOnDatabase(db, { apply: true });
    const afterFirstApply = persistedSnapshot(db);

    const second = runMigrationOnDatabase(db, { apply: true });
    assert.equal(second.stateBefore, 'already_applied');
    assert.equal(second.stateAfter, 'already_applied');
    assert.equal(second.applied, false);
    assert.equal(persistedSnapshot(db), afterFirstApply);
  } finally {
    db.close();
  }
});

test('vacuum can run independently without applying the logical migration', () => {
  const db = createFixture();
  try {
    const before = persistedSnapshot(db);
    const result = runMigrationOnDatabase(db, { vacuum: true });
    assert.equal(result.mode, 'vacuum');
    assert.equal(result.applied, false);
    assert.equal(result.vacuumed, true);
    assert.equal(result.stateBefore, 'pending');
    assert.equal(result.stateAfter, 'pending');
    assert.equal(persistedSnapshot(db), before);
  } finally {
    db.close();
  }
});

test('prefix mismatch aborts before any mutation', () => {
  const db = createFixture({ prefixMismatch: true });
  try {
    const before = persistedSnapshot(db);
    assert.throws(
      () => runMigrationOnDatabase(db, { apply: true }),
      error => error instanceof MigrationError && error.code === 'PREFIX_MISMATCH',
    );
    assert.equal(persistedSnapshot(db), before);
  } finally {
    db.close();
  }
});

test('old full-copy created_at ordering is recognized, then rejected if linking would change seq order', () => {
  const db = createFixture({ createdSeqDivergence: true });
  try {
    const before = persistedSnapshot(db);
    assert.throws(
      () => runMigrationOnDatabase(db),
      error => error instanceof MigrationError && error.code === 'PLANNED_SEQ_ORDER_MISMATCH',
    );
    assert.equal(persistedSnapshot(db), before);
  } finally {
    db.close();
  }
});

test('a failure after JSON rewrites and deletes rolls the entire apply transaction back', () => {
  const db = createFixture();
  try {
    db.exec(`
      CREATE TRIGGER inject_resequence_failure
      BEFORE UPDATE OF seq ON messages
      WHEN old.id = 'c5'
      BEGIN
        SELECT RAISE(ABORT, 'injected resequence failure');
      END;
    `);
    const before = persistedSnapshot(db);
    assert.throws(
      () => runMigrationOnDatabase(db, { apply: true }),
      /injected resequence failure/,
    );
    assert.equal(persistedSnapshot(db), before);
  } finally {
    db.close();
  }
});
