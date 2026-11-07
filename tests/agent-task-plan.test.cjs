const test = require('node:test');
const assert = require('node:assert/strict');
const { installMemoryOnlyTestGuard } = require('./helpers/memory-only-test-guard.cjs');
installMemoryOnlyTestGuard(test);
const Database = require('better-sqlite3');
const { z } = require('zod');
const { registerTsLoader } = require('./helpers/register-ts-loader.cjs');
registerTsLoader();
const { __migrateForTests, __setDbForTests } = require('../src/lib/db.ts');
const { DEFAULT_SETTINGS } = require('../src/types/index.ts');
const { createAgentSession, listAgentMessages, appendAgentMessage } = require('../src/lib/agent/store.ts');
const { agentTaskPlanSchema, readLatestAgentTaskPlan } = require('../src/lib/agent/task-plan.ts');
const { updateTaskPlanTool } = require('../src/lib/agent/tools/task-plan-tool.ts');
const { createMemoryProposalTool } = require('../src/lib/agent/tools/proposal-tools.ts');
const { AGENT_TOOLS } = require('../src/lib/agent/tools/index.ts');
const { defineReadTool } = require('../src/lib/agent/tools/types.ts');
const { toolDefinitions } = require('../src/lib/agent/tools/registry.ts');
const { AGENT_BASE_PROMPT } = require('../src/lib/agent/prompt.ts');
const { MEMORY_REVIEW_SKILL } = require('../src/lib/agent/skills/memory-review.ts');
const { runAgentTurn, compactAgentSession, buildAgentHistoryMessages } = require('../src/lib/agent/loop.ts');

const NOW = '2026-11-06T02:00:00.000Z';
const SETTINGS = { ...DEFAULT_SETTINGS, api_key: 'fixture-task-plan-key', model: 'fixture-task-plan-model', streaming: false };

function plan(overrides = {}) {
  return {
    goal: '审查虚构角色的全部记忆，给出有依据的建议。',
    steps: [
      { id: 'check-conflicts', title: '核验矛盾', status: 'in_progress' },
      { id: 'check-duplicates', title: '核验重复', status: 'pending' },
    ],
    round_goal: '核验第 0 批的矛盾疑点，留下结论和需要继续取证的事项。',
    progress: '尚未读取。',
    unresolved: [],
    next_round: '继续后续批次，并复核待比对的真实记忆 ID。',
    recommend_compaction: false,
    round_complete: false,
    ...overrides,
  };
}

function setup(t) {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  __migrateForTests(db);
  __setDbForTests(db);
  t.after(() => { __setDbForTests(null); db.close(); });
  const session = createAgentSession(db, {}, NOW);
  return { db, sessionId: session.id, ctx: { db, sessionId: session.id, settings: SETTINGS } };
}

function call(name, args) {
  return { id: `fixture-${name}`, name, arguments: JSON.stringify(args) };
}

function latest(db, sessionId) {
  return readLatestAgentTaskPlan(listAgentMessages(db, sessionId));
}

test('task plan schema validates complete snapshots and unique step IDs, and allows several active steps', () => {
  assert.equal(agentTaskPlanSchema.safeParse(plan()).success, true);
  for (const invalid of [
    { ...plan(), goal: ' ' },
    { ...plan(), steps: [] },
    { ...plan(), round_goal: '' },
    { ...plan(), recommend_compaction: 'yes' },
    { ...plan(), round_complete: 'yes' },
    { ...plan(), steps: [{ id: 'same', title: 'A', status: 'pending' }, { id: 'same', title: 'B', status: 'completed' }] },
    { ...plan(), steps: [{ id: 'a', title: 'A', status: 'read' }] },
  ]) assert.equal(agentTaskPlanSchema.safeParse(invalid).success, false);
  const parallel = { ...plan(), steps: [{ id: 'a', title: 'A', status: 'in_progress' }, { id: 'b', title: 'B', status: 'in_progress' }] };
  assert.equal(agentTaskPlanSchema.safeParse(parallel).success, true, 'reading batches and proposing can run side by side');
  const { next_round: omitted, ...partial } = plan();
  assert.ok(omitted);
  assert.equal(agentTaskPlanSchema.safeParse(partial).success, false, 'updates must include the full snapshot');
  const finished = plan({ steps: [{ id: 'check', title: '核验', status: 'completed', result: '已核验且没有发现问题。' }], next_round: '' });
  assert.equal(agentTaskPlanSchema.safeParse(finished).success, true);
  const definition = toolDefinitions([updateTaskPlanTool])[0].function;
  assert.equal(definition.name, 'update_task_plan');
  assert.equal(definition.parameters.properties.steps.items.properties.status.enum.includes('completed'), true);
});

test('latest valid event is restored without trusting corrupt or unrelated records', () => {
  const first = plan();
  const second = plan({ progress: '已审查 mem-2，尚需 msg-3 的原文。', unresolved: ['核验 mem-2 的来源 msg-3。'] });
  const event = (id, value, role = 'event') => ({ id, role, content: typeof value === 'string' ? value : JSON.stringify(value) });
  const rows = [
    event(9, { kind: 'task_plan', plan: second }),
    event(4, { kind: 'task_plan', plan: first }),
    event(10, '{invalid JSON'),
    event(11, { kind: 'task_plan', plan: { goal: '部分数据' } }),
    event(12, { kind: 'task_plan', plan: first }, 'tool'),
    event(13, { kind: 'compaction', plan: first }),
    event(14, { kind: 'task_plan', plan: null }),
  ];
  assert.deepEqual(readLatestAgentTaskPlan(rows), { rowId: 9, plan: second });
  assert.equal(readLatestAgentTaskPlan([]), null);
});

test('older task snapshots without round_complete remain valid and default to an unfinished round', () => {
  const { round_complete: completed, ...legacy } = plan();
  assert.equal(completed, false);
  const parsed = agentTaskPlanSchema.parse(legacy);
  assert.equal(parsed.round_complete, false);
  const restored = readLatestAgentTaskPlan([{ id: 1, role: 'event', content: JSON.stringify({ kind: 'task_plan', plan: legacy }) }]);
  assert.deepEqual(restored, { rowId: 1, plan: { ...legacy, round_complete: false } });
  const schema = toolDefinitions([updateTaskPlanTool])[0].function.parameters;
  assert.equal(schema.required.includes('round_complete'), false, 'upstream input accepts legacy snapshots');
});

test('write tool saves a session event and returns an acknowledgement without repeating the plan', t => {
  const { db, sessionId, ctx } = setup(t);
  const snapshot = plan();
  const before = JSON.stringify(db.prepare('SELECT * FROM memories').all());
  const outcome = updateTaskPlanTool.execute(agentTaskPlanSchema.parse(snapshot), ctx);
  assert.deepEqual(outcome, { result: { ok: true, saved: true } });
  assert.deepEqual(latest(db, sessionId).plan, snapshot);
  assert.equal(listAgentMessages(db, sessionId)[0].role, 'event');
  assert.equal(JSON.stringify(db.prepare('SELECT * FROM memories').all()), before);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM agent_documents').get().n, 0);
  assert.equal(AGENT_TOOLS.find(tool => tool.name === 'update_task_plan'), updateTaskPlanTool);
});

test('snapshots persist in session messages, replace the whole plan and stay isolated between sessions', t => {
  const { db, sessionId, ctx } = setup(t);
  const other = createAgentSession(db, {}, NOW);
  updateTaskPlanTool.execute(plan(), ctx);
  const completed = plan({
    progress: '已审查第 0 批；核验 mem-4 和 msg-8，未发现矛盾。',
    steps: [{ id: 'check-conflicts', title: '核验矛盾', status: 'completed', result: '第 0 批无矛盾。' }],
    unresolved: ['归档记忆尚未审查。'],
    recommend_compaction: true,
  });
  updateTaskPlanTool.execute(completed, ctx);
  updateTaskPlanTool.execute(plan({ goal: '另一个会话的任务。' }), { ...ctx, sessionId: other.id });
  assert.deepEqual(latest(db, sessionId).plan, completed);
  assert.equal(latest(db, other.id).plan.goal, '另一个会话的任务。');
  const savedRows = db.prepare('SELECT id, role, content FROM agent_messages WHERE session_id = ? ORDER BY id').all(sessionId);
  assert.deepEqual(readLatestAgentTaskPlan(savedRows).plan, completed, 'recovery needs no process cache');
});

test('a successful tool round commits the plan alongside assistant and paired tool messages', async t => {
  const { db, sessionId } = setup(t);
  let requests = 0;
  const result = await runAgentTurn({
    db, sessionId, settings: SETTINGS, tools: [updateTaskPlanTool], userContent: '请分阶段审查。',
    complete: async () => ++requests === 1
      ? { text: '本轮先核验矛盾。', toolCalls: [call('update_task_plan', plan())] }
      : { text: '本轮计划已保存。', toolCalls: [] },
  });
  assert.equal(result.status, 'done');
  assert.deepEqual(latest(db, sessionId).plan, plan());
  const rows = listAgentMessages(db, sessionId);
  const assistant = rows.find(row => row.tool_calls_json);
  const tool = rows.find(row => row.role === 'tool');
  assert.equal(tool.tool_call_id, JSON.parse(assistant.tool_calls_json)[0].id);
  assert.deepEqual(JSON.parse(tool.content), { ok: true, saved: true });
});

test('round completion commits the user-facing stage report, snapshot and acknowledgement before terminating', async t => {
  const { db, sessionId } = setup(t);
  const completed = plan({ progress: '已审查第 0 批；mem-7 尚待 msg-8 的原文。', unresolved: ['核验 msg-8。'], next_round: '下一轮核验 msg-8，再推进第 1 批。', recommend_compaction: true, round_complete: true });
  const report = '本轮已审查第 0 批，mem-7 仍需来源 msg-8。建议手动压缩；下一轮先核验 msg-8。';
  let requests = 0;
  const result = await runAgentTurn({
    db, sessionId, settings: SETTINGS, tools: [updateTaskPlanTool], userContent: '审查第 0 批。',
    complete: async () => {
      requests += 1;
      assert.equal(requests, 1, 'stage completion must not start another model request');
      return { text: report, toolCalls: [call('update_task_plan', completed)] };
    },
  });
  assert.equal(result.status, 'terminated');
  assert.equal(requests, 1);
  assert.deepEqual(latest(db, sessionId).plan, completed);
  const rows = listAgentMessages(db, sessionId);
  const assistant = rows.find(row => row.tool_calls_json);
  assert.equal(assistant.content, report);
  const tool = rows.find(row => row.role === 'tool');
  assert.equal(tool.tool_call_id, JSON.parse(assistant.tool_calls_json)[0].id);
  assert.deepEqual(JSON.parse(tool.content), { ok: true, saved: true, round_complete: true });
});

test('invalid round-complete updates do not terminate, and the model can repair and finish', async t => {
  const { db, sessionId } = setup(t);
  const completed = plan({ round_complete: true, progress: '已核验，没有发现问题。' });
  let requests = 0;
  const result = await runAgentTurn({
    db, sessionId, settings: SETTINGS, tools: [updateTaskPlanTool], userContent: '请审查。',
    complete: async () => {
      requests += 1;
      if (requests === 1) return { text: '阶段成果。', toolCalls: [call('update_task_plan', { ...completed, steps: [] })] };
      assert.equal(latest(db, sessionId), null);
      return { text: '本轮核验已完成，下一轮继续。', toolCalls: [call('update_task_plan', completed)] };
    },
  });
  assert.equal(result.status, 'terminated');
  assert.equal(requests, 2);
  const toolRows = listAgentMessages(db, sessionId).filter(row => row.role === 'tool');
  assert.equal(JSON.parse(toolRows[0].content).ok, false);
  assert.deepEqual(JSON.parse(toolRows[1].content), { ok: true, saved: true, round_complete: true });
});

test('a completion tool write failure returns an error without terminating or saving a partial checkpoint', async t => {
  const { db, sessionId } = setup(t);
  db.exec("CREATE TRIGGER reject_task_plan_event BEFORE INSERT ON agent_messages WHEN NEW.role = 'event' AND NEW.content LIKE '%task_plan%' BEGIN SELECT RAISE(ABORT, 'fixture plan write failure'); END;");
  let requests = 0;
  const result = await runAgentTurn({
    db, sessionId, settings: SETTINGS, tools: [updateTaskPlanTool], userContent: '请完成本轮。',
    complete: async () => ++requests === 1
      ? { text: '阶段成果。', toolCalls: [call('update_task_plan', plan({ round_complete: true }))] }
      : { text: '本轮进度保存失败，请重试。', toolCalls: [] },
  });
  assert.equal(result.status, 'done');
  assert.equal(requests, 2);
  assert.equal(latest(db, sessionId), null);
  const tool = listAgentMessages(db, sessionId).find(row => row.role === 'tool');
  assert.equal(JSON.parse(tool.content).ok, false);
});

test('a failed completion-message commit rolls back the stage report and completed snapshot together', async t => {
  const { db, sessionId, ctx } = setup(t);
  updateTaskPlanTool.execute(plan(), ctx);
  const before = latest(db, sessionId);
  db.exec("CREATE TRIGGER reject_completed_tool_message BEFORE INSERT ON agent_messages WHEN NEW.role = 'tool' BEGIN SELECT RAISE(ABORT, 'fixture completion commit failure'); END;");
  const report = '未提交的阶段报告不能留在历史里。';
  const result = await runAgentTurn({
    db, sessionId, settings: SETTINGS, tools: [updateTaskPlanTool], userContent: '结束本轮。',
    complete: async () => ({ text: report, toolCalls: [call('update_task_plan', plan({ round_complete: true }))] }),
  });
  assert.equal(result.status, 'error');
  assert.deepEqual(latest(db, sessionId), before);
  assert.equal(listAgentMessages(db, sessionId).some(row => row.role === 'assistant' && row.content === report), false);
  assert.equal(listAgentMessages(db, sessionId).some(row => row.role === 'tool'), false);
});

test('a failed tool-message commit rolls back the new plan while retaining prior progress', async t => {
  const { db, sessionId, ctx } = setup(t);
  updateTaskPlanTool.execute(plan(), ctx);
  const previous = latest(db, sessionId);
  db.exec("CREATE TRIGGER reject_task_tool_message BEFORE INSERT ON agent_messages WHEN NEW.role = 'tool' BEGIN SELECT RAISE(ABORT, 'fixture commit failure'); END;");
  const result = await runAgentTurn({
    db, sessionId, settings: SETTINGS, tools: [updateTaskPlanTool], userContent: '继续。',
    complete: async () => ({ text: '', toolCalls: [call('update_task_plan', plan({ progress: '不能留下未提交进度。' }))] }),
  });
  assert.equal(result.status, 'error');
  assert.deepEqual(latest(db, sessionId), previous);
  assert.equal(listAgentMessages(db, sessionId).some(row => row.role === 'tool'), false);
});

test('aborting a read in the same round prevents the write tool from saving a plan', async t => {
  const { db, sessionId } = setup(t);
  const controller = new AbortController();
  const interruptedRead = defineReadTool({
    name: 'fixture_read', description: 'fictional read', schema: z.object({}),
    execute() { controller.abort(); return { ok: true }; },
  });
  const result = await runAgentTurn({
    db, sessionId, settings: SETTINGS, tools: [updateTaskPlanTool, interruptedRead], userContent: '请审查。', signal: controller.signal,
    complete: async () => ({ text: '准备审查。', toolCalls: [call('update_task_plan', plan()), call('fixture_read', {})] }),
  });
  assert.equal(result.status, 'aborted');
  assert.equal(latest(db, sessionId), null);
  assert.equal(listAgentMessages(db, sessionId).some(row => row.role === 'tool'), false);
});

test('a truncated model response does not execute its plan update', async t => {
  const { db, sessionId } = setup(t);
  const result = await runAgentTurn({
    db, sessionId, settings: SETTINGS, tools: [updateTaskPlanTool], userContent: '开始。',
    complete: async () => ({ text: '未完成的输出。', finishReason: 'length', toolCalls: [call('update_task_plan', plan())] }),
  });
  assert.equal(result.status, 'aborted');
  assert.equal(latest(db, sessionId), null);
});

test('plan and pending proposal commit together before the terminating turn finishes', async t => {
  const { db, sessionId } = setup(t);
  db.prepare("INSERT INTO characters (id, name) VALUES ('task-char', '虚构角色')").run();
  const snapshot = plan({ progress: '已核验依据，建议待主人批准，角色记忆尚未改变。', recommend_compaction: true });
  const result = await runAgentTurn({
    db, sessionId, settings: SETTINGS, tools: [updateTaskPlanTool, createMemoryProposalTool], userContent: '请给出提案。',
    complete: async () => ({ text: '本轮已形成建议。', toolCalls: [
      call('update_task_plan', snapshot),
      call('create_memory_proposal', {
        character_id: 'task-char', summary: '虚构建议', items: [{ op: 'create', fields: { content: '用户喜欢茶。', category: '偏好习惯' }, reason: '待确认的虚构事实。', confidence: 0.5, evidence: { message_ids: [], note: '无原文依据' } }],
      }),
    ] }),
  });
  assert.equal(result.status, 'terminated');
  assert.deepEqual(latest(db, sessionId).plan, snapshot);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM agent_proposal_items WHERE state = 'pending'").get().n, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM memories').get().n, 0);
});

test('compression records cannot replace or remove the independently persisted task plan', t => {
  const { db, sessionId, ctx } = setup(t);
  updateTaskPlanTool.execute(plan({ progress: '已核验 mem-1；msg-2 尚待取证。' }), ctx);
  const previous = latest(db, sessionId);
  appendAgentMessage(db, sessionId, { role: 'event', content: JSON.stringify({ kind: 'compaction', through_id: previous.rowId, summary: '摘要没有包含具体计划。', tokens_before: 4000 }) }, NOW);
  assert.deepEqual(latest(db, sessionId), previous);
});

test('the next request and next turn carry the latest full plan, including after manual compression', async t => {
  const { db, sessionId } = setup(t);
  const initial = plan();
  const updated = plan({ progress: '已核验 mem-21；msg-35 尚待取证。', unresolved: ['核验 mem-21 的来源 msg-35。'], recommend_compaction: true });
  const requests = [];
  const steps = [
    { text: '', toolCalls: [call('update_task_plan', initial)] },
    { text: '', toolCalls: [call('update_task_plan', updated)] },
    { text: '本轮已核验疑点，请手动压缩后继续取证。', toolCalls: [] },
  ];
  await runAgentTurn({
    db, sessionId, settings: SETTINGS, tools: [updateTaskPlanTool], userContent: '开始分阶段审查。',
    complete: async (_settings, body) => { requests.push(body); return steps.shift(); },
  });
  const injected = body => body.messages.filter(message => message.role === 'user')
    .map(message => message.content).join('\n');
  assert.equal(injected(requests[0]).includes(JSON.stringify(initial)), false);
  assert.equal(injected(requests[1]).includes(JSON.stringify(initial)), true);
  assert.equal(injected(requests[2]).includes(JSON.stringify(updated)), true);
  assert.equal(injected(requests[2]).includes(JSON.stringify(initial)), false, 'only the current snapshot is independently injected');
  assert.deepEqual(await compactAgentSession({
    db, sessionId, settings: SETTINGS, tools: [updateTaskPlanTool],
    complete: async () => ({ text: '摘要故意不包含任务计划。', toolCalls: [], completed: true }),
  }), { compacted: true });
  const history = buildAgentHistoryMessages(listAgentMessages(db, sessionId));
  assert.equal(history[0].content.includes(JSON.stringify(updated)), true);
  assert.equal(history[0].content.includes(JSON.stringify(initial)), false);
  assert.equal(history.some(message => message.role === 'tool'), false);
  let nextBody;
  await runAgentTurn({
    db, sessionId, settings: SETTINGS, tools: [updateTaskPlanTool], userContent: '继续下一轮。',
    complete: async (_settings, body) => { nextBody = body; return { text: '先核验 msg-35 的原文。', toolCalls: [] }; },
  });
  assert.equal(injected(nextBody).includes(JSON.stringify(updated)), true);
});

test('automatic compression and tool-result replacement leave the latest task plan in the request', async t => {
  const { db, sessionId, ctx } = setup(t);
  const snapshot = plan({ progress: '已读取 mem-41，仍需要依据 msg-42。', unresolved: ['核验 msg-42。'] });
  appendAgentMessage(db, sessionId, { role: 'user', content: '请核验。' }, NOW);
  updateTaskPlanTool.execute(snapshot, ctx);
  appendAgentMessage(db, sessionId, { role: 'assistant', content: '虚构的大段已结束记录。'.repeat(3000) }, NOW);
  const hugeRead = defineReadTool({
    name: 'huge_read', description: 'large fictional fixture', schema: z.object({}),
    execute: () => ({ ok: true, content: '虚构读取结果。'.repeat(5000) }),
  });
  const main = [];
  let compacted = false;
  await runAgentTurn({
    db, sessionId, settings: { ...SETTINGS, agent_context_window: 20000 }, tools: [updateTaskPlanTool, hugeRead], userContent: '继续。',
    complete: async (_settings, body) => {
      if (body.messages[0].content.includes('上下文压缩器')) {
        compacted = true;
        return { text: '摘要只包含旧对话。', toolCalls: [], completed: true };
      }
      main.push(body);
      return main.length === 1
        ? { text: '', toolCalls: [call('huge_read', {})] }
        : { text: '本轮先核验已有疑点。', toolCalls: [] };
    },
  });
  assert.equal(compacted, true);
  assert.equal(main.length, 2);
  for (const body of main) {
    assert.equal(body.messages.some(message => message.role === 'user' && message.content.includes(JSON.stringify(snapshot))), true);
  }
  assert.equal(main[1].messages.some(message => message.role === 'tool' && JSON.parse(message.content).oversized === true), true);
  assert.deepEqual(latest(db, sessionId).plan, snapshot);
});

test('planning guidance requires stage results and continuation without imposing a batch count per turn', () => {
  assert.match(AGENT_BASE_PROMPT, /复杂任务先用 update_task_plan/);
  assert.match(AGENT_BASE_PROMPT, /已读取不等于已审查/);
  assert.match(AGENT_BASE_PROMPT, /下一轮由主人再发消息开始/);
  assert.match(AGENT_BASE_PROMPT, /round_complete 为 true/);
  assert.match(AGENT_BASE_PROMPT, /不能只调用工具却不写正文/);
  assert.match(MEMORY_REVIEW_SKILL.content, /完整覆盖可以跨多轮完成/);
  assert.match(MEMORY_REVIEW_SKILL.content, /读完一批先判断疑点/);
  assert.match(MEMORY_REVIEW_SKILL.content, /不能仅凭旧 batch_index 恢复覆盖/);
  assert.match(MEMORY_REVIEW_SKILL.content, /不能只写工具参数/);
  assert.match(MEMORY_REVIEW_SKILL.content, /不继续读取下一轮资料/);
  assert.doesNotMatch(MEMORY_REVIEW_SKILL.content, /本轮最多.{0,10}批/);
});
