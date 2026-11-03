const test = require('node:test');
const assert = require('node:assert/strict');
const { installMemoryOnlyTestGuard } = require('./helpers/memory-only-test-guard.cjs');

installMemoryOnlyTestGuard(test);

const Database = require('better-sqlite3');
const { registerTsLoader } = require('./helpers/register-ts-loader.cjs');

registerTsLoader();

const { __migrateForTests, __setDbForTests } = require('../src/lib/db.ts');
const ssrfGuard = require('../src/lib/ssrf-guard.ts');
const { loadSettings } = require('../src/lib/settings.ts');
const { extractMemories } = require('../src/lib/memory-engine.ts');
const { createMemoryProposal, createMemoryProposalSchema, getProposalView } = require('../src/lib/agent/proposals.ts');
const { applyProposalDecision, proposalDecisionSchema, undoProposalItem } = require('../src/lib/agent/proposal-apply.ts');
const { createAgentSession } = require('../src/lib/agent/store.ts');
const { createMemoryProposalTool } = require('../src/lib/agent/tools/proposal-tools.ts');

const T0 = '2026-10-01T00:00:00.000Z';

let clock = 0;
const now = () => new Date(Date.UTC(2026, 10, 3, 9, 0, 0) + (clock += 1000)).toISOString();

function insertRow(db, table, row) {
  const columns = Object.keys(row);
  db.prepare(`INSERT INTO ${table} (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`)
    .run(...columns.map(column => row[column]));
}

function addTask(db, id, messageIds, extra = {}) {
  insertRow(db, 'memory_tasks', {
    id,
    character_id: 'char-a',
    conversation_id: 'conv-a',
    message_ids: JSON.stringify(messageIds),
    status: 'failed',
    created_at: T0,
    updated_at: T0,
    ...extra,
  });
}

function addCandidate(db, id, taskId, extra = {}) {
  insertRow(db, 'memory_extraction_candidates', {
    id,
    task_id: taskId,
    character_id: 'char-a',
    conversation_id: 'conv-a',
    raw_response: '{"memories": [ 未闭合',
    status: 'repairable',
    error_reason: 'parse_or_no_valid_memory',
    created_at: T0,
    updated_at: T0,
    ...extra,
  });
}

/**
 * 全部为虚构数据。待修复记录：
 * 1 — 任务失败，消息含一条已删除的 msg-gone；2 — 任务已完成；3 — 没有任务；
 * 4 — 任务仍在处理但结果已提交；5 — 别的角色的记录。
 */
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
  insertRow(db, 'characters', { id: 'char-b', name: '月见' });
  insertRow(db, 'conversations', { id: 'conv-a', character_id: 'char-a', title: '午后' });
  insertRow(db, 'messages', { id: 'msg-a1', conversation_id: 'conv-a', role: 'user', content: '我最近在学做蛋糕', created_at: T0 });
  insertRow(db, 'messages', { id: 'msg-a2', conversation_id: 'conv-a', role: 'user', content: '周末想去海边', created_at: T0 });
  insertRow(db, 'messages', { id: 'msg-a3', conversation_id: 'conv-a', role: 'user', content: '今天下雨了', created_at: T0 });

  addTask(db, 1, ['msg-a1', 'msg-a2', 'msg-gone']);
  addTask(db, 2, ['msg-a1'], { status: 'done', result_committed: 1, result_insert_count: 2 });
  addTask(db, 4, ['msg-a1'], { status: 'processing', result_committed: 1, result_insert_count: 1 });
  addCandidate(db, 1, 1);
  addCandidate(db, 2, 2);
  addCandidate(db, 3, null);
  addCandidate(db, 4, 4);
  addCandidate(db, 5, null, { character_id: 'char-b', conversation_id: null });

  const session = createAgentSession(db, { character_id: 'char-a', conversation_id: 'conv-a' }, now());
  return { db, sessionId: session.id };
}

const BAKING = { content: '主人在学做蛋糕', category: '话题历史' };
const SEASIDE = { content: '主人周末想去海边', category: '偏好习惯', tags: ['出行'] };

function repair(candidateId, memories, rest = {}) {
  return { op: 'repair_candidate', reason: '补回解析失败的提取结果', confidence: 0.8, candidate_id: candidateId, memories, ...rest };
}

function discard(candidateId) {
  return { op: 'discard_candidate', reason: '内容没有价值', confidence: 0.8, candidate_id: candidateId };
}

function propose(ctx, items) {
  const input = createMemoryProposalSchema.parse({ character_id: 'char-a', summary: '处理待修复记录', items });
  return createMemoryProposal(ctx.db, input, { sessionId: ctx.sessionId, now: now() });
}

function proposeOk(ctx, items) {
  const created = propose(ctx, items);
  assert.equal(created.ok, true, created.errors?.join('\n'));
  return { id: created.proposalId, itemIds: created.items.map(row => row.id), items: created.items };
}

function approveAll(ctx, proposal) {
  const decision = proposalDecisionSchema.parse({ action: 'apply', approved_item_ids: proposal.itemIds });
  const outcome = applyProposalDecision(ctx.db, proposal.id, decision, now());
  assert.equal(outcome.ok, true, outcome.error);
  return outcome;
}

function proposeAndApply(ctx, items) {
  const proposal = proposeOk(ctx, items);
  const outcome = approveAll(ctx, proposal);
  assert.ok(outcome.items.every(row => row.state === 'applied'), JSON.stringify(outcome.items));
  return proposal;
}

function itemRow(db, id) {
  const row = db.prepare('SELECT * FROM agent_proposal_items WHERE id = ?').get(id);
  return {
    ...row,
    before: JSON.parse(row.before_json),
    evidence: JSON.parse(row.evidence_json),
    result: row.result_json ? JSON.parse(row.result_json) : null,
  };
}

function candidateStatus(db, id) {
  return db.prepare('SELECT status FROM memory_extraction_candidates WHERE id = ?').get(id)?.status;
}

function repairedMemories(db, candidateId) {
  return db.prepare(`
    SELECT * FROM memories WHERE json_extract(metadata, '$.repairedFromCandidate') = ? ORDER BY content
  `).all(candidateId);
}

function embeddingTaskIds(db) {
  return db.prepare('SELECT memory_id FROM memory_embedding_tasks ORDER BY memory_id').all().map(row => row.memory_id);
}

function revisions(db, itemId, action) {
  return db.prepare('SELECT * FROM memory_revisions WHERE proposal_item_id = ? AND action = ? ORDER BY id').all(itemId, action);
}

function stateBytes(db) {
  return JSON.stringify([
    db.prepare('SELECT * FROM memories ORDER BY id').all(),
    db.prepare('SELECT * FROM memory_extraction_candidates ORDER BY id').all(),
    db.prepare('SELECT * FROM agent_proposal_items ORDER BY id').all(),
    db.prepare('SELECT * FROM memory_revisions ORDER BY id').all(),
  ]);
}

function assertUndoRejected(ctx, proposal, pattern) {
  const bytes = stateBytes(ctx.db);
  const outcome = undoProposalItem(ctx.db, proposal.id, proposal.itemIds[0], now());
  assert.equal(outcome.ok, false);
  assert.equal(outcome.status, 409);
  assert.match(outcome.error, pattern);
  assert.equal(stateBytes(ctx.db), bytes);
  assert.equal(itemRow(ctx.db, proposal.itemIds[0]).state, 'applied');
}

test('repair writes every memory with the task\'s surviving messages as sources', t => {
  const ctx = setup(t);
  const proposal = proposeAndApply(ctx, [repair(1, [BAKING, SEASIDE])]);
  const [itemId] = proposal.itemIds;
  const row = itemRow(ctx.db, itemId);

  assert.equal(proposal.items[0].warning, undefined);
  assert.equal(row.before.candidate.task_succeeded, false);
  assert.deepEqual(row.before.candidate.task, { status: 'failed', result_committed: false, result_insert_count: 0 });
  assert.deepEqual(row.evidence, { message_ids: ['msg-a1', 'msg-a2'] });

  assert.equal(candidateStatus(ctx.db, 1), 'repaired');
  const memories = repairedMemories(ctx.db, 1);
  assert.deepEqual(memories.map(memory => memory.content), [SEASIDE.content, BAKING.content]);
  for (const memory of memories) {
    assert.equal(memory.character_id, 'char-a');
    assert.equal(memory.status, 'active');
    assert.deepEqual(JSON.parse(memory.source_msg_ids), ['msg-a1', 'msg-a2']);
    assert.deepEqual(JSON.parse(memory.metadata), { repairedFromCandidate: 1, createdByProposalItem: itemId });
  }
  assert.deepEqual(JSON.parse(memories[0].tags), ['出行']);
  assert.deepEqual(new Set(row.result.memory_ids), new Set(memories.map(memory => memory.id)));
  assert.equal(row.result.created_memory_id, null);
  assert.deepEqual(embeddingTaskIds(ctx.db), memories.map(memory => memory.id).sort());

  const applied = revisions(ctx.db, itemId, 'apply');
  assert.equal(applied.length, 2);
  assert.ok(applied.every(revision => revision.before_json === null && revision.after_json !== null));
});

test('a repair applies all of its memories or none of them', t => {
  const ctx = setup(t);
  const proposal = proposeOk(ctx, [repair(1, [BAKING, SEASIDE])]);
  ctx.db.exec(`
    CREATE TRIGGER fail_second_repair BEFORE INSERT ON memories WHEN NEW.content = '${SEASIDE.content}'
    BEGIN SELECT RAISE(ABORT, 'forced failure'); END;
  `);
  const outcome = approveAll(ctx, proposal);

  assert.deepEqual(outcome.items.map(row => row.state), ['failed']);
  assert.equal(ctx.db.prepare('SELECT COUNT(*) AS n FROM memories').get().n, 0);
  assert.equal(candidateStatus(ctx.db, 1), 'repairable');
  assert.deepEqual(embeddingTaskIds(ctx.db), []);
  assert.deepEqual(revisions(ctx.db, proposal.itemIds[0], 'apply'), []);
});

test('approving two repairs of the same record writes the memories only once', t => {
  const ctx = setup(t);
  const first = proposeOk(ctx, [repair(1, [BAKING])]);
  const second = proposeOk(ctx, [repair(1, [BAKING])]);

  assert.equal(approveAll(ctx, first).items[0].state, 'applied');
  const outcome = approveAll(ctx, second);
  assert.equal(outcome.items[0].state, 'stale');
  assert.match(outcome.items[0].reason, /待修复记录 1 已被处理/);

  assert.equal(ctx.db.prepare('SELECT COUNT(*) AS n FROM memories WHERE content = ?').get(BAKING.content).n, 1);
  assert.equal(JSON.parse(repairedMemories(ctx.db, 1)[0].metadata).createdByProposalItem, first.itemIds[0]);
  assert.deepEqual(revisions(ctx.db, second.itemIds[0], 'apply'), []);
});

test('undoing a repair removes its memories and reopens the record', t => {
  const ctx = setup(t);
  const proposal = proposeAndApply(ctx, [repair(1, [BAKING, SEASIDE])]);
  const repairedIds = repairedMemories(ctx.db, 1).map(memory => memory.id);

  const undone = undoProposalItem(ctx.db, proposal.id, proposal.itemIds[0], now());
  assert.equal(undone.ok, true, undone.error);
  assert.equal(ctx.db.prepare('SELECT COUNT(*) AS n FROM memories').get().n, 0);
  assert.deepEqual(embeddingTaskIds(ctx.db), []);
  assert.equal(candidateStatus(ctx.db, 1), 'repairable');
  assert.equal(itemRow(ctx.db, proposal.itemIds[0]).state, 'undone');

  const undoRevisions = revisions(ctx.db, proposal.itemIds[0], 'undo');
  assert.deepEqual(undoRevisions.map(revision => revision.memory_id).sort(), [...repairedIds].sort());
  assert.ok(undoRevisions.every(revision => revision.before_json !== null && revision.after_json === null));

  // 记录回到 repairable 后可以重新补回
  proposeAndApply(ctx, [repair(1, [BAKING])]);
  assert.equal(candidateStatus(ctx.db, 1), 'repaired');
});

test('undoing a repair is refused when any repaired memory or the record changed', async t => {
  await t.test('a repaired memory was edited', t => {
    const ctx = setup(t);
    const proposal = proposeAndApply(ctx, [repair(1, [BAKING, SEASIDE])]);
    const edited = repairedMemories(ctx.db, 1).find(memory => memory.content === SEASIDE.content);
    ctx.db.prepare('UPDATE memories SET importance = 0.9 WHERE id = ?').run(edited.id);
    assertUndoRejected(ctx, proposal, new RegExp(`记忆 ${edited.id} 在批准后又被改动或删除`));
  });

  await t.test('a repaired memory was deleted', t => {
    const ctx = setup(t);
    const proposal = proposeAndApply(ctx, [repair(1, [BAKING, SEASIDE])]);
    const deleted = repairedMemories(ctx.db, 1)[0];
    ctx.db.prepare('DELETE FROM memories WHERE id = ?').run(deleted.id);
    assertUndoRejected(ctx, proposal, new RegExp(`记忆 ${deleted.id} 在批准后又被改动或删除`));
  });

  await t.test('the record was handled again', t => {
    const ctx = setup(t);
    const proposal = proposeAndApply(ctx, [repair(1, [BAKING])]);
    ctx.db.exec("UPDATE memory_extraction_candidates SET status = 'discarded' WHERE id = 1");
    assertUndoRejected(ctx, proposal, /待修复记录 1 当前状态为 discarded/);
  });

  await t.test('usage statistics alone do not block undo', t => {
    const ctx = setup(t);
    const proposal = proposeAndApply(ctx, [repair(1, [BAKING])]);
    ctx.db.prepare('UPDATE memories SET usage_count = 7, last_used_at = ?').run(now());
    assert.equal(undoProposalItem(ctx.db, proposal.id, proposal.itemIds[0], now()).ok, true);
    assert.equal(candidateStatus(ctx.db, 1), 'repairable');
  });
});

test('repair sources can only be narrowed within the original task', t => {
  const ctx = setup(t);

  const narrowed = proposeAndApply(ctx, [repair(1, [BAKING], { evidence: { message_ids: ['msg-a2'] } })]);
  assert.deepEqual(itemRow(ctx.db, narrowed.itemIds[0]).evidence, { message_ids: ['msg-a2'] });
  assert.deepEqual(JSON.parse(repairedMemories(ctx.db, 1)[0].source_msg_ids), ['msg-a2']);

  ctx.db.exec("UPDATE memory_extraction_candidates SET status = 'repairable' WHERE id = 1");
  const outside = propose(ctx, [repair(1, [SEASIDE], { evidence: { message_ids: ['msg-a3'] } })]);
  assert.equal(outside.ok, false);
  assert.match(outside.errors.join('\n'), /依据消息不在原提取任务的消息范围内：msg-a3/);

  // 没有原任务就没有默认来源，依据照常必填
  const missing = propose(ctx, [repair(3, [SEASIDE])]);
  assert.equal(missing.ok, false);
  assert.match(missing.errors.join('\n'), /缺少依据/);
  const declared = proposeAndApply(ctx, [repair(3, [SEASIDE], { evidence: { note: '无原文依据' } })]);
  assert.deepEqual(itemRow(ctx.db, declared.itemIds[0]).evidence, { message_ids: [], note: '无原文依据' });
  assert.equal(candidateStatus(ctx.db, 3), 'repaired');
});

test('repairs are validated before anything is written', t => {
  const ctx = setup(t);
  insertRow(ctx.db, 'memories', {
    id: 'm-bake',
    character_id: 'char-a',
    category: '话题历史',
    content: BAKING.content,
    confidence: 0.8,
    status: 'active',
    created_at: T0,
    updated_at: T0,
  });
  const cases = [
    [repair(1, [{ content: '只有正文' }]), /repair_candidate 需要 memories\[0\]\.category/],
    [repair(1, [{ content: '', category: '话题历史' }]), /memories\[0\] 的正文不能为空/],
    [repair(1, [SEASIDE, BAKING]), /memories\[1\] 已有内容相同的 active 记忆 m-bake/],
    [repair(1, [SEASIDE, { ...SEASIDE, category: '话题历史' }]), /memories\[1\] 与前面的记忆内容相同/],
    [{ ...repair(1, [SEASIDE]), memories: undefined }, /repair_candidate 需要 memories$/m],
    [{ ...discard(1), memories: [SEASIDE] }, /discard_candidate 不使用 memories/],
    [repair(5, [SEASIDE]), /待修复记录 5 不存在或不属于该角色/],
  ];
  const bytes = stateBytes(ctx.db);
  for (const [input, pattern] of cases) {
    const created = propose(ctx, [input]);
    assert.equal(created.ok, false, JSON.stringify(input));
    assert.match(created.errors.join('\n'), pattern);
  }
  assert.equal(stateBytes(ctx.db), bytes);
});

test('a repair whose task already succeeded is flagged for the model and the reviewer', t => {
  const ctx = setup(t);
  const proposal = proposeOk(ctx, [repair(2, [BAKING]), repair(4, [SEASIDE]), repair(1, [{ content: '主人周末想看海', category: '偏好习惯' }])]);
  const [done, committed, failed] = proposal.items;

  assert.match(done.warning, /原提取任务已成功（写入 2 条），补回可能与已有记忆重复/);
  assert.match(committed.warning, /写入 1 条/);
  assert.equal(failed.warning, undefined);
  assert.equal(itemRow(ctx.db, done.id).before.candidate.task_succeeded, true);
  assert.deepEqual(itemRow(ctx.db, done.id).before.candidate.task, { status: 'done', result_committed: true, result_insert_count: 2 });
  assert.equal(itemRow(ctx.db, committed.id).before.candidate.task_succeeded, true);
  assert.equal(itemRow(ctx.db, failed.id).before.candidate.task_succeeded, false);

  const ctxB = setup(t);
  const parsed = createMemoryProposalTool.schema.parse({ character_id: 'char-a', summary: '补回', items: [repair(2, [BAKING]), discard(1)] });
  const { result, terminate } = createMemoryProposalTool.execute(parsed, { db: ctxB.db, settings: {}, sessionId: ctxB.sessionId });
  assert.equal(result.ok, true);
  assert.equal(terminate, true);
  assert.deepEqual(result.warnings, ['第 1 项：原提取任务已成功（写入 2 条），补回可能与已有记忆重复']);

  // 创建时任务就已成功时，主人看过警告并明确勾选后仍可补回；只在提案生成后才成功会自动过期。
  const approved = approveAll(ctx, proposal);
  assert.deepEqual(approved.items.map(row => row.state), ['applied', 'applied', 'applied']);
  assert.equal(candidateStatus(ctx.db, 2), 'repaired');
  assert.equal(candidateStatus(ctx.db, 4), 'repaired');
});

test('a task that succeeds after proposal creation makes its old repair stale', t => {
  const ctx = setup(t);
  const proposal = proposeOk(ctx, [repair(1, [BAKING])]);
  const [itemId] = proposal.itemIds;
  const historicalBefore = itemRow(ctx.db, itemId).before;

  ctx.db.exec(`
    UPDATE memory_tasks
    SET status = 'done', result_committed = 1, result_insert_count = 1
    WHERE id = 1;
  `);
  insertRow(ctx.db, 'memories', {
    id: 'm-task-result',
    character_id: 'char-a',
    category: BAKING.category,
    content: BAKING.content,
    confidence: 0.8,
    status: 'active',
    created_at: T0,
    updated_at: T0,
  });

  const view = getProposalView(ctx.db, proposal.id);
  assert.ok(view);
  assert.deepEqual(view.items[0].current_candidate_task, {
    status: 'done',
    result_committed: true,
    result_insert_count: 1,
  });
  assert.deepEqual(view.items[0].before, historicalBefore, 'the proposal keeps its historical task snapshot');
  assert.equal(view.items[0].before.candidate.task.status, 'failed');

  const outcome = approveAll(ctx, proposal);
  assert.equal(outcome.items[0].state, 'stale');
  assert.match(outcome.items[0].reason, /原提取任务 1 在提案生成后已成功/);
  assert.equal(candidateStatus(ctx.db, 1), 'repairable');
  assert.deepEqual(repairedMemories(ctx.db, 1), []);
  assert.equal(ctx.db.prepare("SELECT COUNT(*) AS n FROM memories WHERE content = ?").get(BAKING.content).n, 1);
});

test('discarding a record can be undone until the record is handled again', t => {
  const ctx = setup(t);
  const proposal = proposeAndApply(ctx, [discard(1)]);
  assert.equal(candidateStatus(ctx.db, 1), 'discarded');
  assert.deepEqual(itemRow(ctx.db, proposal.itemIds[0]).result.memory_ids, []);

  assert.equal(undoProposalItem(ctx.db, proposal.id, proposal.itemIds[0], now()).ok, true);
  assert.equal(candidateStatus(ctx.db, 1), 'repairable');
  assert.equal(itemRow(ctx.db, proposal.itemIds[0]).state, 'undone');
  assert.equal(ctx.db.prepare('SELECT COUNT(*) AS n FROM memories').get().n, 0);

  const again = proposeAndApply(ctx, [discard(1)]);
  ctx.db.exec("UPDATE memory_extraction_candidates SET status = 'repaired' WHERE id = 1");
  assertUndoRejected(ctx, again, /待修复记录 1 当前状态为 repaired/);

  const removed = proposeAndApply(ctx, [discard(3)]);
  ctx.db.exec('DELETE FROM memory_extraction_candidates WHERE id = 3');
  assertUndoRejected(ctx, removed, /待修复记录 3 已删除，不能撤销/);
});

test('a record left by the real extraction path can be repaired and undone', async t => {
  const ctx = setup(t);
  const insertSetting = ctx.db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)');
  for (const [key, value] of Object.entries({
    api_base: 'http://upstream.test/v1',
    api_key: 'candidate-repair-test-key',
    model: 'candidate-repair-model',
    streaming: false,
  })) {
    insertSetting.run(key, JSON.stringify(value));
  }
  addTask(ctx.db, 9, ['msg-a1', 'msg-a2'], { status: 'processing' });

  const originalFetch = ssrfGuard.safeFetch;
  let calls = 0;
  ssrfGuard.safeFetch = async () => {
    calls += 1;
    return Response.json({ choices: [{ message: { content: '我觉得主人在学做蛋糕，还想去海边（不是 JSON）' }, finish_reason: 'stop' }] });
  };
  t.after(() => {
    ssrfGuard.safeFetch = originalFetch;
  });

  const result = await extractMemories('char-a', '用户: 我最近在学做蛋糕\n用户: 周末想去海边\n'.repeat(4), loadSettings(), {
    messageIds: ['msg-a1', 'msg-a2'],
    taskId: 9,
    conversationId: 'conv-a',
  });
  assert.equal(calls, 1);
  assert.deepEqual(result, { insertCount: 0, mergeCount: 0 });
  const candidate = ctx.db.prepare('SELECT * FROM memory_extraction_candidates WHERE task_id = 9').get();
  assert.equal(candidate.status, 'repairable');
  assert.equal(candidate.character_id, 'char-a');

  const proposal = proposeAndApply(ctx, [repair(candidate.id, [BAKING, SEASIDE])]);
  assert.deepEqual(itemRow(ctx.db, proposal.itemIds[0]).evidence, { message_ids: ['msg-a1', 'msg-a2'] });
  assert.equal(candidateStatus(ctx.db, candidate.id), 'repaired');
  const memories = repairedMemories(ctx.db, candidate.id);
  assert.equal(memories.length, 2);
  assert.ok(memories.every(memory => memory.source_msg_ids === JSON.stringify(['msg-a1', 'msg-a2'])));

  assert.equal(undoProposalItem(ctx.db, proposal.id, proposal.itemIds[0], now()).ok, true);
  assert.equal(candidateStatus(ctx.db, candidate.id), 'repairable');
  assert.deepEqual(repairedMemories(ctx.db, candidate.id), []);
});
