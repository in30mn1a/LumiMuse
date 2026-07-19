// 角色级会话列表 + 记忆列表的浏览器本地缓存（内存 LRU + IndexedDB write-through）。
// 供切角色时 stale-while-revalidate：先秒开上次快照，再后台拉网络对齐。
// 持久化失败静默降级为纯内存（复用 chat-cache-store 的失败即关闭语义）。
// 不碰 LLM 注入语义；容量上限仅约束客户端存储，不是聊天链路 cap。

import type { Conversation, Memory } from '@/types';
import {
  createChatCachePersistence,
  createIndexedDbBackend,
  type ChatCachePersistence,
} from '@/lib/chat-cache-store';

export type CharacterContextSnapshot = {
  conversations: Conversation[];
  memories: Memory[];
  savedAt: number;
};

/** 角色上下文 LRU 上限（客户端存储策略，与注入条数无关） */
export const MAX_CACHED_CHARACTER_CONTEXTS = 20;

const contextCache = new Map<string, CharacterContextSnapshot>();

/** 持久层记录校验：角色上下文快照必须带 conversations / memories 两个数组。 */
export function isValidCharacterContextSnapshot(snapshot: object): boolean {
  const candidate = snapshot as { conversations?: unknown; memories?: unknown };
  return Array.isArray(candidate.conversations) && Array.isArray(candidate.memories);
}

// 与聊天消息缓存分库（lumimuse-character-context），避免动现有 DB 的版本迁移。
let persistence: ChatCachePersistence<CharacterContextSnapshot> = createChatCachePersistence(
  createIndexedDbBackend<CharacterContextSnapshot>({
    dbName: 'lumimuse-character-context',
    storeName: 'contexts',
  }),
  { validateSnapshot: isValidCharacterContextSnapshot },
);
let hydrationPromise: Promise<void> | null = null;

/** 仅供测试注入 fake 持久层；会重置 hydration 状态。 */
export function __setCharacterContextPersistenceForTests(
  next: ChatCachePersistence<CharacterContextSnapshot>,
): void {
  persistence = next;
  hydrationPromise = null;
}

function schedulePersist(characterId: string): void {
  persistence.schedulePut(characterId, () => contextCache.get(characterId) ?? null);
}

/** 首次调用时把持久层快照填充到内存 Map 中**尚不存在**的 key（不覆盖本次运行已写入的新数据）。 */
function ensureHydrated(): Promise<void> {
  hydrationPromise ??= persistence.hydrate().then(entries => {
    if (entries.length === 0) return;
    // 运行期已写入的条目比持久层快照新。填充后把它们移回 Map 尾部，
    // 维持「最旧在头、最新在尾」的 LRU 不变量——否则 trim 会先淘汰活跃角色并误删其持久记录
    const existing = [...contextCache.entries()];
    for (const { id, snapshot } of entries) {
      if (!contextCache.has(id)) {
        contextCache.set(id, snapshot);
      }
    }
    for (const [id, snapshot] of existing) {
      contextCache.delete(id);
      contextCache.set(id, snapshot);
    }
    trimContextCache();
  });
  return hydrationPromise;
}

function copyConversation(conversation: Conversation): Conversation {
  return { ...conversation };
}

function copyConversations(conversations: Conversation[]): Conversation[] {
  return conversations.map(copyConversation);
}

function copyMemory(memory: Memory): Memory {
  return {
    ...memory,
    tags: Array.isArray(memory.tags) ? [...memory.tags] : memory.tags,
    metadata: memory.metadata != null ? structuredClone(memory.metadata) : memory.metadata,
  };
}

function copyMemories(memories: Memory[]): Memory[] {
  return memories.map(copyMemory);
}

function copySnapshot(snapshot: CharacterContextSnapshot): CharacterContextSnapshot {
  return {
    conversations: copyConversations(snapshot.conversations),
    memories: copyMemories(snapshot.memories),
    savedAt: snapshot.savedAt,
  };
}

function trimContextCache(): void {
  while (contextCache.size > MAX_CACHED_CHARACTER_CONTEXTS) {
    const oldest = contextCache.keys().next().value;
    if (!oldest) return;
    contextCache.delete(oldest);
    persistence.remove(oldest);
  }
}

function touch(characterId: string, snapshot: CharacterContextSnapshot): void {
  contextCache.delete(characterId);
  contextCache.set(characterId, snapshot);
  trimContextCache();
  schedulePersist(characterId);
}

export function readCharacterContext(characterId: string): CharacterContextSnapshot | null {
  const cached = contextCache.get(characterId);
  if (!cached) return null;
  // LRU：读命中移到尾部
  contextCache.delete(characterId);
  contextCache.set(characterId, cached);
  return copySnapshot(cached);
}

/** 只判存在性，不做防御拷贝（revalidate 等只需判断是否命中的路径用） */
export function hasCharacterContext(characterId: string): boolean {
  return contextCache.has(characterId);
}

/**
 * 异步读取：内存未命中时等待持久层 hydrate 后再读。
 * 用于重开浏览器后的首次切入角色（内存 Map 为空，但 IndexedDB 里可能有上次的快照）。
 */
export async function readCharacterContextAsync(
  characterId: string,
): Promise<CharacterContextSnapshot | null> {
  await ensureHydrated();
  return readCharacterContext(characterId);
}

export function writeCharacterContext(
  characterId: string,
  snapshot: Omit<CharacterContextSnapshot, 'savedAt'> & { savedAt?: number },
): void {
  touch(characterId, {
    conversations: copyConversations(snapshot.conversations),
    memories: copyMemories(snapshot.memories),
    savedAt: snapshot.savedAt ?? Date.now(),
  });
}

// ---- 定向增量写入 ----
// 以下 helper 只读缓存自身持有的列表做增删改，从不接收调用方的完整列表。
// 这是跨角色污染的关键防线：调用方闭包里的 characterId 与 React state 列表可能分属
// 两个角色（如删除请求在飞时用户已切走），而缓存自身的条目永远与 key 同源。
// 条目不存在（未加载过/已被 LRU 淘汰）时一律 no-op，完整快照由 revalidate 权威写入。

/** 新会话置顶插入；conversation 与 characterId 不同源时拒绝写入。 */
export function prependCharacterConversation(characterId: string, conversation: Conversation): void {
  if (conversation.character_id !== characterId) return;
  const previous = contextCache.get(characterId);
  if (!previous) return;
  touch(characterId, {
    conversations: [
      copyConversation(conversation),
      ...copyConversations(previous.conversations.filter(item => item.id !== conversation.id)),
    ],
    memories: copyMemories(previous.memories),
    savedAt: Date.now(),
  });
}

/** 就地修补单个会话字段（重命名 / ignore_memory 等），不改变排序；会话不在缓存中则 no-op。 */
export function patchCharacterConversation(
  characterId: string,
  conversationId: string,
  patch: Partial<Pick<Conversation, 'title' | 'ignore_memory' | 'updated_at'>>,
): void {
  const previous = contextCache.get(characterId);
  if (!previous || !previous.conversations.some(item => item.id === conversationId)) return;
  touch(characterId, {
    conversations: previous.conversations.map(item => (
      item.id === conversationId ? { ...copyConversation(item), ...patch } : copyConversation(item)
    )),
    memories: copyMemories(previous.memories),
    savedAt: Date.now(),
  });
}

/** 会话删除；会话不在缓存中则 no-op（包括「切走后才收到删除响应」的场景，此时改的正是原角色的缓存）。 */
export function removeCharacterConversation(characterId: string, conversationId: string): void {
  const previous = contextCache.get(characterId);
  if (!previous || !previous.conversations.some(item => item.id === conversationId)) return;
  touch(characterId, {
    conversations: copyConversations(previous.conversations.filter(item => item.id !== conversationId)),
    memories: copyMemories(previous.memories),
    savedAt: Date.now(),
  });
}

/** 聊天完成后 bump updated_at 并置顶；会话不在缓存中则 no-op（后台流对应他角色会话时自然跳过）。 */
export function touchCharacterConversation(
  characterId: string,
  conversationId: string,
  updatedAt: string,
): void {
  const previous = contextCache.get(characterId);
  const target = previous?.conversations.find(item => item.id === conversationId);
  if (!previous || !target) return;
  touch(characterId, {
    conversations: [
      { ...copyConversation(target), updated_at: updatedAt },
      ...copyConversations(previous.conversations.filter(item => item.id !== conversationId)),
    ],
    memories: copyMemories(previous.memories),
    savedAt: Date.now(),
  });
}

/** 记忆列表整体替换（提取完成后的权威刷新）。列表与 characterId 不同源时拒绝；条目不存在则 no-op。 */
export function updateCharacterMemories(characterId: string, memories: Memory[]): void {
  if (memories.some(memory => memory.character_id !== characterId)) return;
  const previous = contextCache.get(characterId);
  if (!previous) return;
  touch(characterId, {
    conversations: copyConversations(previous.conversations),
    memories: copyMemories(memories),
    savedAt: Date.now(),
  });
}

export function clearCharacterContext(characterId?: string): void {
  if (characterId) {
    contextCache.delete(characterId);
    persistence.remove(characterId);
    return;
  }
  contextCache.clear();
  persistence.removeAll();
}

/** 仅供测试：当前缓存角色数（不暴露内部 Map） */
export function __getCharacterContextCacheSizeForTests(): number {
  return contextCache.size;
}
