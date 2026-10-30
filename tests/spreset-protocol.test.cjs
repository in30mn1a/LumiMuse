/**
 * SPreset 插件协议兼容层。
 *
 * 覆盖三件事：
 *  1. 协议识别与剥离（控制指令 / 拼装标记 / 分区标签 / 思考标签）
 *  2. 导入期映射（strip_tags、兼容条目、说明不再误报 tool_binding）
 *  3. 回归：setLastMessage 里的 {{lastUserMessage}} 不得把真正的 user 消息从历史里摘掉
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
const protocolModulePath = require.resolve(path.join(root, 'src', 'lib', 'spreset-protocol.ts'));
const importModulePath = require.resolve(path.join(root, 'src', 'lib', 'prompt-preset-import.ts'));
const presetModulePath = require.resolve(path.join(root, 'src', 'lib', 'prompt-presets.ts'));
const assemblerModulePath = require.resolve(path.join(root, 'src', 'lib', 'prompt-preset-assembler.ts'));

let db;
let protocol;
let importLib;
let presetLib;
let assembler;
let DEFAULT_SETTINGS;

function makeCharacter(overrides = {}) {
  return {
    id: 'char-1',
    name: '雪乃',
    avatar_url: null,
    basic_info: '20 岁，长发，喜欢红茶。',
    personality: '温柔、寡言',
    scenario: '深夜的图书馆',
    greeting: '欢迎。',
    example_dialogue: '',
    system_prompt: '你是雪乃，一位安静的图书管理员。',
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

function warningsWith(report, code) {
  return (report.warnings || []).filter(w => w && w.code === code);
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

  protocol = require(protocolModulePath);
  importLib = require(importModulePath);
  presetLib = require(presetModulePath);
  assembler = require(assemblerModulePath);
  DEFAULT_SETTINGS = require(path.join(root, 'src', 'types', 'index.ts')).DEFAULT_SETTINGS;
});

test.afterEach(() => {
  try { db && db.close(); } catch {}
});

// ---------- 协议层单测 ----------

test('只有出现 <<<|catgodml| 才判定为 SPreset 协议', () => {
  assert.equal(protocol.hasSpresetProtocol(['普通正文 <game></game>']), false);
  assert.equal(protocol.hasSpresetProtocol(['<<<|catgodml|deepthink>>>']), true);
});

test('剥离控制指令与拼装标记，保留作者正文', () => {
  const raw = '{{trim}}<|sep|><|merge|>正文由回复工具输出，请在<draft_notes>思考<run_tool_replacement>';
  const stripped = protocol.stripSpresetControl(raw);
  assert.equal(stripped, '{{trim}}正文由回复工具输出，请在<draft_notes>思考');

  // 指令描述里含 '>' 时也要整段吃掉，不能停在 <game>
  const withTag = '<<<|catgodml|registerPart:story_content:<game></game>内的内容。>>>请把内容放进<game></game>里';
  assert.equal(protocol.stripSpresetControl(withTag), '请把内容放进<game></game>里');

  // 独占一行的指令剥掉后不留连续空行
  const multiline = '前文\n<<<|catgodml|registerPart:extra:其它内容>>>\n\n\n后文';
  assert.equal(protocol.stripSpresetControl(multiline), '前文\n\n后文');
});

test('普通预设正文原样返回（不误伤 <|sep|> 之外的普通文本）', () => {
  const plain = '### 角色设定\n<game>正文</game>{{user}}：你好';
  assert.equal(protocol.stripSpresetControl(plain), plain);
});

test('按出现顺序收集 registerPart 分区与其标签', () => {
  const parts = protocol.collectSpresetParts([
    '<<<|catgodml|registerPart:story_content:<game></game>内的完整剧情正文。>>>',
    '<<<|catgodml|registerPart:options:<options><option>...</option></options>写法的候选项。>>>',
    '<<<|catgodml|setLastMessage:{{lastUserMessage}}>>>',
  ]);
  assert.deepEqual(parts.map(part => part.key), ['story_content', 'options']);
  assert.deepEqual(parts[0].tags, ['game']);
  assert.deepEqual(parts[1].tags, ['options', 'option']);
});

test('工具参数里当思考草稿的标签转成 drop 规则，分区标签转成 block 规则', () => {
  const plan = protocol.planSpresetCompat(
    [
      '<<<|catgodml|registerPart:story_content:<game></game>内的完整剧情正文。>>>',
      '在<draft_notes>中思考',
    ],
    {
      extensions: {
        SPreset: {
          ToolBindings: {
            'uuid-a': {
              enabled: true,
              resolvedName: 'story_reply',
              form: { name: 'story_reply', parameters: [{ name: 'draft_notes', type: 'string' }] },
            },
            'uuid-b': { enabled: false, resolvedName: 'ignored_tool' },
          },
        },
      },
    },
  );

  assert.deepEqual(plan.tools, ['story_reply']);
  assert.deepEqual(plan.thinkingTags, ['draft_notes']);
  assert.deepEqual(plan.stripTags, ['game', '#draft_notes']);
});

// ---------- 导入映射 ----------

function buildSpresetPresetJson() {
  return JSON.stringify({
    prompts: [
      {
        identifier: 'entry-init',
        name: '初始化条目',
        enabled: true,
        role: 'system',
        system_prompt: false,
        content: '{{trim}}<|sep|><|merge|>正文由回复工具输出，请在<draft_notes>思考<run_tool_replacement>',
      },
      {
        identifier: 'main',
        name: '主提示',
        enabled: true,
        role: 'system',
        system_prompt: true,
        content: '你负责主持一场文字冒险。',
      },
      {
        identifier: 'charDescription',
        name: 'Char Description',
        enabled: true,
        role: 'system',
        system_prompt: true,
        marker: true,
        content: '',
      },
      {
        identifier: 'chatHistory',
        name: 'Chat History',
        enabled: true,
        role: 'system',
        system_prompt: true,
        marker: true,
        content: '',
      },
      {
        identifier: 'entry-fixed',
        name: '固定条目',
        enabled: true,
        role: 'system',
        system_prompt: false,
        content: '<<<|catgodml|setLastMessage:{{lastUserMessage}}>>>',
      },
      {
        identifier: 'entry-options',
        name: '候选项条目',
        enabled: true,
        role: 'system',
        system_prompt: false,
        content: '<<<|catgodml|registerPart:options:<options><option>...</option></options>写法的候选项。>>>\n每个候选项放进<option>里',
      },
    ],
    prompt_order: [{
      character_id: 100001,
      order: [
        { identifier: 'entry-init', enabled: true },
        { identifier: 'main', enabled: true },
        { identifier: 'charDescription', enabled: true },
        { identifier: 'chatHistory', enabled: true },
        { identifier: 'entry-fixed', enabled: true },
        { identifier: 'entry-options', enabled: true },
      ],
    }],
    extensions: {
      SPreset: {
        ToolBindings: {
          'uuid-a': {
            enabled: true,
            resolvedName: 'story_reply',
            form: { name: 'story_reply', parameters: [{ name: 'draft_notes', type: 'string' }] },
          },
        },
      },
    },
  });
}

test('导入 SPreset 预设：自动配置剥离规则并追加兼容条目', () => {
  const report = importLib.importSillyTavernPreset(buildSpresetPresetJson());

  assert.equal(report.story_plot_strip, true, '应自动打开剥离');
  const preset = presetLib.getPreset(report.preset_id);
  assert.deepEqual(preset.strip_tags, ['options', 'option', '#draft_notes']);

  // 插件工具依赖由兼容层接管，不再逐条报 tool_binding
  assert.equal(warningsWith(report, 'tool_binding').length, 0);
  assert.equal(warningsWith(report, 'spreset_protocol').length, 1);

  const entries = presetLib.listEntries(report.preset_id);
  const compat = entries.find(entry => entry.name === protocol.SPRESET_COMPAT_ENTRY_NAME);
  assert.ok(compat, '应追加兼容条目');
  assert.equal(compat.enabled, true);
  assert.equal(compat.role, 'system');
  assert.match(compat.content, /不要调用任何工具/);
  assert.match(compat.content, /<options>/);
  assert.match(compat.content, /<draft_notes>/);
  assert.ok(compat.sort_order > entries.filter(entry => entry !== compat).reduce((max, entry) => Math.max(max, entry.sort_order), 0),
    '兼容条目应排在最后');

  // 作者正文原样入库，只做渲染期剥离
  const raw = entries.find(entry => entry.name === '固定条目');
  assert.equal(raw.content, '<<<|catgodml|setLastMessage:{{lastUserMessage}}>>>');
});

test('非 SPreset 预设仍按旧规则报 tool_binding，且不追加兼容条目', () => {
  const report = importLib.importSillyTavernPreset(JSON.stringify({
    extensions: { SPreset: { ToolBindings: [{ name: 'story_content', enabled: true }] } },
    prompts: [{ identifier: 'x', name: '工具要求', content: '调用 story_content 回复' }],
  }));
  assert.equal(report.story_plot_strip, false);
  assert.deepEqual(warningsWith(report, 'tool_binding'), [{ code: 'tool_binding', params: { tool: 'story_content' } }]);
  assert.equal(warningsWith(report, 'spreset_protocol').length, 0);
  assert.equal(
    presetLib.listEntries(report.preset_id).some(entry => entry.name === protocol.SPRESET_COMPAT_ENTRY_NAME),
    false,
  );
});

// ---------- 回归：user 消息不能被 setLastMessage 吞掉 ----------

test('SPreset 预设组装后当前用户消息仍在请求里，控制指令不进提示词', async () => {
  const report = importLib.importSillyTavernPreset(buildSpresetPresetJson());
  const preset = presetLib.getPreset(report.preset_id);
  const entries = presetLib.loadEnabledEntries(preset.id);

  const input = '我们开始吧';
  const result = await assembler.assemblePresetPrompt(
    makeCharacter(),
    [makeMessage(1, 'assistant', '（她把书合上。）'), makeMessage(2, 'user', input)],
    { ...DEFAULT_SETTINGS, show_timestamps: false },
    '',
    undefined,
    preset,
    entries,
  );

  const text = result.map(message => String(message.content)).join('\n');
  assert.equal(text.split(input).length - 1, 1, '当前用户消息应恰好出现一次');
  assert.ok(result.some(message => message.role === 'user' && String(message.content).includes(input)),
    '当前用户消息应作为 user 消息保留，而不是被宏摘掉');
  assert.equal(text.includes('catgodml'), false, '控制指令不应进入提示词');
  assert.equal(text.includes('<|sep|>') || text.includes('<|merge|>'), false, '拼装标记不应进入提示词');
  assert.equal(text.includes('run_tool_replacement'), false);
  assert.ok(text.includes('主持一场文字冒险'), '作者正文应保留');
});

test('非 SPreset 预设里 {{lastUserMessage}} 仍按原语义只出现一次', async () => {
  const preset = presetLib.createPreset({ name: 'plain-current-macro' });
  presetLib.upsertEntry({
    preset_id: preset.id,
    name: 'Current',
    role: 'user',
    content: '<input>{{lastUserMessage}}</input>',
    sort_order: 10,
  });
  const entries = presetLib.loadEnabledEntries(preset.id);

  const result = await assembler.assemblePresetPrompt(
    makeCharacter(),
    [makeMessage(1, 'user', 'CURRENT_UNIQUE')],
    { ...DEFAULT_SETTINGS, show_timestamps: false },
    '',
    undefined,
    preset,
    entries,
  );
  const text = result.map(message => String(message.content)).join('\n');
  assert.equal(text.split('CURRENT_UNIQUE').length - 1, 1);
  assert.ok(text.includes('<input>CURRENT_UNIQUE</input>'));
});

for (const [name, config] of [
  ['output-only', { OutputPreprocessing: { enabled: true, script: '({buffer}) => ({output:buffer})' } }],
  ['tools-only', { ToolBindings: { binding: { enabled: true, resolvedName: 'reply', code: 'return {name:"reply"}' } } }],
]) {
  test(`${name} 不得将控制宏误当成已提供的当前 user 消息`, async () => {
    const preset = presetLib.createPreset({ name, extensions: { SPreset: config } });
    presetLib.upsertEntry({ preset_id: preset.id, name: 'History', role: 'system', content: '', is_marker: true, marker_key: 'chatHistory' });
    presetLib.upsertEntry({
      preset_id: preset.id,
      name: 'Control',
      role: 'system',
      content: '<<<|catgodml|setLastMessage:{{lastUserMessage}}>>>',
      sort_order: 10,
    });
    const result = await assembler.assemblePresetPrompt(
      makeCharacter(), [makeMessage(1, 'user', 'CURRENT_UNIQUE')],
      { ...DEFAULT_SETTINGS, show_timestamps: false }, '', undefined,
      preset, presetLib.loadEnabledEntries(preset.id),
    );
    assert.ok(result.some(message => message.role === 'user' && message.content === 'CURRENT_UNIQUE'));
    assert.equal(result.some(message => String(message.content).includes('catgodml')), false);
  });
}

test('真实请求处理器仍接收原始控制指令与已展开的输入', async () => {
  const preset = presetLib.createPreset({
    name: 'request-processor',
    extensions: { SPreset: { FinalRequestProcessing: { enabled: true, script: '({request}) => request' } } },
  });
  presetLib.upsertEntry({
    preset_id: preset.id, name: 'Control', role: 'system',
    content: '<<<|catgodml|setLastMessage:{{lastUserMessage}}>>>',
  });
  const result = await assembler.assemblePresetPrompt(
    makeCharacter(), [makeMessage(1, 'user', 'CURRENT_UNIQUE')],
    { ...DEFAULT_SETTINGS, show_timestamps: false }, '', undefined,
    preset, presetLib.loadEnabledEntries(preset.id),
  );
  assert.ok(result.some(message => String(message.content).includes('<<<|catgodml|setLastMessage:CURRENT_UNIQUE>>>')));
});
