'use client';

import type { Dispatch, SetStateAction } from 'react';
import type { ApiProvider } from '@/types';

interface ProviderSettingsSectionProps {
  providers: ApiProvider[];
  activeProviderId: string;
  editingProvider: Partial<ApiProvider> | null;
  setEditingProvider: Dispatch<SetStateAction<Partial<ApiProvider> | null>>;
  onActivateProvider: (id: string) => void;
  onDeleteProvider: (id: string) => void;
  onSaveProvider: () => void;
  onSaveCurrentAsProvider: () => void;
  onUpdateCurrentProvider: () => void;
  parseNumber: (value: string) => number;
  t: (key: string) => string;
}

export function ProviderSettingsSection({
  providers,
  activeProviderId,
  editingProvider,
  setEditingProvider,
  onActivateProvider,
  onDeleteProvider,
  onSaveProvider,
  onSaveCurrentAsProvider,
  onUpdateCurrentProvider,
  parseNumber,
  t,
}: ProviderSettingsSectionProps) {
  return (
    <section className="surface-panel p-5">
      <div className="mb-4 flex items-center justify-between">
        <h2 className="section-title text-lg">{t('settings.providerManage')}</h2>
        <div className="flex gap-2">
          {activeProviderId && (
            <button
              onClick={onUpdateCurrentProvider}
              className="soft-button soft-button-secondary text-xs"
            >
              {t('settings.providerUpdateCurrent')}
            </button>
          )}
          <button
            onClick={onSaveCurrentAsProvider}
            className="soft-button soft-button-primary text-xs"
          >
            {t('settings.providerSaveCurrent')}
          </button>
        </div>
      </div>

      {providers.length === 0 ? (
        <p className="text-sm text-text-muted">{t('settings.providerEmpty')}</p>
      ) : (
        <div className="space-y-2">
          {providers.map(provider => (
            <div
              key={provider.id}
              className={`flex items-center gap-3 rounded-2xl border px-4 py-3 transition-colors ${
                provider.id === activeProviderId
                  ? 'border-accent/30 bg-accent/8'
                  : 'border-border-light bg-white/70 hover:border-accent/20'
              }`}
            >
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium text-text-primary">{provider.name}</span>
                  {provider.id === activeProviderId && (
                    <span className="rounded-full bg-accent/15 px-2 py-0.5 text-[10px] font-medium text-accent-dark">
                      {t('settings.providerActive')}
                    </span>
                  )}
                </div>
                <div className="mt-0.5 truncate text-xs text-text-muted">
                  {provider.api_base} · {provider.model || t('settings.modelPlaceholder')}
                </div>
              </div>
              <div className="flex shrink-0 gap-1.5">
                {provider.id !== activeProviderId && (
                  <button
                    onClick={() => onActivateProvider(provider.id)}
                    className="soft-button soft-button-primary px-2.5 py-1 text-xs"
                  >
                    {t('settings.providerSwitch')}
                  </button>
                )}
                <button
                  onClick={() => setEditingProvider({ ...provider })}
                  className="soft-button soft-button-secondary px-2.5 py-1 text-xs"
                >
                  {t('common.edit')}
                </button>
                <button
                  onClick={() => onDeleteProvider(provider.id)}
                  className="soft-button soft-button-danger px-2.5 py-1 text-xs"
                >
                  {t('common.delete')}
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {editingProvider && (
        <div className="mt-4 space-y-3 rounded-2xl border border-accent/20 bg-white/80 px-4 py-4">
          <h3 className="text-sm font-medium text-text-primary">
            {editingProvider.id ? t('settings.providerEdit') : t('settings.providerNew')}
          </h3>
          <div>
            <label htmlFor="settings-provider-name" className="mb-1.5 block text-xs font-medium text-text-secondary">{t('settings.providerName')}</label>
            <input
              id="settings-provider-name"
              value={editingProvider.name || ''}
              onChange={event => setEditingProvider(previous => previous ? { ...previous, name: event.target.value } : null)}
              className="input-rich"
              placeholder="OpenAI"
            />
          </div>
          <div>
            <label htmlFor="settings-provider-api-base" className="mb-1.5 block text-xs font-medium text-text-secondary">{t('settings.apiBase')}</label>
            <input
              id="settings-provider-api-base"
              value={editingProvider.api_base || ''}
              onChange={event => setEditingProvider(previous => previous ? { ...previous, api_base: event.target.value } : null)}
              className="input-rich"
              placeholder={t('settings.apiBasePlaceholder')}
            />
          </div>
          <div>
            <label htmlFor="settings-provider-api-key" className="mb-1.5 block text-xs font-medium text-text-secondary">{t('settings.apiKey')}</label>
            <input
              id="settings-provider-api-key"
              type="password"
              value={editingProvider.api_key || ''}
              onChange={event => setEditingProvider(previous => previous ? { ...previous, api_key: event.target.value } : null)}
              className="input-rich"
            />
          </div>
          <div>
            <label htmlFor="settings-provider-model" className="mb-1.5 block text-xs font-medium text-text-secondary">{t('settings.model')}</label>
            <input
              id="settings-provider-model"
              value={editingProvider.model || ''}
              onChange={event => setEditingProvider(previous => previous ? { ...previous, model: event.target.value } : null)}
              className="input-rich"
              placeholder={t('settings.modelPlaceholder')}
            />
          </div>
          <div className="grid grid-cols-3 gap-3">
            <div>
              <label htmlFor="settings-provider-temperature" className="mb-1.5 block text-xs font-medium text-text-secondary">{t('settings.temperature')}</label>
              <input
                id="settings-provider-temperature"
                type="number"
                min="0"
                max="2"
                step="0.1"
                value={editingProvider.temperature ?? 1}
                onChange={event => setEditingProvider(previous => previous ? { ...previous, temperature: parseNumber(event.target.value) } : null)}
                className="input-rich"
              />
            </div>
            <div>
              <label htmlFor="settings-provider-max-tokens" className="mb-1.5 block text-xs font-medium text-text-secondary">{t('settings.maxTokens')}</label>
              <input
                id="settings-provider-max-tokens"
                type="number"
                min="1"
                value={editingProvider.max_tokens ?? 4096}
                onChange={event => setEditingProvider(previous => previous ? { ...previous, max_tokens: parseNumber(event.target.value) } : null)}
                className="input-rich"
              />
            </div>
            <div>
              <label htmlFor="settings-provider-context-window" className="mb-1.5 block text-xs font-medium text-text-secondary">{t('settings.contextWindow')}</label>
              <input
                id="settings-provider-context-window"
                type="number"
                min="1"
                value={editingProvider.context_window ?? 131072}
                onChange={event => setEditingProvider(previous => previous ? { ...previous, context_window: parseNumber(event.target.value) } : null)}
                className="input-rich"
              />
            </div>
          </div>
          <div className="flex gap-2">
            <button onClick={onSaveProvider} className="soft-button soft-button-primary text-xs">
              {t('common.save')}
            </button>
            <button onClick={() => setEditingProvider(null)} className="soft-button soft-button-secondary text-xs">
              {t('common.cancel')}
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
