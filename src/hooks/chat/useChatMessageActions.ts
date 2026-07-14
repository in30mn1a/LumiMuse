import { useCallback, type MutableRefObject } from 'react';
import type { Message } from '@/types';
import type { ToastType } from '@/components/ui/Toast';
import { parseJsonResponse } from '@/lib/http';
import {
  buildClientTimePayload,
  fetchMessagesPage,
  readChatSseStream,
} from '@/lib/chat-stream-client';

type UpdateMessagesForConversation = (
  conversationIdToUpdate: string,
  updater: (messages: Message[]) => Message[],
) => void;

type StreamingUsage = {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
};

/** 中段 insert 落库后：锚点 user 之后紧邻的第一条 assistant（按列表顺序） */
function findAssistantInsertedAfterUser(messages: Message[], userMessageId: string): string | undefined {
  const userIndex = messages.findIndex(message => message.id === userMessageId && message.role === 'user');
  if (userIndex < 0) return undefined;
  const next = messages[userIndex + 1];
  return next?.role === 'assistant' ? next.id : undefined;
}

type UseChatMessageActionsOptions = {
  activeConvIdRef: MutableRefObject<string | null>;
  activeStreamsRef: MutableRefObject<Set<string>>;
  messagesRef: MutableRefObject<Message[]>;
  beginStream: (convId: string, options?: { regenerateAssistantId?: string; insertAfterUserMessageId?: string }) => AbortController;
  finishStream: (convId: string, options?: { clearRegenerationState?: boolean }) => void;
  scheduleStreamingText: (convId: string, text: string) => void;
  setStreamingUsage: (usage: { convId: string; usage: StreamingUsage } | null) => void;
  pollMemoryTask: (convId: string) => void | Promise<void>;
  refreshMessagesForConversation: (conversationId: string) => Promise<void>;
  /** 聊天/重生成成功后局部更新对话摘要，避免全量重拉对话与记忆 */
  touchConversation: (conversationId: string) => void;
  updateMessagesForConversation: UpdateMessagesForConversation;
  markSkipNextScroll: () => void;
  showToast: (message: string, type?: ToastType) => void;
  t: (key: string) => string;
  pageSize: number;
  maybeAutoGenerateImageFromMessages: (
    cid: string,
    freshMessages: Message[],
    options?: { assistantMessageId?: string; retry?: boolean },
  ) => void | Promise<void>;
  /** 标记本轮流已由 callChatStream 按目标 id 处理自动出图，避免 ChatView 无目标 effect 误打末尾气泡 */
  markStreamAutoImageHandled: (cid: string) => void;
  clearStreamAutoImageHandled: (cid: string) => void;
};

export function useChatMessageActions({
  activeConvIdRef,
  activeStreamsRef,
  messagesRef,
  beginStream,
  finishStream,
  scheduleStreamingText,
  setStreamingUsage,
  pollMemoryTask,
  refreshMessagesForConversation,
  touchConversation,
  updateMessagesForConversation,
  markSkipNextScroll,
  showToast,
  t,
  pageSize,
  maybeAutoGenerateImageFromMessages,
  markStreamAutoImageHandled,
  clearStreamAutoImageHandled,
}: UseChatMessageActionsOptions) {
  const handleEditMessage = useCallback(async (
    id: string,
    content: string,
    attachments?: Array<{ type: string; name: string; data?: string; url?: string; mimeType: string }>,
  ) => {
    try {
      const updated = await parseJsonResponse<Message>(await fetch(`/api/messages/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content, attachments: attachments ?? [] }),
      }));
      updateMessagesForConversation(updated.conversation_id, messages => messages.map(message => (
        message.id === id ? updated : message
      )));
      await refreshMessagesForConversation(updated.conversation_id);
    } catch (err) {
      showToast(err instanceof Error ? err.message : t('common.operationFailed'), 'error');
    }
  }, [refreshMessagesForConversation, showToast, t, updateMessagesForConversation]);

  const handleDeleteMessage = useCallback(async (id: string) => {
    try {
      const res = await fetch(`/api/messages/${id}`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
      });
      const data = await parseJsonResponse<{
        ok: boolean;
        deleted: 'message' | 'version';
        conversation_id: string;
        message?: Message;
      }>(res);
      if (!data.ok) throw new Error(t('message.deleteFailed'));
      const convId = data.conversation_id;
      if (!convId) throw new Error(t('message.deleteFailed'));
      if (data.deleted === 'version' && data.message) {
        updateMessagesForConversation(convId, messages => messages.map(message => (
          message.id === id ? data.message! : message
        )));
      } else {
        updateMessagesForConversation(convId, messages => messages.filter(message => message.id !== id));
      }
      await refreshMessagesForConversation(convId);
    } catch (err) {
      showToast(err instanceof Error ? err.message : t('message.deleteFailed'), 'error');
    }
  }, [refreshMessagesForConversation, showToast, t, updateMessagesForConversation]);

  const callChatStream = useCallback(async (
    convId: string,
    userContent: string,
    regenerateAssistantId?: string,
    skipUserInsert?: boolean,
    insertAssistantAfterUserId?: string,
  ) => {
    const controller = beginStream(convId, {
      regenerateAssistantId,
      insertAfterUserMessageId: !regenerateAssistantId ? insertAssistantAfterUserId : undefined,
    });
    const streamConversationId = convId;
    // 新流开始：清掉上一轮残留的 handled 标记
    clearStreamAutoImageHandled(streamConversationId);

    try {
      const response = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          conversation_id: convId,
          content: userContent,
          ...buildClientTimePayload(),
          ...(regenerateAssistantId ? { regenerate_assistant_id: regenerateAssistantId } : {}),
          ...(insertAssistantAfterUserId ? { insert_assistant_after_user_id: insertAssistantAfterUserId } : {}),
          ...(skipUserInsert ? { skip_user_insert: true } : {}),
        }),
        signal: controller.signal,
      });

      if (!response.ok || !response.body) {
        let errorMessage = `HTTP ${response.status}`;
        try {
          const errorBody = await response.json();
          if (errorBody.error || errorBody.message) {
            errorMessage = errorBody.error || errorBody.message || errorMessage;
          }
        } catch {
          // 响应体不是 JSON 时保留状态码信息。
        }
        throw new Error(errorMessage);
      }

      let fullText = '';
      await readChatSseStream(response.body, {
        onChunk: text => {
          fullText += text;
          scheduleStreamingText(streamConversationId, fullText);
        },
        onUsage: usage => {
          if (activeConvIdRef.current === streamConversationId) {
            setStreamingUsage({ convId: streamConversationId, usage });
          }
        },
        onMemoryExtracting: () => {
          void pollMemoryTask(streamConversationId);
        },
        getErrorMessage: () => t('chat.errorGeneral'),
      });

      if (regenerateAssistantId) markSkipNextScroll();
      await refreshMessagesForConversation(streamConversationId);

      // regenerate：目标 id 已知；mid-insert：新 assistant 落在锚点 user 之后，需从刷新结果定位
      // 两种路径都按目标 id 触发自动出图，并 mark 掉 ChatView 无目标 effect，避免 reverse().find 误打末尾旧气泡
      if (regenerateAssistantId || insertAssistantAfterUserId) {
        const response = await fetchMessagesPage(streamConversationId, {
          limit: Math.max(pageSize, messagesRef.current.length),
        });
        const targetAssistantId = regenerateAssistantId
          ?? findAssistantInsertedAfterUser(response.messages, insertAssistantAfterUserId!);
        if (targetAssistantId) {
          // 仅在成功定位目标时 mark，避免定位失败还挡住 ChatView 兜底
          markStreamAutoImageHandled(streamConversationId);
          void maybeAutoGenerateImageFromMessages(streamConversationId, response.messages, {
            assistantMessageId: targetAssistantId,
            retry: Boolean(regenerateAssistantId),
          });
        }
      }
      // 仅局部 bump 当前对话摘要；记忆列表由 pollMemoryTask 在提取完成后刷新
      touchConversation(streamConversationId);
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        await refreshMessagesForConversation(streamConversationId);
      } else if (error instanceof TypeError) {
        showToast(t('chat.errorNetwork'));
      } else {
        const message = error instanceof Error ? error.message : String(error);
        showToast(message || t('chat.errorGeneral'));
      }
    } finally {
      finishStream(streamConversationId, { clearRegenerationState: true });
    }
  }, [
    activeConvIdRef,
    beginStream,
    finishStream,
    markSkipNextScroll,
    pollMemoryTask,
    refreshMessagesForConversation,
    scheduleStreamingText,
    setStreamingUsage,
    showToast,
    t,
    touchConversation,
    pageSize,
    maybeAutoGenerateImageFromMessages,
    markStreamAutoImageHandled,
    clearStreamAutoImageHandled,
    messagesRef,
  ]);

  const handleRegenerate = useCallback(async (messageId: string) => {
    const convId = activeConvIdRef.current;
    if (!convId || activeStreamsRef.current.has(convId)) return;

    const currentMessages = messagesRef.current;
    const targetIndex = currentMessages.findIndex(message => message.id === messageId);
    if (targetIndex === -1) return;
    const userMessage = [...currentMessages.slice(0, targetIndex)]
      .reverse()
      .find(message => message.role === 'user');
    if (!userMessage) return;

    await callChatStream(convId, userMessage.content, messageId, true);
  }, [activeConvIdRef, activeStreamsRef, callChatStream, messagesRef]);

  const handleRegenerateFromHere = useCallback(async (userMessageId: string) => {
    const convId = activeConvIdRef.current;
    if (!convId || activeStreamsRef.current.has(convId)) return;

    const currentMessages = messagesRef.current;
    const userMessageIndex = currentMessages.findIndex(message => message.id === userMessageId);
    if (userMessageIndex === -1) return;
    const userContent = currentMessages[userMessageIndex].content;
    // 只认「紧挨着的下一条」是否为 assistant；中间角色被删后下一条往往是 user，不能误抓更后面的 assistant
    const immediateNext = currentMessages[userMessageIndex + 1];
    const nextAssistant = immediateNext?.role === 'assistant' ? immediateNext : undefined;

    await callChatStream(
      convId,
      userContent,
      nextAssistant?.id,
      true,
      nextAssistant ? undefined : userMessageId,
    );
  }, [activeConvIdRef, activeStreamsRef, callChatStream, messagesRef]);

  const handleSwitchVersion = useCallback(async (messageId: string, versionIndex: number) => {
    try {
      const updated = await parseJsonResponse<Message>(await fetch(`/api/messages/${messageId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ activeVersion: versionIndex }),
      }));
      updateMessagesForConversation(updated.conversation_id, messages => messages.map(message => (
        message.id === messageId ? updated : message
      )));
      await refreshMessagesForConversation(updated.conversation_id);
    } catch (err) {
      showToast(err instanceof Error ? err.message : t('common.operationFailed'), 'error');
    }
  }, [refreshMessagesForConversation, showToast, t, updateMessagesForConversation]);

  return {
    handleEditMessage,
    handleDeleteMessage,
    handleRegenerate,
    handleRegenerateFromHere,
    handleSwitchVersion,
  };
}

export type UseChatMessageActionsResult = ReturnType<typeof useChatMessageActions>;
