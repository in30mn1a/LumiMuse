import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type MutableRefObject } from 'react';
import type { Character, Conversation, Memory } from '@/types';
import { parseJsonArrayResponse } from '@/lib/http';

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
  const previousCharacterIdRef = useRef<string | null>(character?.id ?? null);
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

  const loadCharacterState = useCallback(async (characterId: string, preferredConversationId: string | null) => {
    const requestSeq = ++loadCharacterStateSeqRef.current;
    setLoadingThread(true);
    try {
      const [conversationList, memoryList] = await Promise.all([
        fetchCharacterConversations(characterId),
        fetch(`/api/memories?character_id=${encodeURIComponent(characterId)}`)
          .then(response => parseJsonArrayResponse<Memory>(response)),
      ]);

      if (loadCharacterStateSeqRef.current !== requestSeq || characterRef.current?.id !== characterId) return;
      setConversationLoadError(null);
      setConversations(conversationList);
      setMemories(memoryList);

      const nextActive = preferredConversationId && conversationList.some((item: Conversation) => item.id === preferredConversationId)
        ? preferredConversationId
        : conversationList[0]?.id || null;
      selectActiveConvId(nextActive);

      if (!nextActive) {
        clearMessagesRef.current();
        clearStreamingTextRef.current();
      }
    } catch (error) {
      if (loadCharacterStateSeqRef.current === requestSeq && characterRef.current?.id === characterId) {
        setConversationLoadError(getConversationLoadErrorMessage(error));
      }
    } finally {
      if (loadCharacterStateSeqRef.current === requestSeq && characterRef.current?.id === characterId) {
        setLoadingThread(false);
      }
    }
  }, [clearMessagesRef, clearStreamingTextRef, selectActiveConvId]);

  useEffect(() => {
    queueMicrotask(() => selectActiveConvId(conversationId));
  }, [conversationId, selectActiveConvId]);

  useEffect(() => {
    if (!character) {
      loadCharacterStateSeqRef.current += 1;
      refreshConversationStateSeqRef.current += 1;
      queueMicrotask(() => {
        setConversations([]);
        setMemories([]);
        clearMessagesRef.current();
        clearStreamingTextRef.current();
        selectActiveConvId(null);
        setLoadingThread(false);
        setConversationLoadError(null);
      });
      previousCharacterIdRef.current = null;
      return;
    }

    const isCharacterChanged = previousCharacterIdRef.current !== character.id;
    previousCharacterIdRef.current = character.id;

    if (isCharacterChanged) {
      queueMicrotask(() => {
        clearMessagesRef.current();
        clearStreamingTextRef.current();
      });
    }

    const timer = setTimeout(() => {
      void loadCharacterState(character.id, conversationId);
    }, 0);

    return () => clearTimeout(timer);
  }, [character, clearMessagesRef, clearStreamingTextRef, conversationId, loadCharacterState, selectActiveConvId]);

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
   */
  const touchConversation = useCallback((conversationId: string, updatedAt?: string) => {
    const nextUpdatedAt = updatedAt ?? new Date().toISOString();
    setConversations(prev => {
      const index = prev.findIndex(conversation => conversation.id === conversationId);
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
