'use client';

import { useEffect, useRef, useState, useCallback } from 'react';
import {
  DEFAULT_MEMORY_ENGINE_SETTINGS,
  DEFAULT_SETTINGS,
  Settings,
  FontStyle,
  MemoryEngineSettings,
} from '@/types';
import { applyFontStyle } from '@/lib/font-stacks';
import { writeThemeStorage } from '@/lib/theme-provider';
import { API_KEY_MASK } from '@/lib/constants';
import { expectOkResponse, getErrorMessage, parseJsonResponse } from '@/lib/http';
import { useRouter } from 'next/navigation';
import { useTranslation } from '@/lib/i18n-context';
import { useToast } from '@/components/ui/Toast';
import { ArrowLeftIcon, SparkIcon, SettingsIcon } from '@/components/ui/icons';
import ErrorBoundary from '@/components/ui/ErrorBoundary';
import { useMemoryIndexPanel } from '@/hooks/settings/useMemoryIndexPanel';
import { useMemoryManagementCharacters } from '@/hooks/settings/useMemoryManagementCharacters';
import { useMemoryProfilePanel } from '@/hooks/settings/useMemoryProfilePanel';
import { useMemoryArchivePanel } from '@/hooks/settings/useMemoryArchivePanel';
import { useMemoryCandidatesPanel } from '@/hooks/settings/useMemoryCandidatesPanel';
import { MemoryIndexPanel } from '@/components/settings/memory/MemoryIndexPanel';
import { MemoryDiagnosticsPanel } from '@/components/settings/memory/MemoryDiagnosticsPanel';
import { MemoryEngineSection } from '@/components/settings/memory/MemoryEngineSection';
import { MemoryProfilePanel } from '@/components/settings/memory/MemoryProfilePanel';
import { MemoryArchivePanel } from '@/components/settings/memory/MemoryArchivePanel';
import { MemoryCandidatesPanel } from '@/components/settings/memory/MemoryCandidatesPanel';
import { ImageGenSettingsSection } from '@/components/settings/ImageGenSettingsSection';
import { ApiSettingsSection } from '@/components/settings/ApiSettingsSection';
import { ProviderSettingsSection } from '@/components/settings/ProviderSettingsSection';
import { useSettingsAuth } from '@/hooks/settings/useSettingsAuth';
import { useSettingsProviders } from '@/hooks/settings/useSettingsProviders';

type MemoryModePreset = 'local' | 'balanced' | 'continuity';
type ModelCredentialSource = 'chat' | 'embedding' | 'reranker';

type SettingsWithMemoryEngine = Settings & {
  memory_engine: MemoryEngineSettings;
};

const CHAT_RETRIEVAL_TIMEOUT_MS = 2500;
const CONTINUITY_CHAT_RETRIEVAL_TIMEOUT_MS = 5000;

const DEFAULT_SETTINGS_WITH_MEMORY_ENGINE: SettingsWithMemoryEngine = {
  ...DEFAULT_SETTINGS,
  memory_engine: DEFAULT_MEMORY_ENGINE_SETTINGS,
};

const MEMORY_MODE_PRESETS: Record<MemoryModePreset, Partial<MemoryEngineSettings>> = {
  local: {
    retrieval_mode: 'local',
    embedding_enabled: false,
    reranker_enabled: false,
    fallback_local_enabled: true,
    memory_package_token_budget: 12000,
    retrieval_token_budget: 8000,
    vector_top_k: 80,
    keyword_top_k: 20,
    reranker_top_k: 40,
    final_top_k: 30,
    embedding_timeout_ms: 1500,
    reranker_timeout_ms: 2000,
    total_retrieval_timeout_ms: CHAT_RETRIEVAL_TIMEOUT_MS,
  },
  balanced: {
    retrieval_mode: 'hybrid',
    embedding_enabled: true,
    reranker_enabled: false,
    fallback_local_enabled: true,
    memory_package_token_budget: 12000,
    retrieval_token_budget: 8000,
    vector_top_k: 80,
    keyword_top_k: 20,
    reranker_top_k: 40,
    final_top_k: 30,
    embedding_timeout_ms: 1500,
    reranker_timeout_ms: 2000,
    total_retrieval_timeout_ms: CHAT_RETRIEVAL_TIMEOUT_MS,
  },
  continuity: {
    retrieval_mode: 'hybrid',
    embedding_enabled: true,
    reranker_enabled: true,
    fallback_local_enabled: true,
    memory_package_token_budget: 20000,
    retrieval_token_budget: 14000,
    vector_top_k: 120,
    keyword_top_k: 30,
    reranker_top_k: 80,
    final_top_k: 50,
    embedding_timeout_ms: 2500,
    reranker_timeout_ms: 3500,
    total_retrieval_timeout_ms: CONTINUITY_CHAT_RETRIEVAL_TIMEOUT_MS,
  },
};

function resolveMemoryModePreset(engine: MemoryEngineSettings): MemoryModePreset {
  if (!engine.embedding_enabled) return 'local';
  if (engine.reranker_enabled && engine.memory_package_token_budget >= 20000) return 'continuity';
  return 'balanced';
}

function mergeSettingsWithMemoryEngine(settings: Partial<SettingsWithMemoryEngine>): SettingsWithMemoryEngine {
  return {
    ...DEFAULT_SETTINGS_WITH_MEMORY_ENGINE,
    ...settings,
    image_gen: {
      ...DEFAULT_SETTINGS.image_gen,
      ...settings.image_gen,
    },
    memory_engine: {
      ...DEFAULT_MEMORY_ENGINE_SETTINGS,
      ...settings.memory_engine,
    },
  };
}

export default function SettingsPage() {
  const router = useRouter();
  const [settings, setSettings] = useState<SettingsWithMemoryEngine>(DEFAULT_SETTINGS_WITH_MEMORY_ENGINE);
  const [saving, setSaving] = useState<'idle' | 'saving'>('idle');
  const [modelList, setModelList] = useState<string[]>([]);
  const [modelLoading, setModelLoading] = useState(false);
  const [modelError, setModelError] = useState<string | null>(null);
  const [bgModelList, setBgModelList] = useState<string[]>([]);
  const [bgModelLoading, setBgModelLoading] = useState(false);
  const [bgModelError, setBgModelError] = useState<string | null>(null);
  const [embeddingModelList, setEmbeddingModelList] = useState<string[]>([]);
  const [embeddingModelLoading, setEmbeddingModelLoading] = useState(false);
  const [embeddingModelError, setEmbeddingModelError] = useState<string | null>(null);
  const [rerankerModelList, setRerankerModelList] = useState<string[]>([]);
  const [rerankerModelLoading, setRerankerModelLoading] = useState(false);
  const [rerankerModelError, setRerankerModelError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<'api' | 'generation' | 'memory' | 'advanced'>('api');
  const { t, setLang } = useTranslation();
  const tRef = useRef(t);
  const { showToast } = useToast();
  const { authEnabled, handleLogout } = useSettingsAuth({
    t,
    showToast,
    replaceRoute: router.replace,
  });
  const resetProviderModels = useCallback(() => {
    setModelList([]);
    setModelError(null);
  }, []);
  const {
    providers,
    activeProviderId,
    editingProvider,
    setEditingProvider,
    handleActivateProvider,
    handleDeleteProvider,
    handleSaveProvider,
    handleSaveCurrentAsProvider,
    handleUpdateCurrentProvider,
  } = useSettingsProviders({
    settings,
    setSettings,
    mergeSettings: mergeSettingsWithMemoryEngine,
    t,
    showToast,
    resetModels: resetProviderModels,
  });
  const memoryManagementPanel = useMemoryManagementCharacters();
  const memoryIndexPanel = useMemoryIndexPanel({
    active: activeTab === 'memory',
    memoryManagementCharacterIdRef: memoryManagementPanel.memoryManagementCharacterIdRef,
    t,
    showToast,
  });
  const {
    loadMemoryIndexStatus,
    loadMemoryDiagnostics,
  } = memoryIndexPanel;
  const memoryProfilePanel = useMemoryProfilePanel({
    characterId: memoryManagementPanel.memoryManagementCharacterId,
    memoryManagementCharacterIdRef: memoryManagementPanel.memoryManagementCharacterIdRef,
    loadMemoryDiagnostics,
    t,
    showToast,
  });
  const memoryArchivePanel = useMemoryArchivePanel({
    characterId: memoryManagementPanel.memoryManagementCharacterId,
    memoryManagementCharacterIdRef: memoryManagementPanel.memoryManagementCharacterIdRef,
    loadMemoryDiagnostics,
    loadMemoryIndexStatus,
    t,
    showToast,
  });
  const memoryCandidatesPanel = useMemoryCandidatesPanel({
    characterId: memoryManagementPanel.memoryManagementCharacterId,
    memoryManagementCharacterIdRef: memoryManagementPanel.memoryManagementCharacterIdRef,
    t,
    showToast,
    loadMemoryDiagnostics,
    loadMemoryIndexStatus,
  });
  const { loadMemoryManagementCharacters } = memoryManagementPanel;
  const { loadMemoryCandidates } = memoryCandidatesPanel;

  useEffect(() => {
    tRef.current = t;
  }, [t]);

  const update = <K extends keyof SettingsWithMemoryEngine>(key: K, value: SettingsWithMemoryEngine[K]) => {
    if (typeof value === 'number' && !Number.isFinite(value)) return;
    setSettings(prev => ({ ...prev, [key]: value }));
  };

  const updateMemoryEngine = <K extends keyof MemoryEngineSettings>(key: K, value: MemoryEngineSettings[K]) => {
    if (typeof value === 'number' && !Number.isFinite(value)) return;
    setSettings(prev => ({
      ...prev,
      memory_engine: { ...prev.memory_engine, [key]: value },
    }));
  };

  const handleMemoryModeChange = (mode: MemoryModePreset) => {
    setSettings(prev => ({
      ...prev,
      memory_engine: {
        ...prev.memory_engine,
        ...MEMORY_MODE_PRESETS[mode],
      },
    }));
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
      const usingKey = (apiKey && apiKey !== API_KEY_MASK)
        ? apiKey
        : (settings.api_key && settings.api_key !== API_KEY_MASK ? settings.api_key : undefined);
      if (usingKey) body.api_key = usingKey;
      const response = await fetch('/api/models', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await parseJsonResponse<{ error?: string; models?: string[] }>(response);
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

  /** 通用模型列表获取，供 embedding / reranker / 后台模型等使用 */
  const fetchModelList = async (
    apiBase: string,
    apiKey: string,
    credentialSource?: ModelCredentialSource,
    providerId?: string,
  ): Promise<string[]> => {
    const body: Record<string, unknown> = { refresh: true };
    if (providerId) {
      body.provider_id = providerId;
    } else {
      body.api_base = apiBase;
      if (credentialSource) body.credential_source = credentialSource;
      const effectiveKey = apiKey && apiKey !== API_KEY_MASK ? apiKey : undefined;
      if (effectiveKey) body.api_key = effectiveKey;
    }
    const response = await fetch('/api/models', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await parseJsonResponse<{ error?: string; models?: string[] }>(response);
    if (data.error) throw new Error(data.error);
    return data.models || [];
  };

  const fetchBgModels = async () => {
    // 后台模型：根据选中的供应商或主接口获取模型列表
    const providerId = settings.memory_background_provider_id;
    const provider = providers.find(p => p.id === providerId);
    const apiBase = providerId ? (provider?.api_base || '') : settings.api_base;
    const apiKey = providerId ? (provider?.api_key || '') : settings.api_key;
    if (!providerId && !apiBase) { setBgModelError(t('settings.apiBaseRequired')); return; }
    setBgModelLoading(true);
    setBgModelError(null);
    try {
      setBgModelList(await fetchModelList(apiBase, apiKey, undefined, providerId || undefined));
    } catch (e) {
      setBgModelError(String(e));
    } finally {
      setBgModelLoading(false);
    }
  };

  const fetchEmbeddingModels = async () => {
    const apiBase = settings.memory_engine.embedding_api_base;
    const apiKey = settings.memory_engine.embedding_api_key;
    if (!apiBase) { setEmbeddingModelError(t('settings.memoryEmbeddingApiBaseRequired')); return; }
    setEmbeddingModelLoading(true);
    setEmbeddingModelError(null);
    try {
      setEmbeddingModelList(await fetchModelList(apiBase, apiKey, 'embedding'));
    } catch (e) {
      setEmbeddingModelError(String(e));
    } finally {
      setEmbeddingModelLoading(false);
    }
  };

  const fetchRerankerModels = async () => {
    const apiBase = settings.memory_engine.reranker_api_base;
    const apiKey = settings.memory_engine.reranker_api_key;
    if (!apiBase) { setRerankerModelError(t('settings.memoryRerankerApiBaseRequired')); return; }
    setRerankerModelLoading(true);
    setRerankerModelError(null);
    try {
      setRerankerModelList(await fetchModelList(apiBase, apiKey, 'reranker'));
    } catch (e) {
      setRerankerModelError(String(e));
    } finally {
      setRerankerModelLoading(false);
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
      await expectOkResponse(response);
      setLang(settings.language);
      document.documentElement.classList.toggle('dark', settings.theme === 'dark');
      writeThemeStorage(settings.theme);
      applyFontStyle((settings.font_style || 'wenkai') as FontStyle);
      showToast(t('settings.saveSuccess'), 'success');
    } catch (err) {
      showToast(`${t('settings.saveFailed')}: ${getErrorMessage(err)}`, 'error');
    } finally {
      setSaving('idle');
    }
  };

  const handleMemoryManagementCharacterChange = (characterId: string) => {
    memoryManagementPanel.handleMemoryManagementCharacterChange(characterId, {
      resetProfile: memoryProfilePanel.resetProfile,
      resetArchiveForCharacterChange: memoryArchivePanel.resetArchiveForCharacterChange,
      loadMemoryDiagnostics,
      loadMemoryProfile: memoryProfilePanel.loadMemoryProfile,
      loadMemoryArchiveMemories: memoryArchivePanel.loadMemoryArchiveMemories,
      loadMemoryArchiveBatches: memoryArchivePanel.loadMemoryArchiveBatches,
    });
    void loadMemoryCandidates(characterId);
  };

  const loadInitialSettingsAndAuth = useCallback(() => {
    void fetch('/api/settings')
      .then(r => parseJsonResponse<Partial<SettingsWithMemoryEngine>>(r))
      .then(s => {
        const merged = mergeSettingsWithMemoryEngine(s);
        setSettings(merged);
        document.documentElement.classList.toggle('dark', s.theme === 'dark');
        writeThemeStorage(merged.theme);
        applyFontStyle((merged.font_style || 'wenkai') as FontStyle);
      })
      .catch(err => {
        showToast(`${tRef.current('settings.loadFailed')}: ${getErrorMessage(err)}`, 'error');
    });
  }, [showToast]);

  const loadMemoryPanelState = useCallback(async () => {
    void loadMemoryIndexStatus();
    void loadMemoryDiagnostics();
    await loadMemoryManagementCharacters({
      loadMemoryDiagnostics,
      loadMemoryProfile: memoryProfilePanel.loadMemoryProfile,
      loadMemoryArchiveMemories: memoryArchivePanel.loadMemoryArchiveMemories,
      loadMemoryArchiveBatches: memoryArchivePanel.loadMemoryArchiveBatches,
    });
    void loadMemoryCandidates();
  }, [
    loadMemoryDiagnostics,
    loadMemoryIndexStatus,
    loadMemoryCandidates,
    loadMemoryManagementCharacters,
    memoryArchivePanel.loadMemoryArchiveBatches,
    memoryArchivePanel.loadMemoryArchiveMemories,
    memoryProfilePanel.loadMemoryProfile,
  ]);

  useEffect(() => {
    loadInitialSettingsAndAuth();
  }, [loadInitialSettingsAndAuth]);

  useEffect(() => {
    if (activeTab !== 'memory') return;
    void loadMemoryPanelState();
  }, [
    activeTab,
    loadMemoryPanelState,
  ]);

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
            <ProviderSettingsSection
              providers={providers}
              activeProviderId={activeProviderId}
              editingProvider={editingProvider}
              setEditingProvider={setEditingProvider}
              onActivateProvider={handleActivateProvider}
              onDeleteProvider={handleDeleteProvider}
              onSaveProvider={handleSaveProvider}
              onSaveCurrentAsProvider={handleSaveCurrentAsProvider}
              onUpdateCurrentProvider={handleUpdateCurrentProvider}
              parseNumber={parseNumber}
              t={t}
            />
            <ApiSettingsSection
              settings={settings}
              activeProviderId={activeProviderId}
              modelList={modelList}
              modelLoading={modelLoading}
              modelError={modelError}
              update={update}
              onFetchModels={() => void fetchModels()}
              t={t}
            />
            </>)}

            {activeTab === 'generation' && (<>
            <section className="surface-panel p-5">
              <div className="mb-4">
                <h2 className="section-title text-lg">{t('settings.modelParams')}</h2>
              </div>

              <div className="grid gap-4 md:grid-cols-3">
                <div>
                  <label htmlFor="settings-temperature" className="mb-2 block text-sm font-medium text-text-secondary">{t('settings.temperature')}</label>
                  <input
                    id="settings-temperature"
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
                  <label htmlFor="settings-max-tokens" className="mb-2 block text-sm font-medium text-text-secondary">{t('settings.maxTokens')}</label>
                  <input
                    id="settings-max-tokens"
                    type="number"
                    min="1"
                    value={settings.max_tokens}
                    onChange={e => update('max_tokens', parseNumber(e.target.value))}
                    className="input-rich"
                  />
                </div>

                <div>
                  <label htmlFor="settings-context-window" className="mb-2 block text-sm font-medium text-text-secondary">{t('settings.contextWindow')}</label>
                  <input
                    id="settings-context-window"
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
              <div className="mb-2">
                <h2 className="section-title text-lg">{t('settings.advancedSampling')}</h2>
                <p className="mt-1 text-xs text-text-muted">{t('settings.advancedSamplingHint')}</p>
              </div>

              <div className="grid gap-3 md:grid-cols-2">
                <SamplingParamRow
                  id="settings-top-p"
                  label={t('settings.topP')}
                  value={settings.top_p}
                  defaultValue={0.9}
                  min={0} max={1} step={0.01}
                  onChange={v => update('top_p', v)}
                  parseNumber={parseNumber}
                />
                <SamplingParamRow
                  id="settings-top-k"
                  label={t('settings.topK')}
                  value={settings.top_k}
                  defaultValue={40}
                  min={1} max={1000} step={1}
                  onChange={v => update('top_k', v)}
                  parseNumber={parseNumber}
                />
                <SamplingParamRow
                  id="settings-frequency-penalty"
                  label={t('settings.frequencyPenalty')}
                  value={settings.frequency_penalty}
                  defaultValue={0}
                  min={-2} max={2} step={0.05}
                  onChange={v => update('frequency_penalty', v)}
                  parseNumber={parseNumber}
                />
                <SamplingParamRow
                  id="settings-presence-penalty"
                  label={t('settings.presencePenalty')}
                  value={settings.presence_penalty}
                  defaultValue={0}
                  min={-2} max={2} step={0.05}
                  onChange={v => update('presence_penalty', v)}
                  parseNumber={parseNumber}
                />
                <SamplingParamRow
                  id="settings-repetition-penalty"
                  label={t('settings.repetitionPenalty')}
                  value={settings.repetition_penalty}
                  defaultValue={1.1}
                  min={0} max={10} step={0.01}
                  onChange={v => update('repetition_penalty', v)}
                  parseNumber={parseNumber}
                />
                <SamplingParamRow
                  id="settings-seed"
                  label={t('settings.seed')}
                  value={settings.seed}
                  defaultValue={0}
                  min={0} max={2147483647} step={1}
                  onChange={v => update('seed', v)}
                  parseNumber={parseNumber}
                />
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
            <MemoryEngineSection
              settings={settings}
              providers={providers}
              bgModelList={bgModelList}
              bgModelLoading={bgModelLoading}
              bgModelError={bgModelError}
              embeddingModelList={embeddingModelList}
              embeddingModelLoading={embeddingModelLoading}
              embeddingModelError={embeddingModelError}
              rerankerModelList={rerankerModelList}
              rerankerModelLoading={rerankerModelLoading}
              rerankerModelError={rerankerModelError}
              memoryModePreset={resolveMemoryModePreset(settings.memory_engine)}
              update={update}
              updateMemoryEngine={updateMemoryEngine}
              onMemoryModeChange={handleMemoryModeChange}
              onFetchBgModels={fetchBgModels}
              onFetchEmbeddingModels={fetchEmbeddingModels}
              onFetchRerankerModels={fetchRerankerModels}
              onClearBgModelList={() => setBgModelList([])}
              onClearEmbeddingModelList={() => setEmbeddingModelList([])}
              onClearRerankerModelList={() => setRerankerModelList([])}
              parseNumber={parseNumber}
              t={t}
            >
              <MemoryIndexPanel
                t={t}
                status={memoryIndexPanel.status}
                loading={memoryIndexPanel.loading}
                rebuilding={memoryIndexPanel.rebuilding}
                retrying={memoryIndexPanel.retrying}
                indexingUnindexed={memoryIndexPanel.indexingUnindexed}
                clearing={memoryIndexPanel.clearing}
                stopping={memoryIndexPanel.stopping}
                error={memoryIndexPanel.error}
                activeTasks={memoryIndexPanel.activeTasks}
                blockedReason={memoryIndexPanel.blockedReason}
                embeddingModel={settings.memory_engine.embedding_model}
                onRetryFailed={memoryIndexPanel.handleRetryFailedMemoryIndex}
                onRebuild={memoryIndexPanel.handleRebuildMemoryIndex}
                onIndexUnindexed={memoryIndexPanel.handleIndexUnindexedMemoryIndex}
                onClear={memoryIndexPanel.handleClearMemoryIndex}
                onStopCurrent={memoryIndexPanel.handleStopCurrentMemoryTask}
              />

              <MemoryDiagnosticsPanel
                t={t}
                diagnostics={memoryIndexPanel.diagnostics}
                loading={memoryIndexPanel.diagnosticsLoading}
                error={memoryIndexPanel.diagnosticsError}
                onRefresh={() => void memoryIndexPanel.loadMemoryDiagnostics()}
              />

              <MemoryProfilePanel
                t={t}
                management={memoryManagementPanel}
                profile={memoryProfilePanel}
                onCharacterChange={handleMemoryManagementCharacterChange}
              />

              <MemoryArchivePanel
                t={t}
                archive={memoryArchivePanel}
                memoryManagementCharacterId={memoryManagementPanel.memoryManagementCharacterId}
              />

              <MemoryCandidatesPanel
                t={t}
                candidates={memoryCandidatesPanel}
              />
            </MemoryEngineSection>
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
                    <option value="zh">{t('settings.languageZh')}</option>
                    <option value="en">{t('settings.languageEn')}</option>
                  </select>
                </label>

                <div className="rounded-2xl border border-border-light bg-white/70 px-4 py-4 text-sm text-text-secondary md:col-span-2">
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
                          {f === 'wenkai' ? t('settings.fontNameWenkai') : f === 'system' ? t('settings.fontNameSystem') : t('settings.fontNameSerif')}
                        </span>
                        <span className="mt-0.5 block text-xs text-text-muted">{t(`settings.font${f.charAt(0).toUpperCase() + f.slice(1)}`)}</span>
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            </section>
            </>)}

            {activeTab === 'advanced' && (<>
            <ErrorBoundary>
              <ImageGenSettingsSection settings={settings} update={update} parseNumber={parseNumber} t={t} />
            </ErrorBoundary>

            <MaintenanceSection t={t} />
            </>)}
          </main>
        </div>
      </div>
    </div>
  );
}

// ========== 高级采样参数行 ==========
interface SamplingParamRowProps {
  id: string;
  label: string;
  value: number | null;
  /** 勾选启用时若当前值为 null，自动填入的初值 */
  defaultValue: number;
  min: number;
  max: number;
  step: number;
  onChange: (v: number | null) => void;
  parseNumber: (v: string) => number;
}

function SamplingParamRow({ id, label, value, defaultValue, min, max, step, onChange, parseNumber }: SamplingParamRowProps) {
  const enabled = value !== null;
  return (
    <div className={`flex items-center gap-3 rounded-2xl border px-4 py-3 transition-colors ${
      enabled
        ? 'border-accent/30 bg-accent/5'
        : 'border-border-light bg-white/70'
    }`}>
      <input
        type="checkbox"
        checked={enabled}
        onChange={e => {
          if (e.target.checked) {
            // 启用：若当前为 null，填入默认初值；已有值则保留
            onChange(value === null ? defaultValue : value);
          } else {
            // 禁用：置为 null，请求体将不包含该字段
            onChange(null);
          }
        }}
      />
      <label htmlFor={id} className="flex-1 text-sm text-text-secondary">{label}</label>
      <input
        id={id}
        type="number"
        min={min}
        max={max}
        step={step}
        value={enabled ? value : ''}
        disabled={!enabled}
        onChange={e => onChange(parseNumber(e.target.value))}
        className="input-rich w-28"
        placeholder="—"
      />
    </div>
  );
}

// ========== 数据库维护子组件 ==========
interface OrphanFileInfo {
  total: number;
  orphanCount: number;
}

function MaintenanceSection({ t }: { t: (key: string) => string }) {
  const [status, setStatus] = useState<'idle' | 'checking' | 'previewed' | 'cleaning' | 'done' | 'error'>('idle');
  const [previewCount, setPreviewCount] = useState(0);
  const [cleanedCount, setCleanedCount] = useState(0);
  const [orphanFiles, setOrphanFiles] = useState<Record<string, OrphanFileInfo> | null>(null);
  const [fileResults, setFileResults] = useState<Record<string, { deleted: number; errors: number }> | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const handlePreview = async () => {
    setStatus('checking');
    setErrorMessage(null);
    try {
      const res = await fetch('/api/maintenance');
      const data = await parseJsonResponse<{ total: number; orphanFiles: Record<string, OrphanFileInfo> }>(res);
      setPreviewCount(data.total);
      setOrphanFiles(data.orphanFiles);
      setFileResults(null);
      setStatus('previewed');
    } catch (err) {
      setErrorMessage(`${t('settings.cleanupPreviewFailed')}: ${getErrorMessage(err)}`);
      setStatus('error');
    }
  };

  const handleCleanup = async () => {
    setStatus('cleaning');
    setErrorMessage(null);
    try {
      // 注意：proxy.ts 的 CSRF 校验要求写方法带 application/json 头
      const res = await fetch('/api/maintenance', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });
      const data = await parseJsonResponse<{ dbDeleted: number; fileResults: Record<string, { deleted: number; errors: number }> }>(res);
      setCleanedCount(data.dbDeleted);
      setFileResults(data.fileResults);
      setStatus('done');
    } catch (err) {
      setErrorMessage(`${t('settings.cleanupFailed')}: ${getErrorMessage(err)}`);
      setStatus('error');
    }
  };

  const fileOrphanCount = (orphanFiles?.avatars?.orphanCount || 0) + (orphanFiles?.attachments?.orphanCount || 0) + (orphanFiles?.generated?.orphanCount || 0);
  const totalOrphans = previewCount + fileOrphanCount;
  const fileCleanedCount = (fileResults?.avatars?.deleted || 0) + (fileResults?.attachments?.deleted || 0) + (fileResults?.generated?.deleted || 0);
  const totalCleaned = cleanedCount + fileCleanedCount;

  const getMessage = () => {
    if (status === 'checking') return t('settings.cleanupRunning');
    if (status === 'cleaning') return t('settings.cleanupRunning');
    if (status === 'error') return errorMessage;
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
            status === 'error' ? 'text-red-600'
            : status === 'done' && totalCleaned > 0 ? 'text-green-600'
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
