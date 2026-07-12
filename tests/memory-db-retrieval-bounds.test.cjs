const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');
const Database = require('better-sqlite3');

const root = path.resolve(__dirname, '..');
const originalResolveFilename = Module._resolveFilename;
const originalLoad = Module._load;

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
      jsx: ts.JsxEmit.ReactJSX,
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
    fileName: filename,
  });
  module._compile(output.outputText, filename);
};

function requireFreshWithMocks(modulePath, mocks = {}) {
  Module._load = function loadWithMocks(request, parent, isMain) {
    if (Object.prototype.hasOwnProperty.call(mocks, request)) {
      return mocks[request];
    }
    return originalLoad.call(this, request, parent, isMain);
  };

  try {
    const resolved = require.resolve(modulePath);
    delete require.cache[resolved];
    for (const relativePath of [
      '../src/lib/memory-engine.ts',
      '../src/lib/memory-retrieval.ts',
      '../src/lib/memory-embeddings.ts',
      '../src/lib/db.ts',
      '../src/lib/memory-embedding-schema.ts',
    ]) {
      try {
        delete require.cache[require.resolve(relativePath)];
      } catch {
        // Optional module during red phase.
      }
    }
    return require(modulePath);
  } finally {
    Module._load = originalLoad;
  }
}

function createCoreDb() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE characters (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT '2026-01-01T00:00:00.000Z',
      updated_at TEXT NOT NULL DEFAULT '2026-01-01T00:00:00.000Z'
    );

    CREATE TABLE memories (
      id TEXT PRIMARY KEY,
      character_id TEXT NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
      category TEXT NOT NULL,
      content TEXT NOT NULL,
      confidence REAL NOT NULL DEFAULT 0.8,
      tags TEXT NOT NULL DEFAULT '[]',
      source_msg_ids TEXT NOT NULL DEFAULT '[]',
      memory_kind TEXT,
      importance REAL,
      emotional_weight REAL,
      status TEXT,
      pinned INTEGER,
      last_used_at TEXT,
      usage_count INTEGER,
      metadata TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    INSERT INTO characters (id, name) VALUES ('char-a', '艾莉丝');
  `);
  return db;
}

function createLegacyMigrationDb() {
  const db = createCoreDb();
  db.exec(`
    INSERT INTO characters (id, name, created_at, updated_at)
    VALUES ('char-b', '露米', '2026-01-02T00:00:00.000Z', '2026-01-02T00:00:00.000Z');

    CREATE TABLE conversations (
      id TEXT PRIMARY KEY,
      character_id TEXT NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
      title TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE messages (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      token_count INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      metadata TEXT NOT NULL DEFAULT '{}'
    );

    CREATE TABLE memory_tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      character_id TEXT NOT NULL,
      conversation_id TEXT NOT NULL,
      message_ids TEXT NOT NULL DEFAULT '[]',
      status TEXT NOT NULL DEFAULT 'pending',
      merge_count INTEGER NOT NULL DEFAULT 0,
      retry_count INTEGER NOT NULL DEFAULT 0,
      error_message TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    INSERT INTO conversations (id, character_id, title, created_at, updated_at)
    VALUES ('conv-legacy', 'char-a', '旧会话', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');

    INSERT INTO messages (id, conversation_id, role, content, created_at)
    VALUES
      ('msg-legacy-a', 'conv-legacy', 'user', '第一条', '2026-01-01T00:00:00.000Z'),
      ('msg-legacy-b', 'conv-legacy', 'assistant', '第二条', '2026-01-01T00:00:00.000Z');

    INSERT INTO memory_tasks (
      character_id, conversation_id, message_ids, status, created_at, updated_at
    ) VALUES (
      'char-a', 'conv-legacy', '[]', 'processing',
      '2026-01-01T00:00:00.000Z', '2026-01-01T00:01:00.000Z'
    );
  `);
  return db;
}

function injectMigrationFailure(db, marker) {
  let injected = false;
  return {
    exec(sql) {
      if (!injected && sql.includes(marker)) {
        injected = true;
        throw new Error(`injected migration failure: ${marker}`);
      }
      return db.exec(sql);
    },
    prepare: db.prepare.bind(db),
    pragma: db.pragma.bind(db),
    transaction(fn) {
      const tx = db.transaction((...args) => fn(...args));
      return (...args) => tx(...args);
    },
  };
}

function insertMemory(db, overrides = {}) {
  const row = {
    id: overrides.id || crypto.randomUUID().slice(0, 12),
    character_id: overrides.character_id || 'char-a',
    category: overrides.category || '话题历史',
    content: overrides.content || '普通记忆',
    confidence: overrides.confidence ?? 0.9,
    tags: JSON.stringify(overrides.tags || []),
    source_msg_ids: JSON.stringify(overrides.source_msg_ids || []),
    memory_kind: overrides.memory_kind || 'general',
    importance: overrides.importance ?? 0.5,
    emotional_weight: overrides.emotional_weight ?? 0,
    status: overrides.status || 'active',
    pinned: overrides.pinned ? 1 : 0,
    last_used_at: overrides.last_used_at ?? null,
    usage_count: overrides.usage_count ?? 0,
    metadata: JSON.stringify(overrides.metadata || {}),
    created_at: overrides.created_at || '2026-01-01T00:00:00.000Z',
    updated_at: overrides.updated_at || '2026-01-01T00:00:00.000Z',
  };
  db.prepare(`
    INSERT INTO memories (
      id, character_id, category, content, confidence, tags, source_msg_ids,
      memory_kind, importance, emotional_weight, status, pinned, last_used_at,
      usage_count, metadata, created_at, updated_at
    )
    VALUES (
      @id, @character_id, @category, @content, @confidence, @tags, @source_msg_ids,
      @memory_kind, @importance, @emotional_weight, @status, @pinned, @last_used_at,
      @usage_count, @metadata, @created_at, @updated_at
    )
  `).run(row);
}

function createTrackedDb(db) {
  const stats = { memorySelectRows: [], embeddingSelectRows: [] };
  const tracked = {
    exec: db.exec.bind(db),
    pragma: db.pragma.bind(db),
    transaction(fn) {
      const tx = db.transaction((...args) => fn(...args));
      return (...args) => tx(...args);
    },
    prepare(sql) {
      const stmt = db.prepare(sql);
      return {
        all(...args) {
          const rows = stmt.all(...args);
          if (/SELECT\s+\*\s+FROM\s+memories/i.test(sql) && /status\s*=\s*'active'/i.test(sql)) {
            stats.memorySelectRows.push(rows.length);
          }
          if (/FROM\s+memory_embeddings/i.test(sql) && /status\s*=\s*'ready'/i.test(sql)) {
            stats.embeddingSelectRows.push(rows.length);
          }
          return rows;
        },
        get: stmt.get.bind(stmt),
        run: stmt.run.bind(stmt),
        iterate: stmt.iterate.bind(stmt),
        raw: stmt.raw.bind(stmt),
        columns: stmt.columns.bind(stmt),
        bind: stmt.bind.bind(stmt),
      };
    },
  };
  return { db: tracked, stats };
}

function seedManyMemories(db, total, specialId) {
  const insert = db.prepare(`
    INSERT INTO memories (
      id, character_id, category, content, confidence, tags, source_msg_ids,
      memory_kind, importance, emotional_weight, status, pinned, last_used_at,
      usage_count, metadata, created_at, updated_at
    )
    VALUES (?, 'char-a', '话题历史', ?, 0.9, ?, '[]', ?, ?, 0, 'active', ?, NULL, 0, '{}', ?, ?)
  `);
  const write = db.transaction(() => {
    for (let i = 0; i < total; i += 1) {
      const day = String((i % 28) + 1).padStart(2, '0');
      insert.run(
        `bulk-${i}`,
        `普通日常记录 ${i}，和目标饮品没有关系。`,
        '[]',
        'general',
        0.2,
        0,
        `2026-03-${day}T00:00:00.000Z`,
        `2026-03-${day}T00:00:00.000Z`,
      );
    }
    insert.run(
      specialId,
      '主人明确说过最重要的饮品偏好是 espresso tonic。',
      JSON.stringify(['espresso', 'drink']),
      'user_preference',
      0.99,
      1,
      '2026-01-01T00:00:00.000Z',
      '2026-01-01T00:00:00.000Z',
    );
  });
  write();
}

function seedManyReadyEmbeddings(db, total, specialId) {
  const blob = Buffer.from(new Float32Array([1, 0]).buffer);
  const insert = db.prepare(`
    INSERT INTO memory_embeddings (
      memory_id, character_id, provider, model, dimension, embedding_blob,
      normalized, embedding_text_hash, status, created_at, updated_at
    )
    VALUES (?, 'char-a', 'openai-compatible', 'embed', 2, ?, 1, ?, 'ready', ?, ?)
  `);
  const rows = db.prepare('SELECT id, updated_at FROM memories ORDER BY id ASC').all();
  const write = db.transaction(() => {
    for (const row of rows) {
      insert.run(row.id, blob, `hash-${row.id}`, row.updated_at, row.updated_at);
    }
  });
  write();

  assert.equal(rows.length, total + 1);
  assert.ok(rows.some(row => row.id === specialId));
}

function seedSemanticVectorRows(db) {
  const insertMemoryRow = db.prepare(`
    INSERT INTO memories (
      id, character_id, category, content, confidence, tags, source_msg_ids,
      memory_kind, importance, emotional_weight, status, pinned, last_used_at,
      usage_count, metadata, created_at, updated_at
    )
    VALUES (
      ?, 'char-a', '话题历史', ?, 0.9, '[]', '[]',
      'general', ?, 0, 'active', 0, NULL,
      0, '{}', ?, ?
    )
  `);
  const insertEmbeddingRow = db.prepare(`
    INSERT INTO memory_embeddings (
      memory_id, character_id, provider, model, dimension, embedding_blob,
      normalized, embedding_text_hash, status, created_at, updated_at
    )
    VALUES (?, 'char-a', 'openai-compatible', 'embed', 2, ?, 1, ?, 'ready', ?, ?)
  `);
  const unrelatedBlob = Buffer.from(new Float32Array([-1, 0]).buffer);
  const exactBlob = Buffer.from(new Float32Array([1, 0]).buffer);

  db.transaction(() => {
    for (let i = 0; i < 500; i += 1) {
      const id = `semantic-noise-${i}`;
      const day = String((i % 28) + 1).padStart(2, '0');
      const updatedAt = `2026-05-${day}T00:00:00.000Z`;
      insertMemoryRow.run(
        id,
        `高重要度但无关的向量记忆 ${i}。`,
        0.84,
        updatedAt,
        updatedAt,
      );
      insertEmbeddingRow.run(id, unrelatedBlob, `hash-${id}`, updatedAt, updatedAt);
    }

    insertMemoryRow.run(
      'semantic-exact',
      '主人精确说过语义检索目标是青柠气泡水。',
      0.1,
      '2026-01-01T00:00:00.000Z',
      '2026-01-01T00:00:00.000Z',
    );
    insertEmbeddingRow.run(
      'semantic-exact',
      exactBlob,
      'hash-semantic-exact',
      '2026-01-01T00:00:00.000Z',
      '2026-01-01T00:00:00.000Z',
    );
  })();
}

test('embedding helper 建表带 FK cascade，删除角色会清理 embedding 与 task', () => {
  const db = createCoreDb();
  insertMemory(db, { id: 'mem-fk', content: '需要向量索引的记忆。' });
  const { ensureMemoryEmbeddingTables } = requireFreshWithMocks('../src/lib/memory-embeddings.ts');

  ensureMemoryEmbeddingTables(db);

  const embeddingFks = db.prepare('PRAGMA foreign_key_list(memory_embeddings)').all();
  const taskFks = db.prepare('PRAGMA foreign_key_list(memory_embedding_tasks)').all();
  assert.ok(embeddingFks.some(row => row.table === 'memories' && row.from === 'memory_id' && row.on_delete === 'CASCADE'));
  assert.ok(embeddingFks.some(row => row.table === 'characters' && row.from === 'character_id' && row.on_delete === 'CASCADE'));
  assert.ok(taskFks.some(row => row.table === 'memories' && row.from === 'memory_id' && row.on_delete === 'CASCADE'));
  assert.ok(taskFks.some(row => row.table === 'characters' && row.from === 'character_id' && row.on_delete === 'CASCADE'));

  db.prepare(`
    INSERT INTO memory_embeddings (
      memory_id, character_id, provider, model, dimension, embedding_blob,
      normalized, embedding_text_hash, status, created_at, updated_at
    )
    VALUES ('mem-fk', 'char-a', 'mock', 'embed', 2, ?, 1, 'hash-a', 'ready', '2026-01-01', '2026-01-01')
  `).run(Buffer.from(new Float32Array([1, 0]).buffer));
  db.prepare(`
    INSERT INTO memory_embedding_tasks (memory_id, character_id, reason, status, created_at, updated_at)
    VALUES ('mem-fk', 'char-a', 'rebuild', 'pending', '2026-01-01', '2026-01-01')
  `).run();

  db.prepare("DELETE FROM characters WHERE id = 'char-a'").run();

  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM memory_embeddings').get().n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM memory_embedding_tasks').get().n, 0);
});

test('embedding 去重与唯一索引迁移失败时回滚，成功后可幂等重跑', () => {
  const db = createCoreDb();
  insertMemory(db, { id: 'mem-dupe-a', content: '重复 embedding A。' });
  insertMemory(db, { id: 'mem-dupe-b', content: '重复 task B。' });
  db.exec(`
    CREATE TABLE memory_embeddings (
      memory_id TEXT NOT NULL,
      character_id TEXT NOT NULL,
      provider TEXT NOT NULL,
      model TEXT NOT NULL,
      dimension INTEGER NOT NULL,
      embedding_blob BLOB NOT NULL,
      normalized INTEGER NOT NULL DEFAULT 1,
      embedding_text_hash TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'ready',
      error_message TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE memory_embedding_tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      memory_id TEXT NOT NULL,
      character_id TEXT NOT NULL,
      reason TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      retry_count INTEGER NOT NULL DEFAULT 0,
      error_message TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
  const blob = Buffer.from(new Float32Array([1, 0]).buffer);
  const insertEmbedding = db.prepare(`
    INSERT INTO memory_embeddings (
      memory_id, character_id, provider, model, dimension, embedding_blob,
      normalized, embedding_text_hash, status, created_at, updated_at
    )
    VALUES ('mem-dupe-a', 'char-a', 'mock', 'embed', 2, ?, 1, ?, 'ready', ?, ?)
  `);
  insertEmbedding.run(blob, 'old-hash', '2026-01-01', '2026-01-01');
  insertEmbedding.run(blob, 'new-hash', '2026-01-02', '2026-01-02');
  db.exec(`
    INSERT INTO memory_embedding_tasks (memory_id, character_id, reason, status, created_at, updated_at)
    VALUES
      ('mem-dupe-b', 'char-a', 'rebuild', 'pending', '2026-01-01', '2026-01-01'),
      ('mem-dupe-b', 'char-a', 'usage', 'processing', '2026-01-02', '2026-01-02');
  `);

  const { __migrateForTests } = requireFreshWithMocks('../src/lib/db.ts');
  let injectedFailure = false;
  const failingDb = {
    exec(sql) {
      const marker = 'CREATE UNIQUE INDEX IF NOT EXISTS idx_memory_embeddings_unique_model';
      if (!injectedFailure && sql.includes(marker)) {
        injectedFailure = true;
        throw new Error('injected index failure');
      }
      return db.exec(sql);
    },
    prepare: db.prepare.bind(db),
    pragma: db.pragma.bind(db),
    transaction(fn) {
      const tx = db.transaction(() => fn());
      return () => tx();
    },
  };

  assert.throws(() => __migrateForTests(failingDb), /injected index failure/);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM memory_embeddings').get().n, 2);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM memory_embedding_tasks WHERE status IN ('pending', 'processing')").get().n, 2);

  __migrateForTests(db);
  __migrateForTests(db);

  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM memory_embeddings').get().n, 1);
  assert.equal(db.prepare("SELECT embedding_text_hash FROM memory_embeddings WHERE memory_id = 'mem-dupe-a'").get().embedding_text_hash, 'new-hash');
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM memory_embedding_tasks WHERE status IN ('pending', 'processing')").get().n, 1);
  assert.equal(db.prepare("SELECT status FROM memory_embedding_tasks WHERE memory_id = 'mem-dupe-b'").get().status, 'processing');
});

test('seq/sort_order/started_at 迁移组在中途失败时回滚，重跑后完整回填', () => {
  const { __migrateForTests } = requireFreshWithMocks('../src/lib/db.ts');
  const scenarios = [
    {
      column: 'seq',
      table: 'messages',
      marker: 'CREATE INDEX IF NOT EXISTS idx_messages_seq',
      verify(db) {
        assert.deepEqual(
          db.prepare('SELECT seq FROM messages ORDER BY rowid').all().map(row => row.seq),
          [1, 2],
        );
        assert.ok(db.prepare("PRAGMA index_list(messages)").all().some(index => index.name === 'idx_messages_seq'));
      },
    },
    {
      column: 'sort_order',
      table: 'characters',
      marker: 'CREATE INDEX IF NOT EXISTS idx_characters_sort_order',
      verify(db) {
        assert.deepEqual(
          db.prepare('SELECT id, sort_order FROM characters ORDER BY sort_order').all(),
          [
            { id: 'char-b', sort_order: 1 },
            { id: 'char-a', sort_order: 2 },
          ],
        );
        assert.ok(db.prepare("PRAGMA index_list(characters)").all().some(index => index.name === 'idx_characters_sort_order'));
      },
    },
    {
      column: 'started_at',
      table: 'memory_tasks',
      marker: 'SET started_at = updated_at',
      verify(db) {
        assert.equal(
          db.prepare("SELECT started_at FROM memory_tasks WHERE conversation_id = 'conv-legacy'").get().started_at,
          '2026-01-01T00:01:00.000Z',
        );
      },
    },
  ];

  for (const scenario of scenarios) {
    const db = createLegacyMigrationDb();
    assert.throws(
      () => __migrateForTests(injectMigrationFailure(db, scenario.marker)),
      /injected migration failure/,
    );
    assert.ok(
      !db.prepare(`PRAGMA table_info(${scenario.table})`).all().some(column => column.name === scenario.column),
      `${scenario.column} should roll back with its migration group`,
    );

    __migrateForTests(db);
    __migrateForTests(db);
    scenario.verify(db);
  }
});

test('message history migration adds an index for created_at-first stable ordering', () => {
  const db = createLegacyMigrationDb();
  const { __migrateForTests } = requireFreshWithMocks('../src/lib/db.ts');
  __migrateForTests(db);
  db.exec(`
    INSERT INTO conversations (id, character_id, title, created_at, updated_at)
    VALUES ('conv-history', 'char-a', '历史索引', '2026-07-11T00:00:00.000Z', '2026-07-11T00:00:00.000Z');
    INSERT INTO messages (id, conversation_id, role, content, token_count, created_at, seq, metadata)
    VALUES
      ('msg-seq-late', 'conv-history', 'user', '同秒后序', 1, '2026-07-11T00:00:01.000Z', 9, '{}'),
      ('msg-created-late', 'conv-history', 'assistant', '创建时间更晚', 1, '2026-07-11T00:00:02.000Z', 1, '{}'),
      ('msg-seq-early', 'conv-history', 'assistant', '同秒前序', 1, '2026-07-11T00:00:01.000Z', 2, '{}');
  `);

  const plan = db.prepare(`
    EXPLAIN QUERY PLAN
    SELECT * FROM messages
    WHERE conversation_id = ?
    ORDER BY created_at ASC, seq ASC
  `).all('conv-history');
  const rows = db.prepare(`
    SELECT id FROM messages
    WHERE conversation_id = ?
    ORDER BY created_at ASC, seq ASC
  `).all('conv-history');

  assert.ok(plan.some(row => String(row.detail).includes('idx_messages_conversation_created_seq')));
  assert.equal(plan.some(row => String(row.detail).includes('USE TEMP B-TREE FOR ORDER BY')), false);
  assert.deepEqual(rows.map(row => row.id), ['msg-seq-early', 'msg-seq-late', 'msg-created-late']);
});

test('database migration records the current schema version and rejects future versions before writes', () => {
  const db = createLegacyMigrationDb();
  const { CURRENT_SCHEMA_VERSION, __migrateForTests } = requireFreshWithMocks('../src/lib/db.ts');

  assert.equal(db.pragma('user_version', { simple: true }), 0);
  __migrateForTests(db);
  assert.equal(db.pragma('user_version', { simple: true }), CURRENT_SCHEMA_VERSION);

  const futureDb = new Database(':memory:');
  futureDb.pragma(`user_version = ${CURRENT_SCHEMA_VERSION + 1}`);
  let execCalls = 0;
  let prepareCalls = 0;
  const guardedDb = {
    pragma: futureDb.pragma.bind(futureDb),
    exec(sql) {
      execCalls += 1;
      return futureDb.exec(sql);
    },
    prepare(sql) {
      prepareCalls += 1;
      return futureDb.prepare(sql);
    },
    transaction: futureDb.transaction.bind(futureDb),
  };

  assert.throws(
    () => __migrateForTests(guardedDb),
    new RegExp(`schema version ${CURRENT_SCHEMA_VERSION + 1}.*supports ${CURRENT_SCHEMA_VERSION}`, 'i'),
  );
  assert.equal(execCalls, 0);
  assert.equal(prepareCalls, 0);
});

test('message search migration keeps a trigram index synchronized and adds an indexed date path', () => {
  const db = createLegacyMigrationDb();
  const { __migrateForTests } = requireFreshWithMocks('../src/lib/db.ts');
  __migrateForTests(db);
  __migrateForTests(db);

  db.prepare(`
    INSERT INTO messages (id, conversation_id, role, content, token_count, created_at, seq, metadata)
    VALUES ('msg-search-cjk', 'conv-legacy', 'user', '主人今天很开心', 1, '2026-07-11T00:00:00.000Z', 3, '{}')
  `).run();

  const trigramPlan = db.prepare(`
    EXPLAIN QUERY PLAN
    SELECT id FROM messages_fts_trigram
    WHERE messages_fts_trigram MATCH ?
  `).all('"主人今天"');
  const datePlan = db.prepare(`
    EXPLAIN QUERY PLAN
    SELECT id FROM messages
    WHERE created_at >= ? AND created_at <= ?
    ORDER BY created_at ASC
  `).all('2026-07-11T00:00:00.000Z', '2026-07-11T23:59:59.999Z');

  assert.ok(trigramPlan.some(row => /SCAN messages_fts_trigram VIRTUAL TABLE INDEX/.test(String(row.detail))));
  assert.deepEqual(
    db.prepare('SELECT id FROM messages_fts_trigram WHERE messages_fts_trigram MATCH ?').all('"主人今天"'),
    [{ id: 'msg-search-cjk' }],
  );
  assert.ok(datePlan.some(row => String(row.detail).includes('idx_messages_created_at')));
  assert.equal(datePlan.some(row => String(row.detail).includes('USE TEMP B-TREE FOR ORDER BY')), false);

  db.prepare("UPDATE messages SET content = '主人明天很开心' WHERE id = 'msg-search-cjk'").run();
  assert.deepEqual(
    db.prepare('SELECT id FROM messages_fts_trigram WHERE messages_fts_trigram MATCH ?').all('"主人今天"'),
    [],
  );
  assert.deepEqual(
    db.prepare('SELECT id FROM messages_fts_trigram WHERE messages_fts_trigram MATCH ?').all('"主人明天"'),
    [{ id: 'msg-search-cjk' }],
  );

  db.prepare("DELETE FROM messages WHERE id = 'msg-search-cjk'").run();
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM messages_fts_trigram').get().count, 2);
});

test('seq/sort_order/started_at 迁移会补完旧版本遗留的半迁移状态', () => {
  const db = createLegacyMigrationDb();
  db.exec(`
    ALTER TABLE messages ADD COLUMN seq INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE characters ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE memory_tasks ADD COLUMN started_at TEXT;
  `);

  const { __migrateForTests } = requireFreshWithMocks('../src/lib/db.ts');
  __migrateForTests(db);

  assert.deepEqual(
    db.prepare('SELECT seq FROM messages ORDER BY rowid').all().map(row => row.seq),
    [1, 2],
  );
  assert.ok(db.prepare("PRAGMA index_list(messages)").all().some(index => index.name === 'idx_messages_seq'));
  assert.deepEqual(
    db.prepare('SELECT id, sort_order FROM characters ORDER BY sort_order').all(),
    [
      { id: 'char-b', sort_order: 1 },
      { id: 'char-a', sort_order: 2 },
    ],
  );
  assert.ok(db.prepare("PRAGMA index_list(characters)").all().some(index => index.name === 'idx_characters_sort_order'));
  assert.equal(
    db.prepare("SELECT started_at FROM memory_tasks WHERE conversation_id = 'conv-legacy'").get().started_at,
    '2026-01-01T00:01:00.000Z',
  );
});

test('迁移旧无 FK embedding 表会重建约束，并通过 cascade 清理旧数据', () => {
  const db = createCoreDb();
  insertMemory(db, { id: 'mem-legacy-fk', content: '旧表里已经存在的 embedding。' });
  db.exec(`
    CREATE TABLE memory_embeddings (
      memory_id TEXT NOT NULL,
      character_id TEXT NOT NULL,
      provider TEXT NOT NULL,
      model TEXT NOT NULL,
      dimension INTEGER NOT NULL,
      embedding_blob BLOB NOT NULL,
      normalized INTEGER NOT NULL DEFAULT 1,
      embedding_text_hash TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'ready',
      error_message TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE memory_embedding_tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      memory_id TEXT NOT NULL,
      character_id TEXT NOT NULL,
      reason TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      retry_count INTEGER NOT NULL DEFAULT 0,
      error_message TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
  db.prepare(`
    INSERT INTO memory_embeddings (
      memory_id, character_id, provider, model, dimension, embedding_blob,
      normalized, embedding_text_hash, status, created_at, updated_at
    )
    VALUES ('mem-legacy-fk', 'char-a', 'mock', 'embed', 2, ?, 1, 'hash-a', 'ready', '2026-01-01', '2026-01-01')
  `).run(Buffer.from(new Float32Array([1, 0]).buffer));
  db.prepare(`
    INSERT INTO memory_embedding_tasks (memory_id, character_id, reason, status, created_at, updated_at)
    VALUES ('mem-legacy-fk', 'char-a', 'rebuild', 'pending', '2026-01-01', '2026-01-01')
  `).run();

  const { __migrateForTests } = requireFreshWithMocks('../src/lib/db.ts');
  __migrateForTests(db);
  __migrateForTests(db);

  const embeddingFks = db.prepare('PRAGMA foreign_key_list(memory_embeddings)').all();
  const taskFks = db.prepare('PRAGMA foreign_key_list(memory_embedding_tasks)').all();
  assert.ok(embeddingFks.some(row => row.table === 'memories' && row.from === 'memory_id' && row.on_delete === 'CASCADE'));
  assert.ok(embeddingFks.some(row => row.table === 'characters' && row.from === 'character_id' && row.on_delete === 'CASCADE'));
  assert.ok(taskFks.some(row => row.table === 'memories' && row.from === 'memory_id' && row.on_delete === 'CASCADE'));
  assert.ok(taskFks.some(row => row.table === 'characters' && row.from === 'character_id' && row.on_delete === 'CASCADE'));
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM memory_embeddings').get().n, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM memory_embedding_tasks').get().n, 1);

  db.prepare("DELETE FROM characters WHERE id = 'char-a'").run();

  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM memory_embeddings').get().n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM memory_embedding_tasks').get().n, 0);
});

test('retrieveRelevantMemories 在 500 和 2000 条 active memories 下只读取有界候选并保留高优先级相关记忆', () => {
  for (const total of [500, 2000]) {
    const db = createCoreDb();
    seedManyMemories(db, total, `bounded-special-${total}`);
    const tracked = createTrackedDb(db);
    const { retrieveRelevantMemories } = requireFreshWithMocks('../src/lib/memory-engine.ts', {
      '@/lib/db': { getDb: () => tracked.db },
    });

    const started = performance.now();
    const result = retrieveRelevantMemories('espresso tonic 饮品偏好', 'char-a', 5);
    const elapsedMs = performance.now() - started;

    assert.ok(
      tracked.stats.memorySelectRows.every(count => count <= 500),
      `${total} active memories should not load more than 500 candidates, got ${tracked.stats.memorySelectRows.join(', ')}`,
    );
    assert.ok(result.some(memory => memory.id === `bounded-special-${total}`));
    assert.ok(elapsedMs < 1000, `${total} active memories retrieval took ${elapsedMs}ms`);
  }
});

test('legacy fallback 在 limit_inject=false 时读取全部 active 记忆，并优先保留 pinned/high-importance/recent', async () => {
  const db = createCoreDb();
  seedManyMemories(db, 2000, 'legacy-pinned');
  const tracked = createTrackedDb(db);
  const { retrieveWorkingMemoryPackage } = requireFreshWithMocks('../src/lib/memory-retrieval.ts', {
    '@/lib/db': { getDb: () => tracked.db },
  });

  const result = await retrieveWorkingMemoryPackage({
    characterId: 'char-a',
    queryText: 'espresso tonic 饮品偏好',
    settings: {
      memory_inject: true,
      limit_inject: false,
      memory_max_inject: 30,
      memory_engine: {
        enabled: false,
        embedding_enabled: false,
        reranker_enabled: false,
        fallback_local_enabled: true,
        memory_package_token_budget: 5000,
        retrieval_token_budget: 1000,
        final_top_k: 30,
      },
    },
    deps: {
      loadMemoryProfile: () => null,
      tokenCounter: text => Math.ceil(text.length / 100),
    },
  });

  // 全量注入路径不再有 300 条候选上限:全部 active 记忆进入候选池,由 token 预算裁剪
  assert.ok(
    tracked.stats.memorySelectRows.some(count => count === 2001),
    `legacy full injection should load all active candidates, got ${tracked.stats.memorySelectRows.join(', ')}`,
  );
  assert.ok(result.selectedMemories.some(memory => memory.id === 'legacy-pinned'));
});

test('loadReadyMemoryEmbeddings 单次读取 scanLimit 内 ready rows，并优先排序 pinned/high-importance 候选', () => {
  const db = createCoreDb();
  seedManyMemories(db, 2000, 'vector-pinned');
  const { ensureMemoryEmbeddingTables, loadReadyMemoryEmbeddings } = requireFreshWithMocks('../src/lib/memory-embeddings.ts');
  ensureMemoryEmbeddingTables(db);
  seedManyReadyEmbeddings(db, 2000, 'vector-pinned');
  const tracked = createTrackedDb(db);

  const rows = loadReadyMemoryEmbeddings('char-a', {
    provider: 'openai-compatible',
    model: 'embed',
    dimension: 2,
    db: tracked.db,
  });

  assert.deepEqual(tracked.stats.embeddingSelectRows, [2001]);
  assert.equal(rows.length, 2001);
  assert.equal(rows[0].memory_id, 'vector-pinned');
});

test('vector retrieval 单次扫描等价候选集并召回低 importance 的精确语义记忆', async () => {
  const db = createCoreDb();
  const { ensureMemoryEmbeddingTables } = requireFreshWithMocks('../src/lib/memory-embeddings.ts');
  ensureMemoryEmbeddingTables(db);
  seedSemanticVectorRows(db);
  const tracked = createTrackedDb(db);
  const { retrieveWorkingMemoryPackage } = requireFreshWithMocks('../src/lib/memory-retrieval.ts', {
    '@/lib/db': { getDb: () => tracked.db },
  });

  const result = await retrieveWorkingMemoryPackage({
    characterId: 'char-a',
    queryText: '青柠气泡水',
    settings: {
      memory_inject: true,
      limit_inject: true,
      memory_max_inject: 5,
      memory_engine: {
        enabled: true,
        embedding_enabled: true,
        embedding_api_base: 'https://example.com/v1',
        embedding_api_key: 'test-key',
        embedding_model: 'embed',
        embedding_dimension: 2,
        fallback_local_enabled: false,
        reranker_enabled: false,
        memory_package_token_budget: 5000,
        vector_top_k: 1,
        final_top_k: 5,
      },
    },
    deps: {
      embedText: async () => [1, 0],
      localRetrieve: () => {
        throw new Error('local fallback should stay disabled');
      },
      loadMemoryProfile: () => null,
      markMemoriesUsed: () => {},
      tokenCounter: text => Math.ceil(text.length / 100),
    },
  });

  assert.deepEqual(tracked.stats.embeddingSelectRows, [501]);
  assert.equal(result.mode, 'vector');
  assert.ok(result.selectedMemories.some(memory => memory.id === 'semantic-exact'));
  assert.match(result.text, /青柠气泡水/);
});
