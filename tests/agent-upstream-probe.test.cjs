const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

process.env.ALLOW_LOCAL_NETWORK = '1';
const { runProbe } = require('../scripts/agent-upstream-probe.cjs');
const { loadUpstreamConfig, redactSecret } = require('../scripts/agent-eval/upstream-config.cjs');

const API_KEY = 'sk-probe-fixture-secret';

/** 按请求内容应答的假上游；flaws 模拟真实中转站可能出现的问题。 */
function buildReply(body, flaws) {
  if (flaws.rejectAll) return { status: 401, error: `bad key ${API_KEY}` };
  const messages = body.messages;
  const system = flaws.dropSystem ? '' : messages.find(message => message.role === 'system')?.content ?? '';
  const code = /校验码是 (sys-[0-9a-f]+)/.exec(system)?.[1] ?? '';

  if (!body.tools) return { content: `校验码是 ${code}` };
  if (flaws.noTools) return { content: '我无法调用工具' };

  const toolNames = body.tools.map(tool => tool.function.name);
  if (toolNames.includes('get_memory')) {
    const id = /编号为 (mem-[0-9a-f]+)/.exec(messages.at(-1).content)?.[1];
    const args = JSON.stringify({ memory_id: id });
    return { toolCalls: [{ name: 'get_memory', arguments: flaws.truncatedArgs ? args.slice(0, 8) : args }] };
  }

  const toolMessages = messages.filter(message => message.role === 'tool');
  if (flaws.requireReasoningReplay && toolMessages.length > 0) {
    const assistant = messages.findLast(message => message.role === 'assistant');
    if (assistant.reasoning_content !== 'thinking') return { status: 400, error: `missing reasoning_content ${API_KEY}` };
  }
  if (toolMessages.length === 0) return { toolCalls: [{ name: 'get_first_token', arguments: '{"reason":"start"}' }], reasoning: 'thinking' };
  if (toolMessages.length === 1) {
    const first = flaws.dropToolResult ? '' : JSON.parse(toolMessages[0].content).first_token;
    return { toolCalls: [{ name: 'get_second_token', arguments: JSON.stringify({ first_token: first }) }], reasoning: 'thinking' };
  }
  const second = JSON.parse(toolMessages[1].content).second_token ?? 'none';
  return { content: `第二段令牌是 ${second}，校验码 ${code}`, reasoning: 'thinking' };
}

function nonStreamPayload(reply) {
  return {
    choices: [{
      finish_reason: reply.toolCalls ? 'tool_calls' : 'stop',
      message: {
        content: reply.content ?? '',
        ...(reply.reasoning ? { reasoning_content: reply.reasoning } : {}),
        ...(reply.toolCalls ? {
          tool_calls: reply.toolCalls.map((call, index) => ({
            id: `call_${index}`,
            type: 'function',
            function: { name: call.name, arguments: call.arguments },
          })),
        } : {}),
      },
    }],
  };
}

function streamEvents(reply) {
  const events = [];
  if (reply.reasoning) events.push({ choices: [{ delta: { reasoning_content: reply.reasoning } }] });
  if (reply.content) events.push({ choices: [{ delta: { content: reply.content } }] });
  for (const [index, call] of (reply.toolCalls ?? []).entries()) {
    // 参数分两片到达，验证探针读到的是拼接后的完整 JSON。
    const middle = Math.floor(call.arguments.length / 2);
    events.push({ choices: [{ delta: { tool_calls: [{ index, id: `call_${index}`, function: { name: call.name, arguments: call.arguments.slice(0, middle) } }] } }] });
    events.push({ choices: [{ delta: { tool_calls: [{ index, function: { arguments: call.arguments.slice(middle) } }] } }] });
  }
  events.push({ choices: [{ delta: {}, finish_reason: reply.toolCalls ? 'tool_calls' : 'stop' }] });
  return events;
}

async function withFakeUpstream(flaws, run) {
  const server = http.createServer((request, response) => {
    let raw = '';
    request.on('data', chunk => { raw += chunk; });
    request.on('end', () => {
      const body = JSON.parse(raw);
      const reply = buildReply(body, flaws);
      if (reply.status) {
        response.writeHead(reply.status, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ error: { message: reply.error } }));
      } else if (body.stream) {
        response.writeHead(200, { 'Content-Type': 'text/event-stream' });
        for (const event of streamEvents(reply)) response.write(`data: ${JSON.stringify(event)}\n\n`);
        response.end('data: [DONE]\n\n');
      } else {
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify(nonStreamPayload(reply)));
      }
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    return await run(`http://127.0.0.1:${server.address().port}/v1`);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

function probe(flaws) {
  return withFakeUpstream(flaws, apiBase => runProbe({ apiBase, apiKey: API_KEY, models: ['fixture-model'] }));
}

function failedChecks(results) {
  return [...new Set(results.filter(row => !row.ok).map(row => row.check))].sort();
}

test('healthy upstream passes every check in both stream modes', async () => {
  const results = await probe({ requireReasoningReplay: true });
  assert.equal(results.length, 6);
  assert.deepEqual(failedChecks(results), []);
  assert.deepEqual([...new Set(results.map(row => row.mode))].sort(), ['non-stream', 'stream']);
});

test('replaced system prompt fails system_echo and tool_replay', async () => {
  assert.deepEqual(failedChecks(await probe({ dropSystem: true })), ['system_echo', 'tool_replay']);
});

test('upstream without tool support fails the tool checks only', async () => {
  assert.deepEqual(failedChecks(await probe({ noTools: true })), ['tool_call', 'tool_replay']);
});

test('truncated tool arguments fail tool_call', async () => {
  assert.deepEqual(failedChecks(await probe({ truncatedArgs: true })), ['tool_call']);
});

test('lost tool result fails tool_replay', async () => {
  assert.deepEqual(failedChecks(await probe({ dropToolResult: true })), ['tool_replay']);
});

test('upstream errors never expose the API key', async () => {
  const results = await probe({ rejectAll: true });
  assert.ok(results.every(row => !row.ok && row.detail.startsWith('API error 401')));
  assert.ok(results.every(row => !row.detail.includes(API_KEY)));
  assert.equal(redactSecret(`bad key ${API_KEY}!`, API_KEY), 'bad key ***!');
});

test('config reports every missing variable without echoing values', () => {
  assert.throws(
    () => loadUpstreamConfig({ AGENT_EVAL_API_KEY: API_KEY }),
    error => /AGENT_EVAL_API_BASE/.test(error.message)
      && /AGENT_EVAL_MODELS/.test(error.message)
      && !error.message.includes(API_KEY),
  );
  assert.deepEqual(
    loadUpstreamConfig({ AGENT_EVAL_API_BASE: 'https://example.test/v1/', AGENT_EVAL_API_KEY: API_KEY, AGENT_EVAL_MODELS: 'a, b,' }),
    { apiBase: 'https://example.test/v1', apiKey: API_KEY, models: ['a', 'b'] },
  );
});
