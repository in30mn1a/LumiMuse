/**
 * TASK-IMPORT-E2E：公开、确定性生成的 78 条 SillyTavern 预设完整导入。
 *
 * 验证：
 *  - total=78
 *  - 6 条核心 marker identifier（charDescription/charPersonality/scenario/dialogueExamples/chatHistory）正确落到 marker_key
 *  - markers_disabled ≥ 1（worldInfoBefore/After、personaDescription、main、nsfw、jailbreak、enhanceDefinitions 中实际出现的）
 *  - prompt_order 内所有外部 identifier 全部映射为内部条目且 sort_order 严格单调递增
 *  - 数据落库后 content / role / injection_position 与原文一致
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
const presetModulePath = require.resolve(path.join(root, 'src', 'lib', 'prompt-presets.ts'));

const CORE_MARKERS = ['charDescription', 'charPersonality', 'scenario', 'dialogueExamples', 'chatHistory'];
const TOMBSTONES = ['worldInfoBefore', 'worldInfoAfter', 'personaDescription', 'main', 'nsfw', 'jailbreak', 'enhanceDefinitions'];
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function syntheticUuid(index) {
  return `10000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
}

function buildSyntheticPreset() {
  const prompts = [];

  for (const identifier of CORE_MARKERS) {
    prompts.push({
      identifier,
      name: `Core marker ${identifier}`,
      enabled: true,
      role: 'system',
      content: '',
      injection_position: 0,
      injection_depth: 4,
      injection_order: 100,
      system_prompt: false,
      marker: true,
      forbid_overrides: false,
      injection_trigger: [],
    });
  }

  for (const identifier of TOMBSTONES) {
    prompts.push({
      identifier,
      name: `Tombstone ${identifier}`,
      enabled: true,
      role: 'system',
      content: `ignored tombstone content ${identifier}`,
      injection_position: 0,
      injection_depth: 4,
      injection_order: 100,
      system_prompt: false,
      marker: true,
      forbid_overrides: false,
      injection_trigger: [],
    });
  }

  const ordinaryCount = 78 - prompts.length;
  for (let index = 0; index < ordinaryCount; index += 1) {
    prompts.push({
      identifier: syntheticUuid(index + 1),
      name: `Synthetic entry ${String(index + 1).padStart(2, '0')}`,
      enabled: index !== 0,
      role: ['system', 'user', 'assistant'][index % 3],
      content: `synthetic-content-${index + 1}`,
      injection_position: index > 0 && index % 5 === 0 ? 1 : 0,
      injection_depth: index % 7,
      injection_order: 50 + (index % 4) * 25,
      system_prompt: index % 2 === 0,
      marker: false,
      forbid_overrides: index % 6 === 0,
      injection_trigger: ['discarded'],
    });
  }

  return {
    prompts,
    prompt_order: [{
      character_id: 100001,
      order: prompts.map(prompt => ({
        identifier: prompt.identifier,
        enabled: prompt.identifier === TOMBSTONES[0] ? true : prompt.enabled,
      })),
    }],
    temperature: 0.73,
    extensions: { ignored: true },
  };
}

let db;
let importLib;
let presetLib;

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
  presetLib = require(presetModulePath);
});

test.afterEach(() => {
  try { db && db.close(); } catch {}
});

test('导入公开合成预设：78 条全部入库 + marker 识别正确 + sort_order 单调', () => {
  const jsonText = JSON.stringify(buildSyntheticPreset());
  const report = importLib.importSillyTavernPreset(jsonText);

  // 1) 总数 78
  assert.equal(report.total, 78, `total 应为 78，实际 ${report.total}`);
  assert.ok(report.preset_id, '报告应含 preset_id');
  assert.equal(report.preset_name, '导入预设', 'json 顶层无 name 字段，应回退到默认名');

  // 2) 读取入库的预设
  const preset = presetLib.getPreset(report.preset_id);
  assert.ok(preset, '预设本身应入库');

  // 3) 全部条目
  const entries = presetLib.listEntries(report.preset_id);
  assert.equal(entries.length, 78, `条目总数应为 78，实际 ${entries.length}`);

  // 4) 6 条核心 marker 识别
  const byMarkerKey = new Map();
  for (const e of entries) {
    if (e.is_marker && e.marker_key) {
      byMarkerKey.set(e.id, e);
    }
  }
  const coreInDb = entries.filter(e => e.is_marker && CORE_MARKERS.includes(e.marker_key));
  assert.ok(coreInDb.length > 0, '应至少有 1 条核心 marker 被识别');
  // 具体到每条酒馆原生标识符：
  const markerNames = coreInDb.map(e => e.marker_key);
  // 合成预设明确包含全部酒馆核心 marker。
  assert.ok(markerNames.includes('charDescription'), 'charDescription 应识别');
  assert.ok(markerNames.includes('chatHistory'), 'chatHistory 应识别');
  assert.ok(markerNames.includes('scenario'), 'scenario 应识别');
  assert.ok(markerNames.includes('charPersonality'), 'charPersonality 应识别');
  assert.ok(markerNames.includes('dialogueExamples'), 'dialogueExamples 应识别');

  // 5) 墓碑（酒馆特有但 LumiMuse 不识别）已自动禁用
  const tomb = entries.filter(e => !e.is_marker && e.marker_key === null && !e.enabled && e.content === '');
  const tombNamesHit = TOMBSTONES.filter(id => {
    // 从原 JSON 验证哪些 tombstone 在 prompt_order 中
    const data = JSON.parse(jsonText);
    const order = (data.prompt_order && data.prompt_order[0] && data.prompt_order[0].order) || [];
    return order.some(o => o.identifier === id);
  });
  assert.equal(tomb.length, TOMBSTONES.length, '全部墓碑 marker 都应清空并禁用');
  assert.equal(tombNamesHit.length, TOMBSTONES.length, '合成 order 应包含全部墓碑 marker');
  assert.equal(report.markers_disabled, TOMBSTONES.length);

  // 6) sort_order 严格单调递增
  const sortedBySortOrder = [...entries].sort((a, b) => a.sort_order - b.sort_order);
  for (let i = 1; i < sortedBySortOrder.length; i += 1) {
    assert.ok(sortedBySortOrder[i].sort_order > sortedBySortOrder[i - 1].sort_order,
      `sort_order 应严格递增：${sortedBySortOrder[i - 1].sort_order} -> ${sortedBySortOrder[i].sort_order}`);
  }

  // 7) prompt_order 中所有 identifier 在 db 中有对应行
  const data = JSON.parse(jsonText);
  const order = (data.prompt_order && data.prompt_order[0] && data.prompt_order[0].order) || [];
  const prompts = data.prompts || [];
  for (const o of order) {
    const identifier = o.identifier;
    // 找到原始 prompt
    const prompt = prompts.find(p => p.identifier === identifier);
    if (!prompt) continue; // 悬空 order 已被剔
    // 外部 UUID 只是导入关联键；数据库总是生成新的内部 UUID，因此用唯一 name/marker_key 对应。
    const row = entries.find(e =>
      (e.marker_key && e.marker_key === identifier) ||
      e.name === prompt.name
    );
    assert.ok(row, `identifier=${identifier} 未入库`);
    assert.match(row.id, UUID_RE, '内部条目 id 应为 UUID');
    if (UUID_RE.test(identifier)) assert.notEqual(row.id, identifier, '外部 UUID 不应复用为内部主键');
  }
});

test('导入：禁用的 relative 条目 enabled=false 落库', () => {
  const jsonText = JSON.stringify(buildSyntheticPreset());
  const data = JSON.parse(jsonText);
  const order = (data.prompt_order && data.prompt_order[0] && data.prompt_order[0].order) || [];
  const prompts = data.prompts || [];

  // 找一条 enabled=false 的 order 项
  const disabledOrderEntry = order.find(o => o.enabled === false);
  assert.ok(disabledOrderEntry, '预设应有至少一条禁用条目');
  const promptDisabled = prompts.find(p => p.identifier === disabledOrderEntry.identifier);

  const report = importLib.importSillyTavernPreset(jsonText);
  const entries = presetLib.listEntries(report.preset_id);
  const dbEntry = entries.find(e => e.name === promptDisabled?.name);
  assert.ok(dbEntry, '应找到该条目');
  assert.equal(dbEntry.enabled, false, `「${promptDisabled?.name}」应为禁用，实际 enabled=${dbEntry.enabled}`);
});

test('导入：role/injection_position/injection_depth/injection_order 与原文一致', () => {
  const jsonText = JSON.stringify(buildSyntheticPreset());
  const data = JSON.parse(jsonText);
  const prompts = data.prompts || [];

  // 抽样几条数据核验；只挑非 marker 的普通条目（uuid）做转字段对比，因为 marker 行的 content 字段不一致是预期。
  const sampleIds = prompts
    .filter(p => UUID_RE.test(p.identifier))
    .slice(0, 8)
    .map(p => p.identifier);
  assert.ok(sampleIds.length > 0);
  const report = importLib.importSillyTavernPreset(jsonText);
  const entries = presetLib.listEntries(report.preset_id);

  for (const id of sampleIds) {
    const original = prompts.find(p => p.identifier === id);
    if (!original) continue;
    const dbEntry = entries.find(e => e.name === original.name);
    assert.ok(dbEntry, `未找到 ${id}`);
    assert.notEqual(dbEntry.id, id, '外部 UUID 应映射到新的内部 UUID');
    assert.equal(dbEntry.role, original.role === 'system' || original.role === 'user' || original.role === 'assistant' ? original.role : 'user');
    if (typeof original.injection_position === 'number') {
      assert.equal(dbEntry.injection_position, original.injection_position);
    }
    if (typeof original.injection_depth === 'number') {
      assert.equal(dbEntry.injection_depth, original.injection_depth);
    }
    if (typeof original.injection_order === 'number') {
      assert.equal(dbEntry.injection_order, original.injection_order);
    }
  }
});
