import { useId } from 'react';
import Link from 'next/link';
import { formatTemplate } from '@/lib/i18n';
import type { PresetImportWarning } from '@/types';

interface Props {
  total: number;
  enabled: number;
  warnings?: PresetImportWarning[];
  importedPreset?: { id: string; name: string };
  t: (key: string) => string;
}

/** code 型说明按当前语言渲染；纯字符串（旧版或外部来源）原样显示。 */
function formatWarning(warning: unknown, t: Props['t']): string | null {
  if (typeof warning === 'string') return warning;
  if (!warning || typeof warning !== 'object') return null;
  const { code, params } = warning as { code?: unknown; params?: unknown };
  if (typeof code !== 'string') return null;
  const values: Record<string, string> = {};
  if (params && typeof params === 'object') {
    for (const [key, value] of Object.entries(params)) {
      if (typeof value === 'string') values[key] = value;
    }
  }
  const key = `preset.warning.${code}`;
  const template = t(key);
  if (template !== key) return formatTemplate(template, values);
  const details = Object.entries(values).map(([name, value]) => `${name}=${value}`).join(', ');
  return formatTemplate(t('preset.warning.unknown'), { code, details }).trim();
}

export default function PresetCompatibilityReport({ total, enabled, warnings, importedPreset, t }: Props) {
  const headingId = useId();
  const warningList = Array.isArray(warnings)
    ? warnings.map(warning => formatWarning(warning, t)).filter((text): text is string => text !== null)
    : [];
  // 详情页只在有说明或「有条目却全部未启用」时出现；新建的空预设不提示。
  if (!importedPreset && warningList.length === 0 && (enabled > 0 || total === 0)) return null;

  return (
    <section
      className="surface-panel min-w-0 p-5"
      aria-labelledby={headingId}
      role={importedPreset ? 'status' : undefined}
      aria-live={importedPreset ? 'polite' : undefined}
    >
      <h2 id={headingId} className="text-base font-semibold text-text-primary">
        {t(importedPreset ? 'preset.importReport' : 'preset.compatibilityReport')}
      </h2>
      {importedPreset && (
        <p className="mt-2 break-words text-sm text-text-primary">
          {formatTemplate(t('preset.importReportName'), { name: importedPreset.name })}
        </p>
      )}
      <p className="mt-1 text-sm text-text-secondary">
        {formatTemplate(t('preset.entryCount'), { total, enabled })}
      </p>
      {enabled === 0 && (
        <p className="mt-3 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-200">
          {t('preset.noEnabledEntries')}
        </p>
      )}
      {warningList.length > 0 && (
        <div className="mt-3">
          <h3 className="text-sm font-medium text-text-primary">{t('preset.importWarnings')}</h3>
          <p className="mt-1 text-xs leading-relaxed text-text-muted">{t('preset.importWarningsHint')}</p>
          <ul className="mt-2 list-disc space-y-2 pl-5 text-sm leading-relaxed text-text-secondary">
            {warningList.map((warning, index) => <li key={index} className="break-words">{warning}</li>)}
          </ul>
        </div>
      )}
      {importedPreset && (
        <Link href={`/settings/prompt-presets/${importedPreset.id}`} className="soft-button soft-button-secondary mt-3 text-xs">
          {t('preset.manage')}
        </Link>
      )}
    </section>
  );
}
