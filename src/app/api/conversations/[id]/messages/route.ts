import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { Message } from '@/types';

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const db = getDb();
  const messages = db.prepare(
    'SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at ASC, seq ASC'
  ).all(id) as Message[];

  // 解析消息元数据
  for (const message of messages) {
    const record = message as unknown as Record<string, unknown>;
    if (typeof record.metadata === 'string') {
      record.metadata = JSON.parse(record.metadata as string);
    }
  }

  return NextResponse.json(messages);
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
  const msgId = uuidv4().slice(0, 8);
  const now = new Date().toISOString();
  const nextSeq = ((db.prepare('SELECT MAX(seq) as m FROM messages WHERE conversation_id = ?').get(id) as { m: number | null }).m ?? 0) + 1;
  const metaStr = metadata ? JSON.stringify(metadata) : '{}';

  db.prepare(`
    INSERT INTO messages (id, conversation_id, role, content, token_count, created_at, seq, metadata)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(msgId, id, role, content, token_count || 0, now, nextSeq, metaStr);

  // 更新对话的最新时间
  db.prepare('UPDATE conversations SET updated_at = ? WHERE id = ?').run(now, id);

  const message = db.prepare('SELECT * FROM messages WHERE id = ?').get(msgId) as Record<string, unknown>;
  if (typeof message.metadata === 'string') {
    message.metadata = JSON.parse(message.metadata as string);
  }
  return NextResponse.json(message, { status: 201 });
}
