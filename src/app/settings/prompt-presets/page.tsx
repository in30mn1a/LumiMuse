'use client';

import { useCallback, useEffect, useRef, useState, type ChangeEvent } from 'react';
import Link from 'next/link';
import { useTranslation } from '@/lib/i18n-context';
import { formatTemplate } from '@/lib/i18n';
import { useToast } from '@/components/ui/Toast';
import { ArrowLeftIcon, TrashIcon } from '@/components/ui/icons';

interface PresetSummary {
  id: string;
  name: string;
  description: string;
  entry_count: number;
  enabled_count: number;
  is_built_in: boolean;
}

export default function PromptPresetsPage() {
  const { t } = useTranslation();
  const { showToast } = useToast();

  const [presets, setPresets] = useState<PresetSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [defaultPresetId, setDefaultPresetId] = useState<string | null>(null);
  const [newName, setNewName] = useState('');
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

  const load = useCallback(async () => {
    const sequence = loadSequenceRef.current + 1;
    loadSequenceRef.current = sequence;
    loadRequestRef.current?.controller.abort();
    const controller = new AbortController();
    loadRequestRef.current = { controller, sequence };
    setLoadError(null);
    try {
      const [presetsRes, settingsRes] = await Promise.all([
        fetch('/api/prompt-presets', { signal: controller.signal }),
        fetch('/api/settings', { signal: controller.signal }),
      ]);
      if (!presetsRes.ok) throw new Error(`/api/prompt-presets: HTTP ${presetsRes.status}`);
      if (!settingsRes.ok) throw new Error(`/api/settings: HTTP ${settingsRes.status}`);
      const [presetsData, settingsData] = await Promise.all([
        presetsRes.json(),
        settingsRes.json(),
      ]);
      if (loadSequenceRef.current !== sequence || controller.signal.aborted) return;
      setPresets(Array.isArray(presetsData.presets) ? presetsData.presets : []);
      const dpi = settingsData?.prompt_preset?.default_preset_id;
      setDefaultPresetId(typeof dpi === 'string' && dpi ? dpi : null);
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
  }, []);

  useEffect(() => {
    // 初次加载由 effect 触发；load 内部的状态写入均在请求生命周期中受 sequence/abort 守护。
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
    return () => {
      loadSequenceRef.current += 1;
      loadRequestRef.current?.controller.abort();
    };
  }, [load]);

  const handleCreate = async () => {
    const name = newName.trim();
    if (!name || !beginAction('create')) return;
    try {
      const res = await fetch('/api/prompt-presets', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || `HTTP ${res.status}`);
      }
      setNewName('');
      showToast(t('preset.createSuccess'), 'success');
      await load();
    } catch (err) {
      showToast(`${t('preset.createError')}: ${err instanceof Error ? err.message : String(err)}`, 'error');
    } finally {
      finishAction();
    }
  };

  const handleDelete = async (preset: PresetSummary) => {
    if (pendingActionRef.current) return;
    if (!window.confirm(formatTemplate(t('preset.confirmDelete'), { name: preset.name }))) return;
    if (!beginAction(`delete:${preset.id}`)) return;
    try {
      const res = await fetch(`/api/prompt-presets/${preset.id}`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      showToast(t('preset.deleteSuccess'), 'success');
      await load();
    } catch (err) {
      showToast(`${t('preset.deleteError')}: ${err instanceof Error ? err.message : String(err)}`, 'error');
    } finally {
      finishAction();
    }
  };

  const handleSetDefault = async (presetId: string) => {
    if (!beginAction(`default:${presetId}`)) return;
    try {
      const res = await fetch('/api/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt_preset: { default_preset_id: presetId } }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setDefaultPresetId(presetId);
      showToast(t('preset.setDefaultSuccess'), 'success');
    } catch (err) {
      showToast(`${t('preset.setDefaultError')}: ${err instanceof Error ? err.message : String(err)}`, 'error');
    } finally {
      finishAction();
    }
  };

  const handleClearDefault = async () => {
    if (!beginAction('default:clear')) return;
    try {
      const res = await fetch('/api/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt_preset: { default_preset_id: null } }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setDefaultPresetId(null);
      showToast(t('preset.clearDefaultSuccess'), 'success');
    } catch (err) {
      showToast(`${t('preset.setDefaultError')}: ${err instanceof Error ? err.message : String(err)}`, 'error');
    } finally {
      finishAction();
    }
  };

  const handleImport = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !beginAction('import')) return;
    try {
      const text = await file.text();
      const res = await fetch('/api/prompt-presets/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: file.name.replace(/\.json$/i, ''),
          json: text,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data.error || `HTTP ${res.status}`);
      }
      showToast(
        formatTemplate(t('preset.importSuccess'), {
          total: data.total,
          markers: data.markers_recognized,
          disabled: data.markers_disabled,
        }),
        'success',
      );
      await load();
    } catch (err) {
      showToast(`${t('preset.importError')}: ${err instanceof Error ? err.message : String(err)}`, 'error');
    } finally {
      finishAction();
      e.target.value = '';
    }
  };

  return (
    <div className="app-shell min-h-screen px-4 py-4">
      <div className="mx-auto flex max-w-5xl flex-col gap-4">
        <header className="surface-hero px-5 py-5">
          <div className="flex items-start justify-between gap-4">
            <div>
              <h1 className="section-title text-2xl">{t('preset.pageTitle')}</h1>
              <p className="mt-1 section-copy">{t('preset.pageSubtitle')}</p>
            </div>
            <Link href="/settings" className="soft-button soft-button-secondary shrink-0 px-3 py-2">
              <ArrowLeftIcon className="h-4 w-4" />
              {t('preset.backSettings')}
            </Link>
          </div>
        </header>

        <section className="surface-panel p-5">
          <h2 className="mb-3 text-base font-semibold text-text-primary">{t('preset.actions')}</h2>
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
            <input
              className="input-rich flex-1"
              placeholder={t('preset.newNamePlaceholder')}
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
            />
            <button
              onClick={handleCreate}
              className="soft-button soft-button-primary"
              disabled={!newName.trim() || pendingAction !== null}
            >
              {t('preset.create')}
            </button>
            <label className={`soft-button soft-button-secondary ${pendingAction ? 'cursor-not-allowed opacity-60' : 'cursor-pointer'}`}>
              {pendingAction === 'import' ? t('preset.importing') : t('preset.importFromSt')}
              <input
                type="file"
                accept="application/json,.json"
                onChange={handleImport}
                disabled={pendingAction !== null}
                className="hidden"
              />
            </label>
          </div>
        </section>

        <section className="surface-panel p-5">
          <h2 className="mb-3 text-base font-semibold text-text-primary">{t('preset.list')}</h2>
          {loadError && (
            <p role="alert" className="mb-3 rounded-xl bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-950/30 dark:text-red-300">
              {t('preset.loadError')}: {loadError}
            </p>
          )}
          {loadError ? null : loading ? (
            <p className="text-sm text-text-muted">{t('preset.loading')}</p>
          ) : presets.length === 0 ? (
            <p className="text-sm text-text-muted">{t('preset.empty')}</p>
          ) : (
            <ul className="space-y-2">
              {presets.map(p => (
                <li
                  key={p.id}
                  className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-border-light bg-surface px-4 py-3"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="truncate text-sm font-medium text-text-primary">{p.name}</span>
                      {defaultPresetId === p.id && (
                        <span className="rounded-full bg-accent-soft px-2 py-0.5 text-xs text-accent-dark">
                          {t('preset.badgeDefault')}
                        </span>
                      )}
                    </div>
                    <p className="mt-1 text-xs text-text-muted">
                      {formatTemplate(t('preset.entryCount'), { total: p.entry_count, enabled: p.enabled_count })}
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    {defaultPresetId === p.id ? (
                      <button
                        onClick={handleClearDefault}
                        className="soft-button soft-button-secondary text-xs"
                        disabled={pendingAction !== null}
                      >
                        {t('preset.clearDefault')}
                      </button>
                    ) : (
                      <button
                        onClick={() => handleSetDefault(p.id)}
                        className="soft-button soft-button-secondary text-xs"
                        disabled={pendingAction !== null}
                      >
                        {t('preset.setDefault')}
                      </button>
                    )}
                    <Link href={`/settings/prompt-presets/${p.id}`} className="soft-button soft-button-primary text-xs">
                      {t('preset.manage')}
                    </Link>
                    <button
                      onClick={() => handleDelete(p)}
                      className="soft-button soft-button-danger text-xs"
                      title={t('preset.delete')}
                      disabled={pendingAction !== null}
                    >
                      <TrashIcon className="h-3.5 w-3.5" />
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </div>
  );
}
