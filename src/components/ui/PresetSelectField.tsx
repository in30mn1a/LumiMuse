'use client';

import { useEffect, useState } from 'react';
import { useTranslation } from '@/lib/i18n-context';

interface PresetSummary {
  id: string;
  name: string;
  entry_count?: number;
}

interface Props {
  /**
   * 当前绑定值：null=跟随全局默认 / '__none__'=禁用 / 其他字符串=具体预设 id。
   * 注意：DB 列 active_preset_id 在「跟随全局默认」语义下为 NULL；
   * UI 用空字符串 '' 与 null 之间的互转（这里接受 null，向下游 onChange 交出 null/string）。
   */
  value: string | null;
  onChange: (nextValue: string | null) => void;
}

export default function PresetSelectField({ value, onChange }: Props) {
  const { t } = useTranslation();
  const [presets, setPresets] = useState<PresetSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();
    (async () => {
      try {
        const res = await fetch('/api/prompt-presets', { signal: controller.signal });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        if (!cancelled) setPresets(Array.isArray(data.presets) ? data.presets : []);
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

  // null → '__follow_global__'（UI 内部表示）
  const uiValue = value === null ? '__follow_global__' : value;

  return (
    <div>
      <label htmlFor="character-prompt-preset" className="mb-2 block text-sm font-medium text-text-secondary">
        {t('preset.fieldLabel')}
      </label>
      <p className="mb-2 text-xs leading-relaxed text-text-muted">
        {t('preset.fieldHint')}
      </p>
      <select
        id="character-prompt-preset"
        className="input-rich"
        disabled={loading || !!error}
        value={uiValue}
        onChange={(e) => {
          const v = e.target.value;
          if (v === '__follow_global__') onChange(null);
          else onChange(v);
        }}
      >
        <option value="__follow_global__">
          {t('preset.optionFollowGlobal')}
        </option>
        <option value="__none__">
          {t('preset.optionDisablePreset')}
        </option>
        {presets.map(p => (
          <option key={p.id} value={p.id}>
            {p.name}{typeof p.entry_count === 'number' ? ` (${p.entry_count})` : ''}
          </option>
        ))}
      </select>
      {loading && (
        <p className="mt-1 text-xs text-text-muted">{t('preset.loading')}</p>
      )}
      {error && (
        <p className="mt-1 text-xs text-red-500">{t('preset.loadError')}: {error}</p>
      )}
    </div>
  );
}
