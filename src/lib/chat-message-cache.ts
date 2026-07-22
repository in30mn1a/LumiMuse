import type { Message } from '@/types';
import {
  createChatCachePersistence,
  createIndexedDbBackend,
  type ChatCachePersistence,
} from '@/lib/chat-cache-store';

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

// 浏览器本地持久层（IndexedDB）：write-through 副作用，SSR/不支持/出错时静默退化为 no-op。
let persistence: ChatCachePersistence<CachedMessages> =
  createChatCachePersistence(createIndexedDbBackend<CachedMessages>());
let hydrationPromise: Promise<void> | null = null;

/** 仅供测试注入 fake 持久层；会重置 hydration 状态。 */
export function __setChatCachePersistenceForTests(next: ChatCachePersistence<CachedMessages>): void {
  persistence = next;
  hydrationPromise = null;
}

/** 乐观占位消息（发送中的 temp-user 等），仅存在于内存 UI，不落持久层、不被网络空响覆盖 */
export function isOptimisticMessage(message: Message): boolean {
  return message.id === 'temp-user' || message.id.startsWith('temp-');
}

function stripOptimisticMessages(messages: Message[]): Message[] {
  return messages.filter(message => !isOptimisticMessage(message));
}

/**
 * 网络/权威快照合并本地乐观消息：
 * - 新建会话首条发送时，activeConvId 切换会立刻拉空列表，不能抹掉已展示的 temp-user
 * - 服务端已出现同内容的真实 user 消息后，丢弃对应乐观占位，避免双气泡
 */
export function mergeMessagesWithOptimistic(
  serverMessages: Message[],
  previousMessages: Message[] | undefined,
): Message[] {
  const optimistic = (previousMessages ?? []).filter(isOptimisticMessage);
  if (optimistic.length === 0) {
    return uniqueMessagesById(serverMessages);
  }

  const keepOptimistic = optimistic.filter(opt => {
    if (serverMessages.some(message => message.id === opt.id)) return false;
    if (opt.role === 'user') {
      const replaced = serverMessages.some(message => (
        message.role === 'user'
        && !isOptimisticMessage(message)
        && message.content === opt.content
      ));
      if (replaced) return false;
    }
    return true;
  });

  return uniqueMessagesById([...serverMessages, ...keepOptimistic]);
}

function schedulePersist(conversationId: string): void {
  // 持久化时剥掉乐观占位，避免刷新后残留幽灵 temp-user
  persistence.schedulePut(conversationId, () => {
    const snapshot = messageCache.get(conversationId);
    if (!snapshot) return null;
    const durableMessages = stripOptimisticMessages(snapshot.messages);
    if (durableMessages.length === snapshot.messages.length) {
      return snapshot;
    }
    return {
      ...snapshot,
      messages: durableMessages,
    };
  });
}

/** 首次调用时把持久层快照填充到内存 Map 中**尚不存在**的 key（不覆盖本次运行已写入的新数据）。 */
function ensureHydrated(): Promise<void> {
  hydrationPromise ??= persistence.hydrate().then(entries => {
    if (entries.length === 0) return;
    // 运行期已写入的条目比持久层快照新。填充后把它们移回 Map 尾部，
    // 维持「最旧在头、最新在尾」的 LRU 不变量——否则 trim 会先淘汰活跃会话并误删其持久记录
    const existing = [...messageCache.entries()];
    for (const { id, snapshot } of entries) {
      if (!messageCache.has(id)) {
        messageCache.set(id, snapshot);
      }
    }
    for (const [id, snapshot] of existing) {
      messageCache.delete(id);
      messageCache.set(id, snapshot);
    }
    trimMessageCache();
  });
  return hydrationPromise;
}

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

/**
 * 异步读取：内存未命中时等待持久层 hydrate 后再读。
 * 用于重开浏览器后的首次进入会话（内存 Map 为空，但 IndexedDB 里可能有上次的快照）。
 */
export async function readCachedMessagesAsync(conversationId: string): Promise<CachedMessages | null> {
  await ensureHydrated();
  return readCachedMessages(conversationId);
}

function trimMessageCache(): void {
  while (messageCache.size > MAX_CACHED_CONVERSATIONS) {
    const oldestConversationId = messageCache.keys().next().value;
    if (!oldestConversationId) return;
    messageCache.delete(oldestConversationId);
    persistence.remove(oldestConversationId);
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
  schedulePersist(conversationId);
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
  const previous = messageCache.get(conversationId);
  const nextMessages = mergeMessagesWithOptimistic(response.messages, previous?.messages);
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
  // 新建会话尚无缓存时也要写入乐观消息，否则随后空列表拉取无法从 previous 合并回来
  const previous = messageCache.get(conversationId) ?? {
    messages: [],
    hasMore: false,
    oldestSeq: null,
  };
  const nextSnapshot = {
    ...previous,
    ...metadata,
    messages: copyMessages(updater(copyMessages(previous.messages))),
  };
  messageCache.delete(conversationId);
  messageCache.set(conversationId, nextSnapshot);
  trimMessageCache();
  schedulePersist(conversationId);
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
    persistence.remove(conversationId);
    return;
  }
  messageCache.clear();
  persistence.removeAll();
}
