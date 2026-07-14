'use client';

import { useCallback, useEffect, useMemo, type Ref, type RefObject } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import type { Message, Character } from '@/types';
import { useTranslation } from '@/lib/i18n-context';
import { formatDateLabel, getVersionInfo, isSameDay } from '@/lib/chat-view-utils';
import { usePrependScrollAnchor, useScrollTargetVirtualizer } from '@/hooks/chat/useChatScrollController';
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
  streamingInsertAfterUserId: string | null;
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
  messagesEndRef: Ref<HTMLDivElement>;
  topSentinelRef: Ref<HTMLDivElement>;
  scrollContainerRef: RefObject<HTMLDivElement | null>;
  onLoadOlder: () => void;
  onEdit: (id: string, content: string, attachments?: Array<{ type: string; name: string; data?: string; url?: string; mimeType: string }>) => void;
  onDelete: (id: string) => void;
  onRegenerate: (id: string) => void;
  onRegenerateFromHere: (id: string) => void;
  onSwitchVersion: (id: string, versionIndex: number) => void;
  onGenerateImage: (id: string, existingPrompt?: string, replaceImageId?: string) => void;
  generatingImageMessageIds: ReadonlySet<string>;
  onDeleteImage: (messageId: string, imgId: string, versionId?: string) => void;
  onEditImagePrompt: (messageId: string, imgId: string, newPrompt: string) => void;
  onSetPrimaryImage: (messageId: string, imgId: string, versionId: string) => void;
}

/**
 * 滚动消息列表（基于 @tanstack/react-virtual 的窗口化渲染）。
 *
 * 虚拟化结构：
 *   <div ref={scrollContainerRef} class="overflow-y-auto"> ← 滚动容器（virtualizer 的 scroll element）
 *     <div ref={topSentinelRef} />                     ← 顶部哨兵
 *     [加载更早消息按钮]
 *     <div style={{ height: totalSize, position: 'relative' }}>  ← virtualizer inner
 *       绝对定位的虚拟 row
 *     </div>
 *     [流式占位气泡]
 *     <div ref={endRef} />                             ← 底部锚点
 *   </div>
 *
 * 动态高度：每个 row 用 measureElement（基于 ResizeObserver）自动测量，
 * 流式生成时最后一条 bubble 高度持续变化也能被自动捕获。
 */
function ChatMessageList(
  {
    visibleMessages,
    hiddenMessageId,
    streamingTargetId,
    streamingInsertAfterUserId,
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
    messagesEndRef,
    topSentinelRef,
    scrollContainerRef,
    onLoadOlder,
    onEdit,
    onDelete,
    onRegenerate,
    onRegenerateFromHere,
    onSwitchVersion,
    onGenerateImage,
    generatingImageMessageIds,
    onDeleteImage,
    onEditImagePrompt,
    onSetPrimaryImage,
  }: Props,
) {
  const { t } = useTranslation();

  const filtered = useMemo(
    () => visibleMessages.filter(m => m.id !== hiddenMessageId || m.id === streamingTargetId),
    [visibleMessages, hiddenMessageId, streamingTargetId],
  );

  // eslint-disable-next-line react-hooks/incompatible-library -- TanStack Virtual intentionally returns imperative helpers used only inside this list.
  const virtualizer = useVirtualizer({
    count: filtered.length,
    getScrollElement: () => scrollContainerRef.current,
    estimateSize: () => 120,
    getItemKey: index => filtered[index]?.id ?? index,
    overscan: 8,
    // 流式生成最后一条消息时，让对应 row 总是被测量；其它 row 默认走 measureElement。
    measureElement:
      typeof window !== 'undefined' && typeof ResizeObserver !== 'undefined'
        ? element => element.getBoundingClientRect().height
        : undefined,
  });

  const virtualItems = virtualizer.getVirtualItems();
  const totalSize = virtualizer.getTotalSize();

  usePrependScrollAnchor({
    scrollContainerRef,
    items: filtered,
    totalSize,
  });

  // 当父组件设定 highlightedId（例如搜索跳转）但目标 row 还没渲染时，主动滚到对应 index，
  // 让 virtualizer 把它挂上 DOM。父组件随后 document.getElementById('msg-${id}').scrollIntoView()
  // 才能拿到真实节点完成最终居中。
  useScrollTargetVirtualizer({
    targetMessageId: highlightedId,
    items: filtered,
    scrollToIndex: (idx, options) => virtualizer.scrollToIndex(idx, options),
    isTargetRendered: id => typeof document !== 'undefined' && Boolean(document.getElementById(`msg-${id}`)),
  });

  // 流式生成时最后一条 bubble 高度会持续变化。ResizeObserver 已经能捕获绝大多数变化，
  // 但纯文本追加偶尔会在同一帧内多次变化，强制在 streamingText 变化时再触发一次 re-measure，
  // 让虚拟列表 totalSize / 后续 row 偏移及时跟上，避免「跟随滚动到底部」时少几个像素。
  useEffect(() => {
    if (!isStreamingHere || !streamingTargetId) return;
    const idx = filtered.findIndex(m => m.id === streamingTargetId);
    if (idx === -1) return;
    // virtualItems 已渲染时才会有真实 DOM；不在窗口内则无需测量
    if (!virtualItems.some(v => v.index === idx)) return;
    const el = document.querySelector(`[data-virtual-index="${idx}"]`) as HTMLElement | null;
    if (el) virtualizer.measureElement(el);
  }, [streamingText, streamingTargetId, isStreamingHere, filtered, virtualItems, virtualizer]);

  // 暴露给 React 的 row ref —— 同时收集 virtualizer 测量需要的 element。
  const setRowRef = useCallback(
    (node: HTMLDivElement | null) => {
      if (node) virtualizer.measureElement(node);
    },
    [virtualizer],
  );

  const isEmpty = visibleMessages.length === 0 && !streamingText && !isStreamingHere;

  return (
    <div
      ref={scrollContainerRef}
      className="min-h-0 flex-1 overflow-y-auto px-3 py-4 md:px-5 md:py-5"
    >
      {/* 对话切换加载骨架屏：消息为空但对话存在时显示 */}
      {isEmpty && activeConvId && (
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

      {isEmpty && !activeConvId && (
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

      {/* 顶部哨兵：进入视口时触发加载更多。必须是滚动容器的直接子节点，
          IntersectionObserver 才能根据视口正确判断顶部到达。 */}
      <div ref={topSentinelRef} className="h-px" />

      {hasOlderMessages && (
        <div className="mb-4 flex items-center justify-center">
          <button
            onClick={onLoadOlder}
            disabled={loadingOlderMessages}
            className="chip cursor-pointer text-xs hover:border-accent/30 hover:bg-accent/8 hover:text-accent-dark"
          >
            {loadingOlderMessages ? t('chat.loadingOlder') : t('chat.loadOlder')}
          </button>
        </div>
      )}

      {/* virtualizer inner：高度为所有 row 之和，row 用绝对定位摆放。
          只有 visibleMessages 非空才渲染，避免空容器抢占空间。 */}
      {filtered.length > 0 && (
        <div
          style={{
            height: totalSize,
            width: '100%',
            position: 'relative',
          }}
        >
          {virtualItems.map(virtualItem => {
            const message = filtered[virtualItem.index];
            if (!message) return null;
            const prevMessage = virtualItem.index > 0 ? filtered[virtualItem.index - 1] : null;
            const isFirstVisible = virtualItem.index === 0;
            const showDateDivider = isFirstVisible
              ? !hasOlderMessages
              : !isSameDay(prevMessage!.created_at, message.created_at);
            const isStreamingTarget = isStreamingHere && streamingTargetId === message.id;
            return (
              <div
                key={virtualItem.key}
                ref={setRowRef}
                data-index={virtualItem.index}
                data-virtual-index={virtualItem.index}
                style={{
                  position: 'absolute',
                  top: 0,
                  left: 0,
                  width: '100%',
                  transform: `translateY(${virtualItem.start}px)`,
                }}
              >
                <div
                  id={`msg-${message.id}`}
                  className={`mb-4 rounded-2xl transition-all duration-500 ${highlightedId === message.id ? 'ring-2 ring-accent/40 ring-offset-2 bg-accent/5' : ''}`}
                >
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
                      isGeneratingImage={generatingImageMessageIds.has(message.id)}
                      onDeleteImage={onDeleteImage}
                      onEditImagePrompt={onEditImagePrompt}
                      onSetPrimaryImage={onSetPrimaryImage}
                    />
                  )}
                  {isStreamingHere
                    && !streamingTargetId
                    && streamingInsertAfterUserId === message.id
                    && streamingBubble}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* 正在生成时显示占位气泡（仅当没有对应已存在的目标消息时；否则气泡由列表内的 streamingTarget 行渲染） */}
      {isStreamingHere && !streamingTargetId && !streamingInsertAfterUserId && streamingBubble}

      {/* 底部锚点：由 useChatScrollController 控制滚动到底部。 */}
      <div ref={messagesEndRef} />
    </div>
  );
}

export default ChatMessageList;
