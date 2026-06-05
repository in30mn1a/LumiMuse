import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { v4 as uuidv4 } from 'uuid';
import { conversationCreateSchema, formatZodFieldErrors } from '@/lib/schemas';

export async function GET(request: NextRequest) {
  const characterId = request.nextUrl.searchParams.get('character_id');
  const db = getDb();

  if (characterId) {
    const conversations = db.prepare(
      'SELECT * FROM conversations WHERE character_id = ? ORDER BY updated_at DESC'
    ).all(characterId);
    return NextResponse.json(conversations);
  }

  const conversations = db.prepare('SELECT * FROM conversations ORDER BY updated_at DESC').all();
  return NextResponse.json(conversations);
}

export async function POST(request: NextRequest) {
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  const parsed = conversationCreateSchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Invalid request body', fieldErrors: formatZodFieldErrors(parsed.error) },
      { status: 400 },
    );
  }
  const { character_id, title } = parsed.data;
  const id = uuidv4().slice(0, 12);
  const now = new Date().toISOString();

  const db = getDb();
  db.prepare(`
    INSERT INTO conversations (id, character_id, title, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(id, character_id, title || '新的对话', now, now);

  const conversation = db.prepare('SELECT * FROM conversations WHERE id = ?').get(id);
  return NextResponse.json(conversation, { status: 201 });
}
