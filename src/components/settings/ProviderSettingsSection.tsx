'use client';

import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import type { ApiProvider } from '@/types';
import { MoreVerticalIcon, PlusIcon } from '@/components/ui/icons';
import { formatTemplate } from '@/lib/i18n';

interface ProviderSettingsSectionProps {
  providers: ApiProvider[];
  activeProviderId: string;
  editingProvider: Partial<ApiProvider> | null;
  setEditingProvider: Dispatch<SetStateAction<Partial<ApiProvider> | null>>;
  onActivateProvider: (id: string) => void;
  onDeleteProvider: (id: string) => void;
  onSaveProvider: () => void;
  onSaveCurrentAsProvider: () => void;
  parseNumber: (value: string) => number;
  t: (key: string) => string;
  busy?: boolean;
  loading?: boolean;
  error?: string | null;
  onRetry?: () => void;
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
  parseNumber,
  t,
  busy = false,
  loading = false,
  error = null,
  onRetry,
}: ProviderSettingsSectionProps) {
  const [menuId, setMenuId] = useState<string | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuTriggerRef = useRef<HTMLButtonElement | null>(null);
  const closeMenu = () => {
    setMenuId(null);
    menuTriggerRef.current?.focus();
  };
  useEffect(() => {
    if (!menuId) return;
    menuRef.current?.querySelector<HTMLButtonElement>('button')?.focus();
    const onPointerDown = (event: PointerEvent) => {
      if (!menuRef.current?.contains(event.target as Node) && !menuTriggerRef.current?.contains(event.target as Node)) {
        setMenuId(null);
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        setMenuId(null);
        menuTriggerRef.current?.focus();
      }
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [menuId]);

  return (
    <section className="surface-panel p-5">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <h2 className="section-title text-lg">{t('settings.providerManage')}</h2>
        <button
          onClick={onSaveCurrentAsProvider}
          disabled={busy}
          className="soft-button soft-button-secondary text-xs"
        >
          {t('settings.providerSaveCurrent')}
        </button>
      </div>

      {loading && providers.length === 0 ? (
        <p role="status" className="flex items-center gap-2 text-sm text-text-secondary"><span className="spinner-sm" aria-hidden="true" />{t('settings.providerLoading')}</p>
      ) : error ? (
        <div role="alert" className="space-y-2 text-sm text-danger">
          <p>{t('settings.providerLoadingFailed')}: {error}</p>
          {onRetry && <button type="button" onClick={onRetry} className="soft-button soft-button-secondary">{t('common.retry')}</button>}
        </div>
      ) : providers.length === 0 ? (
        <p className="text-sm text-text-muted">{t('settings.providerEmpty')}</p>
      ) : (
        <div className="space-y-2" role="radiogroup" aria-label={t('settings.providerManage')}>
          {providers.map(provider => (
            <div
              key={provider.id}
              className={`relative flex items-center gap-2 rounded-2xl border pl-4 pr-2 transition-colors ${
                provider.id === activeProviderId
                  ? 'border-accent/30 bg-accent/8'
                  : 'border-border-light bg-surface/70 hover:border-accent/20'
              }`}
            >
              <label className="flex min-h-14 min-w-0 flex-1 cursor-pointer items-center gap-3 py-3">
                <input type="radio" name="settings-provider" checked={provider.id === activeProviderId} disabled={busy} aria-label={provider.name} onChange={() => onActivateProvider(provider.id)} className="h-4 w-4 shrink-0 accent-accent" />
                <span className="min-w-0 flex-1">
                <span className="flex flex-wrap items-center gap-2">
                  <span className="break-words text-sm font-medium text-text-primary">{provider.name}</span>
                  {provider.id === activeProviderId && (
                    <span className="rounded-full bg-accent/15 px-2 py-0.5 text-xs font-medium text-accent-dark">
                      {t('settings.providerActive')}
                    </span>
                  )}
                </span>
                <span className="mt-0.5 block truncate text-xs text-text-muted">
                  {provider.api_base} · {provider.model || t('settings.modelPlaceholder')}
                </span>
                </span>
              </label>
                <button
                  type="button"
                  disabled={busy}
                  aria-label={formatTemplate(t('settings.providerActions'), { name: provider.name })}
                  aria-expanded={menuId === provider.id}
                  aria-controls={menuId === provider.id ? `provider-actions-${provider.id}` : undefined}
                  onClick={event => {
                    menuTriggerRef.current = event.currentTarget;
                    setMenuId(previous => previous === provider.id ? null : provider.id);
                  }}
                  className="flex min-h-11 min-w-11 shrink-0 items-center justify-center rounded-xl text-text-secondary hover:bg-surface-2 disabled:opacity-50"
                >
                  <MoreVerticalIcon className="h-5 w-5" />
                </button>
                {menuId === provider.id && <div ref={menuRef} id={`provider-actions-${provider.id}`} className="absolute right-2 top-[calc(100%-0.25rem)] z-20 min-w-36 rounded-xl border border-border-light bg-surface p-1 shadow-lg">
                <button type="button" onClick={() => { closeMenu(); setEditingProvider({ ...provider }); }} className="flex min-h-11 w-full items-center rounded-lg px-3 text-sm text-text-secondary hover:bg-surface-2">{t('common.edit')}</button>
                <button
                  type="button"
                  onClick={() => { closeMenu(); onDeleteProvider(provider.id); }}
                  className="flex min-h-11 w-full items-center rounded-lg px-3 text-sm text-danger hover:bg-surface-2"
                >
                  {t('common.delete')}
                </button>
                </div>}
            </div>
          ))}
        </div>
      )}

      <button type="button" disabled={busy} onClick={() => setEditingProvider({ name: '', api_base: '', api_key: '', model: '', temperature: 1, max_tokens: 4096, context_window: 131072, json_mode: false })} className="mt-3 flex min-h-11 items-center gap-2 rounded-xl px-3 text-sm text-accent-dark hover:bg-surface-2 disabled:opacity-50"><PlusIcon className="h-4 w-4" />{t('settings.providerAdd')}</button>

      {editingProvider && (
        <fieldset disabled={busy} className="mt-4 space-y-3 rounded-2xl border border-accent/20 bg-surface/80 px-4 py-4">
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
          <div className="grid gap-3 sm:grid-cols-3">
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
        </fieldset>
      )}
    </section>
  );
}
