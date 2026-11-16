'use client';

import {
  DEFAULT_WEB_SEARCH_SETTINGS,
  Settings,
  WEB_SEARCH_PROVIDER_ENV_KEYS,
  WEB_SEARCH_PROVIDER_IDS,
  WebSearchProviderId,
  WebSearchSettings,
} from '@/types';
import { SearchIcon } from '@/components/ui/icons';
import NumberInput from '@/components/ui/NumberInput';

export function WebSearchSettingsSection({
  settings,
  update,
  t,
}: {
  settings: Settings;
  update: (key: 'web_search', value: WebSearchSettings) => void;
  t: (key: string) => string;
}) {
  const webSearch = settings.web_search || DEFAULT_WEB_SEARCH_SETTINGS;
  const set = <K extends keyof WebSearchSettings>(key: K, value: WebSearchSettings[K]) => {
    update('web_search', { ...webSearch, [key]: value });
  };
  const provider = webSearch.provider;
  const providerName = (id: WebSearchProviderId) => t(`settings.webSearchProvider.${id}`);
  // 两个数值都必须是正整数；清空或填 0 时不提交，输入框失焦后回到原值。
  const setPositiveInt = (key: 'summary_target_chars' | 'max_rounds', value: number) => {
    if (Number.isInteger(value) && value > 0) set(key, value);
  };

  return (
    <section className="surface-panel p-5">
      <div className="mb-2 flex items-center gap-3">
        <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-accent/10 text-accent-dark">
          <SearchIcon className="h-4 w-4" />
        </div>
        <h2 className="section-title text-lg">{t('settings.webSearch')}</h2>
      </div>
      <p className="mb-4 text-sm leading-relaxed text-text-muted">{t('settings.webSearchHint')}</p>

      <label className="flex items-center gap-3 rounded-2xl border border-border-light bg-surface/70 px-4 py-3 text-sm text-text-secondary">
        <input
          type="checkbox"
          checked={webSearch.enabled}
          onChange={e => set('enabled', e.target.checked)}
        />
        {t('settings.webSearchEnabled')}
      </label>

      {webSearch.enabled && (
      <div className="mt-3 space-y-3 rounded-2xl border border-border-light bg-surface/70 px-4 py-4">
        <div>
          <label htmlFor="settings-web-search-provider" className="mb-1.5 block text-sm font-medium text-text-secondary">{t('settings.webSearchProvider')}</label>
          <select
            id="settings-web-search-provider"
            value={provider}
            onChange={e => set('provider', e.target.value as WebSearchProviderId)}
            className="select-rich"
          >
            {WEB_SEARCH_PROVIDER_IDS.map(id => <option key={id} value={id}>{providerName(id)}</option>)}
          </select>
        </div>
        <div>
          <label htmlFor="settings-web-search-key" className="mb-1.5 block text-sm font-medium text-text-secondary">{t('settings.webSearchApiKey').replace('{provider}', providerName(provider))}</label>
          <input
            id="settings-web-search-key"
            type="password"
            autoComplete="off"
            value={webSearch.api_keys[provider]}
            onChange={e => set('api_keys', { ...webSearch.api_keys, [provider]: e.target.value })}
            className="input-rich"
          />
          <p className="mt-1.5 text-xs text-text-muted">{t('settings.webSearchApiKeyHint').replace('{env}', WEB_SEARCH_PROVIDER_ENV_KEYS[provider])}</p>
        </div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div>
            <label htmlFor="settings-web-search-summary" className="mb-1.5 block text-sm font-medium text-text-secondary">{t('settings.webSearchSummaryChars')}</label>
            <NumberInput id="settings-web-search-summary" min="1" step="100" value={webSearch.summary_target_chars} onValueChange={v => setPositiveInt('summary_target_chars', v)} className="input-rich" />
            <p className="mt-1.5 text-xs text-text-muted">{t('settings.webSearchSummaryCharsHint')}</p>
          </div>
          <div>
            <label htmlFor="settings-web-search-rounds" className="mb-1.5 block text-sm font-medium text-text-secondary">{t('settings.webSearchMaxRounds')}</label>
            <NumberInput id="settings-web-search-rounds" min="1" step="1" value={webSearch.max_rounds} onValueChange={v => setPositiveInt('max_rounds', v)} className="input-rich" />
            <p className="mt-1.5 text-xs text-text-muted">{t('settings.webSearchMaxRoundsHint')}</p>
          </div>
        </div>
      </div>
      )}
    </section>
  );
}
