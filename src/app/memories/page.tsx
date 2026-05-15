'use client';

import { useState, useEffect } from 'react';
import { Character } from '@/types';
import MemoryList from '@/components/memories/MemoryList';
import Link from 'next/link';
import { useTranslation } from '@/lib/i18n-context';
import { ArrowLeftIcon, MemoryIcon } from '@/components/ui/icons';

export default function MemoriesPage() {
  const [characters, setCharacters] = useState<Character[]>([]);
  const [selectedCharId, setSelectedCharId] = useState<string | null>(null);
  const { t } = useTranslation();

  useEffect(() => {
    fetch('/api/characters').then(r => r.json()).then((chars: Character[]) => {
      setCharacters(chars);
      if (chars.length > 0) setSelectedCharId(chars[0].id);
    });
  }, []);

  return (
    <div className="app-shell min-h-screen px-4 py-4">
      <div className="mx-auto flex max-w-7xl flex-col gap-4">
        <header className="surface-hero px-5 py-5">
          <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
            <div className="flex items-center gap-4">
              <Link href="/" className="soft-button soft-button-secondary px-3 py-2">
                <ArrowLeftIcon className="h-4 w-4" />
                {t('memories.back')}
              </Link>
              <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-[rgba(155,124,240,0.12)] text-accent-dark">
                <MemoryIcon className="h-5 w-5" />
              </div>
              <div>
                <h1 className="section-title text-2xl">{t('memories.title')}</h1>
              </div>
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

        <main className="min-h-0">
          {selectedCharId ? (
            <MemoryList characterId={selectedCharId} />
          ) : (
            <div className="surface-panel px-6 py-20 text-center">
              <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-[1.4rem] bg-[rgba(155,124,240,0.12)] text-accent-dark">
                <MemoryIcon className="h-6 w-6" />
              </div>
              <p className="text-sm font-medium text-text-primary">{t('memories.noCharacter')}</p>
            </div>
          )}
        </main>
      </div>
    </div>
  );
}
