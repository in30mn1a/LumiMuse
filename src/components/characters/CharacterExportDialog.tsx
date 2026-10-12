'use client';

import { useState } from 'react';
import Modal from '@/components/ui/Modal';
import { useTranslation } from '@/lib/i18n-context';

export function CharacterExportDialog({
  characterId,
  onClose,
}: {
  characterId: string;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [includeCharacter, setIncludeCharacter] = useState(true);
  const [includeMemories, setIncludeMemories] = useState(true);
  const [includeConversations, setIncludeConversations] = useState(true);
  const [includeProfiles, setIncludeProfiles] = useState(true);
  const [includeEmbeddings, setIncludeEmbeddings] = useState(false);

  const handleExport = () => {
    const params = new URLSearchParams({ type: 'character', id: characterId });
    if (!includeCharacter) params.set('include_characters', '0');
    if (!includeMemories) params.set('include_memories', '0');
    if (!includeConversations) params.set('include_conversations', '0');
    if (!includeProfiles) params.set('include_profiles', '0');
    if (includeEmbeddings) params.set('include_embeddings', '1');
    const a = document.createElement('a');
    a.href = '/api/export?' + params.toString();
    a.download = '';
    a.click();
    onClose();
  };

  const nothingSelected =
    !includeCharacter &&
    !includeMemories &&
    !includeConversations &&
    !includeProfiles &&
    !includeEmbeddings;

  return (
    <Modal open onClose={onClose} title={t('export.characterTitle')} maxWidth="max-w-sm">
      <p className="mb-4 text-sm text-text-muted">{t('export.characterHint')}</p>
      <div className="space-y-2">
        <label className="flex cursor-pointer items-center gap-3 rounded-2xl border border-border-light bg-surface/70 px-4 py-3 text-sm text-text-secondary">
          <input type="checkbox" checked={includeCharacter} onChange={e => setIncludeCharacter(e.target.checked)} />
          {t('export.includeCharacters')}
        </label>
        <label className="flex cursor-pointer items-center gap-3 rounded-2xl border border-border-light bg-surface/70 px-4 py-3 text-sm text-text-secondary">
          <input type="checkbox" checked={includeMemories} onChange={e => setIncludeMemories(e.target.checked)} />
          {t('export.includeMemories')}
        </label>
        <label className="flex cursor-pointer items-center gap-3 rounded-2xl border border-border-light bg-surface/70 px-4 py-3 text-sm text-text-secondary">
          <input type="checkbox" checked={includeConversations} onChange={e => setIncludeConversations(e.target.checked)} />
          {t('export.includeConversations')}
        </label>
        <label className="flex cursor-pointer items-center gap-3 rounded-2xl border border-border-light bg-surface/70 px-4 py-3 text-sm text-text-secondary">
          <input type="checkbox" checked={includeProfiles} onChange={e => setIncludeProfiles(e.target.checked)} />
          {t('export.includeProfiles')}
        </label>
        <label className={`flex items-center gap-3 rounded-2xl border border-border-light bg-surface/70 px-4 py-3 text-sm ${includeMemories ? 'cursor-pointer text-text-secondary' : 'cursor-not-allowed opacity-50'}`}>
          <input
            type="checkbox"
            checked={includeMemories && includeEmbeddings}
            disabled={!includeMemories}
            onChange={e => setIncludeEmbeddings(e.target.checked)}
          />
          {t('export.includeEmbeddings')}
        </label>
      </div>
      <div className="mt-5 flex justify-end gap-2">
        <button onClick={onClose} className="soft-button soft-button-secondary px-4 py-2 text-sm">{t('common.cancel')}</button>
        <button
          onClick={handleExport}
          disabled={nothingSelected}
          className="soft-button soft-button-primary px-4 py-2 text-sm disabled:cursor-not-allowed disabled:opacity-50"
        >
          {t('export.download')}
        </button>
      </div>
    </Modal>
  );
}
