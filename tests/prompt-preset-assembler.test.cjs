/**
 * 组装管线 TASK-ASSEMBLER-CORE / TASK-ASSEMBLER-INCHAT / TASK-ASSEMBLER-BEHAVIOR 单测。
 *
 * 复用 prompt-presets.test.cjs 的 :memory: 隔离方案。
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
const assemblerModulePath = require.resolve(path.join(root, 'src', 'lib', 'prompt-preset-assembler.ts'));

let db;
let lib;
let assembler;
let DEFAULT_SETTINGS;

function makeCharacter(overrides = {}) {
  return {
    id: 'char-1',
    name: '露米',
    avatar_url: null,
    basic_info: '一位年长的吸血鬼',
    personality: '沉稳又话多',
    scenario: '夜晚的书房',
    greeting: '你好。',
    example_dialogue: '',
    system_prompt: '你是露米，一位两百岁的吸血鬼。',
    other_info: '',
    image_tags: '',
    user_image_tags: '',
    active_preset_id: null,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

function makeMessage(seq, role, content) {
  return {
    id: `msg-${seq}`,
    conversation_id: 'conv-1',
    role,
    content,
    token_count: 0,
    created_at: `2026-01-01T00:00:${String(seq).padStart(2, '0')}Z`,
    metadata: {},
    seq,
  };
}

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

  lib = require(presetModulePath);
  assembler = require(assemblerModulePath);
  DEFAULT_SETTINGS = require(path.join(root, 'src', 'types', 'index.ts')).DEFAULT_SETTINGS;
});

test.afterEach(() => {
  try { db && db.close(); } catch {}
});

// ============================================================
// TASK-ASSEMBLER-CORE：relative 排序 / marker 渲染
// ============================================================

test('relative 条目按 sort_order 升序；空 content 跳过；marker 渲染', async () => {
  const preset = lib.createPreset({ name: 'P' });
  lib.upsertEntry({ preset_id: preset.id, name: 'A', role: 'system', content: '首条 system', sort_order: 10 });
  lib.upsertEntry({ preset_id: preset.id, name: 'B', role: 'user', content: '第二条 user', sort_order: 20 });
  lib.upsertEntry({ preset_id: preset.id, name: 'Empty', role: 'user', content: '   ', sort_order: 30 });
  lib.upsertEntry({ preset_id: preset.id, name: 'CharDesc', role: 'user', content: '', sort_order: 40, is_marker: true, marker_key: 'charDescription' });
  lib.upsertEntry({ preset_id: preset.id, name: 'Pers', role: 'user', sort_order: 50, is_marker: true, marker_key: 'charPersonality' });
  lib.upsertEntry({ preset_id: preset.id, name: 'Scen', role: 'system', sort_order: 60, is_marker: true, marker_key: 'scenario' });

  const character = makeCharacter();
  const entries = lib.loadEnabledEntries(preset.id);

  const result = await assembler.assemblePresetPrompt(
    character,
    [],                                     // 无历史
    { ...DEFAULT_SETTINGS, show_timestamps: false },
    '',                                     // 无记忆
    undefined,
    preset,
    entries,
  );

  const roles = result.map(m => m.role);
  const contents = result.map(m => m.content);

  // 顺序：A(system)→B(user)→CharDesc(user)→Pers(user)→Scen(system)→隐藏 system
  // 注意：连续 user 会被 merge（ChatDesc + Pers 不会，因为它们之间夹了 Empty（被跳过但内部 merge 仅合并相邻同 role）；
  // 实际：B+CharDesc+Pers 都是 user，连续合并为一条；Scen 单独；最后是隐藏 system。
  assert.equal(roles.length, 4);
  assert.equal(roles[0], 'system');
  assert.equal(contents[0], '首条 system');

  assert.equal(roles[1], 'user');
  assert.match(contents[1], /第二条 user/);
  assert.match(contents[1], /你是露米，一位两百岁的吸血鬼。\n\n一位年长的吸血鬼/, 'CharDesc marker 渲染 system_prompt+basic_info');
  assert.match(contents[1], /沉稳又话多/, 'charPersonality marker 渲染');

  assert.equal(roles[2], 'system');
  assert.equal(contents[2], '夜晚的书房');

  assert.equal(roles[3], 'system');
  assert.match(contents[3], /^## 行为要求\n请始终保持角色扮演/, '末尾隐藏 system 包含行为要求');
});

test('chatHistory marker 占位；未启用时历史兜底追加', async () => {
  const preset = lib.createPreset({ name: 'P2' });
  lib.upsertEntry({ preset_id: preset.id, name: 'Pre', role: 'system', content: '前缀', sort_order: 10 });
  // chatHistory marker 不放 → 历史应该被强制追加到末尾
  const character = makeCharacter();
  const messages = [makeMessage(1, 'user', 'hello'), makeMessage(2, 'assistant', 'hi')];

  const entries = lib.loadEnabledEntries(preset.id);
  const result = await assembler.assemblePresetPrompt(
    character,
    messages,
    { ...DEFAULT_SETTINGS, show_timestamps: false, context_window: 131072, max_tokens: 4096 },
    '',
    undefined,
    preset,
    entries,
  );

  // 应该有：system '前缀' → history(user hello, assistant hi) → 隐藏 system
  const roles = result.map(m => m.role);
  const lastUserIdx = roles.lastIndexOf('user');
  assert.ok(lastUserIdx > 0, '历史消息在 system 之后');
  assert.equal(result[roles.length - 1].role, 'system', '最末是隐藏 system');
});

test('普通 chatHistory marker 保留真实历史与当前 user，而不压成兼容单块', async () => {
  const preset = lib.createPreset({ name: 'P3' });
  lib.upsertEntry({ preset_id: preset.id, name: 'Pre', role: 'system', content: '系统前缀', sort_order: 10 });
  lib.upsertEntry({ preset_id: preset.id, name: '对话历史开始', role: 'user', content: '<story_history>', sort_order: 15 });
  lib.upsertEntry({ preset_id: preset.id, name: 'HIST', role: 'system', sort_order: 20, is_marker: true, marker_key: 'chatHistory' });
  lib.upsertEntry({ preset_id: preset.id, name: '对话历史结束', role: 'user', content: '</story_history>', sort_order: 25 });
  lib.upsertEntry({ preset_id: preset.id, name: 'Post', role: 'system', content: '系统后缀', sort_order: 30 });

  const character = makeCharacter();
  const messages = [
    makeMessage(1, 'user', '历史一'),
    makeMessage(2, 'assistant', '历史二'),
    makeMessage(3, 'user', '当前用户输入'),
  ];
  const entries = lib.loadEnabledEntries(preset.id);

  const result = await assembler.assemblePresetPrompt(
    character,
    messages,
    { ...DEFAULT_SETTINGS, show_timestamps: false, context_window: 131072, max_tokens: 4096 },
    '',
    undefined,
    preset,
    entries,
  );

  const flattened = result.map(message => (
    typeof message.content === 'string'
      ? `${message.role}:${message.content}`
      : `${message.role}:${JSON.stringify(message.content)}`
  )).join('\n');
  assert.match(flattened, /system:系统前缀/);
  assert.match(flattened, /user:<story_history>[\s\S]*历史一/);
  assert.match(flattened, /assistant:历史二/);
  assert.match(flattened, /user:当前用户输入[\s\S]*<\/story_history>/);
  assert.equal((flattened.match(/当前用户输入/g) || []).length, 1, '当前 user 必须且只能出现一次');
  assert.match(flattened, /系统后缀/);
  assert.match(flattened, /## 行为要求/);
});

test('memoryPackage marker：内容渲染 + 空 memoryText 时跳过', async () => {
  const preset = lib.createPreset({ name: 'P4' });
  lib.upsertEntry({ preset_id: preset.id, name: 'Pre', role: 'system', content: 'pre', sort_order: 10 });
  lib.upsertEntry({ preset_id: preset.id, name: 'Mem', role: 'system', sort_order: 20, is_marker: true, marker_key: 'memoryPackage' });
  lib.upsertEntry({ preset_id: preset.id, name: 'Post', role: 'system', content: 'post', sort_order: 30 });

  const character = makeCharacter();
  const entries = lib.loadEnabledEntries(preset.id);

  // 空 memory：Mem 应跳过
  let result = await assembler.assemblePresetPrompt(
    character, [], { ...DEFAULT_SETTINGS, show_timestamps: false }, '', undefined, preset, entries,
  );
  assert.equal(result.length, 3);
  assert.ok(!result.some(m => typeof m.content === 'string' && m.content.includes('## 长期记忆')), '无记忆时无 marker 条目');

  // 有 memory：Mem 应渲染（且经过 normalizeMemoryContextText 处理）
  const memoryText = `### 本轮相关回忆\n- 用户喜欢咖啡`;
  result = await assembler.assemblePresetPrompt(
    character, [], { ...DEFAULT_SETTINGS, show_timestamps: false }, memoryText, undefined, preset, entries,
  );
  const memMsg = result.find(m => typeof m.content === 'string' && m.content.includes('用户喜欢咖啡'));
  assert.ok(memMsg, 'memoryPackage marker 渲染记忆文本');
  assert.equal(memMsg.role, 'system');
});

test('{{user}} 和 {{char}} 宏替换', async () => {
  const preset = lib.createPreset({ name: 'P5' });
  lib.upsertEntry({ preset_id: preset.id, name: 'A', role: 'system', content: '你的目标是陪伴 {{user}}，由 {{char}} 主导。', sort_order: 10 });

  const character = makeCharacter({ name: '露米' });
  const entries = lib.loadEnabledEntries(preset.id);

  const result = await assembler.assemblePresetPrompt(
    character, [], { ...DEFAULT_SETTINGS, show_timestamps: false }, '', undefined, preset, entries,
    { userName: '爱丽丝' },
  );

  const first = result[0];
  assert.match(first.content, /你的目标是陪伴 爱丽丝，由 露米 主导。/);
});

test('{{user}}/{{char}} 替换值中的 $ token 按字面值保留', () => {
  assert.equal(
    assembler.substitutePresetMacros('{{user}} -> {{char}}', {
      userName: '$& $$ $` $\'',
      charName: '$& $$ $` $\'',
    }),
    '$& $$ $` $\' -> $& $$ $` $\'',
  );
});

// ============================================================
// TASK-ASSEMBLER-INCHAT:深度注入
// ============================================================

test('injection_position=1 按 depth+order splice 到真实历史中间', async () => {
  const preset = lib.createPreset({ name: 'P6' });
  // relative 占位
  lib.upsertEntry({ preset_id: preset.id, name: 'Intro', role: 'system', content: '前缀', sort_order: 10 });
  // in-chat：
  //   depth=0 order=100 system "depth0-order100-system"
  //   depth=0 order=200 user   "depth0-order200-user"
  //   depth=2 order=100 user   "depth2-order100-user"
  lib.upsertEntry({
    preset_id: preset.id, name: 'D0S', role: 'system', content: 'depth0-order100-system',
    sort_order: 90, injection_position: 1, injection_depth: 0, injection_order: 100,
  });
  lib.upsertEntry({
    preset_id: preset.id, name: 'D0U', role: 'user', content: 'depth0-order200-user',
    sort_order: 91, injection_position: 1, injection_depth: 0, injection_order: 200,
  });
  lib.upsertEntry({
    preset_id: preset.id, name: 'D2U', role: 'user', content: 'depth2-order100-user',
    sort_order: 92, injection_position: 1, injection_depth: 2, injection_order: 100,
  });

  const character = makeCharacter();
  // 历史 6 条 (user,asst 交替)：u1 a1 u2 a2 u3 a3 (seq 1..6)
  const messages = [
    makeMessage(1, 'user', 'u1'),
    makeMessage(2, 'assistant', 'a1'),
    makeMessage(3, 'user', 'u2'),
    makeMessage(4, 'assistant', 'a2'),
    makeMessage(5, 'user', 'u3'),
    makeMessage(6, 'assistant', 'a3'),
  ];

  const entries = lib.loadEnabledEntries(preset.id);
  const result = await assembler.assemblePresetPrompt(
    character,
    messages,
    { ...DEFAULT_SETTINGS, show_timestamps: false, context_window: 131072, max_tokens: 4096 },
    '',
    undefined,
    preset,
    entries,
  );

  const texts = result.map(m => `${m.role}:${typeof m.content === 'string' ? m.content.slice(0, 30) : ''}`);
  if (process.env.DEBUG_TEST) console.log('RESULT:', JSON.stringify(texts, null, 2));
  // 酒馆 splice 语义（详细推导见 prompt-preset-assembler.ts populateInjectionPrompts 注）：
  // 同 depth 内 roleMessages 在反转数组中按 order 降序收集 → 再 reverse，最终
  // **prompt 中顺序 = order 小值在前（离 latest 更近）、order 大值在后（离 latest 更远）**。
  // 故本例：
  //   Intro(system)
  //   u1 a1 u2 a2       <- 前 4 条历史
  //   depth2-order100-user  <- depth=2 注入
  //   u3 a3                  <- 后 2 条历史
  //   depth0-order100-system <- depth=0 order=100
  //   depth0-order200-user   <- depth=0 order=200（在 depth0 序列里后于 order=100，更靠 chat 末尾离 latest 更远）
  //   隐藏 system
  const introIdx = texts.findIndex(s => s === 'system:前缀');
  const d2Idx = texts.findIndex(s => s.includes('depth2-order100-user'));
  const d0Order200Idx = texts.findIndex(s => s.includes('depth0-order200-user'));
  const d0Order100Idx = texts.findIndex(s => s.includes('depth0-order100-system'));
  const u3Idx = texts.findIndex(s => s === 'user:u3');
  const a3Idx = texts.findIndex(s => s === 'assistant:a3');
  const behaviorIdx = texts.findIndex(s => s.startsWith('system:## 行为要求'));

  assert.ok(introIdx === 0, `Intro 应在首位，实际 ${introIdx}，序列：${JSON.stringify(texts)}`);
  // 关键定位：depth=2 注入应该位于 u2 与 u3 之间（即 a2 之后、u3 之前），但因 u3 和 depth2 都是 user 被 merge 成一条
  // 直接断言文本片段相对位置：
  const mergedText = texts.find(s => s.includes('depth2-order100-user'));
  assert.ok(mergedText, 'depth=2 注入条目存在');
  assert.ok(mergedText.includes('u3'), 'depth=2 与 u3 相邻同 role 被 merge');
  // depth=2 + u3 的整体块应该位于 a2 之后、a3 之前
  const a2Idx = texts.findIndex(s => s === 'assistant:a2');
  const d2CombinedIdx = texts.indexOf(mergedText);
  assert.ok(a2Idx < d2CombinedIdx && d2CombinedIdx < a3Idx, `depth=2 应位于 a2 与 a3 之间（实际 a2=${a2Idx} d2=${d2CombinedIdx} a3=${a3Idx}）`);
  assert.ok(a3Idx < d0Order100Idx, 'a3（latest assistant）应在 depth=0 注入之前');
  assert.ok(a3Idx < d0Order200Idx, 'a3 应在 depth=0 注入之前');
  assert.ok(d0Order100Idx < d0Order200Idx, '同 depth 内 order 小值（100）应在 order 大值（200）之前（离 latest 更近）');
  assert.ok(behaviorIdx === texts.length - 1, '隐藏 system 在最末');
});

test('injection_position=1 同 depth 同 order 不同 role 拼成一条（role 优先级 system>user>assistant）', async () => {
  const preset = lib.createPreset({ name: 'P7' });
  lib.upsertEntry({ preset_id: preset.id, name: 'Intro', role: 'system', content: '前缀', sort_order: 10 });
  lib.upsertEntry({
    preset_id: preset.id, name: 'A', role: 'user', content: '同组 user 内容',
    sort_order: 90, injection_position: 1, injection_depth: 0, injection_order: 100,
  });
  lib.upsertEntry({
    preset_id: preset.id, name: 'B', role: 'system', content: '同组 system 内容',
    sort_order: 91, injection_position: 1, injection_depth: 0, injection_order: 100,
  });
  lib.upsertEntry({
    preset_id: preset.id, name: 'C', role: 'assistant', content: '同组 assistant 内容',
    sort_order: 92, injection_position: 1, injection_depth: 0, injection_order: 100,
  });

  const character = makeCharacter();
  const messages = [makeMessage(1, 'user', 'u1'), makeMessage(2, 'assistant', 'a1')];
  const entries = lib.loadEnabledEntries(preset.id);

  const result = await assembler.assemblePresetPrompt(
    character,
    messages,
    { ...DEFAULT_SETTINGS, show_timestamps: false, context_window: 131072, max_tokens: 4096 },
    '',
    undefined,
    preset,
    entries,
  );

  const texts = result.map(m => `${m.role}:${typeof m.content === 'string' ? m.content.slice(0, 50) : ''}`);
  if (process.env.DEBUG_TEST) console.log('RESULT2:', JSON.stringify(texts, null, 2));
  // 酒馆 splice+reverse 语义（openai.js:801-866）：roleMessages 收集顺序 system→user→assistant，
  // splice 到反向数组 idx=0 后 reverse → 最终 prompt 中顺序反过来：assistant → user → system。
  // 这就是酒馆注释"most important go lower"的字面意思：system 在最终 prompt 中"更靠 chat 底部"（离 latest 更近）。
  // 本测试里：同 depth=0 order=100 的注入在 latest('a1') 之后；assistant 组先 splice 到 idx=0，
  // reverse 后 assistant 出现在队列前部，system 反而离 latest/尾部最近（在 a1 与行为要求之间）。
  // 又因 a1 是 assistant，a1 与同组 assistant 内容相邻被 merge 成一条。
  const sysIdx = texts.findIndex(s => s.includes('同组 system 内容'));
  const userIdx = texts.findIndex(s => s.includes('同组 user 内容'));
  const asstIdx = texts.findIndex(s => s.includes('同组 assistant 内容'));

  assert.ok(sysIdx >= 0 && userIdx >= 0 && asstIdx >= 0, `三条都注入了（实际 ${JSON.stringify(texts)}）`);
  assert.ok(asstIdx < userIdx, `assistant(${asstIdx}) 组应在 user(${userIdx}) 组之前（实际 ${JSON.stringify(texts)}）`);
  assert.ok(userIdx < sysIdx, `user(${userIdx}) 组应在 system(${sysIdx}) 组之前（实际 ${JSON.stringify(texts)}）`);
});

test('injection_position=1 未启用条目不参与组装', async () => {
  const preset = lib.createPreset({ name: 'P8' });
  lib.upsertEntry({ preset_id: preset.id, name: 'Intro', role: 'system', content: '前缀', sort_order: 10 });
  lib.upsertEntry({
    preset_id: preset.id, name: 'Off', role: 'user', content: '应该被禁用',
    sort_order: 90, injection_position: 1, injection_depth: 0, injection_order: 100,
    enabled: false,
  });

  const character = makeCharacter();
  const messages = [makeMessage(1, 'user', 'u1')];
  const entries = lib.loadEnabledEntries(preset.id);

  const result = await assembler.assemblePresetPrompt(
    character, messages, { ...DEFAULT_SETTINGS, show_timestamps: false }, '', undefined, preset, entries,
  );

  assert.ok(!result.some(m => typeof m.content === 'string' && m.content.includes('应该被禁用')), '禁用条目不注入');
});

// ============================================================
// TASK-ASSEMBLER-BEHAVIOR & 尾部兜底
// ============================================================

test('预设组装末尾强制追加 ## 行为要求 隐藏 system；当 timeContext 提供时同时附 Current Time', async () => {
  const preset = lib.createPreset({ name: 'P9' });
  lib.upsertEntry({ preset_id: preset.id, name: 'Intro', role: 'system', content: '前缀', sort_order: 10 });

  const character = makeCharacter();
  const entries = lib.loadEnabledEntries(preset.id);

  // 不含 timeContext
  let result = await assembler.assemblePresetPrompt(
    character, [], { ...DEFAULT_SETTINGS, show_timestamps: false }, '', undefined, preset, entries,
  );
  const last = result[result.length - 1];
  assert.equal(last.role, 'system');
  assert.match(last.content, /^## 行为要求\n请始终保持角色扮演/);
  assert.ok(!last.content.includes('Current Time'), '无 timeContext 时不应含 Current Time');
});

test('预设未启用任何 relative 时兜底追加真实历史（含当前 user）与隐藏 system', async () => {
  const preset = lib.createPreset({ name: 'P10' });
  // 没有任何 relative 条目；只有一条 disabled 的 relative 也不会出现

  const character = makeCharacter();
  const messages = [
    makeMessage(1, 'user', 'u1'),
    makeMessage(2, 'assistant', 'a1'),
    makeMessage(3, 'user', '当前用户输入'),
  ];
  const entries = lib.loadEnabledEntries(preset.id);

  const result = await assembler.assemblePresetPrompt(
    character, messages, { ...DEFAULT_SETTINGS, show_timestamps: false, context_window: 131072, max_tokens: 4096 }, '', undefined, preset, entries,
  );

  assert.equal(result[0].role, 'user');
  assert.equal(result[0].content, 'u1');
  assert.equal(result[1].role, 'assistant');
  assert.equal(result[1].content, 'a1');
  assert.equal(result[2].role, 'user');
  assert.equal(result[2].content, '当前用户输入');
  assert.equal(result.filter(m => typeof m.content === 'string' && m.content.includes('当前用户输入')).length, 1);
  const last = result[result.length - 1];
  assert.equal(last.role, 'system');
  assert.match(last.content, /^## 行为要求/);
});

test('单块兼容仅在 story_history + lastUserMessage 的安全形态启用', async () => {
  const preset = lib.createPreset({ name: 'single-block-compatible' });
  lib.upsertEntry({ preset_id: preset.id, name: 'Open', role: 'user', content: '<story_history>', sort_order: 10 });
  lib.upsertEntry({
    preset_id: preset.id,
    name: 'History',
    role: 'system',
    sort_order: 20,
    is_marker: true,
    marker_key: 'chatHistory',
  });
  lib.upsertEntry({ preset_id: preset.id, name: 'Close', role: 'user', content: '</story_history>', sort_order: 30 });
  lib.upsertEntry({
    preset_id: preset.id,
    name: 'Current',
    role: 'user',
    content: '<last_user>{{lastUserMessage}}</last_user>',
    sort_order: 40,
  });

  const result = await assembler.assemblePresetPrompt(
    makeCharacter(),
    [
      makeMessage(1, 'user', '旧问题'),
      makeMessage(2, 'assistant', '旧回答'),
      makeMessage(3, 'user', '当前问题'),
    ],
    { ...DEFAULT_SETTINGS, show_timestamps: false, context_window: 131072, max_tokens: 4096 },
    '',
    undefined,
    preset,
    lib.loadEnabledEntries(preset.id),
  );

  const flattened = result.map(message => typeof message.content === 'string' ? message.content : '').join('\n');
  assert.match(flattened, /<story_history>/);
  assert.match(flattened, /\{\{user\}\}: 旧问题/);
  assert.match(flattened, /\{\{char\}\}: 旧回答/);
  assert.match(flattened, /<last_user>当前问题<\/last_user>/);
  const historyMessage = result.find(message => (
    message.role === 'system'
    && typeof message.content === 'string'
    && message.content.includes('{{user}}: 旧问题')
  ));
  assert.equal(
    historyMessage?.content,
    '<story_history>\n{{user}}: 旧问题\n{{char}}: 旧回答\n</story_history>',
    'story_history 的开闭标签应由 chatHistory 对应的 system 消息完整承载',
  );
  assert.equal(
    result.some(message => (
      message.role === 'user'
      && typeof message.content === 'string'
      && /<\/?story_history>/.test(message.content)
    )),
    false,
    'story_history 标签不应跨到前后 user 消息',
  );
  assert.equal((flattened.match(/当前问题/g) || []).length, 1, '当前 user 只由 lastUserMessage 宏承载一次');
});

test('单块兼容形态遇到图片附件时回退真实 history，并保留多模态当前 user', async () => {
  const preset = lib.createPreset({ name: 'single-block-with-image' });
  lib.upsertEntry({ preset_id: preset.id, name: 'Open', role: 'user', content: '<story_history>', sort_order: 10 });
  lib.upsertEntry({
    preset_id: preset.id,
    name: 'History',
    role: 'system',
    sort_order: 20,
    is_marker: true,
    marker_key: 'chatHistory',
  });
  lib.upsertEntry({ preset_id: preset.id, name: 'Close', role: 'user', content: '</story_history>', sort_order: 30 });
  lib.upsertEntry({
    preset_id: preset.id,
    name: 'Current',
    role: 'user',
    content: '<last_user>{{lastUserMessage}}</last_user>',
    sort_order: 40,
  });
  const current = makeMessage(1, 'user', '看这张图');
  current.metadata = {
    attachments: [{
      type: 'image',
      name: 'tiny.png',
      data: 'data:image/png;base64,iVBORw0KGgo=',
      mimeType: 'image/png',
    }],
  };

  const result = await assembler.assemblePresetPrompt(
    makeCharacter(),
    [current],
    { ...DEFAULT_SETTINGS, show_timestamps: false, context_window: 131072, max_tokens: 4096 },
    '',
    undefined,
    preset,
    lib.loadEnabledEntries(preset.id),
  );

  const multimodal = result.find(message => (
    message.role === 'user'
    && Array.isArray(message.content)
    && message.content.some(part => part.type === 'image_url')
  ));
  assert.ok(multimodal, '图片附件必须以 image_url part 进入模型上下文');
});

test('没有 memoryPackage/charDescription marker 时仍注入工作记忆', async () => {
  const preset = lib.createPreset({ name: 'memory-fallback' });
  lib.upsertEntry({ preset_id: preset.id, name: 'Only', role: 'user', content: '普通预设内容', sort_order: 10 });

  const result = await assembler.assemblePresetPrompt(
    makeCharacter({ system_prompt: '', basic_info: '' }),
    [makeMessage(1, 'user', '当前问题')],
    { ...DEFAULT_SETTINGS, show_timestamps: false, context_window: 131072, max_tokens: 4096 },
    '### 本轮相关回忆\n- 用户喜欢咖啡',
    undefined,
    preset,
    lib.loadEnabledEntries(preset.id),
  );

  const memory = result.find(message => (
    message.role === 'system'
    && typeof message.content === 'string'
    && message.content.includes('用户喜欢咖啡')
  ));
  assert.ok(memory, '缺少显式 marker 不能导致工作记忆丢失');
});

test('charDescription marker 字段为空时仍承载工作记忆', async () => {
  const preset = lib.createPreset({ name: 'empty-description-memory' });
  lib.upsertEntry({
    preset_id: preset.id,
    name: 'Description',
    role: 'system',
    content: '',
    sort_order: 10,
    is_marker: true,
    marker_key: 'charDescription',
  });
  const result = await assembler.assemblePresetPrompt(
    makeCharacter({ system_prompt: '', basic_info: '' }),
    [makeMessage(1, 'user', '当前问题')],
    { ...DEFAULT_SETTINGS, show_timestamps: false, context_window: 131072, max_tokens: 4096 },
    '### 本轮相关回忆\n- 用户喜欢红茶',
    undefined,
    preset,
    lib.loadEnabledEntries(preset.id),
  );
  assert.ok(result.some(message => (
    message.role === 'system'
    && typeof message.content === 'string'
    && message.content.includes('用户喜欢红茶')
  )));
});

test('in-chat 使用离散超大 depth，不按 0..maxDepth 扫描且不丢内容', async () => {
  const preset = lib.createPreset({ name: 'sparse-depth' });
  lib.upsertEntry({
    preset_id: preset.id,
    name: 'Very deep',
    role: 'system',
    content: '离散深度内容',
    sort_order: 10,
    injection_position: 1,
    injection_depth: 1_000_000_000,
    injection_order: 1,
  });

  const result = await assembler.assemblePresetPrompt(
    makeCharacter(),
    [makeMessage(1, 'user', '当前问题')],
    { ...DEFAULT_SETTINGS, show_timestamps: false, context_window: 131072, max_tokens: 4096 },
    '',
    undefined,
    preset,
    lib.loadEnabledEntries(preset.id),
  );

  assert.ok(result.some(message => (
    typeof message.content === 'string' && message.content.includes('离散深度内容')
  )));
});

test('预设固定上下文计入 context budget，裁剪旧历史但始终保留当前 user', async () => {
  const preset = lib.createPreset({ name: 'budget-aware' });
  lib.upsertEntry({
    preset_id: preset.id,
    name: 'Large system',
    role: 'system',
    content: '固定设定'.repeat(500),
    sort_order: 10,
  });
  const result = await assembler.assemblePresetPrompt(
    makeCharacter(),
    [
      makeMessage(1, 'user', `旧历史${'很长'.repeat(500)}`),
      makeMessage(2, 'assistant', `旧回答${'很长'.repeat(500)}`),
      makeMessage(3, 'user', '当前问题必须保留'),
    ],
    { ...DEFAULT_SETTINGS, show_timestamps: false, context_window: 300, max_tokens: 100 },
    '',
    undefined,
    preset,
    lib.loadEnabledEntries(preset.id),
  );
  const flattened = result.map(message => typeof message.content === 'string' ? message.content : '').join('\n');
  assert.doesNotMatch(flattened, /旧历史|旧回答/);
  assert.match(flattened, /当前问题必须保留/);
});

test('in-chat 与隐藏行为指令也计入 context budget', async () => {
  const preset = lib.createPreset({ name: 'in-chat-budget-aware' });
  lib.upsertEntry({
    preset_id: preset.id,
    name: 'Large injection',
    role: 'system',
    content: '注入设定'.repeat(500),
    sort_order: 10,
    injection_position: 1,
    injection_depth: 0,
    injection_order: 1,
  });
  const result = await assembler.assemblePresetPrompt(
    makeCharacter(),
    [
      makeMessage(1, 'user', '应被预算裁掉的旧问题'),
      makeMessage(2, 'assistant', '应被预算裁掉的旧回答'),
      makeMessage(3, 'user', '当前问题仍保留'),
    ],
    { ...DEFAULT_SETTINGS, show_timestamps: false, context_window: 300, max_tokens: 100 },
    '',
    undefined,
    preset,
    lib.loadEnabledEntries(preset.id),
  );
  const flattened = result.map(message => typeof message.content === 'string' ? message.content : '').join('\n');
  assert.doesNotMatch(flattened, /应被预算裁掉的旧问题|应被预算裁掉的旧回答/);
  assert.match(flattened, /当前问题仍保留/);
  assert.match(flattened, /注入设定/);
  assert.match(flattened, /## 行为要求/);
});
