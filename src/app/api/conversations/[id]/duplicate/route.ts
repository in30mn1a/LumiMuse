import { NextRequest, NextResponse } from 'next/server';
import * as crypto from 'crypto';
import { getDb } from '@/lib/db';
import { Message } from '@/types';

/**
 * POST /api/conversations/[id]/duplicate
 * 复制一段对话（含全部消息），返回新对话对象
 */
export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const db = getDb();

  // 查原对话
  const original = db.prepare('SELECT * FROM conversations WHERE id = ?').get(id) as {
    id: string;
    character_id: string;
    title: string;
    created_at: string;
    updated_at: string;
  } | undefined;

  if (!original) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  const newId = crypto.randomUUID().slice(0, 12);
  const now = new Date().toISOString();
  const newTitle = `${original.title} (副本)`;

  const insertConversation = db.prepare(`
    INSERT INTO conversations (id, character_id, title, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?)
  `);

  // 复制全部消息，保持顺序，重新分配 id 和 seq
  const messages = db.prepare(
    'SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at ASC, seq ASC'
  ).all(id) as Message[];

  const insertMsg = db.prepare(`
    INSERT INTO messages (id, conversation_id, role, content, token_count, created_at, seq, metadata)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const copyAll = db.transaction(() => {
    insertConversation.run(newId, original.character_id, newTitle, now, now);

    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];
      const newMsgId = crypto.randomUUID().slice(0, 12);
      // metadata 保持原样（包括 memory_extracted 标记），避免副本重复提取已有记忆
      const metaStr = typeof msg.metadata === 'string'
        ? (msg.metadata as unknown as string)
        : JSON.stringify(msg.metadata || {});

      insertMsg.run(
        newMsgId,
        newId,
        msg.role,
        msg.content,
        msg.token_count,
        msg.created_at,
        i + 1,          // 重新从 1 开始编 seq
        metaStr,
      );
    }
  });

  copyAll();

  const newConversation = db.prepare('SELECT * FROM conversations WHERE id = ?').get(newId);
  return NextResponse.json(newConversation, { status: 201 });
}
