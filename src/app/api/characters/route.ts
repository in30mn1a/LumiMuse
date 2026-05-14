import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { Character } from '@/types';
import { v4 as uuidv4 } from 'uuid';

export async function GET() {
  const db = getDb();
  // 按 sort_order 升序（越小越靠前），相同则按 updated_at 降序保持稳定
  const characters = db.prepare('SELECT * FROM characters ORDER BY sort_order ASC, updated_at DESC').all();
  return NextResponse.json(characters);
}

export async function POST(request: NextRequest) {
  const body = await request.json() as Partial<Character>;
  const id = uuidv4().slice(0, 8);
  const now = new Date().toISOString();

  const db = getDb();
  // 新建角色排到列表最前：取当前最小 sort_order - 1（首条则为 0）
  const minRow = db.prepare('SELECT MIN(sort_order) AS min_sort FROM characters').get() as { min_sort: number | null };
  const nextSort = minRow.min_sort === null ? 0 : minRow.min_sort - 1;

  db.prepare(`
    INSERT INTO characters (id, name, avatar_url, personality, scenario, greeting, example_dialogue, system_prompt, image_tags, sort_order, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
    nextSort,
    now,
    now,
  );

  const character = db.prepare('SELECT * FROM characters WHERE id = ?').get(id);
  return NextResponse.json(character, { status: 201 });
}
