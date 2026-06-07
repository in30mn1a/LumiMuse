const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');
const Database = require('better-sqlite3');

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

const { __migrateForTests } = require('../src/lib/db.ts');
const { inferMemoryDefaults } = require('../src/lib/memory-category.ts');
const { retrieveWorkingMemoryPackage } = require('../src/lib/memory-retrieval.ts');

const categories = [
  '基础信息',
  '人格特质',
  '重要事件',
  '偏好习惯',
  '关系动态',
  '话题历史',
  '四季日常',
  '未知分类',
];

function baseSettings() {
  return {
    memory_inject: true,
    limit_inject: true,
    memory_engine: {
      embedding_enabled: false,
      reranker_enabled: false,
      fallback_local_enabled: true,
      memory_package_token_budget: 1000,
      retrieval_token_budget: 1000,
      vector_top_k: 8,
      keyword_top_k: 8,
      reranker_top_k: 8,
      final_top_k: 8,
    },
  };
}

function createLegacyDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE characters (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      avatar TEXT,
      description TEXT NOT NULL DEFAULT '',
      personality TEXT NOT NULL DEFAULT '',
      scenario TEXT NOT NULL DEFAULT '',
      first_mes TEXT NOT NULL DEFAULT '',
      mes_example TEXT NOT NULL DEFAULT '',
      creator_notes TEXT NOT NULL DEFAULT '',
      system_prompt TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE memories (
      id TEXT PRIMARY KEY,
      character_id TEXT NOT NULL,
      category TEXT NOT NULL,
      content TEXT NOT NULL,
      confidence REAL NOT NULL DEFAULT 0.8,
      tags TEXT NOT NULL DEFAULT '[]',
      source_msg_ids TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  const insert = db.prepare(`
    INSERT INTO memories (id, character_id, category, content)
    VALUES (?, 'char-a', ?, ?)
  `);
  for (const category of categories) {
    insert.run(`missing-${category}`, category, `${category} legacy memory`);
  }

  return db;
}

function createLegacyDbWithBlankDefaultFields() {
  const db = createLegacyDb();
  db.exec(`
    ALTER TABLE memories ADD COLUMN memory_kind TEXT;
    ALTER TABLE memories ADD COLUMN importance REAL;
    ALTER TABLE memories ADD COLUMN emotional_weight REAL;
  `);
  db.prepare(`
    UPDATE memories
    SET memory_kind = '', importance = NULL, emotional_weight = NULL
    WHERE category = '重要事件'
  `).run();
  db.prepare(`
    UPDATE memories
    SET memory_kind = 'character_promise', importance = 0.91, emotional_weight = 0.88
    WHERE category = '偏好习惯'
  `).run();
  return db;
}

test('legacy memories migration backfills defaults from inferMemoryDefaults', () => {
  const db = createLegacyDb();

  __migrateForTests(db);

  const rows = db.prepare(`
    SELECT id, category, memory_kind, importance, emotional_weight
    FROM memories
    ORDER BY id
  `).all();

  assert.equal(rows.length, categories.length);
  for (const row of rows) {
    assert.deepEqual(
      {
        memory_kind: row.memory_kind,
        importance: row.importance,
        emotional_weight: row.emotional_weight,
      },
      inferMemoryDefaults(row.category),
      row.category,
    );
  }
});

test('legacy memories migration backfills blank fields without overwriting custom defaults', () => {
  const db = createLegacyDbWithBlankDefaultFields();

  __migrateForTests(db);

  const blankRow = db.prepare(`
    SELECT category, memory_kind, importance, emotional_weight
    FROM memories
    WHERE category = '重要事件'
  `).get();
  assert.deepEqual(
    {
      memory_kind: blankRow.memory_kind,
      importance: blankRow.importance,
      emotional_weight: blankRow.emotional_weight,
    },
    inferMemoryDefaults('重要事件'),
  );

  const customRow = db.prepare(`
    SELECT memory_kind, importance, emotional_weight
    FROM memories
    WHERE category = '偏好习惯'
  `).get();
  assert.deepEqual(customRow, {
    memory_kind: 'character_promise',
    importance: 0.91,
    emotional_weight: 0.88,
  });
});

test('retrieval fallback fills null default fields from inferMemoryDefaults', async () => {
  const result = await retrieveWorkingMemoryPackage({
    characterId: 'char-a',
    queryText: '默认值一致性',
    settings: baseSettings(),
    deps: {
      localRetrieve: () => categories.map(category => ({
        id: `retrieval-${category}`,
        character_id: 'char-a',
        category,
        content: `${category} fallback memory`,
        confidence: 0.9,
        tags: [],
        source_msg_ids: [],
        memory_kind: null,
        importance: null,
        emotional_weight: null,
        status: 'active',
        pinned: 0,
        created_at: '2026-01-01T00:00:00.000Z',
        updated_at: '2026-01-01T00:00:00.000Z',
      })),
      tokenCounter: text => Math.ceil(text.length / 100),
    },
  });

  assert.equal(result.selectedMemories.length, categories.length);
  for (const memory of result.selectedMemories) {
    assert.deepEqual(
      {
        memory_kind: memory.memory_kind,
        importance: memory.importance,
        emotional_weight: memory.emotional_weight,
      },
      inferMemoryDefaults(memory.category),
      memory.category,
    );
  }
});
