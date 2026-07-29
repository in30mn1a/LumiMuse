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

test('partial legacy preset schema with rows is upgraded before the composite index is created', () => {
  const db = new Database(':memory:');
  try {
    db.pragma('foreign_keys = ON');
    db.exec(`
      CREATE TABLE prompt_presets (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL
      );
      INSERT INTO prompt_presets (id, name) VALUES ('preset-legacy', 'Legacy');

      CREATE TABLE prompt_preset_entries (
        id TEXT PRIMARY KEY,
        preset_id TEXT NOT NULL,
        name TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL DEFAULT '',
        is_marker INTEGER NOT NULL DEFAULT 0
      );
      INSERT INTO prompt_preset_entries (
        id, preset_id, name, role, content, is_marker
      ) VALUES (
        'entry-legacy', 'preset-legacy', 'Legacy entry', 'user', 'hello', 0
      );
    `);

    const dbModulePath = require.resolve(path.join(root, 'src', 'lib', 'db.ts'));
    delete require.cache[dbModulePath];
    const dbModule = require(dbModulePath);
    dbModule.__migrateForTests(db);

    const presetColumns = new Set(
      db.prepare('PRAGMA table_info(prompt_presets)').all().map(column => column.name)
    );
    const entryColumns = new Set(
      db.prepare('PRAGMA table_info(prompt_preset_entries)').all().map(column => column.name)
    );
    assert.ok(presetColumns.has('created_at'));
    assert.ok(presetColumns.has('updated_at'));
    assert.ok(entryColumns.has('sort_order'));
    assert.ok(entryColumns.has('created_at'));
    assert.ok(entryColumns.has('updated_at'));

    const preset = db.prepare(
      'SELECT created_at, updated_at FROM prompt_presets WHERE id = ?'
    ).get('preset-legacy');
    const entry = db.prepare(
      'SELECT sort_order, created_at, updated_at FROM prompt_preset_entries WHERE id = ?'
    ).get('entry-legacy');
    assert.ok(preset.created_at);
    assert.ok(preset.updated_at);
    assert.equal(entry.sort_order, 0);
    assert.ok(entry.created_at);
    assert.ok(entry.updated_at);

    const indexColumns = db.prepare(
      'PRAGMA index_info(idx_prompt_preset_entries_preset)'
    ).all().map(column => column.name);
    assert.deepEqual(indexColumns, ['preset_id', 'sort_order']);
  } finally {
    db.close();
  }
});

test('legacy story_plot_strip presets receive an empty strip_tags column for re-import', () => {
  const db = new Database(':memory:');
  try {
    db.exec(`
      CREATE TABLE prompt_presets (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        story_plot_strip INTEGER NOT NULL DEFAULT 0
      );
      INSERT INTO prompt_presets (id, name, story_plot_strip)
      VALUES ('preset-rong', 'RONG legacy', 1);
    `);

    const dbModulePath = require.resolve(path.join(root, 'src', 'lib', 'db.ts'));
    delete require.cache[dbModulePath];
    const dbModule = require(dbModulePath);
    dbModule.__migrateForTests(db);

    const preset = db.prepare(`
      SELECT strip_tags
      FROM prompt_presets
      WHERE id = 'preset-rong'
    `).get();
    assert.deepEqual(JSON.parse(preset.strip_tags), []);
  } finally {
    db.close();
  }
});
