const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { registerTsLoader } = require('./helpers/register-ts-loader.cjs');

registerTsLoader();

const { __migrateForTests, CURRENT_SCHEMA_VERSION } = require('../src/lib/db.ts');

const AGENT_TABLES = ['agent_sessions', 'agent_messages', 'agent_documents', 'agent_document_versions'];

function openDb(t) {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  t.after(() => db.close());
  return db;
}

function tableNames(db) {
  return new Set(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map(row => row.name));
}

test('schema version stays at 3 so older images can still start on the new database', t => {
  assert.equal(CURRENT_SCHEMA_VERSION, 3);
  const db = openDb(t);
  __migrateForTests(db);
  assert.equal(db.pragma('user_version', { simple: true }), 3);
});

test('an empty database gets every agent table and migrating again is harmless', t => {
  const db = openDb(t);
  __migrateForTests(db);
  __migrateForTests(db);
  const names = tableNames(db);
  for (const table of AGENT_TABLES) assert.equal(names.has(table), true, table);
});

test('an existing database without agent tables is upgraded in place', t => {
  const db = openDb(t);
  __migrateForTests(db);
  for (const table of [...AGENT_TABLES].reverse()) db.exec(`DROP TABLE ${table}`);
  db.prepare(`INSERT INTO characters (id, name) VALUES ('char-1', 'Fixture')`).run();

  __migrateForTests(db);

  const names = tableNames(db);
  for (const table of AGENT_TABLES) assert.equal(names.has(table), true, table);
  assert.equal(db.prepare('SELECT name FROM characters WHERE id = ?').get('char-1').name, 'Fixture');
  assert.equal(db.pragma('user_version', { simple: true }), 3);
});

test('deleting a session cascades to its messages only', t => {
  const db = openDb(t);
  __migrateForTests(db);
  const now = '2026-11-03T00:00:00.000Z';
  const insertSession = db.prepare('INSERT INTO agent_sessions (id, created_at, updated_at) VALUES (?, ?, ?)');
  const insertMessage = db.prepare(`INSERT INTO agent_messages (session_id, role, content, created_at) VALUES (?, 'user', 'hi', ?)`);
  insertSession.run('s1', now, now);
  insertSession.run('s2', now, now);
  insertMessage.run('s1', now);
  insertMessage.run('s1', now);
  insertMessage.run('s2', now);

  db.prepare('DELETE FROM agent_sessions WHERE id = ?').run('s1');

  const counts = db.prepare('SELECT session_id, COUNT(*) AS count FROM agent_messages GROUP BY session_id').all();
  assert.deepEqual(counts, [{ session_id: 's2', count: 1 }]);
});

test('deleting a character or conversation keeps the session and clears the link', t => {
  const db = openDb(t);
  __migrateForTests(db);
  const now = '2026-11-03T00:00:00.000Z';
  db.prepare(`INSERT INTO characters (id, name) VALUES ('char-1', 'Fixture')`).run();
  db.prepare(`INSERT INTO conversations (id, character_id, title) VALUES ('conv-1', 'char-1', 'First')`).run();
  db.prepare(`
    INSERT INTO agent_sessions (id, character_id, conversation_id, created_at, updated_at)
    VALUES ('s1', 'char-1', 'conv-1', ?, ?)
  `).run(now, now);

  db.prepare('DELETE FROM characters WHERE id = ?').run('char-1');

  const row = db.prepare('SELECT character_id, conversation_id FROM agent_sessions WHERE id = ?').get('s1');
  assert.deepEqual({ ...row }, { character_id: null, conversation_id: null });
});

test('document tables only accept the two known documents and sources', t => {
  const db = openDb(t);
  __migrateForTests(db);
  const now = '2026-11-03T00:00:00.000Z';
  db.prepare(`INSERT INTO agent_documents (key, content, updated_at) VALUES ('agents', 'x', ?)`).run(now);
  assert.throws(() => db.prepare(`INSERT INTO agent_documents (key, content, updated_at) VALUES ('other', 'x', ?)`).run(now), /CHECK/);
  assert.throws(() => db.prepare(`
    INSERT INTO agent_document_versions (key, content, source, created_at) VALUES ('memory', 'x', 'model', ?)
  `).run(now), /CHECK/);
  assert.throws(() => db.prepare(`
    INSERT INTO agent_messages (session_id, role, content, created_at) VALUES ('missing', 'user', 'x', ?)
  `).run(now), /FOREIGN KEY/);
});
