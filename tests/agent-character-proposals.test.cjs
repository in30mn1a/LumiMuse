const test = require('node:test');
const assert = require('node:assert/strict');
const { installMemoryOnlyTestGuard } = require('./helpers/memory-only-test-guard.cjs');

installMemoryOnlyTestGuard(test);
const Database = require('better-sqlite3');
require('./helpers/register-ts-loader.cjs').registerTsLoader();

const { __migrateForTests, __setDbForTests } = require('../src/lib/db.ts');
const { DEFAULT_SETTINGS } = require('../src/types/index.ts');
const { AGENT_TOOLS } = require('../src/lib/agent/tools/index.ts');
const { parseToolArguments } = require('../src/lib/agent/tools/registry.ts');
const { getProposalView, listProposalViews } = require('../src/lib/agent/proposals.ts');
const { applyProposalDecision, undoProposalItem } = require('../src/lib/agent/proposal-apply.ts');
const { createAgentSession, appendAgentMessage } = require('../src/lib/agent/store.ts');

const T0 = '2026-11-01T00:00:00.000Z';
const T1 = '2026-11-01T00:01:00.000Z';
const T2 = '2026-11-01T00:02:00.000Z';
const CARD = {
  name: '星野', basic_info: '住在海边', personality: '安静温柔', scenario: '午后茶室',
  greeting: '欢迎回来。', example_dialogue: '你：你好\n星野：你好。', system_prompt: '保持角色设定',
  other_info: '有一只猫', image_tags: 'blue hair', user_image_tags: 'brown hair',
  image_prompt_other_requirements: '完整保留画面要求',
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
  insert(db, 'characters', {
    id: 'char-a', ...CARD, avatar_url: '/avatars/fixture.png', background_model: 'fixture-model',
    background_provider_id: 'fixture-provider', memory_chat_injection_mode: 'local', created_at: T0, updated_at: T0,
  });
  insert(db, 'characters', { id: 'char-b', name: '白砂' });
  insert(db, 'conversations', { id: 'conv-a', character_id: 'char-a' });
  insert(db, 'conversations', { id: 'conv-b', character_id: 'char-b' });
  insert(db, 'messages', { id: 'msg-source-abcdefgh', conversation_id: 'conv-a', role: 'user', content: '希望角色说话更活泼', created_at: T0 });
  insert(db, 'messages', { id: 'msg-other-abcdefgh', conversation_id: 'conv-b', role: 'user', content: '其他角色', created_at: T0 });
  insert(db, 'memories', { id: 'memory-a', character_id: 'char-a', category: '偏好习惯', content: '喜欢茶', source_msg_ids: '["msg-source-abcdefgh"]' });
  const session = createAgentSession(db, { character_id: 'char-a', conversation_id: 'conv-a' }, T0);
  appendAgentMessage(db, session.id, { role: 'user', content: '把角色性格改得更活泼，其他字段先保留。' }, T0);
  return { db, sessionId: session.id, settings: DEFAULT_SETTINGS };
}

function character(db) { return db.prepare("SELECT * FROM characters WHERE id = 'char-a'").get(); }
function card(row) { return Object.fromEntries(Object.keys(CARD).map(key => [key, row[key]])); }
function untouched(db) {
  return JSON.stringify(['conversations', 'messages', 'memories', 'memory_revisions', 'memory_embedding_tasks', 'character_model_preset_bindings']
    .map(table => db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()));
}
function args(fields, extra = {}) {
  return { character_id: 'char-a', summary: '更新角色卡', fields, reason: '根据主人要求修改设定', confidence: 0.9,
    evidence: { message_ids: [], owner_quote: '把角色性格改得更活泼' }, ...extra };
}
function call(ctx, input) {
  const tool = AGENT_TOOLS.find(entry => entry.name === 'create_character_proposal');
  assert.ok(tool, 'Agent 缺少 create_character_proposal 工具');
  const parsed = parseToolArguments(tool, JSON.stringify(input));
  if (!parsed.ok) return { parseError: parsed.error };
  return tool.execute(parsed.args, ctx);
}
function propose(ctx, fields, extra = {}) {
  const outcome = call(ctx, args(fields, extra));
  assert.equal(outcome.parseError, undefined, outcome.parseError);
  assert.equal(outcome.result.ok, true, outcome.result.error);
  assert.equal(outcome.terminate, true, '提案生成后应结束本轮，等待批准');
  const view = getProposalView(ctx.db, outcome.result.proposal_id);
  return { view, id: view.id, itemId: view.items[0].id };
}
function approve(ctx, proposal, selected = true) {
  return applyProposalDecision(ctx.db, proposal.id, { action: 'apply', approved_item_ids: selected ? [proposal.itemId] : [], rejected_items: [] }, T1);
}

test('Agent 注册角色卡修改提案工具，创建后完整预览且未修改角色或记忆', t => {
  const ctx = setup(t);
  const before = character(ctx.db);
  const related = untouched(ctx.db);
  const proposal = propose(ctx, { personality: '活泼温柔', greeting: '欢迎回来，今天过得怎么样？' });
  assert.equal(proposal.view.items.length, 1);
  assert.equal(proposal.view.items[0].op, 'update');
  assert.deepEqual(proposal.view.items[0].before, { character: { id: 'char-a', snapshot: CARD } });
  assert.deepEqual(proposal.view.items[0].after, { personality: '活泼温柔', greeting: '欢迎回来，今天过得怎么样？' });
  assert.deepEqual(character(ctx.db), before);
  assert.equal(untouched(ctx.db), related);
  assert.equal(AGENT_TOOLS.filter(entry => entry.name === 'create_character_proposal').length, 1);
});

test('批准仅修改明确字段，清空可选文本，完整保留长生图要求及关联数据', t => {
  const ctx = setup(t);
  const longText = '  保留完整设定😀\n'.repeat(1200);
  const before = character(ctx.db);
  const related = untouched(ctx.db);
  const proposal = propose(ctx, { personality: '活泼温柔', example_dialogue: '', image_prompt_other_requirements: longText });
  const applied = approve(ctx, proposal);
  assert.equal(applied.ok, true, applied.error);
  assert.equal(applied.items[0].state, 'applied');
  const after = character(ctx.db);
  assert.equal(after.personality, '活泼温柔');
  assert.equal(after.example_dialogue, '');
  assert.equal(after.image_prompt_other_requirements, longText);
  for (const key of Object.keys(before).filter(key => !['personality', 'example_dialogue', 'image_prompt_other_requirements', 'updated_at'].includes(key))) {
    assert.deepEqual(after[key], before[key], key);
  }
  assert.ok(Date.parse(after.updated_at) > Date.parse(before.updated_at));
  assert.equal(untouched(ctx.db), related);
  const stored = getProposalView(ctx.db, proposal.id).items[0];
  assert.deepEqual(stored.before.character.snapshot, CARD);
  assert.deepEqual(stored.result.character, { id: 'char-a', snapshot: card(after) });
  assert.deepEqual(stored.result.memory_ids, []);
});

test('角色卡全部文本字段可修改，读取工具和撤销保留精确原值', async t => {
  for (const key of Object.keys(CARD)) {
    await t.test(key, async subtest => {
      const ctx = setup(subtest);
      const proposal = propose(ctx, { [key]: `新的${key}\n第二行😀` });
      assert.equal(approve(ctx, proposal).items[0].state, 'applied');
      const read = await AGENT_TOOLS.find(entry => entry.name === 'get_character').execute({ character_id: 'char-a' }, ctx);
      assert.equal(read.ok, true, read.error);
      assert.equal(read.character[key], `新的${key}\n第二行😀`);
      const outcome = undoProposalItem(ctx.db, proposal.id, proposal.itemId, T2);
      assert.equal(outcome.ok, true, outcome.error);
      assert.deepEqual(card(character(ctx.db)), CARD);
      assert.equal(getProposalView(ctx.db, proposal.id).items[0].state, 'undone');
    });
  }
});

test('拒绝角色卡提案不改变角色或关联数据', t => {
  const ctx = setup(t);
  const before = character(ctx.db);
  const related = untouched(ctx.db);
  const proposal = propose(ctx, { personality: '更活泼' });
  const outcome = approve(ctx, proposal, false);
  assert.equal(outcome.items[0].state, 'rejected');
  assert.deepEqual(character(ctx.db), before);
  assert.equal(untouched(ctx.db), related);
});

test('无变化、无目标、缺少依据或伪造主人原话时不创建提案', async t => {
  for (const [label, input] of [
    ['empty', args({})], ['same', args({ personality: CARD.personality })],
    ['missing', args({ personality: '更活泼' }, { character_id: 'missing' })],
    ['reason', args({ personality: '更活泼' }, { reason: '  ' })],
    ['evidence', args({ personality: '更活泼' }, { evidence: { message_ids: [] } })],
    ['quote', args({ personality: '更活泼' }, { evidence: { owner_quote: '主人并没有说过这句话' } })],
    ['other-source', args({ personality: '更活泼' }, { evidence: { message_ids: ['msg-other-abcdefgh'] } })],
  ]) {
    await t.test(label, subtest => {
      const ctx = setup(subtest);
      const before = character(ctx.db);
      const outcome = call(ctx, input);
      assert.equal(outcome.result.ok, false);
      assert.equal(ctx.db.prepare('SELECT COUNT(*) AS n FROM agent_proposals').get().n, 0);
      assert.deepEqual(character(ctx.db), before);
    });
  }
});

test('严格拒绝运行配置、未知字段和错误类型，不把遗漏字段填空', t => {
  const ctx = setup(t);
  for (const fields of [{ background_model: 'other' }, { avatar_url: null }, { status: 'active' }, { personality: 123 }]) {
    assert.ok(call(ctx, args(fields)).parseError, JSON.stringify(fields));
  }
  const proposal = propose(ctx, { personality: '更活泼', name: CARD.name });
  assert.deepEqual(proposal.view.items[0].after, { personality: '更活泼' });
});

test('来源消息唯一前缀补全且保留原文依据，无原文说明可以用于创作提案', t => {
  const ctx = setup(t);
  const proposal = propose(ctx, { scenario: '夜晚茶室' }, { evidence: { message_ids: ['msg-source-ab'] } });
  assert.deepEqual(proposal.view.items[0].evidence.message_ids, ['msg-source-abcdefgh']);
  assert.equal(proposal.view.evidence_messages[0].content, '希望角色说话更活泼');
  const creative = propose(ctx, { scenario: '雨中街角' }, { evidence: { message_ids: [], note: '无原文依据：这是提供主人选择的新场景' } });
  assert.match(creative.view.items[0].evidence.note, /^无原文依据/);
});

test('批准前任一角色卡字段已变化时整项过期，不覆盖并发修改', t => {
  const ctx = setup(t);
  const proposal = propose(ctx, { personality: '更活泼', greeting: '早上好' });
  ctx.db.prepare("UPDATE characters SET scenario = '主人另外编辑的场景' WHERE id = 'char-a'").run();
  const before = character(ctx.db);
  const outcome = approve(ctx, proposal);
  assert.equal(outcome.items[0].state, 'stale');
  assert.deepEqual(character(ctx.db), before);
});

test('撤销前任一角色卡字段已变化时返回冲突且保留已应用项', t => {
  const ctx = setup(t);
  const proposal = propose(ctx, { personality: '更活泼' });
  approve(ctx, proposal);
  ctx.db.prepare("UPDATE characters SET greeting = '后续编辑的开场白' WHERE id = 'char-a'").run();
  const before = character(ctx.db);
  const outcome = undoProposalItem(ctx.db, proposal.id, proposal.itemId, T2);
  assert.equal(outcome.ok, false);
  assert.equal(outcome.status, 409);
  assert.match(outcome.error, /角色卡.*改动/);
  assert.deepEqual(character(ctx.db), before);
  assert.equal(getProposalView(ctx.db, proposal.id).items[0].state, 'applied');
});

test('撤销角色卡保留后来修改的运行配置，会话删除后仍可从历史撤销', t => {
  const ctx = setup(t);
  const related = untouched(ctx.db);
  const proposal = propose(ctx, { personality: '更活泼', image_tags: '' });
  approve(ctx, proposal);
  ctx.db.prepare("UPDATE characters SET background_model = 'later-model' WHERE id = 'char-a'").run();
  ctx.db.prepare('DELETE FROM agent_sessions WHERE id = ?').run(ctx.sessionId);
  const history = listProposalViews(ctx.db, 'char-a', 20, 0).proposals[0];
  assert.equal(history.session_id, null);
  assert.equal(history.items[0].state, 'applied');
  const outcome = undoProposalItem(ctx.db, proposal.id, proposal.itemId, T2);
  assert.equal(outcome.ok, true, outcome.error);
  assert.deepEqual(card(character(ctx.db)), CARD);
  assert.equal(character(ctx.db).background_model, 'later-model');
  assert.equal(untouched(ctx.db), related);
  assert.equal(undoProposalItem(ctx.db, proposal.id, proposal.itemId, T2).status, 409);
});

test('同毫秒内角色卡保存仍推进更新时间', t => {
  const ctx = setup(t);
  ctx.db.prepare("UPDATE characters SET updated_at = ? WHERE id = 'char-a'").run(T1);
  const proposal = propose(ctx, { personality: '更活泼' });
  assert.equal(approve(ctx, proposal).items[0].state, 'applied');
  assert.ok(Date.parse(character(ctx.db).updated_at) > Date.parse(T1));
});
