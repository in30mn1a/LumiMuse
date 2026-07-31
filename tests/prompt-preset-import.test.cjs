/**
 * TASK-IMPORT-CORE 单元测试：合成 JSON 校验各映射规则。
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
const importModulePath = require.resolve(path.join(root, 'src', 'lib', 'prompt-preset-import.ts'));
const exportModulePath = require.resolve(path.join(root, 'src', 'lib', 'prompt-preset-export.ts'));
const presetModulePath = require.resolve(path.join(root, 'src', 'lib', 'prompt-presets.ts'));

let db, importLib, exportLib, presetLib;

test.beforeEach(() => {
  const keysBefore = Object.keys(require.cache).filter(k => k.startsWith(root + path.sep + 'src' + path.sep + 'lib'));
  for (const k of keysBefore) delete require.cache[k];
  const dbMod = require(dbModulePath);
  dbMod.__resetDbForTests();
  db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  dbMod.__migrateForTests(db);
  dbMod.__setDbForTests(db);
  importLib = require(importModulePath);
  exportLib = require(exportModulePath);
  presetLib = require(presetModulePath);
});

test.afterEach(() => { try { db && db.close(); } catch {} });

test('非法 JSON 抛出友好错误', () => {
  assert.throws(() => importLib.importSillyTavernPreset('not json'), /JSON 解析失败/);
});

test('空 prompts + 空 order：创建空预设但不报 marker', () => {
  const report = importLib.importSillyTavernPreset(JSON.stringify({ prompts: [], prompt_order: [{ character_id: 100001, order: [] }] }));
  assert.equal(report.total, 0);
  assert.equal(report.enabled, 0);
  assert.equal(report.markers_recognized, 0);
  assert.equal(report.markers_disabled, 0);
});

test('顶层采样/extensions 等字段被完全忽略', () => {
  const report = importLib.importSillyTavernPreset(JSON.stringify({
    temperature: 0.7,
    top_p: 1,
    wi_format: '{0}',
    impersonation_prompt: 'ignored',
    extensions: { some: 'thing' },
    prompts: [{ identifier: 'aaaaaaaa-1111-4111-a111-111111111111', name: 'x', role: 'user', content: 'hello', enabled: true }],
    prompt_order: [{ character_id: 100001, order: [{ identifier: 'aaaaaaaa-1111-4111-a111-111111111111', enabled: true }] }],
  }));
  assert.equal(report.total, 1);
  const e = presetLib.listEntries(report.preset_id)[0];
  assert.equal(e.content, 'hello');
});

test('order.entry.enabled 优先于 prompt.enabled', () => {
  const id = 'aaaaaaaa-1111-4111-a111-111111111112';
  const report = importLib.importSillyTavernPreset(JSON.stringify({
    prompts: [{ identifier: id, name: 'x', role: 'user', content: 'y', enabled: true }],
    prompt_order: [{ character_id: 100001, order: [{ identifier: id, enabled: false }] }],
  }));
  const e = presetLib.listEntries(report.preset_id)[0];
  assert.equal(e.enabled, false, 'order.enabled=false 应胜出');
});

test('order 缺失 prompt：追加到末尾并强制 disabled（酒馆不渲染未列入 order 的条目）', () => {
  const id1 = 'aaaaaaaa-1111-4111-a111-111111111113';
  const id2 = 'aaaaaaaa-1111-4111-a111-111111111114';
  const id3 = 'aaaaaaaa-1111-4111-a111-111111111115';
  const report = importLib.importSillyTavernPreset(JSON.stringify({
    prompts: [
      { identifier: id1, name: 'in-order', role: 'user', enabled: true },
      { identifier: id2, name: 'not-in-order-false', role: 'user', enabled: false },
      { identifier: id3, name: 'not-in-order-true', role: 'user', enabled: true },
    ],
    prompt_order: [{ character_id: 100001, order: [{ identifier: id1, enabled: true }] }],
  }));
  assert.equal(report.total, 3);
  const entries = presetLib.listEntries(report.preset_id);
  const e1 = entries.find(e => e.name === 'in-order');
  const e2 = entries.find(e => e.name === 'not-in-order-false');
  const e3 = entries.find(e => e.name === 'not-in-order-true');
  assert.ok(e1 && e2 && e3);
  assert.ok(e1.sort_order < e2.sort_order, '未在 order 中的应排到后面');
  assert.ok(e2.sort_order < e3.sort_order, '未在 order 中的相对顺序保持');
  assert.equal(e1.enabled, true, 'order.enabled=true 应生效');
  assert.equal(e2.enabled, false, '未在 order 中的强制 disabled（不受 prompt.enabled=false 影响）');
  assert.equal(e3.enabled, false, '未在 order 中的即使 prompt.enabled=true 也应强制 disabled');
});

test('order 引用不存在的 prompt：剔除', () => {
  const report = importLib.importSillyTavernPreset(JSON.stringify({
    prompts: [],
    prompt_order: [{ character_id: 100001, order: [{ identifier: 'ghost-id-1', enabled: true }] }],
  }));
  assert.equal(report.total, 0);
});

test('核心 6 marker 全部识别', () => {
  const mkPrompt = (id, name) => ({ identifier: id, name, role: 'system', content: '' });
  const mkOrder = (id) => ({ identifier: id, enabled: true });
  const six = ['charDescription', 'charPersonality', 'scenario', 'dialogueExamples', 'chatHistory', 'memoryPackage'];
  const report = importLib.importSillyTavernPreset(JSON.stringify({
    prompts: six.map(id => mkPrompt(id, id)),
    prompt_order: [{ character_id: 100001, order: six.map(id => mkOrder(id)) }],
  }));
  assert.equal(report.markers_recognized, 6);
  const entries = presetLib.listEntries(report.preset_id);
  const charDesc = entries.find(e => e.marker_key === 'charDescription');
  assert.ok(charDesc);
  assert.equal(charDesc.is_marker, true);
  assert.equal(charDesc.content, '');
});

test('墓碑 marker：marker=true 的内建占位条目自动 disabled + content 为空', () => {
  const report = importLib.importSillyTavernPreset(JSON.stringify({
    prompts: [
      { identifier: 'worldInfoBefore', name: 'World Info (before)', role: 'user', enabled: true, marker: true },
      { identifier: 'personaDescription', name: 'Persona Description', role: 'user', enabled: true, marker: true },
      { identifier: 'agentTask', name: 'Agent Task', role: 'user', enabled: true, marker: true },
    ],
    prompt_order: [{ character_id: 100001, order: [
      { identifier: 'worldInfoBefore', enabled: true },
      { identifier: 'personaDescription', enabled: true },
      { identifier: 'agentTask', enabled: true },
    ]}],
  }));
  assert.equal(report.markers_disabled, 3, 'marker=true 且非核心映射的条目都应转墓碑');
  const entries = presetLib.listEntries(report.preset_id);
  for (const e of entries) {
    assert.equal(e.enabled, false, `${e.name} 应自动 disabled`);
    assert.equal(e.content, '', `${e.name} 应 content 为空`);
    assert.equal(e.is_marker, false);
    assert.equal(e.marker_key, null);
  }
});

test('marker=false 的内建 regular 条目（main/jailbreak 等）保留内容并按 order.enabled 启用', () => {
  const report = importLib.importSillyTavernPreset(JSON.stringify({
    prompts: [
      { identifier: 'main', name: 'Main Prompt', role: 'system', enabled: true, marker: false, content: '这是主提示正文' },
      { identifier: 'jailbreak', name: 'Post-History', role: 'system', enabled: false, marker: false, content: '越狱正文' },
    ],
    prompt_order: [{ character_id: 100001, order: [
      { identifier: 'main', enabled: true },
      { identifier: 'jailbreak', enabled: false },
    ]}],
  }));
  assert.equal(report.markers_disabled, 0, 'marker=false 的内建条目不应转墓碑');
  const entries = presetLib.listEntries(report.preset_id);
  const main = entries.find(e => e.name === 'Main Prompt');
  const jailbreak = entries.find(e => e.name === 'Post-History');
  assert.ok(main && jailbreak);
  assert.equal(main.content, '这是主提示正文', 'marker=false 的 main 应保留正文');
  assert.equal(main.enabled, true, 'order.enabled=true 应生效');
  assert.equal(jailbreak.content, '越狱正文', 'marker=false 的 jailbreak 应保留正文');
  assert.equal(jailbreak.enabled, false, 'order.enabled=false 应生效');
});

test('injection_trigger 字段忽略（Q6b）', () => {
  const id = 'aaaaaaaa-1111-4111-a111-111111111115';
  const report = importLib.importSillyTavernPreset(JSON.stringify({
    prompts: [{
      identifier: id, name: 'has-triggers', role: 'user', content: 'x', enabled: true,
      injection_trigger: ['normal', 'quiet'],
    }],
    prompt_order: [{ character_id: 100001, order: [{ identifier: id, enabled: true }] }],
  }));
  const e = presetLib.listEntries(report.preset_id)[0];
  // 我们 schema 不存 injection_trigger；只确保入库成功且核心字段正确
  assert.equal(e.name, 'has-triggers');
  assert.equal(e.content, 'x');
});

test('显式传入 presetName 覆盖导入名', () => {
  const report = importLib.importSillyTavernPreset(JSON.stringify({ prompts: [] }), { presetName: '我的预设' });
  assert.equal(report.preset_name, '我的预设');
  const p = presetLib.getPreset(report.preset_id);
  assert.equal(p.name, '我的预设');
});

test('重复导入同一酒馆预设会生成独立内部 entry id', () => {
  const identifier = 'aaaaaaaa-1111-4111-a111-111111111116';
  const json = JSON.stringify({
    prompts: [{
      identifier,
      name: 'shared',
      role: 'user',
      content: 'hello',
      enabled: true,
    }],
    prompt_order: [{
      character_id: 100001,
      order: [{ identifier, enabled: true }],
    }],
  });

  const first = importLib.importSillyTavernPreset(json);
  const second = importLib.importSillyTavernPreset(json);
  const firstEntry = presetLib.listEntries(first.preset_id)[0];
  const secondEntry = presetLib.listEntries(second.preset_id)[0];

  assert.notEqual(firstEntry.id, identifier);
  assert.notEqual(secondEntry.id, identifier);
  assert.notEqual(firstEntry.id, secondEntry.id);
  assert.equal(firstEntry.content, secondEntry.content);
});

test('LumiMuse native export can be imported with all preset and entry fields preserved', () => {
  const source = presetLib.createPreset({
    name: '原生往返',
    description: '完整描述',
    story_plot_strip: true,
    strip_tags: ['content', 'scene', '#think'],
  });
  presetLib.upsertEntry({
    preset_id: source.id,
    name: 'unbounded depth',
    role: 'assistant',
    content: 'payload',
    is_system_prompt: true,
    injection_position: 1,
    injection_depth: 1_000_000_000,
    injection_order: -50,
    forbid_overrides: true,
    enabled: false,
    sort_order: 30,
  });
  presetLib.upsertEntry({
    preset_id: source.id,
    name: 'memory marker',
    role: 'system',
    content: '',
    is_marker: true,
    marker_key: 'memoryPackage',
    enabled: true,
    sort_order: 10,
  });

  const exported = exportLib.buildLumiMusePresetExport(source.id);
  const report = importLib.importSillyTavernPreset(
    JSON.stringify(exported),
    { presetName: 'lumimuse-preset-原生往返' },
  );
  const importedPreset = presetLib.getPreset(report.preset_id);
  const importedEntries = presetLib.listEntries(report.preset_id);
  const originalEntries = presetLib.listEntries(source.id);

  assert.equal(importedPreset.name, source.name);
  assert.equal(importedPreset.description, source.description);
  assert.equal(importedPreset.story_plot_strip, true);
  assert.deepEqual(importedPreset.strip_tags, source.strip_tags, 'strip_tags 应完整往返');
  assert.equal(report.total, originalEntries.length);
  assert.deepEqual(
    importedEntries.map(({ id, preset_id, created_at, updated_at, ...entry }) => entry),
    originalEntries.map(({ id, preset_id, created_at, updated_at, ...entry }) => entry),
  );
  assert.ok(importedEntries.every((entry, index) => entry.id !== originalEntries[index].id));
});

test('legacy LumiMuse v1 without strip_tags imports with empty rules for re-import', () => {
  const source = presetLib.createPreset({
    name: 'legacy native',
    story_plot_strip: true,
  });
  const exported = exportLib.buildLumiMusePresetExport(source.id);
  delete exported.preset.strip_tags;

  const report = importLib.importSillyTavernPreset(JSON.stringify(exported));
  const importedPreset = presetLib.getPreset(report.preset_id);

  assert.deepEqual(importedPreset.strip_tags, []);
});

test('LumiMuse native explicit empty strip_tags is preserved', () => {
  const source = presetLib.createPreset({
    name: 'explicitly empty native',
    story_plot_strip: true,
    strip_tags: [],
  });
  const exported = exportLib.buildLumiMusePresetExport(source.id);

  const report = importLib.importSillyTavernPreset(JSON.stringify(exported));
  assert.deepEqual(presetLib.getPreset(report.preset_id).strip_tags, []);
});

test('LumiMuse native import rejects malformed metadata or entries without partial writes', () => {
  const source = presetLib.createPreset({ name: 'strict native' });
  presetLib.upsertEntry({
    preset_id: source.id,
    name: 'valid',
    role: 'user',
    content: 'hello',
    is_marker: false,
    marker_key: null,
  });
  const exported = exportLib.buildLumiMusePresetExport(source.id);
  const presetCountBefore = presetLib.listPresets().length;

  const invalidPayloads = [
    { ...exported, version: 2 },
    { ...exported, preset: { name: 'missing fields' } },
    { ...exported, entries: [null] },
    { ...exported, entries: [{ ...exported.entries[0], role: 'tool' }] },
    { ...exported, entries: [{ ...exported.entries[0], injection_position: 2 }] },
    { ...exported, entries: [{ ...exported.entries[0], injection_depth: -1 }] },
    {
      ...exported,
      entries: [{
        ...exported.entries[0],
        is_marker: true,
        marker_key: null,
      }],
    },
  ];

  for (const payload of invalidPayloads) {
    assert.throws(
      () => importLib.importSillyTavernPreset(JSON.stringify(payload)),
      /LumiMuse/,
    );
  }
  assert.equal(presetLib.listPresets().length, presetCountBefore);
});

test('LumiMuse native import rejects invalid, duplicate, or conflicting strip_tags without writes', () => {
  const source = presetLib.createPreset({ name: 'strict strip tags' });
  const exported = exportLib.buildLumiMusePresetExport(source.id);
  const presetCountBefore = presetLib.listPresets().length;
  const invalidRules = [
    ['#'],
    [''],
    ['not a tag'],
    ['content', 'CONTENT'],
    ['think', '#Think'],
  ];

  for (const strip_tags of invalidRules) {
    assert.throws(
      () => importLib.importSillyTavernPreset(JSON.stringify({
        ...exported,
        preset: { ...exported.preset, strip_tags },
      })),
      /strip_tags/,
    );
  }
  assert.equal(presetLib.listPresets().length, presetCountBefore);
});

test('auto-detect 可待协议：content+thinking 同时出现 → 默认 strip_tags 含 scene/content/#think/#thinking/#output-template', () => {
  const id = 'aaaaaaaa-1111-4111-a111-111111111120';
  const report = importLib.importSillyTavernPreset(JSON.stringify({
    prompts: [{
      identifier: id,
      name: 'kedai-formatter',
      role: 'user',
      enabled: true,
      // 内含 content+scene+thinking+output-template 指导
      content: '请在 <scene>…地点…</scene> 后用 <content>…正文…</content> 回应，思考放 <thinking>…</thinking> 或 <think>…</think>，输出遵循 <output-template>',
    }],
    prompt_order: [{ character_id: 100001, order: [{ identifier: id, enabled: true }] }],
  }));
  const preset = presetLib.getPreset(report.preset_id);
  assert.equal(preset.story_plot_strip, true, '可待协议应开启剥离');
  assert.deepEqual(
    preset.strip_tags,
    ['content', 'scene', '#think', '#thinking', '#output-template'],
    'strip_tags 应包含 block 容器 + drop 草稿/模板',
  );
});

test('auto-detect RONG 协议不与可待混淆：story_plot 单独出现 → 默认 strip_tags 是 RONG 列表', () => {
  const id = 'aaaaaaaa-1111-4111-a111-111111111121';
  const report = importLib.importSillyTavernPreset(JSON.stringify({
    prompts: [{
      identifier: id, name: 'rong-protocol', role: 'user', enabled: true,
      content: '{{setvar::rong_story_protocol::STORY_PLOT_OUTPUT}}<story_plot><story_body>…</story_body></story_plot>',
    }],
    prompt_order: [{ character_id: 100001, order: [{ identifier: id, enabled: true }] }],
  }));
  const preset = presetLib.getPreset(report.preset_id);
  assert.equal(preset.story_plot_strip, true);
  assert.deepEqual(
    preset.strip_tags,
    ['story_plot', 'story_scene', 'story_body', 'story_after_format', 'story_done'],
    'RONG 应启用旧剥离路径专用 tag 列表',
  );
});

test('auto-detect 可待协议不被同前缀 tag 误命中：<content_policy>+<thinking_style> → 不启用剥离', () => {
  const id = 'aaaaaaaa-1111-4111-a111-111111111123';
  const report = importLib.importSillyTavernPreset(JSON.stringify({
    prompts: [{
      identifier: id, name: 'policy-preset', role: 'user', enabled: true,
      // 只是碰巧含同前缀 tag：误判会把 #think/#thinking 当 drop 规则，连正文一起丢
      content: '遵守 <content_policy>安全条款</content_policy> 并参考 <thinking_style>冷静</thinking_style>',
    }],
    prompt_order: [{ character_id: 100001, order: [{ identifier: id, enabled: true }] }],
  }));
  const preset = presetLib.getPreset(report.preset_id);
  assert.equal(preset.story_plot_strip, false, '同前缀 tag 不应被认作可待协议');
  assert.deepEqual(preset.strip_tags, []);
});

test('auto-detect 可待协议：自闭合与带属性写法仍能命中', () => {
  const id = 'aaaaaaaa-1111-4111-a111-111111111124';
  const report = importLib.importSillyTavernPreset(JSON.stringify({
    prompts: [{
      identifier: id, name: 'kedai-variant', role: 'user', enabled: true,
      content: '正文写进 <content lang="zh">…</content>，草稿放 <think/>',
    }],
    prompt_order: [{ character_id: 100001, order: [{ identifier: id, enabled: true }] }],
  }));
  const preset = presetLib.getPreset(report.preset_id);
  assert.equal(preset.story_plot_strip, true);
  assert.deepEqual(preset.strip_tags, ['content', 'scene', '#think', '#thinking', '#output-template']);
});

test('两协议都不命中：strip_tags=[] 且 story_plot_strip=false', () => {
  const id = 'aaaaaaaa-1111-4111-a111-111111111122';
  const report = importLib.importSillyTavernPreset(JSON.stringify({
    prompts: [{ identifier: id, name: 'plain', role: 'user', enabled: true, content: '完全没协议的普通提示' }],
    prompt_order: [{ character_id: 100001, order: [{ identifier: id, enabled: true }] }],
  }));
  const preset = presetLib.getPreset(report.preset_id);
  assert.equal(preset.story_plot_strip, false);
  assert.deepEqual(preset.strip_tags, []);
});
