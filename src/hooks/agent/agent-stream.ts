import type { AgentContextStatus } from '@/lib/agent/context';
import type { AgentTurnStatus } from '@/lib/agent/loop';
import { parseChatSsePart } from '@/lib/chat-stream-client';

/** `/api/agent/chat` 推送的事件（usage 已体现在 context 的 last_usage 里，直接忽略）。 */
export type AgentStreamEvent =
  | { type: 'text'; text: string }
  | { type: 'tool_start'; id: string; name: string; arguments: string }
  | { type: 'tool_end'; id: string; name: string; ok: boolean; error?: string }
  | { type: 'note'; text: string }
  | { type: 'context'; context: AgentContextStatus }
  | { type: 'compaction'; phase: 'start' }
  | { type: 'compaction'; phase: 'failed' }
  | { type: 'compaction'; phase: 'done'; summary: string; tokensBefore: number }
  | { type: 'error'; error: string }
  | { type: 'done'; status: AgentTurnStatus; rounds: number };

function count(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

function toContext(value: Record<string, unknown>): AgentContextStatus | null {
  const window = count(value.window);
  const used = count(value.used);
  const threshold = count(value.threshold);
  if (!window || used === null || threshold === null) return null;
  const usage = value.last_usage && typeof value.last_usage === 'object' ? value.last_usage as Record<string, unknown> : null;
  const prompt = count(usage?.prompt_tokens);
  const completion = count(usage?.completion_tokens);
  const cached = count(usage?.cached_tokens);
  return {
    window,
    used,
    threshold,
    last_usage: prompt === null || completion === null
      ? null
      : { prompt_tokens: prompt, completion_tokens: completion, ...(cached === null ? {} : { cached_tokens: cached }) },
  };
}

function toEvent(eventType: string, data: unknown): AgentStreamEvent | null {
  if (!data || typeof data !== 'object') return null;
  const value = data as Record<string, unknown>;
  const text = (field: unknown) => (typeof field === 'string' ? field : '');
  switch (eventType) {
    case 'text':
      return text(value.text) ? { type: 'text', text: text(value.text) } : null;
    case 'tool_start':
      return { type: 'tool_start', id: text(value.id), name: text(value.name), arguments: text(value.arguments) };
    case 'tool_end':
      return {
        type: 'tool_end',
        id: text(value.id),
        name: text(value.name),
        ok: value.ok === true,
        ...(typeof value.error === 'string' ? { error: value.error } : {}),
      };
    case 'note':
      return text(value.text) ? { type: 'note', text: text(value.text) } : null;
    case 'context': {
      const context = toContext(value);
      return context ? { type: 'context', context } : null;
    }
    case 'compaction':
      if (value.phase === 'start') return { type: 'compaction', phase: 'start' };
      if (value.phase === 'failed') return { type: 'compaction', phase: 'failed' };
      if (value.phase === 'done' && text(value.summary)) {
        return { type: 'compaction', phase: 'done', summary: text(value.summary), tokensBefore: count(value.tokens_before) ?? 0 };
      }
      return null;
    case 'error':
      return { type: 'error', error: text(value.error) };
    case 'done':
      return {
        type: 'done',
        status: (text(value.status) || 'error') as AgentTurnStatus,
        rounds: typeof value.rounds === 'number' ? value.rounds : 0,
      };
    default:
      return null;
  }
}

/** 逐个事件读取 Agent 的 SSE 响应，直到流结束。中止时 `reader.read()` 抛出的错误原样上抛。 */
export async function readAgentStream(
  body: ReadableStream<Uint8Array>,
  onEvent: (event: AgentStreamEvent) => void,
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const emit = (part: string) => {
    const { eventType, eventData } = parseChatSsePart(part);
    if (!eventData) return;
    let data: unknown;
    try {
      data = JSON.parse(eventData);
    } catch {
      return;
    }
    const event = toEvent(eventType, data);
    if (event) onEvent(event);
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer = (buffer + decoder.decode(value, { stream: true })).replace(/\r\n/g, '\n');
    const parts = buffer.split('\n\n');
    buffer = parts.pop() ?? '';
    parts.forEach(emit);
  }
  buffer += decoder.decode();
  if (buffer.trim()) emit(buffer);
}
