import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import {
  executeMemorySummaryArchive,
  listUndoableMemoryArchiveBatches,
  planMemorySummaryArchive,
  undoMemorySummaryArchiveBatch,
  type MemoryArchiveSourceMemory,
} from '@/lib/memory-archive';
import { buildBackgroundChatExtraBody, loadSettings, resolveBackgroundConfig } from '@/lib/settings';
import { chatCompletion, REASONING_SAFE_MAX_TOKENS } from '@/lib/api-client';
import { enqueueMemoryEmbeddingTask } from '@/lib/memory-embeddings';
import { triggerMemoryIndexProcessing } from '@/lib/memory-index-trigger';
import { AI_ARCHIVE_PROMPT } from '@/lib/prompt-templates';
import type { MemoryCategory, MemoryKind, MemoryStatus } from '@/types';

const MAX_SUMMARY_CONTENT_LENGTH = 8 * 1024;

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
      { error: 'Failed to list memory archive batches', detail: error instanceof Error ? error.message : String(error) },
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

  // ── AI 归档：LLM 自动选择记忆并生成摘要 ─────────────────────────
  if (action === 'ai_archive') {
    const db = getDb();
    // 读取角色所有 active 非 summary 非 pinned 的记忆
    const memories = db.prepare(`
      SELECT id, category, content, importance, emotional_weight, pinned, memory_kind
      FROM memories
      WHERE character_id = ? AND status = 'active' AND pinned = 0
        AND json_extract(metadata, '$.archiveRole') IS NULL
      ORDER BY importance ASC, updated_at ASC
    `).all(characterId) as Array<{
      id: string; category: string; content: string;
      importance: number; emotional_weight: number; memory_kind: string;
    }>;

    if (memories.length === 0) {
      return NextResponse.json({ ok: false, error: 'no_archivable_memories' }, { status: 400 });
    }

    // 拼接记忆列表给 LLM
    const memoriesText = memories.map((m, i) =>
      `[${i + 1}] ID:${m.id} | 分类:${m.category} | 种类:${m.memory_kind} | 重要度:${m.importance.toFixed(2)} | 情绪:${m.emotional_weight.toFixed(2)}\n${m.content}`
    ).join('\n\n');

    const prompt = AI_ARCHIVE_PROMPT.replace('{memories}', () => memoriesText);

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
      // AI 归档需审阅全量记忆，prompt 较长，推理模型思考阶段消耗更大
      max_tokens: Math.max(settings.max_tokens || 0, REASONING_SAFE_MAX_TOKENS * 2),
    };

    if (!llmSettings.api_base.trim() || !llmSettings.model.trim()) {
      return NextResponse.json({ ok: false, error: 'LLM provider is not configured' }, { status: 400 });
    }
    const backgroundExtraBody = buildBackgroundChatExtraBody(settings, llmSettings.model);

    let response: string;
    try {
      response = await chatCompletion(llmSettings, [{ role: 'user', content: prompt }], request.signal, backgroundExtraBody);
    } catch (err) {
      return NextResponse.json(
        { ok: false, error: `LLM call failed: ${err instanceof Error ? err.message : String(err)}` },
        { status: 500 },
      );
    }

    // 解析 LLM 响应
    let parsed: { archive_memory_ids?: string[]; summary?: string };
    try {
      let text = response.trim();
      if (text.startsWith('```')) text = text.split('\n').slice(1).join('\n');
      if (text.endsWith('```')) text = text.slice(0, text.lastIndexOf('```'));
      const jsonStart = text.indexOf('{');
      const jsonEnd = text.lastIndexOf('}');
      if (jsonStart === -1 || jsonEnd === -1) throw new Error('No JSON object found');
      parsed = JSON.parse(text.slice(jsonStart, jsonEnd + 1));
    } catch {
      return NextResponse.json(
        { ok: false, error: 'Failed to parse AI archive response', raw_response: response.slice(0, 500) },
        { status: 500 },
      );
    }

    const archiveIds = Array.isArray(parsed.archive_memory_ids)
      ? parsed.archive_memory_ids.filter((id): id is string => typeof id === 'string')
      : [];
    const summary = typeof parsed.summary === 'string' ? parsed.summary.trim() : '';

    if (archiveIds.length === 0 || !summary) {
      return NextResponse.json({
        ok: true,
        status: 'no_archive_needed',
        archive_count: 0,
        summary: '',
        message: 'AI 判断当前无需归档的记忆',
      });
    }

    // 校验 ID 合法性：必须在角色的 active 记忆中
    const validIds = new Set(memories.map(m => m.id));
    const filteredIds = [...new Set(archiveIds.filter(id => validIds.has(id)))];

    if (filteredIds.length === 0) {
      return NextResponse.json({
        ok: true,
        status: 'no_archive_needed',
        archive_count: 0,
        summary: '',
        message: 'AI 返回的记忆 ID 无效',
      });
    }

    // 执行归档
    const aiBatchId = crypto.randomUUID();
    const summaryMemoryId = crypto.randomUUID().slice(0, 12);
    try {
      const plan = executeMemorySummaryArchive(db, {
        batchId: aiBatchId,
        characterId,
        summaryMemoryId,
        summaryContent: summary,
        coveredMemoryIds: filteredIds,
        now,
      });
      const indexing = queueArchiveSummaryIndex(plan.summaryMemory.id, characterId);
      return NextResponse.json({
        ok: true,
        status: 'archived',
        archive_count: filteredIds.length,
        summary,
        batch_id: aiBatchId,
        plan,
        ...indexing,
      });
    } catch (err) {
      return NextResponse.json(
        { ok: false, error: `Archive execution failed: ${err instanceof Error ? err.message : String(err)}` },
        { status: 500 },
      );
    }
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
    return NextResponse.json({ error: 'Some covered memories were not found' }, { status: 404 });
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
      { error: 'covered_memory_ids must reference active, non-summary memories' },
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
