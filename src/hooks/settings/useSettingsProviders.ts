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
  const [providerBusy, setProviderBusy] = useState(false);
  const [providersLoading, setProvidersLoading] = useState(true);
  const [providersError, setProvidersError] = useState<string | null>(null);
  const activationSequence = useRef(0);
  const writeQueue = useRef<Promise<void>>(Promise.resolve());
  const pendingWrites = useRef(0);
  const writeRevision = useRef(0);
  const loadSequence = useRef(0);
  const tRef = useRef(t);
  useEffect(() => { tRef.current = t; }, [t]);

  // 所有会写设置的供应商操作共用队列，统一保存的两次请求不会被切换插入。
  const runProviderOperation = useCallback(<T,>(operation: () => Promise<T>): Promise<T> => {
    pendingWrites.current += 1;
    writeRevision.current += 1;
    setProviderBusy(true);
    const result = writeQueue.current.then(operation);
    writeQueue.current = result.then(() => {}, () => {});
    return result.finally(() => {
      pendingWrites.current -= 1;
      setProviderBusy(pendingWrites.current > 0);
    });
  }, []);
  const isProviderOperationPending = useCallback(() => pendingWrites.current > 0, []);

  const loadProviders = useCallback(async (activatedId?: string) => {
    const sequence = ++loadSequence.current;
    const revision = writeRevision.current;
    setProvidersLoading(true);
    try {
      const data = await parseJsonResponse<{ providers?: ApiProvider[]; active_provider_id?: string }>(await fetch('/api/providers'));
      if (sequence !== loadSequence.current || revision !== writeRevision.current) return;
      setProviders(data.providers || []);
      setActiveProviderId(activatedId ?? data.active_provider_id ?? '');
      setProvidersError(null);
    } catch (err) {
      if (sequence !== loadSequence.current || revision !== writeRevision.current) return;
      const message = getErrorMessage(err);
      setProvidersError(message);
      showToast(`${tRef.current('common.loadFailed')}: ${message}`, 'error');
    } finally {
      // loading 只按「是否还有更新的加载」收敛：写操作让本次结果作废时，
      // 不能连 loading 一起挂住，否则保存按钮会永久锁死。
      if (sequence === loadSequence.current) setProvidersLoading(false);
    }
  }, [showToast]);

  useEffect(() => {
    queueMicrotask(() => void loadProviders());
  }, [loadProviders]);

  const handleActivateProvider = useCallback(async (id: string) => {
    const sequence = ++activationSequence.current;
    await runProviderOperation(async () => {
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
        setEditingProvider(null);
        resetModels();
        await loadProviders(id);
      } catch (err) {
        if (sequence === activationSequence.current) {
          showToast(`${t('common.operationFailed')}: ${getErrorMessage(err)}`, 'error');
        }
      }
    });
  }, [loadProviders, mergeSettings, resetModels, runProviderOperation, setSettings, showToast, t]);

  const handleDeleteProvider = useCallback(async (id: string) => {
    if (!window.confirm(t('settings.providerDeleteConfirm'))) return;
    try {
      await runProviderOperation(async () => {
        await expectOkResponse(await fetch(`/api/providers?id=${id}`, {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
        }));
        if (id === activeProviderId) setSettings(previous => ({ ...previous, active_provider_id: '' }));
        await loadProviders();
      });
    } catch (err) {
      showToast(`${t('common.operationFailed')}: ${getErrorMessage(err)}`, 'error');
    }
  }, [activeProviderId, loadProviders, runProviderOperation, setSettings, showToast, t]);

  const handleSaveProvider = useCallback(async () => {
    if (!editingProvider) return;
    try {
      await runProviderOperation(async () => {
        await expectOkResponse(await fetch('/api/providers', {
          method: editingProvider.id ? 'PUT' : 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ...editingProvider, save_as_current: true }),
        }));
        const next = await parseJsonResponse<Partial<TSettings>>(await fetch('/api/settings'));
        setSettings(mergeSettings(next));
        setEditingProvider(null);
        resetModels();
        await loadProviders();
      });
    } catch (err) {
      showToast(`${t('settings.saveFailed')}: ${getErrorMessage(err)}`, 'error');
    }
  }, [editingProvider, loadProviders, mergeSettings, resetModels, runProviderOperation, setSettings, showToast, t]);

  const writeCurrentProvider = useCallback(async (id: string) => {
    // 由统一保存队列调用，不能再次排队等待自己完成。
    // 接口字段与密钥由服务端从刚保存的设置里读取，这里只需指明目标供应商。
    await expectOkResponse(await fetch('/api/providers', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, sync_from_settings: true }),
    }));
    await loadProviders();
  }, [loadProviders]);

  const handleSaveCurrentAsProvider = useCallback(async () => {
    const name = window.prompt(t('settings.providerNamePrompt'));
    if (!name) return;
    const snapshot = settings;
    try {
      await runProviderOperation(async () => {
        await expectOkResponse(await fetch('/api/providers', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name,
            api_base: snapshot.api_base,
            api_key: snapshot.api_key,
            model: snapshot.model,
            temperature: snapshot.temperature,
            max_tokens: snapshot.max_tokens,
            context_window: snapshot.context_window,
            json_mode: snapshot.json_mode,
            save_as_current: true,
          }),
        }));
        const next = await parseJsonResponse<Partial<TSettings>>(await fetch('/api/settings'));
        setSettings(mergeSettings(next));
        await loadProviders();
      });
      showToast(t('settings.saveSuccess'), 'success');
    } catch (err) {
      showToast(`${t('settings.saveFailed')}: ${getErrorMessage(err)}`, 'error');
    }
  }, [loadProviders, mergeSettings, runProviderOperation, setSettings, settings, showToast, t]);

  return {
    providers,
    activeProviderId,
    editingProvider,
    setEditingProvider,
    providerBusy,
    providersLoading,
    providersError,
    runProviderOperation,
    isProviderOperationPending,
    loadProviders,
    handleActivateProvider,
    handleDeleteProvider,
    handleSaveProvider,
    handleSaveCurrentAsProvider,
    handleUpdateCurrentProvider: writeCurrentProvider,
  };
}
