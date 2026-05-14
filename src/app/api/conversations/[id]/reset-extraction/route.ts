import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';

/**
 * POST /api/conversations/[id]/reset-extraction
 * 重置指定消息的记忆提取状态
 * body: { messageIds?: string[] }
 * - 传 messageIds 数组：只重置这些消息
 * - 不传：重置整个对话所有消息
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: conversationId } = await params;
  const body = await request.json().catch(() => ({}));
  const { messageIds } = body as { messageIds?: string[] };

  const db = getDb();

  const allMessages = db.prepare(
    'SELECT id, metadata FROM messages WHERE conversation_id = ? ORDER BY created_at ASC, seq ASC'
  ).all(conversationId) as { id: string; metadata: string }[];

  if (allMessages.length === 0) {
    return NextResponse.json({ error: '对话不存在或无消息' }, { status: 404 });
  }

  const targetSet = messageIds && messageIds.length > 0
    ? new Set(messageIds)
    : null; // null 表示全部重置

  let resetCount = 0;
  const updateStmt = db.prepare('UPDATE messages SET metadata = ? WHERE id = ?');

  for (const msg of allMessages) {
    if (targetSet && !targetSet.has(msg.id)) continue;

    let meta: Record<string, unknown> = {};
    try { meta = JSON.parse(msg.metadata || '{}'); } catch { meta = {}; }

    if (meta.memory_extracted) {
      delete meta.memory_extracted;
      updateStmt.run(JSON.stringify(meta), msg.id);
      resetCount++;
    }
  }

  return NextResponse.json({ resetCount });
}
