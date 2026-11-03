import type { AgentMessageRole, AgentMessageRow } from './store';

/** 存在 `event` 行 content 里的结构化记录；界面按 kind 本地化显示。 */
export type AgentEventPayload =
  | { kind: 'interrupted' }
  | { kind: 'round_limit'; rounds: number }
  | { kind: 'error'; message: string };

/** 存在 `tool_calls_json` 里、也原样发给上游的调用结构。 */
export interface StoredToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
  extra_content?: unknown;
}

export function parseEventPayload(content: string): AgentEventPayload | null {
  try {
    const value = JSON.parse(content) as { kind?: unknown };
    if (value && typeof value.kind === 'string') return value as AgentEventPayload;
  } catch {
    // 无法解析的记录当作不存在
  }
  return null;
}

export function parseStoredToolCalls(json: string | null): StoredToolCall[] | null {
  if (!json) return null;
  try {
    const value = JSON.parse(json) as unknown;
    return Array.isArray(value) && value.length > 0 ? value as StoredToolCall[] : null;
  } catch {
    return null;
  }
}

/** 返回给界面的消息。不含思考链等上游回传字段。 */
export interface AgentMessageView {
  id: number;
  role: AgentMessageRole;
  content: string;
  tool_calls: { id: string; name: string; arguments: string }[] | null;
  tool_call_id: string | null;
  tool_name: string | null;
  /** 工具结果是否成功；非工具行或无法判断时为 null */
  tool_ok: boolean | null;
  event: AgentEventPayload | null;
  created_at: string;
}

/**
 * 工具行 content 的第一行是 `JSON.stringify(result)`（不含换行），之后可能附加重复提醒，
 * 所以只解析第一行。
 */
function parseToolOk(content: string): boolean | null {
  try {
    const value = JSON.parse(content.split('\n', 1)[0]) as { ok?: unknown };
    return typeof value?.ok === 'boolean' ? value.ok : null;
  } catch {
    return null;
  }
}

export function toAgentMessageView(row: AgentMessageRow): AgentMessageView {
  const event = row.role === 'event' ? parseEventPayload(row.content) : null;
  return {
    id: row.id,
    role: row.role,
    content: row.role === 'event' ? '' : row.content,
    tool_calls: parseStoredToolCalls(row.tool_calls_json)?.map(call => ({
      id: call.id,
      name: call.function.name,
      arguments: call.function.arguments,
    })) ?? null,
    tool_call_id: row.tool_call_id,
    tool_name: row.tool_name,
    tool_ok: row.role === 'tool' ? parseToolOk(row.content) : null,
    event,
    created_at: row.created_at,
  };
}
