const test = require('node:test');
const assert = require('node:assert/strict');
const { installMemoryOnlyTestGuard } = require('./helpers/memory-only-test-guard.cjs');

installMemoryOnlyTestGuard(test);

const Database = require('better-sqlite3');
const { registerTsLoader } = require('./helpers/register-ts-loader.cjs');

registerTsLoader();

const { __migrateForTests, __setDbForTests } = require('../src/lib/db.ts');
const { DEFAULT_SETTINGS } = require('../src/types/index.ts');
const { appendAgentMessage, createAgentSession, listAgentMessages } = require('../src/lib/agent/store.ts');
const { agentCompactThreshold, saveAgentLastUsage } = require('../src/lib/agent/context.ts');
const { estimateTokens } = require('../src/lib/token-counter.ts');
const { COMPACTION_SYSTEM_PROMPT } = require('../src/lib/agent/compaction.ts');
const { compactAgentSession, getAgentContextStatus, runAgentTurn } = require('../src/lib/agent/loop.ts');

const SETTINGS = {
  ...DEFAULT_SETTINGS,
  api_base: 'http://upstream.test/v1',
  api_key: 'manual-compaction-test-key',
  model: 'manual-test-model',
  streaming: false,
  memory_background_timeout_ms: 0,
};
const now = () => '2026-11-06T02:00:00.000Z';

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

function seedTurn(db, sessionId, label = '本轮') {
  const rows = [
    { role: 'user', content: `${label}检查虚构角色的记忆` },
    {
      role: 'assistant', content: `${label}检查两条记忆`,
      tool_calls_json: JSON.stringify([{ id: `${label}-call`, type: 'function', function: { name: 'lookup', arguments: '{"memory_id":"mem-1"}' } }]),
    },
    { role: 'tool', content: '{"ok":true,"memory_id":"mem-1","content":"主人喜欢乌龙茶"}', tool_call_id: `${label}-call`, tool_name: 'lookup' },
    { role: 'assistant', content: `${label}已审查 mem-1，mem-2 尚未审查；下一轮核对 mem-2。建议手动压缩。` },
  ];
  return rows.map(row => appendAgentMessage(db, sessionId, row, now()));
}

function compactions(db, sessionId) {
  return listAgentMessages(db, sessionId)
    .filter(row => row.role === 'event')
    .map(row => JSON.parse(row.content))
    .filter(event => event.kind === 'compaction');
}

test('manual compaction includes the just-finished first turn below the threshold and preserves all original rows', async t => {
  const ctx = setup(t);
  const ids = seedTurn(ctx.db, ctx.sessionId);
  const before = listAgentMessages(ctx.db, ctx.sessionId);
  const status = getAgentContextStatus(ctx.db, ctx.sessionId, { tools: [], settings: SETTINGS });
  assert.ok(status.used < status.threshold);
  const requests = [];
  const result = await compactAgentSession({
    ...ctx, tools: [], settings: SETTINGS, now,
    complete: async (_settings, body) => {
      requests.push(body);
      return { text: '已审查 mem-1；mem-2 未审查，下一轮核对 mem-2。', toolCalls: [], completed: true };
    },
  });
  assert.deepEqual(result, { compacted: true });
  assert.equal(requests.length, 1, 'only the summary request runs; no task starts');
  assert.equal(requests[0].messages[0].content, COMPACTION_SYSTEM_PROMPT);
  assert.equal(requests[0].tools, undefined);
  const transcript = requests[0].messages[1].content;
  assert.match(transcript, /【主人】\n本轮检查虚构角色的记忆/);
  assert.match(transcript, /→ 调用 lookup \{"memory_id":"mem-1"\}/);
  assert.match(transcript, /【工具结果 lookup】/);
  assert.match(transcript, /下一轮核对 mem-2/);
  const after = listAgentMessages(ctx.db, ctx.sessionId);
  assert.deepEqual(after.slice(0, before.length), before);
  assert.equal(after.length, before.length + 1);
  assert.equal(compactions(ctx.db, ctx.sessionId)[0].through_id, ids.at(-1));

  let nextBody;
  await runAgentTurn({
    ...ctx, userContent: '继续下一轮', tools: [], settings: SETTINGS, now,
    complete: async (_settings, body) => {
      nextBody = body;
      return { text: '开始核对 mem-2。', toolCalls: [], completed: true };
    },
  });
  assert.equal(nextBody.messages.length, 2);
  assert.match(nextBody.messages[1].content, /已审查 mem-1；mem-2 未审查/);
  assert.match(nextBody.messages[1].content, /继续下一轮$/);
  assert.equal(JSON.stringify(nextBody).includes('本轮检查两条记忆'), false);
});

test('manual compaction merges the previous summary and only newly completed records', async t => {
  const ctx = setup(t);
  seedTurn(ctx.db, ctx.sessionId, '旧轮');
  await compactAgentSession({
    ...ctx, tools: [], settings: SETTINGS, now,
    complete: async () => ({ text: '旧轮成果摘要', toolCalls: [], completed: true }),
  });
  const newIds = seedTurn(ctx.db, ctx.sessionId, '新轮');
  const transcripts = [];
  await compactAgentSession({
    ...ctx, tools: [], settings: SETTINGS, now,
    complete: async (_settings, body) => {
      transcripts.push(body.messages[1].content);
      return { text: '合并后的成果摘要', toolCalls: [], completed: true };
    },
  });
  assert.equal(transcripts.length, 1);
  assert.match(transcripts[0], /^【已有摘要】\n旧轮成果摘要/);
  assert.match(transcripts[0], /新轮检查虚构角色的记忆/);
  assert.equal(transcripts[0].includes('旧轮检查虚构角色的记忆'), false);
  assert.equal(compactions(ctx.db, ctx.sessionId).at(-1).through_id, newIds.at(-1));
});

test('empty history and already compacted history are no-ops without upstream calls', async t => {
  const ctx = setup(t);
  let calls = 0;
  const input = {
    ...ctx, tools: [], settings: SETTINGS, now,
    complete: async () => { calls += 1; return { text: '摘要', toolCalls: [], completed: true }; },
  };
  assert.deepEqual(await compactAgentSession(input), { compacted: false });
  seedTurn(ctx.db, ctx.sessionId);
  assert.deepEqual(await compactAgentSession(input), { compacted: true });
  const before = listAgentMessages(ctx.db, ctx.sessionId);
  assert.deepEqual(await compactAgentSession(input), { compacted: false });
  assert.equal(calls, 1);
  assert.deepEqual(listAgentMessages(ctx.db, ctx.sessionId), before);
});

test('manual compaction failure, empty and incomplete summaries leave history untouched and allow retry', async t => {
  for (const reply of [new Error('fixture upstream failed'), { text: '  ' }, { text: '半截', completed: false }, { text: '半截', finishReason: 'length' }]) {
    await t.test(reply instanceof Error ? reply.message : JSON.stringify(reply), async child => {
      const ctx = setup(child);
      seedTurn(ctx.db, ctx.sessionId);
      const before = listAgentMessages(ctx.db, ctx.sessionId);
      await assert.rejects(compactAgentSession({
        ...ctx, tools: [], settings: SETTINGS, now,
        complete: async () => {
          if (reply instanceof Error) throw reply;
          return { toolCalls: [], completed: true, ...reply };
        },
      }));
      assert.deepEqual(listAgentMessages(ctx.db, ctx.sessionId), before);
      assert.deepEqual(await compactAgentSession({
        ...ctx, tools: [], settings: SETTINGS, now,
        complete: async () => ({ text: '重试成功摘要', toolCalls: [], completed: true }),
      }), { compacted: true });
    });
  }
});

test('manual compaction checks cancellation before requesting and before committing a returned summary', async t => {
  const ctx = setup(t);
  seedTurn(ctx.db, ctx.sessionId);
  const before = listAgentMessages(ctx.db, ctx.sessionId);
  const cancelled = new AbortController();
  cancelled.abort();
  let calls = 0;
  await assert.rejects(compactAgentSession({
    ...ctx, tools: [], settings: SETTINGS, now, signal: cancelled.signal,
    complete: async () => { calls += 1; return { text: '摘要', toolCalls: [], completed: true }; },
  }));
  assert.equal(calls, 0);
  const during = new AbortController();
  await assert.rejects(compactAgentSession({
    ...ctx, tools: [], settings: SETTINGS, now, signal: during.signal,
    complete: async () => {
      during.abort();
      return { text: '应丢弃的摘要', toolCalls: [], completed: true };
    },
  }));
  assert.deepEqual(listAgentMessages(ctx.db, ctx.sessionId), before);
});

test('manual compaction timeout rejects without saving a summary', async t => {
  const ctx = setup(t);
  seedTurn(ctx.db, ctx.sessionId);
  const before = listAgentMessages(ctx.db, ctx.sessionId);
  await assert.rejects(compactAgentSession({
    ...ctx, tools: [], settings: { ...SETTINGS, memory_background_timeout_ms: 10 }, now,
    complete: async (_settings, _body, { signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
    }),
  }));
  assert.deepEqual(listAgentMessages(ctx.db, ctx.sessionId), before);
});

test('manual compaction rolling requests honor calibrated input space', async t => {
  const ctx = setup(t);
  seedTurn(ctx.db, ctx.sessionId);
  appendAgentMessage(ctx.db, ctx.sessionId, { role: 'assistant', content: ' A'.repeat(18000) }, now());
  const settings = { ...SETTINGS, agent_context_window: 20000 };
  saveAgentLastUsage(ctx.db, ctx.sessionId, {
    model: SETTINGS.model, prompt_tokens: 2000, completion_tokens: 1, estimated_prompt_tokens: 1000, at: now(),
  });
  const budget = Math.floor(agentCompactThreshold(20000, 16384) / 2);
  const requests = [];
  await compactAgentSession({
    ...ctx, tools: [], settings, now,
    complete: async (_settings, body) => {
      requests.push(body);
      const tokens = body.messages.reduce((sum, message) => sum + estimateTokens(message.content), 0);
      assert.ok(tokens <= budget, `${tokens} exceeds ${budget}`);
      return { text: '虚构阶段摘要', toolCalls: [], completed: true };
    },
  });
  assert.ok(requests.length > 1);
  assert.equal(compactions(ctx.db, ctx.sessionId).length, 1);
});
