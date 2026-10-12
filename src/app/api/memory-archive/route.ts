import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import {
  executeMemorySummaryArchive,
  listUndoableMemoryArchiveBatches,
  planMemorySummaryArchive,
  undoMemorySummaryArchiveBatch,
  type MemoryArchiveSourceMemory,
} from '@/lib/memory-archive';
import { applyBackgroundSystemPrompt } from '@/lib/background-system-prompt';
import { loadCharacterTaskModels, resolveCharacterTaskSystemPrompt } from '@/lib/character-task-models';
import { buildBackgroundChatExtraBody, loadSettings, mergeSettingsForBackgroundLlm, resolveBackgroundConfig } from '@/lib/settings';
import { chatCompletion, REASONING_SAFE_MAX_TOKENS } from '@/lib/api-client';
import { enqueueMemoryEmbeddingTask } from '@/lib/memory-embeddings';
import { triggerMemoryIndexProcessing } from '@/lib/memory-index-trigger';
import { AI_ARCHIVE_PROMPT } from '@/lib/prompt-templates';
import type { MemoryCategory, MemoryKind, MemoryStatus } from '@/types';
import { findFirstBalancedJson } from '@/lib/balanced-json';
import { publicErrorMessage } from '@/lib/public-error';
import { BackgroundLlmTimeoutError, runWithBackgroundLlmDeadline } from '@/lib/background-llm-deadline';

const MAX_SUMMARY_CONTENT_LENGTH = 8 * 1024;
/** covered_memory_ids 里有记忆已被删除 / 归档 / 合并：方案已过期，重试不会成功。 */
const COVERED_NOT_ARCHIVABLE_CODE = 'COVERED_NOT_ARCHIVABLE';

type MemoryRow = {
  id: string;
  category: MemoryCategory;
  content: string;
  confidence: number;
  tags: string;
  source_msg_ids: string;
  memory_kind: MemoryKind;
  importance: number;
  emotional_weight: number;
  status: MemoryStatus;
  pinned: number;
  metadata: string;
};

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function parseStringArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === 'string');
  if (typeof value !== 'string') return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

function parseMetadata(value: unknown): Record<string, unknown> {
  if (isObject(value)) return value;
  if (typeof value !== 'string') return {};
  try {
    const parsed = JSON.parse(value);
    return isObject(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function toSourceMemory(row: MemoryRow): MemoryArchiveSourceMemory {
  return {
    id: row.id,
    category: row.category,
    content: row.content,
    confidence: row.confidence,
    tags: parseStringArray(row.tags),
    source_msg_ids: parseStringArray(row.source_msg_ids),
    memory_kind: row.memory_kind,
    importance: row.importance,
    emotional_weight: row.emotional_weight,
    status: row.status,
    pinned: row.pinned === 1,
    metadata: parseMetadata(row.metadata),
  };
}

/** AI 归档方案里的一组：同一主题的若干记忆 + 一条覆盖它们的摘要。 */
type AiArchiveProposalGroup = {
  title: string;
  summary: string;
  memories: Array<{ id: string; category: string; content: string }>;
};

/** 把 LLM 输出规整为分组；兼容旧版单组格式 { archive_memory_ids, summary }。 */
function readAiArchiveGroups(parsed: Record<string, unknown>): Array<{ title: string; summary: string; memoryIds: string[] }> {
  const rawGroups: unknown[] = Array.isArray(parsed.groups)
    ? parsed.groups
    : [{ memory_ids: parsed.archive_memory_ids, summary: parsed.summary }];
  return rawGroups.filter(isObject).map(group => ({
    title: typeof group.title === 'string' ? group.title.trim() : '',
    summary: typeof group.summary === 'string' ? group.summary.trim() : '',
    memoryIds: Array.isArray(group.memory_ids)
      ? group.memory_ids.filter((id): id is string => typeof id === 'string')
      : [],
  }));
}

function readNonEmptyString(body: Record<string, unknown>, key: string): string | null {
  const value = body[key];
  return typeof value === 'string' && value.trim() ? value : null;
}

function readStringIds(body: Record<string, unknown>, key: string): string[] | null {
  const value = body[key];
  if (!Array.isArray(value) || value.length === 0) return null;
  const ids = value.filter((item): item is string => typeof item === 'string' && item.length > 0);
  return ids.length === value.length ? ids : null;
}

function loadCoveredMemories(characterId: string, coveredMemoryIds: string[]) {
  const db = getDb();
  const placeholders = coveredMemoryIds.map(() => '?').join(',');
  const rows = db.prepare(`
    SELECT id, category, content, confidence, tags, source_msg_ids,
      memory_kind, importance, emotional_weight, status, pinned, metadata
    FROM memories
    WHERE character_id = ? AND id IN (${placeholders})
  `).all(characterId, ...coveredMemoryIds) as MemoryRow[];

  if (rows.length !== coveredMemoryIds.length) {
    return null;
  }

  const rowById = new Map(rows.map(row => [row.id, row]));
  return coveredMemoryIds.map(id => toSourceMemory(rowById.get(id)!));
}

function queueArchiveSummaryIndex(summaryMemoryId: string, characterId: string) {
  try {
    const indexingQueued = enqueueMemoryEmbeddingTask(summaryMemoryId, characterId, 'created', getDb());
    return {
      indexing_queued: indexingQueued,
      indexing_started: indexingQueued ? triggerMemoryIndexProcessing() : false,
    };
  } catch (error) {
    console.error('Failed to queue archive summary memory indexing', {
      memoryId: summaryMemoryId,
      characterId,
      error,
    });
    return { indexing_queued: false, indexing_started: false };
  }
}

export async function GET(request: NextRequest) {
  const characterId = request.nextUrl.searchParams.get('character_id')?.trim();
  if (!characterId) {
    return NextResponse.json({ error: 'character_id is required' }, { status: 400 });
  }

  try {
    return NextResponse.json({
      ok: true,
      batches: listUndoableMemoryArchiveBatches(getDb(), characterId),
    });
  } catch (error) {
    return NextResponse.json(
      // DB / 意外异常收口：SqliteError message 含 SQL 与库文件路径
      { error: 'Failed to list memory archive batches', detail: publicErrorMessage(error, 'internal error') },
      { status: 500 },
    );
  }
}

export async function POST(request: NextRequest) {
  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  if (!isObject(rawBody)) {
    return NextResponse.json({ error: 'Body must be a JSON object' }, { status: 400 });
  }

  const action = rawBody.action;
  if (action !== 'preview' && action !== 'execute' && action !== 'undo' && action !== 'ai_archive' && action !== 'batch_details' && action !== 'cleanup_orphaned') {
    return NextResponse.json({ error: 'action must be preview, execute, undo, ai_archive, batch_details, or cleanup_orphaned' }, { status: 400 });
  }

  const characterId = readNonEmptyString(rawBody, 'character_id');
  if (!characterId) {
    return NextResponse.json({ error: 'character_id is required' }, { status: 400 });
  }

  const requestedBatchId = readNonEmptyString(rawBody, 'batch_id');
  const batchId = requestedBatchId ?? crypto.randomUUID();
  const now = new Date().toISOString();

  if (action === 'batch_details') {
    if (!requestedBatchId) {
      return NextResponse.json({ error: 'batch_id is required for batch_details' }, { status: 400 });
    }
    const db = getDb();
    // 查该批次下的 covered 记忆 + summary 记忆
    const covered = db.prepare(`
      SELECT id, category, content, status
      FROM memories
      WHERE character_id = ? AND json_extract(metadata, '$.archiveBatchId') = ?
        AND json_extract(metadata, '$.summarizedBy') IS NOT NULL
      ORDER BY updated_at DESC
    `).all(characterId, requestedBatchId) as Array<{ id: string; category: string; content: string; status: string }>;

    const summary = db.prepare(`
      SELECT id, content FROM memories
      WHERE character_id = ? AND json_extract(metadata, '$.archiveBatchId') = ?
        AND json_extract(metadata, '$.archiveRole') = 'summary'
      LIMIT 1
    `).get(characterId, requestedBatchId) as { id: string; content: string } | undefined;

    return NextResponse.json({
      ok: true,
      batch_id: requestedBatchId,
      covered: covered.map(m => ({ id: m.id, category: m.category, content: m.content, status: m.status })),
      summary: summary ?? null,
    });
  }

  if (action === 'cleanup_orphaned') {
    const db = getDb();
    // 清理被 undo 后残留的 archived summary：它们的 covered 记忆已被还原
    // 但 summary 本身还被标记为 archived（旧版 undo 逻辑的遗留）。
    const orphans = db.prepare(`
      SELECT id FROM memories
      WHERE character_id = ?
        AND json_extract(metadata, '$.archiveRole') = 'summary'
        AND status = 'archived'
    `).all(characterId) as Array<{ id: string }>;

    if (orphans.length === 0) {
      return NextResponse.json({ ok: true, cleaned: 0, message: '没有残留的归档摘要' });
    }

    const deleteStmt = db.prepare('DELETE FROM memories WHERE character_id = ? AND id = ?');
    const deleted = db.transaction(() => {
      let count = 0;
      for (const row of orphans) {
        deleteStmt.run(characterId, row.id);
        count++;
      }
      return count;
    })();

    return NextResponse.json({ ok: true, cleaned: deleted });
  }

  if (action === 'undo') {
    if (!requestedBatchId) {
      return NextResponse.json({ error: 'batch_id is required for undo' }, { status: 400 });
    }
    const result = undoMemorySummaryArchiveBatch(getDb(), { batchId, characterId, now });
    return NextResponse.json({ ok: true, result });
  }

  // ── AI 归档：LLM 挑选记忆、按主题分组并生成摘要 ─────────────────────
  // 只返回方案、不落库：归档会让记忆退出聊天，必须由用户确认后再逐组走 execute。
  if (action === 'ai_archive') {
    const db = getDb();
    // 读取角色所有 active 非 summary 非 pinned 的记忆
    const memories = db.prepare(`
      SELECT id, category, content, importance, emotional_weight, pinned, memory_kind, created_at
      FROM memories
      WHERE character_id = ? AND status = 'active' AND pinned = 0
        AND json_extract(metadata, '$.archiveRole') IS NULL
      ORDER BY importance ASC, updated_at ASC
    `).all(characterId) as Array<{
      id: string; category: string; content: string;
      importance: number; emotional_weight: number; memory_kind: string; created_at: string;
    }>;

    if (memories.length === 0) {
      return NextResponse.json({ ok: false, error: 'no_archivable_memories' }, { status: 400 });
    }

    // 拼接记忆列表给 LLM；带上日期，否则模型无从判断哪些记忆"陈旧"。
    const memoriesText = memories.map((m, i) =>
      `[${i + 1}] ID:${m.id} | 日期:${m.created_at.slice(0, 10)} | 分类:${m.category} | 种类:${m.memory_kind} | 重要度:${m.importance.toFixed(2)} | 情绪:${m.emotional_weight.toFixed(2)}\n${m.content}`
    ).join('\n\n');

    const prompt = AI_ARCHIVE_PROMPT
      .replace('{today}', () => now.slice(0, 10))
      .replace('{memories}', () => memoriesText);

    // 调用 LLM
    const settings = loadSettings();
    const taskTarget = { character: loadCharacterTaskModels(db, characterId), kind: 'background' as const };
    const bgConfig = resolveBackgroundConfig(settings, taskTarget);
    const llmSettings = mergeSettingsForBackgroundLlm(settings, bgConfig, {
      json_mode: true,
      streaming: false,
      max_tokens: Math.max(settings.max_tokens || 0, REASONING_SAFE_MAX_TOKENS * 2),
    });

    if (!llmSettings.api_base.trim() || !llmSettings.model.trim()) {
      return NextResponse.json({ ok: false, error: 'LLM provider is not configured' }, { status: 400 });
    }
    const backgroundExtraBody = buildBackgroundChatExtraBody(llmSettings.model, taskTarget);

    let response: string;
    try {
      const messages = applyBackgroundSystemPrompt(
        [{ role: 'user', content: prompt }],
        resolveCharacterTaskSystemPrompt(taskTarget, llmSettings.model),
      );
      response = await runWithBackgroundLlmDeadline(
        settings.memory_background_timeout_ms,
        signal => chatCompletion(llmSettings, messages, signal, backgroundExtraBody),
        request.signal,
      );
    } catch (err) {
      if (err instanceof BackgroundLlmTimeoutError) {
        return NextResponse.json(
          { ok: false, error: 'AI 归档请求超过服务器处理时限', code: 'UPSTREAM_TIMEOUT' },
          { status: 504 },
        );
      }
      return NextResponse.json(
        // 上游 LLM 错误（chatCompletion 抛出前已脱敏）透传；DB / 意外异常收口
        { ok: false, error: `LLM call failed: ${publicErrorMessage(err, '上游调用失败')}` },
        { status: 500 },
      );
    }

    // 解析 LLM 响应
    let parsed: Record<string, unknown>;
    try {
      let text = response.trim();
      if (text.startsWith('```')) text = text.split('\n').slice(1).join('\n');
      if (text.endsWith('```')) text = text.slice(0, text.lastIndexOf('```'));

      let value: unknown;
      try {
        value = JSON.parse(text);
      } catch (error) {
        if (!(error instanceof SyntaxError)) throw error;
        const snippet = findFirstBalancedJson(text, 'object');
        if (!snippet) throw new Error('No JSON object found');
        value = JSON.parse(snippet);
      }
      if (!isObject(value)) throw new Error('AI archive response must be a JSON object');
      parsed = value;
    } catch {
      return NextResponse.json(
        { ok: false, error: 'Failed to parse AI archive response', raw_response: response.slice(0, 500) },
        { status: 500 },
      );
    }

    // 校验每个分组：ID 必须是本次送审的 active 记忆；一条记忆只归入一个分组（先到先得），
    // 否则前一组归档后，后一组执行时会因源记忆已非 active 而失败。
    const memoryById = new Map(memories.map(m => [m.id, m]));
    const claimedIds = new Set<string>();
    const groups: AiArchiveProposalGroup[] = [];
    for (const group of readAiArchiveGroups(parsed)) {
      const ids = [...new Set(group.memoryIds)].filter(id => memoryById.has(id) && !claimedIds.has(id));
      // 只剩一条的分组没有可合并的内容，归档它只会把原记忆换成一条分类/重要度被抹平的摘要。
      if (ids.length < 2 || !group.summary) continue;
      for (const id of ids) claimedIds.add(id);
      groups.push({
        title: group.title,
        summary: group.summary,
        memories: ids.map(id => {
          const memory = memoryById.get(id)!;
          return { id: memory.id, category: memory.category, content: memory.content };
        }),
      });
    }

    return NextResponse.json({
      ok: true,
      status: groups.length > 0 ? 'proposed' : 'no_archive_needed',
      candidate_count: memories.length,
      groups,
    });
  }

  const coveredMemoryIds = readStringIds(rawBody, 'covered_memory_ids');
  if (!coveredMemoryIds) {
    return NextResponse.json({ error: 'covered_memory_ids must be a non-empty string array' }, { status: 400 });
  }
  if (coveredMemoryIds.length > 500) {
    return NextResponse.json({ error: 'Too many covered_memory_ids (max 500)' }, { status: 400 });
  }

  const summaryContent = readNonEmptyString(rawBody, 'summary_content');
  if (!summaryContent) {
    return NextResponse.json({ error: 'summary_content is required' }, { status: 400 });
  }
  if (summaryContent.length > MAX_SUMMARY_CONTENT_LENGTH) {
    return NextResponse.json({ error: 'summary_content is too long' }, { status: 400 });
  }

  const sourceMemories = loadCoveredMemories(characterId, coveredMemoryIds);
  if (!sourceMemories) {
    return NextResponse.json(
      { error: 'Some covered memories were not found', code: COVERED_NOT_ARCHIVABLE_CODE },
      { status: 404 },
    );
  }

  // 提前拒绝非 active / 已是 summary / 已归档的记忆,给用户明确的 400 反馈;
  // executeMemorySummaryArchive 内部还会在事务里再校验一次,兜住 preview→execute 之间的状态变化。
  const invalidCovered = sourceMemories.find(
    memory => memory.status !== 'active'
      || memory.metadata?.archiveRole === 'summary'
      || Boolean(memory.metadata?.archiveBatchId),
  );
  if (invalidCovered) {
    return NextResponse.json(
      { error: 'covered_memory_ids must reference active, non-summary memories', code: COVERED_NOT_ARCHIVABLE_CODE },
      { status: 400 },
    );
  }

  const summaryMemoryId = readNonEmptyString(rawBody, 'summary_memory_id') ?? crypto.randomUUID().slice(0, 12);

  if (action === 'preview') {
    const plan = planMemorySummaryArchive({
      batchId,
      characterId,
      summaryMemoryId,
      summaryContent,
      sourceMemories,
      now,
    });
    return NextResponse.json({ ok: true, plan });
  }

  const plan = executeMemorySummaryArchive(getDb(), {
    batchId,
    characterId,
    summaryMemoryId,
    summaryContent,
    coveredMemoryIds,
    now,
  });
  const indexing = queueArchiveSummaryIndex(plan.summaryMemory.id, characterId);
  return NextResponse.json({ ok: true, plan, ...indexing });
}
