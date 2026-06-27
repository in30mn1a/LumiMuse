import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { buildBackgroundChatExtraBody, loadSettings, resolveBackgroundConfig } from '@/lib/settings';
import { chatCompletion, REASONING_SAFE_MAX_TOKENS } from '@/lib/api-client';
import { enqueueMemoryEmbeddingTask } from '@/lib/memory-embeddings';
import { triggerMemoryIndexProcessing } from '@/lib/memory-index-trigger';
import { normalizeTags, TAG_SPEC_PROMPT_SECTION } from '@/lib/memory-tag-spec';
import { MEMORY_CATEGORIES } from '@/types';

const MEMORY_REVIEW_OUTPUT_MAX_TOKENS = REASONING_SAFE_MAX_TOKENS;
const MEMORY_REVIEW_BATCH_CONCURRENCY = 3;
const MEMORY_REVIEW_BATCH_TEXT_CHAR_LIMIT = 8000;
const MEMORY_REVIEW_ENTRY_CONTENT_CHAR_LIMIT = 4000;
const MEMORY_REVIEW_TAG_OVERVIEW_CHAR_LIMIT = 1200;
const MEMORY_REVIEW_ACTIVE_MEMORY_LIMIT = 500;

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

function buildTagOverview(memories: MemoryReviewRow[]): string {
  const tags = Array.from(new Set(memories.flatMap(memory => parseTags(memory.tags)))).sort();
  const text = tags.join('、') || '无';
  return truncateForReview(text, MEMORY_REVIEW_TAG_OVERVIEW_CHAR_LIMIT);
}

function buildMemoryReviewEntry(memory: MemoryReviewRow, index: number): string {
  const tags = parseTags(memory.tags);
  const content = truncateForReview(memory.content, MEMORY_REVIEW_ENTRY_CONTENT_CHAR_LIMIT);
  return `[${index + 1}] ID:${memory.id} | 分类:${memory.category} | 标签:${tags.join(',') || '无'} | 重要度:${memory.importance} | 种类:${memory.memory_kind}\n${content}`;
}

function buildMemoryReviewBatches(entries: string[]): string[][] {
  const batches: string[][] = [];
  let current: string[] = [];
  let currentLength = 0;

  for (const entry of entries) {
    const separatorLength = current.length > 0 ? 2 : 0;
    if (current.length > 0 && currentLength + separatorLength + entry.length > MEMORY_REVIEW_BATCH_TEXT_CHAR_LIMIT) {
      batches.push(current);
      current = [];
      currentLength = 0;
    }
    current.push(entry);
    currentLength += (current.length > 1 ? 2 : 0) + entry.length;
  }

  if (current.length > 0) batches.push(current);
  return batches;
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
        results[index] = { ok: true, value: await worker(items[index], index) };
      } catch (error) {
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
3. **缺失重要度**：importance 为 0 或明显不合理的，给出建议值（0-1）
4. **分类错误**：明显归类不当的，给出正确的分类（可选：${validCategories}）
   - 例如：日常琐事（作息、饮食、天气）不应归"重要事件"，应归"四季日常"
   - 例如：有长期价值的信息不应归"四季日常"，应归"偏好习惯"或"基础信息"

${TAG_SPEC_PROMPT_SECTION}

## 全局参考
- 这是第 ${batchIndex + 1}/${batchCount} 批；本批只输出本批条目的 correction，不要输出其他批次的 ID
- 全部已有标签概览：${tagOverview}

## 规则
- 只修正确实有问题的条目，不需要改的就不要输出
- 如果只统一标签，也要输出该条 correction；最终 tags 应该是统一后的完整标签数组，而不是只输出新增标签
- 只输出 JSON 对象，不要解释

## 输出格式
{"corrections":[{"id":"<记忆ID>","category":"<正确分类>","tags":["标签1","标签2"],"importance":0.65}]}

## 记忆列表
${memoriesText}

请审阅并输出修正：`;
}

function parseMemoryReviewCorrections(llmResult: string): MemoryReviewCorrection[] {
  let text = llmResult.trim();
  if (text.startsWith('```')) text = text.split('\n').slice(1).join('\n');
  if (text.endsWith('```')) text = text.slice(0, text.lastIndexOf('```'));
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1) throw new Error('No JSON');
  const parsed = JSON.parse(text.slice(start, end + 1));
  if (!Array.isArray(parsed.corrections)) return [];
  return parsed.corrections.filter(
    (correction: unknown) => correction && typeof correction === 'object' && typeof (correction as Record<string, unknown>).id === 'string',
  );
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

  const body = rawBody as { character_id?: string; offset?: unknown };
  const characterId = (body.character_id || '').trim();
  if (!characterId) {
    return NextResponse.json({ error: 'character_id is required' }, { status: 400 });
  }
  const reviewOffset = body.offset === undefined ? 0 : Number(body.offset);
  if (!Number.isInteger(reviewOffset) || reviewOffset < 0) {
    return NextResponse.json({ error: 'offset must be a non-negative integer' }, { status: 400 });
  }

  const db = getDb();
  const totalActive = (db.prepare(`
    SELECT COUNT(*) AS count
    FROM memories
    WHERE character_id = ? AND status = 'active'
  `).get(characterId) as { count: number }).count;

  // 读取有界 active 候选，避免超大记忆库一次性拉全量进入审核路径。
  const memories = db.prepare(`
    SELECT id, category, content, tags, importance, emotional_weight, memory_kind
    FROM memories
    WHERE character_id = ? AND status = 'active'
    ORDER BY COALESCE(importance, 0) DESC, updated_at DESC
    LIMIT ?
    OFFSET ?
  `).all(characterId, MEMORY_REVIEW_ACTIVE_MEMORY_LIMIT, reviewOffset) as MemoryReviewRow[];
  const reviewedEndOffset = reviewOffset + memories.length;
  const skippedDueToLimit = Math.max(0, totalActive - reviewedEndOffset);
  const hasMore = reviewedEndOffset < totalActive;
  const nextOffset = hasMore ? reviewedEndOffset : null;

  if (memories.length === 0) {
    return NextResponse.json({
      ok: true,
      reviewed: 0,
      total_active: totalActive,
      skipped_due_to_limit: skippedDueToLimit,
      reviewed_offset: reviewOffset,
      next_offset: nextOffset,
      has_more: hasMore,
      corrected: 0,
      failed_batches: 0,
      failed_messages: [],
      indexing_queued: 0,
      indexing_started: false,
      changes: [],
    });
  }

  // AI 整理只覆盖本次有界候选集，避免单次 prompt / 输出过大导致上游超时。
  const validCategories = MEMORY_CATEGORIES.join('、');
  const tagOverview = buildTagOverview(memories);
  const reviewBatches = buildMemoryReviewBatches(memories.map(buildMemoryReviewEntry));

  // 调用 LLM
  const settings = loadSettings();
  const bgConfig = resolveBackgroundConfig(settings);
  const llmSettings = {
    ...settings,
    api_base: bgConfig.api_base,
    api_key: bgConfig.api_key,
    model: bgConfig.model,
    json_mode: true,
    streaming: false,
    max_tokens: MEMORY_REVIEW_OUTPUT_MAX_TOKENS,
  };

  if (!llmSettings.api_base.trim() || !llmSettings.model.trim()) {
    return NextResponse.json({ ok: false, error: 'LLM provider is not configured' }, { status: 400 });
  }
  const backgroundExtraBody = buildBackgroundChatExtraBody(settings, llmSettings.model);

  const batchOutcomes = await mapWithConcurrencySettled(
    reviewBatches,
    MEMORY_REVIEW_BATCH_CONCURRENCY,
    async (batch, batchIndex) => {
      const prompt = buildMemoryReviewPrompt(
        batch.join('\n\n'),
        validCategories,
        tagOverview,
        batchIndex,
        reviewBatches.length,
      );
      let llmResult: string;
      try {
        llmResult = await chatCompletion(
          llmSettings,
          [{ role: 'user', content: prompt }],
          request.signal,
          backgroundExtraBody,
        );
      } catch (err) {
        throw new Error(`AI 调用失败（第 ${batchIndex + 1}/${reviewBatches.length} 批）: ${err instanceof Error ? err.message : String(err)}`);
      }

      try {
        return parseMemoryReviewCorrections(llmResult);
      } catch (err) {
        throw new Error(`解析 AI 响应失败（第 ${batchIndex + 1}/${reviewBatches.length} 批）: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  );

  // 失败批次相互隔离：收集失败信息，仍应用成功批次的修正。
  // 仅当本页所有批次全部失败时才视为整页失败返回 500（与单批失败场景的契约保持一致）。
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

  const corrections = batchOutcomes.flatMap(outcome => (outcome.ok ? outcome.value : []));

  // 应用修正
  const validIds = new Set(memories.map(m => m.id));
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

  return NextResponse.json({
    ok: true,
    reviewed: memories.length,
    total_active: totalActive,
    skipped_due_to_limit: skippedDueToLimit,
    reviewed_offset: reviewOffset,
    next_offset: nextOffset,
    has_more: hasMore,
    corrected: changes.length,
    failed_batches: failedBatches,
    failed_messages: failedMessages,
    indexing_queued: indexingQueued,
    indexing_started: indexingStarted,
    changes,
  });
}
