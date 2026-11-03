const test = require('node:test');
const assert = require('node:assert/strict');
const { installMemoryOnlyTestGuard } = require('./helpers/memory-only-test-guard.cjs');

installMemoryOnlyTestGuard(test);

const Database = require('better-sqlite3');
const { NextRequest } = require('next/server');
const { registerTsLoader } = require('./helpers/register-ts-loader.cjs');

registerTsLoader();

const { __migrateForTests, __setDbForTests } = require('../src/lib/db.ts');
const { memoryBusinessSnapshot } = require('../src/lib/memory-mutations.ts');
const { retrieveRelevantMemories } = require('../src/lib/memory-engine.ts');
const { applyMemoryUpdate } = require('../src/lib/memory-mutations.ts');
const {
  buildMemoryEmbeddingText,
  clearMemoryIndex,
  enqueueRebuildMemoryEmbeddings,
  fakeEmbeddingForText,
  hashEmbeddingText,
  loadReadyMemoryEmbeddings,
  upsertMemoryEmbedding,
} = require('../src/lib/memory-embeddings.ts');
const { executeMemorySummaryArchive } = require('../src/lib/memory-archive.ts');
const { createMemoryProposal, createMemoryProposalSchema } = require('../src/lib/agent/proposals.ts');
const { applyProposalDecision, proposalDecisionSchema, undoProposalItem } = require('../src/lib/agent/proposal-apply.ts');
const { createAgentSession } = require('../src/lib/agent/store.ts');
const { startAgentRun, finishAgentRun } = require('../src/lib/agent/runs.ts');
const proposalRoute = require('../src/app/api/agent/proposals/[id]/route.ts');

const T0 = '2026-10-01T00:00:00.000Z';

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
    character_id: 'char-a',
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
  insertRow(db, 'conversations', { id: 'conv-a', character_id: 'char-a', title: '午后' });
  insertRow(db, 'messages', { id: 'msg-a1', conversation_id: 'conv-a', role: 'user', content: '我最近在学做蛋糕', created_at: T0 });
  insertRow(db, 'messages', { id: 'msg-a2', conversation_id: 'conv-a', role: 'user', content: '其实我挺爱吃甜的', created_at: T0 });

  addMemory(db, 'm-tea', '主人喜欢喝无糖乌龙茶', { tags: ['饮品'], metadata: { note: '原有备注' } });
  addMemory(db, 'm-sweet', '主人不爱吃甜', { metadata: { origin: 'chat' } });
  addMemory(db, 'm-cat1', '主人养了一只橘猫');
  addMemory(db, 'm-cat2', '主人家里有只橘色的猫');
  addMemory(db, 'm-walk1', '和主人在河边散步');
  addMemory(db, 'm-walk2', '和主人去公园散步');
  addMemory(db, 'm-rain', '主人喜欢下雨天');

  const session = createAgentSession(db, { character_id: 'char-a', conversation_id: 'conv-a' }, now());
  return { db, sessionId: session.id };
}

const evidence = { message_ids: ['msg-a1'] };

function item(op, rest = {}) {
  return { op, reason: `${op} 的理由`, confidence: 0.8, evidence, ...rest };
}

/** 生成并全部批准，返回各项 id 与应用结果。 */
function proposeAndApply(ctx, items) {
  const input = createMemoryProposalSchema.parse({ character_id: 'char-a', summary: '整理记忆', items });
  const created = createMemoryProposal(ctx.db, input, { sessionId: ctx.sessionId, now: now() });
  assert.equal(created.ok, true, created.errors?.join('\n'));
  const itemIds = created.items.map(row => row.id);
  const decision = proposalDecisionSchema.parse({ action: 'apply', approved_item_ids: itemIds });
  const outcome = applyProposalDecision(ctx.db, created.proposalId, decision, now());
  assert.equal(outcome.ok, true, outcome.error);
  assert.ok(outcome.items.every(row => row.state === 'applied'), JSON.stringify(outcome.items));
  return { id: created.proposalId, itemIds, results: itemIds.map(id => itemRow(ctx.db, id).result) };
}

function undo(ctx, proposalId, itemId) {
  return undoProposalItem(ctx.db, proposalId, itemId, now());
}

function memory(db, id) {
  return db.prepare('SELECT * FROM memories WHERE id = ?').get(id);
}

function snapshot(db, id) {
  return memoryBusinessSnapshot(memory(db, id));
}

function itemRow(db, id) {
  const row = db.prepare('SELECT * FROM agent_proposal_items WHERE id = ?').get(id);
  return { ...row, result: row.result_json ? JSON.parse(row.result_json) : null };
}

function undoRevisions(db, itemId) {
  return db.prepare("SELECT * FROM memory_revisions WHERE proposal_item_id = ? AND action = 'undo' ORDER BY id").all(itemId);
}

function embeddingTaskIds(db) {
  return db.prepare('SELECT memory_id FROM memory_embedding_tasks ORDER BY memory_id').all().map(row => row.memory_id);
}

/** 数据库里与撤销相关的全部状态：记忆、提案项、修订记录、消息。 */
function stateBytes(db) {
  return JSON.stringify([
    db.prepare('SELECT * FROM memories ORDER BY id').all(),
    db.prepare('SELECT * FROM agent_proposal_items ORDER BY id').all(),
    db.prepare('SELECT * FROM memory_revisions ORDER BY id').all(),
    db.prepare('SELECT * FROM messages ORDER BY id').all(),
  ]);
}

function otherRowsBytes(db, excluded) {
  return JSON.stringify(db.prepare('SELECT * FROM memories ORDER BY id').all().filter(row => !excluded.includes(row.id)));
}

/** 撤销被拒绝：返回 409、原因点名记忆，且数据库一个字节都没变。 */
function assertUndoRejected(ctx, proposalId, itemId, pattern) {
  const bytes = stateBytes(ctx.db);
  const outcome = undo(ctx, proposalId, itemId);
  assert.equal(outcome.ok, false);
  assert.equal(outcome.status, 409);
  assert.match(outcome.error, pattern);
  assert.equal(stateBytes(ctx.db), bytes);
  assert.equal(itemRow(ctx.db, itemId).state, 'applied');
}

test('undo update restores only the changed fields and leaves later chat and memories alone', t => {
  const ctx = setup(t);
  const original = snapshot(ctx.db, 'm-tea');
  const proposal = proposeAndApply(ctx, [
    item('update', { memory_id: 'm-tea', fields: { content: '主人喜欢喝乌龙茶，偶尔喝奶茶', tags: ['饮品', '奶茶'], importance: 0.9 } }),
  ]);
  const [itemId] = proposal.itemIds;
  const applied = snapshot(ctx.db, 'm-tea');
  assert.equal(applied.content, '主人喜欢喝乌龙茶，偶尔喝奶茶');

  // 批准之后的聊天和新记忆
  insertRow(ctx.db, 'messages', { id: 'msg-a3', conversation_id: 'conv-a', role: 'user', content: '今天去了奶茶店', created_at: now() });
  addMemory(ctx.db, 'm-later', '主人今天去了奶茶店');
  const messages = JSON.stringify(ctx.db.prepare('SELECT * FROM messages ORDER BY id').all());
  const others = otherRowsBytes(ctx.db, ['m-tea']);
  ctx.db.exec('DELETE FROM memory_embedding_tasks');

  const outcome = undo(ctx, proposal.id, itemId);
  assert.deepEqual(outcome, { ok: true });
  assert.deepEqual(snapshot(ctx.db, 'm-tea'), original);
  assert.equal(JSON.stringify(ctx.db.prepare('SELECT * FROM messages ORDER BY id').all()), messages);
  assert.equal(otherRowsBytes(ctx.db, ['m-tea']), others);
  // 索引同步：与手动编辑一样入队重建
  assert.deepEqual(embeddingTaskIds(ctx.db), ['m-tea']);

  const row = itemRow(ctx.db, itemId);
  assert.equal(row.state, 'undone');
  assert.ok(row.result.undone_at);
  assert.deepEqual(row.result.memory_ids, ['m-tea']);
  const [revision] = undoRevisions(ctx.db, itemId);
  assert.equal(revision.memory_id, 'm-tea');
  assert.equal(revision.op, 'update');
  assert.equal(revision.reason, 'update 的理由');
  assert.deepEqual(JSON.parse(revision.evidence_json), evidence);
  assert.deepEqual(JSON.parse(revision.before_json), applied);
  assert.deepEqual(JSON.parse(revision.after_json), original);
});

test('undo retire brings the memory back into chat retrieval with its old status and metadata', t => {
  const ctx = setup(t);
  const original = snapshot(ctx.db, 'm-sweet');
  const proposal = proposeAndApply(ctx, [item('retire', { memory_id: 'm-sweet' })]);
  assert.equal(retrieveRelevantMemories('主人爱吃甜的吗', 'char-a', Infinity).some(row => row.id === 'm-sweet'), false);
  ctx.db.exec('DELETE FROM memory_embedding_tasks');

  assert.deepEqual(undo(ctx, proposal.id, proposal.itemIds[0]), { ok: true });
  assert.deepEqual(snapshot(ctx.db, 'm-sweet'), original);
  assert.deepEqual(JSON.parse(memory(ctx.db, 'm-sweet').metadata), { origin: 'chat' });
  assert.ok(retrieveRelevantMemories('主人爱吃甜的吗', 'char-a', Infinity).some(row => row.id === 'm-sweet'));
  assert.deepEqual(embeddingTaskIds(ctx.db), ['m-sweet']);
});

test('undo create deletes the row, its index tasks and keeps the history', t => {
  const ctx = setup(t);
  const proposal = proposeAndApply(ctx, [item('create', { fields: { content: '主人在学做蛋糕', category: '话题历史' } })]);
  const createdId = proposal.results[0].created_memory_id;
  assert.ok(memory(ctx.db, createdId));
  assert.deepEqual(embeddingTaskIds(ctx.db), [createdId]);
  const others = otherRowsBytes(ctx.db, [createdId]);

  assert.deepEqual(undo(ctx, proposal.id, proposal.itemIds[0]), { ok: true });
  assert.equal(memory(ctx.db, createdId), undefined);
  assert.deepEqual(embeddingTaskIds(ctx.db), []);
  assert.equal(otherRowsBytes(ctx.db, []), others);

  const [revision] = undoRevisions(ctx.db, proposal.itemIds[0]);
  assert.equal(revision.memory_id, createdId);
  assert.equal(JSON.parse(revision.before_json).content, '主人在学做蛋糕');
  assert.equal(revision.after_json, null);
  // 应用时那条修订仍在，记忆删除后历史可查
  assert.equal(ctx.db.prepare("SELECT COUNT(*) AS n FROM memory_revisions WHERE memory_id = ? AND action = 'apply'").get(createdId).n, 1);
});

test('undo merge and archive restore every member and remove the generated row', t => {
  const ctx = setup(t);
  const members = ['m-cat1', 'm-cat2', 'm-walk1', 'm-walk2'];
  const originals = Object.fromEntries(members.map(id => [id, snapshot(ctx.db, id)]));
  const proposal = proposeAndApply(ctx, [
    item('merge', { memory_ids: ['m-cat1', 'm-cat2'], fields: { content: '主人养了一只橘猫' } }),
    item('archive', { memory_ids: ['m-walk1', 'm-walk2'], fields: { content: '和主人散过几次步' } }),
  ]);
  const [merge, archive] = proposal.results;
  const others = otherRowsBytes(ctx.db, [...members, merge.created_memory_id, archive.created_memory_id]);

  for (const [index, result] of [[0, merge], [1, archive]]) {
    const itemId = proposal.itemIds[index];
    assert.deepEqual(undo(ctx, proposal.id, itemId), { ok: true });
    assert.equal(memory(ctx.db, result.created_memory_id), undefined);
    for (const id of result.memory_ids.filter(id => id !== result.created_memory_id)) {
      assert.deepEqual(snapshot(ctx.db, id), originals[id]);
    }
    const rows = undoRevisions(ctx.db, itemId);
    assert.deepEqual(rows.map(row => row.memory_id), result.memory_ids);
    assert.deepEqual(rows.map(row => row.after_json === null), [false, false, true]);
    assert.equal(itemRow(ctx.db, itemId).state, 'undone');
  }
  assert.equal(otherRowsBytes(ctx.db, [...members]), others);
});

test('undo merge and archive restores pre-existing lifecycle metadata and preserves newer usage', async t => {
  const ctx = setup(t);
  const cases = [
    { op: 'merge', ids: ['m-cat1', 'm-cat2'], fields: { content: '主人养了一只橘猫' } },
    { op: 'archive', ids: ['m-walk1', 'm-walk2'], fields: { content: '和主人散过几次步' } },
  ];

  for (const scenario of cases) await t.test(scenario.op, t2 => {
    const originals = {};
    for (const [index, id] of scenario.ids.entries()) {
      const metadata = { prior_note: `${id} 的历史备注`, previousStatus: 'active', supersededBy: `old-${id}` };
      assert.equal(applyMemoryUpdate(ctx.db, id, { status: 'superseded', metadata }, now()), 'updated');
      assert.equal(applyMemoryUpdate(ctx.db, id, { status: 'active' }, now()), 'updated');
      originals[id] = snapshot(ctx.db, id);
      ctx.db.prepare('UPDATE memories SET usage_count = ?, last_used_at = ? WHERE id = ?')
        .run(20 + index, `2026-11-03T10:0${index}:00.000Z`, id);
      ctx.db.prepare('DELETE FROM memory_embedding_tasks WHERE memory_id = ?').run(id);
    }
    const proposal = proposeAndApply(ctx, [item(scenario.op, {
      memory_ids: scenario.ids,
      fields: scenario.fields,
    })]);
    const result = proposal.results[0];
    const usage = Object.fromEntries(scenario.ids.map(id => {
      const row = memory(ctx.db, id);
      return [id, { usage_count: row.usage_count, last_used_at: row.last_used_at }];
    }));

    assert.deepEqual(undo(ctx, proposal.id, proposal.itemIds[0]), { ok: true });
    for (const id of scenario.ids) {
      assert.deepEqual(snapshot(ctx.db, id), originals[id], `${scenario.op} restores ${id}'s full business snapshot`);
      assert.equal(memory(ctx.db, id).usage_count, usage[id].usage_count);
      assert.equal(memory(ctx.db, id).last_used_at, usage[id].last_used_at);
    }
    assert.equal(memory(ctx.db, result.created_memory_id), undefined);
  });
});

test('undo merge and archive requeues restored members after a cleared index rebuild', async t => {
  const ctx = setup(t);
  const cases = [
    { op: 'merge', ids: ['m-cat1', 'm-cat2'], fields: { content: '主人养了一只橘猫' } },
    { op: 'archive', ids: ['m-walk1', 'm-walk2'], fields: { content: '和主人散过几次步' } },
  ];

  for (const scenario of cases) await t.test(scenario.op, t2 => {
    clearMemoryIndex('char-a', ctx.db);
    const proposal = proposeAndApply(ctx, [item(scenario.op, {
      memory_ids: scenario.ids,
      fields: scenario.fields,
    })]);
    const resultId = proposal.results[0].created_memory_id;

    clearMemoryIndex('char-a', ctx.db);
    enqueueRebuildMemoryEmbeddings('char-a', ctx.db);
    assert.ok(embeddingTaskIds(ctx.db).includes(resultId));
    for (const id of scenario.ids) assert.equal(embeddingTaskIds(ctx.db).includes(id), false);

    // 模拟虚构上游完成当前 active 集的向量构建。
    const active = ctx.db.prepare("SELECT * FROM memories WHERE character_id = 'char-a' AND status = 'active'").all();
    for (const row of active) {
      const text = buildMemoryEmbeddingText({ ...row, tags: JSON.parse(row.tags) });
      upsertMemoryEmbedding({
        memoryId: row.id,
        characterId: row.character_id,
        provider: 'fake-provider',
        model: 'fake-model',
        embedding: fakeEmbeddingForText(text),
        embeddingTextHash: hashEmbeddingText(text),
        db: ctx.db,
      });
    }
    ctx.db.exec('DELETE FROM memory_embedding_tasks');

    assert.deepEqual(undo(ctx, proposal.id, proposal.itemIds[0]), { ok: true });
    assert.deepEqual(embeddingTaskIds(ctx.db), [...scenario.ids].sort());
    assert.equal(embeddingTaskIds(ctx.db).includes(resultId), false);

    for (const id of scenario.ids) {
      const row = memory(ctx.db, id);
      const text = buildMemoryEmbeddingText({ ...row, tags: JSON.parse(row.tags) });
      upsertMemoryEmbedding({
        memoryId: id,
        characterId: row.character_id,
        provider: 'fake-provider',
        model: 'fake-model',
        embedding: fakeEmbeddingForText(text),
        embeddingTextHash: hashEmbeddingText(text),
        db: ctx.db,
      });
    }
    const ready = loadReadyMemoryEmbeddings('char-a', {
      provider: 'fake-provider', model: 'fake-model', db: ctx.db,
    });
    for (const id of scenario.ids) assert.ok(ready.some(row => row.memory_id === id), `${scenario.op} recalls ${id}`);
    assert.equal(ready.some(row => row.memory_id === resultId), false);
  });
});

test('merge undo is refused once the batch changed after approval', async t => {
  const cases = [
    ['result corrected by hand', result => `UPDATE memories SET content = '主人养了两只橘猫' WHERE id = '${result.created_memory_id}'`, 'result'],
    ['member changed', () => "UPDATE memories SET content = '主人养过一只橘猫' WHERE id = 'm-cat2'", /m-cat2/],
    ['member deleted', () => "DELETE FROM memories WHERE id = 'm-cat1'", /m-cat1/],
  ];
  for (const [name, mutation, expected] of cases) {
    await t.test(name, t2 => {
      const ctx = setup(t2);
      const proposal = proposeAndApply(ctx, [item('merge', { memory_ids: ['m-cat1', 'm-cat2'], fields: { content: '主人养了一只橘猫' } })]);
      const result = proposal.results[0];
      ctx.db.exec(mutation(result));
      const pattern = expected === 'result' ? new RegExp(result.created_memory_id) : expected;
      assertUndoRejected(ctx, proposal.id, proposal.itemIds[0], pattern);
    });
  }

  await t.test('result archived in a later batch', t2 => {
    const ctx = setup(t2);
    const proposal = proposeAndApply(ctx, [item('merge', { memory_ids: ['m-cat1', 'm-cat2'], fields: { content: '主人养了一只橘猫' } })]);
    const result = proposal.results[0];
    executeMemorySummaryArchive(ctx.db, {
      batchId: 'batch-later',
      characterId: 'char-a',
      summaryMemoryId: 'm-later-sum',
      summaryContent: '主人的宠物和天气偏好',
      coveredMemoryIds: [result.created_memory_id, 'm-rain'],
      now: now(),
    });
    assertUndoRejected(ctx, proposal.id, proposal.itemIds[0], new RegExp(result.created_memory_id));
  });

  await t.test('another memory joined the batch', t2 => {
    const ctx = setup(t2);
    const proposal = proposeAndApply(ctx, [item('merge', { memory_ids: ['m-cat1', 'm-cat2'], fields: { content: '主人养了一只橘猫' } })]);
    const result = proposal.results[0];
    ctx.db.prepare("UPDATE memories SET metadata = json_object('mergeBatchId', ?) WHERE id = 'm-rain'").run(result.batch_id);
    assertUndoRejected(ctx, proposal.id, proposal.itemIds[0], /m-rain 已离开或加入这次合并/);
  });
});

test('archive undo is refused once the batch changed after approval', async t => {
  const cases = [
    ['summary corrected by hand', result => `UPDATE memories SET content = '和主人散过很多次步' WHERE id = '${result.created_memory_id}'`, 'result'],
    ['member changed', () => "UPDATE memories SET source_msg_ids = '[\"msg-a1\",\"msg-a2\"]' WHERE id = 'm-walk2'", /m-walk2/],
    ['member deleted', () => "DELETE FROM memories WHERE id = 'm-walk1'", /m-walk1/],
    // 摘要不能再被合并或归档，只能被直接改写进后续批次
    ['summary taken into a later batch', result => `
      UPDATE memories SET status = 'superseded',
        metadata = json_set(metadata, '$.mergeBatchId', 'batch-later', '$.mergedInto', 'm-later')
      WHERE id = '${result.created_memory_id}'
    `, 'result'],
    ['another memory joined the batch', result => `
      UPDATE memories SET metadata = json_object('archiveBatchId', '${result.batch_id}') WHERE id = 'm-rain'
    `, /m-rain 已离开或加入这次归档/],
  ];
  for (const [name, mutation, expected] of cases) {
    await t.test(name, t2 => {
      const ctx = setup(t2);
      const proposal = proposeAndApply(ctx, [item('archive', { memory_ids: ['m-walk1', 'm-walk2'], fields: { content: '和主人散过几次步' } })]);
      const result = proposal.results[0];
      ctx.db.exec(mutation(result));
      const pattern = expected === 'result' ? new RegExp(result.created_memory_id) : expected;
      assertUndoRejected(ctx, proposal.id, proposal.itemIds[0], pattern);
    });
  }
});

test('paired check: any business change after approval blocks undo, usage statistics do not', async t => {
  const cases = [
    ['only sources added', "UPDATE memories SET source_msg_ids = '[\"msg-a1\",\"msg-a2\"]' WHERE id = 'm-tea'", 'rejected'],
    ['only confidence changed', "UPDATE memories SET confidence = 0.95 WHERE id = 'm-tea'", 'rejected'],
    ['only business metadata changed', "UPDATE memories SET metadata = '{\"note\":\"主人改了备注\"}' WHERE id = 'm-tea'", 'rejected'],
    ['only usage statistics changed', `UPDATE memories SET usage_count = usage_count + 7, last_used_at = '${T0}', updated_at = '2026-11-02T00:00:00.000Z' WHERE id = 'm-tea'`, 'undone'],
  ];
  for (const [name, mutation, expected] of cases) {
    await t.test(name, t2 => {
      const ctx = setup(t2);
      const original = snapshot(ctx.db, 'm-tea');
      const proposal = proposeAndApply(ctx, [item('update', { memory_id: 'm-tea', fields: { importance: 0.9 } })]);
      ctx.db.exec(mutation);
      const mutated = memory(ctx.db, 'm-tea');
      if (expected === 'rejected') {
        assertUndoRejected(ctx, proposal.id, proposal.itemIds[0], /m-tea 在批准后又被改动或删除/);
        return;
      }
      assert.deepEqual(undo(ctx, proposal.id, proposal.itemIds[0]), { ok: true });
      const after = memory(ctx.db, 'm-tea');
      assert.deepEqual(memoryBusinessSnapshot(after), original);
      assert.equal(after.usage_count, mutated.usage_count);
      assert.equal(after.last_used_at, mutated.last_used_at);
    });
  }

  await t.test('usage statistics on merge members do not block undo', t2 => {
    const ctx = setup(t2);
    const proposal = proposeAndApply(ctx, [item('merge', { memory_ids: ['m-cat1', 'm-cat2'], fields: { content: '主人养了一只橘猫' } })]);
    ctx.db.prepare('UPDATE memories SET usage_count = usage_count + 2, last_used_at = ? WHERE id = ?')
      .run(T0, proposal.results[0].created_memory_id);
    ctx.db.exec("UPDATE memories SET usage_count = 40 WHERE id = 'm-cat1'");
    assert.deepEqual(undo(ctx, proposal.id, proposal.itemIds[0]), { ok: true });
    assert.equal(memory(ctx.db, 'm-cat1').usage_count, 40);
    assert.equal(memory(ctx.db, 'm-cat1').status, 'active');
  });
});

test('only applied items can be undone, and only once', t => {
  const ctx = setup(t);
  const input = createMemoryProposalSchema.parse({
    character_id: 'char-a',
    summary: '整理记忆',
    items: [
      item('update', { memory_id: 'm-tea', fields: { importance: 0.9 } }),
      item('update', { memory_id: 'm-rain', fields: { importance: 0.7 } }),
      item('report_conflict', { memory_ids: ['m-sweet', 'm-tea'] }),
    ],
  });
  const created = createMemoryProposal(ctx.db, input, { sessionId: ctx.sessionId, now: now() });
  const [appliedId, rejectedId, reportedId] = created.items.map(row => row.id);

  const pending = undo(ctx, created.proposalId, appliedId);
  assert.equal(pending.status, 400);
  assert.match(pending.error, /第 1 项没有生效/);

  applyProposalDecision(ctx.db, created.proposalId, proposalDecisionSchema.parse({ action: 'apply', approved_item_ids: [appliedId] }), now());
  for (const id of [rejectedId, reportedId]) {
    const bytes = stateBytes(ctx.db);
    const outcome = undo(ctx, created.proposalId, id);
    assert.equal(outcome.status, 400);
    assert.equal(stateBytes(ctx.db), bytes);
  }
  assert.equal(undo(ctx, 9999, appliedId).status, 404);

  const other = proposeAndApply(ctx, [item('update', { memory_id: 'm-cat1', fields: { importance: 0.6 } })]);
  const foreign = undo(ctx, created.proposalId, other.itemIds[0]);
  assert.equal(foreign.status, 404);
  assert.equal(itemRow(ctx.db, other.itemIds[0]).state, 'applied');

  assert.deepEqual(undo(ctx, created.proposalId, appliedId), { ok: true });
  const bytes = stateBytes(ctx.db);
  const again = undo(ctx, created.proposalId, appliedId);
  assert.equal(again.status, 409);
  assert.match(again.error, /已经撤销过/);
  assert.equal(stateBytes(ctx.db), bytes);
});

function jsonRequest(path, body) {
  return new NextRequest(`http://test.local${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function routeContext(id) {
  return { params: Promise.resolve({ id: String(id) }) };
}

test('proposal route: undo returns the updated view and explains a refusal', async t => {
  const ctx = setup(t);
  const proposal = proposeAndApply(ctx, [
    item('update', { memory_id: 'm-tea', fields: { importance: 0.9 } }),
    item('update', { memory_id: 'm-rain', fields: { importance: 0.7 } }),
  ]);
  const path = `/api/agent/proposals/${proposal.id}`;

  const invalid = await proposalRoute.POST(jsonRequest(path, { action: 'undo' }), routeContext(proposal.id));
  assert.equal(invalid.status, 400);
  assert.ok((await invalid.json()).fieldErrors);

  ctx.db.exec("UPDATE memories SET content = '主人喜欢下雨天，也喜欢雪天' WHERE id = 'm-rain'");
  const refused = await proposalRoute.POST(jsonRequest(path, { action: 'undo', item_id: proposal.itemIds[1] }), routeContext(proposal.id));
  assert.equal(refused.status, 409);
  assert.match((await refused.json()).error, /m-rain 在批准后又被改动或删除/);

  // 撤销不写会话消息，运行中也可以撤销
  const controller = startAgentRun(ctx.sessionId);
  try {
    const undone = await proposalRoute.POST(jsonRequest(path, { action: 'undo', item_id: proposal.itemIds[0] }), routeContext(proposal.id));
    assert.equal(undone.status, 200);
    const view = await undone.json();
    assert.deepEqual(view.items.map(row => row.state), ['undone', 'applied']);
    assert.ok(view.items[0].result.undone_at);
  } finally {
    finishAgentRun(ctx.sessionId, controller);
  }
  assert.equal(memory(ctx.db, 'm-tea').importance, 0.5);
  assert.equal(memory(ctx.db, 'm-rain').importance, 0.7);
});
