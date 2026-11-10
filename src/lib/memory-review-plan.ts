/**
 * 记忆审查批次计划：一次性冻结某一状态的 memory id 成员，跨请求稳定取批，并记录读过哪些批。
 * 进程内 Map + 滑动 TTL（每次取批顺延；项目假设单写入实例）。
 */
import {
  buildMemoryReviewBatches,
  type BuildMemoryReviewBatchesOptions,
  type MemoryReviewClusterItem,
} from '@/lib/memory-review-cluster';

// 计划只存 ID，放久一点几乎不占内存。45 分钟时，Agent 每批都要等主人批准提案，
// 回来读下一批常已过期（2026-11-09 实跑 8 次重新准备计划）。
export const MEMORY_REVIEW_PLAN_TTL_MS = 24 * 60 * 60 * 1000;
export const PLAN_NOT_FOUND_CODE = 'PLAN_NOT_FOUND';

export type MemoryReviewPlan = {
  planId: string;
  characterId: string;
  /** 计划成员所属的记忆状态，读取时只认仍处于该状态的条目 */
  status: string;
  createdAt: number;
  expiresAt: number;
  ttlMs: number;
  /** 计划时点该状态的全部 id（稳定序展平后的并集顺序：按 batches 拼接）。 */
  memoryIds: string[];
  batches: string[][];
  /** 已成功读取的批次编号；覆盖进度由服务端统计，不靠模型自己记 */
  readBatches: Set<number>;
  /** 读取时实际返回了正文的条目 */
  readMemoryIds: Set<string>;
};

export type CreateMemoryReviewPlanParams = {
  characterId: string;
  /** 默认 active */
  status?: string;
  memories: MemoryReviewClusterItem[];
  now?: number;
  ttlMs?: number;
  planId?: string;
  clusterOptions?: BuildMemoryReviewBatchesOptions;
};

export class MemoryReviewPlanError extends Error {
  code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'MemoryReviewPlanError';
    this.code = code;
  }
}

const planCache = new Map<string, MemoryReviewPlan>();

function purgeExpiredPlans(now: number): void {
  for (const [planId, plan] of planCache) {
    if (plan.expiresAt <= now) planCache.delete(planId);
  }
}

export function clearMemoryReviewPlanCacheForTests(): void {
  planCache.clear();
}

export function createMemoryReviewPlan(params: CreateMemoryReviewPlanParams): MemoryReviewPlan {
  const now = params.now ?? Date.now();
  const ttlMs = params.ttlMs ?? MEMORY_REVIEW_PLAN_TTL_MS;
  purgeExpiredPlans(now);

  const batches = buildMemoryReviewBatches(params.memories, params.clusterOptions);
  const memoryIds = batches.flat();
  const plan: MemoryReviewPlan = {
    planId: params.planId ?? crypto.randomUUID(),
    characterId: params.characterId,
    status: params.status ?? 'active',
    createdAt: now,
    expiresAt: now + ttlMs,
    ttlMs,
    memoryIds,
    batches,
    readBatches: new Set(),
    readMemoryIds: new Set(),
  };
  planCache.set(plan.planId, plan);
  return plan;
}

export function getMemoryReviewPlan(planId: string, now = Date.now()): MemoryReviewPlan | null {
  purgeExpiredPlans(now);
  const plan = planCache.get(planId);
  if (!plan) return null;
  if (plan.expiresAt <= now) {
    planCache.delete(planId);
    return null;
  }
  return plan;
}

export function getMemoryReviewPlanBatch(params: {
  planId: string;
  characterId: string;
  batchIndex: number;
  now?: number;
}): { plan: MemoryReviewPlan; batchIds: string[] } {
  const now = params.now ?? Date.now();
  const plan = getMemoryReviewPlan(params.planId, now);
  if (!plan || plan.characterId !== params.characterId) {
    throw new MemoryReviewPlanError(PLAN_NOT_FOUND_CODE, '整理计划不存在或已过期，请重新发起 AI 整理');
  }
  if (!Number.isInteger(params.batchIndex) || params.batchIndex < 0 || params.batchIndex >= plan.batches.length) {
    throw new MemoryReviewPlanError('BATCH_INDEX_OUT_OF_RANGE', 'batch_index out of range');
  }
  // 持续使用的计划不过期：长任务中途过期会丢掉已读进度，只能从头再读
  plan.expiresAt = now + plan.ttlMs;
  return { plan, batchIds: plan.batches[params.batchIndex] };
}
