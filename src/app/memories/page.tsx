'use client';

import { useState, useEffect } from 'react';
import { Character } from '@/types';
import MemoryList from '@/components/memories/MemoryList';
import Link from 'next/link';
import { useTranslation } from '@/lib/i18n-context';
import { getErrorMessage, parseJsonArrayResponse } from '@/lib/http';
import { useToast } from '@/components/ui/Toast';
import { ArrowLeftIcon, MemoryIcon } from '@/components/ui/icons';
import ContentState from '@/components/ui/ContentState';

export default function MemoriesPage() {
  const [characters, setCharacters] = useState<Character[]>([]);
  const [charactersLoading, setCharactersLoading] = useState(true);
  const [charactersLoadError, setCharactersLoadError] = useState('');
  const [selectedCharId, setSelectedCharId] = useState<string | null>(null);
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
            </div>
          </div>

        </header>

        <main className="min-h-0" aria-busy={charactersLoading}>
          {charactersLoading ? (
            <div className="surface-panel"><ContentState mode="loading" title={t('common.loading')} /></div>
          ) : charactersLoadError ? (
            <div className="surface-panel"><ContentState mode="error" title={charactersLoadError} /></div>
          ) : selectedCharId ? (
            <MemoryList characterId={selectedCharId} />
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
