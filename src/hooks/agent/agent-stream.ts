import type { AgentTurnStatus } from '@/lib/agent/loop';
import { parseChatSsePart } from '@/lib/chat-stream-client';

/** `/api/agent/chat` 推送的事件（usage 界面不用，直接忽略）。 */
export type AgentStreamEvent =
  | { type: 'text'; text: string }
  | { type: 'tool_start'; id: string; name: string; arguments: string }
  | { type: 'tool_end'; id: string; name: string; ok: boolean; error?: string }
  | { type: 'note'; text: string }
  | { type: 'error'; error: string }
  | { type: 'done'; status: AgentTurnStatus; rounds: number };

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
