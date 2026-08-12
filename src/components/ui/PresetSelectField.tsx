'use client';

import { useEffect, useState } from 'react';
import { useTranslation } from '@/lib/i18n-context';

/** 与服务端 PRESET_ID_NONE 对齐；客户端组件避免导入含 db 的 prompt-presets 模块。 */
const PRESET_ID_NONE = '__none__';

interface PresetSummary {
  id: string;
  name: string;
  entry_count?: number;
}

interface Props {
  /**
   * 当前绑定值：null / '__none__' = 不使用预设；其他字符串 = 具体预设 id。
   * 历史数据中的 null 与 '__none__' 在 UI 上统一显示为「不使用预设」。
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

  const uiValue = value == null || value === '' ? PRESET_ID_NONE : value;

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
          const nextValue = e.target.value;
          onChange(nextValue === PRESET_ID_NONE ? PRESET_ID_NONE : nextValue);
        }}
      >
        <option value={PRESET_ID_NONE}>
          {t('preset.optionDisablePreset')}
        </option>
        {presets.map(presetSummary => (
          <option key={presetSummary.id} value={presetSummary.id}>
            {presetSummary.name}{typeof presetSummary.entry_count === 'number' ? ` (${presetSummary.entry_count})` : ''}
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
