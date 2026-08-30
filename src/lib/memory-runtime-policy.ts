import {
  DEFAULT_MEMORY_ENGINE_SETTINGS,
  MemoryChatInjectionMode,
  MemoryEngineSettings,
  Settings,
} from '@/types';

export interface MemoryRuntimePolicy {
  indexEnabled: boolean;
  chatInjectionMode: MemoryChatInjectionMode;
  useEmbedding: boolean;
  useLocalRecall: boolean;
  useReranker: boolean;
}

type RawMemoryEngineSettings = Partial<MemoryEngineSettings> & Record<string, unknown>;

function asBoolean(value: unknown, fallback: boolean): boolean {
  if (typeof value === 'boolean') return value;
  if (value === 0) return false;
  if (value === 1) return true;
  return fallback;
}

function legacyChatInjectionMode(
  enabled: boolean,
  embeddingEnabled: boolean,
  fallbackLocalEnabled: boolean,
  limitInject: boolean,
): MemoryChatInjectionMode {
  if (!enabled) return limitInject ? 'local' : 'full';
  if (!embeddingEnabled) return 'local';
  return fallbackLocalEnabled ? 'hybrid' : 'vector';
}

export function normalizeMemoryEngineSettings(
  rawValue: unknown,
  limitInject: boolean,
): MemoryEngineSettings {
  const raw = rawValue && typeof rawValue === 'object'
    ? rawValue as RawMemoryEngineSettings
    : {};
  const merged = {
    ...DEFAULT_MEMORY_ENGINE_SETTINGS,
    ...raw,
  } as MemoryEngineSettings;
  const enabled = asBoolean(raw.enabled, DEFAULT_MEMORY_ENGINE_SETTINGS.enabled);
  const embeddingEnabled = asBoolean(raw.embedding_enabled, DEFAULT_MEMORY_ENGINE_SETTINGS.embedding_enabled);
  const fallbackLocalEnabled = asBoolean(raw.fallback_local_enabled, DEFAULT_MEMORY_ENGINE_SETTINGS.fallback_local_enabled);

  merged.enabled = enabled;
  merged.embedding_enabled = embeddingEnabled;
  merged.fallback_local_enabled = fallbackLocalEnabled;
  merged.reranker_enabled = asBoolean(raw.reranker_enabled, DEFAULT_MEMORY_ENGINE_SETTINGS.reranker_enabled);
  merged.allow_memory_context_in_chat = asBoolean(
    raw.allow_memory_context_in_chat,
    DEFAULT_MEMORY_ENGINE_SETTINGS.allow_memory_context_in_chat,
  );
  merged.allow_external_memory_payloads = asBoolean(
    raw.allow_external_memory_payloads,
    DEFAULT_MEMORY_ENGINE_SETTINGS.allow_external_memory_payloads,
  );

  // 新配置以 index_enabled 为唯一索引开关；旧配置则必须同时满足旧 enhanced engine
  // 与 embedding_enabled，才能保持升级前的索引 drain 行为。
  merged.index_enabled = Object.prototype.hasOwnProperty.call(raw, 'index_enabled')
    ? asBoolean(raw.index_enabled, enabled && embeddingEnabled)
    : enabled && embeddingEnabled;

  const explicitMode = raw.chat_injection_mode;
  const validModes: MemoryChatInjectionMode[] = ['full', 'local', 'hybrid', 'vector'];
  merged.chat_injection_mode = validModes.includes(explicitMode as MemoryChatInjectionMode)
    ? explicitMode as MemoryChatInjectionMode
    : legacyChatInjectionMode(enabled, embeddingEnabled, fallbackLocalEnabled, limitInject);

  return merged;
}

export function resolveMemoryRuntimePolicy(settings: Pick<Settings, 'memory_engine' | 'limit_inject'>): MemoryRuntimePolicy {
  const engine = normalizeMemoryEngineSettings(settings.memory_engine, settings.limit_inject);
  const externalPayloadsAllowed = engine.allow_external_memory_payloads !== false;
  const usesVector = engine.chat_injection_mode === 'hybrid' || engine.chat_injection_mode === 'vector';
  // 显式聊天模式优先于旧 embedding_enabled：该字段仅用于兼容旧配置映射。
  // 实际 API 地址/模型缺失或请求失败时，现有 retrieval 层仍会回退本地召回。
  const useEmbedding = usesVector && externalPayloadsAllowed;
  const useLocalRecall = engine.chat_injection_mode === 'local' || engine.chat_injection_mode === 'hybrid';

  return {
    indexEnabled: engine.index_enabled,
    chatInjectionMode: engine.chat_injection_mode,
    useEmbedding,
    useLocalRecall,
    useReranker: engine.chat_injection_mode !== 'full'
      && engine.reranker_enabled
      && externalPayloadsAllowed,
  };
}
