'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from '@/lib/i18n-context';
import { SearchIcon, ClockIcon } from '@/components/ui/icons';
import { useMessageSearch } from '@/hooks/use-message-search';

interface SearchResult {
  id: string;
  title: string;
  subtitle?: string;
  characterId: string;
  conversationId: string;
  messageId: string;
}

interface Props {
  open: boolean;
  onClose: () => void;
  onConversationSelect?: (characterId: string, conversationId: string, messageId?: string) => void;
}

export default function GlobalSearch({ open, onClose, onConversationSelect }: Props) {
  const { t } = useTranslation();
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  // 打开搜索弹窗前的活跃元素（通常是触发 Cmd+K 的按钮或 body）
  // 关闭后将焦点还回去，保持键盘用户的操作连续性，避免焦点跳到 body 顶部
  const triggerRef = useRef<HTMLElement | null>(null);
  const { results: messageResults, loading, loadingMore, hasMore, loadMore, clearSearch } = useMessageSearch(open ? query : '', { limit: 30, debounceMs: 200 });
  const results = useMemo<SearchResult[]>(() => messageResults.map(m => ({
      id: m.messageId,
      title: m.snippet,
      subtitle: `${m.characterName} · ${m.conversationTitle}`,
      characterId: m.characterId,
      conversationId: m.conversationId,
      messageId: m.messageId,
    })), [messageResults]);
  const safeActiveIndex = results.length > 0 ? Math.min(activeIndex, results.length - 1) : 0;

  // 打开时聚焦输入框；同时记录原焦点元素以便关闭时恢复
  useEffect(() => {
    if (open) {
      // 在打开瞬间捕获原焦点（如 Cmd+K 触发按钮），后面 close 时再 .focus() 还回去
      triggerRef.current = (document.activeElement as HTMLElement) || null;
      queueMicrotask(() => {
        setQuery('');
        clearSearch();
        setActiveIndex(0);
      });
      setTimeout(() => inputRef.current?.focus(), 50);
    } else {
      // 关闭后焦点回到触发元素，符合 WAI-ARIA 对话框最佳实践
      triggerRef.current?.focus?.();
    }
  }, [clearSearch, open]);

  const handleSelect = (result: SearchResult) => {
    onConversationSelect?.(result.characterId, result.conversationId, result.messageId);
    onClose();
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') { onClose(); return; }
    if (e.key === 'ArrowDown') { e.preventDefault(); setActiveIndex(i => Math.min(i + 1, results.length - 1)); }
    if (e.key === 'ArrowUp') { e.preventDefault(); setActiveIndex(i => Math.max(i - 1, 0)); }
    if (e.key === 'Enter' && results[safeActiveIndex]) { handleSelect(results[safeActiveIndex]); }
  };

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-[70] flex items-start justify-center bg-black/35 px-4 pt-[12vh] backdrop-blur-sm"
      onClick={onClose}
      // role="dialog" + aria-modal 让屏幕阅读器把这块视为模态对话框，
      // 阅读时会暂停背景 DOM 的朗读，专注于搜索界面
      role="dialog"
      aria-modal="true"
      aria-label={t('search.placeholder') || '搜索'}
    >
      <div
        className="surface-panel w-full max-w-xl overflow-hidden"
        onClick={e => e.stopPropagation()}
        onKeyDown={handleKeyDown}
      >
        {/* 搜索输入框 */}
        <div className="flex items-center gap-3 border-b border-border-light px-4 py-3">
          <SearchIcon className="h-4 w-4 shrink-0 text-text-muted" />
          <input
            ref={inputRef}
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder={t('search.placeholder')}
            className="flex-1 bg-transparent text-sm text-text-primary outline-none placeholder:text-text-muted"
          />
          <kbd className="hidden rounded border border-border-light px-1.5 py-0.5 text-[10px] text-text-muted sm:block">Esc</kbd>
        </div>

        {/* 结果列表 */}
        <div className="max-h-[50vh] overflow-y-auto">
          {loading && (
            <div className="px-4 py-6 text-center text-sm text-text-muted">{t('common.loading')}</div>
          )}
          {!loading && query && results.length === 0 && (
            <div className="px-4 py-6 text-center text-sm text-text-muted">{t('search.noResults')}</div>
          )}
          {!loading && !query && (
            <div className="px-4 py-6 text-center text-sm text-text-muted">{t('search.hint')}</div>
          )}

          {results.map((result, i) => (
            <button
              key={result.id}
              onClick={() => handleSelect(result)}
              className={`flex w-full flex-col gap-1 border-b border-border-light px-4 py-3 text-left last:border-0 transition-colors ${
                i === safeActiveIndex ? 'bg-accent/8' : 'hover:bg-warm-50'
              }`}
            >
              {/* 角色名 · 对话标题 */}
              <div className="flex items-center gap-1.5 text-[11px] text-text-muted">
                <ClockIcon className="h-3 w-3 shrink-0" />
                <span className="truncate font-medium text-accent-dark">{result.subtitle?.split(' · ')[0]}</span>
                <span className="shrink-0">·</span>
                <span className="truncate">{result.subtitle?.split(' · ')[1]}</span>
              </div>
              {/* 消息片段 */}
              <p className="line-clamp-2 text-xs leading-relaxed text-text-primary">{result.title}</p>
            </button>
          ))}
          {!loading && hasMore && (
            <button
              type="button"
              onClick={loadMore}
              disabled={loadingMore}
              className="w-full px-4 py-3 text-center text-xs font-medium text-accent-dark transition-colors hover:bg-warm-50 disabled:cursor-not-allowed disabled:text-text-muted"
            >
              {loadingMore ? t('common.loading') : t('search.loadMore')}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
