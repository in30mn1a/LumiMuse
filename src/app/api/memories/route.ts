import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { Memory, MEMORY_STATUSES, MemoryStatus } from '@/types';
import { normalizeMemoryCategory, inferMemoryDefaults } from '@/lib/memory-category';
import { normalizeMemoryRow } from '@/lib/memory-normalization';
import { memoryCreateSchema, formatZodFieldErrors } from '@/lib/schemas';
import { enqueueMemoryEmbeddingTask } from '@/lib/memory-embeddings';
import { triggerMemoryIndexProcessing } from '@/lib/memory-index-trigger';

const MAX_PAGINATED_MEMORIES_LIMIT = 500;

function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, char => `\\${char}`);
}

function parseMemoryStatusFilter(value: string | null): MemoryStatus[] {
  if (!value) return [];
  return value
    .split(',')
    .map(status => status.trim())
    .filter((status): status is MemoryStatus => (MEMORY_STATUSES as readonly string[]).includes(status));
}

export async function GET(request: NextRequest) {
  const db = getDb();
  const characterId = request.nextUrl.searchParams.get('character_id');
  const category = request.nextUrl.searchParams.get('category');
  const keyword = request.nextUrl.searchParams.get('keyword');
  const tags = [...new Set(request.nextUrl.searchParams.getAll('tag').map(tag => tag.trim()).filter(Boolean))];
  const statusFilter = parseMemoryStatusFilter(request.nextUrl.searchParams.get('status'));
  const excludeArchiveSummary = request.nextUrl.searchParams.get('exclude_archive_summary') === '1';
  const limitParam = request.nextUrl.searchParams.get('limit');
  const offsetParam = request.nextUrl.searchParams.get('offset');
  const sort = request.nextUrl.searchParams.get('sort');
  const shouldPaginate = limitParam !== null || offsetParam !== null;
  const limit = Math.min(Math.max(Number(limitParam ?? 20) || 20, 1), MAX_PAGINATED_MEMORIES_LIMIT);
  const offset = Math.max(Number(offsetParam ?? 0) || 0, 0);

  let sql = 'SELECT * FROM memories WHERE 1=1';
  const params: unknown[] = [];

  if (characterId) {
    sql += ' AND character_id = ?';
    params.push(characterId);
  }
  if (keyword) {
    sql += " AND (content LIKE ? ESCAPE '\\' OR tags LIKE ? ESCAPE '\\')";
    const escapedKeyword = escapeLikePattern(keyword);
    params.push(`%${escapedKeyword}%`, `%${escapedKeyword}%`);
  }
  if (category) {
    sql += ' AND category = ?';
    params.push(normalizeMemoryCategory(category));
  }
  for (const tag of tags) {
    sql += ' AND EXISTS (SELECT 1 FROM json_each(memories.tags) WHERE json_each.value = ?)';
    params.push(tag);
  }
  if (statusFilter.length === 1) {
    sql += ' AND status = ?';
    params.push(statusFilter[0]);
  } else if (statusFilter.length > 1) {
    sql += ` AND status IN (${statusFilter.map(() => '?').join(',')})`;
    params.push(...statusFilter);
  }
  if (excludeArchiveSummary) {
    sql += ` AND COALESCE(json_extract(metadata, '$.archiveRole'), '') != 'summary'`;
  }
  // 默认隐藏已归档/已总结/已被取代的记忆，与后端注入逻辑（仅注入 active）对齐；
  // 若调用方明确指定状态过滤则不覆盖。
  const hideArchived = request.nextUrl.searchParams.get('hide_archived');
  if (hideArchived !== '0' && statusFilter.length === 0) {
    sql += " AND status NOT IN ('archived', 'summarized', 'superseded')";
  }

  const total = db.prepare(`SELECT COUNT(*) as count FROM (${sql})`).get(...params) as { count: number };

  sql += sort === 'oldest' ? ' ORDER BY created_at ASC, rowid ASC' : ' ORDER BY created_at DESC, rowid DESC';
  if (shouldPaginate) {
    sql += ' LIMIT ? OFFSET ?';
    params.push(limit, offset);
  }

  const memories = db.prepare(sql).all(...params) as Memory[];
  const normalized = memories.map(normalizeMemoryRow);

  if (shouldPaginate) {
    return NextResponse.json({
      memories: normalized,
      total: total.count,
      hasMore: offset + normalized.length < total.count,
    });
  }

  return NextResponse.json(normalized);
}

export async function DELETE(request: NextRequest) {
  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  if (!rawBody || typeof rawBody !== 'object' || Array.isArray(rawBody)) {
    return NextResponse.json({ error: 'Body must be a JSON object' }, { status: 400 });
  }

  const body = rawBody as { ids?: unknown; character_id?: unknown };

  const ids = body.ids;
  if (!Array.isArray(ids) || ids.length === 0) {
    return NextResponse.json({ error: 'ids must be a non-empty array' }, { status: 400 });
  }
  if (ids.length > 500) {
    return NextResponse.json({ error: 'Too many ids (max 500)' }, { status: 400 });
  }
  if (!ids.every(id => typeof id === 'string' && id.length > 0)) {
    return NextResponse.json({ error: 'Each id must be a non-empty string' }, { status: 400 });
  }
  if (body.character_id !== undefined && typeof body.character_id !== 'string') {
    return NextResponse.json({ error: 'character_id must be a string' }, { status: 400 });
  }

  // 归属校验：若请求声明了 character_id，确认所有待删记录都属于该角色
  const claimedCharId = request.nextUrl.searchParams.get('character_id') || body.character_id || null;
  if (claimedCharId) {
    const db = getDb();
    const placeholders = ids.map(() => '?').join(',');
    const rows = db.prepare(`SELECT DISTINCT character_id FROM memories WHERE id IN (${placeholders})`).all(...ids) as { character_id: string }[];
    if (rows.some(r => r.character_id !== claimedCharId)) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }
  }

  const db = getDb();
  const placeholders = ids.map(() => '?').join(',');

  // 拒绝直接删除仍活跃的归档 summary:否则其覆盖的归档记忆会变成孤儿,失去经摘要恢复的链路。
  // 需先在归档面板撤销该批次(撤销后 summary 变 archived 即可删除)。
  const activeSummaries = db.prepare(
    `SELECT id FROM memories WHERE id IN (${placeholders}) AND status = 'active' AND json_extract(metadata, '$.archiveRole') = 'summary'`,
  ).all(...ids) as { id: string }[];
  if (activeSummaries.length > 0) {
    return NextResponse.json(
      {
        error: 'Cannot delete an active archive summary; undo its archive batch first',
        summaryIds: activeSummaries.map(row => row.id),
      },
      { status: 409 },
    );
  }

  const result = db.prepare(`DELETE FROM memories WHERE id IN (${placeholders})`).run(...ids);
  return NextResponse.json({ ok: true, deleted: result.changes });
}

export async function POST(request: NextRequest) {
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  const parsed = memoryCreateSchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Invalid request body', fieldErrors: formatZodFieldErrors(parsed.error) },
      { status: 400 },
    );
  }
  const body = parsed.data;

  const db = getDb();
  const id = crypto.randomUUID().slice(0, 12);
  const now = new Date().toISOString();
  const category = normalizeMemoryCategory(body.category);
  const defaults = inferMemoryDefaults(category);

  db.prepare(`
    INSERT INTO memories (
      id, character_id, category, content, confidence, tags, source_msg_ids,
      memory_kind, importance, emotional_weight, status, pinned, last_used_at, usage_count, metadata,
      created_at, updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, '[]', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    body.character_id,
    category,
    body.content,
    body.confidence ?? 0.9,
    JSON.stringify(body.tags || []),
    body.memory_kind ?? defaults.memory_kind,
    body.importance ?? defaults.importance,
    body.emotional_weight ?? defaults.emotional_weight,
    body.status ?? 'active',
    body.pinned ? 1 : 0,
    body.last_used_at ?? null,
    body.usage_count ?? 0,
    JSON.stringify(body.metadata ?? {}),
    now,
    now,
  );

  try {
    if (enqueueMemoryEmbeddingTask(id, body.character_id, 'created', db)) {
      triggerMemoryIndexProcessing();
    }
  } catch (error) {
    console.error('Failed to enqueue memory embedding task after memory create', {
      memoryId: id,
      characterId: body.character_id,
      error,
    });
  }

  const memory = db.prepare('SELECT * FROM memories WHERE id = ?').get(id) as Memory;
  return NextResponse.json(normalizeMemoryRow(memory), { status: 201 });
}
