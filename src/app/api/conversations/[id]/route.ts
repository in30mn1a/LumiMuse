import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { collectConversationLocalAssetUrls, collectAllLocalAssetUrls, deleteLocalAssetUrls } from '@/lib/character-file-utils';
import { conversationUpdateSchema, formatZodFieldErrors } from '@/lib/schemas';

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
  const fileUrls = collectConversationLocalAssetUrls(db, id);

  // 用事务包裹三条 DELETE，避免中途失败留下不一致状态
  const changes = db.transaction(() => {
    const result = db.prepare('DELETE FROM conversations WHERE id = ?').run(id);
    if (result.changes === 0) return 0;
    db.prepare('DELETE FROM messages WHERE conversation_id = ?').run(id);
    db.prepare('DELETE FROM memory_tasks WHERE conversation_id = ?').run(id);
    return result.changes;
  })();
  if (changes === 0) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  // 清理该对话独有的本地文件
  const remainingUrls = collectAllLocalAssetUrls(db);
  const orphanUrls = [...fileUrls].filter(url => !remainingUrls.has(url));
  await deleteLocalAssetUrls(orphanUrls);

  return NextResponse.json({ ok: true });
}


export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const db = getDb();
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  const parsed = conversationUpdateSchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Invalid request body', fieldErrors: formatZodFieldErrors(parsed.error) },
      { status: 400 },
    );
  }
  const body = parsed.data;
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
