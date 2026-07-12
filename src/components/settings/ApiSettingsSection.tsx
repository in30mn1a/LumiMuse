'use client';

import type { Settings } from '@/types';

interface ApiSettingsSectionProps {
  settings: Settings;
  activeProviderId: string;
  modelList: string[];
  modelLoading: boolean;
  modelError: string | null;
  update: <K extends keyof Settings>(key: K, value: Settings[K]) => void;
  onFetchModels: () => void;
  t: (key: string) => string;
}

export function ApiSettingsSection({
  settings,
  activeProviderId,
  modelList,
  modelLoading,
  modelError,
  update,
  onFetchModels,
  t,
}: ApiSettingsSectionProps) {
  return (
    <section className="surface-panel p-5">
      <div className="mb-4">
        <h2 className="section-title text-lg">{t('settings.api')}</h2>
        {activeProviderId && (
          <p className="mt-1 text-xs text-text-muted">{t('settings.apiFromProvider')}</p>
        )}
      </div>

      <div className="space-y-4">
        <div>
          <label htmlFor="settings-api-base" className="mb-2 block text-sm font-medium text-text-secondary">{t('settings.apiBase')}</label>
          <input
            id="settings-api-base"
            value={settings.api_base}
            onChange={event => update('api_base', event.target.value)}
            className="input-rich"
            placeholder={t('settings.apiBasePlaceholder')}
          />
        </div>

        <div>
          <label htmlFor="settings-api-key" className="mb-2 block text-sm font-medium text-text-secondary">{t('settings.apiKey')}</label>
          <input
            id="settings-api-key"
            type="password"
            value={settings.api_key}
            onChange={event => update('api_key', event.target.value)}
            className="input-rich"
          />
          <p className="mt-2 text-xs text-text-muted">{t('settings.apiKeyHint')}</p>
        </div>

        <div>
          <label htmlFor="settings-model" className="mb-2 block text-sm font-medium text-text-secondary">{t('settings.model')}</label>
          <div className="flex flex-col gap-2 lg:flex-row">
            {modelList.length > 0 ? (
              <select
                id="settings-model"
                value={settings.model}
                onChange={event => update('model', event.target.value)}
                className="select-rich flex-1"
              >
                <option value="">{t('settings.modelSelectPlaceholder')}</option>
                {modelList.map(model => (
                  <option key={model} value={model}>{model}</option>
                ))}
              </select>
            ) : (
              <input
                id="settings-model"
                value={settings.model}
                onChange={event => update('model', event.target.value)}
                className="input-rich flex-1"
                placeholder={t('settings.modelPlaceholder')}
              />
            )}
            <button
              type="button"
              onClick={onFetchModels}
              disabled={modelLoading}
              className="soft-button soft-button-secondary shrink-0 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {modelLoading ? t('common.loading') : t('settings.fetchModels')}
            </button>
          </div>
          {modelError && <p className="mt-2 text-xs text-red-500">{modelError}</p>}
        </div>

        <div className="rounded-2xl border border-border-light bg-white/70 px-4 py-3">
          <label className="flex items-center gap-3 text-sm text-text-secondary">
            <input
              type="checkbox"
              checked={settings.json_mode}
              onChange={event => update('json_mode', event.target.checked)}
            />
            {t('settings.jsonMode')}
          </label>
          <p className="mt-2 text-xs leading-relaxed text-text-muted">
            {t('settings.jsonModeHint')}
          </p>
        </div>
      </div>
    </section>
  );
}
