const test = require('node:test');
const assert = require('node:assert/strict');
const { installMemoryOnlyTestGuard } = require('./helpers/memory-only-test-guard.cjs');

installMemoryOnlyTestGuard(test);

const Database = require('better-sqlite3');
const { registerTsLoader } = require('./helpers/register-ts-loader.cjs');

registerTsLoader();

const { __migrateForTests, __setDbForTests } = require('../src/lib/db.ts');
const { DEFAULT_SETTINGS } = require('../src/types/index.ts');
const { MAX_MEMORY_CONTENT } = require('../src/lib/schemas.ts');
const { AGENT_TOOLS, AGENT_WRITE_TOOLS } = require('../src/lib/agent/tools/index.ts');
const { parseToolArguments, toolDefinitions } = require('../src/lib/agent/tools/registry.ts');
const { NO_EVIDENCE_NOTE } = require('../src/lib/agent/proposals.ts');
const { createAgentSession, listAgentMessages } = require('../src/lib/agent/store.ts');
const { runAgentTurn } = require('../src/lib/agent/loop.ts');

const T0 = '2026-10-01T00:00:00.000Z';
const SETTINGS = {
  ...DEFAULT_SETTINGS,
  api_base: 'http://upstream.test/v1',
  api_key: 'agent-proposals-test-key',
  model: 'agent-test-model',
  streaming: false,
};
const proposalTool = AGENT_TOOLS.find(tool => tool.name === 'create_memory_proposal');

let clock = 0;
const now = () => new Date(Date.UTC(2026, 10, 2, 9, 0, 0) + (clock += 1000)).toISOString();

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
    confidence: extra.confidence ?? 0.8,
    tags: JSON.stringify(extra.tags || []),
    source_msg_ids: JSON.stringify(extra.source || ['msg-a1']),
    importance: extra.importance ?? 0.5,
    status: extra.status || 'active',
    pinned: extra.pinned ? 1 : 0,
    usage_count: extra.usage_count ?? 3,
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
  insertRow(db, 'conversations', { id: 'conv-b', character_id: 'char-b', title: '夜谈' });
  insertRow(db, 'messages', { id: 'msg-a1', conversation_id: 'conv-a', role: 'user', content: '我最近在学做蛋糕', created_at: T0 });
  insertRow(db, 'messages', { id: 'msg-a2', conversation_id: 'conv-a', role: 'user', content: '其实我挺爱吃甜的', created_at: T0 });
  insertRow(db, 'messages', { id: 'msg-b1', conversation_id: 'conv-b', role: 'user', content: '晚安', created_at: T0 });

  addMemory(db, 'm-tea', '主人喜欢喝无糖乌龙茶', { tags: ['饮品', '茶'] });
  addMemory(db, 'm-sweet', '主人不爱吃甜');
  addMemory(db, 'm-bake', '主人最近迷上做甜点', { category: '话题历史' });
  addMemory(db, 'm-pinned', '主人的生日是三月', { pinned: true, category: '基础信息' });
  addMemory(db, 'm-old', '主人住在海边', { status: 'superseded' });
  addMemory(db, 'm-merged', '主人养了一只橘猫（合并结果）', { metadata: { mergeRole: 'result', mergeBatchId: 'b1' } });
  addMemory(db, 'm-summary', '春天的几次散步', { metadata: { archiveRole: 'summary', archiveBatchId: 'a1' } });
  addMemory(db, 'm-cat1', '主人养了一只橘猫');
  addMemory(db, 'm-cat2', '主人家里有只橘色的猫');
  addMemory(db, 'm-walk1', '和主人在河边散步');
  addMemory(db, 'm-walk2', '和主人去公园散步');
  addMemory(db, 'm-other', '白砂的记忆', { character_id: 'char-b' });

  insertRow(db, 'memory_extraction_candidates', {
    id: 1, task_id: 11, character_id: 'char-a', conversation_id: 'conv-a', raw_response: '{bad', status: 'repairable',
    error_reason: 'parse_failed', created_at: T0, updated_at: T0,
  });
  insertRow(db, 'memory_extraction_candidates', {
    id: 2, task_id: 12, character_id: 'char-a', conversation_id: 'conv-a', raw_response: '{bad', status: 'discarded',
    created_at: T0, updated_at: T0,
  });
  insertRow(db, 'memory_extraction_candidates', {
    id: 3, task_id: 13, character_id: 'char-b', conversation_id: 'conv-b', raw_response: '{bad', status: 'repairable',
    created_at: T0, updated_at: T0,
  });

  const session = createAgentSession(db, { character_id: 'char-a', conversation_id: 'conv-a' }, now());
  return { db, sessionId: session.id };
}

const evidence = { message_ids: ['msg-a1'] };

function item(op, rest = {}) {
  return { op, reason: '测试理由', confidence: 0.8, ...rest };
}

function proposal(items, rest = {}) {
  return { character_id: 'char-a', summary: '整理星野的记忆', items, ...rest };
}

/** 与 Agent 循环相同的路径：参数字符串 → schema 校验 → 同步执行。 */
function propose(ctx, args) {
  const parsed = parseToolArguments(proposalTool, JSON.stringify(args));
  if (!parsed.ok) return { parseError: parsed.error };
  return proposalTool.execute(parsed.args, { db: ctx.db, settings: SETTINGS, sessionId: ctx.sessionId });
}

/** memories 与 embedding 队列的全量字节快照：创建提案前后必须完全一致。 */
function memoryBytes(db) {
  return JSON.stringify({
    memories: db.prepare('SELECT * FROM memories ORDER BY id').all(),
    embeddingTasks: db.prepare('SELECT * FROM memory_embedding_tasks ORDER BY id').all(),
    candidates: db.prepare('SELECT * FROM memory_extraction_candidates ORDER BY id').all(),
  });
}

function proposalCount(db) {
  return db.prepare('SELECT COUNT(*) AS n FROM agent_proposals').get().n
    + db.prepare('SELECT COUNT(*) AS n FROM agent_proposal_items').get().n;
}

function storedItems(db, proposalId) {
  return db.prepare('SELECT * FROM agent_proposal_items WHERE proposal_id = ? ORDER BY seq').all(proposalId).map(row => ({
    ...row,
    evidence: JSON.parse(row.evidence_json),
    before: JSON.parse(row.before_json),
    after: JSON.parse(row.after_json),
  }));
}

test('registry: character writes require proposals and remember only adds Agent notes', () => {
  assert.deepEqual(AGENT_WRITE_TOOLS.map(tool => tool.name), ['create_memory_proposal', 'remember', 'update_task_plan']);
  assert.deepEqual(AGENT_TOOLS.filter(tool => tool.kind === 'write').map(tool => tool.name), ['create_memory_proposal', 'remember', 'update_task_plan']);
  assert.equal(new Set(AGENT_TOOLS.map(tool => tool.name)).size, AGENT_TOOLS.length);
  for (const definition of toolDefinitions(AGENT_TOOLS)) {
    assert.equal(definition.function.parameters.type, 'object');
    assert.equal(definition.function.parameters.$schema, undefined);
  }
});

test('a valid proposal stores server-read before snapshots and leaves memories byte-identical', t => {
  const ctx = setup(t);
  const bytes = memoryBytes(ctx.db);

  const outcome = propose(ctx, proposal([
    item('create', { fields: { content: '  主人在学做蛋糕  ', category: '话题历史', tags: ['午饭', '甜点', '午餐'] }, evidence }),
    item('update', {
      memory_id: 'm-tea',
      // 模型伪造的「修改前」必须被忽略
      before: { content: '伪造的旧内容', importance: 0.1 },
      fields: { content: '主人喜欢喝无糖乌龙茶，偶尔喝奶茶', tags: ['茶', '饮品'], importance: 0.7 },
      evidence: { message_ids: ['msg-a2', 'msg-a2'], note: '主人自己说的' },
    }),
    item('retire', { memory_id: 'm-sweet', evidence: { message_ids: ['msg-a2'] } }),
    item('merge', { memory_ids: ['m-cat1', 'm-cat2'], fields: { content: '主人养了一只橘猫', tags: ['宠物'] }, evidence }),
    item('archive', { memory_ids: ['m-walk1', 'm-walk2'], fields: { content: '和主人散过几次步' }, evidence: { message_ids: [], note: NO_EVIDENCE_NOTE } }),
    item('discard_candidate', { candidate_id: 1 }),
    item('report_conflict', { memory_ids: ['m-sweet', 'm-bake'], evidence: { message_ids: ['msg-a1', 'msg-a2'] } }),
  ]));

  assert.equal(outcome.result.ok, true, outcome.result.error);
  assert.equal(outcome.terminate, true);
  assert.equal(outcome.result.pending_items, 6);
  assert.equal(outcome.result.reported_conflicts, 1);
  assert.equal(memoryBytes(ctx.db), bytes);

  const stored = ctx.db.prepare('SELECT * FROM agent_proposals WHERE id = ?').get(outcome.result.proposal_id);
  assert.equal(stored.status, 'pending');
  assert.equal(stored.session_id, ctx.sessionId);
  assert.equal(stored.character_id, 'char-a');
  assert.equal(stored.decided_at, null);

  const items = storedItems(ctx.db, stored.id);
  assert.deepEqual(items.map(row => [row.seq, row.op, row.state]), [
    [1, 'create', 'pending'],
    [2, 'update', 'pending'],
    [3, 'retire', 'pending'],
    [4, 'merge', 'pending'],
    [5, 'archive', 'pending'],
    [6, 'discard_candidate', 'pending'],
    [7, 'report_conflict', 'reported'],
  ]);

  const [create, update, retire, merge, archive, discard, conflict] = items;
  assert.equal(create.before, null);
  assert.deepEqual(create.after, { content: '主人在学做蛋糕', category: '话题历史', tags: ['午餐', '甜点'] });

  assert.equal(update.before_json.includes('伪造'), false);
  assert.equal(update.before.memories[0].id, 'm-tea');
  assert.equal(update.before.memories[0].snapshot.content, '主人喜欢喝无糖乌龙茶');
  assert.equal(update.before.memories[0].snapshot.importance, 0.5);
  assert.deepEqual(update.before.memories[0].snapshot.source_msg_ids, ['msg-a1']);
  assert.equal('usage_count' in update.before.memories[0].snapshot, false);
  // 只记录真正变化的字段：标签只是换了顺序，不算改动
  assert.deepEqual(update.after, { content: '主人喜欢喝无糖乌龙茶，偶尔喝奶茶', importance: 0.7 });
  assert.deepEqual(update.evidence, { message_ids: ['msg-a2'], note: '主人自己说的' });

  assert.deepEqual(retire.after, { status: 'superseded' });
  assert.deepEqual(merge.before.memories.map(target => target.id), ['m-cat1', 'm-cat2']);
  assert.deepEqual(archive.evidence, { message_ids: [], note: NO_EVIDENCE_NOTE });
  assert.equal(discard.before.candidate.id, 1);
  assert.equal(discard.before.candidate.status, 'repairable');
  assert.deepEqual(discard.after, { status: 'discarded' });
  assert.deepEqual(conflict.before.memories.map(target => target.id), ['m-sweet', 'm-bake']);
  assert.equal(conflict.after, null);
  for (const row of items) assert.equal(row.reason, '测试理由');
});

test('illegal proposals are rejected with a reason and store nothing', async t => {
  const cases = [
    ['target missing', proposal([item('update', { memory_id: 'm-none', fields: { importance: 0.9 } })]), /m-none 不存在或不属于该角色/],
    ['target of another character', proposal([item('retire', { memory_id: 'm-other', evidence })]), /m-other 不存在或不属于该角色/],
    ['unknown character', proposal([item('retire', { memory_id: 'm-tea', evidence })], { character_id: 'char-x' }), /角色 char-x 不存在/],
    ['no actual change', proposal([item('update', { memory_id: 'm-tea', fields: { content: '主人喜欢喝无糖乌龙茶' }, evidence })]), /没有实际改动/],
    ['tags only reordered', proposal([item('update', { memory_id: 'm-tea', fields: { tags: ['茶', '饮品'] } })]), /没有实际改动/],
    ['create duplicates an active memory', proposal([item('create', { fields: { content: '主人不爱吃甜', category: '偏好习惯' }, evidence })]), /已有内容相同的 active 记忆 m-sweet/],
    ['blank reason', proposal([item('retire', { memory_id: 'm-tea', reason: '   ', evidence })]), /缺少理由/],
    ['blank summary', proposal([item('retire', { memory_id: 'm-tea', evidence })], { summary: '  ' }), /缺少提案概述/],
    ['update a superseded memory', proposal([item('update', { memory_id: 'm-old', fields: { importance: 0.9 } })]), /m-old 当前状态为 superseded/],
    ['retire a superseded memory', proposal([item('retire', { memory_id: 'm-old', evidence })]), /m-old 当前状态为 superseded/],
    ['merge a pinned memory', proposal([item('merge', { memory_ids: ['m-pinned', 'm-tea'], fields: { content: '合并' }, evidence })]), /m-pinned 已钉选/],
    ['merge an inactive memory', proposal([item('merge', { memory_ids: ['m-old', 'm-tea'], fields: { content: '合并' }, evidence })]), /m-old 不是 active/],
    ['merge an earlier merge result', proposal([item('merge', { memory_ids: ['m-merged', 'm-cat1'], fields: { content: '合并' }, evidence })]), /m-merged 已参与过合并或归档/],
    ['merge a single memory', proposal([item('merge', { memory_ids: ['m-cat1'], fields: { content: '合并' }, evidence })]), /至少需要 2 条/],
    ['merge repeats an id', proposal([item('merge', { memory_ids: ['m-cat1', 'm-cat1', 'm-cat2'], fields: { content: '合并' }, evidence })]), /memory_ids 有重复/],
    ['merge without content', proposal([item('merge', { memory_ids: ['m-cat1', 'm-cat2'], evidence })]), /merge 需要 fields.content/],
    ['archive a summary', proposal([item('archive', { memory_ids: ['m-summary'], fields: { content: '摘要' }, evidence })]), /m-summary 已是归档摘要/],
    ['archive with extra fields', proposal([item('archive', { memory_ids: ['m-walk1'], fields: { content: '摘要', category: '四季日常' }, evidence })]), /fields 不能包含：category/],
    ['conflict with one memory', proposal([item('report_conflict', { memory_ids: ['m-sweet'], evidence })]), /至少需要 2 条/],
    ['conflict across characters', proposal([item('report_conflict', { memory_ids: ['m-sweet', 'm-other'], evidence })]), /m-other/],
    ['retire with fields', proposal([item('retire', { memory_id: 'm-tea', fields: { importance: 0.1 }, evidence })]), /retire 不使用 fields/],
    ['update without target', proposal([item('update', { fields: { importance: 0.9 } })]), /update 需要 memory_id/],
    ['create with a target', proposal([item('create', { memory_id: 'm-tea', fields: { content: '新的', category: '话题历史' }, evidence })]), /create 不使用 memory_id/],
    ['create without category', proposal([item('create', { fields: { content: '新的' }, evidence })]), /create 需要 fields.category/],
    ['create with blank content', proposal([item('create', { fields: { content: '   ', category: '话题历史' }, evidence })]), /正文不能为空/],
    ['discard a non-repairable candidate', proposal([item('discard_candidate', { candidate_id: 2 })]), /当前状态为 discarded/],
    ['discard another character\'s candidate', proposal([item('discard_candidate', { candidate_id: 3 })]), /待修复记录 3 不存在或不属于该角色/],
    ['two items touch one memory', proposal([
      item('update', { memory_id: 'm-tea', fields: { importance: 0.9 } }),
      item('retire', { memory_id: 'm-tea', evidence }),
    ]), /第 2 项（retire）：记忆 m-tea 已在第 1 项中处理/],
    ['merge and archive overlap', proposal([
      item('merge', { memory_ids: ['m-cat1', 'm-cat2'], fields: { content: '合并' }, evidence }),
      item('archive', { memory_ids: ['m-cat2', 'm-walk1'], fields: { content: '摘要' }, evidence }),
    ]), /记忆 m-cat2 已在第 1 项中处理/],
  ];

  for (const [name, args, expected] of cases) {
    await t.test(name, t2 => {
      const ctx = setup(t2);
      const bytes = memoryBytes(ctx.db);
      const outcome = propose(ctx, args);
      assert.equal(outcome.parseError, undefined, outcome.parseError);
      assert.equal(outcome.result.ok, false);
      assert.match(outcome.result.error, /^提案未创建：/);
      assert.match(outcome.result.error, expected);
      assert.ok(!outcome.terminate);
      assert.equal(proposalCount(ctx.db), 0);
      assert.equal(memoryBytes(ctx.db), bytes);
    });
  }
});

test('one bad item rejects the whole proposal and every problem is listed', t => {
  const ctx = setup(t);
  const outcome = propose(ctx, proposal([
    item('retire', { memory_id: 'm-tea', evidence }),
    item('update', { memory_id: 'm-none', fields: { importance: 0.9 } }),
    item('retire', { memory_id: 'm-sweet' }),
  ]));
  assert.equal(outcome.result.ok, false);
  assert.doesNotMatch(outcome.result.error, /第 1 项/);
  assert.match(outcome.result.error, /第 2 项（update）：记忆 m-none 不存在/);
  assert.match(outcome.result.error, /第 3 项（retire）：缺少依据/);
  assert.equal(proposalCount(ctx.db), 0);
});

test('schema rejects invalid categories, oversized content, unknown fields and bad confidence', t => {
  const ctx = setup(t);
  const cases = [
    [item('create', { fields: { content: '新的', category: '乱写的分类' }, evidence }), /category/],
    [item('create', { fields: { content: '长'.repeat(MAX_MEMORY_CONTENT + 1), category: '话题历史' }, evidence }), new RegExp(`正文不能超过 ${MAX_MEMORY_CONTENT} 字`)],
    [item('update', { memory_id: 'm-tea', fields: { status: 'archived' } }), /status/],
    [item('update', { memory_id: 'm-tea', fields: { metadata: { a: 1 } } }), /metadata/],
    [item('retire', { memory_id: 'm-tea', evidence, confidence: 1.5 }), /confidence/],
    [{ op: 'retire', memory_id: 'm-tea', evidence, confidence: 0.5 }, /reason/],
  ];
  for (const [bad, expected] of cases) {
    const outcome = propose(ctx, proposal([bad]));
    assert.ok(outcome.parseError, `expected schema rejection for ${JSON.stringify(bad).slice(0, 80)}`);
    assert.match(outcome.parseError, expected);
  }
  assert.equal(proposalCount(ctx.db), 0);
});

test('evidence: content, retire, merge, archive and conflicts need message ids or the explicit no-evidence note', async t => {
  const missingEvidence = [
    item('create', { fields: { content: '新的记忆', category: '话题历史' } }),
    item('create', { fields: { content: '新的记忆', category: '话题历史' }, evidence: { message_ids: [], note: '我觉得是这样' } }),
    item('update', { memory_id: 'm-tea', fields: { content: '改过的正文' } }),
    item('retire', { memory_id: 'm-tea' }),
    item('merge', { memory_ids: ['m-cat1', 'm-cat2'], fields: { content: '合并' } }),
    item('archive', { memory_ids: ['m-walk1', 'm-walk2'], fields: { content: '摘要' } }),
    item('report_conflict', { memory_ids: ['m-sweet', 'm-bake'] }),
  ];
  for (const bad of missingEvidence) {
    await t.test(`${bad.op} without evidence`, t2 => {
      const ctx = setup(t2);
      const outcome = propose(ctx, proposal([bad]));
      assert.equal(outcome.result.ok, false);
      assert.match(outcome.result.error, /缺少依据/);
      assert.equal(proposalCount(ctx.db), 0);
    });
  }

  await t.test('message ids must exist in this character\'s conversations', t2 => {
    const ctx = setup(t2);
    for (const ids of [['msg-b1'], ['msg-a1', 'msg-none']]) {
      const outcome = propose(ctx, proposal([item('retire', { memory_id: 'm-tea', evidence: { message_ids: ids } })]));
      assert.equal(outcome.result.ok, false);
      assert.match(outcome.result.error, new RegExp(`依据消息不存在或不属于该角色的对话：${ids.at(-1)}`));
    }
    assert.equal(proposalCount(ctx.db), 0);
  });

  await t.test('changes that do not touch content need no evidence', t2 => {
    const ctx = setup(t2);
    const outcome = propose(ctx, proposal([
      item('update', { memory_id: 'm-tea', fields: { importance: 0.9, pinned: true } }),
      item('discard_candidate', { candidate_id: 1 }),
    ]));
    assert.equal(outcome.result.ok, true, outcome.result.error);
    const items = storedItems(ctx.db, outcome.result.proposal_id);
    assert.deepEqual(items.map(row => row.evidence), [{ message_ids: [] }, { message_ids: [] }]);
  });

  await t.test('the explicit no-evidence note is accepted and kept for the card', t2 => {
    const ctx = setup(t2);
    const outcome = propose(ctx, proposal([
      item('retire', { memory_id: 'm-tea', evidence: { message_ids: [], note: ` ${NO_EVIDENCE_NOTE} ` } }),
    ]));
    assert.equal(outcome.result.ok, true, outcome.result.error);
    assert.deepEqual(storedItems(ctx.db, outcome.result.proposal_id)[0].evidence, { message_ids: [], note: NO_EVIDENCE_NOTE });
  });
});

/** 假上游：按顺序返回预设结果，并记录每次请求体。 */
function scripted(steps) {
  const requests = [];
  const complete = async (_settings, body) => {
    requests.push(JSON.parse(JSON.stringify(body)));
    const step = steps[requests.length - 1];
    if (!step) throw new Error(`unexpected request #${requests.length}`);
    return { text: '', toolCalls: [], ...step };
  };
  return { complete, requests };
}

function proposalCall(id, args) {
  return { id, name: 'create_memory_proposal', arguments: JSON.stringify(args) };
}

test('loop: an executable proposal ends the turn without touching memories', async t => {
  const ctx = setup(t);
  const bytes = memoryBytes(ctx.db);
  const { complete, requests } = scripted([
    { text: '我整理好了，请看卡片。', toolCalls: [proposalCall('p1', proposal([item('retire', { memory_id: 'm-sweet', evidence })]))] },
  ]);
  const result = await runAgentTurn({
    db: ctx.db, sessionId: ctx.sessionId, userContent: '帮我整理一下', tools: AGENT_TOOLS, settings: SETTINGS, complete, now,
  });
  assert.deepEqual(result, { status: 'terminated', rounds: 1 });
  assert.equal(requests.length, 1);
  assert.ok(requests[0].tools.some(tool => tool.function.name === 'create_memory_proposal'));
  assert.equal(memoryBytes(ctx.db), bytes);

  const toolRow = listAgentMessages(ctx.db, ctx.sessionId).find(row => row.role === 'tool');
  const toolResult = JSON.parse(toolRow.content);
  assert.equal(toolResult.ok, true);
  assert.equal(toolResult.pending_items, 1);
  assert.equal(ctx.db.prepare('SELECT status FROM agent_proposals WHERE id = ?').get(toolResult.proposal_id).status, 'pending');
});

test('loop: a conflict-only proposal is recorded as findings and the turn continues', async t => {
  const ctx = setup(t);
  const bytes = memoryBytes(ctx.db);
  const { complete, requests } = scripted([
    { toolCalls: [proposalCall('p1', proposal([item('report_conflict', { memory_ids: ['m-sweet', 'm-bake'], evidence })]))] },
    { text: '发现一处矛盾，已经记录。' },
  ]);
  const result = await runAgentTurn({
    db: ctx.db, sessionId: ctx.sessionId, userContent: '有没有矛盾', tools: AGENT_TOOLS, settings: SETTINGS, complete, now,
  });
  assert.deepEqual(result, { status: 'done', rounds: 2 });
  assert.equal(requests.length, 2);
  assert.equal(memoryBytes(ctx.db), bytes);

  const stored = ctx.db.prepare('SELECT * FROM agent_proposals').all();
  assert.equal(stored.length, 1);
  // 只有发现、没有可决定的项：直接记为 decided，矛盾项是 reported 而不是 pending，不会进入批准
  assert.equal(stored[0].status, 'decided');
  assert.ok(stored[0].decided_at);
  assert.deepEqual(storedItems(ctx.db, stored[0].id).map(row => row.state), ['reported']);
});

test('loop: an invalid proposal returns the reasons and the model can retry in the same turn', async t => {
  const ctx = setup(t);
  const { complete, requests } = scripted([
    { toolCalls: [proposalCall('p1', proposal([item('retire', { memory_id: 'm-old', evidence })]))] },
    { toolCalls: [proposalCall('p2', proposal([item('retire', { memory_id: 'm-sweet', evidence })]))] },
  ]);
  const result = await runAgentTurn({
    db: ctx.db, sessionId: ctx.sessionId, userContent: '整理', tools: AGENT_TOOLS, settings: SETTINGS, complete, now,
  });
  assert.deepEqual(result, { status: 'terminated', rounds: 2 });
  const retryContext = requests[1].messages.at(-1);
  assert.equal(retryContext.role, 'tool');
  assert.match(retryContext.content, /提案未创建：[\s\S]*m-old 当前状态为 superseded/);
  assert.equal(ctx.db.prepare('SELECT COUNT(*) AS n FROM agent_proposals').get().n, 1);
});
