const test = require('node:test');
const assert = require('node:assert/strict');
const { installMemoryOnlyTestGuard } = require('./helpers/memory-only-test-guard.cjs');

installMemoryOnlyTestGuard(test);
const Database = require('better-sqlite3');
require('./helpers/register-ts-loader.cjs').registerTsLoader();

const { __migrateForTests, __setDbForTests } = require('../src/lib/db.ts');
const { DEFAULT_SETTINGS } = require('../src/types/index.ts');
const { AGENT_READ_TOOLS, AGENT_TOOLS, AGENT_WRITE_TOOLS } = require('../src/lib/agent/tools/index.ts');
const { parseToolArguments } = require('../src/lib/agent/tools/registry.ts');
const { getProposalView, listProposalViews } = require('../src/lib/agent/proposals.ts');
const { applyProposalDecision, undoProposalItem } = require('../src/lib/agent/proposal-apply.ts');
const { isCheckedByDefault, proposalItemFlags } = require('../src/lib/agent/proposal-flags.ts');
const { createAgentSession, appendAgentMessage } = require('../src/lib/agent/store.ts');
const { applyTextEdits, setPresetScript } = require('../src/lib/agent/preset-edit.ts');
const { MAX_LARGE_TEXT } = require('../src/lib/schemas.ts');

const T0 = '2026-11-01T00:00:00.000Z';
const T1 = '2026-11-01T00:01:00.000Z';
const T2 = '2026-11-01T00:02:00.000Z';

const PRESET_MAIN_ID = 'preset-main-1111aaaa';
const PRESET_ALT_ID = 'preset-main-2222bbbb';
const ENTRY_MAIN_ID = 'entry-main-aaaa1111';
const ENTRY_SECOND_ID = 'entry-main-aaaa2222';
const ENTRY_MARKER_ID = 'entry-mark-cccc3333';
const ENTRY_ALT_ID = 'entry-altx-dddd4444';

const LONG_ENTRY_TEXT = [
  '开头第一行：角色保持温柔语调。',
  ...Array.from({ length: 600 }, (_, i) => `第 ${i + 2} 行：虚构设定片段😀 alpha.*beta 标记-${i}`),
  '结尾段落：请用中文自然回应。',
].join('\n');

const FINAL_REQUEST_SCRIPT = [
  '// final request script',
  'function transform(req) {',
  '  const mode = "strict";',
  '  return { ...req, mode };',
  '}',
].join('\n');

const TOOL_BINDING_KEY = 'tool.entry.with.dot';
const TOOL_BINDING_CODE = 'export function run(input) {\n  return input.trim();\n}\n';

const MAIN_EXTENSIONS = {
  SPreset: {
    FinalRequestProcessing: { enabled: true, script: FINAL_REQUEST_SCRIPT, extraFlag: 42 },
    OutputPreprocessing: {
      enabled: false,
      script: 'function clean(out) { return out; }',
      toolCallFormatter: { enabled: true, script: 'function fmt(tc) { return tc; }' },
    },
    ChatSquash: { enabled: true, squashed_post_script_enable: false, squashed_post_script: 'function squash(x) { return x; }' },
    ToolBindings: {
      [TOOL_BINDING_KEY]: { enabled: true, resolvedName: '查天气', name: 'weather', form: { name: 'weatherForm' }, code: TOOL_BINDING_CODE },
      'tool-fallback-name': { enabled: false, form: { name: '表单工具' }, code: 'return 1;' },
      'tool-no-code': { enabled: true, name: '无代码项' },
    },
    RegexBinding: { enabled: true, script: 'should never be exposed' },
    MessageInjections: [{ text: 'keep untouched' }],
  },
  tavern_helper: { version: 2, nested: { keep: ['a', 'b'] } },
};

function insert(db, table, row) {
  const keys = Object.keys(row);
  db.prepare(`INSERT INTO ${table} (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`)
    .run(...keys.map(key => row[key]));
}

function setup(t) {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  __migrateForTests(db);
  __setDbForTests(db);
  t.after(() => { __setDbForTests(null); db.close(); });

  insert(db, 'prompt_presets', {
    id: PRESET_MAIN_ID,
    name: '星夜主预设',
    description: '带 SPreset 运行时的虚构预设',
    is_built_in: 0,
    story_plot_strip: 0,
    strip_tags: JSON.stringify(['thought']),
    import_warnings: JSON.stringify(['示例警告']),
    extensions: JSON.stringify(MAIN_EXTENSIONS),
    created_at: T0,
    updated_at: T0,
  });
  insert(db, 'prompt_presets', {
    id: PRESET_ALT_ID,
    name: '极简预设',
    description: '无运行时脚本',
    is_built_in: 0,
    story_plot_strip: 1,
    strip_tags: JSON.stringify([]),
    import_warnings: JSON.stringify([]),
    extensions: JSON.stringify({}),
    created_at: '2026-11-01T00:00:05.000Z',
    updated_at: T0,
  });

  insert(db, 'prompt_preset_entries', {
    id: ENTRY_SECOND_ID,
    preset_id: PRESET_MAIN_ID,
    name: '文风补充',
    role: 'system',
    content: 'aaabbb，第一处需要保留，第二处需要改写。',
    is_marker: 0,
    injection_position: 1,
    injection_depth: 4,
    injection_order: 100,
    enabled: 0,
    sort_order: 2,
    created_at: T0,
    updated_at: T0,
  });
  insert(db, 'prompt_preset_entries', {
    id: ENTRY_MAIN_ID,
    preset_id: PRESET_MAIN_ID,
    name: '核心指令',
    role: 'system',
    content: LONG_ENTRY_TEXT,
    is_marker: 0,
    injection_position: 0,
    injection_depth: 4,
    injection_order: 100,
    enabled: 1,
    sort_order: 1,
    created_at: T0,
    updated_at: T0,
  });
  insert(db, 'prompt_preset_entries', {
    id: ENTRY_MARKER_ID,
    preset_id: PRESET_MAIN_ID,
    name: '聊天历史',
    role: 'system',
    content: '',
    is_marker: 1,
    marker_key: 'chatHistory',
    injection_position: 0,
    injection_depth: 4,
    injection_order: 100,
    enabled: 1,
    sort_order: 3,
    created_at: T0,
    updated_at: T0,
  });
  insert(db, 'prompt_preset_entries', {
    id: ENTRY_ALT_ID,
    preset_id: PRESET_ALT_ID,
    name: '极简指令',
    role: 'system',
    content: '简单直接地回复。',
    is_marker: 0,
    injection_position: 0,
    injection_depth: 4,
    injection_order: 100,
    enabled: 1,
    sort_order: 1,
    created_at: T0,
    updated_at: T0,
  });

  insert(db, 'characters', { id: 'char-a', name: '星野', active_preset_id: PRESET_MAIN_ID, sort_order: 0 });
  insert(db, 'characters', { id: 'char-b', name: '白砂', active_preset_id: '__none__', sort_order: 1 });
  insert(db, 'character_model_preset_bindings', {
    character_id: 'char-b', model: 'model-pro', preset_id: PRESET_MAIN_ID, sort_order: 0, created_at: T0, updated_at: T0,
  });
  insert(db, 'character_model_preset_bindings', {
    character_id: 'char-a', model: 'model-lite', preset_id: '__none__', sort_order: 0, created_at: T0, updated_at: T0,
  });
  insert(db, 'conversations', { id: 'conv-a', character_id: 'char-a' });
  insert(db, 'messages', { id: 'msg-chat-1', conversation_id: 'conv-a', role: 'user', content: '聊天里的消息', seq: 1, created_at: T0 });

  const session = createAgentSession(db, { character_id: 'char-a' }, T0);
  appendAgentMessage(db, session.id, { role: 'user', content: '帮我修改星夜主预设的条目、剥离标签和脚本。' }, T0);
  return { db, sessionId: session.id, settings: DEFAULT_SETTINGS };
}

async function runRead(name, args, ctx) {
  const tool = AGENT_READ_TOOLS.find(item => item.name === name);
  assert.ok(tool, `缺少只读工具 ${name}`);
  const parsed = parseToolArguments(tool, JSON.stringify(args));
  if (!parsed.ok) return { parseError: parsed.error };
  return tool.execute(parsed.args, ctx);
}

function callPropose(ctx, body) {
  const tool = AGENT_TOOLS.find(item => item.name === 'create_preset_proposal');
  assert.ok(tool, '缺少写工具 create_preset_proposal');
  const parsed = parseToolArguments(tool, JSON.stringify(body));
  if (!parsed.ok) return { parseError: parsed.error };
  return tool.execute(parsed.args, ctx);
}

function propose(ctx, items, extra = {}) {
  const outcome = callPropose(ctx, { preset_id: PRESET_MAIN_ID, summary: '调整预设配置', items, ...extra });
  assert.equal(outcome.parseError, undefined, outcome.parseError);
  assert.equal(outcome.result.ok, true, outcome.result.error);
  assert.equal(outcome.terminate, true);
  const view = getProposalView(ctx.db, outcome.result.proposal_id);
  return { view, id: view.id, itemId: view.items[0].id, result: outcome.result };
}

function approve(ctx, proposal, itemIds = proposal.view.items.map(item => item.id)) {
  return applyProposalDecision(ctx.db, proposal.id, { action: 'apply', approved_item_ids: itemIds, rejected_items: [] }, T1);
}

const OWNER_EVIDENCE = { owner_quote: '帮我修改星夜主预设的条目、剥离标签和脚本' };

test('工具注册：3 个预设只读工具和 1 个预设提案工具在各自列表里', () => {
  for (const name of ['list_presets', 'get_preset', 'read_preset_text']) {
    assert.ok(AGENT_READ_TOOLS.some(tool => tool.name === name && tool.kind === 'read'), name);
  }
  const writePresetTools = AGENT_WRITE_TOOLS.map(tool => tool.name).filter(name => name.includes('preset'));
  assert.deepEqual(writePresetTools, ['create_preset_proposal']);
});

test('list_presets 返回计数、运行时标记和两种角色绑定方式', async t => {
  const ctx = setup(t);
  const res = await runRead('list_presets', {}, ctx);
  assert.equal(res.ok, true, res.error);
  assert.equal(res.presets.length, 2);

  const main = res.presets[0];
  assert.equal(main.id, PRESET_MAIN_ID);
  assert.equal(main.name, '星夜主预设');
  assert.equal(main.story_plot_strip, false);
  assert.deepEqual(main.strip_tags, ['thought']);
  assert.equal(main.entry_count, 3);
  assert.equal(main.enabled_count, 2);
  assert.equal(main.spreset_runtime, true);
  assert.deepEqual(main.bound_characters, [
    { id: 'char-a', name: '星野', via: 'default' },
    { id: 'char-b', name: '白砂', via: 'model', model: 'model-pro' },
  ]);

  const alt = res.presets[1];
  assert.equal(alt.id, PRESET_ALT_ID);
  assert.equal(alt.spreset_runtime, false);
  assert.deepEqual(alt.bound_characters, []);
});

test('get_preset 按 sort_order 排条目、给 120 字预览并只列存在的白名单脚本', async t => {
  const ctx = setup(t);
  const res = await runRead('get_preset', { preset_id: 'preset-main-1111' }, ctx);
  assert.equal(res.ok, true, res.error);
  assert.equal(res.preset.id, PRESET_MAIN_ID);
  assert.deepEqual(res.preset.import_warnings, ['示例警告']);
  assert.deepEqual(res.entries.map(e => e.id), [ENTRY_MAIN_ID, ENTRY_SECOND_ID, ENTRY_MARKER_ID]);

  const mainEntry = res.entries[0];
  assert.equal(mainEntry.length, LONG_ENTRY_TEXT.length);
  assert.equal(mainEntry.preview, LONG_ENTRY_TEXT.slice(0, 120));
  assert.equal('content' in mainEntry, false, '不返回全文');

  const markerEntry = res.entries[2];
  assert.equal(markerEntry.is_marker, true);
  assert.equal(markerEntry.marker_key, 'chatHistory');
  assert.equal(markerEntry.length, 0);
  assert.equal(markerEntry.preview, '');

  assert.deepEqual(res.scripts, [
    { path: 'FinalRequestProcessing.script', label: '请求改写脚本', enabled: true, length: FINAL_REQUEST_SCRIPT.length },
    { path: 'OutputPreprocessing.script', label: '输出处理脚本', enabled: false, length: 'function clean(out) { return out; }'.length },
    { path: 'OutputPreprocessing.toolCallFormatter.script', label: '工具调用格式化脚本', enabled: true, length: 'function fmt(tc) { return tc; }'.length },
    { path: 'ChatSquash.squashed_post_script', label: '消息合并后处理脚本', enabled: false, length: 'function squash(x) { return x; }'.length },
    { path: `ToolBindings.${TOOL_BINDING_KEY}.code`, label: '工具「查天气」的代码', enabled: true, length: TOOL_BINDING_CODE.length },
    { path: 'ToolBindings.tool-fallback-name.code', label: '工具「表单工具」的代码', enabled: false, length: 'return 1;'.length },
  ]);
  for (const script of res.scripts) {
    assert.equal('content' in script, false);
  }
});

test('read_preset_text 分页拼接逐字一致，支持字面量 find、截断、前缀和错误拒绝', async t => {
  const ctx = setup(t);
  assert.ok(LONG_ENTRY_TEXT.length > 20_000, '测试文本需超过默认单页长度以验证多页拼接');

  // 1. 分页拼接逐字还原（用唯一前缀定位预设和条目）
  let offset = 0;
  let assembled = '';
  let pages = 0;
  while (offset !== null) {
    const page = await runRead('read_preset_text', {
      preset_id: 'preset-main-1111',
      entry_id: 'entry-main-aaaa1',
      offset,
      limit: 9000,
    }, ctx);
    assert.equal(page.ok, true, page.error);
    assert.deepEqual(page.target, { kind: 'entry', id: ENTRY_MAIN_ID, name: '核心指令' });
    assert.equal(page.total_length, LONG_ENTRY_TEXT.length);
    assert.equal(page.offset, offset);
    assembled += page.text;
    offset = page.next_offset;
    pages += 1;
  }
  assert.ok(pages >= 3);
  assert.equal(assembled, LONG_ENTRY_TEXT);

  // 2. find 字面量搜索（含正则元字符 .*），超 20 条时 truncated 为 true，省略 limit 搜全文
  const foundMany = await runRead('read_preset_text', {
    preset_id: PRESET_MAIN_ID,
    entry_id: ENTRY_MAIN_ID,
    find: 'alpha.*beta',
  }, ctx);
  assert.equal(foundMany.ok, true, foundMany.error);
  assert.equal(foundMany.matches.length, 20);
  assert.equal(foundMany.truncated, true);
  assert.equal(foundMany.matches[0].line, 2);
  assert.ok(foundMany.matches[0].context.includes('alpha.*beta'));

  const foundTail = await runRead('read_preset_text', {
    preset_id: PRESET_MAIN_ID,
    entry_id: ENTRY_MAIN_ID,
    find: '结尾段落：请用中文自然回应。',
  }, ctx);
  assert.equal(foundTail.ok, true, foundTail.error);
  assert.equal(foundTail.matches.length, 1);
  assert.equal(foundTail.truncated, false);
  assert.equal(foundTail.matches[0].line, 602);

  // 3. find 指定 offset / limit 区间
  const foundWindow = await runRead('read_preset_text', {
    preset_id: PRESET_MAIN_ID,
    entry_id: ENTRY_MAIN_ID,
    find: '结尾段落',
    offset: 0,
    limit: 500,
  }, ctx);
  assert.equal(foundWindow.ok, true);
  assert.equal(foundWindow.matches.length, 0);

  // 4. 读含点号的 ToolBindings 脚本路径
  const scriptRead = await runRead('read_preset_text', {
    preset_id: PRESET_MAIN_ID,
    script: `ToolBindings.${TOOL_BINDING_KEY}.code`,
  }, ctx);
  assert.equal(scriptRead.ok, true, scriptRead.error);
  assert.deepEqual(scriptRead.target, { kind: 'script', path: `ToolBindings.${TOOL_BINDING_KEY}.code`, label: '工具「查天气」的代码' });
  assert.equal(scriptRead.text, TOOL_BINDING_CODE);
  assert.equal(scriptRead.next_offset, null);

  // 5. 各类拒绝情况
  const nonWhitelist = await runRead('read_preset_text', { preset_id: PRESET_MAIN_ID, script: 'RegexBinding.script' }, ctx);
  assert.equal(nonWhitelist.ok, false);
  assert.match(nonWhitelist.error, /白名单/);

  const bothTargets = await runRead('read_preset_text', { preset_id: PRESET_MAIN_ID, entry_id: ENTRY_MAIN_ID, script: 'FinalRequestProcessing.script' }, ctx);
  assert.equal(bothTargets.ok, false);
  assert.match(bothTargets.error, /只能提供一个/);

  const neitherTarget = await runRead('read_preset_text', { preset_id: PRESET_MAIN_ID }, ctx);
  assert.equal(neitherTarget.ok, false);
  assert.match(neitherTarget.error, /只能提供一个/);

  const markerRead = await runRead('read_preset_text', { preset_id: PRESET_MAIN_ID, entry_id: ENTRY_MARKER_ID }, ctx);
  assert.equal(markerRead.ok, false);
  assert.match(markerRead.error, /marker/);

  // 6. ID 前缀歧义提示候选
  const ambiguousPreset = await runRead('get_preset', { preset_id: 'preset-main-' }, ctx);
  assert.equal(ambiguousPreset.ok, false);
  assert.match(ambiguousPreset.error, new RegExp(`${PRESET_MAIN_ID}.*${PRESET_ALT_ID}`));

  const ambiguousEntry = await runRead('read_preset_text', { preset_id: PRESET_MAIN_ID, entry_id: 'entry-main-aaaa' }, ctx);
  assert.equal(ambiguousEntry.ok, false);
  assert.match(ambiguousEntry.error, new RegExp(`${ENTRY_MAIN_ID}.*${ENTRY_SECOND_ID}`));
});

test('applyTextEdits 顺序替换、重叠计数与特殊替换符字面处理', () => {
  // 重叠计数：'aa' 在 'aaa' 中出现 2 次
  const overlap = applyTextEdits('aaabbb', [{ old_text: 'aa', new_text: 'x' }]);
  assert.equal(overlap.ok, false);
  assert.match(overlap.error, /第 1 处.*2 次/);

  const missing = applyTextEdits('hello', [{ old_text: 'world', new_text: 'x' }]);
  assert.equal(missing.ok, false);
  assert.match(missing.error, /第 1 处.*0 次/);

  // 顺序生效：第二处基于第一处的结果，且 new_text 里的 $& / $1 原样保留
  const seq = applyTextEdits('step1 -> step2', [
    { old_text: 'step1', new_text: 'alpha $& $1' },
    { old_text: 'alpha $& $1 -> step2', new_text: 'done:$&' },
  ]);
  assert.equal(seq.ok, true);
  assert.equal(seq.text, 'done:$&');

  // new_text 为空串（删除）
  const del = applyTextEdits('keep [drop] keep2', [{ old_text: ' [drop]', new_text: '' }]);
  assert.equal(del.ok, true);
  assert.equal(del.text, 'keep keep2');

  // 结果未变报错
  const noop = applyTextEdits('abc', [{ old_text: 'a', new_text: 'x' }, { old_text: 'x', new_text: 'a' }]);
  assert.equal(noop.ok, false);
  assert.match(noop.error, /完全相同/);
});

test('创建校验：不合法项全部拒绝且整份不落库', async t => {
  const validEntryItem = {
    target: 'entry',
    entry_id: ENTRY_SECOND_ID,
    enabled: true,
    reason: '开启条目',
    evidence: OWNER_EVIDENCE,
    confidence: 0.9,
  };

  const cases = [
    ['old_text 0 次', [{ target: 'entry', entry_id: ENTRY_SECOND_ID, edits: [{ old_text: '不存在的片段', new_text: 'x' }], reason: '改字', evidence: OWNER_EVIDENCE, confidence: 0.9 }], /找到 0 次/],
    ['old_text 2 次（含重叠）', [{ target: 'entry', entry_id: ENTRY_SECOND_ID, edits: [{ old_text: 'aa', new_text: 'x' }], reason: '改字', evidence: OWNER_EVIDENCE, confidence: 0.9 }], /找到 2 次/],
    ['没有实际变化', [{ target: 'entry', entry_id: ENTRY_SECOND_ID, enabled: false, name: '文风补充', reason: '无变化', evidence: OWNER_EVIDENCE, confidence: 0.9 }], /没有实际改动/],
    ['改 marker 正文', [{ target: 'entry', entry_id: ENTRY_MARKER_ID, edits: [{ old_text: 'a', new_text: 'b' }], reason: '改 marker', evidence: OWNER_EVIDENCE, confidence: 0.9 }], /marker.*不能修改正文/],
    ['条目属于别的预设', [{ target: 'entry', entry_id: ENTRY_ALT_ID, enabled: false, reason: '跨预设', evidence: OWNER_EVIDENCE, confidence: 0.9 }], /不存在或不属于预设/],
    ['同一条目重复出现', [validEntryItem, { ...validEntryItem, name: '新名字' }], /已在第 1 项中修改/],
    ['settings 重复出现', [
      { target: 'settings', story_plot_strip: true, reason: '开启', evidence: OWNER_EVIDENCE, confidence: 0.9 },
      { target: 'settings', strip_tags: ['ooc'], reason: '再改', evidence: OWNER_EVIDENCE, confidence: 0.9 },
    ], /已在第 1 项中修改/],
    ['同一脚本重复出现', [
      { target: 'script', script: 'FinalRequestProcessing.script', edits: [{ old_text: '"strict"', new_text: '"loose"' }], reason: '改1', evidence: OWNER_EVIDENCE, confidence: 0.9 },
      { target: 'script', script: 'FinalRequestProcessing.script', edits: [{ old_text: 'transform', new_text: 'rewrite' }], reason: '改2', evidence: OWNER_EVIDENCE, confidence: 0.9 },
    ], /已在第 1 项中修改/],
    ['字段与 target 不匹配', [{ target: 'settings', story_plot_strip: true, edits: [{ old_text: 'a', new_text: 'b' }], reason: '混用', evidence: OWNER_EVIDENCE, confidence: 0.9 }], /不能包含字段：edits/],
    ['非法 strip_tags 格式', [{ target: 'settings', strip_tags: ['123bad'], reason: '非法标签', evidence: OWNER_EVIDENCE, confidence: 0.9 }], /strip_tags 不合法/],
    ['strip_tags 冲突', [{ target: 'settings', strip_tags: ['plot', '#PLOT'], reason: '冲突', evidence: OWNER_EVIDENCE, confidence: 0.9 }], /conflicts with strip_tags/],
    ['拒绝 evidence.message_ids', [{ ...validEntryItem, evidence: { message_ids: ['msg-chat-1'] } }], /依据消息不存在或不属于该角色的对话/],
    ['未命中 owner_quote', [{ ...validEntryItem, evidence: { owner_quote: '主人从未说过这句话' } }], /owner_quote/],
    ['普通条目超 MAX_LARGE_TEXT', [{
      target: 'entry', entry_id: ENTRY_SECOND_ID,
      edits: [{ old_text: '第二处需要改写', new_text: '长'.repeat(MAX_LARGE_TEXT + 10) }],
      reason: '超长', evidence: OWNER_EVIDENCE, confidence: 0.9,
    }], /超过上限/],
    ['任一项失败时整份不落库', [
      validEntryItem,
      { target: 'script', script: 'RegexBinding.script', edits: [{ old_text: 'a', new_text: 'b' }], reason: '非法路径', evidence: OWNER_EVIDENCE, confidence: 0.9 },
    ], /不在白名单内/],
  ];

  for (const [label, items, pattern] of cases) {
    await t.test(label, subtest => {
      const ctx = setup(subtest);
      const outcome = callPropose(ctx, { preset_id: PRESET_MAIN_ID, summary: '校验测试', items });
      assert.equal(outcome.parseError, undefined, outcome.parseError);
      assert.equal(outcome.result.ok, false);
      assert.match(outcome.result.error, pattern);
      assert.equal(outcome.terminate, undefined);
      assert.equal(ctx.db.prepare('SELECT COUNT(*) AS n FROM agent_proposals').get().n, 0);
    });
  }
});

test('已超过 MAX_LARGE_TEXT 的导入条目仍可用定位替换编辑', t => {
  const ctx = setup(t);
  const huge = `${'规'.repeat(MAX_LARGE_TEXT + 5000)}\n需要修改的一句\n结尾`;
  ctx.db.prepare('UPDATE prompt_preset_entries SET content = ? WHERE id = ?').run(huge, ENTRY_MAIN_ID);
  const proposal = propose(ctx, [{
    target: 'entry',
    entry_id: ENTRY_MAIN_ID,
    edits: [{ old_text: '需要修改的一句', new_text: '已经修改并略微加长的一句' }],
    reason: '微调大条目',
    evidence: OWNER_EVIDENCE,
    confidence: 0.9,
  }]);
  const applied = approve(ctx, proposal);
  assert.equal(applied.ok, true);
  assert.equal(applied.items[0].state, 'applied');
  const updated = ctx.db.prepare('SELECT content FROM prompt_preset_entries WHERE id = ?').get(ENTRY_MAIN_ID);
  assert.ok(updated.content.includes('已经修改并略微加长的一句'));
});

test('批准 entry、settings、script 三种项生效，保留 extensions 其余键，并更新 updated_at', t => {
  const ctx = setup(t);
  const beforeExt = JSON.parse(ctx.db.prepare('SELECT extensions FROM prompt_presets WHERE id = ?').get(PRESET_MAIN_ID).extensions);
  const expectedExt = setPresetScript(
    setPresetScript(beforeExt, 'FinalRequestProcessing.script', FINAL_REQUEST_SCRIPT.replace('"strict"', '"relaxed"')),
    `ToolBindings.${TOOL_BINDING_KEY}.code`,
    TOOL_BINDING_CODE.replace('trim()', 'trim().toLowerCase()'),
  );

  const proposal = propose(ctx, [
    {
      target: 'entry',
      entry_id: 'entry-main-aaaa2',
      name: '文风补充·新版',
      enabled: true,
      edits: [
        { old_text: '第二处需要改写', new_text: '第二处已改写' },
        { old_text: '第一处需要保留，第二处已改写', new_text: '第一处保留，第二处已改写' },
      ],
      reason: '按主人要求改条目',
      evidence: OWNER_EVIDENCE,
      confidence: 0.9,
    },
    {
      target: 'settings',
      story_plot_strip: true,
      strip_tags: ['thought', '#ooc'],
      reason: '开启剧情剥离并增加 #ooc',
      evidence: OWNER_EVIDENCE,
      confidence: 0.9,
    },
    {
      target: 'script',
      script: 'FinalRequestProcessing.script',
      edits: [{ old_text: 'const mode = "strict";', new_text: 'const mode = "relaxed";' }],
      reason: '放宽模式',
      evidence: OWNER_EVIDENCE,
      confidence: 0.9,
    },
    {
      target: 'script',
      script: `ToolBindings.${TOOL_BINDING_KEY}.code`,
      edits: [{ old_text: 'return input.trim();', new_text: 'return input.trim().toLowerCase();' }],
      reason: '统一小写',
      evidence: OWNER_EVIDENCE,
      confidence: 0.9,
    },
  ]);

  assert.equal(proposal.view.character_id, null);
  assert.equal(listProposalViews(ctx.db, null, 20, 0).proposals[0].id, proposal.id);

  const applied = approve(ctx, proposal);
  assert.equal(applied.ok, true, applied.error);
  assert.deepEqual(applied.items.map(item => item.state), ['applied', 'applied', 'applied', 'applied']);

  const entryRow = ctx.db.prepare('SELECT name, enabled, content, updated_at FROM prompt_preset_entries WHERE id = ?').get(ENTRY_SECOND_ID);
  assert.equal(entryRow.name, '文风补充·新版');
  assert.equal(entryRow.enabled, 1);
  assert.equal(entryRow.content, 'aaabbb，第一处保留，第二处已改写。');
  assert.equal(entryRow.updated_at, T1);

  const presetRow = ctx.db.prepare('SELECT story_plot_strip, strip_tags, extensions, updated_at FROM prompt_presets WHERE id = ?').get(PRESET_MAIN_ID);
  assert.equal(presetRow.story_plot_strip, 1);
  assert.deepEqual(JSON.parse(presetRow.strip_tags), ['thought', '#ooc']);
  assert.equal(presetRow.updated_at, T1);

  const afterExt = JSON.parse(presetRow.extensions);
  assert.deepEqual(afterExt, expectedExt);
  // 确认非白名单字段（RegexBinding、MessageInjections、tavern_helper、extraFlag）完全未动
  assert.deepEqual(afterExt.SPreset.RegexBinding, beforeExt.SPreset.RegexBinding);
  assert.deepEqual(afterExt.SPreset.MessageInjections, beforeExt.SPreset.MessageInjections);
  assert.deepEqual(afterExt.tavern_helper, beforeExt.tavern_helper);
  assert.equal(afterExt.SPreset.FinalRequestProcessing.extraFlag, 42);
});

test('过期检测：正文变更和删除预设判 stale；只改 injection_depth 仍可批准', async t => {
  await t.test('content edited before apply -> stale', subtest => {
    const ctx = setup(subtest);
    const proposal = propose(ctx, [{
      target: 'entry', entry_id: ENTRY_SECOND_ID,
      edits: [{ old_text: '第二处需要改写', new_text: '已改写' }],
      reason: '改字', evidence: OWNER_EVIDENCE, confidence: 0.9,
    }]);
    ctx.db.prepare("UPDATE prompt_preset_entries SET content = '主人抢先改过了' WHERE id = ?").run(ENTRY_SECOND_ID);
    const outcome = approve(ctx, proposal);
    assert.equal(outcome.items[0].state, 'stale');
    assert.equal(ctx.db.prepare('SELECT content FROM prompt_preset_entries WHERE id = ?').get(ENTRY_SECOND_ID).content, '主人抢先改过了');
  });

  await t.test('injection_depth changed -> still applies', subtest => {
    const ctx = setup(subtest);
    const proposal = propose(ctx, [{
      target: 'entry', entry_id: ENTRY_SECOND_ID,
      enabled: true,
      reason: '开启条目', evidence: OWNER_EVIDENCE, confidence: 0.9,
    }]);
    ctx.db.prepare('UPDATE prompt_preset_entries SET injection_depth = 9 WHERE id = ?').run(ENTRY_SECOND_ID);
    const outcome = approve(ctx, proposal);
    assert.equal(outcome.items[0].state, 'applied');
    const row = ctx.db.prepare('SELECT enabled, injection_depth FROM prompt_preset_entries WHERE id = ?').get(ENTRY_SECOND_ID);
    assert.equal(row.enabled, 1);
    assert.equal(row.injection_depth, 9);
  });

  await t.test('preset deleted -> stale', subtest => {
    const ctx = setup(subtest);
    const proposal = propose(ctx, [
      { target: 'entry', entry_id: ENTRY_SECOND_ID, enabled: true, reason: '开启', evidence: OWNER_EVIDENCE, confidence: 0.9 },
      { target: 'settings', story_plot_strip: true, reason: '剥离', evidence: OWNER_EVIDENCE, confidence: 0.9 },
      { target: 'script', script: 'FinalRequestProcessing.script', edits: [{ old_text: '"strict"', new_text: '"loose"' }], reason: '脚本', evidence: OWNER_EVIDENCE, confidence: 0.9 },
    ]);
    ctx.db.prepare('DELETE FROM prompt_presets WHERE id = ?').run(PRESET_MAIN_ID);
    const outcome = approve(ctx, proposal);
    assert.deepEqual(outcome.items.map(item => item.state), ['stale', 'stale', 'stale']);
  });
});

test('撤销：只还原改过的键；批准后再被改动时 409 冲突且保留现状', async t => {
  await t.test('undo restores only changed keys across entry, settings and script', subtest => {
    const ctx = setup(subtest);
    const proposal = propose(ctx, [
      { target: 'entry', entry_id: ENTRY_SECOND_ID, enabled: true, reason: '只改开关', evidence: OWNER_EVIDENCE, confidence: 0.9 },
      { target: 'settings', strip_tags: ['thought', '#meta'], reason: '只改标签表', evidence: OWNER_EVIDENCE, confidence: 0.9 },
      { target: 'script', script: 'FinalRequestProcessing.script', edits: [{ old_text: '"strict"', new_text: '"loose"' }], reason: '改脚本', evidence: OWNER_EVIDENCE, confidence: 0.9 },
    ]);
    approve(ctx, proposal);
    // 改动未跟踪的 injection_depth 不影响 entry 撤销
    ctx.db.prepare('UPDATE prompt_preset_entries SET injection_depth = 7 WHERE id = ?').run(ENTRY_SECOND_ID);

    for (const item of proposal.view.items) {
      const undone = undoProposalItem(ctx.db, proposal.id, item.id, T2);
      assert.equal(undone.ok, true, undone.error);
    }

    const entryRow = ctx.db.prepare('SELECT enabled, injection_depth, name, content FROM prompt_preset_entries WHERE id = ?').get(ENTRY_SECOND_ID);
    assert.equal(entryRow.enabled, 0);
    assert.equal(entryRow.injection_depth, 7);
    assert.equal(entryRow.name, '文风补充');

    const presetRow = ctx.db.prepare('SELECT story_plot_strip, strip_tags, extensions, updated_at FROM prompt_presets WHERE id = ?').get(PRESET_MAIN_ID);
    assert.equal(presetRow.story_plot_strip, 0);
    assert.deepEqual(JSON.parse(presetRow.strip_tags), ['thought']);
    assert.deepEqual(JSON.parse(presetRow.extensions), MAIN_EXTENSIONS);
    assert.equal(presetRow.updated_at, T2);
  });

  await t.test('post-apply modification blocks undo with 409', subtest => {
    const ctx = setup(subtest);
    const proposal = propose(ctx, [
      { target: 'entry', entry_id: ENTRY_SECOND_ID, name: '新名称', reason: '改名', evidence: OWNER_EVIDENCE, confidence: 0.9 },
      { target: 'settings', story_plot_strip: true, reason: '开启剥离', evidence: OWNER_EVIDENCE, confidence: 0.9 },
      { target: 'script', script: 'FinalRequestProcessing.script', edits: [{ old_text: '"strict"', new_text: '"loose"' }], reason: '改脚本', evidence: OWNER_EVIDENCE, confidence: 0.9 },
    ]);
    approve(ctx, proposal);

    ctx.db.prepare("UPDATE prompt_preset_entries SET name = '后来又改了' WHERE id = ?").run(ENTRY_SECOND_ID);
    const undoEntry = undoProposalItem(ctx.db, proposal.id, proposal.view.items[0].id, T2);
    assert.equal(undoEntry.ok, false);
    assert.equal(undoEntry.status, 409);
    assert.equal(ctx.db.prepare('SELECT name FROM prompt_preset_entries WHERE id = ?').get(ENTRY_SECOND_ID).name, '后来又改了');

    ctx.db.prepare('UPDATE prompt_presets SET story_plot_strip = 0 WHERE id = ?').run(PRESET_MAIN_ID);
    const undoSettings = undoProposalItem(ctx.db, proposal.id, proposal.view.items[1].id, T2);
    assert.equal(undoSettings.ok, false);
    assert.equal(undoSettings.status, 409);

    const ext = JSON.parse(ctx.db.prepare('SELECT extensions FROM prompt_presets WHERE id = ?').get(PRESET_MAIN_ID).extensions);
    const hacked = setPresetScript(ext, 'FinalRequestProcessing.script', '// manually edited');
    ctx.db.prepare('UPDATE prompt_presets SET extensions = ? WHERE id = ?').run(JSON.stringify(hacked), PRESET_MAIN_ID);
    const undoScript = undoProposalItem(ctx.db, proposal.id, proposal.view.items[2].id, T2);
    assert.equal(undoScript.ok, false);
    assert.equal(undoScript.status, 409);
    const currentScript = JSON.parse(ctx.db.prepare('SELECT extensions FROM prompt_presets WHERE id = ?').get(PRESET_MAIN_ID).extensions)
      .SPreset.FinalRequestProcessing.script;
    assert.equal(currentScript, '// manually edited');
  });
});

test('标注：脚本项和关闭 marker 项默认不勾选；普通条目带主人原话默认勾选', t => {
  const ctx = setup(t);
  const proposal = propose(ctx, [
    {
      target: 'entry',
      entry_id: ENTRY_SECOND_ID,
      edits: [{ old_text: '第二处需要改写', new_text: '第二处改成饕餮喵' }],
      reason: '普通条目微调',
      evidence: OWNER_EVIDENCE,
      confidence: 0.9,
    },
    {
      target: 'entry',
      entry_id: ENTRY_MARKER_ID,
      enabled: false,
      reason: '关闭聊天历史占位',
      evidence: OWNER_EVIDENCE,
      confidence: 0.9,
    },
    {
      target: 'script',
      script: 'FinalRequestProcessing.script',
      edits: [{ old_text: '"strict"', new_text: '"loose"' }],
      reason: '改脚本',
      evidence: OWNER_EVIDENCE,
      confidence: 0.9,
    },
  ]);

  const [normalFlags, markerFlags, scriptFlags] = proposal.view.items.map(item => proposalItemFlags(item));
  assert.equal(normalFlags.presetScript, false);
  assert.equal(normalFlags.disablesMarker, false);
  assert.deepEqual(normalFlags.unfamiliarChars, []);
  assert.equal(isCheckedByDefault(normalFlags), true);

  assert.equal(markerFlags.disablesMarker, true);
  assert.equal(markerFlags.presetScript, false);
  assert.equal(isCheckedByDefault(markerFlags), false);

  assert.equal(scriptFlags.presetScript, true);
  assert.equal(scriptFlags.disablesMarker, false);
  assert.equal(isCheckedByDefault(scriptFlags), false);
});
