import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { Character } from '@/types';
import { v4 as uuidv4 } from 'uuid';

export async function GET() {
  const db = getDb();
  const characters = db.prepare('SELECT * FROM characters ORDER BY updated_at DESC').all();
  return NextResponse.json(characters);
}

export async function POST(request: NextRequest) {
  const body = await request.json() as Partial<Character>;
  const id = uuidv4().slice(0, 8);
  const now = new Date().toISOString();

  const db = getDb();
  db.prepare(`
    INSERT INTO characters (id, name, avatar_url, personality, scenario, greeting, example_dialogue, system_prompt, image_tags, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    body.name || 'New Character',
    body.avatar_url || null,
    body.personality || '',
    body.scenario || '',
    body.greeting || '',
    body.example_dialogue || '',
    body.system_prompt || '',
    body.image_tags || '',
    now,
    now,
  );

  const character = db.prepare('SELECT * FROM characters WHERE id = ?').get(id);
  return NextResponse.json(character, { status: 201 });
}
