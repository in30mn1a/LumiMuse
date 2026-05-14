import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const db = getDb();
  const conversation = db.prepare('SELECT * FROM conversations WHERE id = ?').get(id);
  if (!conversation) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  return NextResponse.json(conversation);
}

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const db = getDb();
  const result = db.prepare('DELETE FROM conversations WHERE id = ?').run(id);
  if (result.changes === 0) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  return NextResponse.json({ ok: true });
}


export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const db = getDb();
  const body = await request.json();
  const updates: string[] = [];
  const values: unknown[] = [];

  if (body.title !== undefined) {
    updates.push("title = ?");
    values.push(body.title);
  }

  if (body.ignore_memory !== undefined) {
    updates.push("ignore_memory = ?");
    values.push(body.ignore_memory ? 1 : 0);
  }

  if (updates.length === 0) {
    return NextResponse.json({ error: "No fields to update" }, { status: 400 });
  }

  updates.push("updated_at = datetime('now')");
  values.push(id);
  db.prepare(`UPDATE conversations SET ${updates.join(", ")} WHERE id = ?`).run(...values);

  const updated = db.prepare("SELECT * FROM conversations WHERE id = ?").get(id);
  return NextResponse.json(updated);
}
