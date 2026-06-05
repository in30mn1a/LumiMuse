'use client';

import { useRef, useState } from 'react';
import Link from 'next/link';
import CharacterList from './CharacterList';
import { useTranslation } from '@/lib/i18n-context';
import { MemoryIcon, SearchIcon, SettingsIcon, SparkIcon, ClockIcon } from '@/components/ui/icons';
import { useMessageSearch, type MessageSearchResult } from '@/hooks/use-message-search';
import type { Character } from '@/types';

type SearchResult = MessageSearchResult;

interface Props {
  selectedCharacterId: string | null;
  onCharacterSelect: (id: string, character: Character) => void;
  onConversationSelect?: (characterId: string, conversationId: string, messageId: string) => void;
  onSearchOpen?: () => void;
}

export default function Sidebar({ selectedCharacterId, onCharacterSelect, onConversationSelect }: Props) {
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
    onConversationSelect?.(result.characterId, result.conversationId, result.messageId);
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

  return (
    <aside className="surface-panel flex h-[calc(100dvh-2rem)] w-[72vw] flex-col overflow-hidden md:w-[21rem]">
      <div className="border-b border-border-light p-4">
        <div className="surface-hero p-4">
          <div className="flex items-center gap-3">
            <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-[1.1rem] bg-gradient-to-br from-accent to-accent-dark text-white shadow-sm">
              <SparkIcon className="h-5 w-5" />
            </div>
            <h1 className="text-[1.5rem] font-semibold tracking-tight text-text-primary" style={{ fontFamily: 'var(--font-display)' }}>
              LumiMuse
            </h1>
          </div>
        </div>
      </div>

      {/* 对话内容搜索框 */}
      <div className="relative border-b border-border-light px-4 py-3">
        <div className={`flex items-center gap-2 rounded-2xl border bg-white/60 px-3 py-2 text-sm transition-all dark:bg-white/5 ${
          focused ? 'border-accent/30 bg-white shadow-sm dark:bg-white/10' : 'border-border-light hover:border-accent/20 hover:bg-white dark:hover:bg-white/10'
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
          <div className="absolute left-4 right-4 top-full z-50 mt-1 overflow-hidden rounded-2xl border border-border-light bg-white shadow-lg dark:bg-[rgba(33,26,48,0.96)]">
            {loading && (
              <div className="px-4 py-3 text-center text-xs text-text-muted">{t('common.loading')}</div>
            )}
            {!loading && results.length === 0 && (
              <div className="px-4 py-3 text-center text-xs text-text-muted">{t('search.noResults')}</div>
            )}
            {!loading && results.length > 0 && (
              <div className="max-h-[60vh] overflow-y-auto">
                {results.map(r => (
                  <button
                    key={r.messageId}
                    onMouseDown={e => e.preventDefault()}
                    onClick={() => handleSelect(r)}
                    className="flex w-full flex-col gap-1 border-b border-border-light px-4 py-3 text-left last:border-0 hover:bg-accent/5 transition-colors"
                  >
                    {/* 对话标题 + 角色名 */}
                    <div className="flex items-center gap-1.5 text-[11px] text-text-muted">
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
        <CharacterList selectedId={selectedCharacterId} onSelect={onCharacterSelect} />
      </div>

      <div className="border-t border-border-light p-4">
        <div className="grid gap-2">
          <Link
            href="/memories"
            className="flex items-center gap-3 rounded-2xl border border-transparent bg-white/70 px-4 py-3 text-sm text-text-secondary transition-all duration-200 hover:border-border-light hover:bg-white hover:text-text-primary dark:bg-white/5 dark:hover:bg-white/10"
          >
            <MemoryIcon className="h-4 w-4 shrink-0 text-accent-dark" />
            <span className="flex-1">{t('sidebar.memories')}</span>
          </Link>
          <Link
            href="/settings"
            className="flex items-center gap-3 rounded-2xl border border-transparent bg-white/70 px-4 py-3 text-sm text-text-secondary transition-all duration-200 hover:border-border-light hover:bg-white hover:text-text-primary dark:bg-white/5 dark:hover:bg-white/10"
          >
            <SettingsIcon className="h-4 w-4 shrink-0 text-accent-dark" />
            <span className="flex-1">{t('sidebar.settings')}</span>
          </Link>
        </div>
      </div>
    </aside>
  );
}
