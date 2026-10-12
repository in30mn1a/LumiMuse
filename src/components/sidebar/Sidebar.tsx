'use client';

import { useRef, useState } from 'react';
import Link from 'next/link';
import CharacterList, { type SidebarChat } from './CharacterList';
import { useTranslation } from '@/lib/i18n-context';
import { MemoryIcon, SearchIcon, SettingsIcon, SparkIcon, ClockIcon } from '@/components/ui/icons';
import { useMessageSearch, type MessageSearchResult } from '@/hooks/use-message-search';
import type { TextHighlightRange } from '@/lib/text-highlight';
import type { Character } from '@/types';

type SearchResult = MessageSearchResult;

interface Props {
  selectedCharacterId: string | null;
  onCharacterSelect: (id: string, character: Character) => void;
  onConversationSelect?: (characterId: string, conversationId: string, messageId: string, highlightRanges?: readonly TextHighlightRange[]) => void;
  chat?: SidebarChat | null;
}

export default function Sidebar({ selectedCharacterId, onCharacterSelect, onConversationSelect, chat }: Props) {
  const { t } = useTranslation();
  const [query, setQuery] = useState('');
  const [focused, setFocused] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const { results, loading, loadingMore, hasMore, loadMore, clearSearch } = useMessageSearch(query, { limit: 30, debounceMs: 250 });

  const scrollSearchInputToEnd = (input: HTMLInputElement, value: string) => {
    requestAnimationFrame(() => {
      input.setSelectionRange(value.length, value.length);
      input.scrollLeft = input.scrollWidth;
    });
  };

  const handleQueryChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const value = e.target.value;
    setQuery(value);
    scrollSearchInputToEnd(e.target, value);
  };

  const handleQueryFocus = () => {
    setFocused(true);
    if (inputRef.current) {
      scrollSearchInputToEnd(inputRef.current, query);
    }
  };

  const handleSelect = (result: SearchResult) => {
    onConversationSelect?.(result.characterId, result.conversationId, result.messageId, result.highlightRanges);
    setQuery('');
    clearSearch();
    inputRef.current?.blur();
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Escape') {
      setQuery('');
      clearSearch();
      inputRef.current?.blur();
    }
  };

  const showPanel = focused && (query.trim().length > 0);

  // 贴边的平面侧栏，高度跟父级 h-full，避免再写 100dvh 与主栏 100vh 错位；
  // 宽度：抽屉 80vw；lg 起常驻 18rem
  return (
    <aside className="flex h-full min-h-0 w-[80vw] max-w-[20rem] flex-col overflow-hidden overscroll-contain border-r border-border-light bg-surface lg:w-[18rem]">
      <div className="flex items-center gap-2.5 px-5 pb-2 pt-4">
        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-accent-solid text-white">
          <SparkIcon className="h-4 w-4" />
        </div>
        <h1 className="text-lg font-semibold tracking-tight text-text-primary" style={{ fontFamily: 'var(--font-display)' }}>
          LumiMuse
        </h1>
      </div>

      {/* 对话内容搜索框 */}
      <div className="relative px-3 pb-3 pt-1">
        <div className={`flex min-h-10 items-center gap-2 rounded-xl border px-3 text-sm transition-colors ${
          focused ? 'border-accent/40 bg-surface' : 'border-transparent bg-surface-2'
        }`}>
          <SearchIcon className="h-3.5 w-3.5 shrink-0 text-text-muted" />
          <input
            ref={inputRef}
            value={query}
            onChange={handleQueryChange}
            onFocus={handleQueryFocus}
            onBlur={() => setTimeout(() => setFocused(false), 150)}
            onKeyDown={handleKeyDown}
            placeholder={t('search.placeholder')}
            className="flex-1 bg-transparent text-sm text-text-primary outline-none placeholder:text-text-muted"
          />
          {query && (
            <button
              onMouseDown={e => e.preventDefault()}
              onClick={() => { setQuery(''); clearSearch(); }}
              className="text-text-muted hover:text-text-secondary"
            >
              ×
            </button>
          )}
        </div>

        {/* 搜索结果下拉面板 */}
        {showPanel && (
          <div className="absolute left-3 right-3 top-full z-50 -mt-2 overflow-hidden rounded-2xl border border-border-light bg-surface shadow-lg">
            {loading && (
              <div className="px-4 py-3 text-center text-xs text-text-muted">{t('common.loading')}</div>
            )}
            {!loading && results.length === 0 && (
              <div className="px-4 py-3 text-center text-xs text-text-muted">{t('search.noResults')}</div>
            )}
            {!loading && results.length > 0 && (
              <div data-sidebar-scroll className="max-h-[60vh] overflow-y-auto overscroll-contain">
                {results.map(r => (
                  <button
                    key={r.messageId}
                    onMouseDown={e => e.preventDefault()}
                    onClick={() => handleSelect(r)}
                    className="flex w-full flex-col gap-1 border-b border-border-light px-4 py-3 text-left last:border-0 hover:bg-accent/5 transition-colors"
                  >
                    {/* 对话标题 + 角色名 */}
                    <div className="flex items-center gap-1.5 text-xs text-text-muted">
                      <ClockIcon className="h-3 w-3 shrink-0" />
                      <span className="truncate font-medium text-accent-dark">{r.characterName}</span>
                      <span className="shrink-0">·</span>
                      <span className="truncate">{r.conversationTitle}</span>
                    </div>
                    {/* 消息片段 */}
                    <p className="line-clamp-2 text-xs leading-relaxed text-text-primary">
                      <span className="mr-1 text-text-muted">{r.role === 'user' ? t('search.youPrefix') : `${r.characterName}：`}</span>
                      {r.snippet}
                    </p>
                  </button>
                ))}
                {hasMore && (
                  <button
                    type="button"
                    onMouseDown={e => e.preventDefault()}
                    onClick={loadMore}
                    disabled={loadingMore}
                    className="w-full px-4 py-3 text-center text-xs font-medium text-accent-dark transition-colors hover:bg-accent/5 disabled:cursor-not-allowed disabled:text-text-muted"
                  >
                    {loadingMore ? t('common.loading') : t('search.loadMore')}
                  </button>
                )}
              </div>
            )}
          </div>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-hidden pt-1">
        <CharacterList selectedId={selectedCharacterId} onSelect={onCharacterSelect} chat={chat} />
      </div>

      <div className="border-t border-border-light p-2 pb-[max(0.5rem,env(safe-area-inset-bottom))]">
        <div className="grid gap-0.5">
          <Link
            href="/memories"
            className="flex min-h-11 items-center gap-3 rounded-xl px-3 text-sm text-text-secondary transition-colors hover:bg-surface-2 hover:text-text-primary"
          >
            <MemoryIcon className="h-4 w-4 shrink-0 text-accent-dark" />
            <span className="flex-1">{t('sidebar.memories')}</span>
          </Link>
          <Link
            href="/settings"
            className="flex min-h-11 items-center gap-3 rounded-xl px-3 text-sm text-text-secondary transition-colors hover:bg-surface-2 hover:text-text-primary"
          >
            <SettingsIcon className="h-4 w-4 shrink-0 text-accent-dark" />
            <span className="flex-1">{t('sidebar.settings')}</span>
          </Link>
        </div>
      </div>
    </aside>
  );
}
