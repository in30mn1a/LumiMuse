/**
 * AI 整理批次计划：一次性冻结 memory id 成员，跨请求稳定取批。
 * 进程内 Map + TTL（项目假设单写入实例）。
 */
import {
  buildMemoryReviewBatches,
  type BuildMemoryReviewBatchesOptions,
  type MemoryReviewClusterItem,
} from '@/lib/memory-review-cluster';

export const MEMORY_REVIEW_PLAN_TTL_MS = 45 * 60 * 1000;
export const PLAN_NOT_FOUND_CODE = 'PLAN_NOT_FOUND';

export type MemoryReviewPlan = {
  planId: string;
  characterId: string;
  createdAt: number;
  expiresAt: number;
  /** 计划时点全部 active id（稳定序展平后的并集顺序：按 batches 拼接）。 */
  memoryIds: string[];
  batches: string[][];
};

export type CreateMemoryReviewPlanParams = {
  characterId: string;
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
    createdAt: now,
    expiresAt: now + ttlMs,
    memoryIds,
    batches,
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
  return { plan, batchIds: plan.batches[params.batchIndex] };
}
