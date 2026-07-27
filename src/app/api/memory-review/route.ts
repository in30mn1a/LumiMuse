import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { buildBackgroundChatExtraBody, loadSettings, mergeSettingsForBackgroundLlm, resolveBackgroundConfig } from '@/lib/settings';
import { chatCompletion, REASONING_SAFE_MAX_TOKENS } from '@/lib/api-client';
import { blobToEmbedding, enqueueMemoryEmbeddingTask, loadReadyMemoryEmbeddings } from '@/lib/memory-embeddings';
import { triggerMemoryIndexProcessing } from '@/lib/memory-index-trigger';
import { normalizeTags, TAG_SPEC_PROMPT_SECTION } from '@/lib/memory-tag-spec';
import { MEMORY_CATEGORIES } from '@/types';
import {
  BackgroundLlmTimeoutError,
  runWithBackgroundLlmDeadline,
} from '@/lib/background-llm-deadline';
import { findFirstBalancedJson } from '@/lib/balanced-json';
import {
  createMemoryReviewPlan,
  getMemoryReviewPlan,
  MemoryReviewPlanError,
  PLAN_NOT_FOUND_CODE,
  type MemoryReviewPlan,
} from '@/lib/memory-review-plan';
import {
  MEMORY_REVIEW_BATCH_SIZE,
  MEMORY_REVIEW_ENTRY_CONTENT_CHAR_LIMIT,
} from '@/lib/memory-review-cluster';

const MEMORY_REVIEW_OUTPUT_MAX_TOKENS = REASONING_SAFE_MAX_TOKENS;
const MEMORY_REVIEW_BATCH_CONCURRENCY = 3;
const MEMORY_REVIEW_TAG_OVERVIEW_CHAR_LIMIT = 1200;
/**
 * 单次 HTTP 请求最多审核的记忆条数（按 plan 批累加，成员集合仍由 plan 冻结）。
 * 与 MEMORY_REVIEW_BATCH_SIZE 对齐：一页 ≈ 一批 ≈ 一次 LLM 调用。
 */
const MEMORY_REVIEW_ACTIVE_MEMORY_LIMIT = MEMORY_REVIEW_BATCH_SIZE;

type MemoryReviewRow = {
  id: string;
  category: string;
  content: string;
  tags: string;
  importance: number;
  emotional_weight: number;
  memory_kind: string;
};

type MemoryReviewCurrentRow = Pick<MemoryReviewRow, 'category' | 'tags' | 'importance'>;

type MemoryReviewCorrection = {
  id: string;
  category?: string;
  tags?: string[];
  importance?: number;
};

export type MemoryMergeSuggestion = {
  source_ids: string[];
  merged_content: string;
  category?: string;
  tags?: string[];
  importance?: number;
  kind: 'merge' | 'conflict';
  reason?: string;
};

function parseTags(tags: string): string[] {
  try {
    const parsed = JSON.parse(tags);
    return Array.isArray(parsed) ? parsed.map(tag => String(tag).trim()).filter(Boolean) : [];
  } catch {
    return [];
  }
}

function areStringArraysEqual(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function truncateForReview(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n[内容过长，已截断用于本次审核]`;
}

/** 标签 → 出现次数，按次数降序、同次数按名升序。 */
export function buildTagOverview(memories: MemoryReviewRow[]): string {
  const counts = new Map<string, number>();
  for (const memory of memories) {
    for (const tag of parseTags(memory.tags)) {
      counts.set(tag, (counts.get(tag) ?? 0) + 1);
    }
  }
  const ranked = [...counts.entries()].sort((a, b) => {
    if (b[1] !== a[1]) return b[1] - a[1];
    if (a[0] < b[0]) return -1;
    if (a[0] > b[0]) return 1;
    return 0;
  });
  const text = ranked.map(([tag, count]) => `${tag}×${count}`).join('、') || '无';
  return truncateForReview(text, MEMORY_REVIEW_TAG_OVERVIEW_CHAR_LIMIT);
}

function buildMemoryReviewEntry(memory: MemoryReviewRow, index: number): string {
  const tags = parseTags(memory.tags);
  const content = truncateForReview(memory.content, MEMORY_REVIEW_ENTRY_CONTENT_CHAR_LIMIT);
  return `[${index + 1}] ID:${memory.id} | 分类:${memory.category} | 标签:${tags.join(',') || '无'} | 重要度:${memory.importance} | 种类:${memory.memory_kind}\n${content}`;
}

type SettledResult<R> = { ok: true; value: R } | { ok: false; error: unknown };

/**
 * 有界并发执行，且单个任务失败相互隔离：不再 abort 整批，而是逐个返回成功/失败结果。
 * 这样某一批 API 报错只会跳过该批，其它批次的整理结果仍然落库（问题2修复）。
 */
async function mapWithConcurrencySettled<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>,
  abortSignal?: AbortSignal,
): Promise<SettledResult<R>[]> {
  const results = new Array<SettledResult<R>>(items.length);
  let nextIndex = 0;
  const workerCount = Math.min(Math.max(1, concurrency), items.length);

  async function runWorker() {
    while (true) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= items.length) return;

      try {
        abortSignal?.throwIfAborted();
        results[index] = { ok: true, value: await worker(items[index], index) };
      } catch (error) {
        abortSignal?.throwIfAborted();
        results[index] = { ok: false, error };
      }
    }
  }

  await Promise.all(Array.from({ length: workerCount }, () => runWorker()));
  return results;
}

function buildMemoryReviewPrompt(
  memoriesText: string,
  validCategories: string,
  tagOverview: string,
  batchIndex: number,
  batchCount: number,
): string {
  return `你是 LumiMuse 的记忆审核助手。请审阅以下记忆条目，检查并修正问题。

## 检查项
1. **缺失标签**：没有任何标签的记忆，根据内容给出合适的短标签（优先取自下方标签规范表）
2. **标签整理**：整理当前条目的已有标签，删除重复、过泛或不贴切的标签，并在所有条目中统一意思相近的标签；优先替换为下方标签规范表中的标准标签；例如：午饭/午餐统一为"午餐"，聊天/对话统一为"对话"
3. **缺失重要度**：importance 为 0 或明显离谱的，给出建议值（0-1）
4. **分类错误**：明显归类不当的，给出正确的分类（可选：${validCategories}）
   - 例如：日常琐事（作息、饮食、天气）不应归"重要事件"，应归"四季日常"
   - 例如：有长期价值的信息不应归"四季日常"，应归"偏好习惯"或"基础信息"
5. **可合并重复**（仅建议，不要直接改库）：若本批内存在语义重复、可无损合并的条目，输出 merge_suggestions；时序互相否定的不要合并，kind 标为 conflict

${TAG_SPEC_PROMPT_SECTION}

## 全局参考
- 这是第 ${batchIndex + 1}/${batchCount} 批；本批只输出本批条目的 correction / merge_suggestions，不要输出其他批次的 ID
- 全部已有标签概览（标签×出现次数）：${tagOverview}

## 规则
- 只修正确实有问题的条目，不需要改的就不要输出
- 如果只统一标签，也要输出该条 correction；最终 tags 应该是统一后的完整标签数组，而不是只输出新增标签
- 合并建议铁律：
  1. merged_content 必须保留全部具体事实，宁长勿简，禁止为简洁丢弃细节
  2. 时序互相否定、无法无损合并的事实不得合并，输出 kind=conflict
  3. source_ids 至少 2 个，且必须都是本批 ID
- 只输出 JSON 对象，不要解释

## 输出格式
{"corrections":[{"id":"<记忆ID>","category":"<正确分类>","tags":["标签1","标签2"],"importance":0.65}],"merge_suggestions":[{"source_ids":["id1","id2"],"merged_content":"...","category":"偏好习惯","tags":["标签"],"importance":0.7,"kind":"merge","reason":"重复描述同一偏好"}]}

## 记忆列表
${memoriesText}

请审阅并输出修正：`;
}

function parseMemoryReviewPayload(llmResult: string): {
  corrections: MemoryReviewCorrection[];
  merge_suggestions: MemoryMergeSuggestion[];
} {
  let text = llmResult.trim();
  if (text.startsWith('```')) text = text.split('\n').slice(1).join('\n');
  if (text.endsWith('```')) text = text.slice(0, text.lastIndexOf('```'));

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    const snippet = findFirstBalancedJson(text, 'object');
    if (!snippet) throw new Error('No JSON object');
    parsed = JSON.parse(snippet);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Memory review response must be a JSON object');
  }
  const record = parsed as Record<string, unknown>;
  const correctionsRaw = record.corrections;
  const corrections = Array.isArray(correctionsRaw)
    ? correctionsRaw.filter(
      (correction: unknown) => correction && typeof correction === 'object' && typeof (correction as Record<string, unknown>).id === 'string',
    ) as MemoryReviewCorrection[]
    : [];

  const suggestionsRaw = record.merge_suggestions;
  const merge_suggestions: MemoryMergeSuggestion[] = [];
  if (Array.isArray(suggestionsRaw)) {
    for (const item of suggestionsRaw) {
      if (!item || typeof item !== 'object') continue;
      const row = item as Record<string, unknown>;
      const sourceIds = Array.isArray(row.source_ids)
        ? row.source_ids.filter((id): id is string => typeof id === 'string' && id.trim().length > 0).map(id => id.trim())
        : [];
      const mergedContent = typeof row.merged_content === 'string' ? row.merged_content.trim() : '';
      const kind = row.kind === 'conflict' ? 'conflict' : row.kind === 'merge' ? 'merge' : null;
      if (sourceIds.length < 2 || !mergedContent || !kind) continue;
      merge_suggestions.push({
        source_ids: [...new Set(sourceIds)],
        merged_content: mergedContent,
        category: typeof row.category === 'string' ? row.category : undefined,
        tags: Array.isArray(row.tags) ? row.tags.map(tag => String(tag)).filter(Boolean) : undefined,
        importance: typeof row.importance === 'number' && Number.isFinite(row.importance) ? row.importance : undefined,
        kind,
        reason: typeof row.reason === 'string' ? row.reason : undefined,
      });
    }
  }

  return { corrections, merge_suggestions };
}

function loadEmbeddingMap(characterId: string, db: ReturnType<typeof getDb>): Map<string, Float32Array> {
  const map = new Map<string, Float32Array>();
  try {
    const rows = loadReadyMemoryEmbeddings(characterId, { db });
    for (const row of rows) {
      try {
        map.set(row.memory_id, blobToEmbedding(row.embedding_blob));
      } catch {
        // 单条坏 blob 跳过
      }
    }
  } catch {
    // 无 embedding 表或加载失败 → 文本/顺序降级
  }
  return map;
}

function selectRequestBatches(
  plan: MemoryReviewPlan,
  startBatchIndex: number,
  maxMemories: number,
): { batchIndexes: number[]; memoryIds: string[]; nextBatchIndex: number | null } {
  if (plan.batches.length === 0) {
    return { batchIndexes: [], memoryIds: [], nextBatchIndex: null };
  }
  if (!Number.isInteger(startBatchIndex) || startBatchIndex < 0 || startBatchIndex > plan.batches.length) {
    throw new MemoryReviewPlanError('BATCH_INDEX_OUT_OF_RANGE', 'batch_index out of range');
  }
  if (startBatchIndex === plan.batches.length) {
    return { batchIndexes: [], memoryIds: [], nextBatchIndex: null };
  }

  const batchIndexes: number[] = [];
  const memoryIds: string[] = [];
  let i = startBatchIndex;
  // 累加至至少 maxMemories 条（最后一批允许略超），保证大库时每页接近上限且不切碎批内语义。
  while (i < plan.batches.length && memoryIds.length < maxMemories) {
    batchIndexes.push(i);
    memoryIds.push(...plan.batches[i]);
    i += 1;
  }
  return {
    batchIndexes,
    memoryIds,
    nextBatchIndex: i < plan.batches.length ? i : null,
  };
}

function resolveOrCreatePlan(params: {
  db: ReturnType<typeof getDb>;
  characterId: string;
  planId?: string;
  batchIndex: number;
}): { plan: MemoryReviewPlan; startBatchIndex: number } {
  if (params.planId) {
    const plan = getMemoryReviewPlan(params.planId);
    if (!plan || plan.characterId !== params.characterId) {
      throw new MemoryReviewPlanError(PLAN_NOT_FOUND_CODE, '整理计划不存在或已过期，请重新发起 AI 整理');
    }
    // 校验 batchIndex 合法性（允许等于 length 表示已完成）
    if (!Number.isInteger(params.batchIndex) || params.batchIndex < 0 || params.batchIndex > plan.batches.length) {
      throw new MemoryReviewPlanError('BATCH_INDEX_OUT_OF_RANGE', 'batch_index out of range');
    }
    return { plan, startBatchIndex: params.batchIndex };
  }

  // 新计划：读取全部 active，聚类冻结成员（修 OFFSET 漂移）
  const rows = params.db.prepare(`
    SELECT id, category, content, tags, importance, emotional_weight, memory_kind
    FROM memories
    WHERE character_id = ? AND status = 'active'
  `).all(params.characterId) as MemoryReviewRow[];

  const embeddingById = loadEmbeddingMap(params.characterId, params.db);
  const plan = createMemoryReviewPlan({
    characterId: params.characterId,
    memories: rows.map(row => ({
      id: row.id,
      content: row.content,
      importance: row.importance,
      embedding: embeddingById.get(row.id) ?? null,
    })),
    clusterOptions: {
      batchSize: MEMORY_REVIEW_BATCH_SIZE,
    },
  });
  return { plan, startBatchIndex: 0 };
}

export async function POST(request: NextRequest) {
  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  if (!rawBody || typeof rawBody !== 'object' || Array.isArray(rawBody)) {
    return NextResponse.json({ error: 'Body must be a JSON object' }, { status: 400 });
  }

  const body = rawBody as {
    character_id?: string;
    plan_id?: unknown;
    batch_index?: unknown;
    offset?: unknown;
  };
  const characterId = (body.character_id || '').trim();
  if (!characterId) {
    return NextResponse.json({ error: 'character_id is required' }, { status: 400 });
  }

  const planId = typeof body.plan_id === 'string' && body.plan_id.trim() ? body.plan_id.trim() : undefined;
  let batchIndex = 0;
  if (body.batch_index !== undefined) {
    batchIndex = Number(body.batch_index);
    if (!Number.isInteger(batchIndex) || batchIndex < 0) {
      return NextResponse.json({ error: 'batch_index must be a non-negative integer' }, { status: 400 });
    }
  } else if (body.offset !== undefined && body.offset !== null && !planId) {
    // 兼容旧客户端：无 plan 时忽略 offset 并始终从新 plan 第 0 批开始（避免漂移续跑）。
    // 带 plan_id 时请使用 batch_index。
    batchIndex = 0;
  }

  const db = getDb();

  let plan: MemoryReviewPlan;
  let startBatchIndex: number;
  try {
    ({ plan, startBatchIndex } = resolveOrCreatePlan({
      db,
      characterId,
      planId,
      batchIndex,
    }));
  } catch (error) {
    if (error instanceof MemoryReviewPlanError) {
      const status = error.code === PLAN_NOT_FOUND_CODE ? 404 : 400;
      return NextResponse.json({ ok: false, error: error.message, code: error.code }, { status });
    }
    throw error;
  }

  const totalActive = plan.memoryIds.length;
  const { batchIndexes, memoryIds, nextBatchIndex } = selectRequestBatches(
    plan,
    startBatchIndex,
    MEMORY_REVIEW_ACTIVE_MEMORY_LIMIT,
  );
  // 已处理条数：start 之前所有批的 id 数
  const reviewedBefore = plan.batches
    .slice(0, startBatchIndex)
    .reduce((sum, batch) => sum + batch.length, 0);

  if (memoryIds.length === 0) {
    return NextResponse.json({
      ok: true,
      plan_id: plan.planId,
      batch_index: startBatchIndex,
      batch_count: plan.batches.length,
      next_batch_index: null,
      reviewed: 0,
      total_active: totalActive,
      skipped_due_to_limit: 0,
      reviewed_offset: reviewedBefore,
      next_offset: null,
      has_more: false,
      corrected: 0,
      failed_batches: 0,
      failed_messages: [],
      indexing_queued: 0,
      indexing_started: false,
      changes: [],
      merge_suggestions: [],
    });
  }

  // 按冻结 id 列表加载**当前**行内容（成员集合不因 importance/updated_at 变化而漂移）
  const placeholders = memoryIds.map(() => '?').join(',');
  const loaded = db.prepare(`
    SELECT id, category, content, tags, importance, emotional_weight, memory_kind
    FROM memories
    WHERE character_id = ? AND id IN (${placeholders})
  `).all(characterId, ...memoryIds) as MemoryReviewRow[];
  const byId = new Map(loaded.map(row => [row.id, row]));
  // 仅审核仍存在的记忆；缺失 id（中途删除）跳过但不破坏 plan
  const memories = memoryIds.map(id => byId.get(id)).filter((row): row is MemoryReviewRow => Boolean(row));
  const batchIdSets = batchIndexes.map(index => new Set(plan.batches[index]));
  // 保留 plan 内的全局批号：批内记忆若被中途删除导致整批为空，剩余批的「第 N/M 批」提示仍需正确。
  const reviewBatchEntries = batchIndexes.map(index => ({
    globalIndex: index,
    rows: plan.batches[index]
      .map(id => byId.get(id))
      .filter((row): row is MemoryReviewRow => Boolean(row)),
  })).filter(entry => entry.rows.length > 0);

  const validCategories = MEMORY_CATEGORIES.join('、');
  const tagOverview = buildTagOverview(memories);
  const reviewBatches = reviewBatchEntries.map(entry => entry.rows.map((row, i) => buildMemoryReviewEntry(row, i)));

  const settings = loadSettings();
  const bgConfig = resolveBackgroundConfig(settings);
  const llmSettings = mergeSettingsForBackgroundLlm(settings, bgConfig, {
    json_mode: true,
    streaming: false,
    max_tokens: MEMORY_REVIEW_OUTPUT_MAX_TOKENS,
  });

  if (!llmSettings.api_base.trim() || !llmSettings.model.trim()) {
    return NextResponse.json({ ok: false, error: 'LLM provider is not configured' }, { status: 400 });
  }
  const backgroundExtraBody = buildBackgroundChatExtraBody(settings, llmSettings.model);

  type BatchLlmResult = {
    corrections: MemoryReviewCorrection[];
    merge_suggestions: MemoryMergeSuggestion[];
  };

  let batchOutcomes: SettledResult<BatchLlmResult>[];
  try {
    batchOutcomes = await runWithBackgroundLlmDeadline(
      settings.memory_background_timeout_ms,
      signal => mapWithConcurrencySettled(
        reviewBatches,
        MEMORY_REVIEW_BATCH_CONCURRENCY,
        async (batch, batchIndexInRequest) => {
          const globalBatchIndex = reviewBatchEntries[batchIndexInRequest]?.globalIndex ?? batchIndexInRequest;
          const prompt = buildMemoryReviewPrompt(
            batch.join('\n\n'),
            validCategories,
            tagOverview,
            globalBatchIndex,
            plan.batches.length,
          );
          let llmResult: string;
          try {
            llmResult = await chatCompletion(
              llmSettings,
              [{ role: 'user', content: prompt }],
              signal,
              backgroundExtraBody,
            );
          } catch (err) {
            throw new Error(`AI 调用失败（第 ${batchIndexInRequest + 1}/${reviewBatches.length} 批）: ${err instanceof Error ? err.message : String(err)}`);
          }

          try {
            return parseMemoryReviewPayload(llmResult);
          } catch (err) {
            throw new Error(`解析 AI 响应失败（第 ${batchIndexInRequest + 1}/${reviewBatches.length} 批）: ${err instanceof Error ? err.message : String(err)}`);
          }
        },
        signal,
      ),
      request.signal,
    );
  } catch (err) {
    if (err instanceof BackgroundLlmTimeoutError) {
      return NextResponse.json(
        { ok: false, error: '记忆审核请求超过服务器处理时限', code: 'UPSTREAM_TIMEOUT' },
        { status: 504 },
      );
    }
    if (request.signal.aborted) {
      return NextResponse.json({ ok: false, error: '请求已取消' }, { status: 499 });
    }
    throw err;
  }

  const failedMessages = batchOutcomes
    .filter((outcome): outcome is { ok: false; error: unknown } => !outcome.ok)
    .map(outcome => (outcome.error instanceof Error ? outcome.error.message : String(outcome.error)));
  const failedBatches = failedMessages.length;

  if (reviewBatches.length > 0 && failedBatches === reviewBatches.length) {
    return NextResponse.json(
      { ok: false, error: failedMessages.join('；'), failed_batches: failedBatches, failed_messages: failedMessages },
      { status: 500 },
    );
  }

  const corrections = batchOutcomes.flatMap(outcome => (outcome.ok ? outcome.value.corrections : []));
  const rawSuggestions = batchOutcomes.flatMap(outcome => (outcome.ok ? outcome.value.merge_suggestions : []));

  // 合并建议：只保留本请求内 id，且全部仍在本批候选中
  const validIds = new Set(memories.map(m => m.id));
  const mergeSuggestions = rawSuggestions.filter(suggestion => {
    if (suggestion.source_ids.length < 2) return false;
    if (!suggestion.source_ids.every(id => validIds.has(id))) return false;
    // 同一建议的源应来自同一 plan 批（模型本批可见范围）
    return batchIdSets.some(set => suggestion.source_ids.every(id => set.has(id)));
  });

  const memoryContentById = new Map(memories.map(memory => [memory.id, memory.content]));
  const changes: Array<{ id: string; fields: string[]; content: string }> = [];

  const updateMemory = db.transaction(() => {
    const selectCurrentStmt = db.prepare(`
      SELECT category, tags, importance
      FROM memories
      WHERE id = ? AND character_id = ? AND status = 'active'
    `);
    for (const c of corrections) {
      if (!validIds.has(c.id)) continue;
      const current = selectCurrentStmt.get(c.id, characterId) as MemoryReviewCurrentRow | undefined;
      if (!current) continue;

      const changedFields: string[] = [];
      const setClauses: string[] = [];
      const setValues: Array<string | number> = [];

      if (c.category && MEMORY_CATEGORIES.includes(c.category as typeof MEMORY_CATEGORIES[number])) {
        if (c.category !== current.category) {
          setClauses.push('category = ?');
          setValues.push(c.category);
          changedFields.push(`category→${c.category}`);
        }
      }

      if (Array.isArray(c.tags)) {
        const cleanTags = normalizeTags(c.tags);
        if (!areStringArraysEqual(parseTags(current.tags), cleanTags)) {
          setClauses.push('tags = ?');
          setValues.push(JSON.stringify(cleanTags));
          changedFields.push(`tags→[${cleanTags.join(',')}]`);
        }
      }

      if (typeof c.importance === 'number' && Number.isFinite(c.importance) && c.importance >= 0 && c.importance <= 1) {
        if (c.importance !== current.importance) {
          setClauses.push('importance = ?');
          setValues.push(c.importance);
          changedFields.push(`importance→${c.importance}`);
        }
      }

      if (changedFields.length > 0) {
        setClauses.push('updated_at = datetime(\'now\')');
        const result = db.prepare(`
          UPDATE memories
          SET ${setClauses.join(', ')}
          WHERE id = ? AND character_id = ? AND status = 'active'
        `).run(...setValues, c.id, characterId);
        if (result.changes > 0) {
          changes.push({ id: c.id, fields: changedFields, content: memoryContentById.get(c.id) ?? '' });
        }
      }
    }
  });

  updateMemory();

  let indexingQueued = 0;
  for (const change of changes) {
    try {
      if (enqueueMemoryEmbeddingTask(change.id, characterId, 'updated', db)) indexingQueued += 1;
    } catch (error) {
      console.error('Failed to enqueue memory embedding task after memory review', {
        memoryId: change.id,
        characterId,
        error,
      });
    }
  }
  const indexingStarted = indexingQueued > 0 ? triggerMemoryIndexProcessing() : false;

  const hasMore = nextBatchIndex !== null;
  const nextOffset = hasMore ? reviewedBefore + memories.length : null;
  const skippedDueToLimit = hasMore ? Math.max(0, totalActive - (reviewedBefore + memories.length)) : 0;

  return NextResponse.json({
    ok: true,
    plan_id: plan.planId,
    batch_index: startBatchIndex,
    batch_count: plan.batches.length,
    next_batch_index: nextBatchIndex,
    reviewed: memories.length,
    total_active: totalActive,
    skipped_due_to_limit: skippedDueToLimit,
    reviewed_offset: reviewedBefore,
    next_offset: nextOffset,
    has_more: hasMore,
    corrected: changes.length,
    failed_batches: failedBatches,
    failed_messages: failedMessages,
    indexing_queued: indexingQueued,
    indexing_started: indexingStarted,
    changes,
    merge_suggestions: mergeSuggestions,
  });
}

export { parseMemoryReviewPayload, MEMORY_REVIEW_ACTIVE_MEMORY_LIMIT };
