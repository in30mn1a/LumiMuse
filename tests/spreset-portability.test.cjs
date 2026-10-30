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
  module._compile(ts.transpileModule(source, {
    compilerOptions: {
      esModuleInterop: true,
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
    fileName: filename,
  }).outputText, filename);
};

let dbModule;
let db;
let presetLib;
let importLib;
let exportLib;
let configLib;
const databases = [];

function createDb() {
  const result = new Database(':memory:');
  result.pragma('foreign_keys = ON');
  dbModule.__migrateForTests(result);
  databases.push(result);
  return result;
}

test.beforeEach(() => {
  for (const key of Object.keys(require.cache)) {
    if (key.startsWith(path.join(root, 'src', 'lib') + path.sep)) delete require.cache[key];
  }
  dbModule = require('../src/lib/db.ts');
  dbModule.__resetDbForTests();
  db = createDb();
  dbModule.__setDbForTests(db);
  presetLib = require('../src/lib/prompt-presets.ts');
  importLib = require('../src/lib/prompt-preset-import.ts');
  exportLib = require('../src/lib/prompt-preset-export.ts');
  configLib = require('../src/lib/spreset/config.ts');
});

test.afterEach(() => {
  for (const database of databases.splice(0)) database.close();
  dbModule.__resetDbForTests();
});

function makeSource() {
  const report = importLib.importSillyTavernPreset(JSON.stringify({
    name: 'Portable runtime',
    prompts: [
      { identifier: 'reply-source', name: 'Reply', role: 'system', content: 'Use reply.' },
      { identifier: 'off-source', name: 'Disabled', role: 'system', content: 'Off.', enabled: false },
    ],
    extensions: {
      SPreset: {
        FinalRequestProcessing: { enabled: true, script: '({ request }) => request' },
        ToolBindings: {
          'reply-source': { enabled: true, valid: true, resolvedName: 'reply', code: 'return { name: "reply" };' },
          'off-source': { enabled: true, valid: true, resolvedName: 'off', code: 'return { name: "off" };' },
        },
        MessageInjections: { 'reply-source': { enabled: false, content: 'retained' } },
        LogUpload: { enabled: true, url: 'https://example.com/upload' },
      },
      otherPlugin: { retained: true },
    },
  }));
  return { preset: presetLib.getPreset(report.preset_id), entries: presetLib.listEntries(report.preset_id) };
}

function assertRuntimeBindings(preset, entries) {
  const reply = entries.find(entry => entry.name === 'Reply');
  const disabled = entries.find(entry => entry.name === 'Disabled');
  const spreset = preset.extensions.SPreset;
  assert.deepEqual(Object.keys(spreset.ToolBindings).sort(), [reply.id, disabled.id].sort());
  assert.deepEqual(Object.keys(spreset.MessageInjections), [reply.id]);
  assert.equal(spreset.MessageInjections[reply.id].content, 'retained');
  assert.equal(Object.hasOwn(spreset, 'LogUpload'), false);
  assert.deepEqual(preset.extensions.otherPlugin, { retained: true });
  assert.equal(spreset.FinalRequestProcessing.script, '({ request }) => request');
  const enabledIds = new Set(entries.filter(entry => entry.enabled).map(entry => entry.id));
  const activeTools = configLib.parseSpresetConfig(preset.extensions).tools
    .filter(binding => enabledIds.has(binding.entryId)).map(binding => binding.name);
  assert.deepEqual(activeTools, ['reply']);
}

async function assertRuntimeRequest(preset, entries) {
  const { initializeSandbox } = require('../src/lib/spreset/sandbox.ts');
  const { createPresetRuntime } = require('../src/lib/spreset/runtime.ts');
  const { DEFAULT_SETTINGS } = require('../src/types/index.ts');
  await initializeSandbox();
  const runtime = createPresetRuntime(preset, entries);
  assert.ok(runtime);
  try {
    const request = await runtime.buildRequest([{ role: 'user', content: 'Test input.' }], DEFAULT_SETTINGS);
    assert.deepEqual(request.tools.map(tool => tool.function.name), ['reply']);
  } finally {
    runtime.dispose();
  }
}

function loadRoute(routeName, database) {
  const mocks = {
    'next/server': { NextResponse: { json: (body, init = {}) => ({ status: init.status ?? 200, json: async () => body }) } },
    '@/lib/db': { getDb: () => database },
    '@/lib/route-auth': { requireAuth: async () => null },
  };
  Module._load = function loadWithMocks(request, parent, isMain) {
    return Object.hasOwn(mocks, request)
      ? mocks[request]
      : originalLoad.call(this, request, parent, isMain);
  };
  try {
    const filename = require.resolve(`../src/app/api/${routeName}/route.ts`);
    delete require.cache[filename];
    return require(filename);
  } finally {
    Module._load = originalLoad;
  }
}

function importRequest(payload) {
  const raw = JSON.stringify(payload);
  return {
    headers: { get: name => name === 'content-length' ? String(Buffer.byteLength(raw)) : null },
    nextUrl: new URL('http://test.local/api/import'),
    text: async () => raw,
  };
}

test('native exports identify source entries and remap enabled and disabled plugin bindings on every import', async () => {
  const source = makeSource();
  const exported = exportLib.buildLumiMusePresetExport(source.preset.id);
  assert.deepEqual(exported.entries.map(entry => entry.id), source.entries.map(entry => entry.id));
  for (let round = 0; round < 2; round += 1) {
    const report = importLib.importSillyTavernPreset(JSON.stringify(exported));
    const restored = presetLib.getPreset(report.preset_id);
    const restoredEntries = presetLib.listEntries(report.preset_id);
    assertRuntimeBindings(restored, restoredEntries);
    await assertRuntimeRequest(restored, restoredEntries);
    assert.ok(restoredEntries.every(entry => !source.entries.some(original => original.id === entry.id)));
  }
});

test('SillyTavern marker exports remap plugin keys to identifiers and restore a usable bound tool', async () => {
  const source = makeSource();
  const reply = source.entries.find(entry => entry.name === 'Reply');
  db.prepare('UPDATE prompt_preset_entries SET is_marker = 1, marker_key = ?, content = ? WHERE id = ?')
    .run('charDescription', '', reply.id);
  const exported = exportLib.buildSillyTavernPresetExport(source.preset.id);
  assert.ok(exported.prompts.some(prompt => prompt.identifier === 'charDescription'));
  assert.ok(Object.hasOwn(exported.extensions.SPreset.ToolBindings, 'charDescription'));
  assert.deepEqual(Object.keys(exported.extensions.SPreset.MessageInjections), ['charDescription']);
  const report = importLib.importSillyTavernPreset(JSON.stringify(exported));
  const restored = presetLib.getPreset(report.preset_id);
  const restoredEntries = presetLib.listEntries(report.preset_id);
  assertRuntimeBindings(restored, restoredEntries);
  await assertRuntimeRequest(restored, restoredEntries);
});

test('legacy native files without entry ids or extensions remain importable', () => {
  const source = makeSource();
  const exported = exportLib.buildLumiMusePresetExport(source.preset.id);
  delete exported.preset.extensions;
  for (const entry of exported.entries) delete entry.id;
  const report = importLib.importSillyTavernPreset(JSON.stringify(exported));
  assert.equal(report.total, source.entries.length);
  assert.deepEqual(presetLib.getPreset(report.preset_id).extensions, {});
});

test('native source entry ids are validated before writing and LogUpload is never restored', () => {
  const source = makeSource();
  const exported = exportLib.buildLumiMusePresetExport(source.preset.id);
  const before = presetLib.listPresets().length;
  for (const invalidId of ['', 1, null, exported.entries[1].id]) {
    const invalid = structuredClone(exported);
    invalid.entries[0].id = invalidId;
    assert.throws(() => importLib.importSillyTavernPreset(JSON.stringify(invalid)), /id/i);
    assert.equal(presetLib.listPresets().length, before);
  }
  exported.preset.extensions.SPreset.LogUpload = { enabled: true };
  const report = importLib.importSillyTavernPreset(JSON.stringify(exported));
  assertRuntimeBindings(presetLib.getPreset(report.preset_id), presetLib.listEntries(report.preset_id));
});

for (const type of ['all', 'character']) {
  test(`${type} backups restore extensions, new binding ids and equal-sort entry ordering`, async () => {
    const source = makeSource();
    db.prepare('UPDATE prompt_preset_entries SET sort_order = 0 WHERE preset_id = ?').run(source.preset.id);
    db.prepare('INSERT INTO characters (id, name, active_preset_id) VALUES (?, ?, ?)')
      .run('source-char', 'Portable character', source.preset.id);
    db.prepare(`INSERT INTO character_model_preset_bindings
      (character_id, model, preset_id, created_at, updated_at) VALUES (?, ?, ?, '', '')`)
      .run('source-char', 'test-model', source.preset.id);
    const response = await loadRoute('export', db).GET({
      nextUrl: new URL(`http://test.local/api/export?type=${type}${type === 'character' ? '&id=source-char' : ''}`),
    });
    const payload = await response.json();
    const extensions = JSON.parse(payload.prompt_presets[0].extensions);
    extensions.SPreset.LogUpload = { enabled: true };
    payload.prompt_presets[0].extensions = type === 'all' ? JSON.stringify(extensions) : extensions;
    const target = createDb();
    const restoredResponse = await loadRoute('import', target).POST(importRequest(payload));
    assert.equal(restoredResponse.status, 200);
    const presetRow = target.prepare('SELECT * FROM prompt_presets').get();
    const entries = target.prepare('SELECT * FROM prompt_preset_entries ORDER BY sort_order, id').all();
    assertRuntimeBindings({ extensions: JSON.parse(presetRow.extensions) }, entries);
    await assertRuntimeRequest({ extensions: JSON.parse(presetRow.extensions) }, entries);
    assert.notEqual(presetRow.id, source.preset.id);
    assert.deepEqual(entries.map(entry => entry.name), presetLib.listEntries(source.preset.id).map(entry => entry.name));
    assert.ok(entries.every(entry => entry.preset_id === presetRow.id
      && !source.entries.some(original => original.id === entry.id)));
    assert.equal(target.prepare('SELECT active_preset_id FROM characters').get().active_preset_id, presetRow.id);
    assert.equal(target.prepare('SELECT preset_id FROM character_model_preset_bindings').get().preset_id, presetRow.id);
  });
}

test('backup imports without extensions preserve the legacy empty default', async () => {
  const target = createDb();
  const response = await loadRoute('import', target).POST(importRequest({
    characters: [], prompt_presets: [{ id: 'old', name: 'Legacy' }], prompt_preset_entries: [],
  }));
  assert.equal(response.status, 200);
  assert.equal(target.prepare('SELECT extensions FROM prompt_presets').get().extensions, '{}');
});

test('malformed backup extensions fail before any preset is restored', async () => {
  const target = createDb();
  const route = loadRoute('import', target);
  for (const extensions of ['{broken', '[]', null, []]) {
    const response = await route.POST(importRequest({
      characters: [], prompt_presets: [{ id: 'old', name: 'Invalid', extensions }], prompt_preset_entries: [],
    }));
    assert.equal(response.status, 400);
    assert.equal(target.prepare('SELECT COUNT(*) AS count FROM prompt_presets').get().count, 0);
  }
});
