import type { Message, MessageMetadata } from '@/types';

/**
 * 把 messages 表 metadata 列（可能是字符串、对象、null、非对象 JSON）
 * 规范化为 MessageMetadata。所有未识别的形状统一回退到空对象，
 * 避免下游访问 meta.xxx 时遇到 undefined 抛错。
 */
export function parseMessageMetadata(value: unknown): MessageMetadata {
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value) as unknown;
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? parsed as MessageMetadata
        : {};
    } catch {
      return {};
    }
  }

  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as MessageMetadata
    : {};
}

export function serializeMessage<T extends Record<string, unknown>>(row: T): T & { metadata: MessageMetadata } {
  return {
    ...row,
    metadata: parseMessageMetadata(row.metadata),
  };
}

export function serializeMessages<T extends Record<string, unknown>>(messages: T[]): Array<T & { metadata: MessageMetadata }> {
  return messages.map(message => serializeMessage(message));
}

export function serializeTypedMessages(messages: Message[]): Message[] {
  return serializeMessages(messages) as Message[];
}
