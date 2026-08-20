/**
 * 数据访问层 TASK-PRESETS-DAL 单测。
 *
 * 用 __migrateForTests + __setDbForTests，让 prompt-presets.ts 内部 getDb() 拿到 :memory: 数据库，
 * 完全与真实 ./data/lumimuse.db 隔离。
 */

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
      jsx: ts.JsxEmit.ReactJSX,
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
    fileName: filename,
  });
  module._compile(output.outputText, filename);
};

const dbModulePath = require.resolve(path.join(root, 'src', 'lib', 'db.ts'));
const presetModulePath = require.resolve(path.join(root, 'src', 'lib', 'prompt-presets.ts'));

let db;
let lib;

test.beforeEach(() => {
  // 清缓存，让每个 test 拿到一份新 db 单例 + 新 lib（lib 会重新 require db.ts，拿到清缓存后的模块）。
  // 注意：db.ts 会触发 structured-log/memory-category 等一堆互依模块，全清才能保证 lib 拿到的 _db 单例就是我们设置的。
  const keysBefore = Object.keys(require.cache).filter(k => k.startsWith(root + path.sep + 'src' + path.sep + 'lib'));
  for (const k of keysBefore) delete require.cache[k];

  const dbMod = require(dbModulePath);
  dbMod.__resetDbForTests();

  db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  dbMod.__migrateForTests(db);
  dbMod.__setDbForTests(db);

  lib = require(presetModulePath);
});

test.afterEach(() => {
  try { db && db.close(); } catch {}
});

test('createPreset + getPreset + listPresets 基础 CRUD', () => {
  const created = lib.createPreset({ name: 'Alpha', description: 'first' });
  assert.ok(created.id);
  assert.equal(created.name, 'Alpha');
  assert.equal(created.description, 'first');

  const fetched = lib.getPreset(created.id);
  assert.ok(fetched);
  assert.equal(fetched.name, 'Alpha');

  const all = lib.listPresets();
  assert.ok(all.some(p => p.id === created.id));
});

test('updatePreset 修改字段并刷 updated_at', () => {
  const p = lib.createPreset({ name: 'Old Name' });
  lib.updatePreset(p.id, { name: 'New Name', description: 'desc' });
  const after = lib.getPreset(p.id);
  assert.equal(after.name, 'New Name');
  assert.equal(after.description, 'desc');
});

test('createPreset/updatePreset reject invalid, duplicate, and conflicting strip_tags', () => {
  assert.throws(
    () => lib.createPreset({ name: 'invalid', strip_tags: ['#'] }),
    /strip_tags/,
  );

  const preset = lib.createPreset({ name: 'valid', strip_tags: ['content', '#think'] });
  assert.throws(
    () => lib.updatePreset(preset.id, { strip_tags: ['content', 'CONTENT'] }),
    /strip_tags/,
  );
  assert.throws(
    () => lib.updatePreset(preset.id, { strip_tags: ['think', '#Think'] }),
    /strip_tags/,
  );
  assert.deepEqual(lib.getPreset(preset.id).strip_tags, ['content', '#think']);

  lib.updatePreset(preset.id, { strip_tags: [] });
  const stored = db.prepare('SELECT strip_tags FROM prompt_presets WHERE id = ?').get(preset.id);
  assert.deepEqual(JSON.parse(stored.strip_tags), []);
});

test('upsertEntry 新建 + 修改 + sort_order 排序', () => {
  const p = lib.createPreset({ name: 'preset-A' });

  const e1 = lib.upsertEntry({ preset_id: p.id, name: 'e1', role: 'user', content: 'first', sort_order: 30 });
  const e2 = lib.upsertEntry({ preset_id: p.id, name: 'e2', role: 'system', content: 'second', sort_order: 10 });
  const e3 = lib.upsertEntry({ preset_id: p.id, name: 'e3', role: 'assistant', content: 'third', sort_order: 20 });

  const all = lib.listEntries(p.id);
  assert.equal(all.length, 3);
  assert.deepEqual(all.map(e => e.id), [e2.id, e3.id, e1.id], 'sort_order 升序');

  lib.upsertEntry({ id: e1.id, preset_id: p.id, name: 'e1', role: 'system', content: 'modified', enabled: false });
  const after = lib.getEntry(e1.id);
  assert.equal(after.role, 'system');
  assert.equal(after.content, 'modified');
  assert.equal(after.enabled, false);
  assert.equal(after.sort_order, 30, 'sort_order 不变');
});

test('loadEnabledEntries 仅返回 enabled=1，且按 sort_order 排序', () => {
  const p = lib.createPreset({ name: 'preset-B' });
  lib.upsertEntry({ preset_id: p.id, name: 'a', role: 'user', sort_order: 20, enabled: true });
  lib.upsertEntry({ preset_id: p.id, name: 'b', role: 'user', sort_order: 10, enabled: false });
  lib.upsertEntry({ preset_id: p.id, name: 'c', role: 'user', sort_order: 30, enabled: true });
  lib.upsertEntry({ preset_id: p.id, name: 'd', role: 'user', sort_order: 5,  enabled: true });

  const enabled = lib.loadEnabledEntries(p.id);
  assert.deepEqual(enabled.map(e => e.name), ['d', 'a', 'c'], '只取 enabled，按 sort_order 升序');
});

test('deletePreset 级联删除条目并解绑角色', () => {
  const p = lib.createPreset({ name: 'preset-C' });
  lib.upsertEntry({ preset_id: p.id, name: 'x', role: 'user', sort_order: 10 });

  db.prepare(`
    INSERT INTO characters (id, name, basic_info, personality, scenario, greeting, example_dialogue, system_prompt, other_info, image_tags, user_image_tags, active_preset_id, created_at, updated_at)
    VALUES ('char-1', 'T', '', '', '', '', '', '', '', '', '', ?, datetime('now'), datetime('now'))
  `).run(p.id);

  lib.deletePreset(p.id);

  assert.equal(lib.getPreset(p.id), null);
  assert.equal(lib.listEntries(p.id).length, 0);
  const row = db.prepare('SELECT active_preset_id FROM characters WHERE id = ?').get('char-1');
  assert.equal(row.active_preset_id, null);
});

test('resolveActivePreset：角色绑定 / 禁用 / 空值', () => {
  const rolePreset = lib.createPreset({ name: 'Role Override' });

  let resolved = lib.resolveActivePreset({ active_preset_id: null });
  assert.equal(resolved, null, 'null 表示不使用预设');

  resolved = lib.resolveActivePreset({ active_preset_id: rolePreset.id });
  assert.ok(resolved);
  assert.equal(resolved.id, rolePreset.id, '绑定具体预设 id');

  resolved = lib.resolveActivePreset({ active_preset_id: '__none__' });
  assert.equal(resolved, null, '__none__ 必须返回 null');

  resolved = lib.resolveActivePreset({ active_preset_id: '' });
  assert.equal(resolved, null, '空字符串表示不使用预设');
});

test('resolveActivePreset：模型绑定覆盖角色默认，未命中则回退', () => {
  const defaultPreset = lib.createPreset({ name: 'Default Preset' });
  const modelPreset = lib.createPreset({ name: 'Model Preset' });

  db.prepare(`
    INSERT INTO characters (id, name, basic_info, personality, scenario, greeting, example_dialogue, system_prompt, other_info, image_tags, user_image_tags, active_preset_id, created_at, updated_at)
    VALUES ('char-bind', 'T', '', '', '', '', '', '', '', '', '', ?, datetime('now'), datetime('now'))
  `).run(defaultPreset.id);

  lib.replaceCharacterModelPresetBindings('char-bind', [
    { model: 'claude-sonnet-4', preset_id: modelPreset.id },
    { model: 'gpt-4o', preset_id: '__none__' },
  ]);

  const character = { id: 'char-bind', active_preset_id: defaultPreset.id };

  const byModel = lib.resolveActivePreset(character, 'claude-sonnet-4');
  assert.ok(byModel);
  assert.equal(byModel.id, modelPreset.id);

  assert.equal(lib.resolveActivePreset(character, 'gpt-4o'), null, '显式 none 不得回退默认');

  const fallback = lib.resolveActivePreset(character, 'other-model');
  assert.ok(fallback);
  assert.equal(fallback.id, defaultPreset.id);

  const blankModel = lib.resolveActivePreset(character, '  ');
  assert.ok(blankModel);
  assert.equal(blankModel.id, defaultPreset.id);

  const noModel = lib.resolveActivePreset(character);
  assert.ok(noModel);
  assert.equal(noModel.id, defaultPreset.id);

  const memoryOverride = lib.resolveActivePreset({
    id: 'char-bind',
    active_preset_id: defaultPreset.id,
    model_preset_bindings: [{ model: 'claude-sonnet-4', preset_id: '__none__' }],
  }, 'claude-sonnet-4');
  assert.equal(memoryOverride, null, '内存数组优先于库表');

  const missingPreset = lib.resolveActivePreset({
    active_preset_id: defaultPreset.id,
    model_preset_bindings: [{ model: 'x', preset_id: 'does-not-exist' }],
  }, 'x');
  assert.equal(missingPreset, null, '绑定预设缺失时走传统骨架');
});

test('deletePreset 清除指向该预设的模型绑定', () => {
  const keepPreset = lib.createPreset({ name: 'Keep' });
  const dropPreset = lib.createPreset({ name: 'Drop' });

  db.prepare(`
    INSERT INTO characters (id, name, basic_info, personality, scenario, greeting, example_dialogue, system_prompt, other_info, image_tags, user_image_tags, active_preset_id, created_at, updated_at)
    VALUES ('char-unbind', 'T', '', '', '', '', '', '', '', '', '', ?, datetime('now'), datetime('now'))
  `).run(keepPreset.id);

  lib.replaceCharacterModelPresetBindings('char-unbind', [
    { model: 'claude-sonnet-4', preset_id: dropPreset.id },
    { model: 'gpt-4o', preset_id: keepPreset.id },
  ]);

  lib.deletePreset(dropPreset.id);

  const remaining = lib.loadCharacterModelPresetBindings('char-unbind');
  assert.deepEqual(remaining, [{ model: 'gpt-4o', preset_id: keepPreset.id }]);
});
