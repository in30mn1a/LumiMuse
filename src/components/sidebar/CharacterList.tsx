'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Character } from '@/types';
import { useTranslation } from '@/lib/i18n-context';
import { PencilIcon, PlusIcon, SparkIcon } from '@/components/ui/icons';

interface Props {
  selectedId: string | null;
  onSelect: (id: string) => void;
}

export default function CharacterList({ selectedId, onSelect }: Props) {
  const router = useRouter();
  const [characters, setCharacters] = useState<Character[]>([]);
  const { t } = useTranslation();

  useEffect(() => {
    fetch('/api/characters').then(r => r.json()).then(setCharacters);
  }, []);

  const handleCreate = async () => {
    const response = await fetch('/api/characters', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: t('char.newCharacterName') }),
    });
    const newCharacter = await response.json();
    setCharacters(prev => [newCharacter, ...prev]);
    onSelect(newCharacter.id);
    router.push(`/characters/${newCharacter.id}`);
  };

  return (
    <div className="flex h-full flex-col">
      <div className="px-4 pb-4">
        <button onClick={handleCreate} className="soft-button soft-button-primary w-full justify-center">
          <PlusIcon className="h-4 w-4" />
          {t('sidebar.create')}
        </button>
      </div>

      <div className="min-h-0 flex-1 space-y-2 overflow-y-auto px-3 pb-4">
        {characters.length === 0 && (
          <div className="surface-panel-quiet mx-1 px-4 py-8 text-center">
            <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-2xl bg-white/80 text-accent-dark shadow-sm">
              <SparkIcon className="h-5 w-5" />
            </div>
            <p className="text-sm font-medium text-text-primary">{t('sidebar.empty')}</p>
          </div>
        )}

        {characters.map(character => {
          return (
            <button
              key={character.id}
              onClick={() => onSelect(character.id)}
              className={`group flex w-full items-center gap-3 rounded-[1.25rem] border px-3 py-3 text-left transition-all duration-200 ${
                selectedId === character.id
                  ? 'border-accent/26 bg-[rgba(155,124,240,0.10)] shadow-sm'
                  : 'border-transparent bg-white/48 hover:border-border-light hover:bg-white/78'
              }`}
            >
              <div
                className={`flex h-11 w-11 shrink-0 items-center justify-center overflow-hidden rounded-2xl ring-1 transition-all duration-200 ${
                  selectedId === character.id
                    ? 'bg-gradient-to-br from-accent to-accent-dark text-white ring-accent/20'
                    : 'bg-warm-100 text-text-secondary ring-border-light'
                }`}
              >
                {character.avatar_url ? (
                  <img src={character.avatar_url} alt={character.name} className="h-full w-full object-cover" loading="lazy" />
                ) : (
                  <span className="text-sm font-semibold">{character.name[0]}</span>
                )}
              </div>

              <div className="min-w-0 flex-1">
                <span className="truncate text-sm font-medium text-text-primary">{character.name}</span>
              </div>

              <Link
                href={`/characters/${character.id}`}
                onClick={e => e.stopPropagation()}
                className="rounded-full p-2 text-text-muted transition-all duration-200 hover:bg-warm-100 hover:text-accent opacity-60 md:opacity-0 md:group-hover:opacity-100"
                aria-label={t('char.edit')}
              >
                <PencilIcon className="h-4 w-4" />
              </Link>
            </button>
          );
        })}
      </div>
    </div>
  );
}
