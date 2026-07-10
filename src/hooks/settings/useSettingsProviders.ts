'use client';

import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import type { ApiProvider, Settings } from '@/types';
import { expectOkResponse, getErrorMessage, parseJsonResponse } from '@/lib/http';

interface UseSettingsProvidersOptions<TSettings extends Settings> {
  settings: TSettings;
  setSettings: Dispatch<SetStateAction<TSettings>>;
  mergeSettings: (settings: Partial<TSettings>) => TSettings;
  t: (key: string) => string;
  showToast: (message: string, type: 'success' | 'error') => void;
  resetModels: () => void;
}

export function useSettingsProviders<TSettings extends Settings>({
  settings,
  setSettings,
  mergeSettings,
  t,
  showToast,
  resetModels,
}: UseSettingsProvidersOptions<TSettings>) {
  const [providers, setProviders] = useState<ApiProvider[]>([]);
  const [activeProviderId, setActiveProviderId] = useState('');
  const [editingProvider, setEditingProvider] = useState<Partial<ApiProvider> | null>(null);
  const activationSequence = useRef(0);
  const activationQueue = useRef<Promise<void>>(Promise.resolve());

  const loadProviders = useCallback(async () => {
    try {
      const data = await parseJsonResponse<{ providers?: ApiProvider[]; active_provider_id?: string }>(await fetch('/api/providers'));
      setProviders(data.providers || []);
      setActiveProviderId(data.active_provider_id || '');
    } catch (err) {
      showToast(`${t('common.loadFailed')}: ${getErrorMessage(err)}`, 'error');
    }
  }, [showToast, t]);

  useEffect(() => {
    queueMicrotask(() => void loadProviders());
  }, [loadProviders]);

  const handleActivateProvider = useCallback(async (id: string) => {
    const sequence = ++activationSequence.current;
    const operation = activationQueue.current.then(async () => {
      try {
        await expectOkResponse(await fetch('/api/providers/activate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id }),
        }));
        const next = await parseJsonResponse<Partial<TSettings>>(await fetch('/api/settings'));
        if (sequence !== activationSequence.current) return;
        setSettings(mergeSettings(next));
        setActiveProviderId(id);
        resetModels();
      } catch (err) {
        if (sequence === activationSequence.current) {
          showToast(`${t('common.operationFailed')}: ${getErrorMessage(err)}`, 'error');
        }
      }
    });
    activationQueue.current = operation.catch(() => {});
    await operation;
  }, [mergeSettings, resetModels, setSettings, showToast, t]);

  const handleDeleteProvider = useCallback(async (id: string) => {
    if (!window.confirm(t('settings.providerDeleteConfirm'))) return;
    try {
      await expectOkResponse(await fetch(`/api/providers?id=${id}`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
      }));
      void loadProviders();
    } catch (err) {
      showToast(`${t('common.operationFailed')}: ${getErrorMessage(err)}`, 'error');
    }
  }, [loadProviders, showToast, t]);

  const handleSaveProvider = useCallback(async () => {
    if (!editingProvider) return;
    try {
      await expectOkResponse(await fetch('/api/providers', {
        method: editingProvider.id ? 'PUT' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...editingProvider, save_as_current: true }),
      }));
      setEditingProvider(null);
      void loadProviders();
      const next = await parseJsonResponse<Partial<TSettings>>(await fetch('/api/settings'));
      setSettings(mergeSettings(next));
    } catch (err) {
      showToast(`${t('settings.saveFailed')}: ${getErrorMessage(err)}`, 'error');
    }
  }, [editingProvider, loadProviders, mergeSettings, setSettings, showToast, t]);

  const saveCurrent = useCallback(async (id?: string) => {
    const name = id ? undefined : window.prompt(t('settings.providerNamePrompt'));
    if (!id && !name) return;
    try {
      await expectOkResponse(await fetch('/api/providers', {
        method: id ? 'PUT' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...(id ? { id } : { name }),
          api_base: settings.api_base,
          api_key: settings.api_key,
          model: settings.model,
          temperature: settings.temperature,
          max_tokens: settings.max_tokens,
          context_window: settings.context_window,
          json_mode: settings.json_mode,
          save_as_current: true,
        }),
      }));
      void loadProviders();
      showToast(t('settings.saveSuccess'), 'success');
    } catch (err) {
      showToast(`${t('settings.saveFailed')}: ${getErrorMessage(err)}`, 'error');
    }
  }, [loadProviders, settings, showToast, t]);

  return {
    providers,
    activeProviderId,
    editingProvider,
    setEditingProvider,
    loadProviders,
    handleActivateProvider,
    handleDeleteProvider,
    handleSaveProvider,
    handleSaveCurrentAsProvider: () => saveCurrent(),
    handleUpdateCurrentProvider: () => saveCurrent(activeProviderId),
  };
}
