import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type MutableRefObject } from 'react';
import type { Character, Conversation, Memory } from '@/types';
import { parseJsonArrayResponse } from '@/lib/http';
import {
  hasCharacterContext,
  readCharacterContext,
  readCharacterContextAsync,
  touchCharacterConversation,
  writeCharacterContext,
} from '@/lib/character-context-cache';

function getConversationLoadErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const CONVERSATION_PAGE_LIMIT = 100;

async function fetchCharacterConversations(characterId: string): Promise<Conversation[]> {
  const conversations: Conversation[] = [];
  let offset = 0;

  while (true) {
    const params = new URLSearchParams({
      character_id: characterId,
      limit: String(CONVERSATION_PAGE_LIMIT),
      offset: String(offset),
    });
    const response = await fetch(`/api/conversations?${params.toString()}`);
    const page = await parseJsonArrayResponse<Conversation>(response);
    conversations.push(...page);

    if (page.length === 0 || response.headers.get('X-Has-More') !== 'true') {
      return conversations;
    }

    offset += page.length;
  }
}

function resolveActiveConversationId(
  conversationList: Conversation[],
  preferredConversationId: string | null,
  fallbackConversationId: string | null = null,
): string | null {
  if (preferredConversationId && conversationList.some(item => item.id === preferredConversationId)) {
    return preferredConversationId;
  }
  // 显式意图（外部指定的会话）不在列表时，保留当前已选中的会话，避免网络迟到覆盖用户手动选择
  if (fallbackConversationId && conversationList.some(item => item.id === fallbackConversationId)) {
    return fallbackConversationId;
  }
  return conversationList[0]?.id || null;
}

type UseConversationLoaderOptions = {
  character: Character | null;
  conversationId: string | null;
  clearMessagesRef: MutableRefObject<() => void>;
  clearStreamingTextRef: MutableRefObject<() => void>;
};

export function useConversationLoader({
  character,
  conversationId,
  clearMessagesRef,
  clearStreamingTextRef,
}: UseConversationLoaderOptions) {
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [memories, setMemories] = useState<Memory[]>([]);
  const [activeConvId, setActiveConvId] = useState<string | null>(conversationId);
  const [loadingThread, setLoadingThread] = useState(false);
  const [conversationLoadError, setConversationLoadError] = useState<string | null>(null);
  /** 当前 React state 已对齐到的角色；用于区分「切入新角色」与「同角色仅 preferred 变化」 */
  const hydratedCharacterIdRef = useRef<string | null>(null);
  const characterRef = useRef<Character | null>(character);
  const loadCharacterStateSeqRef = useRef(0);
  const refreshConversationStateSeqRef = useRef(0);
  const activeConvIdRef = useRef<string | null>(activeConvId);

  const selectActiveConvId = useCallback((nextConvId: string | null) => {
    activeConvIdRef.current = nextConvId;
    setActiveConvId(nextConvId);
  }, []);

  useEffect(() => {
    activeConvIdRef.current = activeConvId;
  }, [activeConvId]);

  useLayoutEffect(() => {
    characterRef.current = character;
  }, [character]);

  const activeConversation = useMemo(
    () => conversations.find(conversation => conversation.id === activeConvId) || null,
    [activeConvId, conversations],
  );

  const applyCharacterSnapshot = useCallback((
    characterId: string,
    conversationList: Conversation[],
    memoryList: Memory[],
    preferredConversationId: string | null,
    options?: { persist?: boolean; fallbackActiveId?: string | null; trustPreferred?: boolean },
  ) => {
    setConversationLoadError(null);
    setConversations(conversationList);
    setMemories(memoryList);
    if (options?.persist !== false) {
      writeCharacterContext(characterId, {
        conversations: conversationList,
        memories: memoryList,
      });
    }

    // trustPreferred：本地快照可能落后于服务器（如另一端新建的会话尚未入缓存）。
    // 外部显式指定的会话即使不在快照列表里也保持选中，交给 revalidate 确认；
    // 网络权威列表不走此分支（preferred 不在权威列表 = 会话确实不存在）。
    const nextActive = options?.trustPreferred && preferredConversationId
      ? preferredConversationId
      : resolveActiveConversationId(
        conversationList,
        preferredConversationId,
        options?.fallbackActiveId ?? null,
      );
    selectActiveConvId(nextActive);
    hydratedCharacterIdRef.current = characterId;

    if (!nextActive) {
      clearMessagesRef.current();
      clearStreamingTextRef.current();
    }
    return nextActive;
  }, [clearMessagesRef, clearStreamingTextRef, selectActiveConvId]);

  /** 后台 revalidate：网络结果为准写回 state + 角色缓存。 */
  const revalidateCharacterState = useCallback(async (
    characterId: string,
    preferredConversationId: string | null,
  ) => {
    const requestSeq = ++loadCharacterStateSeqRef.current;
    const hadCache = hasCharacterContext(characterId);
    // 已有快照或 state 已 hydrate 时不亮整页 loading，避免秒开后被 loading 态盖住
    if (!hadCache && hydratedCharacterIdRef.current !== characterId) {
      setLoadingThread(true);
    }

    try {
      const [conversationList, memoryList] = await Promise.all([
        fetchCharacterConversations(characterId),
        fetch(`/api/memories?character_id=${encodeURIComponent(characterId)}`)
          .then(response => parseJsonArrayResponse<Memory>(response)),
      ]);

      if (loadCharacterStateSeqRef.current !== requestSeq || characterRef.current?.id !== characterId) return;
      // 网络期间用户可能已手动切换会话：显式 preferred 优先，其次保留当前选择
      applyCharacterSnapshot(characterId, conversationList, memoryList, preferredConversationId, {
        fallbackActiveId: activeConvIdRef.current,
      });
    } catch (error) {
      if (loadCharacterStateSeqRef.current === requestSeq && characterRef.current?.id === characterId) {
        setConversationLoadError(getConversationLoadErrorMessage(error));
      }
    } finally {
      if (loadCharacterStateSeqRef.current === requestSeq && characterRef.current?.id === characterId) {
        setLoadingThread(false);
      }
    }
  }, [applyCharacterSnapshot]);

  // 搜索跳转等：外部显式指定会话 id 时同步选中（仅非 null，避免切角色时 conversationId=null 冲掉秒开）
  useEffect(() => {
    if (!conversationId) return;
    queueMicrotask(() => selectActiveConvId(conversationId));
  }, [conversationId, selectActiveConvId]);

  useEffect(() => {
    if (!character) {
      loadCharacterStateSeqRef.current += 1;
      refreshConversationStateSeqRef.current += 1;
      hydratedCharacterIdRef.current = null;
      queueMicrotask(() => {
        setConversations([]);
        setMemories([]);
        clearMessagesRef.current();
        clearStreamingTextRef.current();
        selectActiveConvId(null);
        setLoadingThread(false);
        setConversationLoadError(null);
      });
      return;
    }

    const preferred = conversationId;
    const previousHydratedId = hydratedCharacterIdRef.current;
    const isNewCharacterHydration = previousHydratedId !== character.id;
    const characterId = character.id;

    // 不用 effect 内同步 setState（react-hooks/set-state-in-effect）。
    // queueMicrotask 仍早于 setTimeout(0) 的网络 revalidate，保证「先快照后网络」。
    if (isNewCharacterHydration) {
      const cached = readCharacterContext(characterId);
      queueMicrotask(() => {
        if (characterRef.current?.id !== characterId) return;
        if (cached) {
          applyCharacterSnapshot(
            characterId,
            cached.conversations,
            cached.memories,
            preferred,
            { persist: false, trustPreferred: true },
          );
          clearStreamingTextRef.current();
          setLoadingThread(false);
          return;
        }

        // 仅在「从另一个角色切过来且无缓存」时清空，避免串台。
        // 首次挂载（previousHydratedId == null）不清空，以免抹掉仍可用的本地 state。
        if (previousHydratedId != null) {
          hydratedCharacterIdRef.current = null;
          setConversations([]);
          setMemories([]);
          // 显式指定了目标会话（跨角色搜索跳转）时保持选中，消息层立即并行加载
          selectActiveConvId(preferred);
          if (!preferred) clearMessagesRef.current();
          clearStreamingTextRef.current();
        } else {
          clearStreamingTextRef.current();
        }
        setLoadingThread(true);

        // IndexedDB 兜底：重开浏览器后内存 LRU 为空，用上次持久化的角色上下文先渲染。
        // 网络（或更快的另一次 hydrate）已应用时丢弃，网络照常 revalidate。
        void readCharacterContextAsync(characterId).then(persisted => {
          if (!persisted) return;
          if (characterRef.current?.id !== characterId) return;
          if (hydratedCharacterIdRef.current === characterId) return;
          applyCharacterSnapshot(characterId, persisted.conversations, persisted.memories, preferred, {
            persist: false,
            trustPreferred: true,
            fallbackActiveId: activeConvIdRef.current,
          });
          clearStreamingTextRef.current();
          setLoadingThread(false);
        });
      });
    }

    const timer = setTimeout(() => {
      void revalidateCharacterState(characterId, preferred);
    }, 0);

    return () => clearTimeout(timer);
  }, [
    applyCharacterSnapshot,
    character,
    clearMessagesRef,
    clearStreamingTextRef,
    conversationId,
    revalidateCharacterState,
    selectActiveConvId,
  ]);

  const refreshConversationState = useCallback(async (nextActiveId?: string | null) => {
    const currentCharacter = characterRef.current;
    if (!currentCharacter) return;
    const requestSeq = ++refreshConversationStateSeqRef.current;
    const requestedCharacterId = currentCharacter.id;
    try {
      const [conversationList, memoryList] = await Promise.all([
        fetchCharacterConversations(requestedCharacterId),
        fetch(`/api/memories?character_id=${encodeURIComponent(requestedCharacterId)}`)
          .then(response => parseJsonArrayResponse<Memory>(response)),
      ]);
      if (refreshConversationStateSeqRef.current !== requestSeq || characterRef.current?.id !== requestedCharacterId) return;
      setConversationLoadError(null);
      setConversations(conversationList);
      setMemories(memoryList);
      writeCharacterContext(requestedCharacterId, {
        conversations: conversationList,
        memories: memoryList,
      });
      hydratedCharacterIdRef.current = requestedCharacterId;

      if (nextActiveId !== undefined) {
        selectActiveConvId(nextActiveId && conversationList.some((item: Conversation) => item.id === nextActiveId)
          ? nextActiveId
          : conversationList[0]?.id || null);
      }
    } catch (error) {
      if (refreshConversationStateSeqRef.current === requestSeq && characterRef.current?.id === requestedCharacterId) {
        setConversationLoadError(getConversationLoadErrorMessage(error));
      }
    }
  }, [selectActiveConvId]);

  /**
   * 聊天/重生成成功后的轻量更新：只 bump 当前对话的 updated_at 并置顶，
   * 不重拉全部对话列表与 memories（记忆刷新走 pollMemoryTask 完成路径）。
   * 缓存写走 touchCharacterConversation（缓存内部按会话 id 定向修改，天然免疫跨角色错写），
   * 且放在 setState updater 外，保持 updater 纯函数。
   */
  const touchConversation = useCallback((conversationIdToTouch: string, updatedAt?: string) => {
    const nextUpdatedAt = updatedAt ?? new Date().toISOString();
    const characterId = characterRef.current?.id;
    if (characterId) {
      touchCharacterConversation(characterId, conversationIdToTouch, nextUpdatedAt);
    }
    setConversations(prev => {
      const index = prev.findIndex(conversation => conversation.id === conversationIdToTouch);
      if (index === -1) return prev;
      const next = { ...prev[index], updated_at: nextUpdatedAt };
      if (index === 0 && prev[0].updated_at === nextUpdatedAt) return prev;
      if (index === 0) {
        const copy = prev.slice();
        copy[0] = next;
        return copy;
      }
      const rest = prev.slice(0, index).concat(prev.slice(index + 1));
      return [next, ...rest];
    });
  }, []);

  return {
    conversations,
    setConversations,
    memories,
    setMemories,
    activeConvId,
    activeConvIdRef,
    selectActiveConvId,
    activeConversation,
    loadingThread,
    conversationLoadError,
    setLoadingThread,
    characterRef,
    refreshConversationState,
    touchConversation,
  };
}

export type UseConversationLoaderResult = ReturnType<typeof useConversationLoader>;
