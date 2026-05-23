import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { normalizeMemoryCategory } from '@/lib/memory-category';

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const body = await request.json() as {
    category?: string;
    content?: string;
    confidence?: number;
    tags?: string[];
  };
  const db = getDb();

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
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const db = getDb();
  const result = db.prepare('DELETE FROM memories WHERE id = ?').run(id);
  if (result.changes === 0) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  return NextResponse.json({ ok: true });
}
