import { getDb } from '@/lib/db';
import { estimateTokens } from '@/lib/token-counter';
import { Memory, Settings } from '@/types';
import { inferMemoryDefaults } from '@/lib/memory-category';
import { retrieveRelevantMemories } from '@/lib/memory-engine';
import { CharacterMemoryProfile, readMemoryProfile, renderMemoryProfile } from '@/lib/memory-profile';
import { normalizeMemoryRow } from '@/lib/memory-normalization';
import {
  EmbeddingAdapterConfig,
  embedText,
  loadReadyMemoryEmbeddings,
  rankEmbeddingRows,
} from '@/lib/memory-embeddings';
import {
  rerankDocuments,
  RerankerAdapterConfig,
  RerankResult,
} from '@/lib/memory-reranker';
import {
  DEFAULT_MEMORY_PACKAGE_TOKEN_BUDGET,
  MEMORY_CONTEXT_TITLE,
  MEMORY_USAGE_PRINCIPLES,
} from '@/lib/memory-prompt-contract';

const MEMORY_LAYERS = [
  { id: 'fixed', title: '重要固定记忆', sortByCreatedAt: true },
  { id: 'promises', title: '角色需要兑现的承诺', sortByCreatedAt: true },
  { id: 'user_context', title: '用户的偏好与长期信息', sortByCreatedAt: false },
  { id: 'relationship_events', title: '关系与重要事件', sortByCreatedAt: true },
  { id: 'relevant', title: '本轮相关回忆', sortByCreatedAt: false },
] as const;

type MemoryLayerId = (typeof MEMORY_LAYERS)[number]['id'];

export interface MemoryEngineConfig {
  enabled: boolean;
  allow_memory_context_in_chat: boolean;
  allow_external_memory_payloads: boolean;
  retrieval_mode: 'local' | 'hybrid' | 'vector';
  embedding_enabled: boolean;
  embedding_api_base: string;
  embedding_api_key: string;
  embedding_model: string;
  embedding_dimension: number;
  reranker_enabled: boolean;
  reranker_api_base: string;
  reranker_api_key: string;
  reranker_model: string;
  fallback_local_enabled: boolean;
  memory_package_token_budget: number;
  retrieval_token_budget: number;
  vector_top_k: number;
  keyword_top_k: number;
  reranker_top_k: number;
  final_top_k: number;
  embedding_timeout_ms: number;
  reranker_timeout_ms: number;
  total_retrieval_timeout_ms: number;
  profile_token_budget: number;
}

export interface RetrievedMemory {
  memory: Memory;
  relevance: number;
  finalScore: number;
  source: 'priority' | 'local' | 'vector';
}

export interface WorkingMemoryPackage {
  text: string;
  selectedMemories: Memory[];
  tokenCount: number;
  /**
   * 检索模式：
   * - local: 增强记忆本地检索（无 embedding）或 legacy 限制注入（limit_inject=true）
   * - hybrid: 增强记忆混合检索（向量 + 本地）
   * - vector: 增强记忆纯向量检索
   * - full: 关闭增强记忆 + 全量注入（limit_inject=false），不检索、不设任何上限，注入全部 active 记忆
   */
  mode: 'local' | 'hybrid' | 'vector' | 'full';
  usedFallback: boolean;
  diagnostics: {
    embeddingFailed?: string;
    rerankerFailed?: string;
    totalRetrievalTimedOut?: boolean;
    candidateCount: number;
  };
}

interface RetrievalDeps {
  localRetrieve?: (queryText: string, characterId: string, limit: number) => Memory[];
  loadLegacyMemories?: (characterId: string) => Memory[];
  loadPriorityMemories?: (characterId: string) => Memory[];
  loadEmbeddingRows?: typeof loadReadyMemoryEmbeddings;
  loadMemoriesByIds?: (ids: string[]) => Memory[];
  embedText?: (text: string, config: EmbeddingAdapterConfig) => Promise<ArrayLike<number>>;
  rerank?: (query: string, documents: Array<{ id: string; text: string }>, config: RerankerAdapterConfig) => Promise<RerankResult[]>;
  tokenCounter?: (text: string) => number;
  loadMemoryProfile?: (characterId: string) => CharacterMemoryProfile | null;
  markMemoriesUsed?: (ids: string[]) => Promise<void> | void;
}

export interface RetrieveWorkingMemoryOptions {
  characterId: string;
  queryText: string;
  settings: Settings;
  deps?: RetrievalDeps;
}

const DEFAULT_MEMORY_ENGINE_CONFIG: MemoryEngineConfig = {
  enabled: true,
  allow_memory_context_in_chat: true,
  allow_external_memory_payloads: true,
  retrieval_mode: 'local',
  embedding_enabled: false,
  embedding_api_base: '',
  embedding_api_key: '',
  embedding_model: '',
  embedding_dimension: 1024,
  reranker_enabled: false,
  reranker_api_base: '',
  reranker_api_key: '',
  reranker_model: '',
  fallback_local_enabled: true,
  memory_package_token_budget: DEFAULT_MEMORY_PACKAGE_TOKEN_BUDGET,
  retrieval_token_budget: 8000,
  vector_top_k: 80,
  keyword_top_k: 20,
  reranker_top_k: 40,
  final_top_k: 30,
  embedding_timeout_ms: 1500,
  reranker_timeout_ms: 2000,
  total_retrieval_timeout_ms: 2500,
  profile_token_budget: 1200,
};


function finiteNumber(value: unknown, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function resolveMemoryEngineConfig(settings: Settings): MemoryEngineConfig {
  const raw = (settings as unknown as { memory_engine?: Partial<MemoryEngineConfig> }).memory_engine || {};
  const merged = { ...DEFAULT_MEMORY_ENGINE_CONFIG, ...raw };
  const legacyLimit = finiteNumber(settings.memory_max_inject, DEFAULT_MEMORY_ENGINE_CONFIG.final_top_k);
  const engineEnabled = merged.enabled !== false;
  const isFullInjectionMode = !engineEnabled && !settings.limit_inject;
  const allowExternalMemoryPayloads = merged.allow_external_memory_payloads !== false;

  return {
    ...merged,
    allow_memory_context_in_chat: merged.allow_memory_context_in_chat !== false,
    allow_external_memory_payloads: allowExternalMemoryPayloads,
    retrieval_mode: merged.retrieval_mode === 'vector' || merged.retrieval_mode === 'hybrid'
      ? merged.retrieval_mode
      : 'local',
    embedding_enabled: engineEnabled && allowExternalMemoryPayloads && merged.embedding_enabled,
    reranker_enabled: engineEnabled && allowExternalMemoryPayloads && merged.reranker_enabled,
    // 不设上界:预算大小由用户自行决定。下界由 finiteNumber 的 >0 判断兜底回默认值。
    // 例外:全量注入模式（引擎关闭 + limit_inject=false）不允许任何 token 上限,
    // 用 Number.MAX_SAFE_INTEGER 防止下游调用方/测试直接复用该预算做钳制。
    memory_package_token_budget: isFullInjectionMode
      ? Number.MAX_SAFE_INTEGER
      : finiteNumber(merged.memory_package_token_budget, DEFAULT_MEMORY_ENGINE_CONFIG.memory_package_token_budget),
    retrieval_token_budget: finiteNumber(merged.retrieval_token_budget, DEFAULT_MEMORY_ENGINE_CONFIG.retrieval_token_budget),
    vector_top_k: Math.floor(finiteNumber(merged.vector_top_k, DEFAULT_MEMORY_ENGINE_CONFIG.vector_top_k)),
    keyword_top_k: Math.floor(finiteNumber(merged.keyword_top_k, DEFAULT_MEMORY_ENGINE_CONFIG.keyword_top_k)),
    reranker_top_k: Math.floor(finiteNumber(merged.reranker_top_k, DEFAULT_MEMORY_ENGINE_CONFIG.reranker_top_k)),
    final_top_k: Math.floor(finiteNumber(merged.final_top_k, settings.limit_inject ? legacyLimit : DEFAULT_MEMORY_ENGINE_CONFIG.final_top_k)),
    embedding_timeout_ms: finiteNumber(merged.embedding_timeout_ms, DEFAULT_MEMORY_ENGINE_CONFIG.embedding_timeout_ms),
    reranker_timeout_ms: finiteNumber(merged.reranker_timeout_ms, DEFAULT_MEMORY_ENGINE_CONFIG.reranker_timeout_ms),
    total_retrieval_timeout_ms: finiteNumber(merged.total_retrieval_timeout_ms, DEFAULT_MEMORY_ENGINE_CONFIG.total_retrieval_timeout_ms),
    profile_token_budget: finiteNumber(merged.profile_token_budget, DEFAULT_MEMORY_ENGINE_CONFIG.profile_token_budget),
  };
}

function normalizeMemoryRecord(record: Memory): Memory {
  return normalizeMemoryRow(record);
}

function loadDefaultPriorityMemories(characterId: string): Memory[] {
  const db = getDb();
  const rows = db.prepare(
    `SELECT * FROM memories
     WHERE character_id = ?
       AND status = 'active'
       AND (
         COALESCE(pinned, 0) > 0
         OR COALESCE(importance, 0) >= 0.85
         OR memory_kind = 'character_promise'
       )
     ORDER BY
       COALESCE(pinned, 0) DESC,
       COALESCE(importance, 0) DESC,
       updated_at DESC`,
  ).all(characterId) as Memory[];

  return rows.map(normalizeMemoryRecord);
}

function loadDefaultLegacyMemories(characterId: string): Memory[] {
  const db = getDb();
  // 全量注入路径不设条数上限，也没有任何 token 预算裁剪（见 buildLegacyFullMemoryPackage 的 full 分支）
  const rows = db.prepare(
    `SELECT * FROM memories
     WHERE character_id = ?
       AND status = 'active'
      ORDER BY
        COALESCE(pinned, 0) DESC,
        COALESCE(importance, 0) DESC,
        updated_at DESC`,
  ).all(characterId) as Memory[];

  return rows.map(normalizeMemoryRecord);
}

function loadDefaultMemoriesByIds(ids: string[]): Memory[] {
  if (ids.length === 0) return [];
  const db = getDb();
  const placeholders = ids.map(() => '?').join(',');
  const rows = db.prepare(`SELECT * FROM memories WHERE status = 'active' AND id IN (${placeholders})`).all(...ids) as Memory[];
  const order = new Map(ids.map((id, index) => [id, index]));
  return rows
    .map(normalizeMemoryRecord)
    .sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
}

function markDefaultMemoriesUsed(ids: string[]): void {
  const uniqueIds = [...new Set(ids)].filter(Boolean);
  if (uniqueIds.length === 0) return;

  const db = getDb();
  const placeholders = uniqueIds.map(() => '?').join(',');
  db.prepare(`
    UPDATE memories
    SET usage_count = COALESCE(usage_count, 0) + 1,
        last_used_at = ?
    WHERE id IN (${placeholders})
  `).run(new Date().toISOString(), ...uniqueIds);
}

function markSelectedMemoriesUsed(memories: Memory[], deps: RetrievalDeps): void {
  const ids = [...new Set(memories.map(memory => memory.id).filter(Boolean))];
  if (ids.length === 0) return;

  const mark = deps.markMemoriesUsed || markDefaultMemoriesUsed;
  Promise.resolve()
    .then(() => mark(ids))
    .catch(error => {
      console.warn('[memory-retrieval] failed to update memory usage', error);
    });
}

function addCandidate(
  map: Map<string, RetrievedMemory>,
  memory: Memory,
  relevance: number,
  source: RetrievedMemory['source'],
): void {
  const normalized = normalizeMemoryRecord(memory);
  const existing = map.get(normalized.id);
  if (!existing || relevance > existing.relevance || source === 'priority') {
    map.set(normalized.id, {
      memory: normalized,
      relevance: Math.max(0, Math.min(1, relevance)),
      finalScore: 0,
      source,
    });
  }
}

/**
 * 把已类型化为 number 的字段钳制到 [0,1]，非有限值回退 fallback。
 * 字段已在 normalizeMemoryRow 中规范化为 number，无需再绕过类型系统动态取列。
 */
function clamp01(value: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(0, Math.min(1, value));
}

function getMemoryKind(memory: Memory): string {
  // memory_kind 已在 normalizeMemoryRow 中规范化为合法 MemoryKind（非空 string）。
  // 保留 fallback 以防未经规范化的裸 DB 行直接进入评分。
  const rawKind = memory.memory_kind;
  if (rawKind) return rawKind;
  return inferMemoryDefaults(memory.category).memory_kind;
}

function recencyScore(memory: Memory): number {
  const timestamp = Date.parse(memory.updated_at || memory.created_at || '');
  if (!Number.isFinite(timestamp)) return 0.4;
  const days = Math.max(0, (Date.now() - timestamp) / 86_400_000);
  return Math.max(0, Math.min(1, 1 / (1 + days / 30)));
}

function categoryBonus(memory: Memory): number {
  const kind = getMemoryKind(memory);
  if (kind === 'character_promise') return 1;
  if (kind === 'relationship_event' || kind === 'user_preference' || kind === 'user_fact' || kind === 'world_state') return 0.8;
  if (memory.category === '重要事件' || memory.category === '关系动态' || memory.category === '偏好习惯') return 0.7;
  return 0.2;
}

function statusPenalty(memory: Memory): number {
  const status = memory.status;
  if (status === 'archived' || status === 'superseded') return 0.7;
  if (status === 'conflict') return 0.4;
  return 0;
}

function scoreCandidate(candidate: RetrievedMemory): RetrievedMemory {
  const memory = candidate.memory;
  const defaults = inferMemoryDefaults(memory.category);
  const importance = clamp01(memory.importance, defaults.importance);
  const emotionalWeight = clamp01(memory.emotional_weight, defaults.emotional_weight);
  const usageCount = memory.usage_count;
  const usageScore = Math.max(0, Math.min(1, Math.log1p(Math.max(0, usageCount)) / Math.log(11)));
  const pinned = memory.pinned ? 1 : 0;

  const finalScore =
    0.45 * candidate.relevance +
    0.20 * importance +
    0.15 * emotionalWeight +
    0.10 * recencyScore(memory) +
    0.05 * usageScore +
    0.05 * categoryBonus(memory) +
    pinned * 0.4 -
    statusPenalty(memory);

  return { ...candidate, finalScore };
}

function rankCandidatesByRelevance(candidates: Iterable<RetrievedMemory>): RetrievedMemory[] {
  return [...candidates].sort((a, b) => {
    if (b.relevance !== a.relevance) return b.relevance - a.relevance;
    return Date.parse(b.memory.updated_at || '') - Date.parse(a.memory.updated_at || '');
  });
}

function rankCandidates(candidates: Iterable<RetrievedMemory>): RetrievedMemory[] {
  return [...candidates].map(scoreCandidate).sort((a, b) => {
    if (b.finalScore !== a.finalScore) return b.finalScore - a.finalScore;
    return Date.parse(b.memory.updated_at || '') - Date.parse(a.memory.updated_at || '');
  });
}

function layerForMemory(memory: Memory): MemoryLayerId {
  const kind = getMemoryKind(memory);
  const pinned = memory.pinned;
  const importance = clamp01(memory.importance, inferMemoryDefaults(memory.category).importance);

  if (pinned || importance >= 0.9) return 'fixed';
  if (kind === 'character_promise') return 'promises';
  if (kind === 'user_preference' || kind === 'user_fact') return 'user_context';
  if (kind === 'relationship_event' || kind === 'world_state') return 'relationship_events';
  return 'relevant';
}

function parseCreatedAtForPresentation(value: string): number | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d+)?$/.test(trimmed)
    ? `${trimmed.replace(' ', 'T')}Z`
    : trimmed;
  const timestamp = Date.parse(normalized);
  return Number.isFinite(timestamp) ? timestamp : null;
}

function trimProfileText(
  profileText: string,
  config: MemoryEngineConfig,
  tokenCounter: (text: string) => number,
): string {
  const trimmed = profileText.trim();
  if (!trimmed) return '';

  const profileBudget = Math.min(config.profile_token_budget, config.memory_package_token_budget);
  const selected: string[] = [];
  for (const line of trimmed.split('\n')) {
    const candidate = [...selected, line].join('\n');
    if (tokenCounter(candidate) <= profileBudget) {
      selected.push(line);
    }
  }

  return selected.length > 1 ? selected.join('\n') : '';
}

function orderMemoriesForPresentation(memories: Memory[]): Memory[] {
  const groups = new Map<MemoryLayerId, Array<{
    memory: Memory;
    selectionIndex: number;
    createdAt: number | null;
  }>>();
  for (const layer of MEMORY_LAYERS) {
    groups.set(layer.id, []);
  }

  memories.forEach((memory, selectionIndex) => {
    groups.get(layerForMemory(memory))?.push({
      memory,
      selectionIndex,
      createdAt: parseCreatedAtForPresentation(memory.created_at || ''),
    });
  });

  const ordered: Memory[] = [];
  for (const layer of MEMORY_LAYERS) {
    const layerEntries = groups.get(layer.id) || [];
    if (!layer.sortByCreatedAt) {
      ordered.push(...layerEntries.map(entry => entry.memory));
      continue;
    }

    ordered.push(...[...layerEntries].sort((a, b) => {
      if (a.createdAt === null && b.createdAt === null) {
        return a.selectionIndex - b.selectionIndex;
      }
      if (a.createdAt === null) return -1;
      if (b.createdAt === null) return 1;
      if (a.createdAt !== b.createdAt) return a.createdAt - b.createdAt;
      return a.selectionIndex - b.selectionIndex;
    }).map(entry => entry.memory));
  }
  return ordered;
}

function renderPackage(memories: Memory[], profileText = '', presentationOrder = false): string {
  if (memories.length === 0 && !profileText) return '';

  const groups = new Map<MemoryLayerId, string[]>();
  for (const layer of MEMORY_LAYERS) {
    groups.set(layer.id, []);
  }

  const renderedMemories = presentationOrder ? orderMemoriesForPresentation(memories) : memories;
  for (const memory of renderedMemories) {
    const content = memory.content.trim();
    if (!content) continue;
    groups.get(layerForMemory(memory))?.push(`- ${content}`);
  }

  const sections = [MEMORY_CONTEXT_TITLE];
  if (profileText) {
    sections.push(`### 记忆画像\n${profileText.replace(/^记忆画像：\n?/u, '').trim()}`);
  }
  for (const layer of MEMORY_LAYERS) {
    const lines = groups.get(layer.id);
    if (!lines || lines.length === 0) continue;
    sections.push(`### ${layer.title}\n${lines.join('\n')}`);
  }
  sections.push(MEMORY_USAGE_PRINCIPLES);
  return sections.join('\n\n');
}

function isHighPriorityMemory(memory: Memory): boolean {
  const layer = layerForMemory(memory);
  return layer === 'fixed' || layer === 'promises';
}

// 单条高优先级记忆即使整条超预算,也截断内容后注入,避免承诺/钉选被整条丢弃。
function truncateMemoryForBudget(
  memory: Memory,
  budget: number,
  profileText: string,
  tokenCounter: (text: string) => number,
  existingMemories: Memory[] = [],
): Memory | null {
  const content = memory.content.trim();
  if (!content) return null;

  let lo = 0;
  let hi = content.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    const trial = `${content.slice(0, mid)}…`;
    const tokens = tokenCounter(renderPackage([...existingMemories, { ...memory, content: trial }], profileText));
    if (tokens <= budget) {
      lo = mid;
    } else {
      hi = mid - 1;
    }
  }

  if (lo <= 0) return null;
  return { ...memory, content: `${content.slice(0, lo)}…` };
}

interface TrimByTokenBudgetOptions {
  skipOversizedOrdinary?: boolean;
}

/**
 * 增量装箱状态：用「骨架 + 分层标题 + 行 bullet」分项累加近似整包 token。
 *
 * js-tiktoken 对整包（数万字符）encode 极慢；full-inject 若反复整包 encode 会卡数秒。
 * 短片段 encode 总和 ≈ 同量字符但避免大串反复完整 BPE。
 * BPE 跨界合并使分项和略 ≥ 真实整包 → 装箱偏保守；最终再精确整包一次回写 tokenCount。
 */
class PackagePacker {
  private readonly tokenCounter: (text: string) => number;
  private readonly profileText: string;
  private readonly lineCache = new Map<string, number>();
  private readonly openLayers = new Set<MemoryLayerId>();
  private running: number;

  constructor(profileText: string, tokenCounter: (text: string) => number) {
    this.tokenCounter = tokenCounter;
    this.profileText = profileText;
    // 标题 + 原则始终存在；画像可选。段间 '\n\n' 用固定松弛覆盖。
    const skeletonParts = [MEMORY_CONTEXT_TITLE];
    if (profileText) {
      skeletonParts.push(`### 记忆画像\n${profileText.replace(/^记忆画像：\n?/u, '').trim()}`);
    }
    skeletonParts.push(MEMORY_USAGE_PRINCIPLES);
    // +8：段间换行与 bullet 行间 '\n' 的粗松弛起点
    this.running = tokenCounter(skeletonParts.join('\n\n')) + 8;
  }

  lineTokens(content: string): number {
    const cached = this.lineCache.get(content);
    if (cached !== undefined) return cached;
    const tokens = content ? this.tokenCounter(`- ${content}`) : 0;
    this.lineCache.set(content, tokens);
    return tokens;
  }

  /** 若加入该记忆，running 会变成多少（不修改状态） */
  costIfAdd(memory: Memory): number {
    const content = memory.content.trim();
    if (!content) return this.running;
    const layer = layerForMemory(memory);
    let extra = this.lineTokens(content) + 1; // +1 行间换行
    if (!this.openLayers.has(layer)) {
      const title = MEMORY_LAYERS.find(item => item.id === layer)?.title || layer;
      extra += this.tokenCounter(`### ${title}`) + 2; // 新层标题 + 段间距
    }
    return this.running + extra;
  }

  add(memory: Memory): void {
    const content = memory.content.trim();
    if (!content) return;
    const layer = layerForMemory(memory);
    this.running = this.costIfAdd(memory);
    this.openLayers.add(layer);
  }

  get tokens(): number {
    return this.running;
  }
}

function trimByTokenBudget(
  ranked: RetrievedMemory[],
  config: MemoryEngineConfig,
  tokenCounter: (text: string) => number,
  profileText = '',
  maxMemoryCount = Math.max(1, config.final_top_k),
  options: TrimByTokenBudgetOptions = {},
): { text: string; selected: Memory[]; tokenCount: number } {
  const budget = config.memory_package_token_budget;
  const exactTokenCache = new Map<string, number>();
  const countTokens = (text: string): number => {
    const cached = exactTokenCache.get(text);
    if (cached !== undefined) return cached;
    const count = tokenCounter(text);
    exactTokenCache.set(text, count);
    return count;
  };

  // 画像 + 固定结构若已超预算,丢弃画像让记忆仍能按预算注入,避免画像把记忆一起饿死。
  let effectiveProfile = profileText;
  if (effectiveProfile && countTokens(renderPackage([], effectiveProfile)) > budget) {
    effectiveProfile = '';
  }

  const limit = Math.min(ranked.length, Math.max(0, maxMemoryCount));
  const packer = new PackagePacker(effectiveProfile, countTokens);

  // ── 阶段一：最长高分前缀（行级累加，零整包 encode）────────────────────
  // 关闭增强记忆 full-inject 时这里是主热路径：旧实现 O(log n) 次整包 tiktoken。
  let lo = 0;
  while (lo < limit && packer.costIfAdd(ranked[lo].memory) <= budget) {
    packer.add(ranked[lo].memory);
    lo += 1;
  }

  const selected: Memory[] = ranked.slice(0, lo).map(candidate => candidate.memory);

  // ── 阶段二：尾部扫描 ──────────────────────────────────────────────────
  // skipOversizedOrdinary：跳过超长普通，继续装后面的短记忆。
  // 高优先级装不下时精确截断（整包二分，低频）。
  // skipOversizedOrdinary=false：只处理高优先级，普通尾项不 tokenize 行内容。
  for (let index = lo; index < limit && selected.length < maxMemoryCount; index += 1) {
    const memory = ranked[index].memory;
    const highPriority = isHighPriorityMemory(memory);

    if (!options.skipOversizedOrdinary && !highPriority) {
      continue;
    }

    const content = memory.content.trim();
    if (!content) continue;

    if (packer.costIfAdd(memory) <= budget) {
      if (options.skipOversizedOrdinary || highPriority) {
        packer.add(memory);
        selected.push(memory);
      }
      continue;
    }

    if (highPriority) {
      const truncated = truncateMemoryForBudget(
        memory,
        budget,
        effectiveProfile,
        countTokens,
        selected,
      );
      if (truncated) {
        selected.push(truncated);
      }
      // 高优先级截断后预算已贴边，结束尾部扫描（避免截断内容与 packer 累加漂移）
      break;
    }

    // 普通记忆装不下：skip 后继续
    if (!options.skipOversizedOrdinary) {
      continue;
    }
  }

  // 最终整包精确校验；分项偶发低估时从尾部回退
  let text = renderPackage(selected, effectiveProfile);
  let tokenCount = text ? countTokens(text) : 0;
  while (tokenCount > budget && selected.length > 0) {
    selected.pop();
    text = renderPackage(selected, effectiveProfile);
    tokenCount = text ? countTokens(text) : 0;
  }

  const presentationText = renderPackage(selected, effectiveProfile, true);
  const presentationTokenCount = presentationText ? countTokens(presentationText) : 0;
  if (presentationTokenCount <= budget) {
    return { text: presentationText, selected, tokenCount: presentationTokenCount };
  }

  return { text, selected, tokenCount };
}

async function applyReranker(
  queryText: string,
  candidates: Map<string, RetrievedMemory>,
  config: MemoryEngineConfig,
  deps: RetrievalDeps,
  diagnostics: WorkingMemoryPackage['diagnostics'],
  signal?: AbortSignal,
): Promise<void> {
  if (!config.reranker_enabled || candidates.size === 0) return;

  const rerank = deps.rerank || rerankDocuments;
  const docs = rankCandidatesByRelevance(candidates.values()).slice(0, config.reranker_top_k).map(candidate => ({
    id: candidate.memory.id,
    text: candidate.memory.content,
  }));

  try {
    const results = await rerank(queryText, docs, {
      api_base: config.reranker_api_base,
      api_key: config.reranker_api_key,
      model: config.reranker_model,
      timeout_ms: config.reranker_timeout_ms,
      signal,
    });
    const finiteScores = results
      .map(result => Number(result.score))
      .filter(score => Number.isFinite(score));
    const minScore = finiteScores.length > 0 ? Math.min(...finiteScores) : 0;
    const maxScore = finiteScores.length > 0 ? Math.max(...finiteScores) : 0;
    const shouldNormalize = maxScore > minScore && (minScore < 0 || maxScore > 1);

    const rerankedIds = new Set<string>();
    let minRerankedRelevance = Infinity;
    for (const result of results) {
      const candidate = candidates.get(result.id);
      if (!candidate) continue;
      const score = Number(result.score);
      if (!Number.isFinite(score)) continue;
      candidate.relevance = shouldNormalize
        ? (score - minScore) / (maxScore - minScore)
        : Math.max(0, Math.min(1, score));
      rerankedIds.add(candidate.memory.id);
      minRerankedRelevance = Math.min(minRerankedRelevance, candidate.relevance);
    }

    // 只有 top reranker_top_k 候选被送入重排,其余仍保留原始相关性(尺度与重排分不同)。
    // 把未重排候选压到重排集最低分以下,避免它们在 finalScore 上反超被重排压低的候选。
    if (Number.isFinite(minRerankedRelevance)) {
      const unrerankedCeiling = Math.max(0, minRerankedRelevance - 1e-6);
      for (const candidate of candidates.values()) {
        if (rerankedIds.has(candidate.memory.id)) continue;
        candidate.relevance = Math.min(candidate.relevance, unrerankedCeiling);
      }
    }
  } catch (error) {
    diagnostics.rerankerFailed = error instanceof Error ? error.message : String(error);
  }
}

async function addVectorCandidates(
  queryText: string,
  characterId: string,
  config: MemoryEngineConfig,
  deps: RetrievalDeps,
  candidates: Map<string, RetrievedMemory>,
  signal?: AbortSignal,
): Promise<void> {
  const embed = deps.embedText || embedText;
  const loadRows = deps.loadEmbeddingRows || loadReadyMemoryEmbeddings;
  const loadByIds = deps.loadMemoriesByIds || loadDefaultMemoriesByIds;

  const queryEmbedding = await embed(queryText, {
    api_base: config.embedding_api_base,
    api_key: config.embedding_api_key,
    model: config.embedding_model,
    dimension: config.embedding_dimension,
    timeout_ms: config.embedding_timeout_ms,
    provider: 'openai-compatible',
    signal,
  });
  const rows = loadRows(characterId, {
    provider: 'openai-compatible',
    model: config.embedding_model,
    dimension: config.embedding_dimension,
    limit: Number.POSITIVE_INFINITY,
  });
  if (rows.length === 0 && config.embedding_dimension > 0) {
    const mismatchedRows = loadRows(characterId, {
      provider: 'openai-compatible',
      model: config.embedding_model,
      limit: Number.POSITIVE_INFINITY,
    });
    const mismatchedDimensions = [...new Set(mismatchedRows
      .map(row => Number((row as unknown as { dimension?: unknown }).dimension))
      .filter(dimension => Number.isFinite(dimension) && dimension !== config.embedding_dimension))];
    if (mismatchedDimensions.length > 0) {
      throw new Error(
        `embedding dimension mismatch: expected ${config.embedding_dimension}, indexed ${mismatchedDimensions.join(', ')}`,
      );
    }
  }
  const rankedRows = rankEmbeddingRows(queryEmbedding, rows, config.vector_top_k);
  const memories = loadByIds(rankedRows.map(item => item.row.memory_id));
  const memoryById = new Map(memories.map(memory => [memory.id, memory]));

  for (const item of rankedRows) {
    const memory = memoryById.get(item.row.memory_id);
    if (!memory) continue;
    addCandidate(candidates, memory, (item.similarity + 1) / 2, 'vector');
  }
}

function localMemoryLimit(settings: Settings, config: MemoryEngineConfig): number {
  if (settings.limit_inject) {
    return Math.max(1, settings.memory_max_inject || config.final_top_k);
  }
  return Number.POSITIVE_INFINITY;
}

function maxSelectedMemoryCount(settings: Settings, config: MemoryEngineConfig): number {
  if (settings.limit_inject) {
    return Math.max(1, config.final_top_k);
  }
  return Number.POSITIVE_INFINITY;
}

function withTotalTimeout<T>(work: (signal: AbortSignal) => Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const controller = new AbortController();
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error(`memory retrieval timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });

  const result = Promise.resolve().then(() => work(controller.signal));
  return Promise.race([result, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

function buildEmptyPackage(): WorkingMemoryPackage {
  return {
    text: '',
    selectedMemories: [],
    tokenCount: 0,
    mode: 'local',
    usedFallback: false,
    diagnostics: { candidateCount: 0 },
  };
}

function buildLegacyFullMemoryPackage(
  options: RetrieveWorkingMemoryOptions,
  config: MemoryEngineConfig,
  deps: RetrievalDeps,
): WorkingMemoryPackage {
  const tokenCounter = deps.tokenCounter || estimateTokens;
  const legacyMemories = options.settings.limit_inject
    ? (deps.localRetrieve || retrieveRelevantMemories)(
        options.queryText,
        options.characterId,
        localMemoryLimit(options.settings, config),
      )
    : (deps.loadLegacyMemories || loadDefaultLegacyMemories)(options.characterId);
  const ranked = legacyMemories.map((memory, index) => ({
    memory,
    relevance: 1,
    finalScore: 1 - index / 100_000,
    source: 'local' as const,
  }));
  if (!options.settings.limit_inject) {
    // 真·全量注入：不做任何 token 预算裁剪、条数限制或单条截断，
    // 全部 active 记忆整包注入（产品决策 2026-08-03：full 模式不允许任何上限）。
    const text = renderPackage(legacyMemories, '', true);
    return {
      text,
      selectedMemories: legacyMemories,
      tokenCount: text ? tokenCounter(text) : 0,
      mode: 'full',
      usedFallback: false,
      diagnostics: { candidateCount: ranked.length },
    };
  }

  const trimmed = trimByTokenBudget(
    ranked,
    config,
    tokenCounter,
    '',
    maxSelectedMemoryCount(options.settings, config),
  );

  return {
    text: trimmed.text,
    selectedMemories: trimmed.selected,
    tokenCount: trimmed.tokenCount,
    // limit_inject=true 是 legacy 本地关键词检索（仍受 token 预算与条数限制）
    mode: 'local',
    usedFallback: false,
    diagnostics: { candidateCount: ranked.length },
  };
}

function resolveProfileText(
  characterId: string,
  config: MemoryEngineConfig,
  deps: RetrievalDeps,
  tokenCounter: (text: string) => number,
): string {
  const loadProfile = deps.loadMemoryProfile || readMemoryProfile;
  return trimProfileText(
    renderMemoryProfile(loadProfile(characterId) || {
      character_id: characterId,
      profile_name: '',
      relationship_state: '',
      recent_story_state: '',
      emotional_baseline: '',
      open_threads: [],
      user_profile_summary: '',
      pinned_summary: '',
      updated_at: '',
    }),
    config,
    tokenCounter,
  );
}

async function buildLocalFallbackPackage(
  options: RetrieveWorkingMemoryOptions,
  config: MemoryEngineConfig,
  deps: RetrievalDeps,
  diagnostics: WorkingMemoryPackage['diagnostics'] = { candidateCount: 0 },
): Promise<WorkingMemoryPackage> {
  const localRetrieve = deps.localRetrieve || retrieveRelevantMemories;
  const priorityMemories = (deps.loadPriorityMemories || loadDefaultPriorityMemories)(options.characterId);
  const tokenCounter = deps.tokenCounter || estimateTokens;
  const profileText = resolveProfileText(options.characterId, config, deps, tokenCounter);
  const candidates = new Map<string, RetrievedMemory>();

  for (const memory of priorityMemories) {
    addCandidate(candidates, memory, 0.75, 'priority');
  }

  const localMemories = localRetrieve(options.queryText, options.characterId, localMemoryLimit(options.settings, config));
  localMemories.forEach((memory, index) => {
    const relevance = Math.max(0.1, 0.7 - index * 0.01);
    addCandidate(candidates, memory, relevance, 'local');
  });

  const ranked = rankCandidates(candidates.values());
  const trimmed = trimByTokenBudget(
    ranked,
    config,
    tokenCounter,
    profileText,
    maxSelectedMemoryCount(options.settings, config),
  );

  return {
    text: trimmed.text,
    selectedMemories: trimmed.selected,
    tokenCount: trimmed.tokenCount,
    mode: 'local',
    usedFallback: true,
    diagnostics: { ...diagnostics, candidateCount: ranked.length },
  };
}

async function buildWorkingMemoryPackage(
  options: RetrieveWorkingMemoryOptions,
  config: MemoryEngineConfig,
  signal?: AbortSignal,
): Promise<WorkingMemoryPackage> {
  if (!config.allow_memory_context_in_chat) {
    return buildEmptyPackage();
  }

  const deps = options.deps || {};
  const localRetrieve = deps.localRetrieve || retrieveRelevantMemories;
  const priorityMemories = (deps.loadPriorityMemories || loadDefaultPriorityMemories)(options.characterId);
  const tokenCounter = deps.tokenCounter || estimateTokens;
  const profileText = resolveProfileText(options.characterId, config, deps, tokenCounter);
  const candidates = new Map<string, RetrievedMemory>();
  const diagnostics: WorkingMemoryPackage['diagnostics'] = { candidateCount: 0 };
  let mode: WorkingMemoryPackage['mode'] = 'local';
  let usedFallback = false;

  for (const memory of priorityMemories) {
    addCandidate(candidates, memory, 0.75, 'priority');
  }

  if (config.embedding_enabled) {
    try {
      await addVectorCandidates(options.queryText, options.characterId, config, deps, candidates, signal);
      mode = candidates.size > priorityMemories.length ? 'vector' : 'hybrid';
    } catch (error) {
      diagnostics.embeddingFailed = error instanceof Error ? error.message : String(error);
      usedFallback = true;
      mode = 'local';
      console.warn('[memory-retrieval] 向量检索失败，回退本地检索:', diagnostics.embeddingFailed);
    }
  }

  if (!config.embedding_enabled || config.fallback_local_enabled || usedFallback) {
    const localLimit = localMemoryLimit(options.settings, config);
    const localMemories = localRetrieve(options.queryText, options.characterId, localLimit);
    const baseRelevance = usedFallback ? 0.7 : 0.55;
    localMemories.forEach((memory, index) => {
      const relevance = Math.max(0.1, baseRelevance - index * 0.01);
      addCandidate(candidates, memory, relevance, 'local');
    });
    if (config.embedding_enabled && !usedFallback) mode = 'hybrid';
  }

  await applyReranker(options.queryText, candidates, config, deps, diagnostics, signal);

  const ranked = rankCandidates(candidates.values());
  diagnostics.candidateCount = ranked.length;
  const trimmed = trimByTokenBudget(
    ranked,
    config,
    tokenCounter,
    profileText,
    maxSelectedMemoryCount(options.settings, config),
  );

  return {
    text: trimmed.text,
    selectedMemories: trimmed.selected,
    tokenCount: trimmed.tokenCount,
    mode,
    usedFallback,
    diagnostics,
  };
}

export async function retrieveWorkingMemoryPackage(options: RetrieveWorkingMemoryOptions): Promise<WorkingMemoryPackage> {
  const config = resolveMemoryEngineConfig(options.settings);
  const deps = options.deps || {};
  if (!config.allow_memory_context_in_chat) {
    return buildEmptyPackage();
  }

  let result: WorkingMemoryPackage;
  if (!config.enabled) {
    result = buildLegacyFullMemoryPackage(options, config, deps);
    markSelectedMemoriesUsed(result.selectedMemories, deps);
    return result;
  }

  try {
    result = await withTotalTimeout(
      signal => buildWorkingMemoryPackage(options, config, signal),
      config.total_retrieval_timeout_ms,
    );
  } catch (error) {
    if (!(error instanceof Error) || !/memory retrieval timed out/.test(error.message)) {
      throw error;
    }

    result = await buildLocalFallbackPackage(options, config, deps, {
      candidateCount: 0,
      totalRetrievalTimedOut: true,
    });
  }

  markSelectedMemoriesUsed(result.selectedMemories, deps);
  return result;
}
