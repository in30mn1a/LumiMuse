const test = require('node:test');
const assert = require('node:assert/strict');
const { installMemoryOnlyTestGuard } = require('./helpers/memory-only-test-guard.cjs');
installMemoryOnlyTestGuard(test);
const { registerTsLoader } = require('./helpers/register-ts-loader.cjs');
registerTsLoader();
const { loadSample } = require('../scripts/agent-eval/fixtures.cjs');
const { runAgent, goalPrompt, createAgentModelCaller } = require('../scripts/agent-eval/agent-review.cjs');
const { aggregateScores, evaluateAgentGate, scoreRun } = require('../scripts/agent-eval/score.cjs');
const { buildAgentReport, foldedEvidenceItems } = require('../scripts/agent-eval-memory-review.cjs');
const sample = loadSample('small');

function findTool(body, name) {
  const result = body.messages.filter(message => message.role === 'tool' && message.name === name).at(-1);
  return result ? JSON.parse(result.content.split('\n', 1)[0]) : null;
}
const call = (name, args, index) => ({ id: `fixture-${name}-${index}`, name, arguments: JSON.stringify(args) });

/** 假模型根据实际工具结果继续运行，答案只用于测试计分器，不进入评测提示词。 */
function fixtureModel() {
  const states = new Map();
  const requests = [];
  const complete = async (_settings, body) => {
    requests.push(body);
    const firstUser = body.messages.find(message => message.role === 'user').content;
    const goal = firstUser.includes('只检查矛盾') ? 'conflict' : firstUser.includes('无损合并') ? 'duplicate' : 'category';
    const state = states.get(goal) ?? { step: 0 };
    states.set(goal, state);
    const index = state.step++;
    let calls = [];
    if (index === 0) calls = [call('load_skill', { name: 'memory-review' }, index), call('get_character', { character_id: 'agent-eval-character' }, index), call('get_memory_profile', { character_id: 'agent-eval-character' }, index)];
    if (index === 1) calls = [call('prepare_memory_review', { character_id: 'agent-eval-character' }, index)];
    if (index === 2) {
      const plan = findTool(body, 'prepare_memory_review');
      state.targets = goal === 'conflict' ? sample.expected.conflicts[0].memory_ids
        : goal === 'duplicate' ? sample.expected.duplicates[0].memory_ids : [sample.expected.misclassified[0].memory_id];
      calls = Array.from({ length: plan.total_batches }, (_, batch_index) => call('read_review_batch', { character_id: plan.character_id, plan_id: plan.plan_id, batch_index }, `${index}-${batch_index}`));
      calls.push(call('get_memory_sources', { memory_ids: state.targets, context: 0 }, index));
    }
    if (index === 3) {
      const sources = findTool(body, 'get_memory_sources');
      const evidence = { message_ids: sources.memories.flatMap(memory => memory.sources.map(source => source.message_id)) };
      const item = goal === 'conflict' ? { op: 'report_conflict', memory_ids: state.targets }
        : goal === 'duplicate' ? { op: 'merge', memory_ids: state.targets, fields: { content: '用户喜欢这种明确且完整的虚构习惯。' } }
          : { op: 'update', memory_id: state.targets[0], fields: { category: sample.expected.misclassified[0].expected_categories[0] } };
      calls = [call('create_memory_proposal', { character_id: 'agent-eval-character', summary: '虚构测试提案', items: [{ ...item, evidence, reason: '已检查虚构来源。', confidence: 0.9 }] }, index)];
    }
    if (index === 4) calls = [call('get_memory_sources', { memory_ids: state.targets, context: 0 }, index)];
    return { text: calls.length ? '' : '本次全部检查完毕。', toolCalls: calls };
  };
  return { complete, requests };
}

test('Agent evaluation drives the actual loop and tools, normalizes proposals and keeps memories unchanged', async () => {
  const model = fixtureModel();
  // 窗口要让「读全部批次 + 来源」那一组装得进输入可用空间（否则会被换成结果过大提示），
  // 同时后续回合超过压缩阈值，触发旧结果折叠与折叠后重读来源
  const result = await runAgent(sample, model.complete, { retryDelaysMs: [], contextWindow: 18_000 });
  assert.equal(result.incomplete, false);
  assert.equal(result.memory_unchanged, true);
  assert.equal(result.phases.length, 3);
  for (const phase of result.phases) {
    assert.equal(phase.complete, true);
    assert.equal(phase.covered_ids.length, sample.memories.length);
    assert.equal(phase.skill_loaded, true);
    assert.equal(phase.character_loaded, true);
    assert.equal(phase.profile_loaded, true);
  }
  assert.deepEqual(result.normalized.conflicts[0].source_ids.sort(), [...sample.expected.conflicts[0].memory_ids].sort());
  assert.deepEqual(result.normalized.merges[0].source_ids.sort(), [...sample.expected.duplicates[0].memory_ids].sort());
  assert.equal(result.normalized.corrections[0].id, sample.expected.misclassified[0].memory_id);
  assert.ok(result.phases.some(phase => phase.folded_results > 0 && phase.refetched_source_ids_after_fold.length > 0));
  assert.ok(model.requests.some(body => body.tools.some(tool => tool.function.name === 'read_review_batch')));
  assert.match(result.normalized.conflicts[0].evidence, /eval-msg/);
  const prompts = model.requests.map(body => body.messages.find(message => message.role === 'user').content);
  for (const prompt of prompts) {
    assert.equal(prompt.includes('expected_categories'), false);
    assert.equal(prompt.includes('c1a'), false);
    assert.equal(prompt.includes('水煮鱼'), false);
  }
});

test('a model claiming completion without reading targets is an incomplete evaluation', async () => {
  const result = await runAgent(sample, async () => ({ text: '完成了', toolCalls: [] }), { goals: ['conflict'], maxTurns: 2, retryDelaysMs: [] });
  assert.equal(result.incomplete, true);
  assert.equal(result.failure_kind, 'coverage_or_model');
  assert.equal(result.phases[0].complete, false);
  assert.equal(result.phases[0].covered_ids.length, 0);
});

test('transport failures remain incomplete and are not turned into successful empty model outputs', async () => {
  const result = await runAgent(sample, async () => { throw new Error('API error 401: fixture failure'); }, { retryDelaysMs: [] });
  assert.equal(result.incomplete, true);
  assert.equal(result.failure_kind, 'transport');
  assert.equal(result.calls[0].status, 'transport_failed');
});

test('the Agent caller redacts a configured credential before a transport error can enter evidence', async t => {
  const guard = require('../src/lib/ssrf-guard.ts');
  const original = guard.safeFetch;
  const secret = 'fixture-eval-key-43a57';
  guard.safeFetch = async () => { throw new Error(`fixture error ${secret}`); };
  t.after(() => { guard.safeFetch = original; });
  const caller = createAgentModelCaller({ apiBase: 'https://upstream.test/v1', apiKey: secret }, 'fixture-model');
  await assert.rejects(() => caller({ model: 'fixture-model', streaming: false }, { model: 'fixture-model', messages: [] }, {}), error => {
    assert.equal(error.message.includes(secret), false);
    assert.match(error.message, /\*\*\*/);
    return true;
  });
});

test('the final gate rejects fewer runs, wrong merges, recall regression and ambiguous accuracy', () => {
  const baseline = { runs: 3, conflict_recall: 0.6, accuracy_upper: 0.8, unreviewed_total: 0 };
  const passing = { runs: 3, wrong_merges_per_run: 0, conflict_recall: 0.7, accuracy_lower: 0.9, reason_coverage: 1, unreviewed_total: 0 };
  assert.equal(evaluateAgentGate(baseline, passing).pass, true);
  for (const change of [{ runs: 2 }, { wrong_merges_per_run: 1 / 3 }, { conflict_recall: 0.5 }, { accuracy_lower: 0.7, unreviewed_total: 1 }, { reason_coverage: 0.99 }]) {
    assert.equal(evaluateAgentGate(baseline, { ...passing, ...change }).pass, false);
  }
  assert.equal(evaluateAgentGate({ ...baseline, accuracy_upper: null }, passing).pass, false);
  const score = scoreRun({ conflicts: [], merges: [], corrections: [], unsupported_suggestions: [{ id: 1, op: 'retire', reason: '未获确认就退场' }] }, sample.expected);
  assert.equal(score.accuracy.wrong, 1);
  assert.equal(aggregateScores([score]).accuracy_lower, 0);
});

test('Agent report stays unverified without three runs and shows required timeline and folding checks', () => {
  const text = buildAgentReport({ model: 'fixture-model', records: {} });
  assert.match(text, /未通过或验证不足/);
  assert.match(text, /c1_c5/);
  assert.match(text, /folded_evidence/);
  assert.match(text, /旧流程 0 次；完整 Agent 0 次/);
  assert.match(goalPrompt('conflict'), /全部批次/);
});

test('folded evidence must precede and support an accepted proposal from the same goal', () => {
  const source = { goal: 'conflict', status: 'ok', folded_tools: ['read_review_batch'], tool_calls: [call('get_memory_sources', { memory_ids: ['a', 'b'] }, 1)] };
  const item = { op: 'report_conflict', memory_ids: ['a', 'b'], reason: '原文相互矛盾', evidence: { message_ids: ['eval-msg-a-0', 'eval-msg-b-0'] } };
  const proposal = { goal: 'conflict', status: 'ok', folded_tools: [], tool_calls: [call('create_memory_proposal', { items: [item] }, 2)] };
  const record = {
    phases: [{ goal: 'conflict', refetched_source_ids_after_fold: ['a', 'b'] }],
    calls: [source, proposal],
    normalized: { conflicts: [{ source_ids: ['a', 'b'], reason: item.reason, evidence: JSON.stringify(item.evidence.message_ids) }], merges: [], corrections: [] },
  };
  assert.equal(foldedEvidenceItems(record).length, 1);
  assert.equal(foldedEvidenceItems({ ...record, calls: [proposal, source] }).length, 0);
  assert.equal(foldedEvidenceItems({ ...record, calls: [{ ...source, folded_tools: [] }, proposal] }).length, 0);
  assert.equal(foldedEvidenceItems({ ...record, calls: [source, { ...proposal, goal: 'duplicate' }] }).length, 0);
  assert.equal(foldedEvidenceItems({ ...record, normalized: { conflicts: [], merges: [], corrections: [] } }).length, 0);
  const unrelatedSource = { ...source, tool_calls: [call('get_memory_sources', { memory_ids: ['x', 'y'] }, 1)] };
  assert.equal(foldedEvidenceItems({ ...record, calls: [unrelatedSource, proposal] }).length, 0);
  const unrelatedEvidence = { ...proposal, tool_calls: [call('create_memory_proposal', { items: [{ ...item, evidence: { message_ids: ['eval-msg-x-0'] } }] }, 2)] };
  assert.equal(foldedEvidenceItems({ ...record, calls: [source, unrelatedEvidence] }).length, 0);
  assert.equal(foldedEvidenceItems({ ...record, calls: [{ ...source, tool_calls: [...source.tool_calls, ...proposal.tool_calls] }] }).length, 0);
  const rejectedCalls = { ...source, tool_calls: [call('get_memory_sources', null, 0), call('get_memory_sources', { memory_ids: 'a' }, 0), call('create_memory_proposal', { items: [null] }, 0)] };
  assert.equal(foldedEvidenceItems({ ...record, calls: [rejectedCalls, source, proposal] }).length, 1);
});
