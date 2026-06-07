import { NextRequest, NextResponse } from 'next/server';
import * as crypto from 'crypto';
import { getDb } from '@/lib/db';
import { characterCreateSchema, formatZodFieldErrors } from '@/lib/schemas';

export async function GET() {
  const db = getDb();
  // 按 sort_order 升序（越小越靠前），相同则按 updated_at 降序保持稳定
  const characters = db.prepare('SELECT * FROM characters ORDER BY sort_order ASC, updated_at DESC').all();
  return NextResponse.json(characters);
}

export async function POST(request: NextRequest) {
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  const parsed = characterCreateSchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Invalid request body', fieldErrors: formatZodFieldErrors(parsed.error) },
      { status: 400 },
    );
  }
  const body = parsed.data;
  const id = crypto.randomUUID().slice(0, 12);
  const now = new Date().toISOString();

  const db = getDb();
  // 新建角色排到列表最前：取当前最小 sort_order - 1（首条则为 0）
  const minRow = db.prepare('SELECT MIN(sort_order) AS min_sort FROM characters').get() as { min_sort: number | null };
  const nextSort = minRow.min_sort === null ? 0 : minRow.min_sort - 1;

  db.prepare(`
    INSERT INTO characters (id, name, avatar_url, basic_info, personality, scenario, greeting, example_dialogue, system_prompt, other_info, image_tags, user_image_tags, sort_order, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    body.name || 'New Character',
    body.avatar_url || null,
    body.basic_info || '',
    body.personality || '',
    body.scenario || '',
    body.greeting || '',
    body.example_dialogue || '',
    body.system_prompt || '',
    body.other_info || '',
    body.image_tags || '',
    body.user_image_tags || '',
    nextSort,
    now,
    now,
  );

  const character = db.prepare('SELECT * FROM characters WHERE id = ?').get(id);
  return NextResponse.json(character, { status: 201 });
}
