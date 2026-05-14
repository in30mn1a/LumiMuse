'use client';

import { useRef, useState, useEffect } from 'react';
import { Character } from '@/types';
import MemoryList from '@/components/memories/MemoryList';
import Link from 'next/link';
import { useTranslation } from '@/lib/i18n-context';
import { ArrowLeftIcon, MemoryIcon } from '@/components/ui/icons';

// 导出选项弹窗
function ExportDialog({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const [includeCharacters, setIncludeCharacters] = useState(true);
  const [includeMemories, setIncludeMemories] = useState(true);
  const [includeConversations, setIncludeConversations] = useState(true);

  const handleExport = () => {
    const params = new URLSearchParams({ type: 'all' });
    if (!includeCharacters) params.set('include_characters', '0');
    if (!includeMemories) params.set('include_memories', '0');
    if (!includeConversations) params.set('include_conversations', '0');
    // 触发浏览器下载
    const a = document.createElement('a');
    a.href = `/api/export?${params.toString()}`;
    a.download = '';
    a.click();
    onClose();
  };

  const nothingSelected = !includeCharacters && !includeMemories && !includeConversations;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center px-4">
      {/* 遮罩 */}
      <div className="absolute inset-0 bg-black/35 backdrop-blur-sm" onClick={onClose} />

      <div className="surface-hero relative z-10 w-full max-w-sm px-6 py-6">
        <h2 className="section-title mb-1 text-lg">{t('export.title')}</h2>
        <p className="mb-5 text-sm" style={{ color: 'var(--color-text-muted)' }}>
          {t('export.hint')}
        </p>

        <div className="space-y-2">
          {[
            { key: 'characters', label: t('export.includeCharacters'), checked: includeCharacters, set: setIncludeCharacters },
            { key: 'memories',   label: t('export.includeMemories'),   checked: includeMemories,   set: setIncludeMemories },
            { key: 'convs',      label: t('export.includeConversations'), checked: includeConversations, set: setIncludeConversations },
          ].map(item => (
            <label
              key={item.key}
              className="flex cursor-pointer items-center gap-3 rounded-2xl border border-border-light bg-white/70 px-4 py-3 text-sm text-text-secondary"
            >
              <input
                type="checkbox"
                checked={item.checked}
                onChange={e => item.set(e.target.checked)}
              />
              {item.label}
            </label>
          ))}
        </div>

        <div className="mt-5 flex justify-end gap-2">
          <button onClick={onClose} className="soft-button soft-button-secondary px-4 py-2 text-sm">
            {t('common.cancel')}
          </button>
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

export default function MemoriesPage() {
  const [characters, setCharacters] = useState<Character[]>([]);
  const [selectedCharId, setSelectedCharId] = useState<string | null>(null);
  const [importMsg, setImportMsg] = useState<{ type: 'ok' | 'err'; text: string } | null>(null);
  const [exportOpen, setExportOpen] = useState(false);
  const importRef = useRef<HTMLInputElement>(null);
  const { t } = useTranslation();

  useEffect(() => {
    fetch('/api/characters').then(r => r.json()).then((chars: Character[]) => {
      setCharacters(chars);
      if (chars.length > 0) setSelectedCharId(chars[0].id);
    });
  }, []);

  const handleImport = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const text = await file.text();
      const json = JSON.parse(text);
      const res = await fetch('/api/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(json),
      });
      const data = await res.json();
      if (data.ok) {
        const parts = [
          data.imported > 0 && `${data.imported} 个角色`,
          data.memoriesImported > 0 && `${data.memoriesImported} 条记忆`,
          data.conversationsImported > 0 && `${data.conversationsImported} 段对话（${data.messagesImported} 条消息）`,
        ].filter(Boolean).join('、');
        setImportMsg({ type: 'ok', text: `${t('memories.importSuccess')}：导入 ${parts || '无新内容'}` });
        fetch('/api/characters').then(r => r.json()).then((chars: Character[]) => {
          setCharacters(chars);
          if (!selectedCharId && chars.length > 0) setSelectedCharId(chars[0].id);
        });
      } else {
        setImportMsg({ type: 'err', text: t('memories.importError') });
      }
    } catch {
      setImportMsg({ type: 'err', text: t('memories.importError') });
    }
    setTimeout(() => setImportMsg(null), 5000);
    if (importRef.current) importRef.current.value = '';
  };

  return (
    <div className="app-shell min-h-screen px-4 py-4">
      {exportOpen && <ExportDialog onClose={() => setExportOpen(false)} />}

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

              {/* 导出（弹窗选择内容） */}
              <button
                onClick={() => setExportOpen(true)}
                className="soft-button soft-button-secondary px-3 py-2 text-sm"
              >
                {t('memories.export')}
              </button>

              {/* 导入 */}
              <button
                onClick={() => importRef.current?.click()}
                className="soft-button soft-button-secondary px-3 py-2 text-sm"
              >
                {t('memories.import')}
              </button>
              <input ref={importRef} type="file" accept=".json" className="hidden" onChange={handleImport} />
            </div>
          </div>

          {/* 导入结果提示 */}
          {importMsg && (
            <div
              className="mt-3 rounded-2xl px-4 py-2 text-sm"
              style={{
                background: importMsg.type === 'ok' ? 'rgba(155,124,240,0.08)' : 'rgba(182,79,138,0.08)',
                border: `1px solid ${importMsg.type === 'ok' ? 'rgba(155,124,240,0.2)' : 'rgba(182,79,138,0.2)'}`,
                color: importMsg.type === 'ok' ? 'var(--color-accent-dark)' : '#a33375',
              }}
            >
              {importMsg.text}
            </div>
          )}
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
