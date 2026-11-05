import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import {
  buildChatRequestBody,
  completeRequest,
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
import { compactAgentHistory } from './compaction';
import {
  agentCalibrationRatio,
  agentCompactThreshold,
  agentInputBudget,
  agentOutputReserve,
  publicLastUsage,
  readAgentLastUsage,
  saveAgentLastUsage,
  toAgentLastUsage,
  type AgentContextStatus,
  type AgentLastUsage,
} from './context';
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
  type AgentSession,
} from './store';
import { parseToolArguments, toolDefinitions } from './tools/registry';
import type { AgentTool, AgentToolContext, AgentToolResult } from './tools/types';

export const AGENT_MAX_ROUNDS = 25;
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
  /** 每次请求上游前的上下文占用，与是否压缩、折叠的判断用同一个数。 */
  onContext?(status: AgentContextStatus): void;
  onCompaction?(event: AgentCompactionEvent): void;
}

export type AgentCompactionEvent =
  | { phase: 'start' }
  | { phase: 'done'; through_id: number; summary: string; tokens_before: number }
  | { phase: 'failed' };

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
export const COMPACT_FAILED_NOTE = '自动压缩上下文失败，这一轮改为折叠较早的工具结果继续。';
const COMPACTION_PREFIX = '（系统记录：较早的对话已压缩为下面的摘要，原始记录仍保存在会话里。需要具体数据时请用工具重新查询。）';

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
    case 'memory_undo':
      return `（系统记录：主人撤销了 Agent 笔记版本 ${payload.version_id} 的追加，memory.md 已恢复；以后以当前笔记为准。）`;
    case 'round_limit':
      return `（系统记录：上一轮连续调用工具达到 ${payload.rounds} 轮上限后暂停。主人说「继续」时接着做。）`;
    case 'error':
      return '（系统记录：上一轮因请求失败中断。）';
    case 'proposal_decision':
      return `（系统记录：主人处理了提案 #${payload.proposal_id}。\n${payload.items.map(decisionLine).join('\n')}\n只有「已批准并生效」的项改了记忆。）`;
    case 'compaction':
      // 摘要由 buildHistoryEntries 放在历史开头，不在原位置重复
      return null;
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
  /** 组成这条消息的第一行 id；行写入后不再修改，可用来缓存 token 估算。压缩摘要用负的事件行 id。 */
  key: number;
  message: AgentRequestMessage;
}

interface CompactionRecord {
  rowId: number;
  throughId: number;
  summary: string;
}

/** 最近一次压缩。它的 through_id 最大，更早的压缩已被它包含。 */
function latestCompaction(rows: readonly AgentMessageRow[]): CompactionRecord | null {
  let latest: CompactionRecord | null = null;
  for (const row of rows) {
    if (row.role !== 'event') continue;
    const payload = parseEventPayload(row.content);
    if (payload?.kind !== 'compaction') continue;
    if (!Number.isInteger(payload.through_id) || typeof payload.summary !== 'string' || !payload.summary.trim()) continue;
    if (!latest || payload.through_id >= latest.throughId) {
      latest = { rowId: row.id, throughId: payload.through_id, summary: payload.summary };
    }
  }
  return latest;
}

function isCompactionRow(row: AgentMessageRow): boolean {
  return row.role === 'event' && parseEventPayload(row.content)?.kind === 'compaction';
}

/**
 * 把会话历史转成发给上游的消息。
 *
 * - 有压缩记录时，`through_id` 及更早的行由摘要代替，摘要放在开头，与紧随的 user 合并。
 * - 相邻的 user 与 event 合并成一条 user：部分上游拒绝连续的同角色消息。
 * - 思考链等 `assistant_fields` 只回传本轮（最后一条 user 之后）的 assistant：
 *   上游要求工具循环内带回，而部分上游拒绝历史轮次里的思考链。
 */
function buildHistoryEntries(rows: readonly AgentMessageRow[]): ContextEntry[] {
  let lastUserId = 0;
  for (const row of rows) {
    if (row.role === 'user') lastUserId = row.id;
  }
  const compaction = latestCompaction(rows);

  const entries: ContextEntry[] = [];
  let pending: { key: number; parts: string[] } | null = compaction
    ? { key: -compaction.rowId, parts: [`${COMPACTION_PREFIX}\n\n${compaction.summary}`] }
    : null;
  const flush = () => {
    if (pending) entries.push({ key: pending.key, message: { role: 'user', content: pending.parts.join('\n\n') } });
    pending = null;
  };

  for (const row of rows) {
    if (compaction && row.id <= compaction.throughId) continue;
    if (isCompactionRow(row)) continue;
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
    note: name === 'remember'
      ? '笔记写入结果已折叠，不得重复 remember；原追加内容在 arguments 中，下一轮以当前 memory.md 为准。'
      : '较早的结果已折叠以节省上下文；需要引用时用相同参数重新调用。',
    tool: name,
    arguments: args,
  });
}

/**
 * 超过预算时从最旧的工具结果开始折叠成占位，`tool_call_id` 不变。
 * 最后一组工具结果是模型刚要的，通常不折叠，否则它会反复重调；
 * 只有它连输入可用空间（`hardLimit`）都装不下时，才把其中过大的结果换成提示。
 */
function foldToolResults(
  entries: readonly ContextEntry[],
  tokenOf: (entry: ContextEntry) => number,
  fixedTokens: number,
  limit: number,
  hardLimit: number,
): { messages: AgentRequestMessage[]; overLimit: boolean; total: number } {
  let total = fixedTokens;
  for (const entry of entries) total += tokenOf(entry);
  const messages = entries.map(entry => entry.message);
  if (total <= limit) return { messages, overLimit: false, total };

  let lastToolRoundStart = entries.length;
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const message = entries[i].message;
    if (message.role === 'assistant' && Array.isArray(message.tool_calls)) {
      lastToolRoundStart = i;
      break;
    }
  }

  const callArguments = new Map<string, string>();
  for (let i = 0; i < lastToolRoundStart && total > limit; i += 1) {
    const entry = entries[i];
    if (entry.message.role !== 'tool') {
      // 只关联当前 assistant 后的工具结果，避免跨回合复用 ID 时覆盖原参数。
      callArguments.clear();
      if (entry.message.role === 'assistant' && Array.isArray(entry.message.tool_calls)) {
        for (const call of entry.message.tool_calls as StoredToolCall[]) callArguments.set(call.id, call.function.arguments);
      }
      continue;
    }
    const placeholder = foldedPlaceholder(String(entry.message.name), callArguments.get(String(entry.message.tool_call_id)));
    const folded: AgentRequestMessage = { ...entry.message, content: placeholder };
    total += estimateTokens(JSON.stringify(folded)) - tokenOf(entry);
    messages[i] = folded;
  }

  // 折叠完旧结果仍超过输入可用空间：最后一组本身就装不下，原样发出去会把请求撑过窗口
  // （曾有一组两条结果共约 1MB）。从最大的结果开始换成「结果过大」提示，让模型缩小范围重调；
  // 库里的原始结果不变。只超压缩阈值、还装得下时照旧原样发送。
  if (total > hardLimit) {
    const lastRound = entries
      .map((entry, index) => ({ entry, index }))
      .slice(lastToolRoundStart + 1)
      .filter(({ entry }) => entry.message.role === 'tool')
      .sort((a, b) => tokenOf(b.entry) - tokenOf(a.entry));
    for (const { entry, index } of lastRound) {
      if (total <= hardLimit) break;
      const tokens = tokenOf(entry);
      const replaced: AgentRequestMessage = { ...entry.message, content: oversizedPlaceholder(String(entry.message.name), tokens) };
      const replacedTokens = estimateTokens(JSON.stringify(replaced));
      if (replacedTokens >= tokens) continue;
      total += replacedTokens - tokens;
      messages[index] = replaced;
    }
  }
  return { messages, overLimit: total > limit, total };
}

function oversizedPlaceholder(name: string, tokens: number): string {
  return JSON.stringify({
    ok: false,
    oversized: true,
    tool: name,
    estimated_tokens: tokens,
    error: '这次结果太大，放不进上下文，没有发给你。请缩小范围重新调用：减少一次传入的 ID、调小 limit，或按结果里的 offset 分页读取。没读到的内容不能当作不存在。',
  });
}

/** 压缩时交给摘要模型的纯文本记录；无法解析或不发给模型的事件跳过。 */
function transcriptBlock(row: AgentMessageRow): string | null {
  switch (row.role) {
    case 'user':
      return `【主人】\n${row.content}`;
    case 'assistant': {
      const calls = parseStoredToolCalls(row.tool_calls_json) ?? [];
      const lines = calls.map(call => `→ 调用 ${call.function.name} ${call.function.arguments}`);
      const text = [row.content.trim(), ...lines].filter(Boolean).join('\n');
      return text ? `【Agent】\n${text}` : null;
    }
    case 'tool':
      return `【工具结果 ${row.tool_name ?? ''}】\n${row.content}`;
    case 'event':
      return eventText(row.content);
  }
}

/**
 * 本轮可以压缩的行：上次压缩之后、本轮主人消息之前。边界落在两轮之间，
 * 不会拆开一组工具调用和结果。没有 user/assistant/tool 行时不值得压缩。
 */
function compactableRows(rows: readonly AgentMessageRow[], userMessageId: number) {
  const previous = latestCompaction(rows);
  const pending = rows.filter(row => row.id < userMessageId
    && (!previous || row.id > previous.throughId)
    && !isCompactionRow(row));
  if (!pending.some(row => row.role !== 'event')) return null;
  return { rows: pending, throughId: pending[pending.length - 1].id, previousSummary: previous?.summary ?? null };
}

interface AgentContextSetup {
  systemPrompt: string;
  definitions: ReturnType<typeof toolDefinitions> | undefined;
  fixedTokens: number;
  window: number;
  threshold: number;
  /** 输入可用空间：最后一组工具结果超过它时才会被换成「结果过大」提示 */
  inputBudget: number;
  reserve: number;
}

/** 系统提示、工具定义与阈值。文档在这里读一次：主人保存后下一轮生效，本轮内保持不变。 */
function buildContextSetup(
  db: Database.Database,
  session: AgentSession,
  tools: readonly AgentTool[],
  skills: readonly AgentPromptSkill[],
  settings: Settings,
  window: number,
): AgentContextSetup {
  const definitions = tools.length > 0 ? toolDefinitions(tools) : undefined;
  const characterName = session.character_id
    ? (db.prepare('SELECT name FROM characters WHERE id = ?').get(session.character_id) as { name: string } | undefined)?.name ?? null
    : null;
  const systemPrompt = buildAgentSystemPrompt({
    agentsMd: readAgentDocument(db, 'agents').content,
    memoryMd: readAgentDocument(db, 'memory').content,
    skills,
    characterId: session.character_id,
    characterName,
    conversationId: session.conversation_id,
  });
  const fixedTokens = estimateTokens(systemPrompt) + (definitions ? estimateTokens(JSON.stringify(definitions)) : 0);
  const reserve = agentOutputReserve(settings);
  return {
    systemPrompt, definitions, fixedTokens, window,
    threshold: agentCompactThreshold(window, reserve), inputBudget: agentInputBudget(window, reserve), reserve,
  };
}

function createTokenCounter() {
  const cache = new Map<number, number>();
  return (entry: ContextEntry) => {
    let count = cache.get(entry.key);
    if (count === undefined) {
      count = estimateTokens(JSON.stringify(entry.message));
      cache.set(entry.key, count);
    }
    return count;
  };
}

/**
 * 会话当前的上下文占用（不在运行时给界面用）：系统提示、工具定义和上次压缩后的完整历史，
 * 不含折叠——下一轮开始时超过阈值会先压缩。
 */
export function getAgentContextStatus(
  db: Database.Database,
  sessionId: string,
  input: { tools: readonly AgentTool[]; skills?: readonly AgentPromptSkill[]; settings?: Settings },
): AgentContextStatus | null {
  const session = getAgentSession(db, sessionId);
  if (!session) return null;
  const settings = input.settings ?? loadSettings();
  const config = resolveAgentConfig(settings);
  const setup = buildContextSetup(db, session, input.tools, input.skills ?? [], settings, config.context_window);
  const tokenOf = createTokenCounter();
  let total = setup.fixedTokens;
  for (const entry of buildHistoryEntries(listAgentMessages(db, sessionId))) total += tokenOf(entry);
  const lastUsage = readAgentLastUsage(db, sessionId);
  return {
    window: setup.window,
    used: Math.ceil(total * agentCalibrationRatio(lastUsage, config.model)),
    threshold: setup.threshold,
    last_usage: publicLastUsage(lastUsage),
  };
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

  const userMessageId = appendAgentUserMessage(db, sessionId, input.userContent, now());

  const config = resolveAgentConfig(settings);
  const llmSettings: Settings = {
    ...settings,
    api_base: config.api_base,
    api_key: config.api_key,
    model: config.model,
    reasoning_effort: config.reasoning_effort,
  };
  const toolsByName = new Map(input.tools.map(tool => [tool.name, tool]));
  const setup = buildContextSetup(db, session, input.tools, input.skills ?? [], settings, config.context_window);
  const { systemPrompt, definitions, fixedTokens, threshold } = setup;
  const tokenOf = createTokenCounter();
  let lastUsage: AgentLastUsage | null = readAgentLastUsage(db, sessionId);
  const toolContext: AgentToolContext = { db, settings, sessionId, signal };

  let lastCallKey = '';
  let repeatCount = 0;
  let overLimitNoted = false;
  let compactionFailed = false;

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
    // 估算按真实 usage 放大后再与阈值比较；折叠用的是未放大的估算，所以阈值反过来缩小
    const ratio = agentCalibrationRatio(lastUsage, config.model);
    const rawLimit = Math.floor(threshold / ratio);
    let rows = listAgentMessages(db, sessionId);
    let entries = buildHistoryEntries(rows);
    const estimate = entries.reduce((sum, entry) => sum + tokenOf(entry), fixedTokens);

    if (estimate > rawLimit && !compactionFailed) {
      const pending = compactableRows(rows, userMessageId);
      if (pending) {
        events.onCompaction?.({ phase: 'start' });
        try {
          const summary = await compactAgentHistory({
            blocks: pending.rows.map(transcriptBlock).filter((block): block is string => block !== null),
            previousSummary: pending.previousSummary,
            settings: llmSettings,
            complete,
            inputBudget: rawLimit,
            maxTokens: setup.reserve,
            streaming: settings.streaming !== false,
            timeoutMs: settings.memory_background_timeout_ms,
            signal,
          });
          if (signal?.aborted) throw new Error('aborted');
          const tokensBefore = Math.ceil(estimate * ratio);
          db.transaction(() => {
            appendAgentMessage(db, sessionId, {
              role: 'event',
              content: JSON.stringify({ kind: 'compaction', through_id: pending.throughId, summary, tokens_before: tokensBefore }),
            }, now());
            touchAgentSession(db, sessionId, now());
          })();
          events.onCompaction?.({ phase: 'done', through_id: pending.throughId, summary, tokens_before: tokensBefore });
          rows = listAgentMessages(db, sessionId);
          entries = buildHistoryEntries(rows);
        } catch {
          if (signal?.aborted) {
            saveInterruptedText('');
            return { status: 'aborted', rounds: round };
          }
          // 压缩失败不让本轮失败：退回折叠，本轮不再重试，免得每个回合都多一次失败的请求
          compactionFailed = true;
          events.onCompaction?.({ phase: 'failed' });
          events.onNote?.(COMPACT_FAILED_NOTE);
        }
      }
    }

    const rawHardLimit = Math.floor(setup.inputBudget / ratio);
    const { messages: history, overLimit, total } = foldToolResults(entries, tokenOf, fixedTokens, rawLimit, rawHardLimit);
    if (overLimit && !overLimitNoted) {
      overLimitNoted = true;
      events.onNote?.(CONTEXT_OVER_LIMIT_NOTE);
    }
    events.onContext?.({
      window: setup.window,
      used: Math.ceil(total * ratio),
      threshold,
      last_usage: publicLastUsage(lastUsage),
    });

    const body = buildChatRequestBody(llmSettings, settings.streaming !== false);
    body.max_tokens = setup.reserve;
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
          onUsage: usage => {
            lastUsage = toAgentLastUsage(usage, config.model, total, now());
            try {
              saveAgentLastUsage(db, sessionId, lastUsage);
            } catch {
              // 统计写入失败不影响本轮
            }
            events.onUsage?.(usage);
          },
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
