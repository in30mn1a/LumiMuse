import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { v4 as uuidv4 } from 'uuid';

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
  const { character_id, title } = await request.json() as { character_id: string; title?: string };
  const id = uuidv4().slice(0, 8);
  const now = new Date().toISOString();

  const db = getDb();
  db.prepare(`
    INSERT INTO conversations (id, character_id, title, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(id, character_id, title || '新的对话', now, now);

  const conversation = db.prepare('SELECT * FROM conversations WHERE id = ?').get(id);
  return NextResponse.json(conversation, { status: 201 });
}
