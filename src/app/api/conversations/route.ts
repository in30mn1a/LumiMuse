import { NextRequest, NextResponse } from 'next/server';
import * as crypto from 'crypto';
import { getDb } from '@/lib/db';
import { conversationCreateSchema, formatZodFieldErrors } from '@/lib/schemas';

const DEFAULT_CONVERSATIONS_LIMIT = 20;
const MAX_CONVERSATIONS_LIMIT = 100;

function parseBoundedInteger(value: string | null, fallback: number, max: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.max(1, Math.min(Math.floor(parsed), max));
}

function parseOffset(value: string | null): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return 0;
  return Math.floor(parsed);
}

export async function GET(request: NextRequest) {
  const characterId = request.nextUrl.searchParams.get('character_id');
  const limit = parseBoundedInteger(request.nextUrl.searchParams.get('limit'), DEFAULT_CONVERSATIONS_LIMIT, MAX_CONVERSATIONS_LIMIT);
  const offset = parseOffset(request.nextUrl.searchParams.get('offset'));
  const db = getDb();

  if (characterId) {
    const total = db.prepare('SELECT COUNT(*) as count FROM conversations WHERE character_id = ?').get(characterId) as { count: number };
    const conversations = db.prepare(
      'SELECT * FROM conversations WHERE character_id = ? ORDER BY updated_at DESC, created_at DESC, id DESC LIMIT ? OFFSET ?'
    ).all(characterId, limit, offset);
    return NextResponse.json(conversations, {
      headers: {
        'X-Total-Count': String(total.count),
        'X-Has-More': String(offset + conversations.length < total.count),
        'X-Page-Limit': String(limit),
        'X-Page-Offset': String(offset),
      },
    });
  }

  const total = db.prepare('SELECT COUNT(*) as count FROM conversations').get() as { count: number };
  const conversations = db.prepare('SELECT * FROM conversations ORDER BY updated_at DESC, created_at DESC, id DESC LIMIT ? OFFSET ?').all(limit, offset);
  return NextResponse.json({
    conversations,
    total: total.count,
    hasMore: offset + conversations.length < total.count,
    limit,
    offset,
  });
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
  const id = crypto.randomUUID().slice(0, 12);
  const now = new Date().toISOString();

  const db = getDb();
  db.prepare(`
    INSERT INTO conversations (id, character_id, title, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(id, character_id, title || '新的对话', now, now);

  const conversation = db.prepare('SELECT * FROM conversations WHERE id = ?').get(id);
  return NextResponse.json(conversation, { status: 201 });
}
