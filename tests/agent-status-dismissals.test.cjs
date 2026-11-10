const test = require('node:test');
const assert = require('node:assert/strict');
const { installMemoryOnlyTestGuard } = require('./helpers/memory-only-test-guard.cjs');
installMemoryOnlyTestGuard(test);
const Database = require('better-sqlite3');
const { NextRequest } = require('next/server');
const { registerTsLoader } = require('./helpers/register-ts-loader.cjs');
registerTsLoader();
const { __migrateForTests, __setDbForTests } = require('../src/lib/db.ts');
const { loadSettings } = require('../src/lib/settings.ts');
const route = require('../src/app/api/agent/status/route.ts');
const { AGENT_READ_TOOLS } = require('../src/lib/agent/tools/index.ts');
const { parseToolArguments } = require('../src/lib/agent/tools/registry.ts');

function setup(t) {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  __migrateForTests(db);
  __setDbForTests(db);
  const now = new Date().toISOString();
  db.exec(`
    INSERT INTO characters (id, name) VALUES ('fictional', '虚构角色');
    INSERT INTO conversations (id, character_id) VALUES ('fictional-chat', 'fictional');
    INSERT INTO memories (id, character_id, category, content) VALUES ('fictional-memory', 'fictional', 'fact', '虚构测试记忆');
    INSERT INTO memory_tasks (character_id, conversation_id, status) VALUES ('fictional', 'fictional-chat', 'failed');
    INSERT INTO character_memory_profile_update_tasks (character_id, reason, patch_json, status) VALUES ('fictional', 'test', '{}', 'failed');
  `);
  db.prepare(`INSERT INTO memory_embedding_tasks (memory_id, character_id, reason, status, created_at, updated_at)
    VALUES ('fictional-memory', 'fictional', 'test', 'failed', ?, ?)`).run(now, now);
  db.prepare(`INSERT INTO memory_extraction_candidates (character_id, status, created_at, updated_at)
    VALUES ('fictional', 'repairable', ?, ?)`).run(now, now);
  db.prepare(`INSERT INTO app_events (ts, level, event) VALUES (?, 'error', 'fictional.error'), (?, 'warn', 'fictional.warn')`).run(now, now);
  t.after(() => { __setDbForTests(null); db.close(); });
  return db;
}

const sourceTables = ['memory_tasks', 'character_memory_profile_update_tasks', 'memory_embedding_tasks', 'memory_extraction_candidates', 'app_events'];
const sourceRows = db => sourceTables.map(table => db.prepare(`SELECT * FROM ${table} ORDER BY id`).all());
const readStatus = async () => (await route.GET()).json();
const dismiss = snapshot => route.POST(new NextRequest('http://test.local/api/agent/status', {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ dismissal_snapshot: snapshot }),
}));

async function call(db, name, args = {}) {
  const tool = AGENT_READ_TOOLS.find(item => item.name === name);
  const parsed = parseToolArguments(tool, JSON.stringify(args));
  assert.equal(parsed.ok, true, parsed.error);
  const result = await tool.execute(parsed.args, { db, settings: loadSettings(), sessionId: 'fixture' });
  assert.equal(result.ok, true, result.error);
  return result;
}

test('dismissing the displayed issues persists inactivity without changing source data', async t => {
  const db = setup(t);
  const before = sourceRows(db);
  const initial = await readStatus();
  assert.deepEqual(initial.failed_tasks, { extraction: 1, profile: 1, embedding: 1 });
  assert.equal(initial.dismissal_snapshot.length, 5);
  const response = await dismiss(initial.dismissal_snapshot);
  assert.equal(response.status, 200);
  const after = await response.json();
  assert.deepEqual(after.failed_tasks, { extraction: 0, profile: 0, embedding: 0 });
  assert.equal(after.repairable_candidates, 0);
  assert.equal(after.recent_errors, 0);
  assert.deepEqual(after.dismissal_snapshot, []);
  assert.deepEqual(sourceRows(db), before);
  __migrateForTests(db);
  assert.deepEqual((await readStatus()).failed_tasks, after.failed_tasks, 'migration retains dismissed state');

  const status = await call(db, 'get_system_status');
  assert.equal(status.memory_system.index.failed, 0, 'the index summary also excludes ignored failures');
  assert.equal(status.memory_system.queues.extraction.failed, 0);
  assert.equal(status.memory_system.queues.profile.failed, 0);
  assert.equal(status.memory_system.queues.embedding.failed, 0);
  assert.equal(status.memory_system.candidates.repairable, 0);
  assert.deepEqual(status.app_events_last_24h.by_level, { warn: 1, error: 0 });
  assert.deepEqual((await call(db, 'list_failed_tasks')).tasks, []);
  assert.deepEqual((await call(db, 'list_repairable_candidates')).candidates, []);
  assert.deepEqual((await call(db, 'list_app_events', { level: 'error' })).events, []);
  for (const table of sourceTables) {
    const filters = table === 'app_events' ? [{ column: 'level', value: 'error' }] : undefined;
    assert.deepEqual((await call(db, 'query_table', { table, filters })).rows, []);
    assert.equal((await call(db, 'query_table', { table, filters, include_inactive: true })).rows.length, 1);
  }
  assert.equal((await call(db, 'list_app_events', { include_inactive: true, level: 'error' })).events.length, 1);
  assert.equal((await call(db, 'list_failed_tasks', { include_inactive: true })).tasks.length, 3);
  assert.equal((await call(db, 'list_repairable_candidates', { include_inactive: true })).candidates.length, 1);
  assert.equal((await call(db, 'get_system_status', { include_inactive: true })).memory_system.queues.extraction.failed, 1);
});

test('a stale snapshot cannot dismiss new errors or a new failure of the same task', async t => {
  const db = setup(t);
  const initial = await readStatus();
  db.exec("UPDATE memory_tasks SET retry_count = retry_count + 1 WHERE id = 1");
  db.prepare("INSERT INTO app_events (ts, level, event) VALUES (?, 'error', 'fictional.new_error')").run(new Date().toISOString());
  const response = await dismiss(initial.dismissal_snapshot);
  assert.equal(response.status, 200);
  const after = await response.json();
  assert.equal(after.failed_tasks.extraction, 1);
  assert.equal(after.recent_errors, 1);
  const errors = await call(db, 'list_app_events', { level: 'error', limit: 1 });
  assert.equal(errors.events[0].event, 'fictional.new_error');
  assert.equal(errors.has_more, false, 'inactive rows are filtered before paging');
  await dismiss(after.dismissal_snapshot);
  db.exec("UPDATE memory_tasks SET retry_count = retry_count + 1 WHERE id = 1");
  assert.equal((await readStatus()).failed_tasks.extraction, 1, 'a retry becomes active again');
  assert.equal((await call(db, 'list_failed_tasks')).tasks.length, 1);
  assert.equal((await call(db, 'get_system_status', { character_id: 'other' })).memory_system.queues.extraction.failed, 0);
});

test('dismissal validates the complete request before writing and tolerates removed sources', async t => {
  const db = setup(t);
  const initial = await readStatus();
  assert.equal((await dismiss([...initial.dismissal_snapshot, { kind: 'settings', id: 1, version: '' }])).status, 400);
  assert.equal((await readStatus()).recent_errors, 1);
  assert.equal((await dismiss(null)).status, 400);
  db.exec('DELETE FROM memory_extraction_candidates WHERE id = 1');
  assert.equal((await dismiss(initial.dismissal_snapshot)).status, 200);
  assert.equal((await readStatus()).recent_errors, 0);
});

test('active index failure counts still respect the current embedding target and in-flight work', async t => {
  const db = setup(t);
  db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run('memory_engine', JSON.stringify({
    embedding_model: 'fictional-current', embedding_dimension: 2,
  }));
  const now = new Date().toISOString();
  const insert = db.prepare(`INSERT INTO memory_embeddings
    (memory_id, character_id, provider, model, dimension, embedding_blob, embedding_text_hash, created_at, updated_at)
    VALUES ('fictional-memory', 'fictional', 'openai-compatible', ?, 2, ?, 'fictional-hash', ?, ?)`);
  insert.run('fictional-old', Buffer.alloc(8), now, now);
  assert.equal((await call(db, 'get_system_status')).memory_system.index.failed, 1, 'an old target does not resolve this failure');
  insert.run('fictional-current', Buffer.alloc(8), now, now);
  assert.equal((await call(db, 'get_system_status')).memory_system.index.failed, 0, 'the current ready target resolves the failure');
  db.exec('DELETE FROM memory_embeddings');
  db.prepare(`INSERT INTO memory_embedding_tasks (memory_id, character_id, reason, status, created_at, updated_at)
    VALUES ('fictional-memory', 'fictional', 'test', 'processing', ?, ?)`).run(now, now);
  assert.equal((await call(db, 'get_system_status')).memory_system.index.failed, 0, 'in-flight indexing is not an unresolved failure');
});
