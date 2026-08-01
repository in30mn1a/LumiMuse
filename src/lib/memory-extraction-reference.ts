import { Memory, Settings } from '@/types';
import { getDb } from '@/lib/db';
import { estimateTokens } from '@/lib/token-counter';
import { normalizeMemoryRow } from '@/lib/memory-normalization';
import { readMemoryProfile, renderMemoryProfile } from '@/lib/memory-profile';
import { resolveMemoryEngineConfig } from '@/lib/memory-retrieval';
import {
  embedTexts,
  loadReadyMemoryEmbeddings,
  rankEmbeddingRows,
} from '@/lib/memory-embeddings';

/**
 * 提取参考记忆的构建。
 *
 * 与聊天注入的检索是两件事，不能共用一套召回：
 * - 聊天注入要的是「与本轮对话相关的记忆」，锚点是用户当前输入；
 * - 提取参考要的是「这条新信息是否已存在 / 是否与旧记忆冲突」，锚点必须是
 *   **即将入库的候选条目本身**。用对话文本做锚点会漏掉措辞差异大但语义冲突的旧记忆
 *   （例："用户迷上做甜点" 召不回 "用户不喜欢吃甜"），导致该 supersede 的没 supersede。
 *
 * 因此这里提供两段参考：
 * - overview：阶段一（纯抽取）用，画像 + 高优先级记忆，不依赖召回质量；
 * - lifecycle reference：阶段二（生命周期判定）用，以候选条目为锚点召回相似旧记忆。
 */

/** 阶段一/二之间传递的候选摘要；刻意不复用 memory-engine 的私有类型，避免双向依赖。 */
export interface ExtractionCandidateSummary {
  category: string;
  content: string;
  tags: string[];
}

export interface ExtractionReference {
  /** 渲染好的记忆列表文本，可直接插入 prompt；无记忆时为空串 */
  text: string;
  memories: Memory[];
  /**
   * vector: 候选锚点向量召回
   * hybrid: 向量 + 本地关键词并集
   * local: 仅本地关键词召回（未配置 embedding 或向量召回失败）
   * priority-only: 无候选/无召回结果，仅高优先级保底
   */
  mode: 'vector' | 'hybrid' | 'local' | 'priority-only';
  tokenCount: number;
  diagnostics: {
    embeddingFailed?: string;
    recallCount: number;
    priorityCount: number;
    truncated: boolean;
  };
}

export interface ExtractionReferenceDeps {
  /** 本地关键词检索；由调用方注入以避免与 memory-engine 形成循环依赖 */
  localRetrieve?: (queryText: string, characterId: string, limit: number) => Memory[];
  loadPriorityMemories?: (characterId: string) => Memory[];
  loadEmbeddingRows?: typeof loadReadyMemoryEmbeddings;
  loadMemoriesByIds?: (ids: string[]) => Memory[];
  embedTexts?: typeof embedTexts;
  tokenCounter?: (text: string) => number;
  loadMemoryProfile?: typeof readMemoryProfile;
}

/** 每个候选向量召回的条数；候选数 × 该值构成召回池，最终仍由 token 预算裁剪。 */
const PER_CANDIDATE_RECALL_LIMIT = 12;

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
  return rows.map(normalizeMemoryRow);
}

function loadDefaultMemoriesByIds(ids: string[]): Memory[] {
  if (ids.length === 0) return [];
  const db = getDb();
  const placeholders = ids.map(() => '?').join(',');
  const rows = db.prepare(
    `SELECT * FROM memories WHERE status = 'active' AND id IN (${placeholders})`,
  ).all(...ids) as Memory[];
  const order = new Map(ids.map((id, index) => [id, index]));
  return rows
    .map(normalizeMemoryRow)
    .sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
}

/** 渲染带稳定编号的一行；编号是模型指认 supersede/upsert 目标的唯一凭据。 */
function renderMemoryLine(memory: Memory, index: number): string {
  return `E${index}. [${memory.category}] ${memory.content}`;
}

function renderMemoryList(memories: Memory[]): string {
  return memories.map((memory, index) => renderMemoryLine(memory, index)).join('\n');
}

/**
 * 按 token 预算取最长前缀。调用方已按优先级排好序，故直接线性累加即可，
 * 不需要整包二分——这里的条数由召回上限约束，不是聊天注入那种全量场景。
 */
function selectWithinBudget(
  memories: Memory[],
  budget: number,
  tokenCounter: (text: string) => number,
  indexOffset = 0,
): { selected: Memory[]; tokenCount: number; truncated: boolean } {
  const selected: Memory[] = [];
  let used = 0;

  for (const memory of memories) {
    const cost = tokenCounter(`${renderMemoryLine(memory, indexOffset + selected.length)}\n`);
    if (used + cost > budget) {
      return { selected, tokenCount: used, truncated: true };
    }
    used += cost;
    selected.push(memory);
  }

  return { selected, tokenCount: used, truncated: false };
}

/** 候选条目 → 向量/关键词召回的锚点文本。带上分类与标签，贴近入库时的 embedding 文本。 */
function anchorTextFor(candidate: ExtractionCandidateSummary): string {
  const tagPart = candidate.tags.length > 0 ? ` [${candidate.tags.join(', ')}]` : '';
  return `${candidate.category}: ${candidate.content}${tagPart}`;
}

async function recallByVector(
  characterId: string,
  candidates: ExtractionCandidateSummary[],
  config: ReturnType<typeof resolveMemoryEngineConfig>,
  deps: ExtractionReferenceDeps,
): Promise<{ memories: Memory[]; failure?: string }> {
  const embed = deps.embedTexts || embedTexts;
  const loadRows = deps.loadEmbeddingRows || loadReadyMemoryEmbeddings;
  const loadByIds = deps.loadMemoriesByIds || loadDefaultMemoriesByIds;

  try {
    const vectors = await embed(candidates.map(anchorTextFor), {
      api_base: config.embedding_api_base,
      api_key: config.embedding_api_key,
      model: config.embedding_model,
      dimension: config.embedding_dimension,
      timeout_ms: config.embedding_timeout_ms,
      provider: 'openai-compatible',
    });

    const rows = loadRows(characterId, {
      provider: 'openai-compatible',
      model: config.embedding_model,
      dimension: config.embedding_dimension,
    });
    if (rows.length === 0) return { memories: [] };

    // 每个候选各召回一批，按相似度归并去重：同一条旧记忆被多个候选命中时取最高分。
    const bestScore = new Map<string, number>();
    for (const vector of vectors) {
      for (const item of rankEmbeddingRows(vector, rows, PER_CANDIDATE_RECALL_LIMIT)) {
        const id = item.row.memory_id;
        const score = (item.similarity + 1) / 2;
        const prev = bestScore.get(id);
        if (prev === undefined || score > prev) bestScore.set(id, score);
      }
    }

    const orderedIds = [...bestScore.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([id]) => id);
    return { memories: loadByIds(orderedIds) };
  } catch (error) {
    return { memories: [], failure: error instanceof Error ? error.message : String(error) };
  }
}

function recallByKeyword(
  characterId: string,
  candidates: ExtractionCandidateSummary[],
  deps: ExtractionReferenceDeps,
): Memory[] {
  const localRetrieve = deps.localRetrieve;
  if (!localRetrieve) return [];

  const seen = new Set<string>();
  const merged: Memory[] = [];
  try {
    for (const candidate of candidates) {
      for (const memory of localRetrieve(anchorTextFor(candidate), characterId, PER_CANDIDATE_RECALL_LIMIT)) {
        if (seen.has(memory.id)) continue;
        seen.add(memory.id);
        merged.push(memory);
      }
    }
  } catch {
    // 关键词召回本身就是向量失败后的兜底，它再失败就只剩高优先级保底，不再向上抛
    return merged;
  }
  return merged;
}

/**
 * 阶段一参考：角色画像 + 高优先级记忆概览。
 * 不依赖召回质量，用于让抽取模型知道「这个角色/用户的长期轮廓」，
 * 避免重复提取已被画像概括的内容。
 */
export function buildExtractionOverview(
  characterId: string,
  settings: Settings,
  deps: ExtractionReferenceDeps = {},
): { profileText: string; priorityText: string } {
  const config = resolveMemoryEngineConfig(settings);
  const tokenCounter = deps.tokenCounter || estimateTokens;
  const loadProfile = deps.loadMemoryProfile || readMemoryProfile;
  const loadPriority = deps.loadPriorityMemories || loadDefaultPriorityMemories;

  // 两个数据源各自降级：参考材料缺失只会让模型少一点上下文，
  // 但抛到调用方会让整个提取任务失败重试，记忆彻底丢失——代价不对等。
  let profileText = '';
  try {
    const profile = loadProfile(characterId);
    profileText = profile ? renderMemoryProfile(profile) : '';
  } catch {
    profileText = '';
  }

  let priorityText = '';
  try {
    // 画像单独占一份预算，剩下的留给高优先级记忆，避免画像把概览挤空。
    const profileTokens = profileText ? tokenCounter(profileText) : 0;
    const priorityBudget = Math.max(0, config.memory_package_token_budget - profileTokens);
    priorityText = renderMemoryList(
      selectWithinBudget(loadPriority(characterId), priorityBudget, tokenCounter).selected,
    );
  } catch {
    priorityText = '';
  }

  return { profileText, priorityText };
}

/**
 * 阶段二参考：以候选条目为锚点召回相似旧记忆，供模型判定 insert/upsert/supersede/ignore。
 *
 * 召回顺序即优先级：高优先级记忆（人格骨架，绝不能漏）→ 按相似度排序的召回结果。
 * 失败不阻塞：向量召回失败自动回退关键词召回，两者都不可用时仍返回高优先级保底。
 */
export async function buildLifecycleReference(
  characterId: string,
  candidates: ExtractionCandidateSummary[],
  settings: Settings,
  deps: ExtractionReferenceDeps = {},
): Promise<ExtractionReference> {
  const config = resolveMemoryEngineConfig(settings);
  const tokenCounter = deps.tokenCounter || estimateTokens;
  const loadPriority = deps.loadPriorityMemories || loadDefaultPriorityMemories;

  let mode: ExtractionReference['mode'] = 'priority-only';
  let recalled: Memory[] = [];
  let embeddingFailed: string | undefined;

  if (candidates.length > 0) {
    if (config.embedding_enabled && config.embedding_model) {
      const vector = await recallByVector(characterId, candidates, config, deps);
      embeddingFailed = vector.failure;
      if (vector.memories.length > 0) {
        recalled = vector.memories;
        mode = 'vector';
      }
    }

    // 关键词召回**始终**参与并做并集，而不是只在向量零结果时兜底：
    // 上一轮刚写入的近重复记忆，其 embedding 任务可能还在队列里 pending，
    // 而 loadReadyMemoryEmbeddings 硬过滤 status='ready'，向量召回看不见它——
    // 而「连续几轮聊同一话题」恰恰是重复提取风险最高的窗口。
    if (config.fallback_local_enabled !== false) {
      const keyword = recallByKeyword(characterId, candidates, deps);
      if (keyword.length > 0) {
        const seen = new Set(recalled.map(memory => memory.id));
        const extra = keyword.filter(memory => !seen.has(memory.id));
        recalled = [...recalled, ...extra];
        if (mode !== 'vector') mode = 'local';
        else if (extra.length > 0) mode = 'hybrid';
      }
    }
  }

  // 高优先级记忆置顶：pinned / importance≥0.85 / character_promise 是角色人格骨架，
  // 漏掉它们导致的 supersede 误判代价最高，故不参与召回排序、直接占据预算前列。
  // 单独兜底：保底查询失败不该连累已经召回到的结果。
  let priority: Memory[] = [];
  try {
    priority = loadPriority(characterId);
  } catch {
    priority = [];
  }

  const budget = config.memory_package_token_budget;

  // 被召回命中的 priority 记忆提到最前：它们与本轮候选语义最相关。
  // 若留在 priority 尾部，会同时遭遇「已从召回集去重」+「被 priority 预算截断」，
  // 结果是唯一的语义命中一条都没进 prompt，日志却仍报 mode=vector、recallCount>0。
  const recalledIds = new Set(recalled.map(memory => memory.id));
  const priorityOrdered = [
    ...priority.filter(memory => recalledIds.has(memory.id)),
    ...priority.filter(memory => !recalledIds.has(memory.id)),
  ];
  const priorityIds = new Set(priority.map(memory => memory.id));
  const dedupedRecall = recalled.filter(memory => !priorityIds.has(memory.id));

  // 召回结果先取保底份额：priority 里的 character_promise 无条件入选且只增不减，
  // 不预留的话长期陪伴后会把语义命中整体挤出 prompt。
  // 但只取「实际需要的」——召回池上限是 12×候选数，通常只有几条，
  // 用不完的余额全部回流给 priority，不闲置。
  const reserve = dedupedRecall.length > 0 ? Math.floor(budget / 2) : 0;
  const recallPick = selectWithinBudget(dedupedRecall, reserve, tokenCounter);
  const priorityPick = selectWithinBudget(
    priorityOrdered,
    budget - recallPick.tokenCount,
    tokenCounter,
  );

  const selected = [...priorityPick.selected, ...recallPick.selected];
  const text = renderMemoryList(selected);

  return {
    text,
    memories: selected,
    mode,
    // 用最终渲染文本实测：两段分别估算时 indexOffset 不同，累加会有偏差
    tokenCount: text ? tokenCounter(text) : 0,
    diagnostics: {
      embeddingFailed,
      recallCount: recalled.length,
      priorityCount: priority.length,
      truncated: priorityPick.truncated || recallPick.truncated,
    },
  };
}
