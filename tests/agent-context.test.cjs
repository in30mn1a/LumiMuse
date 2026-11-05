const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { z } = require('zod');
const { registerTsLoader } = require('./helpers/register-ts-loader.cjs');

registerTsLoader();

const { __migrateForTests, __setDbForTests } = require('../src/lib/db.ts');
const { DEFAULT_SETTINGS } = require('../src/types/index.ts');
const { estimateTokens } = require('../src/lib/token-counter.ts');
const { defineReadTool } = require('../src/lib/agent/tools/types.ts');
const { toolDefinitions } = require('../src/lib/agent/tools/registry.ts');
const { appendAgentMessage, createAgentSession, listAgentMessages } = require('../src/lib/agent/store.ts');
const {
  agentCalibrationRatio,
  agentCompactThreshold,
  agentOutputReserve,
  readAgentLastUsage,
  saveAgentLastUsage,
} = require('../src/lib/agent/context.ts');
const { COMPACTION_SYSTEM_PROMPT, compactAgentHistory } = require('../src/lib/agent/compaction.ts');
const {
  COMPACT_FAILED_NOTE,
  CONTEXT_OVER_LIMIT_NOTE,
  buildAgentHistoryMessages,
  getAgentContextStatus,
  runAgentTurn,
} = require('../src/lib/agent/loop.ts');

const BASE_SETTINGS = {
  ...DEFAULT_SETTINGS,
  api_base: 'http://upstream.test/v1',
  api_key: 'agent-context-test-key',
  model: 'agent-test-model',
  streaming: false,
};
/** 预留 16384 时，20000 的窗口阈值为 floor(10000 * 0.8) = 8000 */
const SMALL = { ...BASE_SETTINGS, agent_context_window: 20000 };

let clock = 0;
const now = () => new Date(Date.UTC(2026, 10, 5, 12, 0, 0) + (clock += 1000)).toISOString();

function setup(t) {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  __migrateForTests(db);
  __setDbForTests(db);
  t.after(() => {
    __setDbForTests(null);
    db.close();
  });
  const session = createAgentSession(db, {}, now());
  return { db, sessionId: session.id };
}

const lookup = defineReadTool({
  name: 'lookup',
  description: 'fixture lookup',
  schema: z.object({ a: z.number() }),
  execute: args => ({ ok: true, value: args.a }),
});

/** 约 n 个 token 的虚构文本 */
function filler(label, n) {
  return Array.from({ length: Math.ceil(n / 7.2) }, (_, i) => `${label} line ${i} about tea.`).join(' ');
}

function isCompactionRequest(body) {
  return body.messages[0]?.content === COMPACTION_SYSTEM_PROMPT;
}

/**
 * 假上游：压缩请求交给 `summarize`，其余请求按顺序走 `main`。
 * 记录所有请求体快照。
 */
function fakeUpstream({ summarize = () => ({ text: '摘要：主人想整理星野的记忆，已看过 mem-1。' }), main }) {
  const requests = [];
  const compactions = [];
  let mainIndex = 0;
  const complete = async (_settings, body, options) => {
    const snapshot = JSON.parse(JSON.stringify(body));
    requests.push(snapshot);
    if (isCompactionRequest(body)) {
      compactions.push(snapshot);
      const result = await summarize(snapshot, options, compactions.length);
      return { text: '', toolCalls: [], completed: true, ...result };
    }
    const step = main[mainIndex];
    mainIndex += 1;
    if (!step) throw new Error(`unexpected main request #${mainIndex}`);
    const result = typeof step === 'function' ? await step(snapshot, options) : step;
    return { text: '', toolCalls: [], completed: true, ...result };
  };
  return { complete, requests, compactions, mainRequests: () => requests.filter(body => !isCompactionRequest(body)) };
}

/** 写入一段较早的对话：一问一答加一组工具调用 */
/** 默认约 7300 token：加上系统提示超过 8000 的阈值，单条又放得进一次摘要请求 */
function seedHistory(db, sessionId, tokens = 7300) {
  const ids = [];
  ids.push(appendAgentMessage(db, sessionId, { role: 'user', content: '先看看星野的记忆' }, now()));
  ids.push(appendAgentMessage(db, sessionId, {
    role: 'assistant',
    content: '',
    tool_calls_json: JSON.stringify([{ id: 'old-1', type: 'function', function: { name: 'lookup', arguments: '{"a":1}' } }]),
  }, now()));
  ids.push(appendAgentMessage(db, sessionId, {
    role: 'tool', content: '{"ok":true,"value":1}', tool_call_id: 'old-1', tool_name: 'lookup',
  }, now()));
  ids.push(appendAgentMessage(db, sessionId, { role: 'assistant', content: filler('old', tokens) }, now()));
  return ids;
}

function compactionEvents(db, sessionId) {
  return listAgentMessages(db, sessionId)
    .filter(row => row.role === 'event')
    .map(row => JSON.parse(row.content))
    .filter(payload => payload.kind === 'compaction');
}

// ---- 阈值与校准 ----

test('the compact threshold reserves output space and keeps half the window for small windows', () => {
  assert.equal(agentOutputReserve({ max_tokens: 4096 }), 16384);
  assert.equal(agentOutputReserve({ max_tokens: 32000 }), 32000);
  assert.equal(agentCompactThreshold(272000, 16384), Math.floor((272000 - 16384) * 0.8));
  assert.equal(agentCompactThreshold(20000, 16384), 8000);
  assert.equal(agentCompactThreshold(10000, 16384), 4000);
});

test('calibration scales both ways within bounds and ignores other models', () => {
  const usage = (prompt, estimated, model = 'm') => ({
    model, prompt_tokens: prompt, completion_tokens: 1, estimated_prompt_tokens: estimated, at: '',
  });
  assert.equal(agentCalibrationRatio(null, 'm'), 1);
  assert.equal(agentCalibrationRatio(usage(150, 100), 'm'), 1.5);
  // 实测：本地估 203872，上游 137934
  assert.equal(agentCalibrationRatio(usage(137934, 203872), 'm'), 137934 / 203872);
  assert.equal(agentCalibrationRatio(usage(10, 100), 'm'), 0.5);
  assert.equal(agentCalibrationRatio(usage(1000, 100), 'm'), 3);
  assert.equal(agentCalibrationRatio(usage(150, 100, 'other'), 'm'), 1);
  assert.equal(agentCalibrationRatio(usage(150, 0), 'm'), 1);
  assert.equal(agentCalibrationRatio(usage(0, 100), 'm'), 1);
});

test('the last_usage_json column is added once and survives a second migration', t => {
  const { db, sessionId } = setup(t);
  __migrateForTests(db);
  const cols = db.prepare('PRAGMA table_info(agent_sessions)').all().map(col => col.name);
  assert.equal(cols.filter(name => name === 'last_usage_json').length, 1);
  assert.equal(readAgentLastUsage(db, sessionId), null);
  db.prepare('UPDATE agent_sessions SET last_usage_json = ? WHERE id = ?').run('{broken', sessionId);
  assert.equal(readAgentLastUsage(db, sessionId), null);
});

// ---- 历史组装 ----

test('history after a compaction starts with the summary merged into the next user message', t => {
  const { db, sessionId } = setup(t);
  const ids = seedHistory(db, sessionId, 200);
  const userId = appendAgentMessage(db, sessionId, { role: 'user', content: '继续整理' }, now());
  appendAgentMessage(db, sessionId, {
    role: 'event', content: JSON.stringify({ kind: 'compaction', through_id: ids[1], summary: '旧摘要', tokens_before: 1 }),
  }, now());
  appendAgentMessage(db, sessionId, {
    role: 'event', content: JSON.stringify({ kind: 'compaction', through_id: ids[3], summary: '新摘要', tokens_before: 2 }),
  }, now());
  appendAgentMessage(db, sessionId, {
    role: 'assistant',
    content: '',
    tool_calls_json: JSON.stringify([{ id: 'new-1', type: 'function', function: { name: 'lookup', arguments: '{"a":2}' } }]),
  }, now());
  appendAgentMessage(db, sessionId, {
    role: 'tool', content: '{"ok":true,"value":2}', tool_call_id: 'new-1', tool_name: 'lookup',
  }, now());

  const messages = buildAgentHistoryMessages(listAgentMessages(db, sessionId));
  assert.equal(messages.length, 3);
  assert.equal(messages[0].role, 'user');
  assert.match(messages[0].content, /较早的对话已压缩/);
  assert.match(messages[0].content, /新摘要\n\n继续整理$/);
  assert.equal(messages[0].content.includes('旧摘要'), false);
  assert.equal(JSON.stringify(messages).includes('old line'), false);
  assert.deepEqual(messages[1].tool_calls.map(call => call.id), ['new-1']);
  assert.equal(messages[2].tool_call_id, 'new-1');
  assert.ok(userId > ids[3]);
});

test('a compaction event with an unusable payload is ignored', t => {
  const { db, sessionId } = setup(t);
  seedHistory(db, sessionId, 100);
  appendAgentMessage(db, sessionId, {
    role: 'event', content: JSON.stringify({ kind: 'compaction', through_id: 'x', summary: '', tokens_before: 0 }),
  }, now());
  const messages = buildAgentHistoryMessages(listAgentMessages(db, sessionId));
  assert.equal(messages[0].content, '先看看星野的记忆');
  assert.equal(messages.length, 4);
});

// ---- 状态 ----

test('an empty session reports the system prompt and tool definitions as its usage', t => {
  const { db, sessionId } = setup(t);
  const status = getAgentContextStatus(db, sessionId, { tools: [lookup], settings: BASE_SETTINGS });
  assert.equal(status.window, 272000);
  assert.equal(status.threshold, agentCompactThreshold(272000, 16384));
  assert.equal(status.last_usage, null);
  assert.ok(status.used > estimateTokens(JSON.stringify(toolDefinitions([lookup]))));
  assert.equal(getAgentContextStatus(db, 'missing', { tools: [lookup], settings: BASE_SETTINGS }), null);
});

test('usage is stored with the estimate it was measured against and calibrates the status', async t => {
  const { db, sessionId } = setup(t);
  const { complete } = fakeUpstream({
    main: [(_body, options) => {
      options.onUsage?.({ prompt_tokens: 99999, completion_tokens: 12, total_tokens: 100011, prompt_tokens_details: { cached_tokens: 64 } });
      return { text: '好的' };
    }],
  });
  const contexts = [];
  await runAgentTurn({
    db, sessionId, userContent: '你好', tools: [lookup], settings: BASE_SETTINGS, complete, now,
    events: { onContext: status => contexts.push(status) },
  });
  const stored = readAgentLastUsage(db, sessionId);
  assert.equal(stored.model, 'agent-test-model');
  assert.equal(stored.prompt_tokens, 99999);
  assert.equal(stored.cached_tokens, 64);
  assert.equal(stored.estimated_prompt_tokens, contexts[0].used);

  const status = getAgentContextStatus(db, sessionId, { tools: [lookup], settings: BASE_SETTINGS });
  assert.deepEqual(status.last_usage, { prompt_tokens: 99999, completion_tokens: 12, cached_tokens: 64 });
  // 校准系数封顶为 3
  const raw = getAgentContextStatus(db, sessionId, { tools: [lookup], settings: { ...BASE_SETTINGS, agent_model: 'other-model' } }).used;
  assert.ok(Math.abs(status.used - raw * 3) <= 3, `${status.used} vs ${raw * 3}`);
});

test('the context event matches the estimate of what is actually sent', async t => {
  const { db, sessionId } = setup(t);
  const { complete, requests } = fakeUpstream({ main: [{ toolCalls: [{ id: 'c1', name: 'lookup', arguments: '{"a":1}' }] }, { text: '完成' }] });
  const contexts = [];
  await runAgentTurn({
    db, sessionId, userContent: '查一下', tools: [lookup], settings: BASE_SETTINGS, complete, now,
    events: { onContext: status => contexts.push(status) },
  });
  assert.equal(contexts.length, 2);
  requests.forEach((body, index) => {
    const expected = estimateTokens(body.messages[0].content)
      + estimateTokens(JSON.stringify(body.tools))
      + body.messages.slice(1).reduce((sum, message) => sum + estimateTokens(JSON.stringify(message)), 0);
    assert.equal(contexts[index].used, expected);
    assert.equal(contexts[index].window, 272000);
  });
  assert.ok(contexts[1].used > contexts[0].used);
});

// ---- 自动压缩 ----

test('crossing the threshold compacts earlier history once and sends only the summary and this turn', async t => {
  const { db, sessionId } = setup(t);
  const ids = seedHistory(db, sessionId);
  const before = listAgentMessages(db, sessionId).map(row => ({ ...row }));
  const { complete, compactions, mainRequests } = fakeUpstream({ main: [{ text: '接着整理。' }] });
  const phases = [];
  const contexts = [];
  const result = await runAgentTurn({
    db, sessionId, userContent: '继续', tools: [lookup], settings: SMALL, complete, now,
    events: { onCompaction: event => phases.push(event), onContext: status => contexts.push(status) },
  });
  assert.equal(result.status, 'done');

  assert.equal(compactions.length, 1);
  const transcript = compactions[0].messages[1].content;
  assert.match(transcript, /【主人】\n先看看星野的记忆/);
  assert.match(transcript, /→ 调用 lookup \{"a":1\}/);
  assert.match(transcript, /【工具结果 lookup】/);
  assert.equal(transcript.includes('【已有摘要】'), false);
  assert.equal(compactions[0].tools, undefined);
  assert.equal(compactions[0].max_tokens, 16384);

  const sent = mainRequests()[0].messages;
  assert.equal(sent.length, 2);
  assert.match(sent[1].content, /摘要：主人想整理星野的记忆/);
  assert.match(sent[1].content, /继续$/);
  assert.equal(JSON.stringify(sent).includes('old line'), false);

  const events = compactionEvents(db, sessionId);
  assert.equal(events.length, 1);
  assert.equal(events[0].through_id, ids[3]);
  assert.ok(events[0].tokens_before > 8000);
  assert.deepEqual(phases.map(event => event.phase), ['start', 'done']);
  assert.equal(phases[1].through_id, ids[3]);
  assert.ok(contexts[0].used < contexts[0].threshold);

  // 原始消息一条不少、一字不改
  const after = listAgentMessages(db, sessionId);
  for (const row of before) assert.deepEqual(after.find(item => item.id === row.id), row);
});

test('the same history is not compacted twice within a turn even when the turn itself stays over the limit', async t => {
  const { db, sessionId } = setup(t);
  seedHistory(db, sessionId);
  const { complete, compactions, mainRequests } = fakeUpstream({
    main: [{ toolCalls: [{ id: 'c1', name: 'lookup', arguments: '{"a":1}' }] }, { text: '好' }],
  });
  const notes = [];
  await runAgentTurn({
    db, sessionId, userContent: filler('huge request', 9000), tools: [lookup], settings: SMALL, complete, now,
    events: { onNote: note => notes.push(note) },
  });
  assert.equal(compactions.length, 1);
  assert.equal(mainRequests().length, 2);
  assert.deepEqual(notes, [CONTEXT_OVER_LIMIT_NOTE]);
});

test('a later compaction folds the previous summary into the new one', async t => {
  const { db, sessionId } = setup(t);
  seedHistory(db, sessionId);
  const first = fakeUpstream({ summarize: () => ({ text: '第一份摘要' }), main: [{ text: filler('reply', 7300) }] });
  await runAgentTurn({ db, sessionId, userContent: '继续', tools: [lookup], settings: SMALL, complete: first.complete, now });
  assert.equal(first.compactions.length, 1);

  const second = fakeUpstream({ summarize: () => ({ text: '第二份摘要' }), main: [{ text: '好' }] });
  await runAgentTurn({ db, sessionId, userContent: '再继续', tools: [lookup], settings: SMALL, complete: second.complete, now });
  assert.equal(second.compactions.length, 1);
  const transcript = second.compactions[0].messages[1].content;
  assert.match(transcript, /^【已有摘要】\n第一份摘要/);
  assert.match(transcript, /【主人】\n继续/);
  assert.equal(transcript.includes('old line'), false);

  const sent = second.mainRequests()[0].messages;
  assert.equal(sent.length, 2);
  assert.match(sent[1].content, /第二份摘要\n\n再继续$/);
  assert.equal(compactionEvents(db, sessionId).length, 2);
});

test('a failed compaction falls back to folding, notes once and does not retry within the turn', async t => {
  const { db, sessionId } = setup(t);
  seedHistory(db, sessionId);
  const { complete, compactions, mainRequests } = fakeUpstream({
    summarize: () => { throw new Error('upstream 502'); },
    main: [{ toolCalls: [{ id: 'c1', name: 'lookup', arguments: '{"a":1}' }] }, { text: '好' }],
  });
  const notes = [];
  const phases = [];
  const result = await runAgentTurn({
    db, sessionId, userContent: '继续', tools: [lookup], settings: SMALL, complete, now,
    events: { onNote: note => notes.push(note), onCompaction: event => phases.push(event.phase) },
  });
  assert.equal(result.status, 'done');
  assert.equal(compactions.length, 1);
  assert.equal(mainRequests().length, 2);
  assert.deepEqual(phases, ['start', 'failed']);
  assert.equal(notes[0], COMPACT_FAILED_NOTE);
  assert.equal(notes.filter(note => note === COMPACT_FAILED_NOTE).length, 1);
  assert.equal(compactionEvents(db, sessionId).length, 0);
  // 退回原有的工具结果折叠：第二个回合里较早的结果变成占位
  const firstTool = mainRequests()[1].messages.find(message => message.role === 'tool');
  assert.equal(JSON.parse(firstTool.content).folded, true);
});

test('an empty or truncated summary counts as a failure', async t => {
  for (const reply of [{ text: '   ' }, { text: '半截', finishReason: 'length' }, { text: '半截', completed: false }]) {
    await t.test(JSON.stringify(reply), async t2 => {
      const { db, sessionId } = setup(t2);
      seedHistory(db, sessionId);
      const { complete } = fakeUpstream({ summarize: () => reply, main: [{ text: '好' }] });
      const notes = [];
      await runAgentTurn({
        db, sessionId, userContent: '继续', tools: [lookup], settings: SMALL, complete, now,
        events: { onNote: note => notes.push(note) },
      });
      assert.equal(notes[0], COMPACT_FAILED_NOTE);
      assert.equal(compactionEvents(db, sessionId).length, 0);
    });
  }
});

test('stopping during compaction ends the turn without writing a compaction record', async t => {
  const { db, sessionId } = setup(t);
  seedHistory(db, sessionId);
  const controller = new AbortController();
  const { complete, mainRequests } = fakeUpstream({
    summarize: () => {
      controller.abort();
      throw new Error('aborted');
    },
    main: [],
  });
  const result = await runAgentTurn({
    db, sessionId, userContent: '继续', tools: [lookup], settings: SMALL, complete, now, signal: controller.signal,
  });
  assert.equal(result.status, 'aborted');
  assert.equal(mainRequests().length, 0);
  assert.equal(compactionEvents(db, sessionId).length, 0);
  const last = listAgentMessages(db, sessionId).at(-1);
  assert.deepEqual(JSON.parse(last.content), { kind: 'interrupted' });
});

test('history that fits is never compacted', async t => {
  const { db, sessionId } = setup(t);
  seedHistory(db, sessionId, 200);
  const { complete, compactions } = fakeUpstream({ main: [{ text: '好' }] });
  await runAgentTurn({ db, sessionId, userContent: '继续', tools: [lookup], settings: SMALL, complete, now });
  assert.equal(compactions.length, 0);
});

test('a first turn with no earlier history folds instead of compacting', async t => {
  const { db, sessionId } = setup(t);
  const { complete, compactions } = fakeUpstream({ main: [{ text: '好' }] });
  const notes = [];
  await runAgentTurn({
    db, sessionId, userContent: filler('huge', 9000), tools: [lookup], settings: SMALL, complete, now,
    events: { onNote: note => notes.push(note) },
  });
  assert.equal(compactions.length, 0);
  assert.deepEqual(notes, [CONTEXT_OVER_LIMIT_NOTE]);
});

test('real usage from the same model makes compaction start earlier', async t => {
  for (const [model, expected] of [['agent-test-model', 1], ['another-model', 0]]) {
    await t.test(model, async t2 => {
      const { db, sessionId } = setup(t2);
      seedHistory(db, sessionId, 4500);
      // 上次真实输入是估算的 2 倍：约 6000 的估算按 12000 计，超过 8000 的阈值
      saveAgentLastUsage(db, sessionId, {
        model, prompt_tokens: 2000, completion_tokens: 1, estimated_prompt_tokens: 1000, at: '',
      });
      const { complete, compactions } = fakeUpstream({ main: [{ text: '好' }] });
      await runAgentTurn({ db, sessionId, userContent: '继续', tools: [lookup], settings: SMALL, complete, now });
      if (expected) assert.ok(compactions.length >= 1);
      else assert.equal(compactions.length, 0);
      assert.equal(compactionEvents(db, sessionId).length, expected);
    });
  }
});

test('real usage below the estimate lets compaction wait until it is really needed', async t => {
  // 默认历史的估算超过 8000 的阈值；上次真实输入只有估算的六成时按真实量计，不必压缩
  for (const [label, usage, expected] of [
    ['uncalibrated', null, 1],
    ['calibrated down', { model: 'agent-test-model', prompt_tokens: 600, completion_tokens: 1, estimated_prompt_tokens: 1000, at: '' }, 0],
  ]) {
    await t.test(label, async t2 => {
      const { db, sessionId } = setup(t2);
      seedHistory(db, sessionId);
      if (usage) saveAgentLastUsage(db, sessionId, usage);
      const { complete, compactions } = fakeUpstream({ main: [{ text: '好' }] });
      await runAgentTurn({ db, sessionId, userContent: '继续', tools: [lookup], settings: SMALL, complete, now });
      assert.equal(compactions.length > 0 ? 1 : 0, expected);
      assert.equal(compactionEvents(db, sessionId).length, expected);
    });
  }
});

// ---- 思考链 ----

const fragments = text => [...text].map(char => ({ type: 'reasoning.text', text: char, format: 'unknown', index: 0 }));

test('streamed reasoning fragments are merged per block and unknown parts are kept in place', () => {
  const { mergeReasoningDetails, compactAssistantFields } = require('../src/lib/agent/reasoning.ts');
  const signedTail = { type: 'reasoning.text', text: '。', format: 'anthropic-claude-v1', index: 1, signature: 'sig-1' };
  const merged = mergeReasoningDetails([
    ...fragments('先查'),
    { type: 'reasoning.text', text: '记忆', format: 'unknown', index: 0, id: 'r1' },
    { type: 'reasoning.text', text: '另一块', format: 'anthropic-claude-v1', index: 1 },
    signedTail,
    { type: 'reasoning.text', text: '签名后的新块', format: 'anthropic-claude-v1', index: 1 },
    { type: 'reasoning.encrypted', data: 'opaque' },
    { type: 'reasoning.text', text: '加密之后', format: 'unknown', index: 0 },
    { type: 'reasoning.text', text: '带陌生字段', format: 'unknown', index: 0, extra: true },
  ]);
  assert.deepEqual(merged, [
    { type: 'reasoning.text', text: '先查记忆', format: 'unknown', index: 0, id: 'r1' },
    { type: 'reasoning.text', text: '另一块。', format: 'anthropic-claude-v1', index: 1, signature: 'sig-1' },
    { type: 'reasoning.text', text: '签名后的新块', format: 'anthropic-claude-v1', index: 1 },
    { type: 'reasoning.encrypted', data: 'opaque' },
    { type: 'reasoning.text', text: '加密之后', format: 'unknown', index: 0 },
    { type: 'reasoning.text', text: '带陌生字段', format: 'unknown', index: 0, extra: true },
  ]);
  const fields = { reasoning_content: '原样', reasoning_details: fragments('一二三') };
  assert.deepEqual(compactAssistantFields(fields), { reasoning_content: '原样', reasoning_details: [{ type: 'reasoning.text', text: '一二三', format: 'unknown', index: 0 }] });
  const plain = { reasoning_content: '只有文本' };
  assert.equal(compactAssistantFields(plain), plain);
});

test('reasoning is stored and replayed merged, and a finished turn no longer counts it', async t => {
  const { db, sessionId } = setup(t);
  const thinking = '我先想想要查哪些记忆，再决定怎么回答。'.repeat(20);
  const { complete, requests } = fakeUpstream({
    main: [
      { toolCalls: [{ id: 'c1', name: 'lookup', arguments: '{"a":1}' }], assistantFields: { reasoning_details: fragments(thinking) } },
      { text: '查完了', assistantFields: { reasoning_details: fragments(thinking) } },
    ],
  });
  await runAgentTurn({ db, sessionId, userContent: '查一下', tools: [lookup], settings: BASE_SETTINGS, complete, now });

  const stored = listAgentMessages(db, sessionId).filter(row => row.role === 'assistant')
    .map(row => JSON.parse(row.assistant_fields_json).reasoning_details);
  assert.deepEqual(stored, [
    [{ type: 'reasoning.text', text: thinking, format: 'unknown', index: 0 }],
    [{ type: 'reasoning.text', text: thinking, format: 'unknown', index: 0 }],
  ]);
  const replayed = requests[1].messages.find(message => message.role === 'assistant');
  assert.deepEqual(replayed.reasoning_details, [{ type: 'reasoning.text', text: thinking, format: 'unknown', index: 0 }]);

  // 这一轮已结束：下次请求不带思考链，空闲占用也不算它
  const status = getAgentContextStatus(db, sessionId, { tools: [lookup], settings: BASE_SETTINGS });
  const withoutReasoning = estimateTokens(JSON.stringify(requests[1].tools))
    + estimateTokens(requests[1].messages[0].content)
    + buildAgentHistoryMessages(listAgentMessages(db, sessionId))
      .map(message => {
        const { reasoning_details: _dropped, ...rest } = message;
        return estimateTokens(JSON.stringify(rest));
      })
      .reduce((sum, tokens) => sum + tokens, 0);
  assert.equal(status.used, withoutReasoning);
});

// ---- 滚动摘要 ----

test('oversized history is summarized in rolling chunks, carrying each summary forward', async () => {
  const calls = [];
  const complete = async (_settings, body) => {
    calls.push(body.messages[1].content);
    return { text: `摘要${calls.length}`, toolCalls: [], completed: true };
  };
  const big = label => filler(label, 1500);
  const summary = await compactAgentHistory({
    blocks: [big('a'), big('b'), big('c'), filler('giant', 20000)],
    previousSummary: '最初摘要',
    settings: BASE_SETTINGS,
    complete,
    inputBudget: 3000,
    maxTokens: 1000,
    streaming: false,
    timeoutMs: 0,
  });
  assert.ok(calls.length >= 3, `expected rolling calls, got ${calls.length}`);
  assert.match(calls[0], /^【已有摘要】\n最初摘要/);
  for (let i = 1; i < calls.length; i += 1) assert.match(calls[i], new RegExp(`^【已有摘要】\\n摘要${i}\\n`));
  assert.equal(summary, `摘要${calls.length}`);
  const last = calls.at(-1);
  assert.match(last, /摘要输入中只保留了开头/);
  assert.ok(estimateTokens(last) < 3000 + 200, `last chunk ${estimateTokens(last)}`);
  for (const label of ['a line', 'b line', 'c line']) assert.ok(calls.some(content => content.includes(label)));
});

// ---- 流解析与实时状态 ----

test('compaction requests use the same real-usage calibration as the main request', async t => {
  const { db, sessionId } = setup(t);
  appendAgentMessage(db, sessionId, { role: 'user', content: '检查虚构记录' }, now());
  appendAgentMessage(db, sessionId, { role: 'assistant', content: ' A'.repeat(150000) }, now());
  saveAgentLastUsage(db, sessionId, {
    model: BASE_SETTINGS.model, prompt_tokens: 2000, completion_tokens: 1, estimated_prompt_tokens: 1000, at: '',
  });
  const requests = [];
  const result = await runAgentTurn({
    db, sessionId, userContent: '继续', tools: [], settings: BASE_SETTINGS, now,
    complete: async (_settings, body) => {
      const input = body.messages.reduce((sum, message) => sum + estimateTokens(message.content), 0);
      requests.push({ compaction: isCompactionRequest(body), input });
      if (input * 2 + body.max_tokens > BASE_SETTINGS.agent_context_window) throw new Error('fixture context length exceeded');
      return { text: '已检查虚构记录。', toolCalls: [], completed: true };
    },
  });
  assert.equal(result.status, 'done');
  assert.ok(requests.some(request => request.compaction));
  const rawBudget = Math.floor(agentCompactThreshold(272000, 16384) / 2);
  for (const request of requests.filter(request => request.compaction)) assert.ok(request.input <= rawBudget);
  assert.equal(compactionEvents(db, sessionId).length, 1);
});

test('truncating a token-dense prefix checks the complete summary request budget', async () => {
  const requests = [];
  await compactAgentHistory({
    blocks: [Array.from({ length: 800 }, (_, index) => `汉😀编号${index} `).join('') + ' hello'.repeat(5000)],
    previousSummary: null, settings: BASE_SETTINGS,
    complete: async (_settings, body) => {
      requests.push(body);
      return { text: '虚构摘要', toolCalls: [], completed: true };
    },
    inputBudget: 3000, maxTokens: 1000, streaming: false, timeoutMs: 0,
  });
  assert.equal(requests.length, 1);
  assert.match(requests[0].messages[1].content, /摘要输入中只保留了开头/);
  const input = requests[0].messages.reduce((sum, message) => sum + estimateTokens(message.content), 0);
  assert.ok(input <= 3000, `sent ${input} tokens with a 3000 token input budget`);
});

test('a large previous summary is reduced before consuming the room for new records', async () => {
  const requests = [];
  const previous = ' A'.repeat(2500);
  await compactAgentHistory({
    blocks: [' B'.repeat(1500)], previousSummary: previous, settings: BASE_SETTINGS,
    complete: async (_settings, body) => {
      requests.push(body);
      const input = body.messages.reduce((sum, message) => sum + estimateTokens(message.content), 0);
      assert.ok(input <= 3000, `sent ${input} tokens with a 3000 token input budget`);
      return { text: '精简的虚构摘要', toolCalls: [], completed: true };
    },
    inputBudget: 3000, maxTokens: 1000, streaming: false, timeoutMs: 0,
  });
  assert.equal(requests.length, 2);
  assert.ok(requests[0].messages[1].content.includes(previous.trim()));
  assert.equal(requests[0].messages[1].content.includes(' B'), false);
  assert.match(requests[1].messages[1].content, /精简的虚构摘要/);
  assert.ok(requests[1].messages[1].content.includes(' B'));
});

test('a previous summary that cannot fit fails without sending an oversized request', async () => {
  let calls = 0;
  await assert.rejects(compactAgentHistory({
    blocks: ['虚构的新记录'], previousSummary: ' A'.repeat(4000), settings: BASE_SETTINGS,
    complete: async () => {
      calls += 1;
      return { text: '摘要', toolCalls: [], completed: true };
    },
    inputBudget: 3000, maxTokens: 1000, streaming: false, timeoutMs: 0,
  }));
  assert.equal(calls, 0);
});

test('an oversized rolling summary fails before sending the next chunk', async () => {
  let calls = 0;
  await assert.rejects(compactAgentHistory({
    blocks: [' hello'.repeat(1800), ' goodbye'.repeat(1800)], previousSummary: null, settings: BASE_SETTINGS,
    complete: async (_settings, body) => {
      calls += 1;
      const input = body.messages.reduce((sum, message) => sum + estimateTokens(message.content), 0);
      assert.ok(input <= 3000);
      return { text: ' summary'.repeat(3200), toolCalls: [], completed: true };
    },
    inputBudget: 3000, maxTokens: 16384, streaming: false, timeoutMs: 0,
  }));
  assert.equal(calls, 1);
});

function sseStream(text) {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text));
      controller.close();
    },
  });
}

test('context and compaction stream events are parsed and malformed ones dropped', async () => {
  const { readAgentStream } = require('../src/hooks/agent/agent-stream.ts');
  const frames = [
    ['context', { window: 272000, used: 5000, threshold: 204492, last_usage: { prompt_tokens: 4800, completion_tokens: 30, cached_tokens: 4000 } }],
    ['context', { window: 272000, used: 5000, threshold: 204492, last_usage: null }],
    ['context', { window: 0, used: 1, threshold: 1 }],
    ['context', { window: 1000, used: 'x', threshold: 1 }],
    ['compaction', { phase: 'start' }],
    ['compaction', { phase: 'done', summary: '摘要', tokens_before: 9000, through_id: 4 }],
    ['compaction', { phase: 'done', summary: '' }],
    ['compaction', { phase: 'failed' }],
    ['compaction', { phase: 'weird' }],
    ['usage', { prompt_tokens: 1 }],
  ];
  const events = [];
  await readAgentStream(sseStream(frames.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join('')), event => events.push(event));
  assert.deepEqual(events, [
    { type: 'context', context: { window: 272000, used: 5000, threshold: 204492, last_usage: { prompt_tokens: 4800, completion_tokens: 30, cached_tokens: 4000 } } },
    { type: 'context', context: { window: 272000, used: 5000, threshold: 204492, last_usage: null } },
    { type: 'compaction', phase: 'start' },
    { type: 'compaction', phase: 'done', summary: '摘要', tokensBefore: 9000 },
    { type: 'compaction', phase: 'failed' },
  ]);
});

test('live compaction segments run, finish in place, and disappear on failure', () => {
  const { applyAgentStreamEvent } = require('../src/hooks/agent/useAgentChat.ts');
  const base = { sessionId: 's', userContent: 'u', afterMessageId: 0, segments: [], error: null, context: null };
  let turn = applyAgentStreamEvent(base, { type: 'compaction', phase: 'start' });
  turn = applyAgentStreamEvent(turn, { type: 'text', text: '后面的回复' });
  assert.deepEqual(turn.segments.map(segment => segment.kind), ['compaction', 'text']);
  turn = applyAgentStreamEvent(turn, { type: 'compaction', phase: 'done', summary: '摘要', tokensBefore: 9000 });
  assert.deepEqual(turn.segments[0], { kind: 'compaction', state: 'done', summary: '摘要', tokensBefore: 9000 });
  assert.equal(turn.segments[1].kind, 'text');

  let failed = applyAgentStreamEvent(base, { type: 'compaction', phase: 'start' });
  failed = applyAgentStreamEvent(failed, { type: 'compaction', phase: 'failed' });
  assert.deepEqual(failed.segments, []);

  const context = { window: 100, used: 10, threshold: 80, last_usage: null };
  assert.equal(applyAgentStreamEvent(base, { type: 'context', context }).context, context);
});
