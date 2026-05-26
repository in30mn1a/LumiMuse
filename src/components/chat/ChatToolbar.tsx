'use client';

import { memo } from 'react';
import { useTranslation } from '@/lib/i18n-context';
import { SparkIcon } from '@/components/ui/icons';
import type { Conversation } from '@/types';

type ExtractStatus = 'idle' | 'extracting' | 'done' | 'failed';

interface Props {
  activeConversation: Conversation | null;
  unextractedCount: number;
  memoryExtractStatus: ExtractStatus;
  tokenCount: number;
  onOpenResetExtraction: () => void;
}

/**
 * 消息列表上方的状态栏：
 * 左侧显示对话标题，右侧显示提取状态 chip + token 估算。
 * 「已忽略提取 / N 待提取 / 提取管理」三态由 conversation.ignore_memory + unextractedCount 决定。
 */
function ChatToolbarImpl({
  activeConversation,
  unextractedCount,
  memoryExtractStatus,
  tokenCount,
  onOpenResetExtraction,
}: Props) {
  const { t } = useTranslation();

  return (
    <div className="flex items-center justify-between border-b border-border-light px-3 py-2.5 text-sm text-text-secondary md:px-5 md:py-4">
      <div className="flex min-w-0 items-center gap-2">
        <SparkIcon className="h-4 w-4 text-accent" />
        <span className="truncate text-xs md:text-sm">{activeConversation?.title || t('chat.noConversationTitle')}</span>
      </div>
      <div className="flex shrink-0 items-center gap-1.5 md:gap-2">
        {activeConversation?.ignore_memory ? (
          <button
            onClick={onOpenResetExtraction}
            className="chip cursor-pointer text-[10px] md:text-xs text-text-muted border-border-light opacity-60 hover:opacity-90"
            title={t('chat.ignoredHintTitle')}
          >
            {t('chat.ignoredHint')}
          </button>
        ) : unextractedCount > 0 ? (
          <button
            onClick={onOpenResetExtraction}
            className="chip cursor-pointer text-amber-600 border-amber-200 bg-amber-50/80 hover:bg-amber-100/80 text-[10px] md:text-xs"
            title={t('chat.resetExtraction')}
          >
            {unextractedCount} {t('chat.unextracted')}
          </button>
        ) : (
          <button
            onClick={onOpenResetExtraction}
            className="chip cursor-pointer text-[10px] md:text-xs opacity-50 hover:opacity-80"
            title={t('chat.resetExtraction')}
          >
            {t('chat.manageExtraction')}
          </button>
        )}
        {memoryExtractStatus !== 'idle' && (
          <span className={`chip text-[10px] md:text-xs transition-opacity ${
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
        <span className="chip text-[10px] md:text-xs">≈{tokenCount} {t('status.tokens')}</span>
      </div>
    </div>
  );
}

const ChatToolbar = memo(ChatToolbarImpl);
export default ChatToolbar;
