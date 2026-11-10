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
const { isCheckedByDefault, proposalItemFlags } = require('../src/lib/agent/proposal-flags.ts');
const { createAgentSession, appendAgentMessage } = require('../src/lib/agent/store.ts');
const { estimateTokens } = require('../src/lib/token-counter.ts');

const T0 = '2026-11-01T00:00:00.000Z';
const T1 = '2026-11-01T00:01:00.000Z';
const T2 = '2026-11-01T00:02:00.000Z';
const ORIGINAL = '今天去了海边。\n「下次再一起来吧。」';
const ATTACHMENTS = [{ type: 'text', name: 'note.txt', data: '附件正文', mimeType: 'text/plain' }];
const EDITED = '今天去了湖边。\n「下次再一起来吧。」';

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
  insert(db, 'characters', { id: 'char-a', name: '星野' });
  insert(db, 'characters', { id: 'char-b', name: '白砂' });
  insert(db, 'conversations', { id: 'conv-a', character_id: 'char-a' });
  insert(db, 'conversations', { id: 'conv-b', character_id: 'char-b' });
  insert(db, 'messages', {
    id: 'msg-reply-abcdefgh', conversation_id: 'conv-a', role: 'assistant', content: ORIGINAL, token_count: 9999,
    created_at: T0, seq: 2,
    metadata: JSON.stringify({ versions: [{ content: '旧版本', token_count: 3 }, { content: ORIGINAL, token_count: 9999 }], activeVersion: 1, keep: 'me', attachments: ATTACHMENTS }),
  });
  insert(db, 'messages', { id: 'msg-user-abcdefgh', conversation_id: 'conv-a', role: 'user', content: '我们去了哪里？', created_at: T0, seq: 1 });
  insert(db, 'messages', { id: 'msg-system-abcdefgh', conversation_id: 'conv-a', role: 'system', content: '系统消息', created_at: T0, seq: 3 });
  insert(db, 'messages', { id: 'msg-other-abcdefgh', conversation_id: 'conv-b', role: 'user', content: '其他角色的消息', created_at: T0, seq: 1 });
  insert(db, 'memories', { id: 'memory-a', character_id: 'char-a', category: '偏好习惯', content: '去过海边', source_msg_ids: '["msg-reply-abcdefgh"]' });
  const session = createAgentSession(db, { character_id: 'char-a', conversation_id: 'conv-a' }, T0);
  appendAgentMessage(db, session.id, { role: 'user', content: '把那条回复里的海边改成湖边。' }, T0);
  return { db, sessionId: session.id, settings: DEFAULT_SETTINGS };
}

function message(db, id = 'msg-reply-abcdefgh') { return db.prepare('SELECT * FROM messages WHERE id = ?').get(id); }
function untouched(db) {
  return JSON.stringify([
    db.prepare("SELECT * FROM messages WHERE id != 'msg-reply-abcdefgh' ORDER BY rowid").all(),
    ...['conversations', 'characters', 'memories', 'memory_revisions'].map(table => db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()),
  ]);
}
function entry(extra = {}) {
  return {
    message_id: 'msg-reply-abcdefgh', content: EDITED, reason: '主人要求改成湖边', confidence: 0.9,
    evidence: { owner_quote: '把那条回复里的海边改成湖边' }, ...extra,
  };
}
function call(ctx, items, summary = '修正地点') {
  const tool = AGENT_TOOLS.find(candidate => candidate.name === 'create_message_proposal');
  assert.ok(tool, 'Agent 缺少 create_message_proposal 工具');
  const parsed = parseToolArguments(tool, JSON.stringify({ summary, items }));
  if (!parsed.ok) return { parseError: parsed.error };
  return tool.execute(parsed.args, ctx);
}
function propose(ctx, items = [entry()]) {
  const outcome = call(ctx, items);
  assert.equal(outcome.parseError, undefined, outcome.parseError);
  assert.equal(outcome.result.ok, true, outcome.result.error);
  assert.equal(outcome.terminate, true, '提案生成后应结束本轮，等待批准');
  const view = getProposalView(ctx.db, outcome.result.proposal_id);
  return { view, id: view.id, itemId: view.items[0].id, result: outcome.result };
}
function approve(ctx, proposal, itemIds = [proposal.itemId]) {
  return applyProposalDecision(ctx.db, proposal.id, { action: 'apply', approved_item_ids: itemIds, rejected_items: [] }, T1);
}

test('创建消息修改提案只保存修改前后，不改消息', t => {
  const ctx = setup(t);
  const before = message(ctx.db);
  const related = untouched(ctx.db);
  const proposal = propose(ctx);
  assert.equal(proposal.view.character_id, 'char-a');
  assert.equal(proposal.view.items[0].op, 'update');
  assert.deepEqual(proposal.view.items[0].before, {
    message: { id: 'msg-reply-abcdefgh', conversation_id: 'conv-a', role: 'assistant', content: ORIGINAL },
  });
  assert.deepEqual(proposal.view.items[0].after, { content: EDITED });
  assert.deepEqual(message(ctx.db), before);
  assert.equal(untouched(ctx.db), related);
  assert.equal(listProposalViews(ctx.db, 'char-a', 20, 0).proposals[0].id, proposal.id);
});

test('批准后改正文、重算 token 并同步激活版本，撤销原样恢复', t => {
  const ctx = setup(t);
  const related = untouched(ctx.db);
  const proposal = propose(ctx);
  const applied = approve(ctx, proposal);
  assert.equal(applied.ok, true, applied.error);
  assert.equal(applied.items[0].state, 'applied');
  const after = message(ctx.db);
  const meta = JSON.parse(after.metadata);
  assert.equal(after.content, EDITED);
  assert.notEqual(after.token_count, 9999);
  assert.equal(after.token_count, meta.versions[1].token_count);
  assert.ok(after.token_count >= estimateTokens(EDITED));
  assert.deepEqual(meta.versions[0], { content: '旧版本', token_count: 3 });
  assert.equal(meta.versions[1].content, EDITED);
  assert.equal(meta.activeVersion, 1);
  assert.equal(meta.keep, 'me');
  assert.deepEqual(meta.attachments, ATTACHMENTS);
  assert.equal(untouched(ctx.db), related);
  assert.deepEqual(getProposalView(ctx.db, proposal.id).items[0].result.message, { id: 'msg-reply-abcdefgh', content: EDITED });

  const undone = undoProposalItem(ctx.db, proposal.id, proposal.itemId, T2);
  assert.equal(undone.ok, true, undone.error);
  const restored = message(ctx.db);
  assert.equal(restored.content, ORIGINAL);
  assert.equal(JSON.parse(restored.metadata).versions[1].content, ORIGINAL);
  assert.deepEqual(JSON.parse(restored.metadata).attachments, ATTACHMENTS);
  assert.equal(untouched(ctx.db), related);
  assert.equal(getProposalView(ctx.db, proposal.id).items[0].state, 'undone');
  assert.equal(undoProposalItem(ctx.db, proposal.id, proposal.itemId, T2).status, 409);
});

test('一份提案可改多条消息，逐项批准，未批准的不动', t => {
  const ctx = setup(t);
  const proposal = propose(ctx, [entry(), entry({ message_id: 'msg-user-abcdefgh', content: '我们去了哪个湖？' })]);
  const [first, second] = proposal.view.items;
  const outcome = approve(ctx, proposal, [second.id]);
  assert.deepEqual(outcome.items.map(item => item.state), ['rejected', 'applied']);
  assert.equal(message(ctx.db).content, ORIGINAL);
  assert.equal(message(ctx.db, 'msg-user-abcdefgh').content, '我们去了哪个湖？');
  assert.equal(getProposalView(ctx.db, proposal.id).items.find(item => item.id === first.id).state, 'rejected');
});

test('批准前消息已被编辑或删除时整项过期，不覆盖', async t => {
  await t.test('edited', subtest => {
    const ctx = setup(subtest);
    const proposal = propose(ctx);
    ctx.db.prepare("UPDATE messages SET content = '主人自己改过了' WHERE id = 'msg-reply-abcdefgh'").run();
    assert.equal(approve(ctx, proposal).items[0].state, 'stale');
    assert.equal(message(ctx.db).content, '主人自己改过了');
  });
  await t.test('deleted', subtest => {
    const ctx = setup(subtest);
    const proposal = propose(ctx);
    ctx.db.prepare("DELETE FROM messages WHERE id = 'msg-reply-abcdefgh'").run();
    assert.equal(approve(ctx, proposal).items[0].state, 'stale');
  });
  await t.test('moved to another character', subtest => {
    const ctx = setup(subtest);
    const proposal = propose(ctx);
    ctx.db.prepare("UPDATE messages SET conversation_id = 'conv-b' WHERE id = 'msg-reply-abcdefgh'").run();
    assert.equal(approve(ctx, proposal).items[0].state, 'stale');
    assert.equal(message(ctx.db).content, ORIGINAL);
  });
});

test('批准后消息被删除时拒绝撤销', t => {
  const ctx = setup(t);
  const proposal = propose(ctx);
  approve(ctx, proposal);
  ctx.db.prepare("DELETE FROM messages WHERE id = 'msg-reply-abcdefgh'").run();
  const outcome = undoProposalItem(ctx.db, proposal.id, proposal.itemId, T2);
  assert.equal(outcome.status, 409);
  assert.equal(getProposalView(ctx.db, proposal.id).items[0].state, 'applied');
});

test('批准后消息又被编辑时拒绝撤销并保留现状', t => {
  const ctx = setup(t);
  const proposal = propose(ctx);
  approve(ctx, proposal);
  ctx.db.prepare("UPDATE messages SET content = '后来又改了' WHERE id = 'msg-reply-abcdefgh'").run();
  const outcome = undoProposalItem(ctx.db, proposal.id, proposal.itemId, T2);
  assert.equal(outcome.ok, false);
  assert.equal(outcome.status, 409);
  assert.match(outcome.error, /消息.*改动/);
  assert.equal(message(ctx.db).content, '后来又改了');
  assert.equal(getProposalView(ctx.db, proposal.id).items[0].state, 'applied');
});

test('不合法的目标、正文或依据不创建提案', async t => {
  for (const [label, items, pattern] of [
    ['missing', [entry({ message_id: 'msg-missing-abcdefgh' })], /不存在/],
    ['system', [entry({ message_id: 'msg-system-abcdefgh' })], /只能修改用户和角色的发言/],
    ['same', [entry({ content: ORIGINAL })], /没有实际改动/],
    ['empty', [entry({ content: '  \n' })], /正文不能为空/],
    ['reason', [entry({ reason: ' ' })], /缺少理由/],
    ['evidence', [entry({ evidence: { message_ids: [] } })], /缺少依据/],
    ['quote', [entry({ evidence: { owner_quote: '主人并没有说过这句话' } })], /owner_quote/],
    ['self-evidence', [entry({ evidence: { message_ids: ['msg-reply-abcdefgh'] } })], /依据不能是被修改的消息本身/],
    ['self-evidence-prefix', [entry({ evidence: { message_ids: ['msg-reply-ab'] } })], /依据不能是被修改的消息本身/],
    ['other-evidence', [entry({ evidence: { message_ids: ['msg-other-abcdefgh'] } })], /依据消息不存在或不属于该角色/],
    ['cross-character', [entry(), entry({ message_id: 'msg-other-abcdefgh', content: '改掉', evidence: { note: '无原文依据：测试' } })], /另一个角色/],
    ['duplicate', [entry(), entry({ content: '第二次修改同一条' })], /已在第 1 项中修改/],
  ]) {
    await t.test(label, subtest => {
      const ctx = setup(subtest);
      const before = untouched(ctx.db);
      const outcome = call(ctx, items);
      assert.equal(outcome.result.ok, false);
      assert.match(outcome.result.error, pattern);
      assert.equal(outcome.terminate, undefined);
      assert.equal(ctx.db.prepare('SELECT COUNT(*) AS n FROM agent_proposals').get().n, 0);
      assert.equal(message(ctx.db).content, ORIGINAL);
      assert.equal(untouched(ctx.db), before);
    });
  }
});

test('未知字段被严格拒绝，不能借提案改角色、附件或元数据', t => {
  const ctx = setup(t);
  for (const extra of [{ role: 'user' }, { metadata: {} }, { attachments: [] }, { conversation_id: 'conv-b' }]) {
    assert.ok(call(ctx, [entry(extra)]).parseError, JSON.stringify(extra));
  }
  assert.ok(call(ctx, []).parseError);
});

test('消息 ID 与依据消息 ID 的唯一前缀会补全', t => {
  const ctx = setup(t);
  const proposal = propose(ctx, [entry({ message_id: 'msg-reply-ab', evidence: { message_ids: ['msg-user-ab'] } })]);
  assert.equal(proposal.view.items[0].before.message.id, 'msg-reply-abcdefgh');
  assert.deepEqual(proposal.view.items[0].evidence.message_ids, ['msg-user-abcdefgh']);
});

test('改台词不算丢失原话，原文已有的生僻字不标注；明显删短会标出并默认不勾选', t => {
  const ctx = setup(t);
  ctx.db.prepare("UPDATE messages SET content = ? WHERE id = 'msg-reply-abcdefgh'").run('她轻声说：「我们去饕餮楼吧。」然后牵起了你的手，慢慢走进了夜色里。');
  const rewrite = propose(ctx, [entry({ content: '她轻声说：「我们去饕餮楼吃饭吧。」然后牵起了你的手，慢慢走进了夜色里。' })]);
  assert.equal(rewrite.result.warnings, undefined);
  assert.equal(isCheckedByDefault(proposalItemFlags(rewrite.view.items[0])), true);

  const shrunk = propose(ctx, [entry({ content: '她轻声说：「走吧。」' })]);
  assert.match(shrunk.result.warnings[0], /短了/);
  const flags = proposalItemFlags(shrunk.view.items[0]);
  assert.ok(flags.shrink);
  assert.deepEqual(flags.missingQuotes, []);
  assert.equal(isCheckedByDefault(flags), false);
});
