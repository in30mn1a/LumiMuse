const test = require('node:test');
const assert = require('node:assert/strict');
const { installMemoryOnlyTestGuard } = require('./helpers/memory-only-test-guard.cjs');

installMemoryOnlyTestGuard(test);
const Database = require('better-sqlite3');
require('./helpers/register-ts-loader.cjs').registerTsLoader();
const { __migrateForTests, CURRENT_SCHEMA_VERSION } = require('../src/lib/db.ts');

const T0 = '2026-11-09T00:00:00.000Z';
const LEGACY_PROPOSALS_DDL = `
  CREATE TABLE agent_proposals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT REFERENCES agent_sessions(id) ON DELETE SET NULL,
    character_id TEXT NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
    summary TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('pending', 'decided')),
    created_at TEXT NOT NULL,
    decided_at TEXT
  );
  CREATE INDEX idx_agent_proposals_character ON agent_proposals(character_id, id);
  CREATE INDEX idx_agent_proposals_session ON agent_proposals(session_id);
`;

function openDb(t) {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  t.after(() => db.close());
  return db;
}

function legacyDb(t) {
  const db = openDb(t);
  __migrateForTests(db);
  db.pragma('foreign_keys = OFF');
  db.exec('DROP TABLE agent_proposals');
  db.exec(LEGACY_PROPOSALS_DDL);
  db.pragma('foreign_keys = ON');
  db.exec(`
    INSERT INTO characters (id, name) VALUES ('char-old', '旧角色');
    INSERT INTO agent_sessions (id, character_id, created_at, updated_at)
      VALUES ('session-old', 'char-old', '${T0}', '${T0}');
    INSERT INTO agent_proposals (id, session_id, character_id, summary, status, created_at, decided_at)
      VALUES (11, 'session-old', 'char-old', '已批准提案', 'decided', '${T0}', '${T0}'),
             (17, 'session-old', 'char-old', '待批准提案', 'pending', '${T0}', NULL);
    INSERT INTO agent_proposal_items (
      id, proposal_id, seq, op, reason, evidence_json, confidence, before_json, after_json, state, result_json, applied_at
    ) VALUES
      (21, 11, 1, 'update', '旧理由', '{"message_ids":[]}', 0.8, '{"old":true}', '{"content":"旧内容"}', 'applied', '{"after":[]}', '${T0}'),
      (27, 17, 1, 'create', '待批准理由', '{"message_ids":[]}', 0.9, 'null', '{"content":"待批准内容"}', 'pending', NULL, NULL);
    INSERT INTO memory_revisions (
      id, character_id, memory_id, proposal_item_id, op, action, reason, evidence_json, before_json, after_json, created_at
    ) VALUES (31, 'char-old', 'memory-old', 21, 'update', 'apply', '旧理由', '{}', '{}', '{}', '${T0}');
    UPDATE sqlite_sequence SET seq = 9001 WHERE name = 'agent_proposals';
    UPDATE sqlite_sequence SET seq = 8001 WHERE name = 'agent_proposal_items';
    UPDATE sqlite_sequence SET seq = 7001 WHERE name = 'memory_revisions';
  `);
  return db;
}

function characterColumn(db) {
  return db.prepare('PRAGMA table_info(agent_proposals)').all().find(column => column.name === 'character_id');
}

function preservedState(db) {
  return {
    proposals: db.prepare('SELECT * FROM agent_proposals ORDER BY id').all(),
    items: db.prepare('SELECT * FROM agent_proposal_items ORDER BY id').all(),
    revisions: db.prepare('SELECT * FROM memory_revisions ORDER BY id').all(),
    indexes: db.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'index' AND tbl_name = 'agent_proposals' ORDER BY name").all(),
    sequences: db.prepare("SELECT name, seq FROM sqlite_sequence WHERE name IN ('agent_proposals', 'agent_proposal_items', 'memory_revisions') ORDER BY name").all(),
  };
}

function insertCreationProposal(db) {
  return db.prepare(`
    INSERT INTO agent_proposals (session_id, character_id, summary, status, created_at)
    VALUES (NULL, NULL, '从零创建角色', 'pending', ?)
  `).run(T0);
}

test('空数据库允许保存无角色创建提案，schema version 保持兼容', t => {
  const db = openDb(t);
  __migrateForTests(db);
  assert.equal(characterColumn(db).notnull, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM characters').get().n, 0);
  assert.ok(insertCreationProposal(db).lastInsertRowid > 0);
  assert.equal(db.pragma('user_version', { simple: true }), CURRENT_SCHEMA_VERSION);
  assert.equal(CURRENT_SCHEMA_VERSION, 3);
});

test('旧提案迁移完整保留历史、子项、修订、索引与 AUTOINCREMENT 高水位且可重复', async t => {
  for (const enabled of [true, false]) {
    await t.test(`原外键开关 ${enabled ? 'ON' : 'OFF'}`, subtest => {
      const db = legacyDb(subtest);
      db.pragma(`foreign_keys = ${enabled ? 'ON' : 'OFF'}`);
      const before = preservedState(db);
      __migrateForTests(db);
      assert.equal(characterColumn(db).notnull, 0);
      assert.deepEqual(preservedState(db), before);
      assert.equal(db.pragma('foreign_keys', { simple: true }), enabled ? 1 : 0);
      assert.deepEqual(db.pragma('foreign_key_check'), []);
      __migrateForTests(db);
      assert.deepEqual(preservedState(db), before);
      assert.equal(db.pragma('foreign_keys', { simple: true }), enabled ? 1 : 0);
      assert.equal(insertCreationProposal(db).lastInsertRowid, 9002);
      const itemForeignKey = db.pragma('foreign_key_list(agent_proposal_items)').find(key => key.from === 'proposal_id');
      assert.equal(itemForeignKey.table, 'agent_proposals');
      assert.equal(itemForeignKey.on_delete, 'CASCADE');
    });
  }
});

test('迁移后旧角色提案仍级联删除，无角色提案不会被关联角色或会话删除带走', t => {
  const db = legacyDb(t);
  __migrateForTests(db);
  const creationId = Number(insertCreationProposal(db).lastInsertRowid);
  db.prepare('DELETE FROM agent_sessions WHERE id = ?').run('session-old');
  assert.deepEqual(db.prepare('SELECT session_id FROM agent_proposals WHERE id = 11').get(), { session_id: null });
  db.prepare('DELETE FROM characters WHERE id = ?').run('char-old');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM agent_proposals WHERE character_id IS NOT NULL').get().n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM agent_proposal_items').get().n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM memory_revisions').get().n, 0);
  assert.ok(db.prepare('SELECT id FROM agent_proposals WHERE id = ?').get(creationId));
  assert.deepEqual(db.pragma('foreign_key_check'), []);
});

test('外键检查失败时整张表迁移回滚，旧结构、历史和原外键开关保持完整', async t => {
  for (const enabled of [true, false]) {
    await t.test(`原外键开关 ${enabled ? 'ON' : 'OFF'}`, subtest => {
      const db = legacyDb(subtest);
      db.pragma('foreign_keys = OFF');
      db.prepare('UPDATE agent_proposal_items SET proposal_id = 404 WHERE id = 27').run();
      db.pragma(`foreign_keys = ${enabled ? 'ON' : 'OFF'}`);
      const before = preservedState(db);
      assert.throws(() => __migrateForTests(db), /foreign key|外键/i);
      assert.equal(characterColumn(db).notnull, 1);
      assert.deepEqual(preservedState(db), before);
      assert.equal(db.pragma('foreign_keys', { simple: true }), enabled ? 1 : 0);
      assert.deepEqual(db.prepare("SELECT name FROM sqlite_master WHERE name = '__agent_proposals_nullable'").all(), []);
    });
  }
});
