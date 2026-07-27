/**
 * AI 整理用的语义聚类分批（纯计算，无 DB）。
 * 贪心单遍：向量 → 文本 → 稳定顺序；禁止按 category 预分桶。
 * 分批按条数（默认 500），聚类只决定批内/跨批邻接顺序，不再按字符硬切。
 */
import { dotProduct } from '@/lib/memory-embeddings';
import { supersedeTextSimilarity } from '@/lib/text-similarity';

/** 单次 LLM 审核最多携带的记忆条数（与 HTTP 页大小对齐）。 */
export const MEMORY_REVIEW_BATCH_SIZE = 500;

/** 写入审核 prompt 时单条 content 截断上限（仅渲染用，不影响分批）。 */
export const MEMORY_REVIEW_ENTRY_CONTENT_CHAR_LIMIT = 4000;

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
  /** 每批最多条数；默认 MEMORY_REVIEW_BATCH_SIZE。 */
  batchSize?: number;
  vectorThreshold?: number;
  textThreshold?: number;
  maxComparisons?: number;
};

type InternalItem = {
  id: string;
  content: string;
  importance: number;
  embedding: ArrayLike<number> | null;
};

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
 * 将记忆聚成簇后按条数切成 LLM 批次，返回每批 memory id 列表。
 * 簇顺序保留语义邻接（同簇尽量同批），同一输入 + 同一选项下结果确定。
 */
export function buildMemoryReviewBatches(
  memories: MemoryReviewClusterItem[],
  options: BuildMemoryReviewBatchesOptions = {},
): string[][] {
  if (memories.length === 0) return [];

  const batchSizeRaw = options.batchSize ?? MEMORY_REVIEW_BATCH_SIZE;
  const batchSize = Number.isFinite(batchSizeRaw) && batchSizeRaw >= 1
    ? Math.floor(batchSizeRaw)
    : MEMORY_REVIEW_BATCH_SIZE;
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

  // 按簇展平（同簇相邻），再按条数切批，避免按字符切出上百次 LLM 调用。
  const orderedIds: string[] = [];
  for (const cluster of clusters) {
    for (const member of cluster.members) {
      orderedIds.push(member.id);
    }
  }

  const batches: string[][] = [];
  for (let offset = 0; offset < orderedIds.length; offset += batchSize) {
    batches.push(orderedIds.slice(offset, offset + batchSize));
  }
  return batches;
}
