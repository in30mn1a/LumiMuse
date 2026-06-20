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
      greeting = ?, example_dialogue = ?, system_prompt = ?, other_info = ?, image_tags = ?, user_image_tags = ?, updated_at = ?
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
    body.user_image_tags ?? existing.user_image_tags ?? '',
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

    // 级联删除：记忆任务、消息、对话、记忆、画像、向量索引
    // 注：这些表大多有 ON DELETE CASCADE 外键，理论上删 characters 行会自动级联。
    // 但显式删除更安全：避免未来某处临时关掉 foreign_keys 时留下孤儿数据，
    // 也让删除顺序清晰可控（先删依赖项，最后删 characters）。
    db.prepare('DELETE FROM memory_tasks WHERE character_id = ? OR conversation_id IN (SELECT id FROM conversations WHERE character_id = ?)').run(id, id);
    db.prepare('DELETE FROM memory_embedding_tasks WHERE character_id = ?').run(id);
    db.prepare('DELETE FROM memory_embeddings WHERE character_id = ?').run(id);
    db.prepare('DELETE FROM memory_extraction_candidates WHERE character_id = ?').run(id);
    db.prepare('DELETE FROM character_memory_profile_update_tasks WHERE character_id = ?').run(id);
    db.prepare('DELETE FROM character_memory_profile_versions WHERE character_id = ?').run(id);
    db.prepare('DELETE FROM character_memory_profiles WHERE character_id = ?').run(id);
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
