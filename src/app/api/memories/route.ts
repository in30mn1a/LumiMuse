import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { Memory } from '@/types';
import { normalizeMemoryCategory } from '@/lib/memory-category';

export async function GET(request: NextRequest) {
  const db = getDb();
  const characterId = request.nextUrl.searchParams.get('character_id');
  const category = request.nextUrl.searchParams.get('category');
  const keyword = request.nextUrl.searchParams.get('keyword');
  const limitParam = request.nextUrl.searchParams.get('limit');
  const offsetParam = request.nextUrl.searchParams.get('offset');
  const sort = request.nextUrl.searchParams.get('sort');
  const shouldPaginate = limitParam !== null || offsetParam !== null;
  const limit = Math.min(Math.max(Number(limitParam ?? 20) || 20, 1), 100);
  const offset = Math.max(Number(offsetParam ?? 0) || 0, 0);

  let sql = 'SELECT * FROM memories WHERE 1=1';
  const params: unknown[] = [];

  if (characterId) {
    sql += ' AND character_id = ?';
    params.push(characterId);
  }
  if (keyword) {
    sql += ' AND (content LIKE ? OR tags LIKE ?)';
    params.push(`%${keyword}%`, `%${keyword}%`);
  }
  if (category) {
    sql += ' AND category = ?';
    params.push(normalizeMemoryCategory(category));
  }

  const total = db.prepare(`SELECT COUNT(*) as count FROM (${sql})`).get(...params) as { count: number };

  sql += sort === 'oldest' ? ' ORDER BY created_at ASC, rowid ASC' : ' ORDER BY created_at DESC, rowid DESC';
  if (shouldPaginate) {
    sql += ' LIMIT ? OFFSET ?';
    params.push(limit, offset);
  }

  const memories = db.prepare(sql).all(...params) as Memory[];

  const normalized = memories.map(memory => {
    const record = memory as unknown as Record<string, unknown>;
    const next = {
      ...memory,
      category: normalizeMemoryCategory(String(record.category || '话题历史')),
      tags: typeof record.tags === 'string' ? JSON.parse(record.tags as string) : memory.tags,
      source_msg_ids: typeof record.source_msg_ids === 'string' ? JSON.parse(record.source_msg_ids as string) : memory.source_msg_ids,
    } as Memory;
    return next;
  });

  if (shouldPaginate) {
    return NextResponse.json({
      memories: normalized,
      total: total.count,
      hasMore: offset + normalized.length < total.count,
    });
  }

  return NextResponse.json(normalized);
}

export async function POST(request: NextRequest) {
  const body = await request.json() as {
    character_id: string;
    category: string;
    content: string;
    confidence?: number;
    tags?: string[];
  };

  const db = getDb();
  const id = crypto.randomUUID().slice(0, 12);
  const now = new Date().toISOString();

  db.prepare(`
    INSERT INTO memories (id, character_id, category, content, confidence, tags, source_msg_ids, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, '[]', ?, ?)
  `).run(
    id,
    body.character_id,
    normalizeMemoryCategory(body.category),
    body.content,
    body.confidence ?? 0.9,
    JSON.stringify(body.tags || []),
    now,
    now,
  );

  const memory = db.prepare('SELECT * FROM memories WHERE id = ?').get(id) as Record<string, unknown>;
  if (typeof memory.tags === 'string') memory.tags = JSON.parse(memory.tags as string);
  if (typeof memory.source_msg_ids === 'string') memory.source_msg_ids = JSON.parse(memory.source_msg_ids as string);
  memory.category = normalizeMemoryCategory(String(memory.category || '话题历史'));
  return NextResponse.json(memory, { status: 201 });
}
