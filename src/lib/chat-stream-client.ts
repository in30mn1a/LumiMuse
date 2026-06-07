import type { Message } from '@/types';
import { parseJsonResponse } from './http';

export type MessagesResponse = {
  messages: Message[];
  hasMore: boolean;
  oldestSeq: number | null;
  unextractedCount?: number;
  /** 整对话（自最后一条 summary 起，无 summary 则全量）的 token_count 总和，用于分页未加载完时正确显示 */
  totalTokens?: number;
};

export type ChatSseHandlers = {
  onChunk: (text: string) => void;
  onMemoryExtracting: () => void;
  getErrorMessage: () => string;
};

export function buildClientTimePayload() {
  return {
    client_now_iso: new Date().toISOString(),
    client_timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    client_utc_offset_minutes: new Date().getTimezoneOffset(),
  };
}

export function messagesUrl(conversationId: string, options?: { limit?: number; beforeSeq?: number | null; all?: boolean }): string {
  const params = new URLSearchParams({ conversation_id: conversationId });
  if (options?.all) params.set('all', '1');
  if (options?.limit) params.set('limit', String(options.limit));
  if (options?.beforeSeq !== undefined && options.beforeSeq !== null) params.set('before_seq', String(options.beforeSeq));
  return `/api/messages?${params}`;
}

export async function fetchMessagesPage(
  conversationId: string,
  options?: { limit?: number; beforeSeq?: number | null; all?: boolean; signal?: AbortSignal },
): Promise<MessagesResponse> {
  const response = await fetch(messagesUrl(conversationId, options), { signal: options?.signal });
  const data = await parseJsonResponse<MessagesResponse | Message[]>(response);
  if (Array.isArray(data)) {
    const oldestSeq = typeof data[0]?.seq === 'number' ? data[0].seq : null;
    return { messages: data, hasMore: false, oldestSeq };
  }
  return data as MessagesResponse;
}

export function parseChatSsePart(part: string): { eventType: string; eventData: string } {
  let eventType = '';
  const eventDataLines: string[] = [];

  for (const line of part.replace(/\r\n/g, '\n').split('\n')) {
    if (line.startsWith('event: ')) eventType = line.slice(7).trim();
    if (line.startsWith('data: ')) eventDataLines.push(line.slice(6));
  }

  return { eventType, eventData: eventDataLines.join('\n') };
}

export function handleChatSseEvent(eventType: string, eventData: string, handlers: ChatSseHandlers): void {
  if (!eventData) return;

  let parsed: { text?: unknown; status?: unknown; message?: unknown };
  try {
    parsed = JSON.parse(eventData) as typeof parsed;
  } catch (parseErr) {
    if (parseErr instanceof Error && parseErr.message !== 'Unexpected end of JSON input') {
      throw parseErr;
    }
    return;
  }

  if ((eventType === 'chunk' || eventType === '') && typeof parsed.text === 'string' && parsed.text) {
    handlers.onChunk(parsed.text);
  } else if (eventType === 'memory' && parsed.status === 'extracting') {
    handlers.onMemoryExtracting();
  } else if (eventType === 'error') {
    throw new Error(typeof parsed.message === 'string' ? parsed.message : handlers.getErrorMessage());
  }
}

export async function readChatSseStream(body: ReadableStream<Uint8Array>, handlers: ChatSseHandlers): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    buffer = buffer.replace(/\r\n/g, '\n');
    const parts = buffer.split('\n\n');
    buffer = parts.pop() || '';

    for (const part of parts) {
      const { eventType, eventData } = parseChatSsePart(part);
      handleChatSseEvent(eventType, eventData, handlers);
    }
  }

  buffer += decoder.decode();
  buffer = buffer.replace(/\r\n/g, '\n');
  if (buffer.trim()) {
    const { eventType, eventData } = parseChatSsePart(buffer);
    handleChatSseEvent(eventType, eventData, handlers);
  }
}
