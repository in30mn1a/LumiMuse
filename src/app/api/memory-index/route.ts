import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import {
  clearMemoryIndex,
  ensureMemoryEmbeddingTables,
  enqueueRebuildMemoryEmbeddings,
  enqueueUnindexedMemoryEmbeddings,
  getMemoryIndexStatus,
  retryFailedMemoryEmbeddings,
  stopCurrentMemoryIndexTasks,
} from '@/lib/memory-embeddings';
import {
  getMemoryIndexProcessingBlockedReason,
  stopMemoryIndexProcessing,
  triggerMemoryIndexProcessing,
  type MemoryIndexProcessingBlockedReason,
} from '@/lib/memory-index-trigger';
import { loadSettings } from '@/lib/settings';
import type { MemoryEmbeddingTarget, MemoryIndexStatus } from '@/lib/memory-embeddings';

type IndexStatusResponse = MemoryIndexStatus & {
  ok: boolean;
  indexed: number;
  queued: number;
  character_id: string | null;
  error?: string;
  processing_blocked_reason?: MemoryIndexProcessingBlockedReason;
};

function toStatusResponse(status: MemoryIndexStatus, characterId: string | null): IndexStatusResponse {
  const response: IndexStatusResponse = {
    ok: true,
    character_id: characterId,
    total: status.total,
    indexed: status.ready,
    ready: status.ready,
    pending: status.pending,
    queued: status.pending,
    processing: status.processing,
    failed: status.failed,
    latest_error: status.latest_error,
  };
  if (status.pending > 0 && status.processing === 0) {
    const blockedReason = getMemoryIndexProcessingBlockedReason();
    if (blockedReason) response.processing_blocked_reason = blockedReason;
  }
  return response;
}

function emptyStatusResponse(characterId: string | null, error: string): IndexStatusResponse {
  return {
    ok: false,
    character_id: characterId,
    total: 0,
    indexed: 0,
    ready: 0,
    pending: 0,
    queued: 0,
    processing: 0,
    failed: 0,
    error,
  };
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isMissingTableError(error: unknown): boolean {
  return /no such table/i.test(getErrorMessage(error));
}

function getCharacterIdsForRebuild(db: ReturnType<typeof getDb>): string[] {
  const rows = db.prepare(`
    SELECT DISTINCT character_id
    FROM memories
    WHERE character_id IS NOT NULL AND character_id != ''
  `).all() as Array<{ character_id: string }>;

  return rows.map(row => row.character_id);
}

function getCurrentEmbeddingTarget(): MemoryEmbeddingTarget {
  const engine = loadSettings().memory_engine;
  return {
    provider: 'openai-compatible',
    model: engine.embedding_model,
    dimension: engine.embedding_dimension,
  };
}

function withProcessingBlockedReason<T extends { queued: number; processing_started: boolean }>(payload: T): T & {
  processing_blocked_reason?: string;
} {
  if (payload.queued <= 0 || payload.processing_started) return payload;

  const blockedReason = getMemoryIndexProcessingBlockedReason();
  if (!blockedReason) return payload;
  return { ...payload, processing_blocked_reason: blockedReason };
}

export async function GET(request: NextRequest) {
  const characterId = request.nextUrl.searchParams.get('character_id')?.trim() || undefined;

  try {
    const db = getDb();
    ensureMemoryEmbeddingTables(db);
    const status = getMemoryIndexStatus(characterId, db, getCurrentEmbeddingTarget());
    return NextResponse.json(toStatusResponse(status, characterId || null));
  } catch (error) {
    if (isMissingTableError(error)) {
      return NextResponse.json(
        emptyStatusResponse(characterId || null, 'memory index tables are not ready'),
      );
    }

    return NextResponse.json(
      { error: 'Failed to read memory index status', detail: getErrorMessage(error) },
      { status: 500 },
    );
  }
}

export async function POST(request: NextRequest) {
  const rawQueryCharacterId = request.nextUrl.searchParams.get('character_id');
  const queryCharacterId = rawQueryCharacterId?.trim();
  const rawBody = await request.json().catch(() => ({}));
  const body = rawBody && typeof rawBody === 'object' && !Array.isArray(rawBody)
    ? rawBody as { action?: unknown; character_id?: unknown }
    : {};
  const rawAction = body.action === undefined ? 'rebuild' : body.action;
  const rawBodyCharacterId = typeof body.character_id === 'string' ? body.character_id : undefined;
  const bodyCharacterId = rawBodyCharacterId?.trim();
  const characterId = bodyCharacterId || queryCharacterId || undefined;

  if (typeof rawAction !== 'string') {
    return NextResponse.json({ error: 'action must be a string' }, { status: 400 });
  }
  const action = rawAction.trim() || 'rebuild';
  if (!['rebuild', 'retry_failed', 'clear_index', 'stop_current', 'index_unindexed'].includes(action)) {
    return NextResponse.json({ error: 'unsupported memory index action' }, { status: 400 });
  }
  if (body.character_id !== undefined && typeof body.character_id !== 'string') {
    return NextResponse.json({ error: 'character_id must be a string' }, { status: 400 });
  }
  if (rawBodyCharacterId?.trim() === '' || rawQueryCharacterId?.trim() === '') {
    return NextResponse.json({ error: 'character_id must not be empty' }, { status: 400 });
  }

  try {
    const db = getDb();
    ensureMemoryEmbeddingTables(db);

    if (action === 'clear_index') {
      stopMemoryIndexProcessing();
      const result = clearMemoryIndex(characterId, db);
      return NextResponse.json({
        ok: true,
        action,
        character_id: characterId || null,
        ...result,
      });
    }

    if (action === 'stop_current') {
      stopMemoryIndexProcessing();
      const result = stopCurrentMemoryIndexTasks(characterId, db);
      return NextResponse.json({
        ok: true,
        action,
        character_id: characterId || null,
        processing_started: false,
        ...result,
      });
    }

    if (action === 'retry_failed') {
      const queued = retryFailedMemoryEmbeddings(characterId, db, getCurrentEmbeddingTarget());
      const processing_started = queued > 0 ? triggerMemoryIndexProcessing() : false;
      return NextResponse.json(withProcessingBlockedReason({
        ok: true,
        queued,
        character_id: characterId || null,
        processing_started,
        action,
      }));
    }

    if (action === 'index_unindexed') {
      const engine = loadSettings().memory_engine;
      const model = engine.embedding_model.trim();
      if (!model) {
        return NextResponse.json(
          { ok: false, queued: 0, error: 'embedding model is required' },
          { status: 400 },
        );
      }
      const queued = enqueueUnindexedMemoryEmbeddings(characterId, {
        provider: 'openai-compatible',
        model,
        dimension: engine.embedding_dimension,
        db,
      });
      const processing_started = queued > 0 ? triggerMemoryIndexProcessing() : false;
      return NextResponse.json(withProcessingBlockedReason({
        ok: true,
        queued,
        character_id: characterId || null,
        processing_started,
        action,
      }));
    }

    if (characterId) {
      const queued = enqueueRebuildMemoryEmbeddings(characterId, db);
      const processing_started = triggerMemoryIndexProcessing();
      return NextResponse.json(withProcessingBlockedReason({
        ok: true,
        queued,
        character_id: characterId,
        processing_started,
      }));
    }

    let queued = 0;
    for (const id of getCharacterIdsForRebuild(db)) {
      queued += enqueueRebuildMemoryEmbeddings(id, db);
    }

    const processing_started = triggerMemoryIndexProcessing();
    return NextResponse.json(withProcessingBlockedReason({
      ok: true,
      queued,
      character_id: null,
      processing_started,
    }));
  } catch (error) {
    if (isMissingTableError(error)) {
      return NextResponse.json(
        { ok: false, queued: 0, error: 'memory tables are not ready' },
        { status: 503 },
      );
    }

    return NextResponse.json(
      { ok: false, queued: 0, error: 'Failed to queue memory index rebuild', detail: getErrorMessage(error) },
      { status: 500 },
    );
  }
}
