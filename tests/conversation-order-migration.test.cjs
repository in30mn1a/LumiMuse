const test = require('node:test');
const assert = require('node:assert/strict');
const { installMemoryOnlyTestGuard } = require('./helpers/memory-only-test-guard.cjs');

installMemoryOnlyTestGuard(test);
const Database = require('better-sqlite3');
require('./helpers/register-ts-loader.cjs').registerTsLoader();
const { __migrateForTests } = require('../src/lib/db.ts');
const { resolveConversationChain } = require('../src/lib/conversation-chain.ts');

const T0 = '2026-11-01T00:00:00.000Z';
const T1 = '2026-11-02T00:00:00.000Z';
const T2 = '2026-11-03T00:00:00.000Z';

test('对话排序迁移按角色保留旧排序与并列次序，不改变消息或父链且可重复', t => {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  t.after(() => db.close());
  __migrateForTests(db);
  db.exec('DROP INDEX idx_conversations_character_sort');
  db.exec('ALTER TABLE conversations DROP COLUMN sort_order');
  db.exec(`
    INSERT INTO characters (id, name) VALUES ('char-a', '虚构角色甲'), ('char-b', '虚构角色乙');
  `);
  const insertConversation = db.prepare(`
    INSERT INTO conversations (id, character_id, title, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?)
  `);
  const fixtures = [
    ['conv-a-old', 'char-a', T0, T0],
    ['conv-b-old', 'char-b', T0, T0],
    ['conv-a-tie-a', 'char-a', T1, T1],
    ['conv-b-created-old', 'char-b', T0, T1],
    ['conv-a-first', 'char-a', T0, T2],
    ['conv-b-created-new', 'char-b', T1, T1],
    ['conv-a-tie-z', 'char-a', T1, T1],
  ];
  for (const [id, characterId, createdAt, updatedAt] of fixtures) {
    insertConversation.run(id, characterId, `虚构对话 ${id}`, createdAt, updatedAt);
  }
  db.prepare("UPDATE conversations SET parent_id = 'conv-a-old', parent_seq_end = 2 WHERE id = 'conv-a-tie-a'").run();
  const insertMessage = db.prepare(`
    INSERT INTO messages (id, conversation_id, role, content, token_count, created_at, seq, metadata)
    VALUES (?, ?, 'user', '虚构消息', 3, ?, ?, '{}')
  `);
  insertMessage.run('msg-parent-1', 'conv-a-old', T0, 1);
  insertMessage.run('msg-parent-2', 'conv-a-old', T1, 2);
  insertMessage.run('msg-parent-3', 'conv-a-old', T2, 3);
  insertMessage.run('msg-child-3', 'conv-a-tie-a', T2, 3);
  insertMessage.run('msg-other-character', 'conv-b-old', T0, 1);

  const conversationsBefore = db.prepare('SELECT * FROM conversations ORDER BY id').all();
  const messagesBefore = db.prepare('SELECT * FROM messages ORDER BY id').all();
  const chainBefore = resolveConversationChain(db, 'conv-a-tie-a');
  const oldOrder = characterId => db.prepare(`
    SELECT id FROM conversations WHERE character_id = ?
    ORDER BY updated_at DESC, created_at DESC, id DESC
  `).all(characterId).map(row => row.id);
  const oldOrderA = oldOrder('char-a');
  const oldOrderB = oldOrder('char-b');
  assert.deepEqual(oldOrderA, ['conv-a-first', 'conv-a-tie-z', 'conv-a-tie-a', 'conv-a-old']);
  assert.deepEqual(oldOrderB, ['conv-b-created-new', 'conv-b-created-old', 'conv-b-old']);

  __migrateForTests(db);

  const ranked = characterId => db.prepare(`
    SELECT id, sort_order FROM conversations WHERE character_id = ? ORDER BY sort_order
  `).all(characterId);
  assert.deepEqual(ranked('char-a'), oldOrderA.map((id, index) => ({ id, sort_order: index + 1 })));
  assert.deepEqual(ranked('char-b'), oldOrderB.map((id, index) => ({ id, sort_order: index + 1 })));
  assert.deepEqual(
    db.prepare('SELECT * FROM conversations ORDER BY id').all().map(({ sort_order, ...conversation }) => conversation),
    conversationsBefore,
  );
  assert.deepEqual(db.prepare('SELECT * FROM messages ORDER BY id').all(), messagesBefore);
  assert.deepEqual(resolveConversationChain(db, 'conv-a-tie-a'), chainBefore);
  assert.deepEqual(db.pragma('foreign_key_check'), []);
  assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE name = 'idx_conversations_character_sort'").get());

  db.prepare("UPDATE conversations SET sort_order = -7 WHERE id = 'conv-a-old'").run();
  db.prepare("UPDATE conversations SET sort_order = 42 WHERE id = 'conv-b-created-new'").run();
  const customOrder = db.prepare('SELECT * FROM conversations ORDER BY id').all();
  __migrateForTests(db);
  assert.deepEqual(db.prepare('SELECT * FROM conversations ORDER BY id').all(), customOrder);
  assert.deepEqual(db.prepare('SELECT * FROM messages ORDER BY id').all(), messagesBefore);
  assert.deepEqual(resolveConversationChain(db, 'conv-a-tie-a'), chainBefore);
  assert.deepEqual(db.pragma('foreign_key_check'), []);
});
