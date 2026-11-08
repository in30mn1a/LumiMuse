const test = require('node:test');
const assert = require('node:assert/strict');
const { installMemoryOnlyTestGuard } = require('./helpers/memory-only-test-guard.cjs');

installMemoryOnlyTestGuard(test);
const Database = require('better-sqlite3');
require('./helpers/register-ts-loader.cjs').registerTsLoader();
const { NextRequest } = require('next/server');
const { __migrateForTests, __setDbForTests } = require('../src/lib/db.ts');
const { DEFAULT_SETTINGS } = require('../src/types/index.ts');
const { AGENT_TOOLS } = require('../src/lib/agent/tools/index.ts');
const { parseToolArguments } = require('../src/lib/agent/tools/registry.ts');
const { getProposalView, listProposalViews } = require('../src/lib/agent/proposals.ts');
const { applyProposalDecision, undoProposalItem } = require('../src/lib/agent/proposal-apply.ts');
const { createAgentSession, appendAgentMessage, deleteAgentSession } = require('../src/lib/agent/store.ts');
const historyRoute = require('../src/app/api/agent/proposals/route.ts');
const characterRoute = require('../src/app/api/characters/route.ts');

const T0 = '2026-11-09T00:00:00.000Z';
const T1 = '2026-11-09T00:01:00.000Z';
const T2 = '2026-11-09T00:02:00.000Z';
const CARD = {
  name: '青岚', basic_info: '海边书店的店主', personality: '温柔而有好奇心', scenario: '雨天的书店',
  greeting: '进来避避雨吧。', example_dialogue: '你：在看什么？\n青岚：一本航海日记。',
  system_prompt: '保持角色设定', other_info: '喜欢收集旧地图', image_tags: 'blue hair',
  user_image_tags: '', image_prompt_other_requirements: '  保留完整画面要求😀\n'.repeat(1200),
};

function setup(t) {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  __migrateForTests(db);
  __setDbForTests(db);
  t.after(() => { __setDbForTests(null); db.close(); });
  const session = createAgentSession(db, {}, T0);
  appendAgentMessage(db, session.id, { role: 'user', content: '请从零创建一位海边书店的店主，名字叫青岚。' }, T0);
  return { db, sessionId: session.id, settings: DEFAULT_SETTINGS };
}

function call(ctx, fields = CARD, extra = {}) {
  const tool = AGENT_TOOLS.find(entry => entry.name === 'create_character');
  assert.ok(tool, 'Agent 缺少从零创建角色卡的 create_character 工具');
  const parsed = parseToolArguments(tool, JSON.stringify({ summary: '创建青岚', fields,
    reason: '根据主人要求创作新角色', confidence: 0.9,
    evidence: { owner_quote: '请从零创建一位海边书店的店主' }, ...extra }));
  return parsed.ok ? tool.execute(parsed.args, ctx) : { parseError: parsed.error };
}

function propose(ctx, fields = CARD, extra = {}) {
  const outcome = call(ctx, fields, extra);
  assert.equal(outcome.parseError, undefined, outcome.parseError);
  assert.equal(outcome.result.ok, true, outcome.result.error);
  assert.equal(outcome.terminate, true);
  const view = getProposalView(ctx.db, outcome.result.proposal_id);
  return { id: view.id, itemId: view.items[0].id, characterId: view.items[0].before.character_creation.id, view };
}

function approve(ctx, proposal, selected = true) {
  return applyProposalDecision(ctx.db, proposal.id, { action: 'apply',
    approved_item_ids: selected ? [proposal.itemId] : [], rejected_items: [] }, T1);
}

function characters(db) { return db.prepare('SELECT * FROM characters ORDER BY id').all(); }

test('零角色时生成完整新角色提案，批准前不创建角色或关联数据', t => {
  const ctx = setup(t);
  const proposal = propose(ctx);
  assert.equal(proposal.view.character_id, null);
  assert.equal(proposal.view.items[0].op, 'create');
  assert.match(proposal.characterId, /^[a-f0-9-]{12}$/);
  assert.deepEqual(proposal.view.items[0].after, CARD);
  assert.deepEqual(characters(ctx.db), []);
  for (const table of ['conversations', 'memories', 'memory_revisions', 'memory_embedding_tasks']) {
    assert.equal(ctx.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n, 0, table);
  }
  assert.equal(AGENT_TOOLS.filter(tool => tool.name === 'create_character').length, 1);
});

test('批准只创建一次且完整保留设定，默认配置与手动创建一致并置顶', async t => {
  const ctx = setup(t);
  const manual = await characterRoute.POST(new NextRequest('http://localhost/api/characters', {
    method: 'POST', body: JSON.stringify({ name: '手动角色' }),
  }));
  assert.equal(manual.status, 201);
  const old = characters(ctx.db)[0];
  ctx.db.prepare('UPDATE characters SET sort_order = -9 WHERE id = ?').run(old.id);
  const proposal = propose(ctx);
  const applied = approve(ctx, proposal);
  assert.equal(applied.ok, true, applied.error);
  assert.equal(applied.items[0].state, 'applied');
  const created = ctx.db.prepare('SELECT * FROM characters WHERE id = ?').get(proposal.characterId);
  assert.deepEqual(Object.fromEntries(Object.keys(CARD).map(key => [key, created[key]])), CARD);
  for (const key of Object.keys(old).filter(key => !['id', ...Object.keys(CARD), 'sort_order', 'created_at', 'updated_at'].includes(key))) {
    assert.deepEqual(created[key], old[key], key);
  }
  assert.equal(created.active_preset_id, '__none__');
  assert.equal(created.memory_chat_injection_mode, 'full');
  assert.equal(created.sort_order, -10);
  assert.equal(created.created_at, T1);
  assert.equal(created.updated_at, T1);
  const item = getProposalView(ctx.db, proposal.id).items[0];
  assert.deepEqual(item.result.character, { id: proposal.characterId, snapshot: CARD });
  assert.deepEqual(item.result.created_character, created);
  assert.equal(approve(ctx, proposal).status, 409);
  assert.equal(characters(ctx.db).length, 2);
  const read = await AGENT_TOOLS.find(tool => tool.name === 'get_character').execute({ character_id: proposal.characterId }, ctx);
  assert.equal(read.character.image_prompt_other_requirements, CARD.image_prompt_other_requirements);
});

test('未传可选文本补空；拒绝和待批会话删除均不创建角色', t => {
  const ctx = setup(t);
  const first = propose(ctx, { name: '青岚' });
  assert.deepEqual(first.view.items[0].after, Object.fromEntries(Object.keys(CARD).map(key => [key, key === 'name' ? '青岚' : ''])));
  assert.equal(approve(ctx, first, false).items[0].state, 'rejected');
  const pending = propose(ctx, { name: '青岚' });
  assert.equal(deleteAgentSession(ctx.db, ctx.sessionId, T2), true);
  assert.equal(getProposalView(ctx.db, pending.id).items[0].state, 'rejected');
  assert.deepEqual(characters(ctx.db), []);
});

test('与手动新建一样允许同名角色，分别保存提案与设定', t => {
  const ctx = setup(t);
  const first = propose(ctx, { name: '青岚', personality: '温柔' });
  const second = propose(ctx, { name: '青岚', personality: '活泼' });
  assert.notEqual(first.characterId, second.characterId);
  assert.equal(approve(ctx, first).items[0].state, 'applied');
  assert.equal(approve(ctx, second).items[0].state, 'applied');
  assert.deepEqual(characters(ctx.db).map(character => character.name), ['青岚', '青岚']);
});

test('决定保存意外失败时创建角色和项状态一起回滚，重试只创建一次', t => {
  const ctx = setup(t);
  const proposal = propose(ctx);
  ctx.db.exec(`CREATE TRIGGER fail_creation_decision BEFORE UPDATE OF state ON agent_proposal_items
    WHEN NEW.state = 'applied' BEGIN SELECT RAISE(ABORT, 'fixture decision interrupted'); END;`);
  assert.throws(() => approve(ctx, proposal), /fixture decision interrupted/);
  assert.deepEqual(characters(ctx.db), []);
  const view = getProposalView(ctx.db, proposal.id);
  assert.equal(view.status, 'pending');
  assert.equal(view.items[0].state, 'pending');
  ctx.db.exec('DROP TRIGGER fail_creation_decision');
  assert.equal(approve(ctx, proposal).items[0].state, 'applied');
  assert.equal(characters(ctx.db).length, 1);
});

test('无目标参数的新建工具拒绝未知字段、错误类型、空名称及无效依据', t => {
  const ctx = setup(t);
  for (const fields of [{}, { name: '' }, { name: '  ' }, { name: 123 }, { name: '青岚', avatar_url: null },
    { name: '青岚', background_model: 'model' }, { name: '青岚', personality: 123 }]) {
    assert.ok(call(ctx, fields).parseError, JSON.stringify(fields));
  }
  assert.ok(call(ctx, CARD, { character_id: 'missing' }).parseError);
  for (const extra of [{ reason: '  ' }, { summary: '  ' }, { evidence: {} },
    { evidence: { owner_quote: '主人未说过的原话' } }, { evidence: { message_ids: ['nonexistent'] } }]) {
    const outcome = call(ctx, CARD, extra);
    assert.equal(outcome.result.ok, false, JSON.stringify(extra));
  }
  assert.equal(ctx.db.prepare('SELECT COUNT(*) AS n FROM agent_proposals').get().n, 0);
  const creative = propose(ctx, { name: '青岚' }, { evidence: { note: '无原文依据：提供主人选择的新角色创意' } });
  assert.match(creative.view.items[0].evidence.note, /^无原文依据/);
});

test('原样新角色可撤销，删除会话后历史及按角色筛选仍保留', async t => {
  const ctx = setup(t);
  const proposal = propose(ctx);
  assert.equal(approve(ctx, proposal).items[0].state, 'applied');
  deleteAgentSession(ctx.db, ctx.sessionId, T2);
  assert.equal(getProposalView(ctx.db, proposal.id).session_id, null);
  assert.equal(listProposalViews(ctx.db, proposal.characterId, 20, 0).proposals[0].id, proposal.id);
  const undone = undoProposalItem(ctx.db, proposal.id, proposal.itemId, T2);
  assert.equal(undone.ok, true, undone.error);
  assert.deepEqual(characters(ctx.db), []);
  assert.equal(getProposalView(ctx.db, proposal.id).items[0].state, 'undone');
  const response = await historyRoute.GET(new NextRequest('http://localhost/api/agent/proposals'));
  assert.equal(response.status, 200);
  assert.equal((await response.json()).proposals[0].id, proposal.id);
  assert.equal(undoProposalItem(ctx.db, proposal.id, proposal.itemId, T2).status, 409);
});

test('新角色任何后续字段或运行配置修改均阻止撤销', async t => {
  for (const field of ['personality', 'avatar_url', 'background_model', 'memory_chat_injection_mode', 'sort_order', 'updated_at']) {
    await t.test(field, subtest => {
      const ctx = setup(subtest);
      const proposal = propose(ctx);
      approve(ctx, proposal);
      ctx.db.prepare(`UPDATE characters SET ${field} = ? WHERE id = ?`)
        .run(field === 'sort_order' ? 5 : field === 'memory_chat_injection_mode' ? 'local' : '后续修改', proposal.characterId);
      const before = characters(ctx.db);
      const outcome = undoProposalItem(ctx.db, proposal.id, proposal.itemId, T2);
      assert.equal(outcome.status, 409);
      assert.deepEqual(characters(ctx.db), before);
      assert.equal(getProposalView(ctx.db, proposal.id).items[0].state, 'applied');
    });
  }
});

test('已有对话、记忆、Agent 关联及未来新增关联表时拒绝撤销并保留数据', async t => {
  for (const related of ['conversation', 'memory', 'session', 'future-table']) {
    await t.test(related, subtest => {
      const ctx = setup(subtest);
      const proposal = propose(ctx);
      approve(ctx, proposal);
      if (related === 'conversation') ctx.db.prepare('INSERT INTO conversations (id, character_id) VALUES (?, ?)').run('conv-new', proposal.characterId);
      if (related === 'memory') ctx.db.prepare('INSERT INTO memories (id, character_id, category, content) VALUES (?, ?, ?, ?)').run('memory-new', proposal.characterId, '偏好习惯', '喜欢雨');
      if (related === 'session') createAgentSession(ctx.db, { character_id: proposal.characterId }, T2);
      if (related === 'future-table') {
        ctx.db.exec('CREATE TABLE future_character_data (character_id TEXT, value TEXT)');
        ctx.db.prepare('INSERT INTO future_character_data VALUES (?, ?)').run(proposal.characterId, '后续数据');
      }
      const before = characters(ctx.db);
      const outcome = undoProposalItem(ctx.db, proposal.id, proposal.itemId, T2);
      assert.equal(outcome.status, 409);
      assert.match(outcome.error, /关联/);
      assert.deepEqual(characters(ctx.db), before);
      assert.deepEqual(ctx.db.pragma('foreign_key_check'), []);
    });
  }
});

test('预分配 ID 被占用时创建项过期，不修改已有角色', t => {
  const ctx = setup(t);
  const proposal = propose(ctx);
  ctx.db.prepare('INSERT INTO characters (id, name) VALUES (?, ?)').run(proposal.characterId, '已有角色');
  const before = characters(ctx.db);
  assert.equal(approve(ctx, proposal).items[0].state, 'stale');
  assert.deepEqual(characters(ctx.db), before);
});
