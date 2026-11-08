const test = require('node:test');
const assert = require('node:assert/strict');
const { installMemoryOnlyTestGuard } = require('./helpers/memory-only-test-guard.cjs');

installMemoryOnlyTestGuard(test);

const Database = require('better-sqlite3');
const { NextRequest } = require('next/server');
const { registerTsLoader } = require('./helpers/register-ts-loader.cjs');

registerTsLoader();

const { __migrateForTests, __setDbForTests } = require('../src/lib/db.ts');
const { DEFAULT_SETTINGS } = require('../src/types/index.ts');
const { memoryBusinessSnapshot } = require('../src/lib/memory-mutations.ts');
const { retrieveRelevantMemories } = require('../src/lib/memory-engine.ts');
const { createMemoryProposal, createMemoryProposalSchema, NO_EVIDENCE_NOTE } = require('../src/lib/agent/proposals.ts');
const { applyProposalDecision, proposalDecisionSchema } = require('../src/lib/agent/proposal-apply.ts');
const { createAgentSession, listAgentMessages } = require('../src/lib/agent/store.ts');
const { startAgentRun, finishAgentRun } = require('../src/lib/agent/runs.ts');
const { runAgentTurn } = require('../src/lib/agent/loop.ts');
const { AGENT_TOOLS } = require('../src/lib/agent/tools/index.ts');
const proposalRoute = require('../src/app/api/agent/proposals/[id]/route.ts');

const T0 = '2026-10-01T00:00:00.000Z';
const SETTINGS = {
  ...DEFAULT_SETTINGS,
  api_base: 'http://upstream.test/v1',
  api_key: 'agent-apply-test-key',
  model: 'agent-test-model',
  streaming: false,
};

let clock = 0;
const now = () => new Date(Date.UTC(2026, 10, 3, 9, 0, 0) + (clock += 1000)).toISOString();

function insertRow(db, table, row) {
  const columns = Object.keys(row);
  db.prepare(`INSERT INTO ${table} (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`)
    .run(...columns.map(column => row[column]));
}

function addMemory(db, id, content, extra = {}) {
  insertRow(db, 'memories', {
    id,
    character_id: extra.character_id || 'char-a',
    category: extra.category || '偏好习惯',
    content,
    confidence: 0.8,
    tags: JSON.stringify(extra.tags || []),
    source_msg_ids: JSON.stringify(['msg-a1']),
    importance: 0.5,
    status: 'active',
    pinned: 0,
    usage_count: 3,
    metadata: JSON.stringify(extra.metadata || {}),
    created_at: T0,
    updated_at: T0,
  });
}

/** 全部为虚构数据。 */
function setup(t) {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  __migrateForTests(db);
  __setDbForTests(db);
  t.after(() => {
    __setDbForTests(null);
    db.close();
  });

  insertRow(db, 'characters', { id: 'char-a', name: '星野' });
  insertRow(db, 'characters', { id: 'char-b', name: '白砂' });
  insertRow(db, 'conversations', { id: 'conv-a', character_id: 'char-a', title: '午后' });
  insertRow(db, 'messages', { id: 'msg-a1', conversation_id: 'conv-a', role: 'user', content: '我最近在学做蛋糕', created_at: T0 });
  insertRow(db, 'messages', { id: 'msg-a2', conversation_id: 'conv-a', role: 'user', content: '其实我挺爱吃甜的', created_at: T0 });

  addMemory(db, 'm-tea', '主人喜欢喝无糖乌龙茶', { tags: ['饮品'] });
  addMemory(db, 'm-sweet', '主人不爱吃甜');
  addMemory(db, 'm-bake', '主人最近迷上做甜点', { category: '话题历史' });
  addMemory(db, 'm-cat1', '主人养了一只橘猫');
  addMemory(db, 'm-cat2', '主人家里有只橘色的猫');
  addMemory(db, 'm-walk1', '和主人在河边散步');
  addMemory(db, 'm-walk2', '和主人去公园散步');
  addMemory(db, 'm-other', '白砂的记忆', { character_id: 'char-b' });

  insertRow(db, 'memory_extraction_candidates', {
    id: 1, task_id: 11, character_id: 'char-a', conversation_id: 'conv-a', raw_response: '{bad', status: 'repairable',
    created_at: T0, updated_at: T0,
  });

  const session = createAgentSession(db, { character_id: 'char-a', conversation_id: 'conv-a' }, now());
  return { db, sessionId: session.id };
}

const evidence = { message_ids: ['msg-a1'] };

function item(op, rest = {}) {
  return { op, reason: `${op} 的理由`, confidence: 0.8, ...rest };
}

function propose(ctx, items, characterId = 'char-a') {
  const input = createMemoryProposalSchema.parse({ character_id: characterId, summary: '整理记忆', items });
  const outcome = createMemoryProposal(ctx.db, input, { sessionId: ctx.sessionId, now: now() });
  assert.equal(outcome.ok, true, outcome.errors?.join('\n'));
  return { id: outcome.proposalId, itemIds: outcome.items.map(row => row.id) };
}

function decide(ctx, proposalId, approved, rejected = []) {
  const input = proposalDecisionSchema.parse({ action: 'apply', approved_item_ids: approved, rejected_items: rejected });
  return applyProposalDecision(ctx.db, proposalId, input, now());
}

function memory(db, id) {
  return db.prepare('SELECT * FROM memories WHERE id = ?').get(id);
}

function itemRow(db, id) {
  const row = db.prepare('SELECT * FROM agent_proposal_items WHERE id = ?').get(id);
  return { ...row, result: row.result_json ? JSON.parse(row.result_json) : null };
}

function embeddingTaskIds(db) {
  return db.prepare('SELECT memory_id FROM memory_embedding_tasks ORDER BY memory_id').all().map(row => row.memory_id);
}

function revisions(db, itemId) {
  return db.prepare('SELECT * FROM memory_revisions WHERE proposal_item_id = ? ORDER BY id').all(itemId);
}

function memoryBytes(db) {
  return JSON.stringify(db.prepare('SELECT * FROM memories ORDER BY id').all());
}

test('批准来源修正只替换来源与粒度，保留完整正文和其他字段，并记录前后版本', t => {
  const ctx = setup(t);
  ctx.db.prepare("UPDATE memories SET source_msg_ids = ?, metadata = ? WHERE id = 'm-bake'")
    .run(JSON.stringify(['msg-a1', 'msg-a2']), JSON.stringify({ note: '保留备注', sourceAttribution: { granularity: 'batch', reason: 'missing_refs' } }));
  const before = memory(ctx.db, 'm-bake');
  const proposal = propose(ctx, [item('update', { memory_id: 'm-bake', fields: { source_msg_ids: ['msg-a1'] } })]);
  const outcome = decide(ctx, proposal.id, proposal.itemIds);
  assert.equal(outcome.ok, true, outcome.error);
  assert.equal(outcome.items[0].state, 'applied');
  const after = memory(ctx.db, 'm-bake');
  for (const key of Object.keys(before).filter(key => !['source_msg_ids', 'metadata', 'updated_at'].includes(key))) assert.deepEqual(after[key], before[key], key);
  assert.deepEqual(JSON.parse(after.source_msg_ids), ['msg-a1']);
  assert.deepEqual(JSON.parse(after.metadata), { note: '保留备注', sourceAttribution: { granularity: 'message' } });
  assert.deepEqual(embeddingTaskIds(ctx.db), []);
  const [revision] = revisions(ctx.db, proposal.itemIds[0]);
  assert.deepEqual(JSON.parse(revision.before_json).source_msg_ids, ['msg-a1', 'msg-a2']);
  assert.deepEqual(JSON.parse(revision.after_json).source_msg_ids, ['msg-a1']);
});

test('普通更新的 evidence 不会隐式替换来源或来源粒度', t => {
  const ctx = setup(t);
  const before = memory(ctx.db, 'm-tea');
  const proposal = propose(ctx, [item('update', { memory_id: 'm-tea', fields: { tags: ['茶'] }, evidence: { message_ids: ['msg-a2'] } })]);
  const outcome = decide(ctx, proposal.id, proposal.itemIds);
  assert.equal(outcome.items[0].state, 'applied');
  assert.equal(memory(ctx.db, 'm-tea').source_msg_ids, before.source_msg_ids);
  assert.equal(memory(ctx.db, 'm-tea').metadata, before.metadata);
});

test('批准来源修正前重新核对消息存在与角色归属，失效时整项不写入', async t => {
  for (const change of ['delete', 'move']) {
    await t.test(change, subtest => {
      const ctx = setup(subtest);
      const proposal = propose(ctx, [item('update', { memory_id: 'm-bake', fields: { source_msg_ids: ['msg-a2'], importance: 0.9 } })]);
      if (change === 'delete') ctx.db.prepare("DELETE FROM messages WHERE id = 'msg-a2'").run();
      else {
        insertRow(ctx.db, 'conversations', { id: 'conv-b', character_id: 'char-b', title: '其他角色' });
        ctx.db.prepare("UPDATE messages SET conversation_id = 'conv-b' WHERE id = 'msg-a2'").run();
      }
      const before = memoryBytes(ctx.db);
      const outcome = decide(ctx, proposal.id, proposal.itemIds);
      assert.equal(outcome.ok, true, outcome.error);
      assert.equal(outcome.items[0].state, 'stale');
      assert.equal(memoryBytes(ctx.db), before);
      assert.deepEqual(revisions(ctx.db, proposal.itemIds[0]), []);
    });
  }
});

test('批准来源修正完整保存超过一千条来源', t => {
  const ctx = setup(t);
  const sourceIds = Array.from({ length: 1025 }, (_, index) => `source-apply-${index}`);
  const insert = ctx.db.prepare('INSERT INTO messages (id, conversation_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)');
  for (const id of sourceIds) insert.run(id, 'conv-a', 'user', '共同支持一个持续事件', T0);
  const proposal = propose(ctx, [item('update', { memory_id: 'm-bake', fields: { source_msg_ids: sourceIds } })]);
  const outcome = decide(ctx, proposal.id, proposal.itemIds);
  assert.equal(outcome.items[0].state, 'applied');
  assert.deepEqual(JSON.parse(memory(ctx.db, 'm-bake').source_msg_ids), sourceIds);
});

test('partial approval applies only the checked items, records the decision and queues indexing', t => {
  const ctx = setup(t);
  const proposal = propose(ctx, [
    item('update', { memory_id: 'm-tea', fields: { content: '主人喜欢喝无糖乌龙茶，偶尔喝奶茶' }, evidence }),
    item('retire', { memory_id: 'm-sweet', evidence: { message_ids: ['msg-a2'] } }),
    item('create', { fields: { content: '主人在学做蛋糕', category: '话题历史', tags: ['甜点'] }, evidence: { message_ids: ['msg-a1', 'msg-a2'] } }),
  ]);
  const [updateId, retireId, createId] = proposal.itemIds;
  const sweetBefore = memory(ctx.db, 'm-sweet');

  const outcome = decide(ctx, proposal.id, [updateId, createId], [{ id: retireId, reason: '  这条还没过时，主人只是在学做甜点  ' }]);
  assert.equal(outcome.ok, true, outcome.error);
  assert.deepEqual(outcome.items, [
    { seq: 1, op: 'update', state: 'applied' },
    { seq: 2, op: 'retire', state: 'rejected', reason: '这条还没过时，主人只是在学做甜点' },
    { seq: 3, op: 'create', state: 'applied' },
  ]);

  assert.equal(memory(ctx.db, 'm-tea').content, '主人喜欢喝无糖乌龙茶，偶尔喝奶茶');
  assert.deepEqual(memory(ctx.db, 'm-sweet'), sweetBefore);

  const created = itemRow(ctx.db, createId);
  assert.equal(created.state, 'applied');
  assert.ok(created.applied_at);
  const createdRow = memory(ctx.db, created.result.created_memory_id);
  assert.equal(createdRow.content, '主人在学做蛋糕');
  assert.equal(createdRow.status, 'active');
  assert.deepEqual(JSON.parse(createdRow.source_msg_ids), ['msg-a1', 'msg-a2']);
  assert.deepEqual(JSON.parse(createdRow.metadata), { createdByProposalItem: createId });

  const rejected = itemRow(ctx.db, retireId);
  assert.equal(rejected.state, 'rejected');
  assert.equal(rejected.reject_reason, '这条还没过时，主人只是在学做甜点');
  assert.equal(rejected.applied_at, null);
  assert.deepEqual(revisions(ctx.db, retireId), []);

  const stored = ctx.db.prepare('SELECT status, decided_at FROM agent_proposals WHERE id = ?').get(proposal.id);
  assert.equal(stored.status, 'decided');
  assert.ok(stored.decided_at);

  // 与手动编辑一样入队：改正文的记忆和新记忆，没批准的那条不入队
  assert.deepEqual(embeddingTaskIds(ctx.db), [created.result.created_memory_id, 'm-tea'].sort());

  const event = listAgentMessages(ctx.db, ctx.sessionId).at(-1);
  assert.equal(event.role, 'event');
  assert.deepEqual(JSON.parse(event.content), { kind: 'proposal_decision', proposal_id: proposal.id, items: outcome.items });
});

test('pending items that were neither approved nor listed are rejected without a reason', t => {
  const ctx = setup(t);
  const bytes = memoryBytes(ctx.db);
  const proposal = propose(ctx, [
    item('update', { memory_id: 'm-tea', fields: { importance: 0.9 } }),
    item('retire', { memory_id: 'm-sweet', evidence }),
  ]);
  const outcome = decide(ctx, proposal.id, []);
  assert.equal(outcome.ok, true);
  assert.deepEqual(outcome.items.map(row => [row.state, row.reason]), [['rejected', undefined], ['rejected', undefined]]);
  assert.equal(memoryBytes(ctx.db), bytes);
  assert.deepEqual(embeddingTaskIds(ctx.db), []);
});

test('duplicate creates in one decision apply only the first item', t => {
  const ctx = setup(t);
  const content = '主人在学做蛋糕';
  const proposal = propose(ctx, [
    item('create', { fields: { content, category: '话题历史' }, evidence }),
    item('create', { fields: { content, category: '偏好习惯', tags: ['甜点'] }, evidence: { message_ids: ['msg-a2'] } }),
  ]);

  const outcome = decide(ctx, proposal.id, proposal.itemIds);
  assert.deepEqual(outcome.items.map(row => row.state), ['applied', 'stale']);
  const createdId = itemRow(ctx.db, proposal.itemIds[0]).result.created_memory_id;
  assert.match(outcome.items[1].reason, new RegExp(`内容相同.*${createdId}`));
  assert.equal(ctx.db.prepare("SELECT COUNT(*) AS n FROM memories WHERE content = ? AND status = 'active'").get(content).n, 1);
  assert.deepEqual(embeddingTaskIds(ctx.db), [createdId]);
  assert.deepEqual(revisions(ctx.db, proposal.itemIds[1]), []);
});

test('create rechecks active content added after proposal creation', async t => {
  for (const source of ['another proposal', 'manual addition']) {
    await t.test(source, t2 => {
      const ctx = setup(t2);
      const content = '主人在学做蛋糕';
      const create = item('create', { fields: { content, category: '话题历史' }, evidence });
      const pending = propose(ctx, [create]);
      if (source === 'another proposal') {
        const first = propose(ctx, [create]);
        assert.equal(decide(ctx, first.id, first.itemIds).items[0].state, 'applied');
      } else {
        addMemory(ctx.db, 'm-manual', content, { category: '偏好习惯' });
      }
      const bytes = memoryBytes(ctx.db);
      const indexIds = embeddingTaskIds(ctx.db);

      const outcome = decide(ctx, pending.id, pending.itemIds);
      assert.equal(outcome.items[0].state, 'stale');
      assert.match(outcome.items[0].reason, /内容相同/);
      assert.equal(memoryBytes(ctx.db), bytes);
      assert.deepEqual(embeddingTaskIds(ctx.db), indexIds);
      assert.deepEqual(revisions(ctx.db, pending.itemIds[0]), []);
    });
  }
});

test('create deduplication stays limited to exact active content in the same character', async t => {
  const content = '主人在学做蛋糕';
  const cases = [
    ['another character', content, 'char-b', 'active'],
    ['inactive memory', content, 'char-a', 'archived'],
    ['similar content', '主人最近在学做蛋糕', 'char-a', 'active'],
  ];
  for (const [name, existingContent, characterId, status] of cases) {
    await t.test(name, t2 => {
      const ctx = setup(t2);
      const proposal = propose(ctx, [item('create', { fields: { content, category: '话题历史' }, evidence })]);
      addMemory(ctx.db, 'm-later', existingContent, { character_id: characterId });
      ctx.db.prepare('UPDATE memories SET status = ? WHERE id = ?').run(status, 'm-later');
      const existing = memory(ctx.db, 'm-later');

      assert.equal(decide(ctx, proposal.id, proposal.itemIds).items[0].state, 'applied');
      assert.deepEqual(memory(ctx.db, 'm-later'), existing);
      const created = itemRow(ctx.db, proposal.itemIds[0]).result.created_memory_id;
      assert.equal(memory(ctx.db, created).content, content);
      assert.equal(memory(ctx.db, created).character_id, 'char-a');
    });
  }
});

test('the rejection reason reaches the model in the next turn', async t => {
  const ctx = setup(t);
  const proposal = propose(ctx, [
    item('update', { memory_id: 'm-tea', fields: { importance: 0.9 } }),
    item('retire', { memory_id: 'm-sweet', evidence }),
  ]);
  decide(ctx, proposal.id, [proposal.itemIds[0]], [{ id: proposal.itemIds[1], reason: '主人现在依然不爱吃甜' }]);

  const requests = [];
  const complete = async (_settings, body) => {
    requests.push(JSON.parse(JSON.stringify(body)));
    return { text: '明白了。', toolCalls: [] };
  };
  const result = await runAgentTurn({
    db: ctx.db, sessionId: ctx.sessionId, userContent: '继续', tools: AGENT_TOOLS, settings: SETTINGS, complete, now,
  });
  assert.equal(result.status, 'done');
  const userMessage = requests[0].messages.at(-1);
  assert.equal(userMessage.role, 'user');
  assert.match(userMessage.content, new RegExp(`系统记录：主人处理了提案 #${proposal.id}`));
  assert.match(userMessage.content, /第 1 项（update）：已批准并生效/);
  assert.match(userMessage.content, /第 2 项（retire）：主人拒绝，原因：主人现在依然不爱吃甜/);
  assert.match(userMessage.content, /继续$/);
});

test('stale check: business changes after the proposal skip the item, usage statistics do not', async t => {
  const cases = [
    ['only sources added', "UPDATE memories SET source_msg_ids = '[\"msg-a1\",\"msg-a2\"]' WHERE id = 'm-tea'", 'stale'],
    ['only confidence changed', "UPDATE memories SET confidence = 0.95 WHERE id = 'm-tea'", 'stale'],
    ['only business metadata changed', "UPDATE memories SET metadata = '{\"note\":\"主人手动补充\"}' WHERE id = 'm-tea'", 'stale'],
    ['content edited by hand', "UPDATE memories SET content = '主人改喝红茶了' WHERE id = 'm-tea'", 'stale'],
    ['memory deleted', "DELETE FROM memories WHERE id = 'm-tea'", 'stale'],
    ['only usage statistics changed', `UPDATE memories SET usage_count = usage_count + 5, last_used_at = '${T0}', updated_at = '2026-10-30T00:00:00.000Z' WHERE id = 'm-tea'`, 'applied'],
    ['only metadata key order changed', "UPDATE memories SET metadata = '{\"b\":2,\"a\":1}' WHERE id = 'm-tea'", 'applied', "UPDATE memories SET metadata = '{\"a\":1,\"b\":2}' WHERE id = 'm-tea'"],
  ];
  for (const [name, mutation, expected, prepare] of cases) {
    await t.test(name, t2 => {
      const ctx = setup(t2);
      if (prepare) ctx.db.exec(prepare);
      const proposal = propose(ctx, [item('update', { memory_id: 'm-tea', fields: { importance: 0.9 } })]);
      ctx.db.exec(mutation);
      const mutated = memory(ctx.db, 'm-tea');

      const outcome = decide(ctx, proposal.id, proposal.itemIds);
      assert.equal(outcome.items[0].state, expected);
      const row = itemRow(ctx.db, proposal.itemIds[0]);
      assert.equal(row.state, expected);
      if (expected === 'stale') {
        // 不覆盖后来的修改
        assert.deepEqual(memory(ctx.db, 'm-tea'), mutated);
        assert.match(row.result.detail, /m-tea/);
        assert.match(outcome.items[0].reason, /m-tea 在提案生成后已被改动或删除/);
        assert.deepEqual(revisions(ctx.db, row.id), []);
      } else {
        const after = memory(ctx.db, 'm-tea');
        assert.equal(after.importance, 0.9);
        assert.equal(after.usage_count, mutated.usage_count);
        assert.equal(after.last_used_at, mutated.last_used_at);
      }
    });
  }

  await t.test('a changed merge member makes the whole merge stale', t2 => {
    const ctx = setup(t2);
    const proposal = propose(ctx, [item('merge', { memory_ids: ['m-cat1', 'm-cat2'], fields: { content: '主人养了一只橘猫' }, evidence })]);
    ctx.db.exec("UPDATE memories SET confidence = 0.99 WHERE id = 'm-cat2'");
    const bytes = memoryBytes(ctx.db);
    const outcome = decide(ctx, proposal.id, proposal.itemIds);
    assert.equal(outcome.items[0].state, 'stale');
    assert.match(outcome.items[0].reason, /m-cat2/);
    assert.doesNotMatch(outcome.items[0].reason, /m-cat1/);
    assert.equal(memoryBytes(ctx.db), bytes);
  });
});

test('retire takes the memory out of chat retrieval and keeps what undo needs', t => {
  const ctx = setup(t);
  const proposal = propose(ctx, [item('retire', { memory_id: 'm-sweet', evidence: { message_ids: ['msg-a2'] } })]);
  assert.ok(retrieveRelevantMemories('主人爱吃甜的吗', 'char-a', Infinity).some(row => row.id === 'm-sweet'));

  const outcome = decide(ctx, proposal.id, proposal.itemIds);
  assert.equal(outcome.items[0].state, 'applied');
  assert.equal(retrieveRelevantMemories('主人爱吃甜的吗', 'char-a', Infinity).some(row => row.id === 'm-sweet'), false);

  const row = memory(ctx.db, 'm-sweet');
  assert.equal(row.status, 'superseded');
  assert.deepEqual(JSON.parse(row.metadata), { previousStatus: 'active', retiredByProposalItem: proposal.itemIds[0] });
  assert.deepEqual(embeddingTaskIds(ctx.db), ['m-sweet']);

  const [revision] = revisions(ctx.db, proposal.itemIds[0]);
  assert.equal(revision.memory_id, 'm-sweet');
  assert.equal(revision.op, 'retire');
  assert.equal(revision.action, 'apply');
  assert.equal(revision.reason, 'retire 的理由');
  assert.deepEqual(JSON.parse(revision.evidence_json), { message_ids: ['msg-a2'] });
  assert.equal(JSON.parse(revision.before_json).status, 'active');
  assert.equal(JSON.parse(revision.after_json).status, 'superseded');
});

test('merge and archive reuse the library functions, queue the new row and write one revision per row', t => {
  const ctx = setup(t);
  const proposal = propose(ctx, [
    item('merge', { memory_ids: ['m-cat1', 'm-cat2'], fields: { content: '主人养了一只橘猫', tags: ['宠物'] }, evidence }),
    item('archive', { memory_ids: ['m-walk1', 'm-walk2'], fields: { content: '和主人散过几次步' }, evidence: { message_ids: [], note: NO_EVIDENCE_NOTE } }),
  ]);
  const [mergeId, archiveId] = proposal.itemIds;
  const outcome = decide(ctx, proposal.id, proposal.itemIds);
  assert.deepEqual(outcome.items.map(row => row.state), ['applied', 'applied']);

  const merge = itemRow(ctx.db, mergeId).result;
  const resultRow = memory(ctx.db, merge.created_memory_id);
  assert.equal(resultRow.content, '主人养了一只橘猫');
  assert.deepEqual(JSON.parse(resultRow.tags), ['宠物']);
  assert.equal(JSON.parse(resultRow.metadata).mergeBatchId, merge.batch_id);
  assert.deepEqual(merge.memory_ids, ['m-cat1', 'm-cat2', merge.created_memory_id]);
  for (const id of ['m-cat1', 'm-cat2']) {
    const source = memory(ctx.db, id);
    assert.equal(source.status, 'superseded');
    assert.equal(JSON.parse(source.metadata).mergedInto, merge.created_memory_id);
  }

  const archive = itemRow(ctx.db, archiveId).result;
  const summaryRow = memory(ctx.db, archive.created_memory_id);
  assert.equal(summaryRow.content, '和主人散过几次步');
  assert.equal(JSON.parse(summaryRow.metadata).archiveRole, 'summary');
  assert.equal(JSON.parse(summaryRow.metadata).archiveBatchId, archive.batch_id);
  assert.deepEqual(['m-walk1', 'm-walk2'].map(id => memory(ctx.db, id).status), ['archived', 'archived']);

  // 与合并、归档路由一致：只给新生成的行入队
  assert.deepEqual(embeddingTaskIds(ctx.db), [merge.created_memory_id, archive.created_memory_id].sort());

  for (const [itemId, result, op] of [[mergeId, merge, 'merge'], [archiveId, archive, 'archive']]) {
    const rows = revisions(ctx.db, itemId);
    assert.deepEqual(rows.map(row => row.memory_id), result.memory_ids);
    assert.ok(rows.every(row => row.op === op && row.action === 'apply' && row.reason === `${op} 的理由`));
    assert.deepEqual(rows.map(row => row.before_json === null), [false, false, true]);
    // 应用后快照与库中当前状态一致，撤销时据此判断冲突
    for (const target of result.after) {
      assert.deepEqual(target.snapshot, memoryBusinessSnapshot(memory(ctx.db, target.id)));
      assert.deepEqual(JSON.parse(rows.find(row => row.memory_id === target.id).after_json), target.snapshot);
    }
  }
  assert.deepEqual(JSON.parse(revisions(ctx.db, archiveId)[0].evidence_json), { message_ids: [], note: NO_EVIDENCE_NOTE });
});

test('discard_candidate claims the record once', async t => {
  await t.test('applies when still repairable', t2 => {
    const ctx = setup(t2);
    const proposal = propose(ctx, [item('discard_candidate', { candidate_id: 1 })]);
    assert.equal(decide(ctx, proposal.id, proposal.itemIds).items[0].state, 'applied');
    assert.equal(ctx.db.prepare('SELECT status FROM memory_extraction_candidates WHERE id = 1').get().status, 'discarded');
  });

  await t.test('is stale when the record was handled elsewhere', t2 => {
    const ctx = setup(t2);
    const proposal = propose(ctx, [item('discard_candidate', { candidate_id: 1 })]);
    ctx.db.exec("UPDATE memory_extraction_candidates SET status = 'ignored' WHERE id = 1");
    const outcome = decide(ctx, proposal.id, proposal.itemIds);
    assert.equal(outcome.items[0].state, 'stale');
    assert.equal(ctx.db.prepare('SELECT status FROM memory_extraction_candidates WHERE id = 1').get().status, 'ignored');
  });
});

test('a failing item is rolled back on its own and the other items still apply', t => {
  const ctx = setup(t);
  const proposal = propose(ctx, [
    item('create', { fields: { content: '会失败的记忆', category: '话题历史' }, evidence }),
    item('retire', { memory_id: 'm-sweet', evidence }),
  ]);
  ctx.db.exec(`
    CREATE TRIGGER fail_one_insert BEFORE INSERT ON memories WHEN NEW.content = '会失败的记忆'
    BEGIN SELECT RAISE(ABORT, 'forced failure'); END;
  `);
  const outcome = decide(ctx, proposal.id, proposal.itemIds);
  assert.deepEqual(outcome.items.map(row => row.state), ['failed', 'applied']);
  assert.equal(typeof outcome.items[0].reason, 'string');
  assert.equal(ctx.db.prepare("SELECT COUNT(*) AS n FROM memories WHERE content = '会失败的记忆'").get().n, 0);
  assert.deepEqual(revisions(ctx.db, proposal.itemIds[0]), []);
  assert.equal(itemRow(ctx.db, proposal.itemIds[0]).applied_at, null);
  assert.equal(memory(ctx.db, 'm-sweet').status, 'superseded');
  assert.deepEqual(embeddingTaskIds(ctx.db), ['m-sweet']);
});

test('invalid decisions change nothing; conflict findings can never be approved', t => {
  const ctx = setup(t);
  const proposal = propose(ctx, [
    item('update', { memory_id: 'm-tea', fields: { importance: 0.9 } }),
    item('report_conflict', { memory_ids: ['m-sweet', 'm-bake'], evidence }),
  ]);
  const other = propose(ctx, [item('retire', { memory_id: 'm-cat1', evidence })]);
  const [updateId, conflictId] = proposal.itemIds;
  const bytes = memoryBytes(ctx.db);
  const messageCount = listAgentMessages(ctx.db, ctx.sessionId).length;

  const invalid = [
    [[conflictId], [], 400, /第 2 项是矛盾发现，只作记录，不能批准/],
    [[], [{ id: conflictId, reason: '不要' }], 400, /不能拒绝/],
    [[other.itemIds[0]], [], 400, /不属于这份提案/],
    [[updateId], [{ id: updateId }], 400, /不能同时批准和拒绝/],
  ];
  for (const [approved, rejected, status, error] of invalid) {
    const outcome = decide(ctx, proposal.id, approved, rejected);
    assert.equal(outcome.ok, false);
    assert.equal(outcome.status, status);
    assert.match(outcome.error, error);
  }
  assert.deepEqual(decide(ctx, 9999, []), { ok: false, status: 404, error: '提案不存在' });

  assert.equal(memoryBytes(ctx.db), bytes);
  assert.equal(listAgentMessages(ctx.db, ctx.sessionId).length, messageCount);
  assert.equal(ctx.db.prepare('SELECT status FROM agent_proposals WHERE id = ?').get(proposal.id).status, 'pending');
  assert.deepEqual([updateId, conflictId].map(id => itemRow(ctx.db, id).state), ['pending', 'reported']);

  const outcome = decide(ctx, proposal.id, [updateId]);
  assert.deepEqual(outcome.items, [{ seq: 1, op: 'update', state: 'applied' }]);
  assert.equal(itemRow(ctx.db, conflictId).state, 'reported');
  assert.deepEqual(decide(ctx, proposal.id, [updateId]), { ok: false, status: 409, error: '这份提案已经处理过' });

  const conflictOnly = propose(ctx, [item('report_conflict', { memory_ids: ['m-cat2', 'm-walk1'], evidence })]);
  assert.equal(decide(ctx, conflictOnly.id, conflictOnly.itemIds).status, 409);
});

test('deleting the character removes its proposals and revisions', t => {
  const ctx = setup(t);
  const proposal = propose(ctx, [item('retire', { memory_id: 'm-sweet', evidence })]);
  decide(ctx, proposal.id, proposal.itemIds);
  assert.equal(ctx.db.prepare('SELECT COUNT(*) AS n FROM memory_revisions').get().n, 1);

  ctx.db.prepare("DELETE FROM characters WHERE id = 'char-a'").run();
  for (const table of ['agent_proposals', 'agent_proposal_items', 'memory_revisions']) {
    assert.equal(ctx.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n, 0, table);
  }
});

function jsonRequest(path, method, body) {
  return new NextRequest(`http://test.local${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function routeContext(id) {
  return { params: Promise.resolve({ id: String(id) }) };
}

test('proposal route: view, validation, busy session and apply', async t => {
  const ctx = setup(t);
  const proposal = propose(ctx, [
    item('update', { memory_id: 'm-tea', fields: { importance: 0.9 } }),
    item('report_conflict', { memory_ids: ['m-sweet', 'm-bake'], evidence }),
  ]);
  const path = `/api/agent/proposals/${proposal.id}`;

  for (const id of ['abc', '0', '9999']) {
    assert.equal((await proposalRoute.GET(jsonRequest(`/api/agent/proposals/${id}`, 'GET'), routeContext(id))).status, 404);
  }
  const view = await (await proposalRoute.GET(jsonRequest(path, 'GET'), routeContext(proposal.id))).json();
  assert.equal(view.status, 'pending');
  assert.equal(view.items[0].before.memories[0].snapshot.importance, 0.5);
  assert.deepEqual(view.items[0].after, { importance: 0.9 });
  assert.deepEqual(view.items.map(row => row.state), ['pending', 'reported']);

  const invalid = await proposalRoute.POST(jsonRequest(path, 'POST', { action: 'apply', approved_item_ids: ['x'] }), routeContext(proposal.id));
  assert.equal(invalid.status, 400);
  assert.ok((await invalid.json()).fieldErrors);
  const conflict = await proposalRoute.POST(jsonRequest(path, 'POST', { action: 'apply', approved_item_ids: [proposal.itemIds[1]] }), routeContext(proposal.id));
  assert.equal(conflict.status, 400);

  const controller = startAgentRun(ctx.sessionId);
  try {
    const busy = await proposalRoute.POST(jsonRequest(path, 'POST', { action: 'apply', approved_item_ids: [proposal.itemIds[0]] }), routeContext(proposal.id));
    assert.equal(busy.status, 409);
    assert.equal((await busy.json()).code, 'agent_busy');
  } finally {
    finishAgentRun(ctx.sessionId, controller);
  }
  assert.equal(memory(ctx.db, 'm-tea').importance, 0.5);

  const applied = await proposalRoute.POST(jsonRequest(path, 'POST', { action: 'apply', approved_item_ids: [proposal.itemIds[0]] }), routeContext(proposal.id));
  assert.equal(applied.status, 200);
  const decided = await applied.json();
  assert.equal(decided.status, 'decided');
  assert.deepEqual(decided.items.map(row => row.state), ['applied', 'reported']);
  assert.equal(decided.items[0].result.memory_ids[0], 'm-tea');
  assert.equal(memory(ctx.db, 'm-tea').importance, 0.9);

  const again = await proposalRoute.POST(jsonRequest(path, 'POST', { action: 'apply', approved_item_ids: [] }), routeContext(proposal.id));
  assert.equal(again.status, 409);
});
