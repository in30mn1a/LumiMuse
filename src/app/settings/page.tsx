'use client';

import { useEffect, useState, useCallback } from 'react';
import { DEFAULT_SETTINGS, Settings, ImageGenSettings, DEFAULT_IMAGE_GEN_SETTINGS, FontStyle, ApiProvider } from '@/types';
import { applyFontStyle } from '@/lib/font-stacks';
import { useRouter } from 'next/navigation';
import { useTranslation } from '@/lib/i18n-context';
import { useToast } from '@/components/ui/Toast';
import { ArrowLeftIcon, SparkIcon, SettingsIcon, ImageIcon } from '@/components/ui/icons';

export default function SettingsPage() {
  const router = useRouter();
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [saving, setSaving] = useState<'idle' | 'saving'>('idle');
  const [modelList, setModelList] = useState<string[]>([]);
  const [modelLoading, setModelLoading] = useState(false);
  const [modelError, setModelError] = useState<string | null>(null);
  const [authEnabled, setAuthEnabled] = useState(false);
  const [providers, setProviders] = useState<ApiProvider[]>([]);
  const [activeProviderId, setActiveProviderId] = useState('');
  const [editingProvider, setEditingProvider] = useState<Partial<ApiProvider> | null>(null);
  const [activeTab, setActiveTab] = useState<'api' | 'generation' | 'memory' | 'advanced'>('api');
  const { t, setLang } = useTranslation();
  const { showToast } = useToast();

  const loadProviders = useCallback(() => {
    fetch('/api/providers').then(r => r.json()).then(data => {
      setProviders(data.providers || []);
      setActiveProviderId(data.active_provider_id || '');
    });
  }, []);

  useEffect(() => {
    fetch('/api/settings').then(r => r.json()).then(s => {
      setSettings({ ...DEFAULT_SETTINGS, ...s });
      document.documentElement.classList.toggle('dark', s.theme === 'dark');
      applyFontStyle((s.font_style || 'wenkai') as FontStyle);
    });
    fetch('/api/auth').then(r => r.json()).then(d => setAuthEnabled(d.authEnabled)).catch(() => {});
    loadProviders();
  }, [loadProviders]);

  const update = <K extends keyof Settings>(key: K, value: Settings[K]) => {
    if (typeof value === 'number' && !Number.isFinite(value)) return;
    setSettings(prev => ({ ...prev, [key]: value }));
  };

  const parseNumber = (value: string): number => {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  };

  const fetchModels = async (apiBase?: string, apiKey?: string) => {
    setModelLoading(true);
    setModelError(null);
    try {
      // 使用 POST 传递 api_key，避免敏感凭证出现在 URL / access log / 历史记录中
      const body: Record<string, unknown> = { refresh: true };
      const usingBase = apiBase || settings.api_base;
      if (usingBase) body.api_base = usingBase;
      const usingKey = (apiKey && apiKey !== '********')
        ? apiKey
        : (settings.api_key && settings.api_key !== '********' ? settings.api_key : undefined);
      if (usingKey) body.api_key = usingKey;
      const response = await fetch('/api/models', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await response.json();
      if (data.error) {
        setModelError(data.error);
      } else {
        setModelList(data.models || []);
      }
    } catch (error) {
      setModelError(String(error));
    } finally {
      setModelLoading(false);
    }
  };

  const handleSave = async () => {
    // 用 toast 替代旧的 1.2s setTimeout 状态切换：主人离开页面也能后续看到结果。
    // saving 状态仅保留用于按钮 loading 反馈。
    setSaving('saving');
    try {
      const response = await fetch('/api/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(settings),
      });
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error((data as { error?: string }).error || `HTTP ${response.status}`);
      }
      setLang(settings.language);
      document.documentElement.classList.toggle('dark', settings.theme === 'dark');
      applyFontStyle((settings.font_style || 'wenkai') as FontStyle);
      showToast(t('settings.saveSuccess'), 'success');
    } catch (err) {
      showToast(`${t('settings.saveFailed')}: ${err instanceof Error ? err.message : String(err)}`, 'error');
    } finally {
      setSaving('idle');
    }
  };

  const handleLogout = async () => {
    if (!window.confirm(t('auth.logoutConfirm'))) return;
    await fetch('/api/auth', { method: 'DELETE' });
    router.replace('/login');
  };

  const handleActivateProvider = async (id: string) => {
    await fetch('/api/providers/activate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id }),
    });
    const res = await fetch('/api/settings');
    const s = await res.json();
    setSettings({ ...DEFAULT_SETTINGS, ...s });
    setActiveProviderId(id);
    setModelList([]);
    setModelError(null);
  };

  const handleDeleteProvider = async (id: string) => {
    if (!window.confirm(t('settings.providerDeleteConfirm'))) return;
    await fetch(`/api/providers?id=${id}`, { method: 'DELETE' });
    loadProviders();
  };

  const handleSaveProvider = async () => {
    if (!editingProvider) return;
    const isEdit = !!editingProvider.id;
    const method = isEdit ? 'PUT' : 'POST';
    await fetch('/api/providers', {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...editingProvider, save_as_current: true }),
    });
    setEditingProvider(null);
    loadProviders();
    const res = await fetch('/api/settings');
    const s = await res.json();
    setSettings({ ...DEFAULT_SETTINGS, ...s });
  };

  const handleSaveCurrentAsProvider = async () => {
    const name = window.prompt(t('settings.providerNamePrompt'));
    if (!name) return;
    await fetch('/api/providers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name,
        api_base: settings.api_base,
        api_key: settings.api_key,
        model: settings.model,
        temperature: settings.temperature,
        max_tokens: settings.max_tokens,
        context_window: settings.context_window,
        json_mode: settings.json_mode,
        save_as_current: true,
      }),
    });
    loadProviders();
  };

  const handleUpdateCurrentProvider = async () => {
    if (!activeProviderId) return;
    await fetch('/api/providers', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: activeProviderId,
        api_base: settings.api_base,
        api_key: settings.api_key,
        model: settings.model,
        temperature: settings.temperature,
        max_tokens: settings.max_tokens,
        context_window: settings.context_window,
        json_mode: settings.json_mode,
        save_as_current: true,
      }),
    });
    loadProviders();
  };

  return (
    <div className="app-shell min-h-screen px-4 py-4">
      <div className="mx-auto flex max-w-7xl flex-col gap-4">
        <header className="surface-hero px-5 py-5">
          <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
            <div className="flex items-center gap-4">
              <button onClick={() => router.push('/')} className="soft-button soft-button-secondary px-3 py-2">
                <ArrowLeftIcon className="h-4 w-4" />
                {t('settings.back')}
              </button>
              <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-[rgba(155,124,240,0.12)] text-accent-dark">
                <SettingsIcon className="h-5 w-5" />
              </div>
              <h1 className="section-title text-2xl">{t('settings.title')}</h1>
            </div>

            <div className="flex items-center gap-2">
              {authEnabled && (
                <button
                  onClick={handleLogout}
                  className="soft-button soft-button-danger"
                >
                  {t('auth.logout')}
                </button>
              )}
              <button
                onClick={handleSave}
                disabled={saving !== 'idle'}
                className="soft-button soft-button-primary disabled:cursor-not-allowed disabled:opacity-60"
              >
                {saving === 'saving' ? (
                  <span className="spinner-sm" aria-hidden="true" />
                ) : (
                  <SparkIcon className="h-4 w-4" />
                )}
                {saving === 'saving' ? t('settings.saving') : t('settings.save')}
              </button>
            </div>
          </div>
        </header>

        <div className="space-y-4">
          {/* 分组导航 Tab */}
          <nav className="surface-panel flex gap-1 overflow-x-auto p-1.5" aria-label={t('settings.title')}>
            {([
              { key: 'api', label: t('settings.tabApi') },
              { key: 'generation', label: t('settings.tabGeneration') },
              { key: 'memory', label: t('settings.tabMemory') },
              { key: 'advanced', label: t('settings.tabAdvanced') },
            ] as const).map(tab => (
              <button
                key={tab.key}
                type="button"
                onClick={() => setActiveTab(tab.key)}
                className={`flex-1 whitespace-nowrap rounded-xl px-4 py-2 text-sm font-medium transition-all ${
                  activeTab === tab.key
                    ? 'bg-accent/15 text-accent-dark shadow-sm'
                    : 'text-text-secondary hover:bg-warm-100 hover:text-text-primary'
                }`}
                aria-pressed={activeTab === tab.key}
              >
                {tab.label}
              </button>
            ))}
          </nav>

          <main className="space-y-4">
            {activeTab === 'api' && (<>
            {/* 供应商管理 */}
            <section className="surface-panel p-5">
              <div className="mb-4 flex items-center justify-between">
                <h2 className="section-title text-lg">{t('settings.providerManage')}</h2>
                <div className="flex gap-2">
                  {activeProviderId && (
                    <button
                      onClick={handleUpdateCurrentProvider}
                      className="soft-button soft-button-secondary text-xs"
                    >
                      {t('settings.providerUpdateCurrent')}
                    </button>
                  )}
                  <button
                    onClick={handleSaveCurrentAsProvider}
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
                  {providers.map(p => (
                    <div
                      key={p.id}
                      className={`flex items-center gap-3 rounded-2xl border px-4 py-3 transition-colors ${
                        p.id === activeProviderId
                          ? 'border-accent/30 bg-accent/8'
                          : 'border-border-light bg-white/70 hover:border-accent/20'
                      }`}
                    >
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <span className="text-sm font-medium text-text-primary">{p.name}</span>
                          {p.id === activeProviderId && (
                            <span className="rounded-full bg-accent/15 px-2 py-0.5 text-[10px] font-medium text-accent-dark">
                              {t('settings.providerActive')}
                            </span>
                          )}
                        </div>
                        <div className="mt-0.5 text-xs text-text-muted truncate">
                          {p.api_base} · {p.model || t('settings.modelPlaceholder')}
                        </div>
                      </div>
                      <div className="flex shrink-0 gap-1.5">
                        {p.id !== activeProviderId && (
                          <button
                            onClick={() => handleActivateProvider(p.id)}
                            className="soft-button soft-button-primary px-2.5 py-1 text-xs"
                          >
                            {t('settings.providerSwitch')}
                          </button>
                        )}
                        <button
                          onClick={() => setEditingProvider({ ...p })}
                          className="soft-button soft-button-secondary px-2.5 py-1 text-xs"
                        >
                          {t('common.edit')}
                        </button>
                        <button
                          onClick={() => handleDeleteProvider(p.id)}
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
                    <label className="mb-1.5 block text-xs font-medium text-text-secondary">{t('settings.providerName')}</label>
                    <input
                      value={editingProvider.name || ''}
                      onChange={e => setEditingProvider(prev => prev ? { ...prev, name: e.target.value } : null)}
                      className="input-rich"
                      placeholder="OpenAI"
                    />
                  </div>
                  <div>
                    <label className="mb-1.5 block text-xs font-medium text-text-secondary">{t('settings.apiBase')}</label>
                    <input
                      value={editingProvider.api_base || ''}
                      onChange={e => setEditingProvider(prev => prev ? { ...prev, api_base: e.target.value } : null)}
                      className="input-rich"
                      placeholder={t('settings.apiBasePlaceholder')}
                    />
                  </div>
                  <div>
                    <label className="mb-1.5 block text-xs font-medium text-text-secondary">{t('settings.apiKey')}</label>
                    <input
                      type="password"
                      value={editingProvider.api_key || ''}
                      onChange={e => setEditingProvider(prev => prev ? { ...prev, api_key: e.target.value } : null)}
                      className="input-rich"
                    />
                  </div>
                  <div>
                    <label className="mb-1.5 block text-xs font-medium text-text-secondary">{t('settings.model')}</label>
                    <input
                      value={editingProvider.model || ''}
                      onChange={e => setEditingProvider(prev => prev ? { ...prev, model: e.target.value } : null)}
                      className="input-rich"
                      placeholder={t('settings.modelPlaceholder')}
                    />
                  </div>
                  <div className="grid grid-cols-3 gap-3">
                    <div>
                      <label className="mb-1.5 block text-xs font-medium text-text-secondary">{t('settings.temperature')}</label>
                      <input
                        type="number" min="0" max="2" step="0.1"
                        value={editingProvider.temperature ?? 1}
                        onChange={e => setEditingProvider(prev => prev ? { ...prev, temperature: parseNumber(e.target.value) } : null)}
                        className="input-rich"
                      />
                    </div>
                    <div>
                      <label className="mb-1.5 block text-xs font-medium text-text-secondary">{t('settings.maxTokens')}</label>
                      <input
                        type="number" min="1"
                        value={editingProvider.max_tokens ?? 4096}
                        onChange={e => setEditingProvider(prev => prev ? { ...prev, max_tokens: parseNumber(e.target.value) } : null)}
                        className="input-rich"
                      />
                    </div>
                    <div>
                      <label className="mb-1.5 block text-xs font-medium text-text-secondary">{t('settings.contextWindow')}</label>
                      <input
                        type="number" min="1"
                        value={editingProvider.context_window ?? 131072}
                        onChange={e => setEditingProvider(prev => prev ? { ...prev, context_window: parseNumber(e.target.value) } : null)}
                        className="input-rich"
                      />
                    </div>
                  </div>
                  <div className="flex gap-2">
                    <button onClick={handleSaveProvider} className="soft-button soft-button-primary text-xs">
                      {t('common.save')}
                    </button>
                    <button onClick={() => setEditingProvider(null)} className="soft-button soft-button-secondary text-xs">
                      {t('common.cancel')}
                    </button>
                  </div>
                </div>
              )}
            </section>

            {/* 当前接口配置 */}
            <section className="surface-panel p-5">
              <div className="mb-4">
                <h2 className="section-title text-lg">{t('settings.api')}</h2>
                {activeProviderId && (
                  <p className="mt-1 text-xs text-text-muted">{t('settings.apiFromProvider')}</p>
                )}
              </div>

              <div className="space-y-4">
                <div>
                  <label className="mb-2 block text-sm font-medium text-text-secondary">{t('settings.apiBase')}</label>
                  <input
                    value={settings.api_base}
                    onChange={e => update('api_base', e.target.value)}
                    className="input-rich"
                    placeholder={t('settings.apiBasePlaceholder')}
                  />
                </div>

                <div>
                  <label className="mb-2 block text-sm font-medium text-text-secondary">{t('settings.apiKey')}</label>
                  <input
                    type="password"
                    value={settings.api_key}
                    onChange={e => update('api_key', e.target.value)}
                    className="input-rich"
                  />
                  <p className="mt-2 text-xs text-text-muted">{t('settings.apiKeyHint')}</p>
                </div>

                <div>
                  <label className="mb-2 block text-sm font-medium text-text-secondary">{t('settings.model')}</label>
                  <div className="flex flex-col gap-2 lg:flex-row">
                    {modelList.length > 0 ? (
                      <select
                        value={settings.model}
                        onChange={e => update('model', e.target.value)}
                        className="select-rich flex-1"
                      >
                        <option value="">{t('settings.modelPlaceholder')}</option>
                        {modelList.map(model => (
                          <option key={model} value={model}>{model}</option>
                        ))}
                      </select>
                    ) : (
                      <input
                        value={settings.model}
                        onChange={e => update('model', e.target.value)}
                        className="input-rich flex-1"
                        placeholder={t('settings.modelPlaceholder')}
                      />
                    )}
                    <button
                      type="button"
                      onClick={() => fetchModels()}
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
                      onChange={e => update('json_mode', e.target.checked)}
                    />
                    {t('settings.jsonMode')}
                  </label>
                  <p className="mt-2 text-xs leading-relaxed text-text-muted">
                    {t('settings.jsonModeHint')}
                  </p>
                </div>
              </div>
            </section>
            </>)}

            {activeTab === 'generation' && (<>
            <section className="surface-panel p-5">
              <div className="mb-4">
                <h2 className="section-title text-lg">{t('settings.modelParams')}</h2>
              </div>

              <div className="grid gap-4 md:grid-cols-3">
                <div>
                  <label className="mb-2 block text-sm font-medium text-text-secondary">{t('settings.temperature')}</label>
                  <input
                    type="number"
                    min="0"
                    max="2"
                    step="0.1"
                    value={settings.temperature}
                    onChange={e => update('temperature', parseNumber(e.target.value))}
                    className="input-rich"
                  />
                </div>

                <div>
                  <label className="mb-2 block text-sm font-medium text-text-secondary">{t('settings.maxTokens')}</label>
                  <input
                    type="number"
                    min="1"
                    value={settings.max_tokens}
                    onChange={e => update('max_tokens', parseNumber(e.target.value))}
                    className="input-rich"
                  />
                </div>

                <div>
                  <label className="mb-2 block text-sm font-medium text-text-secondary">{t('settings.contextWindow')}</label>
                  <input
                    type="number"
                    min="1"
                    value={settings.context_window}
                    onChange={e => update('context_window', parseNumber(e.target.value))}
                    className="input-rich"
                  />
                </div>
              </div>
            </section>

            <section className="surface-panel p-5">
              <div className="mb-4">
                <h2 className="section-title text-lg">{t('settings.chatBehavior')}</h2>
              </div>

              <div className="space-y-3">
                <label className="flex items-center gap-3 rounded-2xl border border-border-light bg-white/70 px-4 py-3 text-sm text-text-secondary">
                  <input
                    type="checkbox"
                    checked={settings.streaming}
                    onChange={e => update('streaming', e.target.checked)}
                  />
                  {t('settings.streaming')}
                </label>

                <label className="flex items-center gap-3 rounded-2xl border border-border-light bg-white/70 px-4 py-3 text-sm text-text-secondary">
                  <input
                    type="checkbox"
                    checked={settings.example_dialogue}
                    onChange={e => update('example_dialogue', e.target.checked)}
                  />
                  {t('settings.exampleDialogue')}
                </label>

                <label className="flex items-center gap-3 rounded-2xl border border-border-light bg-white/70 px-4 py-3 text-sm text-text-secondary">
                  <input
                    type="checkbox"
                    checked={settings.show_timestamps}
                    onChange={e => update('show_timestamps', e.target.checked)}
                  />
                  {t('settings.showTimestamps')}
                </label>
              </div>
            </section>
            </>)}

            {activeTab === 'memory' && (<>
            <section className="surface-panel p-5">
              <div className="mb-4">
                <h2 className="section-title text-lg">{t('settings.memoryEngine')}</h2>
              </div>

              <div className="space-y-3">
                <label className="flex items-center gap-3 rounded-2xl border border-border-light bg-white/70 px-4 py-3 text-sm text-text-secondary">
                  <input
                    type="checkbox"
                    checked={settings.memory_trigger_interval_enabled}
                    onChange={e => update('memory_trigger_interval_enabled', e.target.checked)}
                  />
                  {t('settings.triggerInterval')}
                </label>

                {settings.memory_trigger_interval_enabled && (
                  <div className="rounded-2xl border border-border-light bg-white/70 px-4 py-4">
                    <label className="mb-2 block text-sm font-medium text-text-secondary">{t('settings.extractionInterval')}</label>
                    <input
                      type="number"
                      min="1"
                      max="50"
                      value={settings.memory_interval}
                      onChange={e => update('memory_interval', parseNumber(e.target.value))}
                      className="input-rich"
                    />
                  </div>
                )}

                <label className="flex items-center gap-3 rounded-2xl border border-border-light bg-white/70 px-4 py-3 text-sm text-text-secondary">
                  <input
                    type="checkbox"
                    checked={settings.memory_trigger_time_enabled}
                    onChange={e => update('memory_trigger_time_enabled', e.target.checked)}
                  />
                  {t('settings.triggerTime')}
                </label>

                {settings.memory_trigger_time_enabled && (
                  <div className="rounded-2xl border border-border-light bg-white/70 px-4 py-4">
                    <label className="mb-2 block text-sm font-medium text-text-secondary">{t('settings.triggerTimeMinutes')}</label>
                    <input
                      type="number"
                      min="1"
                      max="72"
                      value={settings.memory_trigger_time_hours}
                      onChange={e => update('memory_trigger_time_hours', parseNumber(e.target.value))}
                      className="input-rich"
                    />
                  </div>
                )}

                <label className="flex items-center gap-3 rounded-2xl border border-border-light bg-white/70 px-4 py-3 text-sm text-text-secondary">
                  <input
                    type="checkbox"
                    checked={settings.memory_trigger_keyword_enabled}
                    onChange={e => update('memory_trigger_keyword_enabled', e.target.checked)}
                  />
                  {t('settings.triggerKeyword')}
                </label>

                {settings.memory_trigger_keyword_enabled && (
                  <div className="rounded-2xl border border-border-light bg-white/70 px-4 py-4">
                    <label className="mb-2 block text-sm font-medium text-text-secondary">{t('settings.triggerKeywords')}</label>
                    <p className="mb-2 text-xs leading-relaxed text-text-muted">{t('settings.triggerKeywordsHint')}</p>
                    <input
                      type="text"
                      value={settings.memory_trigger_keywords}
                      onChange={e => update('memory_trigger_keywords', e.target.value)}
                      placeholder="晚安"
                      className="input-rich"
                    />
                  </div>
                )}

                <label className="flex items-center gap-3 rounded-2xl border border-border-light bg-white/70 px-4 py-3 text-sm text-text-secondary">
                  <input
                    type="checkbox"
                    checked={settings.memory_inject}
                    onChange={e => update('memory_inject', e.target.checked)}
                  />
                  {t('settings.memoryInject')}
                </label>

                <label className="flex items-center gap-3 rounded-2xl border border-border-light bg-white/70 px-4 py-3 text-sm text-text-secondary">
                  <input
                    type="checkbox"
                    checked={settings.limit_inject}
                    onChange={e => update('limit_inject', e.target.checked)}
                  />
                  {t('settings.limitInject')}
                </label>

                {settings.limit_inject && (
                  <div className="rounded-2xl border border-border-light bg-white/70 px-4 py-4">
                    <label className="mb-2 block text-sm font-medium text-text-secondary">{t('settings.maxMemoriesInject')}</label>
                    <p className="mb-3 text-xs leading-relaxed text-text-muted">{t('settings.limitInjectHint')}</p>
                    <input
                      type="number"
                      min="5"
                      max="100"
                      value={settings.memory_max_inject}
                      onChange={e => update('memory_max_inject', parseNumber(e.target.value))}
                      className="input-rich"
                    />
                  </div>
                )}
              </div>
            </section>

            <section className="surface-panel p-5">
              <div className="mb-4">
                <h2 className="section-title text-lg">{t('settings.display')}</h2>
              </div>

              <div className="grid gap-4 md:grid-cols-2">
                <label className="rounded-2xl border border-border-light bg-white/70 px-4 py-4 text-sm text-text-secondary">
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

                <label className="rounded-2xl border border-border-light bg-white/70 px-4 py-4 text-sm text-text-secondary">
                  <span className="mb-2 block">{t('settings.language')}</span>
                  <select
                    value={settings.language}
                    onChange={e => update('language', e.target.value as 'zh' | 'en')}
                    className="select-rich"
                  >
                    <option value="zh">中文</option>
                    <option value="en">English</option>
                  </select>
                </label>

                <label className="rounded-2xl border border-border-light bg-white/70 px-4 py-4 text-sm text-text-secondary md:col-span-2">
                  <span className="mb-2 block">{t('settings.font')}</span>
                  <div className="grid grid-cols-3 gap-2">
                    {(['wenkai', 'system', 'serif'] as const).map(f => (
                      <button
                        key={f}
                        type="button"
                        onClick={() => {
                          update('font_style', f);
                          // 实时预览
                          applyFontStyle(f);
                        }}
                        className={`rounded-xl border px-3 py-2.5 text-center text-sm transition-colors ${
                          (settings.font_style || 'wenkai') === f
                            ? 'border-accent bg-accent/10 text-accent-dark font-medium'
                            : 'border-border-light bg-white/50 text-text-secondary hover:border-accent/40 hover:bg-accent/5'
                        }`}
                      >
                        <span className="block text-base leading-snug" style={{
                          fontFamily: f === 'wenkai'
                            ? "'LXGW WenKai Screen', 'PingFang SC', sans-serif"
                            : f === 'system'
                            ? "'PingFang SC', 'Microsoft YaHei', system-ui, sans-serif"
                            : "'Noto Serif SC', 'SimSun', Georgia, serif"
                        }}>
                          {f === 'wenkai' ? '霞鹜文楷' : f === 'system' ? '系统字体' : '衬线字体'}
                        </span>
                        <span className="mt-0.5 block text-xs text-text-muted">{t(`settings.font${f.charAt(0).toUpperCase() + f.slice(1)}`)}</span>
                      </button>
                    ))}
                  </div>
                </label>
              </div>
            </section>
            </>)}

            {activeTab === 'advanced' && (<>
            <ImageGenSettingsSection settings={settings} update={update} parseNumber={parseNumber} t={t} />

            <MaintenanceSection t={t} />
            </>)}
          </main>
        </div>
      </div>
    </div>
  );
}

// ========== 生图设置子组件 ==========
function ImageGenSettingsSection({
  settings,
  update,
  parseNumber,
  t,
}: {
  settings: Settings;
  update: <K extends keyof Settings>(key: K, value: Settings[K]) => void;
  parseNumber: (v: string) => number;
  t: (key: string) => string;
}) {
  const imgGen = settings.image_gen || DEFAULT_IMAGE_GEN_SETTINGS;

  const updateImg = <K extends keyof ImageGenSettings>(key: K, value: ImageGenSettings[K]) => {
    update('image_gen', { ...imgGen, [key]: value });
  };

  return (
    <section className="surface-panel p-5">
      <div className="mb-4 flex items-center gap-3">
        <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-accent/10 text-accent-dark">
          <ImageIcon className="h-4 w-4" />
        </div>
        <h2 className="section-title text-lg">{t('settings.imageGen')}</h2>
      </div>

      <div className="space-y-3">
        {/* 启用开关 */}
        <label className="flex items-center gap-3 rounded-2xl border border-border-light bg-white/70 px-4 py-3 text-sm text-text-secondary">
          <input
            type="checkbox"
            checked={imgGen.enabled}
            onChange={e => updateImg('enabled', e.target.checked)}
          />
          {t('settings.imageGenEnabled')}
        </label>

        {imgGen.enabled && (
          <>
            {/* 引擎选择 */}
            <div className="rounded-2xl border border-border-light bg-white/70 px-4 py-4">
              <label className="mb-2 block text-sm font-medium text-text-secondary">{t('settings.imageGenEngine')}</label>
              <select
                value={imgGen.engine}
                onChange={e => updateImg('engine', e.target.value as ImageGenSettings['engine'])}
                className="select-rich"
              >
                <option value="sd">{t('settings.imageGenSD')}</option>
                <option value="nai">{t('settings.imageGenNAI')}</option>
                <option value="comfyui">{t('settings.imageGenComfyUI')}</option>
                <option value="custom">{t('settings.imageGenCustom')}</option>
              </select>
            </div>

            {/* SD WebUI 配置 */}
            {imgGen.engine === 'sd' && (
              <div className="space-y-3 rounded-2xl border border-border-light bg-white/70 px-4 py-4">
                <div>
                  <label className="mb-1.5 block text-sm font-medium text-text-secondary">{t('settings.imageGenSDUrl')}</label>
                  <input value={imgGen.sd_url} onChange={e => updateImg('sd_url', e.target.value)} className="input-rich" placeholder="http://127.0.0.1:7860" />
                </div>
                <div>
                  <label className="mb-1.5 block text-sm font-medium text-text-secondary">{t('settings.imageGenSDSampler')}</label>
                  <input value={imgGen.sd_sampler} onChange={e => updateImg('sd_sampler', e.target.value)} className="input-rich" />
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="mb-1.5 block text-sm font-medium text-text-secondary">{t('settings.imageGenSDSteps')}</label>
                    <input type="number" min="1" max="150" value={imgGen.sd_steps} onChange={e => updateImg('sd_steps', parseNumber(e.target.value))} className="input-rich" />
                  </div>
                  <div>
                    <label className="mb-1.5 block text-sm font-medium text-text-secondary">{t('settings.imageGenSDCfg')}</label>
                    <input type="number" min="1" max="30" step="0.5" value={imgGen.sd_cfg_scale} onChange={e => updateImg('sd_cfg_scale', parseNumber(e.target.value))} className="input-rich" />
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="mb-1.5 block text-sm font-medium text-text-secondary">{t('settings.imageGenSDWidth')}</label>
                    <input type="number" min="256" max="2048" step="64" value={imgGen.sd_width} onChange={e => updateImg('sd_width', parseNumber(e.target.value))} className="input-rich" />
                  </div>
                  <div>
                    <label className="mb-1.5 block text-sm font-medium text-text-secondary">{t('settings.imageGenSDHeight')}</label>
                    <input type="number" min="256" max="2048" step="64" value={imgGen.sd_height} onChange={e => updateImg('sd_height', parseNumber(e.target.value))} className="input-rich" />
                  </div>
                </div>
                <div>
                  <label className="mb-1.5 block text-sm font-medium text-text-secondary">{t('settings.imageGenSDNeg')}</label>
                  <textarea value={imgGen.sd_negative_prompt} onChange={e => updateImg('sd_negative_prompt', e.target.value)} rows={2} className="textarea-rich w-full resize-none rounded-xl border border-border-light bg-white/70 px-3 py-2 text-sm" />
                </div>
              </div>
            )}

            {/* NovelAI 配置 */}
            {imgGen.engine === 'nai' && (
              <div className="space-y-3 rounded-2xl border border-border-light bg-white/70 px-4 py-4">
                <div>
                  <label className="mb-1.5 block text-sm font-medium text-text-secondary">{t('settings.imageGenNAIKey')}</label>
                  <input type="password" value={imgGen.nai_api_key} onChange={e => updateImg('nai_api_key', e.target.value)} className="input-rich" />
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="mb-1.5 block text-sm font-medium text-text-secondary">{t('settings.imageGenNAIModel')}</label>
                    <select value={imgGen.nai_model} onChange={e => updateImg('nai_model', e.target.value)} className="select-rich">
                      <option value="nai-diffusion-4-5-full">NAI Diffusion 4.5 Full</option>
                      <option value="nai-diffusion-4-5-curated">NAI Diffusion 4.5 Curated</option>
                      <option value="nai-diffusion-4-full">NAI Diffusion 4 Full</option>
                      <option value="nai-diffusion-4-curated-preview">NAI Diffusion 4 Curated</option>
                      <option value="nai-diffusion-3">NAI Diffusion 3 (Anime V3)</option>
                      <option value="nai-diffusion-furry-3">NAI Diffusion Furry V3</option>
                    </select>
                  </div>
                  <div>
                    <label className="mb-1.5 block text-sm font-medium text-text-secondary">{t('settings.imageGenNAISampler')}</label>
                    <select value={imgGen.nai_sampler} onChange={e => updateImg('nai_sampler', e.target.value)} className="select-rich">
                      <option value="k_euler_ancestral">Euler Ancestral</option>
                      <option value="k_euler">Euler</option>
                      <option value="k_dpmpp_2s_ancestral">DPM++ 2S Ancestral</option>
                      <option value="k_dpmpp_2m">DPM++ 2M</option>
                      <option value="k_dpmpp_sde">DPM++ SDE</option>
                      <option value="ddim_v3">DDIM</option>
                    </select>
                  </div>
                </div>
                <div>
                  <label className="mb-1.5 block text-sm font-medium text-text-secondary">{t('settings.imageGenNAINoiseSchedule')}</label>
                  <select value={imgGen.nai_noise_schedule} onChange={e => updateImg('nai_noise_schedule', e.target.value)} className="select-rich">
                    <option value="karras">Karras</option>
                    <option value="exponential">Exponential</option>
                    <option value="polyexponential">Polyexponential</option>
                    <option value="native">Native</option>
                  </select>
                </div>
                <div className="grid grid-cols-3 gap-3">
                  <div>
                    <label className="mb-1.5 block text-sm font-medium text-text-secondary">{t('settings.imageGenNAISteps')}</label>
                    <input type="number" min="1" max="50" value={imgGen.nai_steps} onChange={e => updateImg('nai_steps', parseNumber(e.target.value))} className="input-rich" />
                  </div>
                  <div>
                    <label className="mb-1.5 block text-sm font-medium text-text-secondary">{t('settings.imageGenNAIScale')}</label>
                    <input type="number" min="0" max="25" step="0.1" value={imgGen.nai_scale} onChange={e => updateImg('nai_scale', parseNumber(e.target.value))} className="input-rich" />
                  </div>
                  <div>
                    <label className="mb-1.5 block text-sm font-medium text-text-secondary">{t('settings.imageGenNAICfgRescale')}</label>
                    <input type="number" min="0" max="1" step="0.01" value={imgGen.nai_cfg_rescale} onChange={e => updateImg('nai_cfg_rescale', parseNumber(e.target.value))} className="input-rich" />
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="mb-1.5 block text-sm font-medium text-text-secondary">{t('settings.imageGenNAIWidth')}</label>
                    <input type="number" min="256" max="2048" step="64" value={imgGen.nai_width} onChange={e => updateImg('nai_width', parseNumber(e.target.value))} className="input-rich" />
                  </div>
                  <div>
                    <label className="mb-1.5 block text-sm font-medium text-text-secondary">{t('settings.imageGenNAIHeight')}</label>
                    <input type="number" min="256" max="2048" step="64" value={imgGen.nai_height} onChange={e => updateImg('nai_height', parseNumber(e.target.value))} className="input-rich" />
                  </div>
                </div>
                <div>
                  <label className="mb-1.5 block text-sm font-medium text-text-secondary">{t('settings.imageGenNAIArtist')}</label>
                  <p className="mb-2 text-xs leading-relaxed text-text-muted">{t('settings.imageGenNAIArtistHint')}</p>
                  <textarea value={imgGen.nai_artist_tags} onChange={e => updateImg('nai_artist_tags', e.target.value)} rows={2} placeholder="" className="textarea-rich w-full resize-none rounded-xl border border-border-light bg-white/70 px-3 py-2 text-sm" />
                </div>
                <div>
                  <label className="mb-1.5 block text-sm font-medium text-text-secondary">{t('settings.imageGenNAINeg')}</label>
                  <textarea value={imgGen.nai_negative_prompt} onChange={e => updateImg('nai_negative_prompt', e.target.value)} rows={2} className="textarea-rich w-full resize-none rounded-xl border border-border-light bg-white/70 px-3 py-2 text-sm" />
                </div>
              </div>
            )}

            {/* ComfyUI 配置 */}
            {imgGen.engine === 'comfyui' && (
              <div className="space-y-3 rounded-2xl border border-border-light bg-white/70 px-4 py-4">
                <div>
                  <label className="mb-1.5 block text-sm font-medium text-text-secondary">{t('settings.imageGenComfyUrl')}</label>
                  <input value={imgGen.comfyui_url} onChange={e => updateImg('comfyui_url', e.target.value)} className="input-rich" placeholder="http://127.0.0.1:8188" />
                </div>
                <div>
                  <label className="mb-1.5 block text-sm font-medium text-text-secondary">{t('settings.imageGenComfyWorkflow')}</label>
                  <p className="mb-2 text-xs leading-relaxed text-text-muted">{t('settings.imageGenComfyWorkflowHint')}</p>
                  <textarea value={imgGen.comfyui_workflow} onChange={e => updateImg('comfyui_workflow', e.target.value)} rows={4} className="textarea-rich w-full resize-none rounded-xl border border-border-light bg-white/70 px-3 py-2 font-mono text-xs" />
                </div>
              </div>
            )}

            {/* 自定义 API 配置 */}
            {imgGen.engine === 'custom' && (
              <div className="space-y-3 rounded-2xl border border-border-light bg-white/70 px-4 py-4">
                <div>
                  <label className="mb-1.5 block text-sm font-medium text-text-secondary">{t('settings.imageGenCustomUrl')}</label>
                  <input value={imgGen.custom_url} onChange={e => updateImg('custom_url', e.target.value)} className="input-rich" placeholder="https://api.openai.com/v1/images/generations" />
                </div>
                <div>
                  <label className="mb-1.5 block text-sm font-medium text-text-secondary">{t('settings.imageGenCustomKey')}</label>
                  <input type="password" value={imgGen.custom_api_key} onChange={e => updateImg('custom_api_key', e.target.value)} className="input-rich" />
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="mb-1.5 block text-sm font-medium text-text-secondary">{t('settings.imageGenCustomModel')}</label>
                    <input value={imgGen.custom_model} onChange={e => updateImg('custom_model', e.target.value)} className="input-rich" placeholder="dall-e-3" />
                  </div>
                  <div>
                    <label className="mb-1.5 block text-sm font-medium text-text-secondary">{t('settings.imageGenCustomSize')}</label>
                    <input value={imgGen.custom_size} onChange={e => updateImg('custom_size', e.target.value)} className="input-rich" placeholder="1024x1024" />
                  </div>
                </div>
              </div>
            )}

            {/* 通用设置 */}
            <div className="rounded-2xl border border-border-light bg-white/70 px-4 py-4">
              <label className="mb-1.5 block text-sm font-medium text-text-secondary">{t('settings.imageGenQuality')}</label>
              <input value={imgGen.quality_tags} onChange={e => updateImg('quality_tags', e.target.value)} className="input-rich" />
            </div>

            {/* 自动生图 */}
            <label className="flex items-center gap-3 rounded-2xl border border-border-light bg-white/70 px-4 py-3 text-sm text-text-secondary">
              <input
                type="checkbox"
                checked={imgGen.auto_generate}
                onChange={e => updateImg('auto_generate', e.target.checked)}
              />
              {t('settings.imageGenAuto')}
            </label>
            <p className="px-4 text-xs leading-relaxed text-text-muted">{t('settings.imageGenAutoHint')}</p>

            {imgGen.auto_generate && (
              <div className="rounded-2xl border border-border-light bg-white/70 px-4 py-4">
                <label className="mb-1.5 block text-sm font-medium text-text-secondary">{t('settings.imageGenAutoKeywords')}</label>
                <p className="mb-2 text-xs leading-relaxed text-text-muted">{t('settings.imageGenAutoKeywordsHint')}</p>
                <input
                  value={imgGen.auto_generate_keywords}
                  onChange={e => updateImg('auto_generate_keywords', e.target.value)}
                  className="input-rich"
                  placeholder="画,生图,来一张,看看"
                />
              </div>
            )}
          </>
        )}
      </div>
    </section>
  );
}

// ========== 数据库维护子组件 ==========
interface OrphanFileInfo {
  total: number;
  orphanCount: number;
}

function MaintenanceSection({ t }: { t: (key: string) => string }) {
  const [status, setStatus] = useState<'idle' | 'checking' | 'previewed' | 'cleaning' | 'done'>('idle');
  const [previewCount, setPreviewCount] = useState(0);
  const [cleanedCount, setCleanedCount] = useState(0);
  const [orphanFiles, setOrphanFiles] = useState<Record<string, OrphanFileInfo> | null>(null);
  const [fileResults, setFileResults] = useState<Record<string, { deleted: number; errors: number }> | null>(null);

  const handlePreview = async () => {
    setStatus('checking');
    try {
      const res = await fetch('/api/maintenance');
      const data = await res.json() as { total: number; orphanFiles: Record<string, OrphanFileInfo> };
      setPreviewCount(data.total);
      setOrphanFiles(data.orphanFiles);
      setFileResults(null);
      setStatus('previewed');
    } catch {
      setStatus('idle');
    }
  };

  const handleCleanup = async () => {
    setStatus('cleaning');
    try {
      const res = await fetch('/api/maintenance', { method: 'POST' });
      const data = await res.json() as { dbDeleted: number; fileResults: Record<string, { deleted: number; errors: number }> };
      setCleanedCount(data.dbDeleted);
      setFileResults(data.fileResults);
      setStatus('done');
    } catch {
      setStatus('idle');
    }
  };

  const fileOrphanCount = (orphanFiles?.avatars?.orphanCount || 0) + (orphanFiles?.attachments?.orphanCount || 0) + (orphanFiles?.generated?.orphanCount || 0);
  const totalOrphans = previewCount + fileOrphanCount;
  const fileCleanedCount = (fileResults?.avatars?.deleted || 0) + (fileResults?.attachments?.deleted || 0) + (fileResults?.generated?.deleted || 0);
  const totalCleaned = cleanedCount + fileCleanedCount;

  const getMessage = () => {
    if (status === 'checking') return t('settings.cleanupRunning');
    if (status === 'cleaning') return t('settings.cleanupRunning');
    if (status === 'done') {
      if (totalCleaned === 0) return t('settings.cleanupClean');
      return t('settings.cleanupResult').replace('{count}', String(totalCleaned));
    }
    if (status === 'previewed') {
      if (totalOrphans === 0) return t('settings.cleanupClean');
      return t('settings.cleanupPreview').replace('{count}', String(totalOrphans));
    }
    return null;
  };

  const msg = getMessage();

  return (
    <section className="surface-panel p-5">
      <div className="mb-4">
        <h2 className="section-title text-lg">{t('settings.maintenance')}</h2>
        <p className="mt-1 text-xs text-text-muted">{t('settings.maintenanceHint')}</p>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <button
          onClick={handlePreview}
          disabled={status === 'checking' || status === 'cleaning'}
          className="soft-button soft-button-secondary disabled:cursor-not-allowed disabled:opacity-50"
        >
          {status === 'checking' ? t('settings.cleanupRunning') : t('settings.cleanupDryRun')}
        </button>

        {status === 'previewed' && totalOrphans > 0 && (
          <button
            onClick={handleCleanup}
            className="soft-button soft-button-danger"
          >
            {t('settings.cleanupConfirm')}
          </button>
        )}

        {msg && (
          <span className={`text-sm ${
            status === 'done' && totalCleaned > 0 ? 'text-green-600'
            : status === 'previewed' && totalOrphans > 0 ? 'text-amber-600'
            : 'text-text-muted'
          }`}>
            {msg}
          </span>
        )}
      </div>

      {status === 'previewed' && orphanFiles && fileOrphanCount > 0 && (
        <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-text-muted">
          <span>{t('settings.cleanupFilePreview').replace('{a}', `${orphanFiles.avatars.orphanCount}/${orphanFiles.avatars.total}`).replace('{at}', `${orphanFiles.attachments.orphanCount}/${orphanFiles.attachments.total}`).replace('{g}', `${orphanFiles.generated.orphanCount}/${orphanFiles.generated.total}`)}</span>
        </div>
      )}

      {status === 'done' && fileResults && fileCleanedCount > 0 && (
        <div className="mt-3 text-xs text-green-600">
          {t('settings.cleanupFileResult').replace('{a}', String(fileResults.avatars?.deleted ?? 0)).replace('{at}', String(fileResults.attachments?.deleted ?? 0)).replace('{g}', String(fileResults.generated?.deleted ?? 0))}
        </div>
      )}
    </section>
  );
}
