const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { z } = require('zod');
const { registerTsLoader } = require('./helpers/register-ts-loader.cjs');

registerTsLoader();

const { __migrateForTests, __setDbForTests } = require('../src/lib/db.ts');
const { DEFAULT_SETTINGS } = require('../src/types/index.ts');
const ssrfGuard = require('../src/lib/ssrf-guard.ts');
const { completeRequest } = require('../src/lib/api-client.ts');
const { defineReadTool, defineWriteTool } = require('../src/lib/agent/tools/types.ts');
const { createAgentSession, listAgentMessages } = require('../src/lib/agent/store.ts');
const { readAgentDocument, saveAgentDocument } = require('../src/lib/agent/documents.ts');
const { AGENT_BASE_PROMPT } = require('../src/lib/agent/prompt.ts');
const {
  AGENT_MAX_ROUNDS,
  CONTEXT_OVER_LIMIT_NOTE,
  EMPTY_REPLY_NOTE,
  buildAgentHistoryMessages,
  runAgentTurn,
} = require('../src/lib/agent/loop.ts');

const BASE_SETTINGS = {
  ...DEFAULT_SETTINGS,
  api_base: 'http://upstream.test/v1',
  api_key: 'agent-loop-test-key',
  model: 'agent-test-model',
  streaming: false,
};

let clock = 0;
const now = () => new Date(Date.UTC(2026, 10, 1, 12, 0, 0) + (clock += 1000)).toISOString();

function setup(t) {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  __migrateForTests(db);
  __setDbForTests(db);
  t.after(() => {
    __setDbForTests(null);
    db.close();
  });
  db.prepare(`INSERT INTO characters (id, name) VALUES ('char-1', '星野')`).run();
  db.prepare(`INSERT INTO conversations (id, character_id, title) VALUES ('conv-1', 'char-1', '午后')`).run();
  const session = createAgentSession(db, { conversation_id: 'conv-1' }, now());
  return { db, sessionId: session.id };
}

/** 假上游：按顺序返回预设结果，并记录每次请求体的快照。 */
function scripted(steps) {
  const requests = [];
  const complete = async (_settings, body, options) => {
    requests.push(JSON.parse(JSON.stringify(body)));
    const step = steps[requests.length - 1];
    if (!step) throw new Error(`unexpected request #${requests.length}`);
    const result = typeof step === 'function' ? await step(body, options) : step;
    if (result.text && typeof step !== 'function') options.onText?.(result.text);
    return { text: '', toolCalls: [], ...result };
  };
  return { complete, requests };
}

function call(id, name, args) {
  return { id, name, arguments: typeof args === 'string' ? args : JSON.stringify(args) };
}

const lookup = defineReadTool({
  name: 'lookup',
  description: 'fixture lookup',
  schema: z.object({ a: z.number(), b: z.number().optional() }),
  execute: args => ({ ok: true, sum: args.a + (args.b ?? 0) }),
});

function rowsOf(db, sessionId) {
  return listAgentMessages(db, sessionId).map(row => ({
    role: row.role,
    content: row.content,
    tool_call_id: row.tool_call_id,
    tool_calls: row.tool_calls_json ? JSON.parse(row.tool_calls_json).map(item => item.id) : null,
  }));
}

/** 每个 tool_call 都有对应的 tool 消息，每条 tool 消息都对应前面 assistant 的调用。 */
function assertPaired(messages) {
  for (let i = 0; i < messages.length; i += 1) {
    const message = messages[i];
    if (message.role === 'assistant' && message.tool_calls) {
      const ids = message.tool_calls.map(item => item.id);
      const following = [];
      for (let j = i + 1; j < messages.length && messages[j].role === 'tool'; j += 1) following.push(messages[j].tool_call_id);
      assert.deepEqual(following, ids, `tool results after message ${i} must pair with its calls`);
    }
    if (message.role === 'tool') {
      let j = i - 1;
      while (j >= 0 && messages[j].role === 'tool') j -= 1;
      assert.ok(j >= 0 && messages[j].tool_calls, `tool message ${i} must follow an assistant with tool_calls`);
    }
  }
}

test('a multi-round turn persists the full round and pairs tool results', async t => {
  const { db, sessionId } = setup(t);
  const { complete, requests } = scripted([
    { text: '我先查一下。', toolCalls: [call('call_a', 'lookup', { a: 1, b: 2 })] },
    { text: '结果是 3。' },
  ]);
  const seen = [];
  const result = await runAgentTurn({
    db, sessionId, userContent: '一加二是多少？', tools: [lookup], settings: BASE_SETTINGS, complete, now,
    events: {
      onText: text => seen.push(`text:${text}`),
      onToolStart: item => seen.push(`start:${item.name}`),
      onToolEnd: item => seen.push(`end:${item.name}:${item.result.ok}`),
    },
  });

  assert.deepEqual(result, { status: 'done', rounds: 2 });
  assert.deepEqual(seen, ['text:我先查一下。', 'start:lookup', 'end:lookup:true', 'text:结果是 3。']);
  assert.deepEqual(rowsOf(db, sessionId), [
    { role: 'user', content: '一加二是多少？', tool_call_id: null, tool_calls: null },
    { role: 'assistant', content: '我先查一下。', tool_call_id: null, tool_calls: ['call_a'] },
    { role: 'tool', content: '{"ok":true,"sum":3}', tool_call_id: 'call_a', tool_calls: null },
    { role: 'assistant', content: '结果是 3。', tool_call_id: null, tool_calls: null },
  ]);

  assert.equal(requests.length, 2);
  assert.equal(requests[0].tools[0].function.name, 'lookup');
  assert.equal(requests[0].messages[0].role, 'system');
  const second = requests[1].messages;
  assert.deepEqual(second.slice(1).map(m => m.role), ['user', 'assistant', 'tool']);
  assert.equal(second[3].tool_call_id, 'call_a');
  assert.equal(second[3].content, '{"ok":true,"sum":3}');
  assertPaired(second);
  assert.equal(db.prepare('SELECT title FROM agent_sessions WHERE id = ?').get(sessionId).title, '一加二是多少？');
});

test('the system prompt carries the base rules, documents and session context', async t => {
  const { db, sessionId } = setup(t);
  saveAgentDocument(db, 'agents', '叫我队长。', 'user', now());
  saveAgentDocument(db, 'memory', '主人喜欢先看结论。', 'agent', now());
  const { complete, requests } = scripted([{ text: '好的' }, { text: '收到' }]);
  await runAgentTurn({ db, sessionId, userContent: '你好', tools: [], settings: BASE_SETTINGS, complete, now });

  const system = requests[0].messages[0].content;
  assert.ok(system.startsWith(AGENT_BASE_PROMPT));
  assert.ok(system.indexOf('叫我队长。') > AGENT_BASE_PROMPT.length);
  assert.ok(system.indexOf('主人喜欢先看结论。') > system.indexOf('叫我队长。'));
  assert.match(system, /星野（char-1）/);
  assert.match(system, /conv-1/);
  assert.equal(requests[0].tools, undefined);

  // 保存后的下一轮按新内容生效
  saveAgentDocument(db, 'agents', '叫我船长。', 'user', now());
  await runAgentTurn({ db, sessionId, userContent: '再来', tools: [], settings: BASE_SETTINGS, complete, now });
  const nextSystem = requests[1].messages[0].content;
  assert.match(nextSystem, /叫我船长。/);
  assert.doesNotMatch(nextSystem, /叫我队长。/);
});

function sseResponse(events) {
  const encoder = new TextEncoder();
  return new Response(new ReadableStream({
    start(controller) {
      for (const event of events) controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
      controller.enqueue(encoder.encode('data: [DONE]\n\n'));
      controller.close();
    },
  }), { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}

test('streamed tool_calls split across chunks are reassembled and reasoning is replayed within the turn', async t => {
  const { db, sessionId } = setup(t);
  const bodies = [];
  const responses = [
    sseResponse([
      { choices: [{ delta: { reasoning_content: '先想' } }] },
      { choices: [{ delta: { reasoning_content: '一想', tool_calls: [{ index: 0, id: 'call_s', function: { name: 'lookup', arguments: '{"a"' } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: ':4,' } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"b":5}' } }] }, finish_reason: 'tool_calls' }] },
    ]),
    sseResponse([{ choices: [{ delta: { content: '等于 9。' }, finish_reason: 'stop' }] }]),
    sseResponse([{ choices: [{ delta: { content: '不客气。' }, finish_reason: 'stop' }] }]),
  ];
  const originalFetch = ssrfGuard.safeFetch;
  ssrfGuard.safeFetch = async (_url, init) => {
    bodies.push(JSON.parse(init.body));
    return responses.shift();
  };
  t.after(() => {
    ssrfGuard.safeFetch = originalFetch;
  });
  const settings = { ...BASE_SETTINGS, streaming: true };

  const result = await runAgentTurn({ db, sessionId, userContent: '四加五？', tools: [lookup], settings, complete: completeRequest, now });
  assert.equal(result.status, 'done');
  assert.equal(bodies[0].stream, true);
  const assistant = bodies[1].messages[2];
  assert.equal(assistant.role, 'assistant');
  assert.equal(assistant.reasoning_content, '先想一想');
  assert.deepEqual(assistant.tool_calls, [{ id: 'call_s', type: 'function', function: { name: 'lookup', arguments: '{"a":4,"b":5}' } }]);
  assert.deepEqual(bodies[1].messages[3], { role: 'tool', tool_call_id: 'call_s', name: 'lookup', content: '{"ok":true,"sum":9}' });

  // 下一轮：上一轮的思考链不再回传，调用结构仍保留
  await runAgentTurn({ db, sessionId, userContent: '谢谢', tools: [lookup], settings, complete: completeRequest, now });
  const replayed = bodies[2].messages[2];
  assert.equal(replayed.reasoning_content, undefined);
  assert.equal(replayed.tool_calls[0].id, 'call_s');
});

test('the third identical call in a row gets a reminder, key order does not matter', async t => {
  const { db, sessionId } = setup(t);
  const { complete } = scripted([
    { toolCalls: [call('c1', 'lookup', '{"a":1,"b":2}')] },
    { toolCalls: [call('c2', 'lookup', '{"b":2,"a":1}')] },
    { toolCalls: [call('c3', 'lookup', { a: 1, b: 2 })] },
    { toolCalls: [call('c4', 'lookup', { a: 7 })] },
    { text: '好了' },
  ]);
  await runAgentTurn({ db, sessionId, userContent: '算', tools: [lookup], settings: BASE_SETTINGS, complete, now });
  const tools = listAgentMessages(db, sessionId).filter(row => row.role === 'tool');
  assert.deepEqual(tools.map(row => row.content.includes('[提醒]')), [false, false, true, false]);
  assert.match(tools[2].content, /连续 3 次/);
});

test('25 tool rounds pause the turn and the next turn continues from the pause', async t => {
  const { db, sessionId } = setup(t);
  let index = 0;
  const steps = Array.from({ length: AGENT_MAX_ROUNDS }, () => ({ toolCalls: [call(`loop_${index += 1}`, 'lookup', { a: index })] }));
  steps.push({ text: '继续完成了' });
  const { complete, requests } = scripted(steps);

  const first = await runAgentTurn({ db, sessionId, userContent: '一直查', tools: [lookup], settings: BASE_SETTINGS, complete, now });
  assert.deepEqual(first, { status: 'round_limit', rounds: 25 });
  assert.equal(requests.length, 25);
  const rows = listAgentMessages(db, sessionId);
  assert.equal(rows.filter(row => row.role === 'assistant').length, 25);
  assert.deepEqual(JSON.parse(rows.at(-1).content), { kind: 'round_limit', rounds: 25 });

  const second = await runAgentTurn({ db, sessionId, userContent: '继续', tools: [lookup], settings: BASE_SETTINGS, complete, now });
  assert.equal(second.status, 'done');
  const last = requests[25].messages;
  const userMessage = last.at(-1);
  assert.equal(userMessage.role, 'user');
  assert.match(userMessage.content, /25 轮上限/);
  assert.match(userMessage.content, /继续$/);
  assertPaired(last);
});

test('aborting while the model streams keeps the partial text and records the interruption', async t => {
  const { db, sessionId } = setup(t);
  const controller = new AbortController();
  const { complete } = scripted([
    (_body, options) => new Promise((_resolve, reject) => {
      options.onText('写到一半');
      options.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
      setImmediate(() => controller.abort());
    }),
  ]);
  const result = await runAgentTurn({
    db, sessionId, userContent: '写一段', tools: [lookup], settings: BASE_SETTINGS, complete, now, signal: controller.signal,
  });
  assert.deepEqual(result, { status: 'aborted', rounds: 1 });
  assert.deepEqual(rowsOf(db, sessionId).map(row => [row.role, row.content]), [
    ['user', '写一段'],
    ['assistant', '写到一半'],
    ['event', '{"kind":"interrupted"}'],
  ]);
});

test('aborting a real completion stream with timeout disabled records the partial reply as interrupted', async t => {
  const { db, sessionId } = setup(t);
  const controller = new AbortController();
  const originalFetch = ssrfGuard.safeFetch;
  ssrfGuard.safeFetch = async () => sseResponse([
    { choices: [{ delta: { content: '写到一半' } }] },
    { choices: [{ delta: { content: '这段不应读到' }, finish_reason: 'stop' }] },
  ]);
  t.after(() => { ssrfGuard.safeFetch = originalFetch; });
  const streamed = [];

  const result = await runAgentTurn({
    db, sessionId, userContent: '写一段', tools: [], complete: completeRequest, now,
    settings: { ...BASE_SETTINGS, streaming: true, memory_background_timeout_ms: 0 },
    signal: controller.signal,
    events: {
      onText: text => {
        streamed.push(text);
        controller.abort();
      },
    },
  });

  assert.deepEqual(streamed, ['写到一半']);
  assert.deepEqual(result, { status: 'aborted', rounds: 1 });
  assert.deepEqual(rowsOf(db, sessionId).map(row => [row.role, row.content]), [
    ['user', '写一段'],
    ['assistant', '写到一半'],
    ['event', '{"kind":"interrupted"}'],
  ]);
});

for (const [label, terminal] of [
  ['EOF without a completion marker', ''],
  ['length even followed by DONE', 'data: {"choices":[{"delta":{},"finish_reason":"length"}]}\n\ndata: [DONE]\n\n'],
]) {
  test(`an upstream ${label} preserves partial text and does not execute pending tools`, async t => {
    const { db, sessionId } = setup(t);
    const originalFetch = ssrfGuard.safeFetch;
    const pending = { choices: [{ delta: {
      content: '还没说完',
      tool_calls: [{ index: 0, id: 'pending', function: { name: 'lookup', arguments: '{"a":1}' } }],
    } }] };
    ssrfGuard.safeFetch = async () => new Response(`data: ${JSON.stringify(pending)}\n\n${terminal}`);
    t.after(() => { ssrfGuard.safeFetch = originalFetch; });
    let executed = 0;
    const counted = defineReadTool({ ...lookup, execute: () => { executed += 1; return { ok: true }; } });

    const result = await runAgentTurn({
      db, sessionId, userContent: '查一下', tools: [counted], settings: { ...BASE_SETTINGS, streaming: true },
      complete: completeRequest, now,
    });

    assert.deepEqual(result, { status: 'aborted', rounds: 1 });
    assert.equal(executed, 0);
    assert.deepEqual(rowsOf(db, sessionId).map(row => [row.role, row.content]), [
      ['user', '查一下'], ['assistant', '还没说完'], ['event', '{"kind":"interrupted"}'],
    ]);
    assert.ok(listAgentMessages(db, sessionId).every(row => row.tool_calls_json === null));
  });
}

for (const [label, terminal] of [
  ['finish_reason stop without DONE', 'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n'],
  ['DONE without finish_reason', 'data: [DONE]\n\n'],
]) {
  test(`a real stream with ${label} completes normally`, async t => {
    const { db, sessionId } = setup(t);
    const originalFetch = ssrfGuard.safeFetch;
    ssrfGuard.safeFetch = async () => new Response(`data: {"choices":[{"delta":{"content":"完成了"}}]}\n\n${terminal}`);
    t.after(() => { ssrfGuard.safeFetch = originalFetch; });
    const result = await runAgentTurn({
      db, sessionId, userContent: '你好', tools: [], settings: { ...BASE_SETTINGS, streaming: true },
      complete: completeRequest, now,
    });
    assert.deepEqual(result, { status: 'done', rounds: 1 });
    assert.deepEqual(rowsOf(db, sessionId).map(row => row.role), ['user', 'assistant']);
  });
}

for (const text of ['', '  \n']) {
  test(`an empty model reply ${JSON.stringify(text)} persists its explanation as an error event`, async t => {
    const { db, sessionId } = setup(t);
    const { complete } = scripted([{ text }]);
    const result = await runAgentTurn({ db, sessionId, userContent: '在吗', tools: [], settings: BASE_SETTINGS, complete, now });
    assert.deepEqual(result, { status: 'error', rounds: 1, error: EMPTY_REPLY_NOTE });
    assert.deepEqual(rowsOf(db, sessionId).map(row => [row.role, row.content]), [
      ['user', '在吗'], ['event', JSON.stringify({ kind: 'error', message: EMPTY_REPLY_NOTE })],
    ]);
  });
}

test('tool failures go back to the model and the turn keeps going', async t => {
  const { db, sessionId } = setup(t);
  const broken = defineReadTool({
    name: 'broken',
    description: 'always fails',
    schema: z.object({}),
    execute: () => {
      const error = new Error('SELECT secret FROM somewhere at /srv/data.db');
      error.name = 'SqliteError';
      throw error;
    },
  });
  const plainFailure = defineReadTool({
    name: 'plain_failure',
    description: 'fails with a readable message',
    schema: z.object({}),
    execute: async () => {
      throw new Error('找不到这个角色');
    },
  });
  const { complete, requests } = scripted([
    {
      toolCalls: [
        call('e1', 'missing_tool', {}),
        call('e2', 'lookup', '{"a":"x"}'),
        call('e3', 'lookup', '{not json'),
        call('e4', 'broken', {}),
        call('e5', 'plain_failure', {}),
      ],
    },
    { text: '有几个工具出错了' },
  ]);
  const result = await runAgentTurn({
    db, sessionId, userContent: '试试', tools: [lookup, broken, plainFailure], settings: BASE_SETTINGS, complete, now,
  });
  assert.equal(result.status, 'done');
  const results = requests[1].messages.filter(m => m.role === 'tool').map(m => JSON.parse(m.content));
  assert.deepEqual(results.map(item => item.ok), [false, false, false, false, false]);
  assert.match(results[0].error, /未知工具：missing_tool/);
  assert.match(results[1].error, /^参数无效：a:/);
  assert.equal(results[2].error, '参数不是合法的 JSON');
  assert.equal(results[3].error, '工具执行失败');
  assert.equal(results[4].error, '找不到这个角色');
  assertPaired(requests[1].messages);
});

test('old tool results fold under context pressure, pairing stays intact and a re-call returns the original', async t => {
  const { db, sessionId } = setup(t);
  const page = label => Array.from({ length: 400 }, (_, i) => `${label}第${i}条：今天聊到了第${i * 7 % 13}件小事。`).join('');
  const pages = { 1: page('甲'), 2: page('乙') };
  const readPage = defineReadTool({
    name: 'read_page',
    description: 'returns a long page',
    schema: z.object({ page: z.number() }),
    execute: args => ({ ok: true, text: pages[args.page] }),
  });
  const { complete, requests } = scripted([
    { toolCalls: [call('p1', 'read_page', { page: 1 })] },
    { toolCalls: [call('p2', 'read_page', { page: 2 })] },
    { toolCalls: [call('p3', 'read_page', { page: 1 })] },
    { text: '读完了' },
  ]);
  const notes = [];
  const settings = { ...BASE_SETTINGS, context_window: 6000 };
  const result = await runAgentTurn({
    db, sessionId, userContent: '读两页', tools: [readPage], settings, complete, now, events: { onNote: note => notes.push(note) },
  });
  assert.equal(result.status, 'done');

  // 第三次请求：第 1 页的旧结果被折叠，最新的第 2 页保留原文
  const third = requests[2].messages;
  const toolMessages = third.filter(m => m.role === 'tool');
  assert.deepEqual(toolMessages.map(m => m.tool_call_id), ['p1', 'p2']);
  const folded = JSON.parse(toolMessages[0].content);
  assert.equal(folded.folded, true);
  assert.equal(folded.tool, 'read_page');
  assert.deepEqual(folded.arguments, { page: 1 });
  assert.equal(JSON.parse(toolMessages[1].content).text, pages[2]);
  assertPaired(third);

  // 重新调用拿到的是原内容；数据库里保存的一直是完整结果
  const stored = listAgentMessages(db, sessionId).filter(row => row.role === 'tool');
  assert.equal(stored[0].content, stored[2].content);
  assert.equal(JSON.parse(stored[2].content).text, pages[1]);
  // 最新一页本身就超出预算：折叠后仍超出，本轮只提示一次
  assert.deepEqual(notes, [CONTEXT_OVER_LIMIT_NOTE]);
});

test('nothing folds while the context fits', async t => {
  const { db, sessionId } = setup(t);
  const { complete, requests } = scripted([
    { toolCalls: [call('f1', 'lookup', { a: 1 })] },
    { toolCalls: [call('f2', 'lookup', { a: 2 })] },
    { text: '完成' },
  ]);
  await runAgentTurn({ db, sessionId, userContent: '查', tools: [lookup], settings: BASE_SETTINGS, complete, now });
  const tools = requests[2].messages.filter(m => m.role === 'tool').map(m => m.content);
  assert.deepEqual(tools, ['{"ok":true,"sum":1}', '{"ok":true,"sum":2}']);
});

test('aborting during the second of two tools drops the round, and the next turn has no unpaired calls', async t => {
  const { db, sessionId } = setup(t);
  const controller = new AbortController();
  const executed = [];
  const slow = defineReadTool({
    name: 'slow',
    description: 'aborts mid-way',
    schema: z.object({ n: z.number() }),
    execute: async args => {
      executed.push(args.n);
      if (args.n === 2) {
        controller.abort();
        throw new DOMException('aborted', 'AbortError');
      }
      return { ok: true, n: args.n };
    },
  });
  const { complete, requests } = scripted([
    { text: '两个一起查', toolCalls: [call('s1', 'slow', { n: 1 }), call('s2', 'slow', { n: 2 })] },
    { text: '重新开始' },
  ]);
  const first = await runAgentTurn({
    db, sessionId, userContent: '查两个', tools: [slow], settings: BASE_SETTINGS, complete, now, signal: controller.signal,
  });
  assert.deepEqual(first, { status: 'aborted', rounds: 1 });
  assert.deepEqual(executed, [1, 2]);
  assert.deepEqual(rowsOf(db, sessionId).map(row => [row.role, row.tool_calls]), [
    ['user', null],
    ['assistant', null],
    ['event', null],
  ]);

  const second = await runAgentTurn({ db, sessionId, userContent: '继续', tools: [slow], settings: BASE_SETTINGS, complete, now });
  assert.equal(second.status, 'done');
  const history = requests[1].messages;
  assert.ok(history.every(m => !m.tool_calls && m.role !== 'tool'));
  assertPaired(history);
  assert.match(history.at(-1).content, /上一轮中断/);
});

function noteTool(name, behaviour = 'ok') {
  return defineWriteTool({
    name,
    description: 'writes memory.md',
    schema: z.object({ text: z.string() }),
    execute: (args, ctx) => {
      saveAgentDocument(ctx.db, 'memory', args.text, 'agent', '2026-11-01T00:00:00.000Z');
      if (behaviour === 'throw') throw new Error('写到一半失败');
      return { result: { ok: true }, terminate: behaviour === 'terminate' };
    },
  });
}

test('a failure while saving the round rolls back the write tool side effects', async t => {
  const { db, sessionId } = setup(t);
  db.exec(`
    CREATE TRIGGER fail_tool_rows BEFORE INSERT ON agent_messages WHEN NEW.role = 'tool'
    BEGIN SELECT RAISE(ABORT, 'injected failure'); END;
  `);
  const { complete } = scripted([
    { toolCalls: [call('w1', 'note', { text: '不应该留下' }), call('w2', 'lookup', { a: 1 })] },
  ]);
  const result = await runAgentTurn({ db, sessionId, userContent: '记一下', tools: [noteTool('note'), lookup], settings: BASE_SETTINGS, complete, now });

  assert.equal(result.status, 'error');
  assert.equal(readAgentDocument(db, 'memory').updated_at, null);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM agent_document_versions').get().n, 0);
  assert.deepEqual(rowsOf(db, sessionId).map(row => row.role), ['user', 'event']);
  assert.equal(JSON.parse(listAgentMessages(db, sessionId).at(-1).content).kind, 'error');
});

test('a write tool that throws only rolls back its own writes', async t => {
  const { db, sessionId } = setup(t);
  const { complete, requests } = scripted([
    { toolCalls: [call('w1', 'note_fail', { text: '半截' }), call('w2', 'lookup', { a: 2 })] },
    { text: '记录失败了' },
  ]);
  const result = await runAgentTurn({
    db, sessionId, userContent: '记一下', tools: [noteTool('note_fail', 'throw'), lookup], settings: BASE_SETTINGS, complete, now,
  });
  assert.equal(result.status, 'done');
  assert.equal(readAgentDocument(db, 'memory').updated_at, null);
  const tools = requests[1].messages.filter(m => m.role === 'tool').map(m => JSON.parse(m.content));
  assert.deepEqual(tools, [{ ok: false, error: '写到一半失败' }, { ok: true, sum: 2 }]);
});

test('a write tool can end the turn after its round is saved', async t => {
  const { db, sessionId } = setup(t);
  const { complete, requests } = scripted([{ text: '已提交，等你批准', toolCalls: [call('w1', 'note_stop', { text: '要点' })] }]);
  const result = await runAgentTurn({
    db, sessionId, userContent: '记一下', tools: [noteTool('note_stop', 'terminate')], settings: BASE_SETTINGS, complete, now,
  });
  assert.deepEqual(result, { status: 'terminated', rounds: 1 });
  assert.equal(requests.length, 1);
  assert.equal(readAgentDocument(db, 'memory').content, '要点');
  assert.deepEqual(rowsOf(db, sessionId).map(row => row.role), ['user', 'assistant', 'tool']);
});

test('upstream errors are recorded as an event and the session stays usable', async t => {
  const { db, sessionId } = setup(t);
  const { complete, requests } = scripted([
    async () => {
      throw new Error('API error 503: upstream overloaded');
    },
    { text: '恢复了' },
  ]);
  const first = await runAgentTurn({ db, sessionId, userContent: '在吗', tools: [lookup], settings: BASE_SETTINGS, complete, now });
  assert.deepEqual(first, { status: 'error', rounds: 1, error: 'API error 503: upstream overloaded' });
  const second = await runAgentTurn({ db, sessionId, userContent: '再试', tools: [lookup], settings: BASE_SETTINGS, complete, now });
  assert.equal(second.status, 'done');
  const messages = requests[1].messages;
  assert.deepEqual(messages.slice(1).map(m => m.role), ['user']);
  assert.match(messages[1].content, /^在吗\n\n（系统记录：上一轮因请求失败中断。）\n\n再试$/);
});

test('history building merges adjacent user and event rows and skips unreadable events', () => {
  const rows = [
    { id: 1, role: 'user', content: '甲', tool_calls_json: null, tool_call_id: null, tool_name: null, assistant_fields_json: null },
    { id: 2, role: 'event', content: '{"kind":"interrupted"}', tool_calls_json: null, tool_call_id: null, tool_name: null, assistant_fields_json: null },
    { id: 3, role: 'event', content: 'not json', tool_calls_json: null, tool_call_id: null, tool_name: null, assistant_fields_json: null },
    { id: 4, role: 'user', content: '乙', tool_calls_json: null, tool_call_id: null, tool_name: null, assistant_fields_json: null },
    { id: 5, role: 'assistant', content: '丙', tool_calls_json: null, tool_call_id: null, tool_name: null, assistant_fields_json: '{"reasoning_content":"想"}' },
  ];
  assert.deepEqual(buildAgentHistoryMessages(rows), [
    { role: 'user', content: '甲\n\n（系统记录：上一轮中断，未完成的工具调用没有执行。）\n\n乙' },
    { role: 'assistant', content: '丙', reasoning_content: '想' },
  ]);
});
