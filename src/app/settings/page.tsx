'use client';

import { useEffect, useMemo, useRef, useState, useCallback, type Dispatch, type SetStateAction } from 'react';
import Link from 'next/link';
import {
  DEFAULT_MEMORY_ENGINE_SETTINGS,
  DEFAULT_SETTINGS,
  Settings,
  FontSize,
  FontStyle,
  MemoryEngineSettings,
} from '@/types';
import { applyFontSize, applyFontStyle } from '@/lib/font-stacks';
import { writeThemeStorage } from '@/lib/theme-provider';
import { API_KEY_MASK } from '@/lib/constants';
import { getErrorMessage, parseJsonResponse } from '@/lib/http';
import { formatTemplate } from '@/lib/i18n';
import { useRouter } from 'next/navigation';
import { useTranslation } from '@/lib/i18n-context';
import { useToast } from '@/components/ui/Toast';
import { ArrowLeftIcon } from '@/components/ui/icons';
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
import { DisplaySettingsSection } from '@/components/settings/DisplaySettingsSection';
import { ApiSettingsSection } from '@/components/settings/ApiSettingsSection';
import { ProviderSettingsSection } from '@/components/settings/ProviderSettingsSection';
import ConfirmModal from '@/components/ui/ConfirmModal';
import { useSettingsAuth } from '@/hooks/settings/useSettingsAuth';
import { useSettingsProviders } from '@/hooks/settings/useSettingsProviders';
import { forgetImageBlobs } from '@/lib/image-blob-cache';

type ModelCredentialSource = 'chat' | 'embedding' | 'reranker';

type SettingsWithMemoryEngine = Settings & {
  memory_engine: MemoryEngineSettings;
};

const DEFAULT_SETTINGS_WITH_MEMORY_ENGINE: SettingsWithMemoryEngine = {
  ...DEFAULT_SETTINGS,
  memory_engine: DEFAULT_MEMORY_ENGINE_SETTINGS,
};

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

type SettingsTab = 'api' | 'generation' | 'memory' | 'appearance' | 'advanced';

const SETTINGS_TABS: Array<{ key: SettingsTab; label: string }> = [
  { key: 'api', label: 'settings.tabApi' },
  { key: 'generation', label: 'settings.tabGeneration' },
  { key: 'memory', label: 'settings.tabMemory' },
  { key: 'appearance', label: 'settings.tabAppearance' },
  { key: 'advanced', label: 'settings.tabAdvanced' },
];

/** 记忆页很长：顶部给一排跳转入口，id 对应下方各面板的包裹元素 */
const MEMORY_ANCHORS = [
  { id: 'settings-memory-index', label: 'settings.memoryIndexStatus' },
  { id: 'settings-memory-diagnostics', label: 'settings.memoryDiagnosticsTitle' },
  { id: 'settings-memory-profile', label: 'settings.memoryProfileTitle' },
  { id: 'settings-memory-archive', label: 'settings.memoryArchiveTitle' },
  { id: 'settings-memory-candidates', label: 'settings.memoryCandidatesTitle' },
];
const MEMORY_ANCHOR_TARGET = 'scroll-mt-28 lg:scroll-mt-20';

export default function SettingsPage() {
  const router = useRouter();
  const [settings, setSettings] = useState<SettingsWithMemoryEngine>(DEFAULT_SETTINGS_WITH_MEMORY_ENGINE);
  // 与服务端一致的那份设置；settings 与它不同即「有未保存的修改」
  const [savedSettings, setSavedSettings] = useState<SettingsWithMemoryEngine>(DEFAULT_SETTINGS_WITH_MEMORY_ENGINE);
  const applyServerSettings: Dispatch<SetStateAction<SettingsWithMemoryEngine>> = useCallback(action => {
    setSettings(action);
    setSavedSettings(action);
  }, []);
  const hasUnsavedChanges = useMemo(
    () => JSON.stringify(settings) !== JSON.stringify(savedSettings),
    [savedSettings, settings],
  );
  const [saving, setSaving] = useState<'idle' | 'saving'>('idle');
  const [modelList, setModelList] = useState<string[]>([]);
  const [modelLoading, setModelLoading] = useState(false);
  const [modelError, setModelError] = useState<string | null>(null);
  const [embeddingModelList, setEmbeddingModelList] = useState<string[]>([]);
  const [embeddingModelLoading, setEmbeddingModelLoading] = useState(false);
  const [embeddingModelError, setEmbeddingModelError] = useState<string | null>(null);
  const [rerankerModelList, setRerankerModelList] = useState<string[]>([]);
  const [rerankerModelLoading, setRerankerModelLoading] = useState(false);
  const [rerankerModelError, setRerankerModelError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<SettingsTab>('api');
  const [pendingCharacterId, setPendingCharacterId] = useState<string | null>(null);
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
    setSettings: applyServerSettings,
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

  /** 通用模型列表获取，供 embedding / reranker 使用 */
  const fetchModelList = async (
    apiBase: string,
    apiKey: string,
    credentialSource?: ModelCredentialSource,
  ): Promise<string[]> => {
    const body: Record<string, unknown> = { refresh: true, api_base: apiBase };
    if (credentialSource) body.credential_source = credentialSource;
    const effectiveKey = apiKey && apiKey !== API_KEY_MASK ? apiKey : undefined;
    if (effectiveKey) body.api_key = effectiveKey;
    const response = await fetch('/api/models', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await parseJsonResponse<{ error?: string; models?: string[] }>(response);
    if (data.error) throw new Error(data.error);
    return data.models || [];
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
    const snapshot = settings;
    try {
      const response = await fetch('/api/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(settings),
      });
      const saved = await parseJsonResponse<{
        memory_index_backfill?: {
          queued?: number;
          processing_started?: boolean;
          reason?: string | null;
        };
      }>(response);
      setSavedSettings(snapshot);
      // 接口字段改了就一并写回当前供应商，否则切走再切回会被旧配置覆盖
      if (activeProviderId) await handleUpdateCurrentProvider();
      setLang(settings.language);
      document.documentElement.classList.toggle('dark', settings.theme === 'dark');
      writeThemeStorage(settings.theme);
      applyFontStyle((settings.font_style || 'wenkai') as FontStyle);
      applyFontSize((settings.font_size || 'medium') as FontSize);
      showToast(t('settings.saveSuccess'), 'success');
      const backfillReason = saved.memory_index_backfill?.reason ?? null;
      const backfillQueued = Number(saved.memory_index_backfill?.queued || 0);
      if (backfillQueued > 0) {
        showToast(
          formatTemplate(t('settings.memoryIndexAutoBackfillQueued'), {
            count: String(backfillQueued),
          }),
          'success',
        );
      }
      if (backfillReason === 'target_changed') {
        // 换模型/维度后旧 target 的 embedding 行仍在库内但检索不再使用；
        // 此时用户可能不在 memory tab、status 未拉取，只能主动 GET 一次判断。
        try {
          const index = await parseJsonResponse<{ other_target_ready?: number; embedding_rows?: number }>(
            await fetch('/api/memory-index'),
          );
          const otherTargetReady = index.other_target_ready ?? 0;
          if (otherTargetReady > 0) {
            showToast(
              formatTemplate(t('settings.memoryIndexOtherTargetHint'), {
                count: String(otherTargetReady),
                rows: String(index.embedding_rows ?? 0),
              }),
              'info',
            );
          }
        } catch {
          // 提示失败不阻塞保存主流程
        }
      }
    } catch (err) {
      showToast(`${t('settings.saveFailed')}: ${getErrorMessage(err)}`, 'error');
    } finally {
      setSaving('idle');
    }
  };

  const applyMemoryManagementCharacterChange = (characterId: string) => {
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

  const handleMemoryManagementCharacterChange = (characterId: string) => {
    if (
      characterId !== memoryManagementPanel.memoryManagementCharacterId
      && memoryProfilePanel.isProfileDraftDirty
    ) {
      setPendingCharacterId(characterId);
      return;
    }
    applyMemoryManagementCharacterChange(characterId);
  };

  const loadInitialSettingsAndAuth = useCallback(() => {
    void fetch('/api/settings')
      .then(r => parseJsonResponse<Partial<SettingsWithMemoryEngine>>(r))
      .then(s => {
        const merged = mergeSettingsWithMemoryEngine(s);
        applyServerSettings(merged);
        document.documentElement.classList.toggle('dark', s.theme === 'dark');
        writeThemeStorage(merged.theme);
        applyFontStyle((merged.font_style || 'wenkai') as FontStyle);
        applyFontSize((merged.font_size || 'medium') as FontSize);
      })
      .catch(err => {
        showToast(`${tRef.current('settings.loadFailed')}: ${getErrorMessage(err)}`, 'error');
    });
  }, [applyServerSettings, showToast]);

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

  useEffect(() => {
    if (!hasUnsavedChanges) return;
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [hasUnsavedChanges]);

  return (
    <div className="app-shell flex min-h-dvh flex-col">
      <header className="sticky top-0 z-20 border-b border-border-light bg-surface">
        <div className="mx-auto flex h-14 max-w-5xl items-center gap-1 px-1 sm:px-3">
          <button
            onClick={() => router.push('/')}
            className="flex min-h-11 min-w-11 shrink-0 items-center justify-center gap-1.5 rounded-xl text-text-secondary transition-colors hover:bg-surface-2 hover:text-text-primary sm:px-2.5"
          >
            <ArrowLeftIcon className="h-5 w-5 sm:h-4 sm:w-4" />
            <span className="sr-only text-sm sm:not-sr-only">{t('settings.back')}</span>
          </button>
          <h1 className="min-w-0 flex-1 truncate px-1 text-base font-semibold text-text-primary">{t('settings.title')}</h1>
          {authEnabled && (
            <button onClick={handleLogout} className="soft-button soft-button-danger mr-2 text-sm">
              {t('auth.logout')}
            </button>
          )}
        </div>
      </header>

      <div className="mx-auto flex w-full max-w-5xl flex-1 flex-col lg:flex-row lg:gap-8 lg:px-4 lg:py-6">
        {/* 同一份导航：<lg 是吸顶的横向页签，lg+ 是左侧竖排 */}
        <nav
          className="sticky top-14 z-10 flex gap-1 overflow-x-auto border-b border-border-light bg-surface px-2 lg:top-20 lg:w-44 lg:shrink-0 lg:flex-col lg:self-start lg:overflow-visible lg:border-0 lg:bg-transparent lg:px-0"
          aria-label={t('settings.title')}
        >
          {SETTINGS_TABS.map(tab => (
            <button
              key={tab.key}
              type="button"
              onClick={() => setActiveTab(tab.key)}
              className={`min-h-11 shrink-0 whitespace-nowrap border-b-2 px-3 text-sm transition-colors lg:min-h-10 lg:rounded-xl lg:border-b-0 lg:text-left ${
                activeTab === tab.key
                  ? 'border-accent font-medium text-accent-dark lg:bg-accent/12'
                  : 'border-transparent text-text-secondary hover:text-text-primary lg:hover:bg-surface-2'
              }`}
              aria-pressed={activeTab === tab.key}
            >
              {t(tab.label)}
            </button>
          ))}
        </nav>

        <main className="min-w-0 flex-1 space-y-4 px-3 py-4 sm:px-4 lg:max-w-[45rem] lg:p-0">
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
            <Link
              href="/settings/prompt-presets"
              className="surface-panel flex items-center justify-between gap-4 px-5 py-4 transition-shadow hover:shadow-md"
            >
              <div>
                <h2 className="text-base font-semibold text-text-primary">{t('preset.pageTitle')}</h2>
                <p className="mt-1 text-sm text-text-muted">{t('preset.pageSubtitle')}</p>
              </div>
              <span className="soft-button soft-button-primary shrink-0 whitespace-nowrap">
                {t('preset.manage')}
              </span>
            </Link>

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
                <label className="flex items-center gap-3 rounded-2xl border border-border-light bg-surface/70 px-4 py-3 text-sm text-text-secondary">
                  <input
                    type="checkbox"
                    checked={settings.streaming}
                    onChange={e => update('streaming', e.target.checked)}
                  />
                  {t('settings.streaming')}
                </label>

                <label className="flex items-center gap-3 rounded-2xl border border-border-light bg-surface/70 px-4 py-3 text-sm text-text-secondary">
                  <input
                    type="checkbox"
                    checked={settings.example_dialogue}
                    onChange={e => update('example_dialogue', e.target.checked)}
                  />
                  {t('settings.exampleDialogue')}
                </label>

                <label className="flex items-center gap-3 rounded-2xl border border-border-light bg-surface/70 px-4 py-3 text-sm text-text-secondary">
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
            <nav className="flex flex-wrap gap-2" aria-label={t('settings.tabMemory')}>
              {MEMORY_ANCHORS.map(anchor => (
                <button
                  key={anchor.id}
                  type="button"
                  onClick={() => document.getElementById(anchor.id)?.scrollIntoView({ block: 'start' })}
                  className="chip cursor-pointer hover:bg-surface-3"
                >
                  {t(anchor.label)}
                </button>
              ))}
            </nav>
            <MemoryEngineSection
              settings={settings}
              embeddingModelList={embeddingModelList}
              embeddingModelLoading={embeddingModelLoading}
              embeddingModelError={embeddingModelError}
              rerankerModelList={rerankerModelList}
              rerankerModelLoading={rerankerModelLoading}
              rerankerModelError={rerankerModelError}
              update={update}
              updateMemoryEngine={updateMemoryEngine}
              onFetchEmbeddingModels={fetchEmbeddingModels}
              onFetchRerankerModels={fetchRerankerModels}
              onClearEmbeddingModelList={() => setEmbeddingModelList([])}
              onClearRerankerModelList={() => setRerankerModelList([])}
              parseNumber={parseNumber}
              t={t}
            >
              <div id="settings-memory-index" className={MEMORY_ANCHOR_TARGET}>
              <MemoryIndexPanel
                t={t}
                status={memoryIndexPanel.status}
                loading={memoryIndexPanel.loading}
                rebuilding={memoryIndexPanel.rebuilding}
                retrying={memoryIndexPanel.retrying}
                indexingUnindexed={memoryIndexPanel.indexingUnindexed}
                clearing={memoryIndexPanel.clearing}
                clearingOther={memoryIndexPanel.clearingOther}
                stopping={memoryIndexPanel.stopping}
                error={memoryIndexPanel.error}
                activeTasks={memoryIndexPanel.activeTasks}
                blockedReason={memoryIndexPanel.blockedReason}
                embeddingModel={settings.memory_engine.embedding_model}
                onRetryFailed={memoryIndexPanel.handleRetryFailedMemoryIndex}
                onRebuild={memoryIndexPanel.handleRebuildMemoryIndex}
                onIndexUnindexed={memoryIndexPanel.handleIndexUnindexedMemoryIndex}
                onClear={memoryIndexPanel.handleClearMemoryIndex}
                onClearOtherTargets={memoryIndexPanel.handleClearOtherTargetMemoryIndex}
                onStopCurrent={memoryIndexPanel.handleStopCurrentMemoryTask}
              />
              </div>

              <div id="settings-memory-diagnostics" className={MEMORY_ANCHOR_TARGET}>
              <MemoryDiagnosticsPanel
                t={t}
                diagnostics={memoryIndexPanel.diagnostics}
                loading={memoryIndexPanel.diagnosticsLoading}
                error={memoryIndexPanel.diagnosticsError}
                onRefresh={() => void memoryIndexPanel.loadMemoryDiagnostics()}
              />
              </div>

              <div id="settings-memory-profile" className={MEMORY_ANCHOR_TARGET}>
              <MemoryProfilePanel
                t={t}
                management={memoryManagementPanel}
                profile={memoryProfilePanel}
                onCharacterChange={handleMemoryManagementCharacterChange}
              />
              </div>

              <div id="settings-memory-archive" className={MEMORY_ANCHOR_TARGET}>
              <MemoryArchivePanel
                t={t}
                archive={memoryArchivePanel}
                memoryManagementCharacterId={memoryManagementPanel.memoryManagementCharacterId}
              />
              </div>

              <div id="settings-memory-candidates" className={MEMORY_ANCHOR_TARGET}>
              <MemoryCandidatesPanel
                t={t}
                candidates={memoryCandidatesPanel}
              />
              </div>
            </MemoryEngineSection>
            </>)}

            {activeTab === 'appearance' && (
              <DisplaySettingsSection
                settings={settings}
                update={update}
                t={t}
                applyFontStyle={applyFontStyle}
                applyFontSize={applyFontSize}
              />
            )}

            {activeTab === 'advanced' && (<>
            <ErrorBoundary>
              <ImageGenSettingsSection settings={settings} update={update} parseNumber={parseNumber} t={t} />
            </ErrorBoundary>

            <MaintenanceSection t={t} />
            </>)}
        </main>
      </div>

      <div className="sticky bottom-0 z-20 border-t border-border-light bg-surface">
        <div className="mx-auto flex max-w-5xl items-center gap-3 px-4 pb-[max(0.625rem,env(safe-area-inset-bottom))] pt-2.5">
          <p className="flex min-w-0 flex-1 items-center gap-2 text-sm text-text-secondary" aria-live="polite">
            {hasUnsavedChanges && <span aria-hidden="true" className="h-2 w-2 shrink-0 rounded-full bg-accent" />}
            <span className={`truncate ${hasUnsavedChanges ? '' : 'text-text-muted'}`}>
              {hasUnsavedChanges ? t('common.unsavedChanges') : t('common.noUnsavedChanges')}
            </span>
          </p>
          <button
            onClick={handleSave}
            disabled={saving !== 'idle'}
            className="soft-button soft-button-primary shrink-0 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {saving === 'saving' && <span className="spinner-sm" aria-hidden="true" />}
            {saving === 'saving' ? t('settings.saving') : t('settings.save')}
          </button>
        </div>
      </div>

      <ConfirmModal
        open={pendingCharacterId !== null}
        title={t('settings.memoryProfileTitle')}
        message={t('settings.memoryProfileDiscardConfirm')}
        danger
        confirmLabel={t('common.confirm')}
        onConfirm={() => {
          const nextId = pendingCharacterId;
          setPendingCharacterId(null);
          if (nextId !== null) applyMemoryManagementCharacterChange(nextId);
        }}
        onCancel={() => setPendingCharacterId(null)}
      />
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
        : 'border-border-light bg-surface/70'
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
      const data = await parseJsonResponse<{
        dbDeleted: number;
        fileResults: Record<string, { deleted: number; errors: number }>;
        deletedUrls?: string[];
      }>(res);
      try {
        await forgetImageBlobs(data.deletedUrls ?? []);
      } catch (error) {
        console.warn('[image-cache] 维护清理已成功，但本地图片缓存失效失败：', error);
      }
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
