const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');
const Database = require('better-sqlite3');
const root = path.resolve(__dirname, '..');
const originalResolve = Module._resolveFilename;
const originalLoad = Module._load;
let mocks = {};
Module._resolveFilename = function (request, parent, isMain, options) {
  if (request.startsWith('@/')) {
    const mapped = path.join(root, 'src', request.slice(2));
    for (const file of [mapped, `${mapped}.ts`, `${mapped}.tsx`, path.join(mapped, 'index.ts')]) {
      if (fs.existsSync(file) && fs.statSync(file).isFile()) return file;
    }
  }
  return originalResolve.call(this, request, parent, isMain, options);
};
Module._load = function (request, parent, isMain) {
  if (Object.hasOwn(mocks, request)) return mocks[request];
  return originalLoad.call(this, request, parent, isMain);
};
function compile(module, filename, suffix = '') {
  const output = ts.transpileModule(fs.readFileSync(filename, 'utf8') + suffix, {
    fileName: filename,
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true, jsx: ts.JsxEmit.ReactJSX },
  });
  module._compile(output.outputText, filename);
}
require.extensions['.ts'] = compile;
require.extensions['.tsx'] = compile;
function fresh(relative) {
  const file = path.join(root, relative);
  delete require.cache[require.resolve(file)];
  return require(file);
}
const dbModule = fresh('src/lib/db.ts');
function memoryDb() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  dbModule.__migrateForTests(db);
  return db;
}
function request(payload, endpoint) {
  return {
    nextUrl: new URL(`http://test.invalid${endpoint}`),
    headers: new Headers(), signal: new AbortController().signal,
    json: async () => payload, text: async () => JSON.stringify(payload),
  };
}

test('SEC-01: partial provider updates enforce the key boundary in actual model requests', async () => {
  const db = memoryDb();
  try {
    const id = '11111111-1111-4111-8111-111111111111';
    db.prepare('INSERT INTO api_providers (id, name, api_base, api_key, model) VALUES (?, ?, ?, ?, ?)')
      .run(id, 'Fixture', 'https://first.invalid/v1', 'old-key', 'model');
    let outgoing;
    mocks = {
      '@/lib/db': { getDb: () => db }, '@/lib/route-auth': { requireAuth: async () => null },
      '@/lib/ssrf-guard': { safeFetch: async (url, init) => {
        outgoing = { url, authorization: init.headers.Authorization };
        return Response.json({ data: [] });
      } },
    };
    const route = fresh('src/app/api/providers/route.ts');
    const models = fresh('src/app/api/models/route.ts');
    for (const [patch, expectedKey] of [
      [{ name: 'Renamed' }, 'old-key'],
      [{ api_base: 'https://second.invalid/v1', save_as_current: true }, ''],
      [{ api_key: 'new-key' }, 'new-key'],
      [{ api_base: 'https://third.invalid/v1', api_key: 'explicit-key' }, 'explicit-key'],
      [{ api_key: '********' }, 'explicit-key'],
      [{ api_base: 'https://fourth.invalid/v1', api_key: '********' }, ''],
    ]) {
      const response = await route.PUT(request({ id, ...patch }, '/api/providers'));
      assert.equal(response.status, 200);
      const row = db.prepare('SELECT * FROM api_providers WHERE id = ?').get(id);
      assert.equal(row.api_key, expectedKey);
      outgoing = undefined;
      const modelResponse = await models.POST(request({ provider_id: id, refresh: true }, '/api/models'));
      if (expectedKey) {
        assert.equal(outgoing.url, `${row.api_base}/models`);
        assert.equal(outgoing.authorization, `Bearer ${expectedKey}`);
      } else {
        assert.equal(modelResponse.status, 400);
        assert.equal(outgoing, undefined);
      }
      if (patch.save_as_current) assert.equal(JSON.parse(db.prepare("SELECT value FROM settings WHERE key='api_key'").get().value), '');
    }
  } finally { db.close(); }
});

for (const type of ['all', 'character']) {
  test(`SEC-02: ${type} backup restores actual preset prompts, defaults, bindings and entry settings`, async () => {
    const source = memoryDb();
    const target = memoryDb();
    let current = source;
    try {
      mocks = { '@/lib/db': { getDb: () => current }, '@/lib/route-auth': { requireAuth: async () => null } };
      const presets = fresh('src/lib/prompt-presets.ts');
      const preset = presets.createPreset({ name: '角色表现', strip_tags: ['scratch'] });
      const instruction = 'KEEP_THIS_CHARACTER_FORMAL_AND_CALM';
      presets.upsertEntry({ preset_id: preset.id, name: '角色约束', role: 'system', content: instruction, is_system_prompt: true });
      presets.upsertEntry({ preset_id: preset.id, name: '同序条目', role: 'user', content: 'SECOND_ENABLED_INSTRUCTION', injection_position: 1, injection_depth: 1, injection_order: 3, forbid_overrides: true });
      presets.upsertEntry({ preset_id: preset.id, name: '停用内容', role: 'system', content: 'DISABLED_INSTRUCTION', enabled: false });
      source.prepare('INSERT INTO characters (id, name, active_preset_id) VALUES (?, ?, ?)').run('original', '角色一', preset.id);
      source.prepare('INSERT INTO characters (id, name, active_preset_id) VALUES (?, ?, ?)').run('shared', '角色二', preset.id);
      presets.replaceCharacterModelPresetBindings('original', [{ model: 'fixture-model', preset_id: preset.id }, { model: 'no-preset', preset_id: '__none__' }]);
      const { DEFAULT_SETTINGS } = fresh('src/types/index.ts');
      const { assemblePresetPrompt } = fresh('src/lib/prompt-preset-assembler.ts');
      const settings = { ...DEFAULT_SETTINGS, model: 'fixture-model', show_timestamps: false };
      const before = await assemblePresetPrompt(source.prepare("SELECT * FROM characters WHERE id='original'").get(), [], settings, '', undefined, preset, presets.loadEnabledEntries(preset.id));
      assert.ok(JSON.stringify(before).includes(instruction));
      const backup = await (await fresh('src/app/api/export/route.ts').GET(request(null, `/api/export?type=${type}&id=original`))).json();
      assert.equal(backup.version, 3);
      assert.equal(backup.prompt_presets.length, 1);
      assert.equal(backup.prompt_preset_entries.length, 3);
      current = target;
      // 同 ID 但不同内容的现存预设必须完整保留。
      target.prepare('INSERT INTO prompt_presets (id, name) VALUES (?, ?)').run(preset.id, '目标已有预设');
      const importedResponse = await fresh('src/app/api/import/route.ts').POST(request(backup, '/api/import'));
      assert.equal(importedResponse.status, 200);
      const imported = target.prepare("SELECT * FROM characters WHERE name='角色一'").get();
      assert.notEqual(imported.active_preset_id, preset.id);
      assert.equal(target.prepare('SELECT name FROM prompt_presets WHERE id=?').get(preset.id).name, '目标已有预设');
      const resolved = presets.resolveActivePreset(imported, 'fixture-model');
      assert.equal(resolved.id, imported.active_preset_id);
      assert.deepEqual(resolved.strip_tags, ['scratch']);
      assert.equal(presets.resolveActivePreset(imported, 'no-preset'), null);
      assert.equal(presets.resolveActivePreset(imported, 'unbound-model').id, resolved.id);
      assert.equal(presets.listEntries(resolved.id).length, 3);
      assert.equal(presets.loadEnabledEntries(resolved.id).length, 2);
      const normalizedEntry = ({ id, preset_id, ...entry }) => entry;
      assert.deepEqual(presets.listEntries(resolved.id).map(normalizedEntry), backup.prompt_preset_entries
        .filter(entry => entry.preset_id === preset.id).map(entry => ({
          ...entry, is_marker: Boolean(entry.is_marker), is_system_prompt: Boolean(entry.is_system_prompt),
          forbid_overrides: Boolean(entry.forbid_overrides), enabled: Boolean(entry.enabled),
          injection_trigger: JSON.parse(entry.injection_trigger),
        })).map(normalizedEntry));
      const after = await assemblePresetPrompt(imported, [], settings, '', undefined, resolved, presets.loadEnabledEntries(resolved.id));
      assert.deepEqual(after, before);
      if (type === 'all') assert.equal(target.prepare("SELECT active_preset_id FROM characters WHERE name='角色二'").get().active_preset_id, resolved.id);
      assert.equal((await importedResponse.json()).warnings.length, 0);
    } finally { source.close(); target.close(); }
  });
}

test('SEC-02: old backups warn for missing presets and reuse existing presets without modifying them', async () => {
  const db = memoryDb();
  try {
    mocks = { '@/lib/db': { getDb: () => db }, '@/lib/route-auth': { requireAuth: async () => null } };
    db.prepare('INSERT INTO prompt_presets (id, name) VALUES (?, ?)').run('existing', '现存');
    const importer = fresh('src/app/api/import/route.ts');
    for (const id of ['missing', 'existing', '__none__']) {
      const result = await importer.POST(request({ character: { id: `char-${id}`, name: id, active_preset_id: id }, model_preset_bindings: [{ model: 'm', preset_id: id }] }, '/api/import'));
      const body = await result.json();
      assert.equal(result.status, 200);
      const imported = db.prepare('SELECT * FROM characters WHERE name=?').get(id);
      assert.equal(imported.active_preset_id, id === 'missing' ? null : id);
      assert.equal(body.warnings.length, id === 'missing' ? 1 : 0);
      if (id === 'missing') { assert.equal(body.warnings[0].type, 'preset_missing'); assert.match(body.warnings[0].message, /重新导出完整备份/); }
    }
  } finally { db.close(); }
});

test('SEC-02: target overlay returns mapped default and model choices for the editable character draft', async () => {
  const source = memoryDb();
  const target = memoryDb();
  let current = source;
  try {
    mocks = { '@/lib/db': { getDb: () => current }, '@/lib/route-auth': { requireAuth: async () => null } };
    const presets = fresh('src/lib/prompt-presets.ts');
    const preset = presets.createPreset({ name: '导入预设' });
    presets.upsertEntry({ preset_id: preset.id, name: '指令', role: 'system', content: 'RESTORE_CHARACTER_BEHAVIOR' });
    source.prepare('INSERT INTO characters (id, name, active_preset_id) VALUES (?, ?, ?)').run('original', '源角色', preset.id);
    presets.replaceCharacterModelPresetBindings('original', [{ model: 'fixture', preset_id: preset.id }]);
    const backup = await (await fresh('src/app/api/export/route.ts').GET(request(null, '/api/export?type=character&id=original'))).json();
    current = target;
    target.prepare('INSERT INTO characters (id, name) VALUES (?, ?)').run('target', '目标');
    const result = await fresh('src/app/api/import/route.ts').POST(request(backup, '/api/import?target_character_id=target'));
    assert.equal(result.status, 200);
    const { characterDraft } = await result.json();
    assert.notEqual(characterDraft.active_preset_id, preset.id);
    assert.equal(characterDraft.model_preset_bindings[0].preset_id, characterDraft.active_preset_id);
    assert.equal(presets.getPreset(characterDraft.active_preset_id).name, '导入预设');
    assert.equal(presets.loadCharacterModelPresetBindings('target')[0].preset_id, characterDraft.active_preset_id);
  } finally { source.close(); target.close(); }
});

test('SEC-02: malformed preset entries fail before writes and preset recovery rolls back with character writes', async () => {
  const db = memoryDb();
  try {
    mocks = { '@/lib/db': { getDb: () => db }, '@/lib/route-auth': { requireAuth: async () => null } };
    const importer = fresh('src/app/api/import/route.ts');
    const backup = {
      character: { id: 'original', name: '角色', active_preset_id: 'preset' },
      prompt_presets: [{ id: 'preset', name: '预设' }],
      prompt_preset_entries: [{ id: 'entry', preset_id: 'preset', name: '指令', role: 'invalid', content: 'instruction' }],
    };
    const invalid = await importer.POST(request(backup, '/api/import'));
    assert.equal(invalid.status, 400);
    assert.equal(db.prepare('SELECT count(*) AS n FROM prompt_presets').get().n, 0);
    db.exec("CREATE TRIGGER reject_character BEFORE INSERT ON characters BEGIN SELECT RAISE(ABORT, 'fixture-write-failure'); END");
    backup.prompt_preset_entries[0].role = 'system';
    await assert.rejects(importer.POST(request(backup, '/api/import')), /fixture-write-failure/);
    assert.equal(db.prepare('SELECT count(*) AS n FROM prompt_presets').get().n, 0);
    assert.equal(db.prepare('SELECT count(*) AS n FROM prompt_preset_entries').get().n, 0);
  } finally { db.close(); }
});

test('SEC-04: return navigation rejects URL-normalized external destinations', () => {
  mocks = { 'next/navigation': {}, 'next/image': {}, '@/lib/i18n-context': {} };
  const filename = path.join(root, 'src/app/login/page.tsx');
  const loaded = new Module(filename, module);
  loaded.filename = filename;
  loaded.paths = module.paths;
  compile(loaded, filename, '\nexport { safeReturnTo };');
  const { safeReturnTo } = loaded.exports;
  for (const value of [null, '', '//evil.invalid', '/\\evil.invalid', '/\t/evil.invalid', '/\n/evil.invalid', '/\r/evil.invalid', 'https://evil.invalid', '/\u0000/evil.invalid', '/a/..//evil.invalid', '/%2e%2e//evil.invalid']) {
    assert.equal(safeReturnTo(value), '/');
    assert.equal(new URL(safeReturnTo(value), 'https://lumimuse.invalid').origin, 'https://lumimuse.invalid');
  }
  for (const value of ['/characters/test', '/settings?tab=memory#profile', '/%E4%B8%AD%E6%96%87']) assert.equal(safeReturnTo(value), value);
  assert.equal(safeReturnTo('/characters/../settings?tab=memory#profile'), '/settings?tab=memory#profile');
});

test('summary coverage IDs survive actual export/import and select only summary plus uncovered history in runChat', async () => {
  const source = memoryDb();
  const target = memoryDb();
  let current = source;
  try {
    mocks = { '@/lib/db': { getDb: () => current }, '@/lib/route-auth': { requireAuth: async () => null } };
    source.prepare('INSERT INTO characters (id, name) VALUES (?, ?)').run('original', '总结角色');
    source.prepare('INSERT INTO conversations (id, character_id, title) VALUES (?, ?, ?)').run('root', 'original', '根对话');
    source.prepare('INSERT INTO conversations (id, character_id, title, parent_id, parent_seq_end) VALUES (?, ?, ?, ?, ?)').run('child', 'original', '链式对话', 'root', 4);
    const insert = source.prepare('INSERT INTO messages (id, conversation_id, role, content, seq, metadata) VALUES (?, ?, ?, ?, ?, ?)');
    insert.run('before', 'root', 'user', 'RAW_COVERED_BEFORE', 1, '{}');
    insert.run('summary', 'root', 'system', 'CUMULATIVE_SUMMARY_FACTS', 2, JSON.stringify({ isSummary: true, summaryCoverageVersion: 1, summarizedIds: ['before', 'after'] }));
    insert.run('after', 'root', 'assistant', 'RAW_COVERED_AFTER', 3, '{}');
    insert.run('uncovered', 'root', 'user', 'UNCOVERED_ROOT_MESSAGE', 4, '{}');
    insert.run('child-uncovered', 'child', 'user', 'UNCOVERED_CHILD_MESSAGE', 5, '{}');
    const backup = await (await fresh('src/app/api/export/route.ts').GET(request(null, '/api/export?type=all'))).json();
    // 原始数组中的 summary 在它覆盖的后续消息之前，必须延后至 ID 全部建立再映射。
    assert.equal(backup.conversations.length, 2);
    current = target;
    const imported = await fresh('src/app/api/import/route.ts').POST(request(backup, '/api/import'));
    assert.equal(imported.status, 200);
    let captured;
    mocks['@/lib/api-client'] = { chatCompletion: async (_settings, messages) => { captured = messages; return '测试回复'; } };
    mocks['@/lib/memory-engine'] = { retrieveRelevantMemories: () => [] };
    mocks['@/lib/memory-retrieval'] = { retrieveWorkingMemoryPackage: async () => ({ text: '', selectedMemories: [], tokenCount: 0, mode: 'test' }) };
    const { DEFAULT_SETTINGS } = fresh('src/types/index.ts');
    const { runChat } = fresh('src/lib/chat-engine.ts');
    for (const conversation of target.prepare('SELECT * FROM conversations ORDER BY title').all()) {
      const rows = target.prepare('SELECT * FROM messages WHERE conversation_id = ? ORDER BY seq').all(conversation.id);
      const summary = rows.find(row => JSON.parse(row.metadata).isSummary);
      const coveredIds = JSON.parse(summary.metadata).summarizedIds;
      assert.deepEqual(coveredIds, ['RAW_COVERED_BEFORE', 'RAW_COVERED_AFTER'].map(content => rows.find(row => row.content === content).id));
      const errors = [];
      await runChat(conversation.id, '', { ...DEFAULT_SETTINGS, streaming: false, memory_inject: false, show_timestamps: false }, {
        onChunk() {}, onDone() {}, onError(error) { errors.push(error); },
      }, { skipUserInsert: true });
      assert.deepEqual(errors, []);
      const prompt = JSON.stringify(captured);
      assert.equal(prompt.includes('RAW_COVERED_BEFORE'), false);
      assert.equal(prompt.includes('RAW_COVERED_AFTER'), false);
      assert.equal(prompt.split('CUMULATIVE_SUMMARY_FACTS').length - 1, 1);
      assert.equal(prompt.split('UNCOVERED_ROOT_MESSAGE').length - 1, 1);
      assert.equal(prompt.includes('UNCOVERED_CHILD_MESSAGE'), conversation.title === '链式对话');
    }
  } finally { source.close(); target.close(); }
});
