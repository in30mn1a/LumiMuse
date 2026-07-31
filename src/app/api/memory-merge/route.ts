import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import {
  executeMemoryMerge,
  listUndoableMemoryMergeBatches,
  undoMemoryMergeBatch,
} from '@/lib/memory-merge';
import { enqueueMemoryEmbeddingTask } from '@/lib/memory-embeddings';
import { triggerMemoryIndexProcessing } from '@/lib/memory-index-trigger';
import { MAX_MEMORY_CONTENT } from '@/lib/schemas';

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function readNonEmptyString(body: Record<string, unknown>, key: string): string | null {
  const value = body[key];
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
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
  if (action !== 'execute' && action !== 'undo' && action !== 'list') {
    return NextResponse.json({ error: 'action must be execute, undo, or list' }, { status: 400 });
  }

  const characterId = readNonEmptyString(rawBody, 'character_id');
  if (!characterId) {
    return NextResponse.json({ error: 'character_id is required' }, { status: 400 });
  }

  const db = getDb();
  const now = new Date().toISOString();

  if (action === 'list') {
    const batches = listUndoableMemoryMergeBatches(db, characterId);
    return NextResponse.json({ ok: true, batches });
  }

  if (action === 'undo') {
    const batchId = readNonEmptyString(rawBody, 'batch_id');
    if (!batchId) {
      return NextResponse.json({ error: 'batch_id is required for undo' }, { status: 400 });
    }
    try {
      const result = undoMemoryMergeBatch(db, { batchId, characterId, now });
      return NextResponse.json({ ok: true, ...result, batch_id: batchId });
    } catch (error) {
      return NextResponse.json(
        { ok: false, error: error instanceof Error ? error.message : String(error) },
        { status: 400 },
      );
    }
  }

  // execute
  const sourceIdsRaw = rawBody.source_ids;
  const sourceIds = Array.isArray(sourceIdsRaw)
    ? sourceIdsRaw.filter((id): id is string => typeof id === 'string' && id.trim().length > 0).map(id => id.trim())
    : [];
  if (sourceIds.length < 2) {
    return NextResponse.json({ error: 'source_ids must contain at least 2 ids' }, { status: 400 });
  }

  const mergedContent = typeof rawBody.merged_content === 'string' ? rawBody.merged_content.trim() : '';
  if (!mergedContent) {
    return NextResponse.json({ error: 'merged_content is required' }, { status: 400 });
  }
  if (mergedContent.length > MAX_MEMORY_CONTENT) {
    return NextResponse.json(
      { error: `merged_content exceeds MAX_MEMORY_CONTENT (${MAX_MEMORY_CONTENT})` },
      { status: 400 },
    );
  }

  const kind = rawBody.kind;
  if (kind === 'conflict') {
    return NextResponse.json({ error: 'conflict suggestions cannot be executed' }, { status: 400 });
  }

  const batchId = readNonEmptyString(rawBody, 'batch_id') ?? crypto.randomUUID();
  const resultMemoryId = readNonEmptyString(rawBody, 'result_memory_id') ?? crypto.randomUUID();
  const tags = Array.isArray(rawBody.tags)
    ? rawBody.tags.map(tag => String(tag)).filter(Boolean)
    : undefined;
  const category = typeof rawBody.category === 'string' ? rawBody.category : undefined;
  const importance = typeof rawBody.importance === 'number' ? rawBody.importance : undefined;

  try {
    const executed = executeMemoryMerge(db, {
      batchId,
      characterId,
      resultMemoryId,
      sourceIds,
      mergedContent,
      category,
      tags,
      importance,
      now,
    });

    let indexingQueued = 0;
    try {
      if (enqueueMemoryEmbeddingTask(executed.resultMemoryId, characterId, 'created', db)) {
        indexingQueued += 1;
      }
    } catch (error) {
      console.error('Failed to enqueue embedding after memory merge', {
        memoryId: executed.resultMemoryId,
        characterId,
        error,
      });
    }
    const indexingStarted = indexingQueued > 0 ? triggerMemoryIndexProcessing() : false;

    return NextResponse.json({
      ok: true,
      batch_id: executed.batchId,
      // 同时给 snake_case 与 camelCase：memory-merge 的前期调用方与 undo 断言存在混用，
      // 前端本次新增 UI 也以 resultMemoryId 展示跳转目标。
      result_memory_id: executed.resultMemoryId,
      resultMemoryId: executed.resultMemoryId,
      source_ids: executed.sourceIds,
      content: executed.content,
      indexing_queued: indexingQueued,
      indexing_started: indexingStarted,
    });
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : String(error) },
      { status: 400 },
    );
  }
}
