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

function seedConversation(db) {
  db.exec(`
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