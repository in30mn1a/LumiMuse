'use client';

import { useState, useEffect, use, useRef, useMemo, type ChangeEvent } from 'react';
import { Character } from '@/types';
import { normalizeCharacterCard } from '@/lib/character-card-import';
import { useRouter } from 'next/navigation';
import { useTranslation } from '@/lib/i18n-context';
import { ArrowLeftIcon, CameraIcon, PencilIcon, SparkIcon, TrashIcon } from '@/components/ui/icons';

interface Props {
  params: Promise<{ id: string }>;
}

function previewLine(text: string, fallback: string): string {
  return text.trim() || fallback;
}

function previewText(text: string, fallback: string, maxLength = 90): string {
  const value = previewLine(text, fallback).replace(/\s+/g, ' ').trim();
  return value.length > maxLength ? `${value.slice(0, maxLength)}...` : value;
}

function ExportDialog({ characterId, onClose }: { characterId: string; onClose: () => void }) {
  const { t } = useTranslation();
  const [includeCharacter, setIncludeCharacter] = useState(true);
  const [includeMemories, setIncludeMemories] = useState(true);
  const [includeConversations, setIncludeConversations] = useState(true);

  const handleExport = () => {
    const params = new URLSearchParams({ type: 'character', id: characterId });
    if (!includeCharacter) params.set('include_characters', '0');
    if (!includeMemories) params.set('include_memories', '0');
    if (!includeConversations) params.set('include_conversations', '0');
    const a = document.createElement('a');
    a.href = '/api/export?' + params.toString();
    a.download = '';
    a.click();
    onClose();
  };

  const nothingSelected = !includeCharacter && !includeMemories && !includeConversations;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center px-4">
      <div className="absolute inset-0 bg-black/35 backdrop-blur-sm" onClick={onClose} />
      <div className="surface-hero relative z-10 w-full max-w-sm px-6 py-6">
        <h2 className="section-title mb-1 text-lg">{t('export.characterTitle')}</h2>
        <p className="mb-5 text-sm text-text-muted">{t('export.characterHint')}</p>
        <div className="space-y-2">
          <label className="flex cursor-pointer items-center gap-3 rounded-2xl border border-border-light bg-white/70 px-4 py-3 text-sm text-text-secondary">
            <input type="checkbox" checked={includeCharacter} onChange={e => setIncludeCharacter(e.target.checked)} />
            {t('export.includeCharacters')}
          </label>
          <label className="flex cursor-pointer items-center gap-3 rounded-2xl border border-border-light bg-white/70 px-4 py-3 text-sm text-text-secondary">
            <input type="checkbox" checked={includeMemories} onChange={e => setIncludeMemories(e.target.checked)} />
            {t('export.includeMemories')}
          </label>
          <label className="flex cursor-pointer items-center gap-3 rounded-2xl border border-border-light bg-white/70 px-4 py-3 text-sm text-text-secondary">
            <input type="checkbox" checked={includeConversations} onChange={e => setIncludeConversations(e.target.checked)} />
            {t('export.includeConversations')}
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
      </div>
    </div>
  );
}
function ImportDialog({
  fileName,
  onCancel,
  onConfirm,
}: {
  fileName: string;
  onCancel: () => void;
  onConfirm: (options: { includeCharacter: boolean; includeMemories: boolean; includeConversations: boolean }) => void;
}) {
  const { t } = useTranslation();
  const [includeCharacter, setIncludeCharacter] = useState(true);
  const [includeMemories, setIncludeMemories] = useState(true);
  const [includeConversations, setIncludeConversations] = useState(true);
  const nothingSelected = !includeCharacter && !includeMemories && !includeConversations;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center px-4">
      <div className="absolute inset-0 bg-black/35 backdrop-blur-sm" onClick={onCancel} />
      <div className="surface-hero relative z-10 w-full max-w-sm px-6 py-6">
        <h2 className="section-title mb-1 text-lg">{t('import.characterTitle')}</h2>
        <p className="mb-3 text-sm text-text-muted">{t('import.characterHint')}</p>
        <p className="mb-5 truncate rounded-2xl border border-border-light bg-white/70 px-4 py-3 text-xs text-text-muted">{fileName}</p>
        <div className="space-y-2">
          <label className="flex cursor-pointer items-center gap-3 rounded-2xl border border-border-light bg-white/70 px-4 py-3 text-sm text-text-secondary">
            <input type="checkbox" checked={includeCharacter} onChange={e => setIncludeCharacter(e.target.checked)} />
            {t('export.includeCharacters')}
          </label>
          <label className="flex cursor-pointer items-center gap-3 rounded-2xl border border-border-light bg-white/70 px-4 py-3 text-sm text-text-secondary">
            <input type="checkbox" checked={includeMemories} onChange={e => setIncludeMemories(e.target.checked)} />
            {t('export.includeMemories')}
          </label>
          <label className="flex cursor-pointer items-center gap-3 rounded-2xl border border-border-light bg-white/70 px-4 py-3 text-sm text-text-secondary">
            <input type="checkbox" checked={includeConversations} onChange={e => setIncludeConversations(e.target.checked)} />
            {t('export.includeConversations')}
          </label>
        </div>
        <div className="mt-5 flex justify-end gap-2">
          <button onClick={onCancel} className="soft-button soft-button-secondary px-4 py-2 text-sm">{t('common.cancel')}</button>
          <button
            onClick={() => onConfirm({ includeCharacter, includeMemories, includeConversations })}
            disabled={nothingSelected}
            className="soft-button soft-button-primary px-4 py-2 text-sm disabled:cursor-not-allowed disabled:opacity-50"
          >
            {t('import.apply')}
          </button>
        </div>
      </div>
    </div>
  );
}


export default function CharacterEditor({ params }: Props) {
  const { id } = use(params);
  const router = useRouter();
  const [character, setCharacter] = useState<Character | null>(null);
  const [saving, setSaving] = useState(false);
  const [duplicating, setDuplicating] = useState(false);
  const [showAiGenerator, setShowAiGenerator] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const [aiRequirement, setAiRequirement] = useState('');
  const [aiGenerating, setAiGenerating] = useState(false);
  const [aiError, setAiError] = useState('');
  const [importMsg, setImportMsg] = useState<{ type: 'ok' | 'err'; text: string } | null>(null);
  const [pendingImport, setPendingImport] = useState<{ fileName: string; payload: Record<string, unknown> } | null>(null);
  const characterImportRef = useRef<HTMLInputElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const { t } = useTranslation();

  useEffect(() => {
    fetch(`/api/characters/${id}`).then(r => r.json()).then(setCharacter);
  }, [id]);

  const previewMessages = useMemo(() => {
    if (!character) return [];
    return [
      {
        role: 'user',
        content: '我今天有点累，想听你慢慢说话。',
      },
      {
        role: 'assistant',
        content: previewText(character.greeting, '我会在这里陪着你。', 96),
      },
    ];
  }, [character]);

  const returnToSidebar = () => {
    sessionStorage.setItem('lumimuse_open_sidebar', '1');
    router.push('/');
  };

  const handleSave = async () => {
    if (!character) return;
    setSaving(true);
    await fetch(`/api/characters/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(character),
    });
    setSaving(false);
    returnToSidebar();
  };

  const handleDelete = async () => {
    if (!confirm(t('editor.deleteConfirm'))) return;
    await fetch(`/api/characters/${id}`, { method: 'DELETE' });
    router.push('/');
  };

  const handleDuplicate = async () => {
    if (!confirm(t('editor.duplicateConfirm'))) return;
    setDuplicating(true);
    try {
      const response = await fetch(`/api/characters/${id}/duplicate`, { method: 'POST' });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || t('editor.duplicateError'));
      router.push(`/characters/${data.id}`);
    } catch (err) {
      alert(err instanceof Error ? err.message : t('editor.duplicateError'));
    } finally {
      setDuplicating(false);
    }
  };

  const handleAvatarUpload = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file || !character) return;
    const formData = new FormData();
    formData.append('avatar', file);
    const response = await fetch('/api/upload', { method: 'POST', body: formData });
    if (response.ok) {
      const { url } = await response.json();
      setCharacter({ ...character, avatar_url: url });
    }
  };

  const handleImportCharacterCard = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file || !character) return;

    try {
      const json = JSON.parse(await file.text()) as Record<string, unknown>;
      if (json.character || json.memories || json.conversations) {
        setPendingImport({ fileName: file.name, payload: json });
        return;
      }

      const draft = normalizeCharacterCard(json);
      if (!draft) throw new Error(t('editor.importError'));
      setCharacter({ ...character, ...draft });
      setImportMsg({ type: 'ok', text: t('editor.importDraftSuccess') });
    } catch {
      setImportMsg({ type: 'err', text: t('editor.importError') });
    } finally {
      if (characterImportRef.current) characterImportRef.current.value = '';
      setTimeout(() => setImportMsg(null), 5000);
    }
  };

  const applyPendingImport = async (options: { includeCharacter: boolean; includeMemories: boolean; includeConversations: boolean }) => {
    if (!pendingImport || !character) return;
    const sourceCharacter = (pendingImport.payload.character && typeof pendingImport.payload.character === 'object')
      ? pendingImport.payload.character as Record<string, unknown>
      : {};
    const draft = normalizeCharacterCard({ character: sourceCharacter });

    if (options.includeCharacter && draft) {
      setCharacter({ ...character, ...draft });
    }

    const conversations = options.includeConversations && Array.isArray(pendingImport.payload.conversations)
      ? pendingImport.payload.conversations.map(item => ({ ...(item as Record<string, unknown>), character_id: character.id }))
      : [];
    const memories = options.includeMemories && Array.isArray(pendingImport.payload.memories)
      ? pendingImport.payload.memories.map(item => ({ ...(item as Record<string, unknown>), character_id: character.id }))
      : [];

    if (memories.length === 0 && conversations.length === 0) {
      setImportMsg({ type: 'ok', text: t('editor.importDraftSuccess') });
      setPendingImport(null);
      if (characterImportRef.current) characterImportRef.current.value = '';
      setTimeout(() => setImportMsg(null), 5000);
      return;
    }

    try {
      const response = await fetch('/api/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ version: pendingImport.payload.version, memories, conversations }),
      });
      const data = await response.json();
      if (!response.ok || !data.ok) throw new Error(t('editor.importError'));
      setImportMsg({ type: 'ok', text: t('import.characterSuccess').replace('{memories}', String(data.memoriesImported || 0)).replace('{conversations}', String(data.conversationsImported || 0)) });
    } catch {
      setImportMsg({ type: 'err', text: t('editor.importError') });
    } finally {
      setPendingImport(null);
      if (characterImportRef.current) characterImportRef.current.value = '';
      setTimeout(() => setImportMsg(null), 5000);
    }
  };
  const handleGenerateCharacter = async () => {
    if (!character || !aiRequirement.trim()) return;
    setAiGenerating(true);
    setAiError('');

    try {
      const response = await fetch('/api/characters/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          requirement: aiRequirement,
          current_character: character,
        }),
      });
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error || t('editor.aiGenerateError'));
      }

      setCharacter({
        ...character,
        name: data.name ?? character.name,
        basic_info: data.basic_info ?? character.basic_info,
        personality: data.personality ?? character.personality,
        scenario: data.scenario ?? character.scenario,
        greeting: data.greeting ?? character.greeting,
        example_dialogue: data.example_dialogue ?? character.example_dialogue,
        system_prompt: data.system_prompt ?? character.system_prompt,
        other_info: data.other_info ?? character.other_info,
        image_tags: data.image_tags ?? character.image_tags,
      });
    } catch (err) {
      setAiError(err instanceof Error ? err.message : t('editor.aiGenerateError'));
    } finally {
      setAiGenerating(false);
    }
  };

  const update = (field: keyof Character, value: string) => {
    if (!character) return;
    setCharacter({ ...character, [field]: value });
  };

  if (!character) {
    return <div className="px-6 py-10 text-text-muted">{t('editor.loading')}</div>;
  }

  return (
    <div className="app-shell min-h-screen px-4 py-4">
      {exportOpen && <ExportDialog characterId={id} onClose={() => setExportOpen(false)} />}
      {pendingImport && (
        <ImportDialog
          fileName={pendingImport.fileName}
          onCancel={() => setPendingImport(null)}
          onConfirm={applyPendingImport}
        />
      )}
      <div className="mx-auto flex max-w-7xl flex-col gap-4">
        <header className="surface-hero px-5 py-5">
          <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
            <div className="flex items-center gap-4">
              <button onClick={returnToSidebar} className="soft-button soft-button-secondary shrink-0 whitespace-nowrap px-3 py-2">
                <ArrowLeftIcon className="h-4 w-4" />
                {t('editor.cancel')}
              </button>
              <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-[rgba(155,124,240,0.12)] text-accent-dark">
                <PencilIcon className="h-5 w-5" />
              </div>
              <div>
                <h1 className="section-title text-2xl">{t('editor.title')}</h1>
                <p className="mt-1 section-copy">{t('editor.previewSubtitle')}</p>
              </div>
            </div>

            <div data-role="headerActions" className="flex flex-wrap items-center gap-2 lg:justify-end">
              <button
                type="button"
                onClick={() => setShowAiGenerator(value => !value)}
                className="soft-button soft-button-secondary"
              >
                <SparkIcon className="h-4 w-4" />
                {t('editor.aiGenerate')}
              </button>
              <button onClick={handleDuplicate} disabled={duplicating} className="soft-button soft-button-secondary disabled:cursor-not-allowed disabled:opacity-50">
                <SparkIcon className="h-4 w-4" />
                {duplicating ? t('editor.duplicating') : t('editor.duplicate')}
              </button>
              <button onClick={handleDelete} className="soft-button soft-button-danger">
                <TrashIcon className="h-4 w-4" />
                {t('editor.delete')}
              </button>
              <button type="button" onClick={() => characterImportRef.current?.click()} className="soft-button soft-button-secondary">
                              {t('editor.importTitle')}
                            </button>
                            <input ref={characterImportRef} type="file" accept=".json,application/json" onChange={handleImportCharacterCard} className="hidden" />
                            <button type="button" onClick={() => setExportOpen(true)} className="soft-button soft-button-secondary">
                              {t('editor.export')}
                            </button>
              <button onClick={handleSave} disabled={saving} className="soft-button soft-button-primary disabled:cursor-not-allowed disabled:opacity-50">
                <SparkIcon className="h-4 w-4" />
                {saving ? t('editor.saving') : t('editor.save')}
              </button>
            </div>
          </div>
          {importMsg && (
            <div className={`mt-4 rounded-2xl px-4 py-3 text-sm ${importMsg.type === 'ok' ? 'bg-green-50 text-green-700' : 'bg-red-50 text-red-700'}`}>
              {importMsg.text}
            </div>
          )}
          {showAiGenerator && (
            <div data-role="aiGeneratorPanel" className="mt-4 flex w-full flex-col gap-2 rounded-2xl border border-border-light bg-white/70 p-3 shadow-sm lg:ml-auto lg:max-w-[38rem] lg:self-end">
              <div className="flex flex-col gap-2 sm:flex-row">
                <input
                  value={aiRequirement}
                  onChange={e => setAiRequirement(e.target.value)}
                  onKeyDown={e => {
                    if (e.key === 'Enter' && !e.shiftKey) {
                      e.preventDefault();
                      handleGenerateCharacter();
                    }
                  }}
                  disabled={aiGenerating}
                  className="input-rich min-w-0 flex-1"
                  placeholder={t('editor.aiRequirementPlaceholder')}
                />
                <button
                  type="button"
                  onClick={handleGenerateCharacter}
                  disabled={aiGenerating || !aiRequirement.trim()}
                  className="soft-button soft-button-primary disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {aiGenerating ? t('editor.aiGenerating') : t('editor.aiApplyHint')}
                </button>
              </div>
              {aiError && <p className="text-xs text-danger">{aiError}</p>}
            </div>
          )}
        </header>

        <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_20rem]">
          <main className="space-y-4">
            <section className="surface-panel p-5">
              <h2 className="mb-4 text-base font-semibold text-text-primary">{t('editor.identityInfo')}</h2>
              <div className="flex flex-col gap-4 sm:flex-row sm:items-center">
                <div className="relative h-24 w-24 shrink-0 overflow-hidden rounded-3xl bg-gradient-to-br from-accent/15 to-accent-light/25 shadow-inner">
                  {character.avatar_url ? (
                    <img src={character.avatar_url} alt={character.name} className="h-full w-full object-cover" />
                  ) : (
                    <div className="flex h-full w-full items-center justify-center text-3xl font-semibold text-accent-dark">
                      {character.name[0]}
                    </div>
                  )}
                  <button
                    type="button"
                    onClick={() => fileInputRef.current?.click()}
                    className="absolute inset-0 flex items-center justify-center bg-black/20 text-white opacity-0 transition hover:opacity-100"
                    title={t('editor.changeAvatar')}
                  >
                    <CameraIcon className="h-6 w-6" />
                  </button>
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept="image/*"
                    onChange={handleAvatarUpload}
                    className="hidden"
                  />
                </div>

                <div className="flex-1">
                  <label className="mb-2 block text-sm font-medium text-text-secondary">{t('editor.name')}</label>
                  <input
                    value={character.name}
                    onChange={e => update('name', e.target.value)}
                    className="input-rich"
                    placeholder={t('editor.namePlaceholder')}
                  />
                </div>
              </div>
            </section>

            <section className="surface-panel p-5">
              <h2 className="mb-4 text-base font-semibold text-text-primary">{t('editor.basicInfo')}</h2>
              <textarea
                value={character.basic_info || ''}
                onChange={e => update('basic_info', e.target.value)}
                rows={6}
                placeholder={t('editor.basicInfoPlaceholder')}
                className="textarea-rich"
              />
            </section>

            <section className="surface-panel p-5">
              <h2 className="mb-4 text-base font-semibold text-text-primary">{t('editor.personality')}</h2>
              <textarea
                value={character.personality}
                onChange={e => update('personality', e.target.value)}
                rows={6}
                placeholder={t('editor.personalityPlaceholder')}
                className="textarea-rich"
              />
            </section>

            <section className="surface-panel p-5">
              <h2 className="mb-4 text-base font-semibold text-text-primary">{t('editor.scenario')}</h2>
              <textarea
                value={character.scenario}
                onChange={e => update('scenario', e.target.value)}
                rows={6}
                placeholder={t('editor.scenarioPlaceholder')}
                className="textarea-rich"
              />
            </section>

            <section className="surface-panel p-5">
              <h2 className="mb-4 text-base font-semibold text-text-primary">{t('editor.greeting')}</h2>
              <textarea
                value={character.greeting}
                onChange={e => update('greeting', e.target.value)}
                rows={5}
                placeholder={t('editor.greetingPlaceholder')}
                className="textarea-rich"
              />
            </section>

            <section className="surface-panel p-5">
              <h2 className="mb-4 text-base font-semibold text-text-primary">{t('editor.other')}</h2>
              <textarea
                value={character.other_info || ''}
                onChange={e => update('other_info', e.target.value)}
                rows={6}
                placeholder={t('editor.otherPlaceholder')}
                className="textarea-rich"
              />
            </section>

            <section className="surface-panel p-5">
              <h2 className="mb-4 text-base font-semibold text-text-primary">{t('editor.exampleDialogue')}</h2>
              <textarea
                value={character.example_dialogue}
                onChange={e => update('example_dialogue', e.target.value)}
                rows={8}
                placeholder={t('editor.dialoguePlaceholder')}
                className="textarea-rich font-mono"
              />
            </section>
            <details className="surface-panel overflow-hidden">
              <summary className="cursor-pointer px-5 py-4 text-sm font-medium text-text-primary">
                {t('editor.advanced')}
              </summary>
              <div className="border-t border-border-light px-5 pb-5 pt-4 space-y-4">
                <div>
                  <label className="mb-2 block text-sm font-medium text-text-secondary">{t('editor.systemPrompt')}</label>
                  <textarea
                    value={character.system_prompt}
                    onChange={e => update('system_prompt', e.target.value)}
                    rows={8}
                    placeholder={t('editor.systemPromptPlaceholder')}
                    className="textarea-rich font-mono"
                  />
                </div>
                <div>
                  <label className="mb-2 block text-sm font-medium text-text-secondary">{t('editor.imageTags')}</label>
                  <p className="mb-2 text-xs leading-relaxed text-text-muted">{t('editor.imageTagsHint')}</p>
                  <textarea
                    value={character.image_tags || ''}
                    onChange={e => update('image_tags', e.target.value)}
                    rows={3}
                    placeholder="1girl, silver hair, short hair, orange eyes, slender..."
                    className="textarea-rich font-mono text-sm"
                  />
                </div>
              </div>
            </details>
          </main>

          <aside className="surface-panel h-fit p-5 xl:sticky xl:top-4">
            <h2 className="section-title text-lg">{t('editor.previewTitle')}</h2>
            <p className="mt-2 section-copy">{t('editor.previewSubtitle')}</p>

            <div className="mt-5 space-y-3">
              <div className="stat-tile">
                <div className="flex items-center gap-3">
                  <div className="h-11 w-11 overflow-hidden rounded-2xl bg-gradient-to-br from-accent/15 to-accent-light/25">
                    {character.avatar_url ? (
                      <img src={character.avatar_url} alt={character.name} className="h-full w-full object-cover" loading="lazy" />
                    ) : (
                      <div className="flex h-full w-full items-center justify-center text-lg font-semibold text-accent-dark">
                        {character.name[0]}
                      </div>
                    )}
                  </div>
                  <div className="min-w-0">
                    <div className="truncate text-sm font-semibold text-text-primary">{character.name}</div>
                    <div className="truncate text-xs text-text-muted">{t('editor.previewNote')}</div>
                  </div>
                </div>
              </div>

              <div className="surface-card p-4">
                <div className="mb-3 text-xs uppercase tracking-[0.18em] text-text-muted">{character.name}</div>
                {previewMessages.map(message => (
                  <div key={message.role} className={`mb-3 ${message.role === 'user' ? 'text-right' : ''}`}>
                    <div className={`inline-block max-w-full break-words rounded-2xl px-3 py-2 text-sm leading-relaxed ${message.role === 'user' ? 'bg-warm-100 text-text-primary' : 'bg-[rgba(155,124,240,0.10)] text-text-primary'}`}>
                      {message.content}
                    </div>
                  </div>
                ))}
              </div>

              <div className="stat-tile">
                <div className="label-small">{t('editor.advanced')}</div>
                <p className="mt-2 break-words text-sm text-text-primary">
                  {previewText(character.system_prompt, t('editor.systemPromptPlaceholder'), 120)}
                </p>
              </div>
            </div>
          </aside>
        </div>
      </div>
    </div>
  );
}
