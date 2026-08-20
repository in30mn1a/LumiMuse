'use client';

import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from '@/lib/i18n-context';
import type { CharacterModelPresetBinding } from '@/types';
import { PlusIcon, TrashIcon } from '@/components/ui/icons';

const PRESET_ID_NONE = '__none__';

interface PresetSummary {
  id: string;
  name: string;
  entry_count?: number;
}

interface Props {
  value: CharacterModelPresetBinding[];
  onChange: (next: CharacterModelPresetBinding[]) => void;
}

export default function ModelPresetBindingsField({ value, onChange }: Props) {
  const { t } = useTranslation();
  const [presets, setPresets] = useState<PresetSummary[]>([]);
  const [models, setModels] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();
    (async () => {
      try {
        const [presetRes, modelRes] = await Promise.all([
          fetch('/api/prompt-presets', { signal: controller.signal }),
          fetch('/api/models', { signal: controller.signal }),
        ]);
        if (!presetRes.ok) throw new Error(`HTTP ${presetRes.status}`);
        const presetData = await presetRes.json() as { presets?: PresetSummary[] };
        let modelList: string[] = [];
        if (modelRes.ok) {
          const modelData = await modelRes.json() as { models?: string[] };
          if (Array.isArray(modelData.models)) modelList = modelData.models;
        }
        if (!cancelled) {
          setPresets(Array.isArray(presetData.presets) ? presetData.presets : []);
          setModels(modelList);
        }
      } catch (err) {
        if (controller.signal.aborted || (err instanceof Error && err.name === 'AbortError')) return;
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, []);

  const duplicateModels = useMemo(() => {
    const counts = new Map<string, number>();
    for (const row of value) {
      const key = row.model.trim();
      if (!key) continue;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return new Set([...counts.entries()].filter(([, count]) => count > 1).map(([model]) => model));
  }, [value]);

  const updateRow = (index: number, patch: Partial<CharacterModelPresetBinding>) => {
    onChange(value.map((row, rowIndex) => (rowIndex === index ? { ...row, ...patch } : row)));
  };

  return (
    <div className="mt-5 border-t border-border-light pt-5">
      <h3 className="mb-1 text-sm font-medium text-text-secondary">{t('preset.modelBindTitle')}</h3>
      <p className="mb-3 text-xs leading-relaxed text-text-muted">{t('preset.modelBindHint')}</p>

      {value.length === 0 && (
        <p className="mb-3 text-xs text-text-muted">{t('preset.modelBindEmpty')}</p>
      )}

      <datalist id="model-preset-binding-models">
        {models.map(model => (
          <option key={model} value={model} />
        ))}
      </datalist>

      <div className="space-y-3">
        {value.map((row, index) => {
          const trimmed = row.model.trim();
          const isDuplicate = trimmed !== '' && duplicateModels.has(trimmed);
          return (
            <div key={index} className="flex flex-col gap-2 sm:flex-row sm:items-end">
              <label className="min-w-0 flex-1">
                <span className="mb-1 block text-xs text-text-muted">{t('preset.modelBindModel')}</span>
                <input
                  className="input-rich"
                  list="model-preset-binding-models"
                  value={row.model}
                  maxLength={200}
                  placeholder={t('preset.modelBindModelPlaceholder')}
                  aria-invalid={isDuplicate}
                  onChange={e => updateRow(index, { model: e.target.value })}
                />
              </label>
              <label className="min-w-0 flex-1">
                <span className="mb-1 block text-xs text-text-muted">{t('preset.modelBindPreset')}</span>
                <select
                  className="input-rich"
                  disabled={loading || !!error}
                  value={row.preset_id || PRESET_ID_NONE}
                  onChange={e => updateRow(index, { preset_id: e.target.value })}
                >
                  <option value={PRESET_ID_NONE}>{t('preset.optionDisablePreset')}</option>
                  {presets.map(presetSummary => (
                    <option key={presetSummary.id} value={presetSummary.id}>
                      {presetSummary.name}{typeof presetSummary.entry_count === 'number' ? ` (${presetSummary.entry_count})` : ''}
                    </option>
                  ))}
                </select>
              </label>
              <button
                type="button"
                className="soft-button soft-button-secondary w-fit shrink-0 self-end px-3 py-2"
                title={t('preset.modelBindRemove')}
                aria-label={t('preset.modelBindRemove')}
                onClick={() => onChange(value.filter((_, rowIndex) => rowIndex !== index))}
              >
                <TrashIcon className="h-4 w-4" />
              </button>
            </div>
          );
        })}
      </div>

      {duplicateModels.size > 0 && (
        <p className="mt-2 text-xs text-red-500">{t('preset.modelBindDuplicate')}</p>
      )}
      {loading && (
        <p className="mt-2 text-xs text-text-muted">{t('preset.loading')}</p>
      )}
      {error && (
        <p className="mt-2 text-xs text-red-500">{t('preset.loadError')}: {error}</p>
      )}

      <button
        type="button"
        className="soft-button soft-button-secondary mt-3 inline-flex items-center gap-1.5 px-3 py-2 text-sm"
        onClick={() => onChange([...value, { model: '', preset_id: PRESET_ID_NONE }])}
      >
        <PlusIcon className="h-4 w-4" />
        {t('preset.modelBindAdd')}
      </button>
    </div>
  );
}
