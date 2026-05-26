'use client';

import { useEffect, useState } from 'react';
import type { Message, Conversation } from '@/types';
import { useTranslation } from '@/lib/i18n-context';
import { formatTemplate } from '@/lib/i18n';
import { formatDateTime } from '@/lib/chat-view-utils';
import Modal from '@/components/ui/Modal';

const PAGE_SIZE = 30;

interface Props {
  open: boolean;
  conversationId: string | null;
  conversation: Conversation | null;
  serverUnextractedCount: number;
  memoryExtractStatus: 'idle' | 'extracting' | 'done' | 'failed';
  /** 关闭弹窗 */
  onClose: () => void;
  /** 切换提取状态：messageIds 为 undefined 表示对全部用户消息生效；action 决定 reset 或 mark */
  onSubmit: (messageIds: string[] | undefined, action: 'reset' | 'mark') => Promise<void>;
  /** 切换"忽略本对话"开关 */
  onToggleIgnore: () => Promise<void>;
  /** 手动触发记忆提取 */
  onManualExtract: () => Promise<void>;
  /** 异步加载该对话全部消息（来自父组件，复用同一 fetcher） */
  loadAllMessages: (conversationId: string) => Promise<Message[]>;
}

/**
 * 切换提取状态弹窗。
 * 从 ChatView 抽出：内部维护「全部消息」「选中集合」「分页计数」等局部状态。
 * 业务回调（实际 API 调用、本地 state 更新）仍由父组件持有，
 * 因为重置/标记要同步刷新主消息列表的 metadata 与未提取计数。
 *
 * 视觉外壳统一使用通用 <Modal> 组件，复用焦点陷阱 / ESC / Portal / aria-modal。
 */
export default function ResetExtractionModal(props: Props) {
  if (!props.open || !props.conversationId) return null;
  // 通过 key 让每次打开都是全新挂载，本地状态自然重置，避免在 effect 中 setState
  return <ResetExtractionModalInner key={props.conversationId} {...props} />;
}

function ResetExtractionModalInner({
  open,
  conversationId,
  conversation,
  serverUnextractedCount,
  memoryExtractStatus,
  onClose,
  onSubmit,
  onToggleIgnore,
  onManualExtract,
  loadAllMessages,
}: Props) {
  const { t } = useTranslation();
  // null = 加载中，[] = 加载完成但无消息
  const [allMessages, setAllMessages] = useState<Message[] | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);

  useEffect(() => {
    if (!conversationId) return;
    let cancelled = false;
    loadAllMessages(conversationId)
      .then(msgs => { if (!cancelled) setAllMessages(msgs); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [conversationId, loadAllMessages]);

  const userMsgs = (allMessages || []).filter(m => m.role === 'user').reverse();
  const visible = userMsgs.slice(0, visibleCount);
  const hasMore = userMsgs.length > visibleCount;

  return (
    <Modal open={open} onClose={onClose} title={t('chat.resetExtractionTitle')} maxWidth="max-w-md">
      <p className="section-copy">{t('chat.resetExtractionDesc')}</p>

      {/* 全选 / 取消全选 */}
      <div className="mt-3 flex items-center justify-between text-sm">
        <span className="text-text-muted">
          {selectedIds.size > 0
            ? formatTemplate(t('chat.resetSelectedHint'), { count: selectedIds.size })
            : t('chat.resetClickHint')}
        </span>
        <div className="flex gap-2">
          <button
            onClick={() => setSelectedIds(new Set(userMsgs.map(m => m.id)))}
            className="text-xs text-accent-dark hover:underline"
          >
            {t('chat.imageSelectAll')}
          </button>
          <button
            onClick={() => setSelectedIds(new Set())}
            className="text-xs text-text-muted hover:underline"
          >
            {t('chat.imageUnselectAll')}
          </button>
        </div>
      </div>

      {/* 消息列表 */}
      {allMessages === null ? (
        <div className="mt-2 flex items-center justify-center py-8 text-sm text-text-muted">
          {t('common.loading')}
        </div>
      ) : (
        <div className="mt-2 max-h-64 overflow-y-auto rounded-xl border border-border-light">
          {visible.map(m => {
            const meta = (m.metadata as Record<string, unknown>) || {};
            const extracted = Boolean(meta.memory_extracted);
            const selected = selectedIds.has(m.id);
            return (
              <button
                key={m.id}
                onClick={() => {
                  setSelectedIds(prev => {
                    const next = new Set(prev);
                    if (next.has(m.id)) next.delete(m.id);
                    else next.add(m.id);
                    return next;
                  });
                }}
                className={`flex w-full items-start gap-3 border-b border-border-light px-4 py-3 text-left text-sm transition-colors ${
                  selected ? 'bg-accent/8' : 'hover:bg-accent/5'
                }`}
              >
                <span className={`mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded border transition-colors ${
                  selected ? 'border-accent bg-accent text-white' : 'border-border-light bg-white'
                }`}>
                  {selected && (
                    <svg viewBox="0 0 10 8" fill="none" className="h-2.5 w-2.5" aria-hidden="true">
                      <path d="M1 4l3 3 5-6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  )}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-text-primary">{m.content.slice(0, 60)}</span>
                  <span className="text-xs text-text-muted">{formatDateTime(m.created_at)}</span>
                </span>
                <span className={`mt-0.5 shrink-0 text-xs ${extracted ? 'text-green-500' : 'text-amber-500'}`}>
                  {extracted ? '✓' : '○'}
                </span>
              </button>
            );
          })}
          {hasMore && (
            <button
              onClick={() => setVisibleCount(v => v + PAGE_SIZE)}
              className="w-full px-4 py-3 text-center text-xs text-accent-dark hover:bg-accent/5"
            >
              {formatTemplate(t('chat.resetLoadMore'), { count: userMsgs.length - visibleCount })}
            </button>
          )}
        </div>
      )}

      <div className="mt-4 flex flex-wrap items-center gap-2">
        {/* 忽略本对话开关 */}
        <button
          onClick={() => void onToggleIgnore()}
          className={`soft-button px-3 py-1.5 text-xs ${conversation?.ignore_memory ? 'soft-button-primary' : 'soft-button-secondary'}`}
          title={t('chat.resetIgnoreTitle')}
        >
          {conversation?.ignore_memory ? t('chat.resetIgnoredOn') : t('chat.resetIgnoredOff')}
        </button>
        {/* 手动提取按钮 */}
        <button
          onClick={() => { onClose(); void onManualExtract(); }}
          disabled={memoryExtractStatus === 'extracting' || serverUnextractedCount === 0}
          className="soft-button soft-button-primary px-3 py-1.5 text-xs disabled:cursor-not-allowed disabled:opacity-50"
          title={t('chat.resetManualTitle')}
        >
          {memoryExtractStatus === 'extracting' ? t('chat.extracting') : t('chat.manualExtract')}
        </button>
        <div className="flex-1" />
        <button
          onClick={onClose}
          className="soft-button soft-button-secondary px-3 py-1.5 text-sm"
        >
          {t('chat.cancel')}
        </button>
        <button
          onClick={() => void onSubmit(undefined, 'reset')}
          className="soft-button soft-button-secondary px-3 py-1.5 text-sm"
        >
          {t('chat.resetAll')}
        </button>
        <button
          onClick={() => void onSubmit([...selectedIds], 'mark')}
          disabled={selectedIds.size === 0}
          className="soft-button soft-button-secondary px-3 py-1.5 text-sm disabled:cursor-not-allowed disabled:opacity-50"
        >
          {formatTemplate(t('chat.resetMarkExtracted'), { count: selectedIds.size })}
        </button>
        <button
          onClick={() => void onSubmit([...selectedIds], 'reset')}
          disabled={selectedIds.size === 0}
          className="soft-button soft-button-primary px-3 py-1.5 text-sm disabled:cursor-not-allowed disabled:opacity-50"
        >
          {formatTemplate(t('chat.resetSelected'), { count: selectedIds.size })}
        </button>
      </div>
    </Modal>
  );
}
