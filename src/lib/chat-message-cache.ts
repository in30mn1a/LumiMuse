import type { Message } from '@/types';

export type CachedMessages = {
  messages: Message[];
  hasMore: boolean;
  oldestSeq: number | null;
  unextractedCount?: number;
  totalTokens?: number;
};

type CachedMessageMetadata = Partial<Omit<CachedMessages, 'messages'>>;
type MessageUpdater = (messages: Message[]) => Message[];

const MAX_CACHED_CONVERSATIONS = 55;
const messageCache = new Map<string, CachedMessages>();

function copyMessage(message: Message): Message {
  return {
    ...message,
    metadata: structuredClone(message.metadata ?? {}),
  };
}

function copyMessages(messages: Message[]): Message[] {
  return messages.map(copyMessage);
}

function copySnapshot(snapshot: CachedMessages): CachedMessages {
  return {
    ...snapshot,
    messages: copyMessages(snapshot.messages),
  };
}

export function readCachedMessages(conversationId: string): CachedMessages | null {
  const cached = messageCache.get(conversationId);
  if (cached) {
    messageCache.delete(conversationId);
    messageCache.set(conversationId, cached);
  }
  return cached ? copySnapshot(cached) : null;
}

function trimMessageCache(): void {
  while (messageCache.size > MAX_CACHED_CONVERSATIONS) {
    const oldestConversationId = messageCache.keys().next().value;
    if (!oldestConversationId) return;
    messageCache.delete(oldestConversationId);
  }
}

export function writeCachedMessages(conversationId: string, snapshot: CachedMessages): void {
  const previous = messageCache.get(conversationId);
  messageCache.delete(conversationId);
  messageCache.set(conversationId, {
    messages: copyMessages(snapshot.messages),
    hasMore: snapshot.hasMore,
    oldestSeq: snapshot.oldestSeq,
    unextractedCount: snapshot.unextractedCount ?? previous?.unextractedCount,
    totalTokens: snapshot.totalTokens ?? previous?.totalTokens,
  });
  trimMessageCache();
}

export function uniqueMessagesById(messages: Message[]): Message[] {
  const seen = new Set<string>();
  return messages.filter(message => {
    if (seen.has(message.id)) return false;
    seen.add(message.id);
    return true;
  });
}

export function cacheMessagesResponse(conversationId: string, response: CachedMessages): Message[] {
  const nextMessages = uniqueMessagesById(response.messages);
  writeCachedMessages(conversationId, {
    messages: nextMessages,
    hasMore: response.hasMore,
    oldestSeq: response.oldestSeq,
    unextractedCount: response.unextractedCount,
    totalTokens: response.totalTokens,
  });
  return nextMessages;
}

export function applyMessagesResponseToState(
  conversationId: string,
  response: CachedMessages,
  handlers: {
    getActiveConversationId: () => string | null;
    replaceMessages: (messages: Message[]) => void;
    setHasOlderMessages: (hasMore: boolean) => void;
    setOldestLoadedSeq: (oldestSeq: number | null) => void;
    setServerUnextractedCount?: (count: number) => void;
    setServerTotalTokens?: (total: { convId: string; value: number }) => void;
  },
): boolean {
  const nextMessages = cacheMessagesResponse(conversationId, response);
  if (handlers.getActiveConversationId() !== conversationId) return false;
  handlers.replaceMessages(nextMessages);
  handlers.setHasOlderMessages(response.hasMore);
  handlers.setOldestLoadedSeq(response.oldestSeq);
  if (response.unextractedCount !== undefined) {
    handlers.setServerUnextractedCount?.(response.unextractedCount);
  }
  if (response.totalTokens !== undefined) {
    handlers.setServerTotalTokens?.({ convId: conversationId, value: response.totalTokens });
  }
  return true;
}

export function updateCachedMessages(
  conversationId: string,
  updater: MessageUpdater,
  metadata?: CachedMessageMetadata,
): CachedMessages | null {
  const previous = messageCache.get(conversationId);
  if (!previous) return null;
  const nextSnapshot = {
    ...previous,
    ...metadata,
    messages: copyMessages(updater(copyMessages(previous.messages))),
  };
  messageCache.delete(conversationId);
  messageCache.set(conversationId, nextSnapshot);
  trimMessageCache();
  return copySnapshot(nextSnapshot);
}

export function updateMessagesForConversationState(
  conversationId: string,
  updater: MessageUpdater,
  handlers: {
    getActiveConversationId: () => string | null;
    updateMessages: (updater: MessageUpdater) => void;
  },
  metadata?: CachedMessageMetadata,
): CachedMessages | null {
  const cached = updateCachedMessages(conversationId, updater, metadata);
  if (handlers.getActiveConversationId() === conversationId) {
    handlers.updateMessages(updater);
  }
  return cached;
}

export function clearCachedMessages(conversationId?: string): void {
  if (conversationId) {
    messageCache.delete(conversationId);
    return;
  }
  messageCache.clear();
}
