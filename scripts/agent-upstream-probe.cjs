/**
 * 验证生产上游能否支撑内置 Agent（TASK-UPSTREAM-PROBE）。
 *
 * 对每个模型分别走流式和非流式，检查三件事：
 *   system_echo  长系统提示词末尾的校验码能被复述（中转站曾把 system 整段替换掉）
 *   tool_call    工具调用完整返回，参数是合法 JSON 且值正确
 *   tool_replay  两轮工具回灌（带 assistantFields）后仍能继续，且系统提示词没丢
 *
 * 校验码和工具返回值每次随机生成，模型猜不出来，只有真的收到才会通过。
 *
 * Usage: node scripts/agent-upstream-probe.cjs
 * 配置见 scripts/agent-eval/upstream-config.cjs；结果写到被 gitignore 的 docs/agent-eval/。
 */
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { registerTsLoader } = require('../tests/helpers/register-ts-loader.cjs');
const { loadUpstreamConfig, redactSecret } = require('./agent-eval/upstream-config.cjs');

registerTsLoader();
const { buildChatRequestBody, completeRequest, REASONING_SAFE_MAX_TOKENS } = require('../src/lib/api-client.ts');

const REQUEST_TIMEOUT_MS = 180_000;
const MAX_TOOL_ROUNDS = 6;
const OUTPUT_DIR = path.resolve(__dirname, '..', 'docs', 'agent-eval');
// 模拟 Agent 较长的系统提示词：校验码放在末尾，按大小截断也能被发现。
const SYSTEM_PADDING = '你是 LumiMuse 的后台管家，负责帮主人检查虚构角色的记忆。回答要简短准确。\n'.repeat(120);

function nonce(prefix) {
  return `${prefix}-${crypto.randomBytes(5).toString('hex')}`;
}

function functionTool(name, description, properties) {
  return {
    type: 'function',
    function: {
      name,
      description,
      parameters: { type: 'object', properties, required: Object.keys(properties) },
    },
  };
}

async function requestRound(target, stream, messages, tools) {
  const body = buildChatRequestBody({ model: target.model, max_tokens: REASONING_SAFE_MAX_TOKENS, temperature: 1 }, stream);
  body.messages = messages;
  if (tools) body.tools = tools;
  return completeRequest(
    { api_base: target.apiBase, api_key: target.apiKey, model: target.model },
    body,
    { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) },
  );
}

async function probeSystemEcho(target, stream) {
  const code = nonce('sys');
  const result = await requestRound(target, stream, [
    { role: 'system', content: `${SYSTEM_PADDING}\n本次会话的校验码是 ${code}。用户询问校验码时直接告诉用户。` },
    { role: 'user', content: '你好' },
    { role: 'assistant', content: '你好，有什么需要帮忙的吗？' },
    { role: 'user', content: '这次会话的校验码是多少？' },
  ]);
  if (result.text.includes(code)) return { ok: true };
  return { ok: false, detail: `回复中没有校验码，系统提示词可能被替换或截断（回复 ${result.text.length} 字）` };
}

async function probeToolCall(target, stream) {
  const memoryId = nonce('mem');
  const result = await requestRound(target, stream, [
    { role: 'system', content: '你是记忆检查助手，需要查询记忆时必须调用工具。' },
    { role: 'user', content: `请查询编号为 ${memoryId} 的记忆。` },
  ], [functionTool('get_memory', '按编号读取一条记忆', { memory_id: { type: 'string', description: '记忆编号' } })]);

  const call = result.toolCalls.find(item => item.name === 'get_memory');
  if (!call) return { ok: false, detail: `没有返回工具调用（finish_reason=${result.finishReason}，正文 ${result.text.length} 字）` };
  if (!call.id) return { ok: false, detail: '工具调用缺少 id，无法回灌结果' };
  let args;
  try {
    args = JSON.parse(call.arguments);
  } catch {
    return { ok: false, detail: `工具参数不是合法 JSON（${call.arguments.length} 字），流式分片可能不完整` };
  }
  if (args.memory_id !== memoryId) return { ok: false, detail: '工具参数的值与请求不一致' };
  return { ok: true };
}

function appendToolRound(messages, result, toolResults) {
  const toolCalls = result.toolCalls.map(call => ({
    id: call.id,
    type: 'function',
    function: { name: call.name, arguments: call.arguments || '{}' },
    ...(call.extra_content === undefined ? {} : { extra_content: call.extra_content }),
  }));
  return [
    ...messages,
    { role: 'assistant', content: result.text || '', ...result.assistantFields, tool_calls: toolCalls },
    ...result.toolCalls.map((call, index) => ({
      role: 'tool',
      tool_call_id: call.id,
      name: call.name,
      content: toolResults[index],
    })),
  ];
}

async function probeToolReplay(target, stream) {
  const systemCode = nonce('sys');
  const firstToken = nonce('first');
  const secondToken = nonce('second');
  const tools = [
    functionTool('get_first_token', '读取第一段令牌', { reason: { type: 'string', description: '调用原因' } }),
    functionTool('get_second_token', '用第一段令牌换第二段令牌', { first_token: { type: 'string', description: '第一段令牌' } }),
  ];
  let messages = [
    { role: 'system', content: `${SYSTEM_PADDING}\n本次会话的校验码是 ${systemCode}。每次给出最终回答时都要带上校验码。` },
    { role: 'user', content: '请先调用 get_first_token 拿到第一段令牌，再把它传给 get_second_token 换第二段令牌，最后告诉我第二段令牌。' },
  ];
  let usedFirst = false;
  let usedSecond = false;
  let sawAssistantFields = false;

  for (let round = 0; round < MAX_TOOL_ROUNDS; round += 1) {
    const result = await requestRound(target, stream, messages, tools);
    if (result.assistantFields) sawAssistantFields = true;

    if (result.toolCalls.length === 0) {
      const replayNote = sawAssistantFields ? '已回灌 assistantFields' : '上游未返回 assistantFields';
      if (!usedSecond) return { ok: false, detail: `第 ${round + 1} 轮提前结束，没有走完两次工具调用（${replayNote}）` };
      if (!result.text.includes(secondToken)) return { ok: false, detail: `最终回答没有第二段令牌，工具结果可能没送达（${replayNote}）` };
      if (!result.text.includes(systemCode)) return { ok: false, detail: `多轮后校验码丢失，系统提示词可能没保留（${replayNote}）` };
      return { ok: true, detail: replayNote };
    }

    const toolResults = result.toolCalls.map(call => {
      if (call.name === 'get_first_token') {
        usedFirst = true;
        return JSON.stringify({ first_token: firstToken });
      }
      let args = {};
      try {
        args = JSON.parse(call.arguments || '{}');
      } catch {
        return JSON.stringify({ error: 'invalid arguments' });
      }
      if (args.first_token !== firstToken) return JSON.stringify({ error: 'wrong first_token' });
      usedSecond = true;
      return JSON.stringify({ second_token: secondToken });
    });
    if (result.toolCalls.some(call => !call.id)) return { ok: false, detail: '工具调用缺少 id，无法回灌结果' };
    messages = appendToolRound(messages, result, toolResults);
  }
  return { ok: false, detail: `超过 ${MAX_TOOL_ROUNDS} 轮仍未结束（first=${usedFirst}，second=${usedSecond}）` };
}

const CHECKS = [
  ['system_echo', probeSystemEcho],
  ['tool_call', probeToolCall],
  ['tool_replay', probeToolReplay],
];

async function runProbe({ apiBase, apiKey, models }, log = () => {}) {
  const results = [];
  for (const model of models) {
    for (const stream of [false, true]) {
      for (const [check, run] of CHECKS) {
        const startedAt = Date.now();
        let outcome;
        try {
          outcome = await run({ apiBase, apiKey, model }, stream);
        } catch (error) {
          outcome = { ok: false, detail: redactSecret(error instanceof Error ? error.message : String(error), apiKey) };
        }
        const row = {
          model,
          mode: stream ? 'stream' : 'non-stream',
          check,
          ok: outcome.ok,
          detail: outcome.detail || '',
          elapsed_ms: Date.now() - startedAt,
        };
        results.push(row);
        log(`${row.ok ? 'PASS' : 'FAIL'}  ${row.model}  ${row.mode}  ${row.check}  ${row.elapsed_ms}ms${row.detail ? `  ${row.detail}` : ''}`);
      }
    }
  }
  return results;
}

async function main() {
  const config = loadUpstreamConfig();
  const results = await runProbe(config, console.log);
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outputPath = path.join(OUTPUT_DIR, `probe-${stamp}.json`);
  fs.writeFileSync(outputPath, `${JSON.stringify({ generated_at: new Date().toISOString(), results }, null, 2)}\n`);
  const failed = results.filter(row => !row.ok).length;
  console.log(`\n${results.length - failed}/${results.length} 项通过，结果：${path.relative(process.cwd(), outputPath)}`);
  if (failed > 0) process.exitCode = 1;
}

if (require.main === module) {
  main().catch(error => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}

module.exports = { runProbe };
