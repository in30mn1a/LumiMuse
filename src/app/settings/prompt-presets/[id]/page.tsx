'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { use } from 'react';
import { useTranslation } from '@/lib/i18n-context';
import { formatTemplate } from '@/lib/i18n';
import { useToast } from '@/components/ui/Toast';
import { ArrowLeftIcon } from '@/components/ui/icons';

interface PresetEntry {
  id: string;
  preset_id: string;
  name: string;
  role: 'system' | 'user' | 'assistant';
  content: string;
  is_marker: boolean;
  marker_key: string | null;
  is_system_prompt: boolean;
  injection_position: 0 | 1;
  injection_depth: number;
  injection_order: number;
  forbid_overrides: boolean;
  enabled: boolean;
  sort_order: number;
}

interface Props {
  params: Promise<{ id: string }>;
}

export default function PresetDetailPage({ params }: Props) {
  const { id } = use(params);
  const { t } = useTranslation();
  const { showToast } = useToast();

  const [preset, setPreset] = useState<{ id: string; name: string; description: string; story_plot_strip: boolean; strip_tags: string[] } | null>(null);
  const [newTagInput, setNewTagInput] = useState('');
  const [entries, setEntries] = useState<PresetEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [editingEntry, setEditingEntry] = useState<PresetEntry | null>(null);
  const [draft, setDraft] = useState<Partial<PresetEntry>>({});
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const loadRequestRef = useRef<{ controller: AbortController; sequence: number } | null>(null);
  const loadSequenceRef = useRef(0);
  const pendingActionRef = useRef<string | null>(null);
  const translateRef = useRef(t);
  const showToastRef = useRef(showToast);

  useEffect(() => {
    translateRef.current = t;
    showToastRef.current = showToast;
  }, [showToast, t]);

  const beginAction = (action: string): boolean => {
    if (pendingActionRef.current) return false;
    pendingActionRef.current = action;
    setPendingAction(action);
    return true;
  };

  const finishAction = () => {
    pendingActionRef.current = null;
    setPendingAction(null);
  };

  const toggleStoryPlotStrip = async () => {
    if (!preset || !beginAction('story-plot-strip')) return;
    const next = !preset.story_plot_strip;
    try {
      const res = await fetch(`/api/prompt-presets/${preset.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ story_plot_strip: next }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setPreset(current => current?.id === preset.id ? { ...current, story_plot_strip: next } : current);
      showToast(t('preset.storyPlotToggleSuccess'), 'success');
    } catch (err) {
      showToast(`${t('preset.toggleError')}: ${err instanceof Error ? err.message : String(err)}`, 'error');
    } finally {
      finishAction();
    }
  };

  const updateStripTags = async (nextTags: string[]): Promise<boolean> => {
    if (!preset || !beginAction('strip-tags')) return false;
    try {
      const res = await fetch(`/api/prompt-presets/${preset.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ strip_tags: nextTags }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setPreset(current => current?.id === preset.id ? { ...current, strip_tags: nextTags } : current);
      showToast(t('preset.stripTagsUpdateSuccess'), 'success');
      return true;
    } catch (err) {
      showToast(`${t('preset.toggleError')}: ${err instanceof Error ? err.message : String(err)}`, 'error');
      return false;
    } finally {
      finishAction();
    }
  };

  const addStripTag = async () => {
    const tag = newTagInput.trim();
    if (!tag || !preset) return;
    if (preset.strip_tags.includes(tag)) { setNewTagInput(''); return; }
    const updated = await updateStripTags([...preset.strip_tags, tag]);
    if (updated) setNewTagInput('');
  };

  const removeStripTag = async (tag: string) => {
    if (!preset) return;
    await updateStripTags(preset.strip_tags.filter(tg => tg !== tag));
  };

  // 统一的"保留视口位置"工具：执行任何会触发整列重渲染的 setState，需要包住它
  // 防止浏览器自动跳到顶部（内容长度变化导致 scroll 被重置）。
  const withScrollPreserved = <T,>(fn: () => Promise<T> | T): Promise<T> | T => {
    const scrollY = window.scrollY;
    const result = fn();
    const restore = () => {
      requestAnimationFrame(() => {
        window.scrollTo({ top: scrollY, behavior: 'instant' as ScrollBehavior });
      });
    };
    if (result && typeof (result as Promise<T>).then === 'function') {
      return (result as Promise<T>).then(r => { restore(); return r; });
    }
    restore();
    return result;
  };

  const load = useCallback(async () => {
    const sequence = loadSequenceRef.current + 1;
    loadSequenceRef.current = sequence;
    loadRequestRef.current?.controller.abort();
    const controller = new AbortController();
    loadRequestRef.current = { controller, sequence };
    setLoadError(null);
    try {
      const [presetRes, entriesRes] = await Promise.all([
        fetch(`/api/prompt-presets/${id}`, { signal: controller.signal }),
        fetch(`/api/prompt-presets/${id}/entries`, { signal: controller.signal }),
      ]);
      if (!presetRes.ok) throw new Error(`/api/prompt-presets/${id}: HTTP ${presetRes.status}`);
      if (!entriesRes.ok) throw new Error(`/api/prompt-presets/${id}/entries: HTTP ${entriesRes.status}`);
      const [presetData, entriesData] = await Promise.all([
        presetRes.json(),
        entriesRes.json(),
      ]);
      if (loadSequenceRef.current !== sequence || controller.signal.aborted) return;
      setPreset(presetData);
      setEntries(Array.isArray(entriesData.entries) ? entriesData.entries : []);
    } catch (err) {
      if (controller.signal.aborted || (err instanceof Error && err.name === 'AbortError')) return;
      if (loadSequenceRef.current !== sequence) return;
      const message = err instanceof Error ? err.message : String(err);
      setLoadError(message);
      showToastRef.current(`${translateRef.current('preset.loadError')}: ${message}`, 'error');
    } finally {
      if (loadSequenceRef.current === sequence && !controller.signal.aborted) {
        setLoading(false);
      }
    }
  }, [id]);

  useEffect(() => {
    // 路由 id 变化时由 effect 启动受 sequence/abort 守护的加载。
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setLoading(true);
    void load();
    return () => {
      loadSequenceRef.current += 1;
      loadRequestRef.current?.controller.abort();
    };
  }, [load]);

  const toggleEnabled = async (entry: PresetEntry) => {
    if (!beginAction(`toggle:${entry.id}`)) return;
    // 保留点击时的视口位置，避免 PATCH 后 setState 触发整列重排导致浏览器跳到顶部
    const scrollY = window.scrollY;
    try {
      const res = await fetch(`/api/prompt-presets/${id}/entries/${entry.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: !entry.enabled }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setEntries(prev => prev.map(e => e.id === entry.id ? { ...e, enabled: !e.enabled } : e));
      // 等浏览器下次绘制完成后强制回到原 scroll 位置
      requestAnimationFrame(() => {
        window.scrollTo({ top: scrollY, behavior: 'instant' as ScrollBehavior });
      });
    } catch (err) {
      showToast(`${t('preset.toggleError')}: ${err instanceof Error ? err.message : String(err)}`, 'error');
    } finally {
      finishAction();
    }
  };

  const handleEditClick = (entry: PresetEntry) => {
    withScrollPreserved(() => {
      setEditingEntry(entry);
      setDraft({
        name: entry.name,
        content: entry.content,
        role: entry.role,
        injection_position: entry.injection_position,
        injection_depth: entry.injection_depth,
        injection_order: entry.injection_order,
        sort_order: entry.sort_order,
      });
    });
  };

  const handleSaveDraft = async () => {
    if (!editingEntry || !beginAction(`save:${editingEntry.id}`)) return;
    await withScrollPreserved(async () => {
      try {
        const res = await fetch(`/api/prompt-presets/${id}/entries/${editingEntry.id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(draft),
        });
        if (!res.ok) {
          const err = await res.json().catch(() => ({}));
          throw new Error(err.error || `HTTP ${res.status}`);
        }
        showToast(t('preset.saveEntrySuccess'), 'success');
        setEditingEntry(null);
        await load();
      } catch (err) {
        showToast(`${t('preset.saveEntryError')}: ${err instanceof Error ? err.message : String(err)}`, 'error');
      } finally {
        finishAction();
      }
    });
  };

  const handleDelete = async (entry: PresetEntry) => {
    if (pendingActionRef.current) return;
    if (!window.confirm(formatTemplate(t('preset.confirmDeleteEntry'), { name: entry.name }))) return;
    if (!beginAction(`delete:${entry.id}`)) return;
    await withScrollPreserved(async () => {
      try {
        const res = await fetch(`/api/prompt-presets/${id}/entries/${entry.id}`, {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        await load();
      } catch (err) {
        showToast(`${t('preset.deleteEntryError')}: ${err instanceof Error ? err.message : String(err)}`, 'error');
      } finally {
        finishAction();
      }
    });
  };

  const handleAddEntry = async () => {
    if (!preset || !beginAction('add')) return;
    await withScrollPreserved(async () => {
      try {
        const res = await fetch(`/api/prompt-presets/${id}/entries`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name: '新条目',
            role: 'user',
            content: '',
            enabled: false,
          }),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        await load();
      } catch (err) {
        showToast(`${t('preset.addEntryError')}: ${err instanceof Error ? err.message : String(err)}`, 'error');
      } finally {
        finishAction();
      }
    });
  };

  if (loading) return <div className="px-6 py-10 text-text-muted">{t('preset.loading')}</div>;
  if (loadError && !preset) {
    return (
      <div role="alert" className="m-6 rounded-xl bg-red-50 px-4 py-3 text-sm text-red-700 dark:bg-red-950/30 dark:text-red-300">
        {t('preset.loadError')}: {loadError}
      </div>
    );
  }
  if (!preset) return <div className="px-6 py-10 text-text-muted">{t('preset.notFound')}</div>;

  const relativeEntries = entries.filter(e => e.injection_position === 0);
  const inChatEntries = entries.filter(e => e.injection_position === 1);

  const EntryRow = ({ entry }: { entry: PresetEntry }) => (
    <li
      className={`flex items-start justify-between gap-3 rounded-xl border px-4 py-3 ${
        entry.enabled
          ? 'border-border-light bg-surface'
          : 'border-border-light/50 bg-surface/50 opacity-60'
      }`}
    >
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="truncate text-sm font-medium text-text-primary">{entry.name}</span>
          <span className={`rounded-full px-2 py-0.5 text-xs ${
            entry.role === 'system' ? 'bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-300' :
            entry.role === 'user' ? 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300' :
            'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300'
          }`}>
            {entry.role}
          </span>
          {entry.is_marker && entry.marker_key && (
            <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs text-amber-700 dark:bg-amber-900/30 dark:text-amber-300" title={t('preset.markerHint')}>
              marker: {entry.marker_key}
            </span>
          )}
          {entry.injection_position === 1 && (
            <span className="rounded-full bg-rose-100 px-2 py-0.5 text-xs text-rose-700 dark:bg-rose-900/30 dark:text-rose-300" title={t('preset.inChatHint')}>
              in-chat d{entry.injection_depth}/o{entry.injection_order}
            </span>
          )}
          <span className="text-xs text-text-muted">#{entry.sort_order}</span>
        </div>
        {entry.content && (
          <p className="mt-1 line-clamp-2 text-xs text-text-muted">{entry.content}</p>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <button
          onClick={() => toggleEnabled(entry)}
          className={`rounded-full px-3 py-1 text-xs font-medium transition-colors ${
            entry.enabled
              ? 'bg-emerald-100 text-emerald-700 hover:bg-emerald-200 dark:bg-emerald-900/30 dark:text-emerald-300'
              : 'bg-zinc-200 text-zinc-600 hover:bg-zinc-300 dark:bg-zinc-700 dark:text-zinc-400'
          }`}
          disabled={pendingAction !== null}
        >
          {entry.enabled ? t('preset.enabled') : t('preset.disabled')}
        </button>
        <button
          onClick={() => handleEditClick(entry)}
          className="soft-button soft-button-secondary text-xs"
          disabled={pendingAction !== null}
        >
          {t('preset.edit')}
        </button>
        <button
          onClick={() => handleDelete(entry)}
          className="soft-button soft-button-danger text-xs"
          disabled={pendingAction !== null}
        >
          {t('preset.delete')}
        </button>
      </div>
    </li>
  );

  return (
    <div className="app-shell min-h-screen px-4 py-4">
      <div className="mx-auto flex max-w-5xl flex-col gap-4">
        <header className="surface-hero px-5 py-5">
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0">
              <h1 className="section-title text-2xl truncate">{preset.name}</h1>
              {preset.description && (
                <p className="mt-1 section-copy">{preset.description}</p>
              )}
              <div className="mt-3 flex flex-col gap-2">
                <label className="flex items-center gap-2 text-xs text-text-muted">
                  <input
                    type="checkbox"
                    checked={preset.story_plot_strip}
                    onChange={toggleStoryPlotStrip}
                    disabled={pendingAction !== null}
                  />
                  {t('preset.storyPlotStripLabel')}
                </label>
                {preset.story_plot_strip && (
                  <div className="flex flex-col gap-1.5">
                    <p className="text-xs text-text-muted">{t('preset.stripTagsHint')}</p>
                    <div className="flex flex-wrap gap-1.5">
                      {preset.strip_tags.map(tag => (
                        <span
                          key={tag}
                          className="inline-flex items-center gap-1 rounded bg-surface-2 px-2 py-0.5 text-xs text-text-secondary"
                        >
                          <code>{tag}</code>
                          <button
                            type="button"
                            onClick={() => void removeStripTag(tag)}
                            disabled={pendingAction !== null}
                            className="text-text-muted hover:text-red-400 disabled:opacity-40"
                            aria-label={`remove ${tag}`}
                          >
                            ×
                          </button>
                        </span>
                      ))}
                    </div>
                    <div className="flex items-center gap-1.5">
                      <input
                        type="text"
                        value={newTagInput}
                        onChange={e => setNewTagInput(e.target.value)}
                        onKeyDown={e => { if (e.key === 'Enter') void addStripTag(); }}
                        placeholder={t('preset.stripTagPlaceholder')}
                        disabled={pendingAction !== null}
                        className="w-48 rounded border border-border bg-surface px-2 py-1 text-xs"
                      />
                      <button
                        type="button"
                        onClick={() => void addStripTag()}
                        disabled={pendingAction !== null || !newTagInput.trim()}
                        className="soft-button soft-button-secondary px-2 py-1 text-xs disabled:opacity-40"
                      >
                        {t('preset.stripTagAdd')}
                      </button>
                    </div>
                  </div>
                )}
              </div>
            </div>
            <Link href="/settings/prompt-presets" className="soft-button soft-button-secondary shrink-0 px-3 py-2">
              <ArrowLeftIcon className="h-4 w-4" />
              {t('preset.backList')}
            </Link>
            <a
              href={`/api/prompt-presets/${preset.id}/export?format=lumimuse`}
              className="soft-button soft-button-secondary shrink-0 text-xs"
              download
            >
              {t('preset.exportLumiMuse')}
            </a>
            <a
              href={`/api/prompt-presets/${preset.id}/export?format=sillytavern`}
              className="soft-button soft-button-secondary shrink-0 text-xs"
              download
            >
              {t('preset.exportSt')}
            </a>
          </div>
        </header>

        {loadError && (
          <p role="alert" className="rounded-xl bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-950/30 dark:text-red-300">
            {t('preset.loadError')}: {loadError}
          </p>
        )}

        <section className="surface-panel p-5">
          <div className="flex items-center justify-between">
            <h2 className="text-base font-semibold text-text-primary">{t('preset.relativeEntries')}</h2>
            <button
              onClick={handleAddEntry}
              className="soft-button soft-button-secondary text-xs"
              disabled={pendingAction !== null}
            >
              {t('preset.addEntry')}
            </button>
          </div>
          <p className="mt-1 text-xs text-text-muted">{t('preset.relativeHint')}</p>
          <ul className="mt-3 space-y-2">
            {relativeEntries.length === 0 && <li className="text-sm text-text-muted">{t('preset.noEntries')}</li>}
            {relativeEntries.map(e => <EntryRow key={e.id} entry={e} />)}
          </ul>
        </section>

        <section className="surface-panel p-5">
          <h2 className="text-base font-semibold text-text-primary">{t('preset.inChatEntries')}</h2>
          <p className="mt-1 text-xs text-text-muted">{t('preset.inChatHint2')}</p>
          <ul className="mt-3 space-y-2">
            {inChatEntries.length === 0 && <li className="text-sm text-text-muted">{t('preset.noEntries')}</li>}
            {inChatEntries.map(e => <EntryRow key={e.id} entry={e} />)}
          </ul>
        </section>

        {editingEntry && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
            <div className="flex w-full max-w-2xl flex-col gap-4 rounded-2xl bg-surface p-6 shadow-xl">
              <h3 className="text-lg font-semibold text-text-primary">
                {formatTemplate(t('preset.editEntryTitle'), { name: editingEntry.name })}
              </h3>
              <div>
                <label className="mb-1 block text-xs font-medium text-text-secondary">{t('preset.entryName')}</label>
                <input
                  className="input-rich"
                  value={draft.name ?? ''}
                  onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                  disabled={pendingAction !== null}
                />
              </div>
              <div className="grid grid-cols-3 gap-3">
                <div>
                  <label className="mb-1 block text-xs font-medium text-text-secondary">{t('preset.entryRole')}</label>
                  <select
                    className="input-rich"
                    value={draft.role ?? 'user'}
                    onChange={(e) => setDraft({ ...draft, role: e.target.value as 'system' | 'user' | 'assistant' })}
                    disabled={pendingAction !== null}
                  >
                    <option value="system">system</option>
                    <option value="user">user</option>
                    <option value="assistant">assistant</option>
                  </select>
                </div>
                <div>
                  <label className="mb-1 block text-xs font-medium text-text-secondary">{t('preset.entryPos')}</label>
                  <select
                    className="input-rich"
                    value={draft.injection_position ?? 0}
                    onChange={(e) => setDraft({ ...draft, injection_position: Number(e.target.value) === 1 ? 1 : 0 })}
                    disabled={pendingAction !== null}
                  >
                    <option value={0}>{t('preset.posRelative')}</option>
                    <option value={1}>{t('preset.posInChat')}</option>
                  </select>
                </div>
                <div>
                  <label className="mb-1 block text-xs font-medium text-text-secondary">{t('preset.entrySortOrder')}</label>
                  <input
                    type="number"
                    className="input-rich"
                    value={draft.sort_order ?? 0}
                    onChange={(e) => setDraft({ ...draft, sort_order: Number(e.target.value) })}
                    disabled={pendingAction !== null}
                  />
                </div>
              </div>
              {(draft.injection_position ?? 0) === 1 && (
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="mb-1 block text-xs font-medium text-text-secondary">{t('preset.entryDepth')}</label>
                    <input
                      type="number"
                      className="input-rich"
                      value={draft.injection_depth ?? 4}
                      onChange={(e) => setDraft({ ...draft, injection_depth: Number(e.target.value) })}
                      disabled={pendingAction !== null}
                    />
                  </div>
                  <div>
                    <label className="mb-1 block text-xs font-medium text-text-secondary">{t('preset.entryOrder')}</label>
                    <input
                      type="number"
                      className="input-rich"
                      value={draft.injection_order ?? 100}
                      onChange={(e) => setDraft({ ...draft, injection_order: Number(e.target.value) })}
                      disabled={pendingAction !== null}
                    />
                  </div>
                </div>
              )}
              <div>
                <label className="mb-1 block text-xs font-medium text-text-secondary">{t('preset.entryContent')}</label>
                <textarea
                  rows={12}
                  className="textarea-rich font-mono text-sm"
                  value={draft.content ?? ''}
                  onChange={(e) => setDraft({ ...draft, content: e.target.value })}
                  disabled={pendingAction !== null}
                />
              </div>
              <div className="flex justify-end gap-2">
                <button
                  onClick={() => withScrollPreserved(() => setEditingEntry(null))}
                  className="soft-button soft-button-secondary"
                  disabled={pendingAction !== null}
                >
                  {t('preset.cancel')}
                </button>
                <button
                  onClick={handleSaveDraft}
                  className="soft-button soft-button-primary"
                  disabled={pendingAction !== null}
                >
                  {t('preset.save')}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
