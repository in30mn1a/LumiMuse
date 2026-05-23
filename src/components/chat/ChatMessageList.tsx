'use client';

import { forwardRef, memo, type Ref } from 'react';
import type { Message, Character } from '@/types';
import { useTranslation } from '@/lib/i18n-context';
import { formatDateLabel, getVersionInfo, isSameDay } from '@/lib/chat-view-utils';
import { MemoryIcon } from '@/components/ui/icons';
import MessageBubble from './MessageBubble';

interface VersionInfo {
  total: number;
  active: number;
}

interface Props {
  visibleMessages: Message[];
  hiddenMessageId: string | null;
  streamingTargetId: string | null;
  highlightedId: string | null;
  isStreamingHere: boolean;
  hasOlderMessages: boolean;
  loadingOlderMessages: boolean;
  showTimestamps: boolean;
  activeConvId: string | null;
  streamingText: string;
  character: Character;
  streamingBubble: React.ReactNode;
  versionInfoByMessageId: Map<string, VersionInfo | undefined>;
  topSentinelRef: Ref<HTMLDivElement>;
  onLoadOlder: () => void;
  onEdit: (id: string, content: string, attachments?: Array<{ type: string; name: string; data?: string; url?: string; mimeType: string }>) => void;
  onDelete: (id: string) => void;
  onRegenerate: (id: string) => void;
  onRegenerateFromHere: (id: string) => void;
  onSwitchVersion: (id: string, versionIndex: number) => void;
  onGenerateImage: (id: string, existingPrompt?: string, replaceImageId?: string) => void;
  onDeleteImage: (messageId: string, imgId: string, versionId?: string) => void;
  onEditImagePrompt: (messageId: string, imgId: string, newPrompt: string) => void;
  onSetPrimaryImage: (messageId: string, imgId: string, versionId: string) => void;
}

/**
 * 滚动消息列表。
 * 通过 forwardRef 暴露 messagesEndRef 给父级，控制滚动到底部。
 * topSentinelRef 用 IntersectionObserver 触发分页加载历史消息（在父组件设置）。
 */
const ChatMessageList = forwardRef<HTMLDivElement, Props>(function ChatMessageList(
  {
    visibleMessages,
    hiddenMessageId,
    streamingTargetId,
    highlightedId,
    isStreamingHere,
    hasOlderMessages,
    loadingOlderMessages,
    showTimestamps,
    activeConvId,
    streamingText,
    character,
    streamingBubble,
    versionInfoByMessageId,
    topSentinelRef,
    onLoadOlder,
    onEdit,
    onDelete,
    onRegenerate,
    onRegenerateFromHere,
    onSwitchVersion,
    onGenerateImage,
    onDeleteImage,
    onEditImagePrompt,
    onSetPrimaryImage,
  },
  endRef,
) {
  const { t } = useTranslation();
  const filtered = visibleMessages.filter(m => m.id !== hiddenMessageId || m.id === streamingTargetId);

  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-3 py-4 md:px-5 md:py-5">
      {/* 对话切换加载骨架屏：消息为空但对话存在时显示 */}
      {visibleMessages.length === 0 && !streamingText && !isStreamingHere && activeConvId && (
        <div className="flex flex-col gap-5 py-2" aria-hidden="true">
          <div className="flex gap-3">
            <div className="h-10 w-10 shrink-0 animate-pulse rounded-2xl bg-accent/10" />
            <div className="flex flex-col gap-1.5">
              <div className="h-3 w-16 animate-pulse rounded-full bg-border-light" />
              <div className="h-16 w-56 animate-pulse rounded-2xl border border-border-light bg-white/80" style={{ animationDelay: '60ms' }} />
            </div>
          </div>
          <div className="flex flex-row-reverse gap-3">
            <div className="flex flex-col items-end gap-1.5">
              <div className="h-3 w-10 animate-pulse rounded-full bg-border-light" style={{ animationDelay: '120ms' }} />
              <div className="h-10 w-44 animate-pulse rounded-2xl bg-accent/15" style={{ animationDelay: '120ms' }} />
            </div>
          </div>
          <div className="flex gap-3">
            <div className="h-10 w-10 shrink-0 animate-pulse rounded-2xl bg-accent/10" style={{ animationDelay: '180ms' }} />
            <div className="flex flex-col gap-1.5">
              <div className="h-3 w-16 animate-pulse rounded-full bg-border-light" style={{ animationDelay: '180ms' }} />
              <div className="h-20 w-72 animate-pulse rounded-2xl border border-border-light bg-white/80" style={{ animationDelay: '180ms' }} />
            </div>
          </div>
        </div>
      )}

      {visibleMessages.length === 0 && !streamingText && !isStreamingHere && !activeConvId && (
        <div className="flex h-full min-h-[18rem] items-center justify-center">
          <div className="max-w-md text-center">
            <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-[1.4rem] bg-gradient-to-br from-accent/15 to-accent-light/25 text-accent-dark empty-breathe">
              <MemoryIcon className="h-6 w-6" />
            </div>
            <p className="text-base font-medium text-text-primary">{t('chat.emptyConversation')}</p>
            <p className="mt-2 text-sm text-text-muted">{t('chat.emptyConversationBody')}</p>
          </div>
        </div>
      )}

      {/* 顶部哨兵：进入视口时触发加载更多 */}
      <div ref={topSentinelRef} className="h-px" />

      {hasOlderMessages && (
        <div className="mb-4 flex items-center justify-center">
          <button
            onClick={onLoadOlder}
            disabled={loadingOlderMessages}
            className="chip cursor-pointer text-xs hover:border-accent/30 hover:bg-accent/8 hover:text-accent-dark"
          >
            {loadingOlderMessages ? '正在加载更早消息...' : '↑ 加载更早消息'}
          </button>
        </div>
      )}

      {filtered.map((message, index, arr) => {
        const prevMessage = index > 0 ? arr[index - 1] : null;
        const isFirstVisible = index === 0;
        const showDateDivider = isFirstVisible
          ? !hasOlderMessages
          : !isSameDay(prevMessage!.created_at, message.created_at);
        const isStreamingTarget = isStreamingHere && streamingTargetId === message.id;
        return (
          <div key={message.id} id={`msg-${message.id}`} className={`mb-4 rounded-2xl transition-all duration-500 ${highlightedId === message.id ? 'ring-2 ring-accent/40 ring-offset-2 bg-accent/5' : ''}`}>
            {showDateDivider && (
              <div className="mb-4 flex items-center gap-3">
                <div className="h-px flex-1 bg-border-light" />
                <span className="text-[11px] text-text-muted">{formatDateLabel(message.created_at)}</span>
                <div className="h-px flex-1 bg-border-light" />
              </div>
            )}
            {isStreamingTarget ? streamingBubble : (
              <MessageBubble
                message={message}
                characterName={character.name}
                avatarUrl={character.avatar_url}
                showTimestamps={showTimestamps}
                versionInfo={versionInfoByMessageId.get(message.id) ?? getVersionInfo(message)}
                onEdit={onEdit}
                onDelete={onDelete}
                onRegenerate={onRegenerate}
                onRegenerateFromHere={onRegenerateFromHere}
                onSwitchVersion={onSwitchVersion}
                onGenerateImage={onGenerateImage}
                onDeleteImage={onDeleteImage}
                onEditImagePrompt={onEditImagePrompt}
                onSetPrimaryImage={onSetPrimaryImage}
              />
            )}
          </div>
        );
      })}

      {/* 正在生成时显示占位气泡 */}
      {isStreamingHere && !streamingTargetId && streamingBubble}

      <div ref={endRef} />
    </div>
  );
});

export default memo(ChatMessageList);
