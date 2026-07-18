import { useCallback, type MutableRefObject } from 'react';
import type { Message } from '@/types';
import type { ToastType } from '@/components/ui/Toast';
import type { AttachmentItem } from '@/lib/chat-engine';
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

function findLastAssistantId(messages: Message[]): string | undefined {
  return [...messages].reverse().find(message => message.role === 'assistant')?.id;
}

export type SendChatStreamOpts =
  | {
      mode: 'new';
      convId: string;
      content: string;
      attachments?: AttachmentItem[];
      /** 非 Abort 失败时回滚 UI（如删除 temp-user） */
      onFailureCleanup?: () => void;
    }
  | {
      mode: 'regenerate';
      convId: string;
      content: string;
      regenerateAssistantId: string;
    }
  | {
      mode: 'insert';
      convId: string;
      content: string;
      insertAfterUserMessageId: string;
    };

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

  /**
   * 一次聊天流的完整生命周期：begin → fetch/SSE → refresh → 按 mode 显式目标自动生图 → touch → finish。
   * new / regenerate / insert 共用，避免协议双份与共享 Set 暗协议。
   */
  const sendChatStream = useCallback(async (opts: SendChatStreamOpts) => {
    const { mode, convId, content } = opts;
    const regenerateAssistantId = mode === 'regenerate' ? opts.regenerateAssistantId : undefined;
    const insertAfterUserMessageId = mode === 'insert' ? opts.insertAfterUserMessageId : undefined;
    const attachments = mode === 'new' ? opts.attachments : undefined;
    const onFailureCleanup = mode === 'new' ? opts.onFailureCleanup : undefined;

    const controller = beginStream(convId, {
      regenerateAssistantId,
      insertAfterUserMessageId,
    });
    const streamConversationId = convId;

    // 三种 mode 均按显式目标 id 触发自动出图；定位失败则不触发（不再靠 effect 兜底）。
    // 属收尾装饰步骤：拉页失败只提示加载失败，不得误报为发送失败；
    // new 模式沿用旧行为，仅在用户仍停留在该对话时出图。
    const triggerAutoImage = async () => {
      if (mode === 'new' && activeConvIdRef.current !== streamConversationId) return;
      try {
        const page = await fetchMessagesPage(streamConversationId, {
          limit: Math.max(pageSize, messagesRef.current.length),
        });
        const targetAssistantId = mode === 'regenerate'
          ? regenerateAssistantId
          : mode === 'insert'
            ? findAssistantInsertedAfterUser(page.messages, insertAfterUserMessageId!)
            : findLastAssistantId(page.messages);
        if (targetAssistantId) {
          void maybeAutoGenerateImageFromMessages(streamConversationId, page.messages, {
            assistantMessageId: targetAssistantId,
            retry: mode === 'regenerate',
          });
        }
      } catch {
        showToast(t('chat.messageLoadFailed'), 'error');
      }
    };

    try {
      const response = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          conversation_id: convId,
          content,
          ...buildClientTimePayload(),
          ...(attachments && attachments.length > 0 ? { attachments } : {}),
          ...(regenerateAssistantId ? { regenerate_assistant_id: regenerateAssistantId } : {}),
          ...(insertAfterUserMessageId ? { insert_assistant_after_user_id: insertAfterUserMessageId } : {}),
          ...(mode !== 'new' ? { skip_user_insert: true } : {}),
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

      if (mode === 'regenerate') markSkipNextScroll();
      await refreshMessagesForConversation(streamConversationId);

      // 仅局部 bump 当前对话摘要；记忆列表由 pollMemoryTask 在提取完成后刷新
      touchConversation(streamConversationId);

      await triggerAutoImage();
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        // 中止的部分回复已落库，仍尝试自动出图（尾部 [IMG] 块可能已流完）
        await refreshMessagesForConversation(streamConversationId);
        await triggerAutoImage();
      } else if (error instanceof TypeError) {
        showToast(t('chat.errorNetwork'));
        onFailureCleanup?.();
      } else {
        const message = error instanceof Error ? error.message : String(error);
        showToast(message || t('chat.errorGeneral'));
        onFailureCleanup?.();
      }
    } finally {
      finishStream(streamConversationId, { clearRegenerationState: mode !== 'new' });
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

    await sendChatStream({
      mode: 'regenerate',
      convId,
      content: userMessage.content,
      regenerateAssistantId: messageId,
    });
  }, [activeConvIdRef, activeStreamsRef, sendChatStream, messagesRef]);

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

    if (nextAssistant) {
      await sendChatStream({
        mode: 'regenerate',
        convId,
        content: userContent,
        regenerateAssistantId: nextAssistant.id,
      });
    } else {
      await sendChatStream({
        mode: 'insert',
        convId,
        content: userContent,
        insertAfterUserMessageId: userMessageId,
      });
    }
  }, [activeConvIdRef, activeStreamsRef, sendChatStream, messagesRef]);

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
    sendChatStream,
    handleEditMessage,
    handleDeleteMessage,
    handleRegenerate,
    handleRegenerateFromHere,
    handleSwitchVersion,
  };
}

export type UseChatMessageActionsResult = ReturnType<typeof useChatMessageActions>;
