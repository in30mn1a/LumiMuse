import { getDb } from '@/lib/db';
import { loadSettings } from '@/lib/settings';
import { structuredLog } from '@/lib/structured-log';
import {
  ensureMemoryEmbeddingTables,
  getMemoryIndexStatus,
  processMemoryEmbeddingTasks,
  type EmbeddingAdapterConfig,
} from '@/lib/memory-embeddings';

const MEMORY_INDEX_PROCESS_BATCH_LIMIT = 8;
const MEMORY_INDEX_DRAIN_MAX_BATCHES = 32;
const MEMORY_INDEX_DRAIN_MAX_DURATION_MS = 25_000;
const MEMORY_INDEX_MIN_EMBEDDING_TIMEOUT_MS = 10_000;
const MEMORY_INDEX_DRAIN_CONTINUE_DELAY_MS = 0;
const MEMORY_INDEX_DRAIN_RETRY_DELAY_MS = 30_000;

let memoryIndexDrainActive = false;
let memoryIndexDrainRequested = false;
let memoryIndexDrainStopVersion = 0;
let memoryIndexDrainGeneration = 0;

export type MemoryIndexProcessingBlockedReason =
  | 'memory_engine_disabled'
  | 'external_memory_payloads_disabled'
  | 'embedding_disabled'
  | 'embedding_api_base_missing'
  | 'embedding_model_missing';

function resolveEmbeddingProcessingConfigState(): {
  config: EmbeddingAdapterConfig | null;
  blockedReason: MemoryIndexProcessingBlockedReason | null;
} {
  const settings = loadSettings();
  const engine = settings.memory_engine;
  if (!engine.enabled) return { config: null, blockedReason: 'memory_engine_disabled' };
  if (engine.allow_external_memory_payloads === false) {
    return { config: null, blockedReason: 'external_memory_payloads_disabled' };
  }
  if (!engine.embedding_enabled) return { config: null, blockedReason: 'embedding_disabled' };

  const apiBase = engine.embedding_api_base.trim();
  const model = engine.embedding_model.trim();
  if (!apiBase) return { config: null, blockedReason: 'embedding_api_base_missing' };
  if (!model) return { config: null, blockedReason: 'embedding_model_missing' };

  return {
    config: {
      api_base: apiBase,
      api_key: engine.embedding_api_key,
      model,
      dimension: engine.embedding_dimension,
      timeout_ms: Math.max(engine.embedding_timeout_ms || 0, MEMORY_INDEX_MIN_EMBEDDING_TIMEOUT_MS),
      provider: 'openai-compatible',
    },
    blockedReason: null,
  };
}

function resolveEmbeddingProcessingConfig(): EmbeddingAdapterConfig | null {
  return resolveEmbeddingProcessingConfigState().config;
}

export function getMemoryIndexProcessingBlockedReason(): MemoryIndexProcessingBlockedReason | null {
  return resolveEmbeddingProcessingConfigState().blockedReason;
}

function hasPendingMemoryIndexTasks(): boolean {
  try {
    const db = getDb();
    ensureMemoryEmbeddingTables(db);
    return getMemoryIndexStatus(undefined, db).pending > 0;
  } catch (error) {
    structuredLog('error', 'memory.index.inspect_failed', {
      operation: 'inspect_pending', status: 'failed',
    }, error);
    return false;
  }
}

async function drainMemoryIndexTasks(initialConfig: EmbeddingAdapterConfig): Promise<{ handled: number }> {
  const startedAt = Date.now();
  let config = initialConfig;
  let batches = 0;
  let totalHandled = 0;
  const stopVersion = memoryIndexDrainStopVersion;

  while (
    batches < MEMORY_INDEX_DRAIN_MAX_BATCHES &&
    Date.now() - startedAt < MEMORY_INDEX_DRAIN_MAX_DURATION_MS &&
    stopVersion === memoryIndexDrainStopVersion
  ) {
    memoryIndexDrainRequested = false;
    let result: Awaited<ReturnType<typeof processMemoryEmbeddingTasks>>;

    try {
      result = await processMemoryEmbeddingTasks(config, { limit: MEMORY_INDEX_PROCESS_BATCH_LIMIT });
    } catch (error) {
      structuredLog('error', 'memory.index.process_failed', {
        operation: 'process_batch', status: 'failed',
      }, error);
      break;
    }

    batches += 1;
    const handled = result.processed + result.failed;
    totalHandled += handled;
    if (stopVersion !== memoryIndexDrainStopVersion || handled === 0) break;
    if (handled < MEMORY_INDEX_PROCESS_BATCH_LIMIT && !memoryIndexDrainRequested) break;

    if (memoryIndexDrainRequested) {
      let nextConfig: EmbeddingAdapterConfig | null;
      try {
        nextConfig = resolveEmbeddingProcessingConfig();
      } catch (error) {
        structuredLog('error', 'memory.index.config_refresh_failed', {
          operation: 'refresh_config', status: 'failed',
        }, error);
        break;
      }
      if (!nextConfig) break;
      config = nextConfig;
    }
  }

  return { handled: totalHandled };
}

function scheduleMemoryIndexProcessing(
  config: EmbeddingAdapterConfig,
  delayMs: number,
  generation: number,
): void {
  const stopVersion = memoryIndexDrainStopVersion;
  setTimeout(() => {
    if (generation !== memoryIndexDrainGeneration || stopVersion !== memoryIndexDrainStopVersion) return;

    let handled = 0;
    void drainMemoryIndexTasks(config)
      .then(result => {
        handled = result.handled;
      })
      .catch(error => {
        structuredLog('error', 'memory.index.drain_failed', {
          operation: 'drain', status: 'failed',
        }, error);
      })
      .finally(() => {
        if (generation !== memoryIndexDrainGeneration) return;
        memoryIndexDrainActive = false;
        if (stopVersion === memoryIndexDrainStopVersion && hasPendingMemoryIndexTasks()) {
          triggerMemoryIndexProcessing(handled > 0 ? MEMORY_INDEX_DRAIN_CONTINUE_DELAY_MS : MEMORY_INDEX_DRAIN_RETRY_DELAY_MS);
        }
      });
  }, delayMs);
}

export function stopMemoryIndexProcessing(): void {
  memoryIndexDrainRequested = false;
  memoryIndexDrainStopVersion += 1;
  memoryIndexDrainGeneration += 1;
  // 同步清掉 active 标志，避免 stop/clear 后紧跟 rebuild 时新任务卡在 pending。
  memoryIndexDrainActive = false;
}

export function triggerMemoryIndexProcessing(delayMs = MEMORY_INDEX_DRAIN_CONTINUE_DELAY_MS): boolean {
  let resolved: ReturnType<typeof resolveEmbeddingProcessingConfigState>;
  try {
    resolved = resolveEmbeddingProcessingConfigState();
  } catch (error) {
    structuredLog('error', 'memory.index.config_resolve_failed', {
      operation: 'resolve_config', status: 'failed',
    }, error);
    return false;
  }
  if (!resolved.config) return false;

  memoryIndexDrainRequested = true;
  if (memoryIndexDrainActive) return true;

  memoryIndexDrainActive = true;
  const generation = ++memoryIndexDrainGeneration;
  scheduleMemoryIndexProcessing(resolved.config, delayMs, generation);
  return true;
}
