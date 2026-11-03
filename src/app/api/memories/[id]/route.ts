import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { Memory } from '@/types';
import { normalizeMemoryRow } from '@/lib/memory-normalization';
import { memoryUpdateSchema, formatZodFieldErrors } from '@/lib/schemas';
import { applyMemoryUpdate } from '@/lib/memory-mutations';

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
  // 先校验归属：若请求方声明了 character_id，必须匹配 DB 中的归属
  const existing = db.prepare('SELECT character_id FROM memories WHERE id = ?').get(id) as
    | { character_id: string }
    | undefined;
  if (!existing) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const claimed = pickClaimedCharacterId(request, body);
  if (claimed !== null && claimed !== existing.character_id) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const result = applyMemoryUpdate(db, id, body, new Date().toISOString());
  if (result === 'not_found') return NextResponse.json({ error: 'Not found' }, { status: 404 });
  if (result === 'no_fields') return NextResponse.json({ error: 'No fields to update' }, { status: 400 });

  const updated = db.prepare('SELECT * FROM memories WHERE id = ?').get(id) as Memory;
  return NextResponse.json(normalizeMemoryRow(updated));
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
