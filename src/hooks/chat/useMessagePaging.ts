import { useCallback, useEffect, useMemo, useRef, useState, type MutableRefObject } from 'react';
import type { Message } from '@/types';
import { fetchMessagesPage, type MessagesResponse } from '@/lib/chat-stream-client';
import {
  applyMessagesResponseToState,
  readCachedMessages,
  uniqueMessagesById,
  updateCachedMessages,
  updateMessagesForConversationState,
} from '@/lib/chat-message-cache';

type UseMessagePagingOptions = {
  activeConvId: string | null;
  activeConvIdRef: MutableRefObject<string | null>;
  targetMessageId?: string | null;
  pageSize: number;
  onTargetMessageLoaded: (id: string) => void;
  onInitialMessagesLoaded: () => void;
  onError?: (message: string) => void;
};

const isAbortError = (error: unknown) => error instanceof DOMException && error.name === 'AbortError';

export function useMessagePaging({
  activeConvId,
  activeConvIdRef,
  targetMessageId,
  pageSize,
  onTargetMessageLoaded,
  onInitialMessagesLoaded,
  onError,
}: UseMessagePagingOptions) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [hasOlderMessages, setHasOlderMessages] = useState(false);
  const [oldestLoadedSeq, setOldestLoadedSeq] = useState<number | null>(null);
  const [loadingOlderMessages, setLoadingOlderMessages] = useState(false);
  const [messagePagingError, setMessagePagingError] = useState<string | null>(null);
  // 服务端返回的真实未提取消息数量（不受前端分页限制）
  const [serverUnextractedCountState, setServerUnextractedCountState] = useState<{ convId: string; value: number } | null>(null);
  const serverUnextractedCountRef = useRef(serverUnextractedCountState);
  // 服务端返回的整对话 token 总和（自最后一条 summary 起，无 summary 则全量），用于分页未加载完时正确显示。
  // 带 convId 是为了切换对话时能识别"旧值过期"，避免新对话短暂显示旧对话的 token 数。
  const [serverTotalTokens, setServerTotalTokens] = useState<{ convId: string; value: number } | null>(null);
  const messagesRef = useRef<Message[]>(messages);
  const onTargetMessageLoadedRef = useRef(onTargetMessageLoaded);
  const onInitialMessagesLoadedRef = useRef(onInitialMessagesLoaded);
  const onErrorRef = useRef(onError);

  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

  useEffect(() => {
    onTargetMessageLoadedRef.current = onTargetMessageLoaded;
    onInitialMessagesLoadedRef.current = onInitialMessagesLoaded;
    onErrorRef.current = onError;
  }, [onError, onInitialMessagesLoaded, onTargetMessageLoaded]);

  useEffect(() => {
    serverUnextractedCountRef.current = serverUnextractedCountState;
  }, [serverUnextractedCountState]);

  const serverUnextractedCount = activeConvId && serverUnextractedCountState?.convId === activeConvId
    ? serverUnextractedCountState.value
    : 0;

  const visibleMessages = useMemo(
    () => activeConvId ? messages.filter(message => message.conversation_id === activeConvId) : [],
    [activeConvId, messages],
  );

  const setServerUnextractedCountValue = useCallback((convId: string, count: number) => {
    const next = { convId, value: count };
    serverUnextractedCountRef.current = next;
    setServerUnextractedCountState(next);
  }, []);

  const updateServerCounts = useCallback((convId: string, unextractedCount?: number, totalTokens?: number) => {
    if (unextractedCount !== undefined) {
      setServerUnextractedCountValue(convId, unextractedCount);
    }
    if (totalTokens !== undefined) {
      setServerTotalTokens({ convId, value: totalTokens });
    }
  }, [setServerUnextractedCountValue]);

  const updateMessagesForConversation = useCallback((
    conversationIdToUpdate: string,
    updater: (messages: Message[]) => Message[],
    metadata?: Partial<Omit<MessagesResponse, 'messages'>>,
  ) => {
    updateMessagesForConversationState(conversationIdToUpdate, updater, {
      getActiveConversationId: () => activeConvIdRef.current,
      updateMessages: nextUpdater => setMessages(prev => nextUpdater(prev)),
    }, metadata);
  }, [activeConvIdRef]);

  const applyMessagesResponse = useCallback((conversationIdToApply: string, response: MessagesResponse): boolean => {
    return applyMessagesResponseToState(conversationIdToApply, response, {
      getActiveConversationId: () => activeConvIdRef.current,
      replaceMessages: setMessages,
      setHasOlderMessages,
      setOldestLoadedSeq,
      setServerUnextractedCount: count => setServerUnextractedCountValue(conversationIdToApply, count),
      setServerTotalTokens,
    });
  }, [activeConvIdRef, setServerUnextractedCountValue]);

  const clearMessages = useCallback(() => {
    setMessages([]);
  }, []);

  const replaceMessages = useCallback((nextMessages: Message[]) => {
    setMessages(nextMessages);
  }, []);

  const reportMessagePagingError = useCallback((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    setMessagePagingError(message);
    onErrorRef.current?.(message);
  }, []);

  useEffect(() => {
    if (!activeConvId) return;
    const ctl = new AbortController();
    const needsTarget = Boolean(targetMessageId);
    const loadingConvId = activeConvId;
    if (!needsTarget) {
      const cached = readCachedMessages(loadingConvId);
      if (cached) {
        onInitialMessagesLoadedRef.current();
        queueMicrotask(() => {
          applyMessagesResponse(loadingConvId, cached);
        });
      }
    }
    fetchMessagesPage(loadingConvId, { limit: pageSize, all: needsTarget, signal: ctl.signal })
      .then(response => {
        setMessagePagingError(null);
        if (!applyMessagesResponse(loadingConvId, response)) return;

        if (targetMessageId) {
          const idx = response.messages.findIndex(m => m.id === targetMessageId);
          if (idx !== -1) {
            onTargetMessageLoadedRef.current(targetMessageId);
          }
        } else {
          onInitialMessagesLoadedRef.current();
        }
      })
      .catch(error => {
        if (isAbortError(error)) return;
        reportMessagePagingError(error);
    });
    return () => ctl.abort();
  }, [activeConvId, applyMessagesResponse, pageSize, reportMessagePagingError, targetMessageId]);

  // 页面重新可见时刷新未提取数量（处理后台提取完成但前端不知道的情况）
  useEffect(() => {
    const handleVisibility = () => {
      if (document.visibilityState === 'visible' && activeConvId) {
        const cid = activeConvId;
        fetchMessagesPage(cid, { limit: Math.max(pageSize, messages.length) })
          .then(({ unextractedCount: uc, totalTokens: tt }) => {
            if (activeConvIdRef.current !== cid) return;
            setMessagePagingError(null);
            updateServerCounts(cid, uc, tt);
          })
          .catch(error => {
            if (isAbortError(error)) return;
            reportMessagePagingError(error);
          });
      }
    };
    document.addEventListener('visibilitychange', handleVisibility);
    return () => document.removeEventListener('visibilitychange', handleVisibility);
  }, [activeConvId, activeConvIdRef, messages.length, pageSize, reportMessagePagingError, updateServerCounts]);

  const refreshMessages = useCallback(async () => {
    const convId = activeConvIdRef.current;
    if (!convId) return;
    // 用 ref 读取最新 messages 长度，避免 callback 引用因 messages 变化而频繁重建
    const response = await fetchMessagesPage(convId, { limit: Math.max(pageSize, messagesRef.current.length) });
    setMessagePagingError(null);
    applyMessagesResponse(convId, response);
  }, [activeConvIdRef, applyMessagesResponse, pageSize]);

  const refreshMessagesForConversation = useCallback(async (conversationIdToRefresh: string) => {
    const cached = readCachedMessages(conversationIdToRefresh);
    const loadedLength = activeConvIdRef.current === conversationIdToRefresh
      ? messagesRef.current.length
      : cached?.messages.length ?? 0;
    const response = await fetchMessagesPage(conversationIdToRefresh, { limit: Math.max(pageSize, loadedLength) });
    setMessagePagingError(null);
    applyMessagesResponse(conversationIdToRefresh, response);
  }, [activeConvIdRef, applyMessagesResponse, pageSize]);

  const loadOlderMessages = useCallback(async () => {
    if (!activeConvId || !hasOlderMessages || oldestLoadedSeq === null || loadingOlderMessages) return;
    const loadingConvId = activeConvId;
    setLoadingOlderMessages(true);
    try {
      const { messages: olderMessages, hasMore, oldestSeq } = await fetchMessagesPage(loadingConvId, {
        limit: pageSize,
        beforeSeq: oldestLoadedSeq,
      });
      if (activeConvIdRef.current !== loadingConvId) return;
      setMessagePagingError(null);
      const mergeOlderMessages = (currentMessages: Message[]) => uniqueMessagesById([
        ...olderMessages,
        ...currentMessages,
      ]);
      updateCachedMessages(loadingConvId, mergeOlderMessages, {
        hasMore,
        oldestSeq,
      });
      setMessages(currentMessages => mergeOlderMessages(currentMessages));
      setHasOlderMessages(hasMore);
      setOldestLoadedSeq(oldestSeq);
    } catch (error) {
      if (!isAbortError(error)) reportMessagePagingError(error);
    } finally {
      setLoadingOlderMessages(false);
    }
  }, [activeConvId, activeConvIdRef, hasOlderMessages, loadingOlderMessages, oldestLoadedSeq, pageSize, reportMessagePagingError]);

  return {
    messages,
    messagesRef,
    visibleMessages,
    hasOlderMessages,
    loadingOlderMessages,
    messagePagingError,
    serverUnextractedCount,
    serverUnextractedCountRef,
    serverTotalTokens,
    applyMessagesResponse,
    updateMessagesForConversation,
    clearMessages,
    replaceMessages,
    refreshMessages,
    refreshMessagesForConversation,
    loadOlderMessages,
    updateServerCounts,
    setServerUnextractedCountValue,
  };
}

export type UseMessagePagingResult = ReturnType<typeof useMessagePaging>;
