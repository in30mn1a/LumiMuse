'use client';

import { useEffect, useState, useCallback, useRef } from 'react';
import {
  DEFAULT_MEMORY_ENGINE_SETTINGS,
  DEFAULT_SETTINGS,
  Settings,
  ImageGenSettings,
  DEFAULT_IMAGE_GEN_SETTINGS,
  FontStyle,
  ApiProvider,
  ArtistString,
  MemoryEngineSettings,
} from '@/types';
import { applyFontStyle } from '@/lib/font-stacks';
import { writeThemeStorage } from '@/lib/theme-provider';
import { API_KEY_MASK } from '@/lib/constants';
import { expectOkResponse, getErrorMessage, parseJsonResponse } from '@/lib/http';
import { formatTemplate } from '@/lib/i18n';
import { useRouter } from 'next/navigation';
import { useTranslation } from '@/lib/i18n-context';
import { useToast } from '@/components/ui/Toast';
import { ArrowLeftIcon, SparkIcon, SettingsIcon, ImageIcon, RefreshIcon, StopIcon, TrashIcon } from '@/components/ui/icons';

type MemoryModePreset = 'local' | 'balanced' | 'continuity';
type ModelCredentialSource = 'chat' | 'embedding' | 'reranker';
type MemoryIndexProcessingBlockedReason =
  | 'memory_engine_disabled'
  | 'external_memory_payloads_disabled'
  | 'embedding_disabled'
  | 'embedding_api_base_missing'
  | 'embedding_model_missing';

type SettingsWithMemoryEngine = Settings & {
  memory_engine: MemoryEngineSettings;
};

interface MemoryIndexStatus {
  indexed: number;
  total: number;
  failed: number;
  pending?: number;
  queued?: number;
  processing?: number;
  canRebuild?: boolean;
  latest_error?: string | null;
  processing_blocked_reason?: MemoryIndexProcessingBlockedReason;
}

interface MemoryIndexActionResponse {
  ok: boolean;
  queued?: number;
  processing_blocked_reason?: MemoryIndexProcessingBlockedReason;
}

interface MemoryCandidate {
  id: number;
  character_id: string;
  conversation_id: string | null;
  raw_candidate: Record<string, unknown>;
  error_reason: string | null;
  created_at: string;
}

interface MemoryDiagnostics {
  index: { total: number; ready: number; failed: number };
  tasks: Record<string, number>;
  candidates: Record<string, number>;
  profile: { exists: boolean; filled_fields: number };
  archive: Record<string, number>;
}

interface MemoryProfileResponse {
  profile: {
    character_id: string;
    profile_name: string;
    relationship_state: string;
    recent_story_state: string;
    emotional_baseline: string;
    open_threads: string[];
    user_profile_summary: string;
    pinned_summary: string;
    updated_at: string;
  } | null;
  versions: Array<{
    id: number;
    version_number: number;
    snapshot: { profile_name?: string };
    reason: string;
    created_at: string;
  }>;
  tasks: Array<{ id: number; reason: string; status: string; retry_count: number; error_message: string | null }>;
}

interface MemoryProfileActionResponse {
  ok: boolean;
  error?: string;
  detail?: string;
  status?: string;
  created?: boolean;
  already_exists?: boolean;
  processed?: number;
  skipped?: number;
  failed?: number;
  remaining?: number;
  no_pending_tasks?: boolean;
  memory_count?: number;
}

interface MemoryManagementCharacter {
  id: string;
  name: string;
}

interface MemoryArchiveSelectableMemory {
  id: string;
  category: string;
  content: string;
  status: string;
  pinned: boolean;
  updated_at: string;
}

interface MemoryArchiveBatch {
  batch_id: string;
  summary_memory_id: string | null;
  summary_content: string;
  covered_count: number;
  updated_at: string;
}

interface MemoryArchivePlan {
  summaryMemory: { id: string; content: string };
  coveredMemoryUpdates: Array<{ id: string; status: string }>;
}

const CHAT_RETRIEVAL_TIMEOUT_MS = 2500;
const CONTINUITY_CHAT_RETRIEVAL_TIMEOUT_MS = 5000;
const MEMORY_INDEX_STATUS_POLL_INTERVAL_MS = 2000;
const MEMORY_ARCHIVE_MEMORY_LIMIT = 200;

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

function getCandidateText(candidate: MemoryCandidate, key: string): string {
  const value = candidate.raw_candidate[key];
  return typeof value === 'string' ? value : '';
}

function getCandidateTags(candidate: MemoryCandidate): string {
  const value = candidate.raw_candidate.tags;
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === 'string').join(', ');
  return typeof value === 'string' ? value : '';
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
  const [authEnabled, setAuthEnabled] = useState(false);
  const [providers, setProviders] = useState<ApiProvider[]>([]);
  const [activeProviderId, setActiveProviderId] = useState('');
  const [editingProvider, setEditingProvider] = useState<Partial<ApiProvider> | null>(null);
  const [activeTab, setActiveTab] = useState<'api' | 'generation' | 'memory' | 'advanced'>('api');
  const [memoryIndexStatus, setMemoryIndexStatus] = useState<MemoryIndexStatus | null>(null);
  const [memoryIndexLoading, setMemoryIndexLoading] = useState(false);
  const [memoryIndexRebuilding, setMemoryIndexRebuilding] = useState(false);
  const [memoryIndexRetrying, setMemoryIndexRetrying] = useState(false);
  const [memoryIndexIndexingUnindexed, setMemoryIndexIndexingUnindexed] = useState(false);
  const [memoryIndexClearing, setMemoryIndexClearing] = useState(false);
  const [memoryIndexStopping, setMemoryIndexStopping] = useState(false);
  const [memoryIndexError, setMemoryIndexError] = useState<string | null>(null);
  const [memoryCandidates, setMemoryCandidates] = useState<MemoryCandidate[]>([]);
  const [memoryCandidatesLoading, setMemoryCandidatesLoading] = useState(false);
  const [memoryCandidatesError, setMemoryCandidatesError] = useState<string | null>(null);
  const [memoryCandidateActionId, setMemoryCandidateActionId] = useState<number | null>(null);
  const [editingMemoryCandidateId, setEditingMemoryCandidateId] = useState<number | null>(null);
  const [memoryCandidateEdits, setMemoryCandidateEdits] = useState<Record<number, string>>({});
  const [memoryDiagnostics, setMemoryDiagnostics] = useState<MemoryDiagnostics | null>(null);
  const [memoryDiagnosticsLoading, setMemoryDiagnosticsLoading] = useState(false);
  const [memoryDiagnosticsError, setMemoryDiagnosticsError] = useState<string | null>(null);
  const [memoryManagementCharacters, setMemoryManagementCharacters] = useState<MemoryManagementCharacter[]>([]);
  const [memoryManagementCharacterId, setMemoryManagementCharacterId] = useState('');
  const [memoryManagementLoading, setMemoryManagementLoading] = useState(false);
  const [memoryManagementError, setMemoryManagementError] = useState<string | null>(null);
  const [memoryProfile, setMemoryProfile] = useState<MemoryProfileResponse | null>(null);
  const [memoryProfileLoading, setMemoryProfileLoading] = useState(false);
  const [memoryProfileActionLoading, setMemoryProfileActionLoading] = useState(false);
  const [memoryProfileError, setMemoryProfileError] = useState<string | null>(null);
  const [editingProfile, setEditingProfile] = useState(false);
  const [editingProfileDraft, setEditingProfileDraft] = useState<Record<string, string>>({});
  const [memoryArchiveMemories, setMemoryArchiveMemories] = useState<MemoryArchiveSelectableMemory[]>([]);
  const [selectedMemoryArchiveIds, setSelectedMemoryArchiveIds] = useState<string[]>([]);
  const [memoryArchiveSummary, setMemoryArchiveSummary] = useState('');
  const [memoryArchiveBatches, setMemoryArchiveBatches] = useState<MemoryArchiveBatch[]>([]);
  const [selectedMemoryArchiveBatchId, setSelectedMemoryArchiveBatchId] = useState('');
  const [memoryArchivePlan, setMemoryArchivePlan] = useState<MemoryArchivePlan | null>(null);
  const [memoryArchiveBatchDetail, setMemoryArchiveBatchDetail] = useState<{
    covered: Array<{ id: string; category: string; content: string; status: string }>;
    summary: { id: string; content: string } | null;
  } | null>(null);
  const [memoryArchiveLoading, setMemoryArchiveLoading] = useState(false);
  const [memoryArchiveListLoading, setMemoryArchiveListLoading] = useState(false);
  const [memoryArchiveHasMore, setMemoryArchiveHasMore] = useState(false);
  const [memoryArchiveTotal, setMemoryArchiveTotal] = useState(0);
  const [memoryArchiveOffset, setMemoryArchiveOffset] = useState(0);
  const [memoryArchiveError, setMemoryArchiveError] = useState<string | null>(null);
  const [memoryArchiveAiRunning, setMemoryArchiveAiRunning] = useState(false);
  const memoryManagementCharacterIdRef = useRef('');
  const memoryArchiveRequestSeqRef = useRef(0);
  const memoryArchiveAiControllerRef = useRef<AbortController | null>(null);
  const { t, setLang } = useTranslation();
  const { showToast } = useToast();
  const formatMemoryIndexBlockedReason = useCallback((reason?: MemoryIndexProcessingBlockedReason | null): string | null => {
    return reason ? t(`settings.memoryIndexBlocked.${reason}`) : null;
  }, [t]);
  const showMemoryIndexActionResult = useCallback((result: MemoryIndexActionResponse, successKey: string) => {
    const blockedReason = formatMemoryIndexBlockedReason(result.processing_blocked_reason);
    if (blockedReason) {
      const message = formatTemplate(t('settings.memoryIndexProcessingBlocked'), { reason: blockedReason });
      setMemoryIndexError(message);
      showToast(message, 'error');
      return;
    }
    showToast(t(successKey), 'success');
  }, [formatMemoryIndexBlockedReason, showToast, t]);
  const memoryEngineEnabled = settings.memory_engine.enabled;
  const memoryIndexActiveTasks = (memoryIndexStatus?.pending ?? memoryIndexStatus?.queued ?? 0) + (memoryIndexStatus?.processing ?? 0);
  const memoryIndexBlockedReason = formatMemoryIndexBlockedReason(memoryIndexStatus?.processing_blocked_reason);
  const memoryArchiveShownCount = Math.max(memoryArchiveMemories.length, memoryArchiveOffset);

  const loadProviders = useCallback(async () => {
    try {
      const data = await parseJsonResponse<{ providers?: ApiProvider[]; active_provider_id?: string }>(await fetch('/api/providers'));
      setProviders(data.providers || []);
      setActiveProviderId(data.active_provider_id || '');
    } catch (err) {
      showToast(`${t('common.loadFailed')}: ${getErrorMessage(err)}`, 'error');
    }
  }, [showToast, t]);

  const loadMemoryIndexStatus = useCallback(async (options: { silent?: boolean } = {}) => {
    if (!options.silent) setMemoryIndexLoading(true);
    setMemoryIndexError(null);
    try {
      const data = await parseJsonResponse<MemoryIndexStatus>(await fetch('/api/memory-index'));
      setMemoryIndexStatus(data);
    } catch (err) {
      setMemoryIndexError(getErrorMessage(err));
    } finally {
      if (!options.silent) setMemoryIndexLoading(false);
    }
  }, []);

  const loadMemoryCandidates = useCallback(async () => {
    setMemoryCandidatesLoading(true);
    setMemoryCandidatesError(null);
    try {
      const data = await parseJsonResponse<{ candidates?: MemoryCandidate[] }>(await fetch('/api/memory-candidates?limit=50'));
      setMemoryCandidates(data.candidates || []);
    } catch (err) {
      setMemoryCandidatesError(getErrorMessage(err));
    } finally {
      setMemoryCandidatesLoading(false);
    }
  }, []);

  const loadMemoryDiagnostics = useCallback(async (options: { silent?: boolean } = {}) => {
    if (!options.silent) setMemoryDiagnosticsLoading(true);
    setMemoryDiagnosticsError(null);
    const diagnosticsCharacterId = memoryManagementCharacterIdRef.current.trim();
    try {
      const query = diagnosticsCharacterId ? `?character_id=${encodeURIComponent(diagnosticsCharacterId)}` : '';
      const data = await parseJsonResponse<MemoryDiagnostics>(await fetch(`/api/memory-diagnostics${query}`));
      // 丢弃陈旧响应:发起请求后管理角色若已切换,不要用旧角色的数据覆盖当前角色
      if (memoryManagementCharacterIdRef.current.trim() !== diagnosticsCharacterId) return;
      setMemoryDiagnostics(data);
    } catch (err) {
      if (memoryManagementCharacterIdRef.current.trim() !== diagnosticsCharacterId) return;
      setMemoryDiagnosticsError(getErrorMessage(err));
    } finally {
      if (!options.silent) setMemoryDiagnosticsLoading(false);
    }
  }, []);

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

  const handleRebuildMemoryIndex = async () => {
    setMemoryIndexRebuilding(true);
    setMemoryIndexError(null);
    try {
      const result = await parseJsonResponse<MemoryIndexActionResponse>(await fetch('/api/memory-index', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'rebuild' }),
      }));
      showMemoryIndexActionResult(result, 'settings.memoryIndexRebuildQueued');
      await loadMemoryIndexStatus();
    } catch (err) {
      const message = getErrorMessage(err);
      setMemoryIndexError(message);
      showToast(`${t('settings.memoryIndexRebuildFailed')}: ${message}`, 'error');
    } finally {
      setMemoryIndexRebuilding(false);
    }
  };

  const handleRetryFailedMemoryIndex = async () => {
    setMemoryIndexRetrying(true);
    setMemoryIndexError(null);
    try {
      const result = await parseJsonResponse<MemoryIndexActionResponse>(await fetch('/api/memory-index', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'retry_failed' }),
      }));
      showMemoryIndexActionResult(result, 'settings.memoryIndexRetryFailedQueued');
      await loadMemoryIndexStatus();
    } catch (err) {
      const message = getErrorMessage(err);
      setMemoryIndexError(message);
      showToast(`${t('settings.memoryIndexRetryFailedError')}: ${message}`, 'error');
    } finally {
      setMemoryIndexRetrying(false);
    }
  };

  const handleIndexUnindexedMemoryIndex = async () => {
    setMemoryIndexIndexingUnindexed(true);
    setMemoryIndexError(null);
    try {
      const result = await parseJsonResponse<MemoryIndexActionResponse>(await fetch('/api/memory-index', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'index_unindexed' }),
      }));
      showMemoryIndexActionResult(result, 'settings.memoryIndexIndexUnindexedQueued');
      await loadMemoryIndexStatus();
    } catch (err) {
      const message = getErrorMessage(err);
      setMemoryIndexError(message);
      showToast(`${t('settings.memoryIndexIndexUnindexedFailed')}: ${message}`, 'error');
    } finally {
      setMemoryIndexIndexingUnindexed(false);
    }
  };

  const handleClearMemoryIndex = async () => {
    setMemoryIndexClearing(true);
    setMemoryIndexError(null);
    try {
      await parseJsonResponse<{ ok: boolean }>(await fetch('/api/memory-index', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'clear_index' }),
      }));
      showToast(t('settings.memoryIndexClearSuccess'), 'success');
      await loadMemoryIndexStatus();
      await loadMemoryDiagnostics();
    } catch (err) {
      const message = getErrorMessage(err);
      setMemoryIndexError(message);
      showToast(`${t('settings.memoryIndexClearFailed')}: ${message}`, 'error');
    } finally {
      setMemoryIndexClearing(false);
    }
  };

  const handleStopCurrentMemoryTask = async () => {
    setMemoryIndexStopping(true);
    setMemoryIndexError(null);
    try {
      await parseJsonResponse<{ ok: boolean }>(await fetch('/api/memory-index', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'stop_current' }),
      }));
      showToast(t('settings.memoryIndexStopCurrentSuccess'), 'success');
      await loadMemoryIndexStatus();
      await loadMemoryDiagnostics();
    } catch (err) {
      const message = getErrorMessage(err);
      setMemoryIndexError(message);
      showToast(`${t('settings.memoryIndexStopCurrentFailed')}: ${message}`, 'error');
    } finally {
      setMemoryIndexStopping(false);
    }
  };

  const handleMemoryCandidateAction = async (
    candidate: MemoryCandidate,
    action: 'accept' | 'edit-accept' | 'ignore' | 'discard',
  ) => {
    if (action === 'edit-accept') {
      const content = (memoryCandidateEdits[candidate.id] ?? getCandidateText(candidate, 'content')).trim();
      if (!content) {
        showToast(t('settings.memoryCandidatesEmptyContent'), 'error');
        return;
      }
    }

    setMemoryCandidateActionId(candidate.id);
    try {
      const body: Record<string, unknown> = {
        action: action === 'edit-accept' ? 'accept' : action,
      };
      if (action === 'edit-accept') {
        body.memory = {
          content: (memoryCandidateEdits[candidate.id] ?? getCandidateText(candidate, 'content')).trim(),
        };
      }
      await expectOkResponse(await fetch(`/api/memory-candidates/${candidate.id}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }));
      setEditingMemoryCandidateId(null);
      setMemoryCandidateEdits(prev => {
        const next = { ...prev };
        delete next[candidate.id];
        return next;
      });
      await loadMemoryCandidates();
    } catch (err) {
      showToast(`${t('settings.memoryCandidatesActionFailed')}: ${getErrorMessage(err)}`, 'error');
    } finally {
      setMemoryCandidateActionId(null);
    }
  };

  const loadMemoryProfile = useCallback(async (characterId: string) => {
    const trimmed = characterId.trim();
    if (!trimmed) {
      setMemoryProfileError(t('settings.memoryProfileCharacterRequired'));
      return;
    }

    setMemoryProfileLoading(true);
    setMemoryProfileError(null);
    try {
      const data = await parseJsonResponse<MemoryProfileResponse>(
        await fetch('/api/memory-profile?character_id=' + encodeURIComponent(trimmed)),
      );
      // 丢弃陈旧响应:发起请求后管理角色若已切换,不要用旧角色的画像覆盖当前角色
      if (memoryManagementCharacterIdRef.current.trim() !== trimmed) return;
      setMemoryProfile(data);
    } catch (err) {
      if (memoryManagementCharacterIdRef.current.trim() !== trimmed) return;
      setMemoryProfileError(getErrorMessage(err));
    } finally {
      setMemoryProfileLoading(false);
    }
  }, [t]);

  const loadMemoryArchiveMemories = useCallback(async (characterId: string, options: { append?: boolean; offset?: number } = {}) => {
    const append = options.append === true;
    if (!characterId) {
      memoryArchiveRequestSeqRef.current += 1;
      setMemoryArchiveMemories([]);
      setSelectedMemoryArchiveIds([]);
      setMemoryArchiveHasMore(false);
      setMemoryArchiveTotal(0);
      setMemoryArchiveOffset(0);
      setMemoryArchivePlan(null);
      setMemoryArchiveError(null);
      setMemoryArchiveListLoading(false);
      return;
    }

    if (memoryManagementCharacterIdRef.current !== characterId) return;

    const memoryArchiveNextOffset = append ? options.offset ?? 0 : 0;
    memoryArchiveRequestSeqRef.current += 1;
    const requestSeq = memoryArchiveRequestSeqRef.current;
    setMemoryArchiveListLoading(true);
    try {
      const data = await parseJsonResponse<{
        memories?: MemoryArchiveSelectableMemory[];
        total?: number;
        hasMore?: boolean;
        offset?: number;
      }>(
        await fetch(`/api/memories?character_id=${encodeURIComponent(characterId)}&status=active&exclude_archive_summary=1&limit=${MEMORY_ARCHIVE_MEMORY_LIMIT}&offset=${memoryArchiveNextOffset}`),
      );
      if (memoryManagementCharacterIdRef.current !== characterId || requestSeq !== memoryArchiveRequestSeqRef.current) return;
      const memories = data.memories || [];
      setMemoryArchiveMemories(prev => (append ? [...prev, ...memories] : memories));
      setMemoryArchiveHasMore(Boolean(data.hasMore));
      setMemoryArchiveTotal(data.total ?? memories.length);
      setMemoryArchiveOffset((data.offset ?? memoryArchiveNextOffset) + memories.length);
    } catch (err) {
      if (memoryManagementCharacterIdRef.current !== characterId || requestSeq !== memoryArchiveRequestSeqRef.current) return;
      setMemoryArchiveError(getErrorMessage(err));
      if (!append) {
        setMemoryArchiveMemories([]);
        setMemoryArchiveHasMore(false);
        setMemoryArchiveTotal(0);
        setMemoryArchiveOffset(0);
      }
    } finally {
      if (memoryManagementCharacterIdRef.current === characterId && requestSeq === memoryArchiveRequestSeqRef.current) {
        setMemoryArchiveListLoading(false);
      }
    }
  }, []);

  const loadMemoryArchiveBatches = useCallback(async (characterId: string) => {
    if (!characterId) {
      setMemoryArchiveBatches([]);
      return;
    }

    try {
      const data = await parseJsonResponse<{ batches?: MemoryArchiveBatch[] }>(
        await fetch(`/api/memory-archive?character_id=${encodeURIComponent(characterId)}`),
      );
      // 丢弃陈旧响应:发起请求后管理角色若已切换,不要用旧角色的归档批次覆盖当前角色
      if (memoryManagementCharacterIdRef.current !== characterId) return;
      const batches = data.batches || [];
      setMemoryArchiveBatches(batches);
      setSelectedMemoryArchiveBatchId(prev => (
        prev && batches.some(batch => batch.batch_id === prev) ? prev : batches[0]?.batch_id || ''
      ));
    } catch (err) {
      if (memoryManagementCharacterIdRef.current !== characterId) return;
      setMemoryArchiveError(getErrorMessage(err));
      setMemoryArchiveBatches([]);
      setSelectedMemoryArchiveBatchId('');
    }
  }, []);

  const loadMemoryManagementCharacters = useCallback(async (preferredCharacterId = '') => {
    setMemoryManagementLoading(true);
    setMemoryManagementError(null);
    try {
      const characters = await parseJsonResponse<MemoryManagementCharacter[]>(await fetch('/api/characters'));
      setMemoryManagementCharacters(characters);
      // 保留用户当前已选的管理角色:初始化 effect 因 t/语言变化重跑时,不应把已选角色重置回列表第一个。
      const currentSelected = memoryManagementCharacterIdRef.current;
      const nextCharacterId = preferredCharacterId
        || (currentSelected && characters.some(character => character.id === currentSelected) ? currentSelected : '')
        || characters[0]?.id || '';
      if (nextCharacterId) {
        setMemoryManagementCharacterId(nextCharacterId);
        memoryManagementCharacterIdRef.current = nextCharacterId;
        await Promise.all([
          loadMemoryDiagnostics(),
          loadMemoryProfile(nextCharacterId),
          loadMemoryArchiveMemories(nextCharacterId),
          loadMemoryArchiveBatches(nextCharacterId),
        ]);
      }
    } catch (err) {
      setMemoryManagementError(getErrorMessage(err));
    } finally {
      setMemoryManagementLoading(false);
    }
  }, [loadMemoryArchiveBatches, loadMemoryArchiveMemories, loadMemoryDiagnostics, loadMemoryProfile]);

  const handleMemoryManagementCharacterChange = (characterId: string) => {
    setMemoryManagementCharacterId(characterId);
    memoryManagementCharacterIdRef.current = characterId;
    memoryArchiveRequestSeqRef.current += 1;
    setMemoryProfile(null);
    setMemoryProfileError(null);
    setMemoryArchiveMemories([]);
    setSelectedMemoryArchiveIds([]);
    setMemoryArchiveBatches([]);
    setSelectedMemoryArchiveBatchId('');
    setMemoryArchivePlan(null);
    setMemoryArchiveListLoading(false);
    setMemoryArchiveHasMore(false);
    setMemoryArchiveTotal(0);
    setMemoryArchiveOffset(0);
    setMemoryArchiveError(null);

    if (characterId) {
      void loadMemoryProfile(characterId);
      void loadMemoryArchiveMemories(characterId);
      void loadMemoryArchiveBatches(characterId);
    }
    void loadMemoryDiagnostics();
  };

  const toggleMemoryArchiveSelection = (memoryId: string) => {
    setSelectedMemoryArchiveIds(prev => (
      prev.includes(memoryId)
        ? prev.filter(id => id !== memoryId)
        : [...prev, memoryId]
    ));
    setMemoryArchivePlan(null);
  };

  const handleLoadMoreMemoryArchiveMemories = () => {
    if (!memoryManagementCharacterId || memoryArchiveListLoading) return;
    const memoryArchiveNextOffset = memoryArchiveMemories.length;
    void loadMemoryArchiveMemories(memoryManagementCharacterId, { append: true, offset: memoryArchiveNextOffset });
  };

  const handleMemoryProfileAction = async (action: 'init_from_memories') => {
    const characterId = memoryManagementCharacterId.trim();
    if (!characterId) {
      setMemoryProfileError(t('settings.memoryProfileCharacterRequired'));
      return;
    }

    setMemoryProfileActionLoading(true);
    setMemoryProfileError(null);
    showToast(t('settings.memoryProfileInitFromMemoriesStarted'), 'success');
    try {
      const body: Record<string, unknown> = { action, character_id: characterId };
      const response = await fetch('/api/memory-profile', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const result = await response.json().catch(() => null) as (MemoryProfileActionResponse & { memory_count?: number }) | null;
      if (characterId) await loadMemoryProfile(characterId);
      await loadMemoryDiagnostics();
      if (!response.ok || !result || result.ok === false || result.error === 'no_active_memories') {
        if (result?.error !== 'no_active_memories') {
          const detail = typeof result?.detail === 'string' && result.detail ? result.detail
            : typeof result?.error === 'string' && result.error ? result.error
              : `HTTP ${response.status}`;
          showToast(`${t('settings.memoryProfileActionFailed')}: ${detail}`, 'error');
          return;
        }
        showToast(t('settings.memoryProfileInitFromMemoriesNoMemories'), 'error');
      } else {
        setEditingProfile(false);
        setEditingProfileDraft({});
        if (result.status === 'no_changes') {
          showToast(t('settings.memoryProfileInitFromMemoriesNoChanges'), 'info');
          return;
        }
        showToast(t('settings.memoryProfileInitFromMemoriesDone').replace('{count}', String(result.memory_count ?? 0)), 'success');
      }
    } catch (err) {
      showToast(`${t('settings.memoryProfileActionFailed')}: ${getErrorMessage(err)}`, 'error');
    } finally {
      setMemoryProfileActionLoading(false);
    }
  };

  const handleMemoryProfileRollback = async (versionId: number) => {
    const characterId = memoryManagementCharacterId.trim();
    if (!characterId) {
      setMemoryProfileError(t('settings.memoryProfileCharacterRequired'));
      return;
    }

    setMemoryProfileActionLoading(true);
    setMemoryProfileError(null);
    try {
      await expectOkResponse(await fetch('/api/memory-profile', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'rollback', character_id: characterId, version_id: versionId }),
      }));
      await loadMemoryProfile(characterId);
      await loadMemoryDiagnostics();
    } catch (err) {
      showToast(`${t('settings.memoryProfileActionFailed')}: ${getErrorMessage(err)}`, 'error');
    } finally {
      setMemoryProfileActionLoading(false);
    }
  };

  const handleMemoryProfileDeleteVersion = async (versionId: number) => {
    const characterId = memoryManagementCharacterId.trim();
    if (!characterId) {
      setMemoryProfileError(t('settings.memoryProfileCharacterRequired'));
      return;
    }
    if (!window.confirm(t('settings.memoryProfileDeleteVersionConfirm'))) return;

    setMemoryProfileActionLoading(true);
    setMemoryProfileError(null);
    try {
      const result = await parseJsonResponse<{ ok: boolean; deleted?: boolean }>(await fetch('/api/memory-profile', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'delete_version', character_id: characterId, version_id: versionId }),
      }));
      if (result.deleted) showToast(t('settings.memoryProfileVersionDeleted'), 'success');
      await loadMemoryProfile(characterId);
      await loadMemoryDiagnostics();
    } catch (err) {
      showToast(`${t('settings.memoryProfileActionFailed')}: ${getErrorMessage(err)}`, 'error');
    } finally {
      setMemoryProfileActionLoading(false);
    }
  };

  const startEditingProfile = () => {
    if (!memoryProfile?.profile) return;
    const p = memoryProfile.profile;
    setEditingProfileDraft({
      profile_name: p.profile_name ?? '',
      relationship_state: p.relationship_state ?? '',
      recent_story_state: p.recent_story_state ?? '',
      emotional_baseline: p.emotional_baseline ?? '',
      user_profile_summary: p.user_profile_summary ?? '',
      pinned_summary: p.pinned_summary ?? '',
      open_threads: Array.isArray(p.open_threads) ? p.open_threads.join('\n') : '',
    });
    setEditingProfile(true);
  };

  const cancelEditingProfile = () => {
    setEditingProfile(false);
    setEditingProfileDraft({});
  };

  const saveEditingProfile = async () => {
    const characterId = memoryManagementCharacterId.trim();
    if (!characterId) return;
    if (!memoryProfile?.profile) return;
    const currentProfile = memoryProfile.profile;

    setMemoryProfileActionLoading(true);
    setMemoryProfileError(null);
    try {
      const patch: Record<string, unknown> = {};
      for (const key of [
        'profile_name',
        'relationship_state',
        'recent_story_state',
        'emotional_baseline',
        'user_profile_summary',
        'pinned_summary',
      ] as const) {
        const trimmedValue = String(editingProfileDraft[key] ?? '').trim();
        if (trimmedValue !== (currentProfile[key] ?? '').trim()) {
          patch[key] = trimmedValue;
        }
      }
      const threads = String(editingProfileDraft.open_threads ?? '').split('\n').map(s => s.trim()).filter(Boolean);
      const currentThreads = Array.isArray(currentProfile.open_threads) ? currentProfile.open_threads : [];
      if (threads.join('\n') !== currentThreads.join('\n')) {
        patch.open_threads = threads;
      }

      if (Object.keys(patch).length === 0) {
        showToast(t('settings.memoryProfileEditNoChanges'), 'info');
        setMemoryProfileActionLoading(false);
        return;
      }

      await expectOkResponse(await fetch('/api/memory-profile', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'enqueue',
          character_id: characterId,
          patch,
          reason: 'manual_edit',
        }),
      }));

      setEditingProfile(false);
      setEditingProfileDraft({});
      showToast(t('settings.memoryProfileEditSaved'), 'success');
      await loadMemoryProfile(characterId);
      await loadMemoryDiagnostics();
    } catch (err) {
      showToast(`${t('settings.memoryProfileActionFailed')}: ${getErrorMessage(err)}`, 'error');
    } finally {
      setMemoryProfileActionLoading(false);
    }
  };

  const buildMemoryArchiveBody = (action: 'preview' | 'execute') => {
    const characterId = memoryManagementCharacterId.trim();
    const summaryContent = memoryArchiveSummary.trim();
    if (!characterId || selectedMemoryArchiveIds.length === 0 || !summaryContent) return null;
    return {
      action,
      character_id: characterId,
      covered_memory_ids: selectedMemoryArchiveIds,
      summary_content: summaryContent,
    };
  };

  const handleMemoryArchivePreview = async () => {
    const body = buildMemoryArchiveBody('preview');
    if (!body) {
      setMemoryArchiveError(t('settings.memoryArchiveRequired'));
      return;
    }

    setMemoryArchiveLoading(true);
    setMemoryArchiveError(null);
    try {
      const data = await parseJsonResponse<{ plan: MemoryArchivePlan }>(await fetch('/api/memory-archive', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }));
      setMemoryArchivePlan(data.plan);
    } catch (err) {
      setMemoryArchiveError(getErrorMessage(err));
    } finally {
      setMemoryArchiveLoading(false);
    }
  };

  const handleMemoryArchiveExecute = async () => {
    const body = buildMemoryArchiveBody('execute');
    if (!body) {
      setMemoryArchiveError(t('settings.memoryArchiveRequired'));
      return;
    }

    setMemoryArchiveLoading(true);
    setMemoryArchiveError(null);
    try {
      const data = await parseJsonResponse<{ plan: MemoryArchivePlan }>(await fetch('/api/memory-archive', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }));
      setMemoryArchivePlan(data.plan);
      setSelectedMemoryArchiveIds([]);
      await loadMemoryDiagnostics();
      await loadMemoryIndexStatus();
      await loadMemoryArchiveMemories(body.character_id);
      await loadMemoryArchiveBatches(body.character_id);
    } catch (err) {
      setMemoryArchiveError(getErrorMessage(err));
    } finally {
      setMemoryArchiveLoading(false);
    }
  };

  const handleMemoryArchiveUndo = async () => {
    const characterId = memoryManagementCharacterId.trim();
    const batchId = selectedMemoryArchiveBatchId.trim();
    if (!characterId || !batchId) {
      setMemoryArchiveError(t('settings.memoryArchiveUndoRequired'));
      return;
    }

    setMemoryArchiveLoading(true);
    setMemoryArchiveError(null);
    try {
      await expectOkResponse(await fetch('/api/memory-archive', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'undo', character_id: characterId, batch_id: batchId }),
      }));
      setMemoryArchivePlan(null);
      setSelectedMemoryArchiveBatchId('');
      setMemoryArchiveBatchDetail(null);
      await loadMemoryDiagnostics();
      await loadMemoryIndexStatus();
      await loadMemoryArchiveMemories(characterId);
      await loadMemoryArchiveBatches(characterId);
    } catch (err) {
      setMemoryArchiveError(getErrorMessage(err));
    } finally {
      setMemoryArchiveLoading(false);
    }
  };

  const handleMemoryArchiveAi = async () => {
    const characterId = memoryManagementCharacterId.trim();
    if (!characterId) {
      setMemoryArchiveError(t('settings.memoryArchiveUndoRequired'));
      return;
    }
    const requestedCharacterId = characterId;

    const controller = new AbortController();
    memoryArchiveAiControllerRef.current = controller;
    setMemoryArchiveAiRunning(true);
    setMemoryArchiveLoading(true);
    setMemoryArchiveError(null);
    setMemoryArchivePlan(null);
    try {
      const res = await fetch('/api/memory-archive', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'ai_archive', character_id: requestedCharacterId }),
        signal: controller.signal,
      });
      const result = await res.json().catch(() => null) as {
        ok?: boolean; status?: string; archive_count?: number;
        summary?: string; error?: string; message?: string; detail?: string;
        batch_id?: string; plan?: MemoryArchivePlan;
      } | null;

      if (memoryManagementCharacterIdRef.current !== requestedCharacterId) return;

      if (!result || result.ok === false) {
        const msg = result?.error || result?.message || t('settings.memoryArchiveAiFailed');
        showToast(msg, 'error');
        setMemoryArchiveError(msg);
      } else if (result.status === 'no_archive_needed') {
        showToast(result.message || t('settings.memoryArchiveAiNoArchiveNeeded'), 'success');
        // 也展示在计划区域，让用户明确看到 AI 的判断
        setMemoryArchivePlan(null);
      } else if (result.plan) {
        const count = result.archive_count ?? result.plan.coveredMemoryUpdates.length;
        showToast(t('settings.memoryArchiveAiDone').replace('{count}', String(count)), 'success');
        // 展示归档结果摘要
        setMemoryArchivePlan({
          summaryMemory: result.plan.summaryMemory,
          coveredMemoryUpdates: result.plan.coveredMemoryUpdates,
        });
        // 把 AI 生成的摘要填入文本框，方便用户看到内容
        if (result.summary) setMemoryArchiveSummary(result.summary);
      } else {
        showToast(t('settings.memoryArchiveAiDone')
          .replace('{count}', String(result.archive_count ?? 0)), 'success');
      }

      await loadMemoryDiagnostics();
      await loadMemoryIndexStatus();
      await loadMemoryArchiveMemories(requestedCharacterId);
      await loadMemoryArchiveBatches(requestedCharacterId);
    } catch (err) {
      if (controller.signal.aborted) {
        if (memoryManagementCharacterIdRef.current === requestedCharacterId) setMemoryArchiveError(null);
        return;
      }
      if (memoryManagementCharacterIdRef.current !== requestedCharacterId) return;
      const msg = getErrorMessage(err);
      showToast(`${t('settings.memoryArchiveAiFailed')}: ${msg}`, 'error');
      setMemoryArchiveError(msg);
    } finally {
      if (memoryArchiveAiControllerRef.current === controller) {
        memoryArchiveAiControllerRef.current = null;
        setMemoryArchiveAiRunning(false);
        setMemoryArchiveLoading(false);
      }
    }
  };

  const handleStopMemoryArchiveAi = () => {
    const controller = memoryArchiveAiControllerRef.current;
    if (!controller || controller.signal.aborted) return;
    controller.abort();
    showToast(t('settings.memoryArchiveAiStopping'), 'success');
  };

  const loadMemoryArchiveBatchDetail = async (batchId: string) => {
    if (!batchId) { setMemoryArchiveBatchDetail(null); return; }
    const characterId = memoryManagementCharacterId.trim();
    if (!characterId) return;
    try {
      const res = await fetch('/api/memory-archive', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'batch_details', character_id: characterId, batch_id: batchId }),
      });
      const data = await res.json() as {
        ok?: boolean;
        covered?: Array<{ id: string; category: string; content: string; status: string }>;
        summary?: { id: string; content: string } | null;
      };
      if (data.ok) {
        setMemoryArchiveBatchDetail(data as typeof memoryArchiveBatchDetail);
        // 选批次时把该批次的摘要填入文本框，方便用户查看
        if (data.summary?.content) setMemoryArchiveSummary(data.summary.content);
      }
    } catch {
      setMemoryArchiveBatchDetail(null);
    }
  };

  useEffect(() => {
    fetch('/api/settings')
      .then(r => parseJsonResponse<Partial<SettingsWithMemoryEngine>>(r))
      .then(s => {
        const merged = mergeSettingsWithMemoryEngine(s);
        setSettings(merged);
        document.documentElement.classList.toggle('dark', s.theme === 'dark');
        writeThemeStorage(merged.theme);
        applyFontStyle((merged.font_style || 'wenkai') as FontStyle);
      })
      .catch(err => {
        showToast(`${t('common.loadFailed')}: ${getErrorMessage(err)}`, 'error');
      });
    fetch('/api/auth').then(r => r.json()).then(d => setAuthEnabled(d.authEnabled)).catch(() => {});
    queueMicrotask(() => void loadProviders());
    queueMicrotask(() => void loadMemoryIndexStatus());
    queueMicrotask(() => void loadMemoryCandidates());
    queueMicrotask(() => void loadMemoryDiagnostics());
    queueMicrotask(() => void loadMemoryManagementCharacters());
  }, [
    loadMemoryCandidates,
    loadMemoryDiagnostics,
    loadMemoryIndexStatus,
    loadMemoryManagementCharacters,
    loadProviders,
    showToast,
    t,
  ]);

  const shouldPollMemoryIndexStatus = activeTab === 'memory' && (
    memoryIndexRebuilding ||
    memoryIndexRetrying ||
    memoryIndexIndexingUnindexed ||
    (memoryIndexStatus?.queued ?? 0) > 0 ||
    (memoryIndexStatus?.processing ?? 0) > 0
  );

  useEffect(() => {
    if (!shouldPollMemoryIndexStatus) return;
    const interval = setInterval(() => {
      void loadMemoryIndexStatus({ silent: true });
      void loadMemoryDiagnostics({ silent: true });
    }, MEMORY_INDEX_STATUS_POLL_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [
    loadMemoryDiagnostics,
    loadMemoryIndexStatus,
    shouldPollMemoryIndexStatus,
  ]);

  const handleLogout = async () => {
    if (!window.confirm(t('auth.logoutConfirm'))) return;
    try {
      // 注意：proxy.ts 的 CSRF 校验要求写方法（含 DELETE）带 application/json 头，
      // 否则会被 415 拦截，登出表面上"点了没反应"
      await expectOkResponse(await fetch('/api/auth', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
      }));
      router.replace('/login');
    } catch (err) {
      showToast(`${t('auth.logoutFailed')}: ${getErrorMessage(err)}`, 'error');
    }
  };

  const handleActivateProvider = async (id: string) => {
    try {
      await expectOkResponse(await fetch('/api/providers/activate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id }),
      }));
      const s = await parseJsonResponse<Partial<SettingsWithMemoryEngine>>(await fetch('/api/settings'));
      setSettings(mergeSettingsWithMemoryEngine(s));
      setActiveProviderId(id);
      setModelList([]);
      setModelError(null);
    } catch (err) {
      showToast(`${t('common.operationFailed')}: ${getErrorMessage(err)}`, 'error');
    }
  };

  const handleDeleteProvider = async (id: string) => {
    if (!window.confirm(t('settings.providerDeleteConfirm'))) return;
    try {
      // 注意：proxy.ts 的 CSRF 校验要求写方法（含 DELETE）带 application/json 头
      await expectOkResponse(await fetch(`/api/providers?id=${id}`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
      }));
      void loadProviders();
    } catch (err) {
      showToast(`${t('common.operationFailed')}: ${getErrorMessage(err)}`, 'error');
    }
  };

  const handleSaveProvider = async () => {
    if (!editingProvider) return;
    const isEdit = !!editingProvider.id;
    const method = isEdit ? 'PUT' : 'POST';
    try {
      await expectOkResponse(await fetch('/api/providers', {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...editingProvider, save_as_current: true }),
      }));
      setEditingProvider(null);
      void loadProviders();
      const s = await parseJsonResponse<Partial<SettingsWithMemoryEngine>>(await fetch('/api/settings'));
      setSettings(mergeSettingsWithMemoryEngine(s));
    } catch (err) {
      showToast(`${t('settings.saveFailed')}: ${getErrorMessage(err)}`, 'error');
    }
  };

  const handleSaveCurrentAsProvider = async () => {
    const name = window.prompt(t('settings.providerNamePrompt'));
    if (!name) return;
    try {
      const res = await fetch('/api/providers', {
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
      await expectOkResponse(res);
      void loadProviders();
      showToast(t('settings.saveSuccess'), 'success');
    } catch (err) {
      showToast(`${t('settings.saveFailed')}: ${getErrorMessage(err)}`, 'error');
    }
  };

  const handleUpdateCurrentProvider = async () => {
    if (!activeProviderId) return;
    try {
      const res = await fetch('/api/providers', {
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
      await expectOkResponse(res);
      void loadProviders();
      showToast(t('settings.saveSuccess'), 'success');
    } catch (err) {
      showToast(`${t('settings.saveFailed')}: ${getErrorMessage(err)}`, 'error');
    }
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
                        <option value="">{t('settings.modelSelectPlaceholder')}</option>
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
                    checked={settings.memory_engine.enabled}
                    onChange={e => updateMemoryEngine('enabled', e.target.checked)}
                  />
                  {t('settings.memoryEngineEnabled')}
                </label>

                {!memoryEngineEnabled && (
                  <p className="rounded-2xl border border-border-light bg-white/70 px-4 py-3 text-xs leading-relaxed text-text-muted">
                    {t('settings.memoryEngineDisabledHint')}
                  </p>
                )}

                {memoryEngineEnabled && (
                  <div className="rounded-2xl border border-border-light bg-white/70 px-4 py-4">
                    <label className="mb-2 block text-sm font-medium text-text-secondary">{t('settings.memoryRetrievalMode')}</label>
                    <select
                      value={resolveMemoryModePreset(settings.memory_engine)}
                      onChange={e => handleMemoryModeChange(e.target.value as MemoryModePreset)}
                      className="select-rich"
                    >
                      <option value="local">{t('settings.memoryRetrievalModeLocal')}</option>
                      <option value="balanced">{t('settings.memoryRetrievalModeBalanced')}</option>
                      <option value="continuity">{t('settings.memoryRetrievalModeContinuity')}</option>
                    </select>
                  </div>
                )}

                {/* 后台任务模型 + 记忆工作包 token 上限：不依赖增强记忆开关，始终可配置 */}
                <div className="space-y-4 rounded-2xl border border-border-light bg-white/70 px-4 py-4">
                  <div>
                    <label className="mb-1.5 block text-sm font-medium text-text-secondary">{t('settings.memoryBackgroundProvider')}</label>
                    <select
                      value={settings.memory_background_provider_id}
                      onChange={e => {
                        update('memory_background_provider_id', e.target.value);
                        setBgModelList([]);
                        // 选择供应商时自动填充其模型
                        const provider = providers.find(p => p.id === e.target.value);
                        if (provider) {
                          update('memory_background_model', provider.model);
                        } else {
                          // 取消供应商选择时，清空后台模型让用户重新填
                          update('memory_background_model', '');
                        }
                      }}
                      className="select-rich"
                    >
                      <option value="">{t('settings.memoryBackgroundProviderNone')}</option>
                      {providers.map(p => (
                        <option key={p.id} value={p.id}>{p.name} ({p.model || t('settings.modelPlaceholder')})</option>
                      ))}
                    </select>
                    <p className="mt-1.5 text-xs leading-relaxed text-text-muted">{t('settings.memoryBackgroundProviderHint')}</p>
                  </div>
                  <div>
                    <label className="mb-1.5 block text-sm font-medium text-text-secondary">{t('settings.memoryBackgroundModel')}</label>
                    <div className="flex flex-col gap-2 lg:flex-row">
                      {bgModelList.length > 0 ? (
                        <select
                          value={settings.memory_background_model}
                          onChange={e => update('memory_background_model', e.target.value)}
                          className="select-rich flex-1"
                        >
                          <option value="">{t('settings.modelSelectPlaceholder')}</option>
                          {bgModelList.map(model => (
                            <option key={model} value={model}>{model}</option>
                          ))}
                        </select>
                      ) : (
                        <input
                          value={settings.memory_background_model}
                          onChange={e => update('memory_background_model', e.target.value)}
                          className="input-rich flex-1"
                          placeholder={t('settings.modelPlaceholder')}
                        />
                      )}
                      <button
                        type="button"
                        onClick={fetchBgModels}
                        disabled={bgModelLoading}
                        className="soft-button soft-button-secondary shrink-0 disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        {bgModelLoading ? t('common.loading') : t('settings.fetchModels')}
                      </button>
                    </div>
                    {bgModelError && <p className="mt-2 text-xs text-red-500">{bgModelError}</p>}
                    <p className="mt-1.5 text-xs leading-relaxed text-text-muted">{t('settings.memoryBackgroundModelHint')}</p>
                  </div>
                  <label className="flex items-start gap-3 rounded-2xl border border-border-light bg-white/70 px-4 py-3 text-sm text-text-secondary">
                    <input
                      type="checkbox"
                      checked={settings.disable_deepseek_thinking_for_background}
                      onChange={e => update('disable_deepseek_thinking_for_background', e.target.checked)}
                      className="mt-1"
                    />
                    <span>
                      <span className="block font-medium text-text-primary">{t('settings.disableDeepseekThinkingForBackground')}</span>
                      <span className="mt-1 block text-xs leading-relaxed text-text-muted">{t('settings.disableDeepseekThinkingForBackgroundHint')}</span>
                    </span>
                  </label>
                  <div>
                    <label className="mb-1.5 block text-sm font-medium text-text-secondary">{t('settings.memoryPackageTokenBudget')}</label>
                    <input
                      type="number"
                      min="1000"
                      max="32000"
                      step="500"
                      value={settings.memory_engine.memory_package_token_budget}
                      onChange={e => updateMemoryEngine('memory_package_token_budget', parseNumber(e.target.value))}
                      onBlur={e => updateMemoryEngine('memory_package_token_budget', Math.min(32000, Math.max(1000, Math.round(parseNumber(e.target.value) || 12000))))}
                      className="input-rich"
                    />
                    <p className="mt-1.5 text-xs leading-relaxed text-text-muted">{t('settings.memoryPackageTokenBudgetHint')}</p>
                  </div>
                </div>

                <div className="space-y-3 rounded-2xl border border-border-light bg-white/70 px-4 py-4">
                  <h3 className="text-sm font-medium text-text-primary">{t('settings.memoryEmbedding')}</h3>
                  <div className="grid gap-3 md:grid-cols-2">
                    <div>
                      <label className="mb-1.5 block text-sm font-medium text-text-secondary">{t('settings.memoryEmbeddingApiBase')}</label>
                      <input
                        value={settings.memory_engine.embedding_api_base}
                        onChange={e => { updateMemoryEngine('embedding_api_base', e.target.value); setEmbeddingModelList([]); }}
                        className="input-rich"
                        placeholder={t('settings.apiBasePlaceholder')}
                      />
                    </div>
                    <div>
                      <label className="mb-1.5 block text-sm font-medium text-text-secondary">{t('settings.memoryEmbeddingApiKey')}</label>
                      <input
                        type="password"
                        value={settings.memory_engine.embedding_api_key}
                        onChange={e => { updateMemoryEngine('embedding_api_key', e.target.value); setEmbeddingModelList([]); }}
                        className="input-rich"
                      />
                    </div>
                    <div>
                      <label className="mb-1.5 block text-sm font-medium text-text-secondary">{t('settings.memoryEmbeddingModel')}</label>
                      <div className="flex gap-2">
                        {embeddingModelList.length > 0 ? (
                          <select
                            value={settings.memory_engine.embedding_model}
                            onChange={e => updateMemoryEngine('embedding_model', e.target.value)}
                            className="select-rich flex-1"
                          >
                            <option value="">{t('settings.modelSelectPlaceholder')}</option>
                            {embeddingModelList.map(model => (
                              <option key={model} value={model}>{model}</option>
                            ))}
                          </select>
                        ) : (
                          <input
                            value={settings.memory_engine.embedding_model}
                            onChange={e => updateMemoryEngine('embedding_model', e.target.value)}
                            className="input-rich flex-1"
                            placeholder={t('settings.modelPlaceholder')}
                          />
                        )}
                        <button
                          type="button"
                          onClick={fetchEmbeddingModels}
                          disabled={embeddingModelLoading}
                          className="soft-button soft-button-secondary shrink-0 disabled:cursor-not-allowed disabled:opacity-50"
                        >
                          {embeddingModelLoading ? t('common.loading') : t('settings.fetchModels')}
                        </button>
                      </div>
                      {embeddingModelError && <p className="mt-1 text-xs text-red-500">{embeddingModelError}</p>}
                    </div>
                    <div>
                      <label className="mb-1.5 block text-sm font-medium text-text-secondary">{t('settings.memoryEmbeddingDimension')}</label>
                      <input
                        type="number"
                        min="0"
                        value={settings.memory_engine.embedding_dimension || ''}
                        onChange={e => updateMemoryEngine('embedding_dimension', parseNumber(e.target.value))}
                        className="input-rich"
                        placeholder="0"
                      />
                      <p className="mt-1 text-xs text-text-muted">{t('settings.memoryEmbeddingDimensionHint')}</p>
                    </div>
                  </div>
                </div>

                <div className="space-y-3 rounded-2xl border border-border-light bg-white/70 px-4 py-4">
                  <h3 className="text-sm font-medium text-text-primary">{t('settings.memoryReranker')}</h3>
                  <label className="flex items-center gap-3 text-sm text-text-secondary">
                    <input
                      type="checkbox"
                      checked={settings.memory_engine.reranker_enabled}
                      onChange={e => updateMemoryEngine('reranker_enabled', e.target.checked)}
                    />
                    {t('settings.memoryRerankerEnabled')}
                  </label>
                  {settings.memory_engine.reranker_enabled && (
                    <div className="grid gap-3 md:grid-cols-2">
                      <div>
                        <label className="mb-1.5 block text-sm font-medium text-text-secondary">{t('settings.memoryRerankerApiBase')}</label>
                        <input
                          value={settings.memory_engine.reranker_api_base}
                          onChange={e => { updateMemoryEngine('reranker_api_base', e.target.value); setRerankerModelList([]); }}
                          className="input-rich"
                          placeholder={t('settings.apiBasePlaceholder')}
                        />
                      </div>
                      <div>
                        <label className="mb-1.5 block text-sm font-medium text-text-secondary">{t('settings.memoryRerankerApiKey')}</label>
                        <input
                          type="password"
                          value={settings.memory_engine.reranker_api_key}
                          onChange={e => { updateMemoryEngine('reranker_api_key', e.target.value); setRerankerModelList([]); }}
                          className="input-rich"
                        />
                      </div>
                      <div className="md:col-span-2">
                        <label className="mb-1.5 block text-sm font-medium text-text-secondary">{t('settings.memoryRerankerModel')}</label>
                        <div className="flex gap-2">
                          {rerankerModelList.length > 0 ? (
                            <select
                              value={settings.memory_engine.reranker_model}
                              onChange={e => updateMemoryEngine('reranker_model', e.target.value)}
                              className="select-rich flex-1"
                            >
                              <option value="">{t('settings.modelSelectPlaceholder')}</option>
                              {rerankerModelList.map(model => (
                                <option key={model} value={model}>{model}</option>
                              ))}
                            </select>
                          ) : (
                            <input
                              value={settings.memory_engine.reranker_model}
                              onChange={e => updateMemoryEngine('reranker_model', e.target.value)}
                              className="input-rich flex-1"
                              placeholder={t('settings.modelPlaceholder')}
                            />
                          )}
                          <button
                            type="button"
                            onClick={fetchRerankerModels}
                            disabled={rerankerModelLoading}
                            className="soft-button soft-button-secondary shrink-0 disabled:cursor-not-allowed disabled:opacity-50"
                          >
                            {rerankerModelLoading ? t('common.loading') : t('settings.fetchModels')}
                          </button>
                        </div>
                        {rerankerModelError && <p className="mt-1 text-xs text-red-500">{rerankerModelError}</p>}
                      </div>
                    </div>
                  )}
                </div>

                {memoryEngineEnabled && (
                  <>
                <div className="space-y-3 rounded-2xl border border-border-light bg-white/70 px-4 py-4">
                  <h3 className="text-sm font-medium text-text-primary">{t('settings.memoryPrivacy')}</h3>
                  <label className="flex items-center gap-3 text-sm text-text-secondary">
                    <input
                      type="checkbox"
                      checked={settings.memory_engine.allow_memory_context_in_chat}
                      onChange={e => updateMemoryEngine('allow_memory_context_in_chat', e.target.checked)}
                    />
                    {t('settings.memoryAllowChatContext')}
                  </label>
                  <label className="flex items-center gap-3 text-sm text-text-secondary">
                    <input
                      type="checkbox"
                      checked={settings.memory_engine.allow_external_memory_payloads}
                      onChange={e => updateMemoryEngine('allow_external_memory_payloads', e.target.checked)}
                    />
                    {t('settings.memoryAllowExternalPayloads')}
                  </label>
                </div>

                <div className="rounded-2xl border border-border-light bg-white/70 px-4 py-4">
                  <div className="mb-3 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                    <h3 className="text-sm font-medium text-text-primary">{t('settings.memoryIndexStatus')}</h3>
                    <div className="flex flex-wrap gap-2">
                      <button
                        type="button"
                        onClick={handleRetryFailedMemoryIndex}
                        disabled={
                          memoryIndexRetrying ||
                          memoryIndexLoading ||
                          memoryIndexRebuilding ||
                          memoryIndexIndexingUnindexed ||
                          memoryIndexClearing ||
                          memoryIndexStopping ||
                          (memoryIndexStatus?.failed ?? 0) === 0
                        }
                        className="soft-button soft-button-secondary text-xs disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        {memoryIndexRetrying ? (
                          <span className="spinner-sm" aria-hidden="true" />
                        ) : (
                          <RefreshIcon className="h-3.5 w-3.5" />
                        )}
                        {memoryIndexRetrying ? t('settings.memoryIndexRetrying') : t('settings.memoryIndexRetryFailed')}
                      </button>
                      <button
                        type="button"
                        onClick={handleRebuildMemoryIndex}
                        disabled={
                          memoryIndexRebuilding ||
                          memoryIndexRetrying ||
                          memoryIndexIndexingUnindexed ||
                          memoryIndexLoading ||
                          memoryIndexClearing ||
                          memoryIndexStopping ||
                          memoryIndexStatus?.canRebuild === false
                        }
                        className="soft-button soft-button-secondary text-xs disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        {memoryIndexRebuilding ? (
                          <span className="spinner-sm" aria-hidden="true" />
                        ) : (
                          <RefreshIcon className="h-3.5 w-3.5" />
                        )}
                        {memoryIndexRebuilding ? t('settings.memoryIndexRebuilding') : t('settings.memoryIndexRebuild')}
                      </button>
                      <button
                        type="button"
                        onClick={handleIndexUnindexedMemoryIndex}
                        disabled={
                          memoryIndexIndexingUnindexed ||
                          memoryIndexRebuilding ||
                          memoryIndexRetrying ||
                          memoryIndexLoading ||
                          memoryIndexClearing ||
                          memoryIndexStopping ||
                          !settings.memory_engine.embedding_model.trim()
                        }
                        className="soft-button soft-button-secondary text-xs disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        {memoryIndexIndexingUnindexed ? (
                          <span className="spinner-sm" aria-hidden="true" />
                        ) : (
                          <RefreshIcon className="h-3.5 w-3.5" />
                        )}
                        {memoryIndexIndexingUnindexed ? t('settings.memoryIndexIndexingUnindexed') : t('settings.memoryIndexIndexUnindexed')}
                      </button>
                      <button
                        type="button"
                        onClick={handleClearMemoryIndex}
                        disabled={
                          memoryIndexClearing ||
                          memoryIndexStopping ||
                          memoryIndexLoading ||
                          memoryIndexRebuilding ||
                          memoryIndexRetrying ||
                          memoryIndexIndexingUnindexed ||
                          (memoryIndexStatus?.total ?? 0) === 0
                        }
                        className="soft-button soft-button-danger text-xs disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        {memoryIndexClearing ? (
                          <span className="spinner-sm" aria-hidden="true" />
                        ) : (
                          <RefreshIcon className="h-3.5 w-3.5" />
                        )}
                        {memoryIndexClearing ? t('settings.memoryIndexClearing') : t('settings.memoryIndexClear')}
                      </button>
                      <button
                        type="button"
                        onClick={handleStopCurrentMemoryTask}
                        disabled={
                          memoryIndexStopping ||
                          memoryIndexClearing ||
                          memoryIndexLoading ||
                          memoryIndexRebuilding ||
                          memoryIndexRetrying ||
                          memoryIndexIndexingUnindexed ||
                          memoryIndexActiveTasks === 0
                        }
                        className="soft-button soft-button-secondary text-xs disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        {memoryIndexStopping ? (
                          <span className="spinner-sm" aria-hidden="true" />
                        ) : (
                          <RefreshIcon className="h-3.5 w-3.5" />
                        )}
                        {memoryIndexStopping ? t('settings.memoryIndexStopping') : t('settings.memoryIndexStopCurrent')}
                      </button>
                    </div>
                  </div>
                  <div className="grid grid-cols-2 gap-2 text-xs sm:grid-cols-5">
                    <div className="rounded-xl border border-border-light bg-white/60 px-3 py-2">
                      <span className="block text-text-muted">{t('settings.memoryIndexIndexed')}</span>
                      <span className="text-sm font-medium text-text-primary">{memoryIndexLoading ? '...' : memoryIndexStatus?.indexed ?? 0}</span>
                    </div>
                    <div className="rounded-xl border border-border-light bg-white/60 px-3 py-2">
                      <span className="block text-text-muted">{t('settings.memoryIndexTotal')}</span>
                      <span className="text-sm font-medium text-text-primary">{memoryIndexLoading ? '...' : memoryIndexStatus?.total ?? 0}</span>
                    </div>
                    <div className="rounded-xl border border-border-light bg-white/60 px-3 py-2">
                      <span className="block text-text-muted">{t('settings.memoryIndexFailed')}</span>
                      <span className="text-sm font-medium text-text-primary">{memoryIndexLoading ? '...' : memoryIndexStatus?.failed ?? 0}</span>
                    </div>
                    <div className="rounded-xl border border-border-light bg-white/60 px-3 py-2">
                      <span className="block text-text-muted">{t('settings.memoryIndexQueued')}</span>
                      <span className="text-sm font-medium text-text-primary">{memoryIndexLoading ? '...' : memoryIndexStatus?.queued ?? 0}</span>
                    </div>
                    <div className="rounded-xl border border-border-light bg-white/60 px-3 py-2">
                      <span className="block text-text-muted">{t('settings.memoryIndexProcessing')}</span>
                      <span className="text-sm font-medium text-text-primary">{memoryIndexLoading ? '...' : memoryIndexStatus?.processing ?? 0}</span>
                    </div>
                  </div>
                  {memoryIndexError && (
                    <p className="mt-3 text-xs text-red-500">{t('common.loadFailed')}: {memoryIndexError}</p>
                  )}
                  {memoryIndexBlockedReason && (
                    <p className="mt-3 break-words text-xs text-amber-600">
                      {formatTemplate(t('settings.memoryIndexProcessingBlocked'), { reason: memoryIndexBlockedReason })}
                    </p>
                  )}
                  {memoryIndexStatus?.latest_error && (
                    <p className="mt-3 break-words text-xs text-red-500">
                      {t('settings.memoryIndexLatestError')}: {memoryIndexStatus.latest_error}
                    </p>
                  )}
                </div>

                <div className="rounded-2xl border border-border-light bg-white/70 px-4 py-4">
                  <div className="mb-3 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                    <h3 className="text-sm font-medium text-text-primary">{t('settings.memoryDiagnosticsTitle')}</h3>
                    <div className="flex gap-2">
                      <button
                        type="button"
                        onClick={() => void loadMemoryDiagnostics()}
                        disabled={memoryDiagnosticsLoading}
                        className="soft-button soft-button-secondary text-xs disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      {memoryDiagnosticsLoading ? (
                        <span className="spinner-sm" aria-hidden="true" />
                      ) : (
                        <RefreshIcon className="h-3.5 w-3.5" />
                      )}
                      {memoryDiagnosticsLoading ? t('common.loading') : t('settings.memoryCandidatesRefresh')}
                    </button>
                  </div>
                  </div>
                  <div className="grid grid-cols-2 gap-2 text-xs sm:grid-cols-5">
                    <div className="rounded-xl border border-border-light bg-white/60 px-3 py-2">
                      <span className="block text-text-muted">{t('settings.memoryDiagnosticsIndex')}</span>
                      <span className="text-sm font-medium text-text-primary">
                        {memoryDiagnosticsLoading ? '...' : `${memoryDiagnostics?.index.ready ?? 0}/${memoryDiagnostics?.index.total ?? 0}`}
                      </span>
                    </div>
                    <div className="rounded-xl border border-border-light bg-white/60 px-3 py-2">
                      <span className="block text-text-muted">{t('settings.memoryDiagnosticsTasks')}</span>
                      <span className="text-sm font-medium text-text-primary">
                        {memoryDiagnosticsLoading ? '...' : `${memoryDiagnostics?.tasks.pending ?? 0}/${memoryDiagnostics?.tasks.processing ?? 0}/${memoryDiagnostics?.tasks.failed ?? 0}`}
                      </span>
                    </div>
                    <div className="rounded-xl border border-border-light bg-white/60 px-3 py-2">
                      <span className="block text-text-muted">{t('settings.memoryDiagnosticsCandidates')}</span>
                      <span className="text-sm font-medium text-text-primary">
                        {memoryDiagnosticsLoading ? '...' : memoryDiagnostics?.candidates.repairable ?? 0}
                      </span>
                    </div>
                    <div className="rounded-xl border border-border-light bg-white/60 px-3 py-2">
                      <span className="block text-text-muted">{t('settings.memoryDiagnosticsProfile')}</span>
                      <span className="text-sm font-medium text-text-primary">
                        {memoryDiagnosticsLoading ? '...' : (
                          memoryDiagnostics?.profile.exists
                            ? `${memoryDiagnostics.profile.filled_fields}/6`
                            : t('common.empty')
                        )}
                      </span>
                    </div>
                    <div className="rounded-xl border border-border-light bg-white/60 px-3 py-2">
                      <span className="block text-text-muted">{t('settings.memoryDiagnosticsArchive')}</span>
                      <span className="text-sm font-medium text-text-primary">
                        {memoryDiagnosticsLoading ? '...' : (() => {
                          const a = memoryDiagnostics?.archive.archived ?? 0;
                          const s = memoryDiagnostics?.archive.summarized ?? 0;
                          return s > 0 ? `${a}/${s}` : String(a);
                        })()}
                      </span>
                    </div>
                  </div>
                  {memoryDiagnosticsError && (
                    <p className="mt-3 text-xs text-red-500">{t('common.loadFailed')}: {memoryDiagnosticsError}</p>
                  )}
                </div>

                <div className="rounded-2xl border border-border-light bg-white/70 px-4 py-4">
                  <div className="mb-3">
                    <h3 className="text-sm font-medium text-text-primary">{t('settings.memoryProfileTitle')}</h3>
                    <p className="mt-1 text-xs text-text-muted">{t('settings.memoryProfileHint')}</p>
                  </div>
                  <div className="mb-3">
                    <label className="mb-1.5 block text-sm font-medium text-text-secondary">
                      {t('settings.memoryManagementCharacter')}
                    </label>
                    <select
                      value={memoryManagementCharacterId}
                      onChange={e => handleMemoryManagementCharacterChange(e.target.value)}
                      disabled={memoryManagementLoading}
                      className="select-rich"
                    >
                      <option value="">{t('settings.memoryManagementChooseCharacter')}</option>
                      {memoryManagementCharacters.map(character => (
                        <option key={character.id} value={character.id}>{character.name || character.id}</option>
                      ))}
                    </select>
                    {memoryManagementError && (
                      <p className="mt-2 text-xs text-red-500">{t('common.loadFailed')}: {memoryManagementError}</p>
                    )}
                  </div>
                  <div className="grid gap-3 md:grid-cols-[1fr_auto]">
                    <button
                      type="button"
                      onClick={() => void loadMemoryProfile(memoryManagementCharacterId)}
                      disabled={memoryProfileLoading || !memoryManagementCharacterId}
                      className="soft-button soft-button-secondary text-xs disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      {memoryProfileLoading ? (
                        <span className="spinner-sm" aria-hidden="true" />
                      ) : (
                        <RefreshIcon className="h-3.5 w-3.5" />
                      )}
                      {memoryProfileLoading ? t('common.loading') : t('settings.memoryCandidatesRefresh')}
                    </button>
                    <button
                      type="button"
                      onClick={() => void handleMemoryProfileAction('init_from_memories')}
                      disabled={memoryProfileActionLoading || !memoryManagementCharacterId}
                      className="soft-button soft-button-primary text-xs disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      {t('settings.memoryProfileInitFromMemories')}
                    </button>
                  </div>
                  {memoryProfileError && (
                    <p className="mt-3 text-xs text-red-500">{memoryProfileError}</p>
                  )}
                  {memoryProfile && !editingProfile && (
                    <div className="mt-3 grid gap-3 md:grid-cols-3">
                      <div className="rounded-xl border border-border-light bg-white/60 px-3 py-2 text-xs text-text-secondary md:col-span-2">
                        <div className="flex items-center justify-between">
                          <div>
                            <span className="font-medium text-text-primary">{t('settings.memoryProfileCurrent')}</span>
                            <span className="ml-2 text-text-muted">
                              {memoryProfile.profile?.profile_name?.trim() || memoryProfile.profile?.character_id || t('common.empty')}
                            </span>
                          </div>
                          <button
                            type="button"
                            onClick={startEditingProfile}
                            disabled={memoryProfileActionLoading || !memoryProfile.profile}
                            className="soft-button soft-button-secondary text-xs disabled:cursor-not-allowed disabled:opacity-50"
                          >
                            {t('common.edit')}
                          </button>
                        </div>
                        <p className="mt-1 whitespace-pre-wrap leading-relaxed">
                          {[
                            memoryProfile.profile?.relationship_state && formatTemplate(t('settings.memoryProfileDisplayRelationship'), { value: memoryProfile.profile.relationship_state }),
                            memoryProfile.profile?.recent_story_state && formatTemplate(t('settings.memoryProfileDisplayStory'), { value: memoryProfile.profile.recent_story_state }),
                            memoryProfile.profile?.emotional_baseline && formatTemplate(t('settings.memoryProfileDisplayEmotion'), { value: memoryProfile.profile.emotional_baseline }),
                            (() => { const p = memoryProfile.profile; const threads = p?.open_threads; return threads && threads.length > 0 ? formatTemplate(t('settings.memoryProfileDisplayThreads'), { value: threads.join('；') }) : ''; })(),
                            memoryProfile.profile?.user_profile_summary && formatTemplate(t('settings.memoryProfileDisplayUser'), { value: memoryProfile.profile.user_profile_summary }),
                            memoryProfile.profile?.pinned_summary && formatTemplate(t('settings.memoryProfileDisplayPinned'), { value: memoryProfile.profile.pinned_summary }),
                          ].filter(Boolean).join('\n') || t('settings.memoryProfileEmpty')}
                        </p>
                      </div>
                      <div className="rounded-xl border border-border-light bg-white/60 px-3 py-2 text-xs text-text-secondary">
                        <div className="space-y-1">
                          {memoryProfile.versions.map(version => {
                            const versionName = version.snapshot?.profile_name?.trim();
                            const versionLabel = versionName || `v${version.version_number}`;
                            return (
                              <div
                                key={version.id}
                                className="flex items-stretch gap-1 rounded-lg border border-border-light bg-white/70"
                              >
                                <button
                                  type="button"
                                  onClick={() => void handleMemoryProfileRollback(version.id)}
                                  disabled={memoryProfileActionLoading}
                                  className="min-w-0 flex-1 px-2 py-1 text-left text-xs text-text-secondary hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-50"
                                >
                                  <span className="block truncate">{t('settings.memoryProfileRollback')} {versionLabel}</span>
                                  <span className="block truncate text-[11px] text-text-muted">
                                    {versionName ? `v${version.version_number} · ${version.reason}` : version.reason}
                                  </span>
                                </button>
                                <button
                                  type="button"
                                  title={t('settings.memoryProfileDeleteVersion')}
                                  aria-label={t('settings.memoryProfileDeleteVersion')}
                                  onClick={() => void handleMemoryProfileDeleteVersion(version.id)}
                                  disabled={memoryProfileActionLoading}
                                  className="flex w-8 shrink-0 items-center justify-center border-l border-border-light text-red-500 hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-50"
                                >
                                  <TrashIcon className="h-3.5 w-3.5" />
                                </button>
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    </div>
                  )}
                  {memoryProfile && editingProfile && (
                    <div className="mt-3 rounded-xl border border-border-light bg-white/60 px-3 py-2 text-xs text-text-secondary">
                      <div className="mb-2 flex items-center justify-between">
                        <span className="font-medium text-text-primary">{t('settings.memoryProfileEditTitle')}</span>
                        <div className="flex gap-2">
                          <button
                            type="button"
                            onClick={() => void saveEditingProfile()}
                            disabled={memoryProfileActionLoading}
                            className="soft-button soft-button-primary text-xs disabled:cursor-not-allowed disabled:opacity-50"
                          >
                            {t('common.save')}
                          </button>
                          <button
                            type="button"
                            onClick={cancelEditingProfile}
                            disabled={memoryProfileActionLoading}
                            className="soft-button soft-button-secondary text-xs disabled:cursor-not-allowed disabled:opacity-50"
                          >
                            {t('common.cancel')}
                          </button>
                        </div>
                      </div>
                      <div className="grid gap-3 md:grid-cols-2">
                        {[
                          { key: 'profile_name', label: t('settings.memoryProfileFieldName'), singleLine: true },
                          { key: 'relationship_state', label: t('settings.memoryProfileFieldRelationship') },
                          { key: 'recent_story_state', label: t('settings.memoryProfileFieldStory') },
                          { key: 'emotional_baseline', label: t('settings.memoryProfileFieldEmotion') },
                          { key: 'user_profile_summary', label: t('settings.memoryProfileFieldUser') },
                          { key: 'pinned_summary', label: t('settings.memoryProfileFieldPinned') },
                          { key: 'open_threads', label: t('settings.memoryProfileFieldThreads'), rows: 3 },
                        ].map(({ key, label, rows, singleLine }) => (
                          <div key={key} className={key === 'open_threads' || key === 'pinned_summary' ? 'md:col-span-2' : ''}>
                            <label className="mb-1 block font-medium text-text-primary">{label}</label>
                            {singleLine ? (
                              <input
                                value={editingProfileDraft[key] ?? ''}
                                onChange={e => setEditingProfileDraft(prev => ({ ...prev, [key]: e.target.value }))}
                                className="input-rich w-full rounded-lg border border-border-light bg-white/80 px-2 py-1.5 text-xs"
                              />
                            ) : (
                              <textarea
                                value={editingProfileDraft[key] ?? ''}
                                onChange={e => setEditingProfileDraft(prev => ({ ...prev, [key]: e.target.value }))}
                                rows={rows ?? 2}
                                className="textarea-rich w-full resize-none rounded-lg border border-border-light bg-white/80 px-2 py-1.5 text-xs"
                              />
                            )}
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>

                <div className="rounded-2xl border border-border-light bg-white/70 px-4 py-4">
                  <div className="mb-3">
                    <h3 className="text-sm font-medium text-text-primary">{t('settings.memoryArchiveTitle')}</h3>
                    <p className="mt-1 text-xs text-text-muted">{t('settings.memoryArchiveHint')}</p>
                  </div>
                  <div>
                    <div className="mb-2 text-sm font-medium text-text-secondary">
                      {t('settings.memoryArchiveSelectMemories')}
                    </div>
                    <p className="mb-2 text-xs text-text-muted">
                      {t('settings.memoryArchiveShownCount')
                        .replace('{shown}', String(memoryArchiveShownCount))
                        .replace('{total}', String(memoryArchiveTotal))}
                    </p>
                    {memoryArchiveMemories.length === 0 ? (
                      <p className="rounded-xl border border-border-light bg-white/60 px-3 py-2 text-xs text-text-muted">
                        {memoryManagementCharacterId ? t('settings.memoryArchiveNoMemories') : t('settings.memoryManagementChooseCharacter')}
                      </p>
                    ) : (
                      <div className="max-h-64 space-y-2 overflow-auto rounded-xl border border-border-light bg-white/60 p-2">
                        {memoryArchiveMemories.map(memory => (
                          <label
                            key={memory.id}
                            className="flex cursor-pointer items-start gap-2 rounded-lg px-2 py-2 text-xs text-text-secondary hover:bg-white/70"
                          >
                            <input
                              type="checkbox"
                              checked={selectedMemoryArchiveIds.includes(memory.id)}
                              onChange={() => toggleMemoryArchiveSelection(memory.id)}
                              className="mt-0.5"
                            />
                            <span className="min-w-0 flex-1">
                              <span className="block font-medium text-text-primary">
                                {memory.category} · {memory.status}{memory.pinned ? ` · ${t('common.current')}` : ''}
                              </span>
                              <span className="mt-1 block line-clamp-2 break-words">{memory.content}</span>
                            </span>
                          </label>
                        ))}
                      </div>
                    )}
                    {memoryArchiveHasMore && memoryManagementCharacterId && (
                      <button
                        type="button"
                        onClick={handleLoadMoreMemoryArchiveMemories}
                        disabled={memoryArchiveListLoading}
                        className="mt-2 soft-button soft-button-secondary text-xs disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        {memoryArchiveListLoading ? (
                          <span className="spinner-sm" aria-hidden="true" />
                        ) : (
                          <RefreshIcon className="h-3.5 w-3.5" />
                        )}
                        {t('settings.memoryArchiveLoadMore')}
                      </button>
                    )}
                  </div>
                  <div className="mt-3">
                    <label className="mb-1.5 block text-sm font-medium text-text-secondary">
                      {t('settings.memoryArchiveSelectBatch')}
                    </label>
                    <select
                      value={selectedMemoryArchiveBatchId}
                      onChange={e => {
                        setSelectedMemoryArchiveBatchId(e.target.value);
                        void loadMemoryArchiveBatchDetail(e.target.value);
                      }}
                      className="select-rich"
                    >
                      <option value="">{t('settings.memoryArchiveNoBatches')}</option>
                      {memoryArchiveBatches.map(batch => (
                        <option key={batch.batch_id} value={batch.batch_id}>
                          {(batch.summary_content.length > 60 ? batch.summary_content.slice(0, 60) + '...' : batch.summary_content) || batch.batch_id} ({batch.covered_count})
                        </option>
                      ))}
                    </select>
                    {memoryArchiveBatchDetail && (
                      <div className="mt-2 max-h-32 overflow-auto rounded-lg border border-border-light bg-white/60 p-2 text-xs">
                        {memoryArchiveBatchDetail.summary && (
                          <p className="mb-2 rounded bg-white/70 px-2 py-1 font-medium text-text-primary">
                            {memoryArchiveBatchDetail.summary.content}
                          </p>
                        )}
                        {memoryArchiveBatchDetail.covered.map(m => (
                          <p key={m.id} className="flex gap-2 border-b border-border-light/50 px-2 py-1 last:border-0">
                            <span className="shrink-0 text-text-muted">[{m.category}]</span>
                            <span className="min-w-0 flex-1 text-text-secondary">{m.content}</span>
                          </p>
                        ))}
                      </div>
                    )}
                  </div>
                  <textarea
                    value={memoryArchiveSummary}
                    onChange={e => setMemoryArchiveSummary(e.target.value)}
                    rows={3}
                    className="textarea-rich mt-3 w-full resize-none rounded-xl border border-border-light bg-white/80 px-3 py-2 text-sm"
                    placeholder={t('settings.memoryArchiveSummary')}
                  />
                  <div className="mt-3 flex flex-wrap gap-2">
                    <button
                      type="button"
                      onClick={() => void handleMemoryArchiveAi()}
                      disabled={memoryArchiveLoading || memoryArchiveAiRunning || !memoryManagementCharacterId}
                      className="soft-button soft-button-primary px-2.5 py-1 text-xs disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      {memoryArchiveAiRunning ? (
                        <span className="spinner-sm" aria-hidden="true" />
                      ) : (
                        <SparkIcon className="h-3.5 w-3.5" />
                      )}
                      {memoryArchiveAiRunning ? t('common.loading') : t('settings.memoryArchiveAi')}
                    </button>
                    {memoryArchiveAiRunning && (
                      <button
                        type="button"
                        onClick={handleStopMemoryArchiveAi}
                        className="soft-button soft-button-danger px-2.5 py-1 text-xs"
                      >
                        <StopIcon className="h-3.5 w-3.5" />
                        {t('settings.memoryArchiveAiStop')}
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => void handleMemoryArchivePreview()}
                      disabled={memoryArchiveLoading || !memoryManagementCharacterId}
                      className="soft-button soft-button-secondary px-2.5 py-1 text-xs disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      {t('settings.memoryArchivePreview')}
                    </button>
                    <button
                      type="button"
                      onClick={() => void handleMemoryArchiveExecute()}
                      disabled={memoryArchiveLoading || !memoryManagementCharacterId}
                      className="soft-button soft-button-secondary px-2.5 py-1 text-xs disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      {t('settings.memoryArchiveExecute')}
                    </button>
                    <button
                      type="button"
                      onClick={() => void handleMemoryArchiveUndo()}
                      disabled={memoryArchiveLoading || !memoryManagementCharacterId || !selectedMemoryArchiveBatchId}
                      className="soft-button soft-button-danger px-2.5 py-1 text-xs disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      {t('settings.memoryArchiveUndo')}
                    </button>
                  </div>
                  {memoryArchiveError && (
                    <p className="mt-3 text-xs text-red-500">{memoryArchiveError}</p>
                  )}
                  {memoryArchivePlan && (
                    <p className="mt-3 text-xs text-text-muted">
                      {t('settings.memoryArchivePlanResult')
                        .replace('{summary}', memoryArchivePlan.summaryMemory.id)
                        .replace('{count}', String(memoryArchivePlan.coveredMemoryUpdates.length))}
                    </p>
                  )}
                </div>

                <div className="rounded-2xl border border-border-light bg-white/70 px-4 py-4">
                  <div className="mb-3 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                    <div>
                      <h3 className="text-sm font-medium text-text-primary">{t('settings.memoryCandidatesTitle')}</h3>
                      <p className="mt-1 text-xs text-text-muted">{t('settings.memoryCandidatesHint')}</p>
                    </div>
                    <button
                      type="button"
                      onClick={() => void loadMemoryCandidates()}
                      disabled={memoryCandidatesLoading}
                      className="soft-button soft-button-secondary text-xs disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      {memoryCandidatesLoading ? (
                        <span className="spinner-sm" aria-hidden="true" />
                      ) : (
                        <RefreshIcon className="h-3.5 w-3.5" />
                      )}
                      {memoryCandidatesLoading ? t('common.loading') : t('settings.memoryCandidatesRefresh')}
                    </button>
                  </div>

                  {memoryCandidatesError && (
                    <p className="mb-3 text-xs text-red-500">{t('common.loadFailed')}: {memoryCandidatesError}</p>
                  )}

                  {memoryCandidatesLoading && memoryCandidates.length === 0 ? (
                    <p className="text-sm text-text-muted">{t('common.loading')}</p>
                  ) : memoryCandidates.length === 0 ? (
                    <p className="text-sm text-text-muted">{t('settings.memoryCandidatesEmpty')}</p>
                  ) : (
                    <div className="space-y-3">
                      {memoryCandidates.map(candidate => {
                        const isEditing = editingMemoryCandidateId === candidate.id;
                        const isBusy = memoryCandidateActionId === candidate.id;
                        const content = getCandidateText(candidate, 'content');
                        const category = getCandidateText(candidate, 'category') || t('common.empty');
                        const role = getCandidateText(candidate, 'role') || getCandidateText(candidate, 'memory_kind') || t('common.empty');
                        const tags = getCandidateTags(candidate);

                        return (
                          <div key={candidate.id} className="rounded-xl border border-border-light bg-white/60 px-3 py-3">
                            <div className="mb-2 flex flex-wrap items-center gap-2 text-xs text-text-muted">
                              <span className="rounded-full bg-accent/10 px-2 py-0.5 text-accent-dark">{category}</span>
                              <span>{t('settings.memoryCandidatesRole')}: {role}</span>
                              {candidate.error_reason && (
                                <span>{t('settings.memoryCandidatesErrorReason')}: {candidate.error_reason}</span>
                              )}
                            </div>

                            {isEditing ? (
                              <textarea
                                value={memoryCandidateEdits[candidate.id] ?? content}
                                onChange={e => setMemoryCandidateEdits(prev => ({ ...prev, [candidate.id]: e.target.value }))}
                                rows={3}
                                className="textarea-rich w-full resize-none rounded-xl border border-border-light bg-white/80 px-3 py-2 text-sm"
                              />
                            ) : (
                              <p className="whitespace-pre-wrap text-sm leading-relaxed text-text-primary">{content || t('common.empty')}</p>
                            )}

                            {tags && (
                              <p className="mt-2 text-xs text-text-muted">{t('settings.memoryCandidatesTags')}: {tags}</p>
                            )}

                            <div className="mt-3 flex flex-wrap gap-2">
                              <button
                                type="button"
                                onClick={() => void handleMemoryCandidateAction(candidate, 'accept')}
                                disabled={isBusy}
                                className="soft-button soft-button-primary px-2.5 py-1 text-xs disabled:cursor-not-allowed disabled:opacity-50"
                              >
                                {t('settings.memoryCandidateAccept')}
                              </button>
                              {isEditing ? (
                                <button
                                  type="button"
                                  onClick={() => void handleMemoryCandidateAction(candidate, 'edit-accept')}
                                  disabled={isBusy}
                                  className="soft-button soft-button-primary px-2.5 py-1 text-xs disabled:cursor-not-allowed disabled:opacity-50"
                                >
                                  {t('settings.memoryCandidateEditAccept')}
                                </button>
                              ) : (
                                <button
                                  type="button"
                                  onClick={() => {
                                    setEditingMemoryCandidateId(candidate.id);
                                    setMemoryCandidateEdits(prev => ({ ...prev, [candidate.id]: content }));
                                  }}
                                  disabled={isBusy}
                                  className="soft-button soft-button-secondary px-2.5 py-1 text-xs disabled:cursor-not-allowed disabled:opacity-50"
                                >
                                  {t('common.edit')}
                                </button>
                              )}
                              <button
                                type="button"
                                onClick={() => void handleMemoryCandidateAction(candidate, 'ignore')}
                                disabled={isBusy}
                                className="soft-button soft-button-secondary px-2.5 py-1 text-xs disabled:cursor-not-allowed disabled:opacity-50"
                              >
                                {t('settings.memoryCandidateIgnore')}
                              </button>
                              <button
                                type="button"
                                onClick={() => void handleMemoryCandidateAction(candidate, 'discard')}
                                disabled={isBusy}
                                className="soft-button soft-button-danger px-2.5 py-1 text-xs disabled:cursor-not-allowed disabled:opacity-50"
                              >
                                {t('settings.memoryCandidateDiscard')}
                              </button>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
                  </>
                )}

                <div className="border-t border-border-light pt-3" />

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
                      placeholder={t('settings.triggerKeywordsPlaceholder')}
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
                    <option value="zh">{t('settings.languageZh')}</option>
                    <option value="en">{t('settings.languageEn')}</option>
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
                          {f === 'wenkai' ? t('settings.fontNameWenkai') : f === 'system' ? t('settings.fontNameSystem') : t('settings.fontNameSerif')}
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
  update: <K extends 'image_gen' | 'artist_strings'>(key: K, value: Settings[K]) => void;
  parseNumber: (v: string) => number;
  t: (key: string) => string;
}) {
  const imgGen = settings.image_gen || DEFAULT_IMAGE_GEN_SETTINGS;

  const updateImg = <K extends keyof ImageGenSettings>(key: K, value: ImageGenSettings[K]) => {
    update('image_gen', { ...imgGen, [key]: value });
  };

  // 画师串预设管理
  const artistStrings: ArtistString[] = settings.artist_strings || [];
  const [selectedPresetId, setSelectedPresetId] = useState('');

  // 同步预设选中状态：当外部传入的 nai_artist_tags 变化时（例如设置异步加载完成、
  // 或别处更新了画师串），用渲染期 setState 反查匹配的预设并选中。
  // 这是 React 18+ 官方推荐的"由 props 派生 state"模式（见 react.dev/reference/react/useState
  // 中 "Storing information from previous renders" 一节），等价于在同一 render pass
  // 内重新渲染，不会触发 effect 的级联渲染告警，也不需要 useEffect/useRef 配合。
  const [lastSyncedTags, setLastSyncedTags] = useState<string | null>(null);
  if (imgGen.nai_artist_tags !== lastSyncedTags) {
    setLastSyncedTags(imgGen.nai_artist_tags);
    const trimmed = imgGen.nai_artist_tags.trim();
    if (trimmed && artistStrings.length > 0) {
      const matched = artistStrings.find(a => a.tags === imgGen.nai_artist_tags);
      // 只在找到匹配预设时同步 selectedPresetId；找不到时不清空，保留用户已有选择，
      // 由 handleArtistTagsChange 在用户手动改 tags 时显式清空。
      if (matched && matched.id !== selectedPresetId) {
        setSelectedPresetId(matched.id);
      }
    }
  }

  const [presetName, setPresetName] = useState('');

  const handleSelectPreset = (id: string) => {
    if (!id) { setSelectedPresetId(''); return; }
    const preset = artistStrings.find(a => a.id === id);
    if (preset) {
      setSelectedPresetId(id);
      updateImg('nai_artist_tags', preset.tags);
    }
  };

  const handleSaveAsPreset = () => {
    const name = presetName.trim() || window.prompt(t('settings.artistStringsNamePrompt'));
    if (!name) return;
    const newPreset: ArtistString = {
      id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      name,
      tags: imgGen.nai_artist_tags,
    };
    update('artist_strings', [...artistStrings, newPreset]);
    setSelectedPresetId(newPreset.id);
    setPresetName('');
  };

  const handleUpdatePreset = () => {
    if (!selectedPresetId) return;
    update('artist_strings', artistStrings.map(a =>
      a.id === selectedPresetId ? { ...a, tags: imgGen.nai_artist_tags } : a
    ));
  };

  const handleDeletePreset = () => {
    if (!selectedPresetId) return;
    if (!window.confirm(t('settings.artistStringsDeleteConfirm'))) return;
    update('artist_strings', artistStrings.filter(a => a.id !== selectedPresetId));
    setSelectedPresetId('');
  };

  const handleArtistTagsChange = (value: string) => {
    updateImg('nai_artist_tags', value);
    if (selectedPresetId) setSelectedPresetId('');
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
                  {/* 画师串预设管理 */}
                  <div className="space-y-2">
                    <div className="flex items-center gap-2">
                      <select
                        value={selectedPresetId}
                        onChange={e => handleSelectPreset(e.target.value)}
                        className="select-rich flex-1"
                      >
                        <option value="">{t('settings.artistStringsCustom')}</option>
                        {artistStrings.map(a => (
                          <option key={a.id} value={a.id}>{a.name}</option>
                        ))}
                      </select>
                    </div>
                    <textarea
                      value={imgGen.nai_artist_tags}
                      onChange={e => handleArtistTagsChange(e.target.value)}
                      rows={2}
                      className="textarea-rich w-full resize-none rounded-xl border border-border-light bg-white/70 px-3 py-2 text-sm"
                    />
                    <div className="flex items-center gap-2">
                      <div className="flex items-center gap-1 flex-1">
                        <input
                          value={presetName}
                          onChange={e => setPresetName(e.target.value)}
                          placeholder={t('settings.artistStringsNamePrompt')}
                          className="input-rich flex-1 text-xs"
                          onKeyDown={e => { if (e.key === 'Enter') handleSaveAsPreset(); }}
                        />
                        <button
                          type="button"
                          onClick={handleSaveAsPreset}
                          disabled={!imgGen.nai_artist_tags.trim()}
                          className="rounded-lg bg-accent/10 px-2.5 py-1.5 text-xs font-medium text-accent-dark hover:bg-accent/20 transition disabled:opacity-40"
                        >
                          {t('settings.artistStringsSaveAs')}
                        </button>
                      </div>
                      {selectedPresetId && (
                        <>
                          <button
                            type="button"
                            onClick={handleUpdatePreset}
                            className="rounded-lg bg-blue-100 px-2.5 py-1.5 text-xs font-medium text-blue-700 hover:bg-blue-200 transition"
                          >
                            {t('settings.artistStringsUpdate')}
                          </button>
                          <button
                            type="button"
                            onClick={handleDeletePreset}
                            className="rounded-lg bg-red-100 px-2.5 py-1.5 text-xs font-medium text-red-600 hover:bg-red-200 transition"
                          >
                            {t('settings.artistStringsDelete')}
                          </button>
                        </>
                      )}
                    </div>
                  </div>
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

            {/* 内联提示词：聊天回复附带生图提示词 */}
            <label className="flex items-center gap-3 rounded-2xl border border-border-light bg-white/70 px-4 py-3 text-sm text-text-secondary">
              <input
                type="checkbox"
                checked={imgGen.inline_prompt}
                onChange={e => updateImg('inline_prompt', e.target.checked)}
              />
              {t('settings.imageGenInlinePrompt')}
            </label>
            <p className="px-4 text-xs leading-relaxed text-text-muted">{t('settings.imageGenInlinePromptHint')}</p>

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
                  placeholder={t('settings.imageGenAutoKeywordsPlaceholder')}
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
      // 注意：proxy.ts 的 CSRF 校验要求写方法带 application/json 头
      const res = await fetch('/api/maintenance', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });
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
