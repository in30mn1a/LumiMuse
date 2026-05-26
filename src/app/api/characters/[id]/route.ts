import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { Character } from '@/types';
import { collectAllLocalAssetUrls, collectCharacterLocalAssetUrls, deleteLocalAssetUrls } from '@/lib/character-file-utils';
import { characterUpdateSchema, formatZodFieldErrors } from '@/lib/schemas';

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const db = getDb();
  const character = db.prepare('SELECT * FROM characters WHERE id = ?').get(id);
  if (!character) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  return NextResponse.json(character);
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
  const parsed = characterUpdateSchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Invalid request body', fieldErrors: formatZodFieldErrors(parsed.error) },
      { status: 400 },
    );
  }
  const body = parsed.data;
  const db = getDb();

  const existing = db.prepare('SELECT * FROM characters WHERE id = ?').get(id) as Character | undefined;
  if (!existing) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const now = new Date().toISOString();
  db.prepare(`
    UPDATE characters SET
      name = ?, avatar_url = ?, basic_info = ?, personality = ?, scenario = ?,
      greeting = ?, example_dialogue = ?, system_prompt = ?, other_info = ?, image_tags = ?, updated_at = ?
    WHERE id = ?
  `).run(
    body.name ?? existing.name,
    body.avatar_url ?? existing.avatar_url,
    body.basic_info ?? existing.basic_info ?? '',
    body.personality ?? existing.personality,
    body.scenario ?? existing.scenario,
    body.greeting ?? existing.greeting,
    body.example_dialogue ?? existing.example_dialogue,
    body.system_prompt ?? existing.system_prompt,
    body.other_info ?? existing.other_info ?? '',
    body.image_tags ?? existing.image_tags ?? '',
    now,
    id,
  );

  const updated = db.prepare('SELECT * FROM characters WHERE id = ?').get(id);
  return NextResponse.json(updated);
}

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const db = getDb();
  const fileUrls = collectCharacterLocalAssetUrls(db, id);

  const deleteCharacter = db.transaction(() => {
    const existing = db.prepare('SELECT id FROM characters WHERE id = ?').get(id);
    if (!existing) return 0;

    // 级联删除：记忆任务、消息、对话、记忆
    db.prepare('DELETE FROM memory_tasks WHERE character_id = ? OR conversation_id IN (SELECT id FROM conversations WHERE character_id = ?)').run(id, id);
    db.prepare('DELETE FROM messages WHERE conversation_id IN (SELECT id FROM conversations WHERE character_id = ?)').run(id);
    db.prepare('DELETE FROM conversations WHERE character_id = ?').run(id);
    db.prepare('DELETE FROM memories WHERE character_id = ?').run(id);
    const result = db.prepare('DELETE FROM characters WHERE id = ?').run(id);
    return result.changes;
  });

  const changes = deleteCharacter();
  if (changes === 0) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const remainingUrls = collectAllLocalAssetUrls(db);
  const orphanUrls = [...fileUrls].filter(url => !remainingUrls.has(url));
  await deleteLocalAssetUrls(orphanUrls);
  return NextResponse.json({ ok: true });
}
