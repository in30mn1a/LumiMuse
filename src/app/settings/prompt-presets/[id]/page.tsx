'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { use } from 'react';
import { useTranslation } from '@/lib/i18n-context';
import { formatTemplate } from '@/lib/i18n';
import { useToast } from '@/components/ui/Toast';
import { ArrowLeftIcon, CheckIcon, PencilIcon, XIcon } from '@/components/ui/icons';
import { LEGACY_STORY_PLOT_TAGS, usesLegacyStoryPlotRules } from '@/lib/story-plot-strip';

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

/**
 * RONG 旧协议模式（strip_tags 含 block 规则 story_plot）下剥离流程是硬编码的，
 * 只有 LEGACY_STORY_PLOT_TAGS 里的容器会被处理，列表中其余规则一律不参与——
 * 必须在 UI 上标出来，否则用户加了 tag 却看不出它永远不会生效。
 */
function isStripTagEffective(tag: string, legacyMode: boolean): boolean {
  if (!legacyMode) return true;
  if (tag.startsWith('#')) return false;
  return LEGACY_STORY_PLOT_TAGS.includes(tag.trim().toLowerCase());
}

interface EntryRowProps {
  entry: PresetEntry;
  pending: boolean;
  t: ReturnType<typeof useTranslation>['t'];
  onToggle: (entry: PresetEntry) => void;
  onEdit: (entry: PresetEntry) => void;
  onDelete: (entry: PresetEntry) => void;
}

function EntryRow({ entry, pending, t, onToggle, onEdit, onDelete }: EntryRowProps) {
  const toggleLabel = `${entry.enabled ? t('preset.enabled') : t('preset.disabled')}: ${entry.name}`;
  const editLabel = `${t('preset.edit')}: ${entry.name}`;
  const deleteLabel = `${t('preset.delete')}: ${entry.name}`;
  const iconButtonClassName = 'soft-button h-11 min-h-11 w-11 min-w-11 shrink-0 touch-manipulation rounded-xl p-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-surface disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:translate-y-0';

  return (
    <li
      className={`flex flex-col gap-3 rounded-xl border px-4 py-3 sm:flex-row sm:items-start sm:justify-between ${
        entry.enabled
          ? 'border-border-light bg-surface'
          : 'border-border-light/50 bg-surface/50 opacity-60'
      }`}
    >
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span
            className="line-clamp-2 basis-full break-words text-sm font-medium text-text-primary sm:basis-auto"
            title={entry.name}
          >
            {entry.name}
          </span>
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
      <div className="flex shrink-0 items-center gap-2 self-end sm:self-auto">
        <button
          type="button"
          onClick={() => onToggle(entry)}
          className={`${iconButtonClassName} ${
            entry.enabled
              ? 'bg-emerald-100 text-emerald-700 hover:bg-emerald-200 dark:bg-emerald-900/30 dark:text-emerald-300'
              : 'bg-zinc-200 text-zinc-600 hover:bg-zinc-300 dark:bg-zinc-700 dark:text-zinc-400'
          }`}
          disabled={pending}
          aria-label={toggleLabel}
          aria-pressed={entry.enabled}
          title={toggleLabel}
        >
          <CheckIcon className="h-5 w-5" />
        </button>
        <button
          type="button"
          onClick={() => onEdit(entry)}
          className={`${iconButtonClassName} soft-button-secondary`}
          disabled={pending}
          aria-label={editLabel}
          title={editLabel}
        >
          <PencilIcon className="h-5 w-5" />
        </button>
        <button
          type="button"
          onClick={() => onDelete(entry)}
          className={`${iconButtonClassName} soft-button-danger`}
          disabled={pending}
          aria-label={deleteLabel}
          title={deleteLabel}
        >
          <XIcon className="h-5 w-5" />
        </button>
      </div>
    </li>
  );
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
    const legacyMode = usesLegacyStoryPlotRules(preset.strip_tags);
    const updated = await updateStripTags([...preset.strip_tags, tag]);
    if (!updated) return;
    setNewTagInput('');
    // 规则已存下但不会参与剥离时当场告知，避免用户以为加上就生效了
    if (!isStripTagEffective(tag, legacyMode)) {
      showToast(t('preset.stripTagInactiveToast'), 'info');
    }
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
      // 与 entries 一样在入口归一化：strip_tags 缺失/畸形时兜底成空数组，
      // 让模式判定、标签渲染与增删路径拿到的一律是数组
      setPreset({
        ...presetData,
        strip_tags: Array.isArray(presetData.strip_tags) ? presetData.strip_tags : [],
      });
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
    try {
      const res = await fetch(`/api/prompt-presets/${id}/entries/${entry.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: !entry.enabled }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setEntries(prev => prev.map(e => e.id === entry.id ? { ...e, enabled: !e.enabled } : e));
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

  const legacyStoryPlotMode = usesLegacyStoryPlotRules(preset.strip_tags);
  const relativeEntries = entries.filter(e => e.injection_position === 0);
  const inChatEntries = entries.filter(e => e.injection_position === 1);

  return (
    <div className="app-shell min-h-screen px-4 py-4">
      <div className="mx-auto flex max-w-5xl flex-col gap-4">
        <header className="surface-hero min-w-0 px-5 py-5">
          <div className="flex min-w-0 flex-col gap-4">
            <div className="flex min-w-0 flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
              <div className="min-w-0 flex-1">
                <h1 className="section-title text-2xl break-words">{preset.name}</h1>
                {preset.description && (
                  <p className="mt-1 section-copy break-words">{preset.description}</p>
                )}
              </div>
              <div className="flex min-w-0 flex-wrap items-center gap-2 sm:justify-end">
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
            </div>
            <div className="flex min-w-0 flex-col gap-2">
              <label className="flex min-w-0 items-start gap-2 text-xs text-text-muted">
                <input
                  type="checkbox"
                  checked={preset.story_plot_strip}
                  onChange={toggleStoryPlotStrip}
                  disabled={pendingAction !== null}
                  className="mt-0.5 shrink-0"
                />
                <span className="min-w-0 break-words">{t('preset.storyPlotStripLabel')}</span>
              </label>
              {preset.story_plot_strip && (
                <div className="flex min-w-0 flex-col gap-1.5">
                  <p className="min-w-0 break-words text-xs text-text-muted">{t('preset.stripTagsHint')}</p>
                  {legacyStoryPlotMode && (
                    <p className="min-w-0 break-words text-xs text-amber-600 dark:text-amber-400">{t('preset.stripTagsLegacyHint')}</p>
                  )}
                  <div className="flex min-w-0 flex-wrap gap-1.5">
                    {preset.strip_tags.map(tag => {
                      const effective = isStripTagEffective(tag, legacyStoryPlotMode);
                      return (
                        <span
                          key={tag}
                          title={effective ? undefined : t('preset.stripTagInactiveToast')}
                          className={`inline-flex max-w-full min-w-0 items-center gap-1 rounded bg-surface-2 px-2 py-0.5 text-xs ${
                            effective ? 'text-text-secondary' : 'text-text-muted line-through opacity-60'
                          }`}
                        >
                          <code className="min-w-0 break-all">{tag}</code>
                          <button
                            type="button"
                            onClick={() => void removeStripTag(tag)}
                            disabled={pendingAction !== null}
                            className="shrink-0 text-text-muted hover:text-red-400 disabled:opacity-40"
                            aria-label={`remove ${tag}`}
                          >
                            ×
                          </button>
                        </span>
                      );
                    })}
                  </div>
                  <div className="flex min-w-0 items-center gap-1.5">
                    <input
                      type="text"
                      value={newTagInput}
                      onChange={e => setNewTagInput(e.target.value)}
                      onKeyDown={e => { if (e.key === 'Enter') void addStripTag(); }}
                      placeholder={t('preset.stripTagPlaceholder')}
                      disabled={pendingAction !== null}
                      className="min-w-0 flex-1 rounded border border-border bg-surface px-2 py-1 text-xs"
                    />
                    <button
                      type="button"
                      onClick={() => void addStripTag()}
                      disabled={pendingAction !== null || !newTagInput.trim()}
                      className="soft-button soft-button-secondary shrink-0 px-2 py-1 text-xs disabled:opacity-40"
                    >
                      {t('preset.stripTagAdd')}
                    </button>
                  </div>
                </div>
              )}
            </div>
          </div>
        </header>

        {loadError && (
          <p role="alert" className="rounded-xl bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-950/30 dark:text-red-300">
            {t('preset.loadError')}: {loadError}
          </p>
        )}

        <section className="surface-panel p-5">
          <div className="flex items-start justify-between gap-2">
            <h2 className="min-w-0 flex-1 break-words text-base font-semibold text-text-primary">{t('preset.relativeEntries')}</h2>
            <button
              onClick={handleAddEntry}
              className="soft-button soft-button-secondary shrink-0 text-xs"
              disabled={pendingAction !== null}
            >
              {t('preset.addEntry')}
            </button>
          </div>
          <p className="mt-1 text-xs text-text-muted">{t('preset.relativeHint')}</p>
          <ul className="mt-3 space-y-2">
            {relativeEntries.length === 0 && <li className="text-sm text-text-muted">{t('preset.noEntries')}</li>}
            {relativeEntries.map(e => (
              <EntryRow
                key={e.id}
                entry={e}
                pending={pendingAction !== null}
                t={t}
                onToggle={toggleEnabled}
                onEdit={handleEditClick}
                onDelete={handleDelete}
              />
            ))}
          </ul>
        </section>

        <section className="surface-panel p-5">
          <h2 className="min-w-0 break-words text-base font-semibold text-text-primary">{t('preset.inChatEntries')}</h2>
          <p className="mt-1 text-xs text-text-muted">{t('preset.inChatHint2')}</p>
          <ul className="mt-3 space-y-2">
            {inChatEntries.length === 0 && <li className="text-sm text-text-muted">{t('preset.noEntries')}</li>}
            {inChatEntries.map(e => (
              <EntryRow
                key={e.id}
                entry={e}
                pending={pendingAction !== null}
                t={t}
                onToggle={toggleEnabled}
                onEdit={handleEditClick}
                onDelete={handleDelete}
              />
            ))}
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
