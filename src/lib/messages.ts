import type { Message } from '@/types';

export function parseMessageMetadata(value: unknown): Record<string, unknown> {
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value) as unknown;
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
    } catch {
      return {};
    }
  }

  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export function serializeMessage<T extends Record<string, unknown>>(row: T): T & { metadata: Record<string, unknown> } {
  return {
    ...row,
    metadata: parseMessageMetadata(row.metadata),
  };
}

export function serializeMessages<T extends Record<string, unknown>>(messages: T[]): Array<T & { metadata: Record<string, unknown> }> {
  return messages.map(message => serializeMessage(message));
}

export function serializeTypedMessages(messages: Message[]): Message[] {
  return serializeMessages(messages) as Message[];
}
