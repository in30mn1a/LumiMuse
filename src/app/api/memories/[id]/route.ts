import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { normalizeMemoryCategory } from '@/lib/memory-category';

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
  const body = await request.json() as {
    character_id?: string;
    category?: string;
    content?: string;
    confidence?: number;
    tags?: string[];
  };
  const db = getDb();

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
  fields.push('updated_at = ?'); values.push(now);

  if (fields.length === 1) return NextResponse.json({ error: 'No fields to update' }, { status: 400 });

  values.push(id);
  db.prepare(`UPDATE memories SET ${fields.join(', ')} WHERE id = ?`).run(...values);

  const updated = db.prepare('SELECT * FROM memories WHERE id = ?').get(id) as Record<string, unknown>;
  if (typeof updated.tags === 'string') updated.tags = JSON.parse(updated.tags as string);
  if (typeof updated.source_msg_ids === 'string') updated.source_msg_ids = JSON.parse(updated.source_msg_ids as string);
  if (typeof updated.category === 'string') updated.category = normalizeMemoryCategory(updated.category as string);
  return NextResponse.json(updated);
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const db = getDb();

  // 先校验归属：若 query param 声明了 character_id，必须匹配 DB 中的归属
  const existing = db.prepare('SELECT character_id FROM memories WHERE id = ?').get(id) as
    | { character_id: string }
    | undefined;
  if (!existing) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const claimed = pickClaimedCharacterId(request);
  if (claimed !== null && claimed !== existing.character_id) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const result = db.prepare('DELETE FROM memories WHERE id = ?').run(id);
  if (result.changes === 0) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  return NextResponse.json({ ok: true });
}
