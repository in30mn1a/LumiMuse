import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import {
  buildChatRequestBody,
  completeRequest,
  REASONING_SAFE_MAX_TOKENS,
  type ChatToolCall,
  type CompletionRequestOptions,
  type CompletionRequestResult,
  type LlmUsage,
} from '@/lib/api-client';
import { runWithBackgroundLlmDeadline } from '@/lib/background-llm-deadline';
import { publicErrorMessage } from '@/lib/public-error';
import { loadSettings, resolveAgentConfig } from '@/lib/settings';
import { estimateTokens } from '@/lib/token-counter';
import type { Settings } from '@/types';
import { readAgentDocument } from './documents';
import {
  parseEventPayload,
  parseStoredToolCalls,
  type AgentEventPayload,
  type ProposalDecisionEventItem,
  type StoredToolCall,
} from './messages';
import { buildAgentSystemPrompt, type AgentPromptSkill } from './prompt';
import {
  appendAgentMessage,
  appendAgentUserMessage,
  getAgentSession,
  listAgentMessages,
  touchAgentSession,
  type AgentMessageRow,
} from './store';
import { parseToolArguments, toolDefinitions } from './tools/registry';
import type { AgentTool, AgentToolContext, AgentToolResult } from './tools/types';

export const AGENT_MAX_ROUNDS = 25;
/** 估算超过 context_window 的这个比例时折叠较旧的工具结果。 */
export const AGENT_CONTEXT_FOLD_RATIO = 0.7;
/** 相同工具和参数连续调用到第几次时附加提醒。 */
const REPEAT_REMINDER_AT = 3;

export type AgentRequestMessage = { role: 'system' | 'user' | 'assistant' | 'tool'; content: string } & Record<string, unknown>;

export type AgentCompleteFn = (
  settings: Settings,
  body: Record<string, unknown>,
  options: CompletionRequestOptions,
) => Promise<CompletionRequestResult>;

export interface AgentTurnEvents {
  onText?(delta: string): void;
  onToolStart?(call: { id: string; name: string; arguments: string }): void;
  onToolEnd?(call: { id: string; name: string; result: AgentToolResult }): void;
  onUsage?(usage: LlmUsage): void;
  /** 不入库的提示，例如上下文折叠后仍然超出。 */
  onNote?(note: string): void;
}

export type AgentTurnStatus = 'done' | 'aborted' | 'round_limit' | 'terminated' | 'error';

export interface AgentTurnResult {
  status: AgentTurnStatus;
  rounds: number;
  error?: string;
}

export interface RunAgentTurnInput {
  db: Database.Database;
  sessionId: string;
  userContent: string;
  tools: readonly AgentTool[];
  skills?: readonly AgentPromptSkill[];
  signal?: AbortSignal;
  settings?: Settings;
  complete?: AgentCompleteFn;
  now?: () => string;
  events?: AgentTurnEvents;
  maxRounds?: number;
}

export const CONTEXT_OVER_LIMIT_NOTE = '上下文已接近模型上限，较早的工具结果已折叠。如果回复变差，建议新建会话。';
export const EMPTY_REPLY_NOTE = '模型没有返回内容。如果用的是推理模型，可能是思考用完了输出长度。';

function decisionLine(item: ProposalDecisionEventItem): string {
  const head = `- 第 ${item.seq} 项（${item.op}）：`;
  switch (item.state) {
    case 'applied':
      return `${head}已批准并生效`;
    case 'rejected':
      return item.reason ? `${head}主人拒绝，原因：${item.reason}` : `${head}主人拒绝，没有填写原因`;
    case 'stale':
      return `${head}已跳过，${item.reason ?? '目标在提案生成后已被改动'}`;
    case 'failed':
      return `${head}应用失败：${item.reason ?? '未知错误'}`;
  }
}

/** 不认识的记录（例如新版本写入的）不发给模型。 */
function eventModelText(payload: AgentEventPayload): string | null {
  switch (payload.kind) {
    case 'interrupted':
      return '（系统记录：上一轮中断，未完成的工具调用没有执行。）';
    case 'round_limit':
      return `（系统记录：上一轮连续调用工具达到 ${payload.rounds} 轮上限后暂停。主人说「继续」时接着做。）`;
    case 'error':
      return '（系统记录：上一轮因请求失败中断。）';
    case 'proposal_decision':
      return `（系统记录：主人处理了提案 #${payload.proposal_id}。\n${payload.items.map(decisionLine).join('\n')}\n只有「已批准并生效」的项改了记忆。）`;
    default:
      return null;
  }
}

function parseJson<T>(text: string | null): T | null {
  if (!text) return null;
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

interface ContextEntry {
  /** 组成这条消息的第一行 id；行写入后不再修改，可用来缓存 token 估算。 */
  key: number;
  message: AgentRequestMessage;
}

/**
 * 把会话历史转成发给上游的消息。
 *
 * - 相邻的 user 与 event 合并成一条 user：部分上游拒绝连续的同角色消息。
 * - 思考链等 `assistant_fields` 只回传本轮（最后一条 user 之后）的 assistant：
 *   上游要求工具循环内带回，而部分上游拒绝历史轮次里的思考链。
 */
function buildHistoryEntries(rows: readonly AgentMessageRow[]): ContextEntry[] {
  let lastUserId = 0;
  for (const row of rows) {
    if (row.role === 'user') lastUserId = row.id;
  }

  const entries: ContextEntry[] = [];
  let pending: { key: number; parts: string[] } | null = null;
  const flush = () => {
    if (pending) entries.push({ key: pending.key, message: { role: 'user', content: pending.parts.join('\n\n') } });
    pending = null;
  };

  for (const row of rows) {
    if (row.role === 'user' || row.role === 'event') {
      const text = row.role === 'user' ? row.content : eventText(row.content);
      if (text === null) continue;
      if (!pending) pending = { key: row.id, parts: [] };
      pending.parts.push(text);
      continue;
    }
    flush();
    if (row.role === 'assistant') {
      const message: AgentRequestMessage = { role: 'assistant', content: row.content };
      if (row.id > lastUserId) {
        Object.assign(message, parseJson<Record<string, unknown>>(row.assistant_fields_json) ?? {});
      }
      const toolCalls = parseStoredToolCalls(row.tool_calls_json);
      if (toolCalls) message.tool_calls = toolCalls;
      entries.push({ key: row.id, message });
    } else {
      entries.push({
        key: row.id,
        message: { role: 'tool', tool_call_id: row.tool_call_id ?? '', name: row.tool_name ?? '', content: row.content },
      });
    }
  }
  flush();
  return entries;
}

function eventText(content: string): string | null {
  const payload = parseEventPayload(content);
  return payload ? eventModelText(payload) : null;
}

/** 测试与调试用：不折叠时发给上游的历史消息。 */
export function buildAgentHistoryMessages(rows: readonly AgentMessageRow[]): AgentRequestMessage[] {
  return buildHistoryEntries(rows).map(entry => entry.message);
}

function foldedPlaceholder(name: string, rawArguments: string | undefined): string {
  let args: unknown = rawArguments ?? '';
  try {
    args = rawArguments ? JSON.parse(rawArguments) : {};
  } catch {
    // 保留原始字符串
  }
  return JSON.stringify({
    ok: true,
    folded: true,
    note: '较早的结果已折叠以节省上下文；需要引用时用相同参数重新调用。',
    tool: name,
    arguments: args,
  });
}

/**
 * 超过预算时从最旧的工具结果开始折叠成占位，`tool_call_id` 不变。
 * 最后一组工具结果是模型刚要的，不折叠，否则它会反复重调。
 */
function foldToolResults(
  entries: readonly ContextEntry[],
  tokenOf: (entry: ContextEntry) => number,
  fixedTokens: number,
  limit: number,
): { messages: AgentRequestMessage[]; overLimit: boolean } {
  let total = fixedTokens;
  for (const entry of entries) total += tokenOf(entry);
  const messages = entries.map(entry => entry.message);
  if (total <= limit) return { messages, overLimit: false };

  let lastToolRoundStart = entries.length;
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const message = entries[i].message;
    if (message.role === 'assistant' && Array.isArray(message.tool_calls)) {
      lastToolRoundStart = i;
      break;
    }
  }

  const callArguments = new Map<string, string>();
  for (const { message } of entries) {
    if (message.role !== 'assistant' || !Array.isArray(message.tool_calls)) continue;
    for (const call of message.tool_calls as StoredToolCall[]) callArguments.set(call.id, call.function.arguments);
  }

  for (let i = 0; i < lastToolRoundStart && total > limit; i += 1) {
    const entry = entries[i];
    if (entry.message.role !== 'tool') continue;
    const placeholder = foldedPlaceholder(String(entry.message.name), callArguments.get(String(entry.message.tool_call_id)));
    const folded: AgentRequestMessage = { ...entry.message, content: placeholder };
    total += estimateTokens(JSON.stringify(folded)) - tokenOf(entry);
    messages[i] = folded;
  }
  return { messages, overLimit: total > limit };
}

function stableCallKey(tool: AgentTool | undefined, call: ChatToolCall): string {
  if (tool) {
    const parsed = parseToolArguments(tool, call.arguments);
    if (parsed.ok) return `${call.name}\u0000${JSON.stringify(parsed.args)}`;
  }
  return `${call.name}\u0000${call.arguments.trim()}`;
}

function serializeResult(result: AgentToolResult, repeatCount: number, name: string): string {
  const text = JSON.stringify(result);
  if (repeatCount < REPEAT_REMINDER_AT) return text;
  return `${text}\n\n[提醒] 你已经连续 ${repeatCount} 次用相同参数调用 ${name}，结果不会变化。请换个思路，或者根据已有结果回答。`;
}

function toolErrorResult(error: unknown): AgentToolResult {
  return { ok: false, error: publicErrorMessage(error, '工具执行失败') };
}

/**
 * 运行一轮 Agent 对话：先保存主人的消息，再循环「调用模型 → 执行工具」直到模型不再调用工具。
 *
 * 每个回合分两步，保证数据库里要么有完整的 assistant 和全部配对的工具结果，要么这一回合不存在：
 * 1. 只读工具串行执行，结果只放内存；中止时整回合丢弃，重读没有副作用。
 * 2. 写入工具和本回合的全部消息在同一个事务里提交；写入工具是同步函数，由类型保证。
 */
export async function runAgentTurn(input: RunAgentTurnInput): Promise<AgentTurnResult> {
  const { db, sessionId, signal, events = {} } = input;
  const now = input.now ?? (() => new Date().toISOString());
  const complete = input.complete ?? completeRequest;
  const maxRounds = input.maxRounds ?? AGENT_MAX_ROUNDS;
  const settings = input.settings ?? loadSettings();
  const session = getAgentSession(db, sessionId);
  if (!session) return { status: 'error', rounds: 0, error: '会话不存在' };

  appendAgentUserMessage(db, sessionId, input.userContent, now());

  const config = resolveAgentConfig(settings);
  const llmSettings: Settings = {
    ...settings,
    api_base: config.api_base,
    api_key: config.api_key,
    model: config.model,
    reasoning_effort: config.reasoning_effort,
  };
  const toolsByName = new Map(input.tools.map(tool => [tool.name, tool]));
  const definitions = input.tools.length > 0 ? toolDefinitions(input.tools) : undefined;
  const characterName = session.character_id
    ? (db.prepare('SELECT name FROM characters WHERE id = ?').get(session.character_id) as { name: string } | undefined)?.name ?? null
    : null;
  // 每轮开始时读一次文档：主人保存后下一轮生效，本轮内保持不变
  const systemPrompt = buildAgentSystemPrompt({
    agentsMd: readAgentDocument(db, 'agents').content,
    memoryMd: readAgentDocument(db, 'memory').content,
    skills: input.skills ?? [],
    characterId: session.character_id,
    characterName,
    conversationId: session.conversation_id,
  });
  const fixedTokens = estimateTokens(systemPrompt) + (definitions ? estimateTokens(JSON.stringify(definitions)) : 0);
  const contextLimit = Math.floor(settings.context_window * AGENT_CONTEXT_FOLD_RATIO);
  const tokenCache = new Map<number, number>();
  const tokenOf = (entry: ContextEntry) => {
    let count = tokenCache.get(entry.key);
    if (count === undefined) {
      count = estimateTokens(JSON.stringify(entry.message));
      tokenCache.set(entry.key, count);
    }
    return count;
  };
  const toolContext: AgentToolContext = { db, settings, sessionId, signal };

  let lastCallKey = '';
  let repeatCount = 0;
  let overLimitNoted = false;

  const writeEvent = (payload: AgentEventPayload) => {
    try {
      appendAgentMessage(db, sessionId, { role: 'event', content: JSON.stringify(payload) }, now());
      touchAgentSession(db, sessionId, now());
    } catch {
      // 记录失败不能掩盖本轮真正的结果
    }
  };
  const saveInterruptedText = (text: string) => {
    db.transaction(() => {
      if (text) appendAgentMessage(db, sessionId, { role: 'assistant', content: text }, now());
      appendAgentMessage(db, sessionId, { role: 'event', content: JSON.stringify({ kind: 'interrupted' }) }, now());
      touchAgentSession(db, sessionId, now());
    })();
  };
  const fail = (error: unknown, rounds: number): AgentTurnResult => {
    const message = publicErrorMessage(error, 'Agent 运行失败');
    writeEvent({ kind: 'error', message });
    return { status: 'error', rounds, error: message };
  };

  for (let round = 1; round <= maxRounds; round += 1) {
    const { messages: history, overLimit } = foldToolResults(
      buildHistoryEntries(listAgentMessages(db, sessionId)),
      tokenOf,
      fixedTokens,
      contextLimit,
    );
    if (overLimit && !overLimitNoted) {
      overLimitNoted = true;
      events.onNote?.(CONTEXT_OVER_LIMIT_NOTE);
    }

    const body = buildChatRequestBody(llmSettings, settings.streaming !== false);
    body.max_tokens = Math.max(llmSettings.max_tokens || 0, REASONING_SAFE_MAX_TOKENS);
    body.messages = [{ role: 'system', content: systemPrompt }, ...history];
    if (definitions) body.tools = definitions;

    let streamedText = '';
    let result: CompletionRequestResult;
    try {
      result = await runWithBackgroundLlmDeadline(
        settings.memory_background_timeout_ms,
        deadlineSignal => complete(llmSettings, body, {
          signal: deadlineSignal,
          onText: delta => {
            streamedText += delta;
            events.onText?.(delta);
          },
          onUsage: usage => events.onUsage?.(usage),
        }),
        signal,
      );
    } catch (error) {
      if (signal?.aborted) {
        saveInterruptedText(streamedText);
        return { status: 'aborted', rounds: round };
      }
      return fail(error, round);
    }

    if (signal?.aborted) {
      saveInterruptedText(result.text);
      return { status: 'aborted', rounds: round };
    }

    if (result.completed === false || result.finishReason === 'length') {
      saveInterruptedText(result.text);
      return { status: 'aborted', rounds: round };
    }

    const calls = result.toolCalls;
    if (calls.length === 0) {
      if (!result.text.trim()) return fail(new Error(EMPTY_REPLY_NOTE), round);
      db.transaction(() => {
        if (result.text) {
          appendAgentMessage(db, sessionId, {
            role: 'assistant',
            content: result.text,
            assistant_fields_json: result.assistantFields ? JSON.stringify(result.assistantFields) : null,
          }, now());
        }
        touchAgentSession(db, sessionId, now());
      })();
      return { status: 'done', rounds: round };
    }

    const seenIds = new Set<string>();
    const storedCalls: StoredToolCall[] = calls.map(call => {
      let id = call.id;
      if (!id || seenIds.has(id)) id = `call_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
      seenIds.add(id);
      return {
        id,
        type: 'function',
        function: { name: call.name, arguments: call.arguments || '{}' },
        ...(call.extra_content === undefined ? {} : { extra_content: call.extra_content }),
      };
    });
    const repeatCounts = calls.map(call => {
      const key = stableCallKey(toolsByName.get(call.name), call);
      repeatCount = key === lastCallKey ? repeatCount + 1 : 1;
      lastCallKey = key;
      return repeatCount;
    });

    // 第一步：只读工具，结果只放内存
    const results: (AgentToolResult | undefined)[] = new Array(calls.length);
    for (let i = 0; i < calls.length; i += 1) {
      const tool = toolsByName.get(calls[i].name);
      if (tool?.kind === 'write') continue;
      events.onToolStart?.({ id: storedCalls[i].id, name: calls[i].name, arguments: calls[i].arguments });
      if (!tool) {
        results[i] = { ok: false, error: `未知工具：${calls[i].name}` };
        continue;
      }
      const parsed = parseToolArguments(tool, calls[i].arguments);
      if (!parsed.ok) {
        results[i] = { ok: false, error: parsed.error };
        continue;
      }
      try {
        results[i] = await tool.execute(parsed.args, toolContext);
      } catch (error) {
        results[i] = toolErrorResult(error);
      }
      if (signal?.aborted) break;
    }
    if (signal?.aborted) {
      saveInterruptedText(result.text);
      return { status: 'aborted', rounds: round };
    }

    // 第二步：写入工具与本回合消息一起提交
    let terminate = false;
    try {
      db.transaction(() => {
        for (let i = 0; i < calls.length; i += 1) {
          const tool = toolsByName.get(calls[i].name);
          if (tool?.kind !== 'write') continue;
          events.onToolStart?.({ id: storedCalls[i].id, name: calls[i].name, arguments: calls[i].arguments });
          const parsed = parseToolArguments(tool, calls[i].arguments);
          if (!parsed.ok) {
            results[i] = { ok: false, error: parsed.error };
            continue;
          }
          try {
            // 嵌套事务即 SAVEPOINT：工具中途抛错时只撤销它自己的写入
            const outcome = db.transaction(() => tool.execute(parsed.args, toolContext))();
            results[i] = outcome.result;
            if (outcome.terminate) terminate = true;
          } catch (error) {
            results[i] = toolErrorResult(error);
          }
        }
        const createdAt = now();
        appendAgentMessage(db, sessionId, {
          role: 'assistant',
          content: result.text,
          tool_calls_json: JSON.stringify(storedCalls),
          assistant_fields_json: result.assistantFields ? JSON.stringify(result.assistantFields) : null,
        }, createdAt);
        for (let i = 0; i < calls.length; i += 1) {
          appendAgentMessage(db, sessionId, {
            role: 'tool',
            content: serializeResult(results[i] ?? { ok: false, error: '工具没有返回结果' }, repeatCounts[i], calls[i].name),
            tool_call_id: storedCalls[i].id,
            tool_name: calls[i].name,
          }, createdAt);
        }
        touchAgentSession(db, sessionId, createdAt);
      })();
    } catch (error) {
      return fail(error, round);
    }

    for (let i = 0; i < calls.length; i += 1) {
      events.onToolEnd?.({ id: storedCalls[i].id, name: calls[i].name, result: results[i] ?? { ok: false, error: '工具没有返回结果' } });
    }
    if (terminate) return { status: 'terminated', rounds: round };
  }

  writeEvent({ kind: 'round_limit', rounds: maxRounds });
  return { status: 'round_limit', rounds: maxRounds };
}
