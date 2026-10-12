'use client';

import { memo } from 'react';
import { useTranslation } from '@/lib/i18n-context';
import type { Conversation } from '@/types';

type ExtractStatus = 'idle' | 'extracting' | 'done' | 'failed';

interface Props {
  activeConversation: Conversation | null;
  unextractedCount: number;
  memoryExtractStatus: ExtractStatus;
  tokenCount: number;
  /** true 表示 tokenCount 是模型返回的真实值（不带 ≈）；false 表示是估算值（带 ≈） */
  isRealTokenCount?: boolean;
  onOpenResetExtraction: () => void;
  onOpenTokenBreakdown: () => void;
}

/**
 * 顶栏状态条（由 ChatHeader 的 status 插槽摆放）：
 * 提取状态 chip 在左，token 估算在右；<lg 是顶栏下方的一条细条，lg+ 并入顶栏同一行。
 * 「已忽略提取 / N 待提取 / 提取管理」三态由 conversation.ignore_memory + unextractedCount 决定。
 */
function ChatToolbarImpl({
  activeConversation,
  unextractedCount,
  memoryExtractStatus,
  tokenCount,
  isRealTokenCount,
  onOpenResetExtraction,
  onOpenTokenBreakdown,
}: Props) {
  const { t } = useTranslation();

  return (
    <div className="flex h-9 items-center gap-1.5 border-t border-border-light px-3 text-text-secondary lg:h-auto lg:border-0 lg:px-0">
      {activeConversation?.ignore_memory ? (
        <button
          onClick={onOpenResetExtraction}
          className="chip cursor-pointer text-xs text-text-muted border-border-light opacity-60 hover:opacity-90"
          title={t('chat.ignoredHintTitle')}
        >
          {t('chat.ignoredHint')}
        </button>
      ) : unextractedCount > 0 ? (
        <button
          onClick={onOpenResetExtraction}
          className="chip cursor-pointer text-amber-600 border-amber-200 bg-amber-50/80 hover:bg-amber-100/80 text-xs"
          title={t('chat.resetExtraction')}
        >
          {unextractedCount} {t('chat.unextracted')}
        </button>
      ) : (
        <button
          onClick={onOpenResetExtraction}
          className="chip cursor-pointer text-xs opacity-50 hover:opacity-80"
          title={t('chat.resetExtraction')}
        >
          {t('chat.manageExtraction')}
        </button>
      )}
      {memoryExtractStatus !== 'idle' && (
        <span role="status" aria-live="polite" aria-atomic="true" className={`chip text-xs transition-opacity ${
          memoryExtractStatus === 'extracting'
            ? 'text-purple-600 border-purple-200 bg-purple-50/80 animate-pulse'
            : memoryExtractStatus === 'done'
            ? 'text-green-600 border-green-200 bg-green-50/80'
            : 'text-red-500 border-red-200 bg-red-50/80'
        }`}>
          {memoryExtractStatus === 'extracting' ? t('chat.extracting')
            : memoryExtractStatus === 'done' ? t('chat.extractDone')
            : t('chat.extractFailed')}
        </span>
      )}
      <span className="flex-1 lg:hidden" />
      <button
        type="button"
        onClick={onOpenTokenBreakdown}
        className="chip cursor-pointer text-xs hover:bg-surface/80"
        title={t('token.breakdownTitle')}
      >
        {isRealTokenCount ? '' : '≈'}{tokenCount} {t('status.tokens')}
      </button>
    </div>
  );
}

const ChatToolbar = memo(ChatToolbarImpl);
export default ChatToolbar;
