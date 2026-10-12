import type { FontSize, FontStyle, Settings } from '@/types';
import { applyFontSize as defaultApplyFontSize, applyFontStyle as defaultApplyFontStyle } from '@/lib/font-stacks';

interface DisplaySettingsSectionProps {
  settings: Settings;
  update: <K extends keyof Settings>(key: K, value: Settings[K]) => void;
  t: (key: string) => string;
  applyFontStyle?: (style: FontStyle) => void;
  applyFontSize?: (size: FontSize) => void;
}

export function DisplaySettingsSection({
  settings,
  update,
  t,
  applyFontStyle = defaultApplyFontStyle,
  applyFontSize = defaultApplyFontSize,
}: DisplaySettingsSectionProps) {
  return (
    <section className="surface-panel p-5">
      <div className="mb-4">
        <h2 className="section-title text-lg">{t('settings.display')}</h2>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <label className="rounded-2xl border border-border-light bg-surface/70 px-4 py-4 text-sm text-text-secondary">
          <span className="mb-2 block">{t('settings.theme')}</span>
          <select
            value={settings.theme}
            onChange={e => update('theme', e.target.value as 'light' | 'dark')}
            className="select-rich"
          >
            <option value="light">{t('settings.themeLight')}</option>
            <option value="dark">{t('settings.themeDark')}</option>
          </select>
        </label>

        <label className="rounded-2xl border border-border-light bg-surface/70 px-4 py-4 text-sm text-text-secondary">
          <span className="mb-2 block">{t('settings.language')}</span>
          <select
            value={settings.language}
            onChange={e => update('language', e.target.value as 'zh' | 'en')}
            className="select-rich"
          >
            <option value="zh">{t('settings.languageZh')}</option>
            <option value="en">{t('settings.languageEn')}</option>
          </select>
        </label>

        <div className="rounded-2xl border border-border-light bg-surface/70 px-4 py-4 text-sm text-text-secondary md:col-span-2">
          <span className="mb-2 block">{t('settings.font')}</span>
          <div className="grid grid-cols-3 gap-2">
            {(['wenkai', 'system', 'serif'] as const).map((f: FontStyle) => (
              <button
                key={f}
                type="button"
                onClick={() => {
                  update('font_style', f);
                  applyFontStyle(f);
                }}
                className={`rounded-xl border px-3 py-2.5 text-center text-sm transition-colors ${
                  (settings.font_style || 'wenkai') === f
                    ? 'border-accent bg-accent/10 text-accent-dark font-medium'
                    : 'border-border-light bg-surface/50 text-text-secondary hover:border-accent/40 hover:bg-accent/5'
                }`}
              >
                <span
                  className="block text-base leading-snug"
                  style={{
                    fontFamily:
                      f === 'wenkai'
                        ? "'LXGW WenKai Screen', 'PingFang SC', sans-serif"
                        : f === 'system'
                        ? "'PingFang SC', 'Microsoft YaHei', system-ui, sans-serif"
                        : "'Noto Serif SC', 'SimSun', Georgia, serif",
                  }}
                >
                  {f === 'wenkai'
                    ? t('settings.fontNameWenkai')
                    : f === 'system'
                    ? t('settings.fontNameSystem')
                    : t('settings.fontNameSerif')}
                </span>
                <span className="mt-0.5 block text-xs text-text-muted">
                  {t(`settings.font${f.charAt(0).toUpperCase() + f.slice(1)}`)}
                </span>
              </button>
            ))}
          </div>
        </div>

        <div className="rounded-2xl border border-border-light bg-surface/70 px-4 py-4 text-sm text-text-secondary md:col-span-2">
          <span className="mb-2 block">{t('settings.fontSize')}</span>
          <div className="grid grid-cols-3 gap-2">
            {([
              { id: 'small' as const, labelKey: 'settings.fontSizeSmall', sample: '14' },
              { id: 'medium' as const, labelKey: 'settings.fontSizeMedium', sample: '16' },
              { id: 'large' as const, labelKey: 'settings.fontSizeLarge', sample: '18' },
            ] satisfies ReadonlyArray<{ id: FontSize; labelKey: string; sample: string }>).map(option => (
              <button
                key={option.id}
                type="button"
                onClick={() => {
                  update('font_size', option.id);
                  applyFontSize(option.id);
                }}
                className={`rounded-xl border px-3 py-2.5 text-center text-sm transition-colors ${
                  (settings.font_size || 'medium') === option.id
                    ? 'border-accent bg-accent/10 text-accent-dark font-medium'
                    : 'border-border-light bg-surface/50 text-text-secondary hover:border-accent/40 hover:bg-accent/5'
                }`}
              >
                <span
                  className="block leading-snug"
                  style={{ fontSize: option.id === 'small' ? '0.875rem' : option.id === 'large' ? '1.125rem' : '1rem' }}
                >
                  {t(option.labelKey)}
                </span>
                <span className="mt-0.5 block text-xs text-text-muted">{option.sample}px</span>
              </button>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}
