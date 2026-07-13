import { useCallback, useState, type Dispatch, type SetStateAction } from 'react';
import type { Character, Conversation, Message } from '@/types';
import type { MessagesResponse } from '@/lib/chat-stream-client';
import { writeCachedMessages } from '@/lib/chat-message-cache';
import { getErrorMessage, parseJsonResponse } from '@/lib/http';

type UseNewChatOptions = {
  character: Character | null;
  setConversations: Dispatch<SetStateAction<Conversation[]>>;
  selectActiveConvId: (conversationId: string | null) => void;
  applyMessagesResponse: (conversationId: string, response: MessagesResponse) => boolean;
  clearMessages: () => void;
  clearStreamingText: () => void;
  refreshConversationState: (preferredActiveId?: string | null) => Promise<void>;
  showToast: (message: string, type?: 'error' | 'info') => void;
  t: (key: string) => string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/** 校验 POST /api/conversations 响应形状；ChatView 自动建对话路径也复用此函数。 */
export function parseConversation(data: unknown): Conversation {
  if (!isRecord(data)
    || typeof data.id !== 'string'
    || typeof data.character_id !== 'string'
    || typeof data.title !== 'string'
    || typeof data.ignore_memory !== 'number'
    || typeof data.created_at !== 'string'
    || typeof data.updated_at !== 'string') {
    throw new Error('Invalid conversation response');
  }
  return data as unknown as Conversation;
}

function parseGreetingMessage(data: unknown, conversationId: string): Message {
  if (!isRecord(data)
    || typeof data.id !== 'string'
    || data.conversation_id !== conversationId
    || !['user', 'assistant', 'system'].includes(String(data.role))
    || typeof data.content !== 'string'
    || typeof data.token_count !== 'number'
    || typeof data.created_at !== 'string'
    || !isRecord(data.metadata)) {
    throw new Error('Invalid greeting response');
  }
  return data as unknown as Message;
}

function initializeEmptyMessages(conversationId: string): void {
  writeCachedMessages(conversationId, {
    messages: [],
    hasMore: false,
    oldestSeq: null,
    unextractedCount: 0,
    totalTokens: 0,
  });
}

export function useNewChat({
  character,
  setConversations,
  selectActiveConvId,
  applyMessagesResponse,
  clearMessages,
  clearStreamingText,
  refreshConversationState,
  showToast,
  t,
}: UseNewChatOptions) {
  const [creating, setCreating] = useState(false);

  const handleNewChat = useCallback(async () => {
    if (!character || creating) return;
    setCreating(true);
    try {
      const response = await fetch('/api/conversations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ character_id: character.id }),
      });
      const conversation = parseConversation(await parseJsonResponse<unknown>(response));
      setConversations(prev => [conversation, ...prev]);
      initializeEmptyMessages(conversation.id);
      clearMessages();
      selectActiveConvId(conversation.id);
      clearStreamingText();

      if (character.greeting) {
        try {
          const greetingResponse = await fetch('/api/messages', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ conversation_id: conversation.id, role: 'assistant', content: character.greeting, token_count: 0 }),
          });
          const greetingMessage = parseGreetingMessage(
            await parseJsonResponse<unknown>(greetingResponse),
            conversation.id,
          );
          applyMessagesResponse(conversation.id, {
            messages: [greetingMessage],
            hasMore: false,
            oldestSeq: typeof greetingMessage.seq === 'number' ? greetingMessage.seq : null,
            unextractedCount: 0,
            totalTokens: greetingMessage.token_count,
          });
        } catch (error) {
          showToast(`${t('chat.greetingCreateFailed')}: ${getErrorMessage(error)}`, 'error');
        }
      }

      void refreshConversationState(conversation.id);
    } catch (error) {
      showToast(`${t('common.operationFailed')}: ${getErrorMessage(error)}`, 'error');
    } finally {
      setCreating(false);
    }
  }, [
    applyMessagesResponse,
    character,
    clearMessages,
    clearStreamingText,
    creating,
    refreshConversationState,
    selectActiveConvId,
    setConversations,
    showToast,
    t,
  ]);

  return { creating, handleNewChat };
}
