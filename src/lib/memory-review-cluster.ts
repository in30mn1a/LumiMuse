/**
 * AI 整理用的语义聚类分批（纯计算，无 DB）。
 * 贪心单遍：向量 → 文本 → 稳定顺序；禁止按 category 预分桶。
 */
import { dotProduct } from '@/lib/memory-embeddings';
import { supersedeTextSimilarity } from '@/lib/text-similarity';

/** 与 memory-review 路由保持一致的批文本预算。 */
export const MEMORY_REVIEW_BATCH_TEXT_CHAR_LIMIT = 8000;
export const MEMORY_REVIEW_ENTRY_CONTENT_CHAR_LIMIT = 4000;

/** 渲染元数据行的保守开销估算（ID/分类/标签等）。 */
const ENTRY_METADATA_OVERHEAD_CHARS = 160;

export const MEMORY_REVIEW_VECTOR_SIMILARITY_THRESHOLD = 0.78;
export const MEMORY_REVIEW_TEXT_SIMILARITY_THRESHOLD = 0.72;

/** 比较次数护栏：最多 n * multiplier，防止最坏 O(n²) 拖死请求。 */
export const MEMORY_REVIEW_CLUSTER_COMPARISON_MULTIPLIER = 64;

export type MemoryReviewClusterItem = {
  id: string;
  content: string;
  importance: number;
  /** 已 L2 归一的向量；缺失则该条只用文本/顺序。 */
  embedding?: ArrayLike<number> | null;
};

export type BuildMemoryReviewBatchesOptions = {
  batchTextCharLimit?: number;
  entryContentCharLimit?: number;
  vectorThreshold?: number;
  textThreshold?: number;
  maxComparisons?: number;
};

type InternalItem = {
  id: string;
  content: string;
  importance: number;
  embedding: ArrayLike<number> | null;
  estimatedChars: number;
};

function estimateEntryChars(content: string, entryContentCharLimit: number): number {
  const body = Math.min(content.length, entryContentCharLimit);
  const truncationNote = content.length > entryContentCharLimit ? 24 : 0;
  return body + truncationNote + ENTRY_METADATA_OVERHEAD_CHARS;
}

function stableSortItems(items: InternalItem[]): InternalItem[] {
  return [...items].sort((a, b) => {
    if (b.importance !== a.importance) return b.importance - a.importance;
    if (a.id < b.id) return -1;
    if (a.id > b.id) return 1;
    return 0;
  });
}

function vectorSimilarity(a: ArrayLike<number> | null, b: ArrayLike<number> | null): number | null {
  if (!a || !b) return null;
  if (a.length === 0 || b.length === 0 || a.length !== b.length) return null;
  return dotProduct(a, b);
}

/**
 * 将记忆聚成簇后再按字符预算切成 LLM 批次，返回每批 memory id 列表。
 * 同一输入 + 同一选项下结果确定。
 */
export function buildMemoryReviewBatches(
  memories: MemoryReviewClusterItem[],
  options: BuildMemoryReviewBatchesOptions = {},
): string[][] {
  if (memories.length === 0) return [];

  const batchTextCharLimit = options.batchTextCharLimit ?? MEMORY_REVIEW_BATCH_TEXT_CHAR_LIMIT;
  const entryContentCharLimit = options.entryContentCharLimit ?? MEMORY_REVIEW_ENTRY_CONTENT_CHAR_LIMIT;
  const vectorThreshold = options.vectorThreshold ?? MEMORY_REVIEW_VECTOR_SIMILARITY_THRESHOLD;
  const textThreshold = options.textThreshold ?? MEMORY_REVIEW_TEXT_SIMILARITY_THRESHOLD;
  const maxComparisons = options.maxComparisons
    ?? Math.max(memories.length * MEMORY_REVIEW_CLUSTER_COMPARISON_MULTIPLIER, memories.length);

  const items = stableSortItems(
    memories.map(memory => ({
      id: memory.id,
      content: memory.content,
      importance: Number.isFinite(memory.importance) ? memory.importance : 0,
      embedding: memory.embedding ?? null,
      estimatedChars: estimateEntryChars(memory.content, entryContentCharLimit),
    })),
  );

  type Cluster = { seed: InternalItem; members: InternalItem[] };
  const clusters: Cluster[] = [];
  let comparisons = 0;
  let comparisonsExhausted = false;

  for (const item of items) {
    if (comparisonsExhausted) {
      clusters.push({ seed: item, members: [item] });
      continue;
    }

    let bestIndex = -1;
    let bestScore = -1;
    let bestMode: 'vector' | 'text' | null = null;

    for (let i = 0; i < clusters.length; i += 1) {
      if (comparisons >= maxComparisons) {
        comparisonsExhausted = true;
        break;
      }
      comparisons += 1;
      const seed = clusters[i].seed;
      const vectorScore = vectorSimilarity(item.embedding, seed.embedding);
      if (vectorScore !== null) {
        if (vectorScore >= vectorThreshold && vectorScore > bestScore) {
          bestScore = vectorScore;
          bestIndex = i;
          bestMode = 'vector';
        }
        continue;
      }

      const textScore = supersedeTextSimilarity(item.content, seed.content);
      if (textScore >= textThreshold && textScore > bestScore) {
        bestScore = textScore;
        bestIndex = i;
        bestMode = 'text';
      }
    }

    if (bestIndex >= 0 && bestMode) {
      clusters[bestIndex].members.push(item);
    } else {
      clusters.push({ seed: item, members: [item] });
    }
  }

  // 簇内保持稳定序（已按全局稳定序扫描，members 追加顺序即稳定）
  const batches: string[][] = [];
  for (const cluster of clusters) {
    let current: string[] = [];
    let currentLength = 0;
    for (const member of cluster.members) {
      const separatorLength = current.length > 0 ? 2 : 0;
      if (
        current.length > 0
        && currentLength + separatorLength + member.estimatedChars > batchTextCharLimit
      ) {
        batches.push(current);
        current = [];
        currentLength = 0;
      }
      current.push(member.id);
      currentLength += (current.length > 1 ? 2 : 0) + member.estimatedChars;
    }
    if (current.length > 0) batches.push(current);
  }

  return batches;
}
