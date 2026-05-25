import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { Message } from '@/types';
import { serializeMessage, serializeTypedMessages } from '@/lib/messages';

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const db = getDb();
  const messages = db.prepare(
    'SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at ASC, seq ASC'
  ).all(id) as Message[];

  return NextResponse.json(serializeTypedMessages(messages));
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const { role, content, token_count, metadata } = await request.json() as {
    role: string;
    content: string;
    token_count?: number;
    metadata?: Record<string, unknown>;
  };
  const db = getDb();

  const { v4: uuidv4 } = await import('uuid');
  const msgId = uuidv4().slice(0, 12);
  const now = new Date().toISOString();
  const metaStr = metadata ? JSON.stringify(metadata) : '{}';

  // 用事务包裹 SELECT MAX(seq) + INSERT + UPDATE conversations，避免并发写入产生重复 seq
  db.transaction(() => {
    const nextSeq = ((db.prepare('SELECT MAX(seq) as m FROM messages WHERE conversation_id = ?').get(id) as { m: number | null }).m ?? 0) + 1;
    db.prepare(`
      INSERT INTO messages (id, conversation_id, role, content, token_count, created_at, seq, metadata)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(msgId, id, role, content, token_count || 0, now, nextSeq, metaStr);

    // 更新对话的最新时间
    db.prepare('UPDATE conversations SET updated_at = ? WHERE id = ?').run(now, id);
  })();

  const message = db.prepare('SELECT * FROM messages WHERE id = ?').get(msgId) as Record<string, unknown>;
  return NextResponse.json(serializeMessage(message), { status: 201 });
}
