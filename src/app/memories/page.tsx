'use client';

import { useState, useEffect, useSyncExternalStore } from 'react';
import { Character } from '@/types';
import MemoryList from '@/components/memories/MemoryList';
import WorksCatalogPanel from '@/components/memories/WorksCatalogPanel';
import Link from 'next/link';
import { useTranslation } from '@/lib/i18n-context';
import { getErrorMessage, parseJsonArrayResponse } from '@/lib/http';
import { useToast } from '@/components/ui/Toast';
import { ArrowLeftIcon, MemoryIcon } from '@/components/ui/icons';
import ContentState from '@/components/ui/ContentState';

type MemoriesView = 'memories' | 'works';
const VIEW_CHANGE_EVENT = 'lumimuse:memories-view';

// 视图记在 URL 的 view 参数里（view=works），刷新后仍停在片单。
// 用 history API 而不是 next/navigation：useSearchParams 要求整页包一层 Suspense，这里没必要。
function subscribeView(onChange: () => void): () => void {
  window.addEventListener('popstate', onChange);
  window.addEventListener(VIEW_CHANGE_EVENT, onChange);
  return () => {
    window.removeEventListener('popstate', onChange);
    window.removeEventListener(VIEW_CHANGE_EVENT, onChange);
  };
}

function readView(): MemoriesView {
  return new URLSearchParams(window.location.search).get('view') === 'works' ? 'works' : 'memories';
}

function readServerView(): MemoriesView {
  return 'memories';
}

function writeView(view: MemoriesView): void {
  const url = new URL(window.location.href);
  if (view === 'works') url.searchParams.set('view', 'works');
  else url.searchParams.delete('view');
  window.history.replaceState(window.history.state, '', url);
  window.dispatchEvent(new Event(VIEW_CHANGE_EVENT));
}

export default function MemoriesPage() {
  const [characters, setCharacters] = useState<Character[]>([]);
  const [charactersLoading, setCharactersLoading] = useState(true);
  const [charactersLoadError, setCharactersLoadError] = useState('');
  const [selectedCharId, setSelectedCharId] = useState<string | null>(null);
  const view = useSyncExternalStore(subscribeView, readView, readServerView);
  const { t } = useTranslation();
  const { showToast } = useToast();

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const chars = await parseJsonArrayResponse<Character>(await fetch('/api/characters'));
        if (cancelled) return;
        setCharacters(chars);
        setCharactersLoadError('');
        if (chars.length > 0) {
          setSelectedCharId(chars[0].id);
        }
      } catch (error) {
        if (!cancelled) {
          setCharactersLoadError(t('common.loadFailed'));
          showToast(`${t('common.loadFailed')}: ${getErrorMessage(error)}`, 'error');
        }
      } finally {
        if (!cancelled) setCharactersLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [showToast, t]);

  return (
    <div className="app-shell min-h-dvh px-4 py-4">
      <div className="mx-auto flex max-w-7xl flex-col gap-4">
        <header className="border-b border-border-light pb-4">
          <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
            <div className="flex items-center gap-4">
              <Link href="/" className="soft-button soft-button-secondary px-3 py-2">
                <ArrowLeftIcon className="h-4 w-4" />
                {t('memories.back')}
              </Link>
              <h1 className="section-title text-xl">{t('memories.title')}</h1>
            </div>

            <div className="flex flex-wrap items-center gap-3">
              <span className="chip">{characters.length} {t('sidebar.characters')}</span>
              <select
                value={selectedCharId || ''}
                onChange={e => setSelectedCharId(e.target.value || null)}
                className="select-rich min-w-56"
              >
                {characters.map(character => (
                  <option key={character.id} value={character.id}>{character.name}</option>
                ))}
              </select>
              <div role="group" aria-label={t('works.viewLabel')} className="flex gap-1.5">
                <button
                  type="button"
                  aria-pressed={view === 'memories'}
                  onClick={() => writeView('memories')}
                  className={`chip min-h-11 cursor-pointer px-4 text-sm ${view === 'memories' ? 'chip-active font-medium' : 'hover:text-text-primary'}`}
                >
                  {t('works.viewMemories')}
                </button>
                <button
                  type="button"
                  aria-pressed={view === 'works'}
                  onClick={() => writeView('works')}
                  className={`chip min-h-11 cursor-pointer px-4 text-sm ${view === 'works' ? 'chip-active font-medium' : 'hover:text-text-primary'}`}
                >
                  {t('works.viewWorks')}
                </button>
              </div>
            </div>
          </div>

        </header>

        <main className="min-h-0" aria-busy={charactersLoading}>
          {charactersLoading ? (
            <div className="surface-panel"><ContentState mode="loading" title={t('common.loading')} /></div>
          ) : charactersLoadError ? (
            <div className="surface-panel"><ContentState mode="error" title={charactersLoadError} /></div>
          ) : selectedCharId ? (
            view === 'works' ? (
              <WorksCatalogPanel
                characterId={selectedCharId}
                characterName={characters.find(character => character.id === selectedCharId)?.name ?? ''}
              />
            ) : (
              <MemoryList characterId={selectedCharId} />
            )
          ) : (
            <div className="surface-panel">
              <ContentState mode="empty" title={t('memories.noCharacter')} icon={<MemoryIcon className="h-5 w-5" />} />
            </div>
          )}
        </main>
      </div>
    </div>
  );
}
