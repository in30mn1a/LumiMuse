import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { Memory, MEMORY_KINDS, MEMORY_STATUSES, MemoryKind, MemoryStatus } from '@/types';
import { normalizeMemoryCategory, inferMemoryDefaults } from '@/lib/memory-category';
import { memoryUpdateSchema, formatZodFieldErrors } from '@/lib/schemas';
import { enqueueMemoryEmbeddingTask } from '@/lib/memory-embeddings';
import { triggerMemoryIndexProcessing } from '@/lib/memory-index-trigger';

function parseJsonArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === 'string');
  if (typeof value !== 'string') return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

function parseJsonObject(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value !== 'string') return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function toNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function normalizeMemoryKind(value: unknown, fallback: MemoryKind): MemoryKind {
  return typeof value === 'string' && (MEMORY_KINDS as readonly string[]).includes(value)
    ? value as MemoryKind
    : fallback;
}

function normalizeMemoryStatus(value: unknown): MemoryStatus {
  return typeof value === 'string' && (MEMORY_STATUSES as readonly string[]).includes(value)
    ? value as MemoryStatus
    : 'active';
}

function normalizeMemoryRecord(record: Record<string, unknown>): Memory {
  const category = normalizeMemoryCategory(String(record.category || '话题历史'));
  const defaults = inferMemoryDefaults(category);
  return {
    ...record,
    category,
    tags: parseJsonArray(record.tags),
    source_msg_ids: parseJsonArray(record.source_msg_ids),
    memory_kind: normalizeMemoryKind(record.memory_kind, defaults.memory_kind),
    importance: toNumber(record.importance, defaults.importance),
    emotional_weight: toNumber(record.emotional_weight, defaults.emotional_weight),
    status: normalizeMemoryStatus(record.status),
    pinned: record.pinned === true || record.pinned === 1,
    last_used_at: typeof record.last_used_at === 'string' ? record.last_used_at : null,
    usage_count: toNumber(record.usage_count, 0),
    metadata: parseJsonObject(record.metadata),
  } as Memory;
}

/**
 * 取出请求方可能声明的 character_id 归属（query param 或 body field），
 * 用于在 PUT/DELETE 时与 DB 记录交叉校验，避免误操作其它角色的记忆。
 */
function pickClaimedCharacterId(
  request: NextRequest,
  body?: Record<string, unknown> | null,
): string | null {
  const fromQuery = request.nextUrl.searchParams.get('character_id');
  if (typeof fromQuery === 'string' && fromQuery.length > 0) return fromQuery;
  if (body && typeof body.character_id === 'string' && body.character_id.length > 0) {
    return body.character_id;
  }
  return null;
}

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  const parsed = memoryUpdateSchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Invalid request body', fieldErrors: formatZodFieldErrors(parsed.error) },
      { status: 400 },
    );
  }
  const body = parsed.data;
  const db = getDb();
  const shouldEnqueueEmbeddingUpdate =
    body.category !== undefined ||
    body.content !== undefined ||
    body.tags !== undefined ||
    body.memory_kind !== undefined ||
    body.importance !== undefined ||
    body.emotional_weight !== undefined ||
    body.status !== undefined ||
    body.pinned !== undefined;

  // 先校验归属：若请求方声明了 character_id，必须匹配 DB 中的归属
  const existing = db.prepare('SELECT character_id FROM memories WHERE id = ?').get(id) as
    | { character_id: string }
    | undefined;
  if (!existing) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const claimed = pickClaimedCharacterId(request, body);
  if (claimed !== null && claimed !== existing.character_id) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const now = new Date().toISOString();
  const fields: string[] = [];
  const values: unknown[] = [];

  if (body.category !== undefined) { fields.push('category = ?'); values.push(normalizeMemoryCategory(body.category)); }
  if (body.content !== undefined) { fields.push('content = ?'); values.push(body.content); }
  if (body.confidence !== undefined) { fields.push('confidence = ?'); values.push(body.confidence); }
  if (body.tags !== undefined) { fields.push('tags = ?'); values.push(JSON.stringify(body.tags)); }
  if (body.memory_kind !== undefined) { fields.push('memory_kind = ?'); values.push(body.memory_kind); }
  if (body.importance !== undefined) { fields.push('importance = ?'); values.push(body.importance); }
  if (body.emotional_weight !== undefined) { fields.push('emotional_weight = ?'); values.push(body.emotional_weight); }
  if (body.status !== undefined) { fields.push('status = ?'); values.push(body.status); }
  if (body.pinned !== undefined) { fields.push('pinned = ?'); values.push(body.pinned ? 1 : 0); }
  if (body.last_used_at !== undefined) { fields.push('last_used_at = ?'); values.push(body.last_used_at); }
  if (body.usage_count !== undefined) { fields.push('usage_count = ?'); values.push(body.usage_count); }
  if (body.metadata !== undefined) { fields.push('metadata = ?'); values.push(JSON.stringify(body.metadata)); }
  fields.push('updated_at = ?'); values.push(now);

  if (fields.length === 1) return NextResponse.json({ error: 'No fields to update' }, { status: 400 });

  values.push(id);
  db.prepare(`UPDATE memories SET ${fields.join(', ')} WHERE id = ?`).run(...values);

  if (shouldEnqueueEmbeddingUpdate) {
    try {
      if (enqueueMemoryEmbeddingTask(id, existing.character_id, 'updated', db)) {
        triggerMemoryIndexProcessing();
      }
    } catch (error) {
      console.error('Failed to enqueue memory embedding task after memory update', {
        memoryId: id,
        characterId: existing.character_id,
        error,
      });
    }
  }

  const updated = db.prepare('SELECT * FROM memories WHERE id = ?').get(id) as Record<string, unknown>;
  return NextResponse.json(normalizeMemoryRecord(updated));
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const db = getDb();

  // 先校验归属：单条删除必须声明 character_id，且必须匹配 DB 中的归属
  const existing = db.prepare('SELECT character_id FROM memories WHERE id = ?').get(id) as
    | { character_id: string }
    | undefined;
  if (!existing) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  let body: Record<string, unknown> | null = null;
  if (!request.nextUrl.searchParams.get('character_id')) {
    try {
      const raw = await request.json();
      body = raw && typeof raw === 'object' && !Array.isArray(raw)
        ? raw as Record<string, unknown>
        : null;
    } catch {
      body = null;
    }
  }

  const claimed = pickClaimedCharacterId(request, body);
  if (claimed === null) {
    return NextResponse.json({ error: 'character_id is required' }, { status: 400 });
  }
  if (claimed !== null && claimed !== existing.character_id) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const protectedSummary = db.prepare(`
    SELECT id FROM memories
    WHERE id = ?
      AND status = 'active'
      AND json_extract(metadata, '$.archiveRole') = 'summary'
  `).get(id);
  if (protectedSummary) {
    return NextResponse.json(
      { error: 'Cannot delete an active archive summary; undo its archive batch first' },
      { status: 409 },
    );
  }

  const result = db.prepare('DELETE FROM memories WHERE id = ?').run(id);
  if (result.changes === 0) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  return NextResponse.json({ ok: true });
}
