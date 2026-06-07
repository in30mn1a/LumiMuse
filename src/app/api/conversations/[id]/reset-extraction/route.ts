import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { getDb } from '@/lib/db';
import { readJsonObject } from '@/lib/request-json';

const resetExtractionBodySchema = z.object({
  messageIds: z.array(z.string()).optional(),
  action: z.enum(['reset', 'mark']).optional(),
});

/**
 * POST /api/conversations/[id]/reset-extraction
 * 切换指定消息的记忆提取状态
 * body: { messageIds?: string[]; action?: 'reset' | 'mark' }
 * - action = 'reset'（默认）：清除 memory_extracted 标记，下次触发时重新提取
 * - action = 'mark'：标记为已提取，跳过这些消息不再提取
 * - 传 messageIds 数组：只操作这些消息
 * - 不传：操作整个对话所有用户消息
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: conversationId } = await params;
  const body = await readJsonObject(request);
  if (!body.ok) return body.response;

  const parsedBody = resetExtractionBodySchema.safeParse(body.data);
  if (!parsedBody.success) {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
  }
  const { messageIds, action = 'reset' } = parsedBody.data;

  const db = getDb();

  const allMessages = db.prepare(
    'SELECT id, metadata, role FROM messages WHERE conversation_id = ? ORDER BY created_at ASC, seq ASC'
  ).all(conversationId) as { id: string; metadata: string; role: string }[];

  if (allMessages.length === 0) {
    return NextResponse.json({ error: '对话不存在或无消息' }, { status: 404 });
  }

  const targetSet = messageIds && messageIds.length > 0
    ? new Set(messageIds)
    : null; // null 表示全部操作

  const updateStmt = db.prepare('UPDATE messages SET metadata = ? WHERE id = ?');

  try {
    const count = db.transaction(() => {
      let updated = 0;

      for (const msg of allMessages) {
        // 只操作用户消息
        if (msg.role !== 'user') continue;
        if (targetSet && !targetSet.has(msg.id)) continue;

        let meta: Record<string, unknown> = {};
        try { meta = JSON.parse(msg.metadata || '{}'); } catch { meta = {}; }

        if (action === 'mark') {
          // 标记为已提取
          if (!meta.memory_extracted) {
            meta.memory_extracted = true;
            updateStmt.run(JSON.stringify(meta), msg.id);
            updated++;
          }
        } else if (meta.memory_extracted) {
          // 重置（清除已提取标记）
          delete meta.memory_extracted;
          updateStmt.run(JSON.stringify(meta), msg.id);
          updated++;
        }
      }

      return updated;
    })();

    return NextResponse.json({ resetCount: count, action });
  } catch (error) {
    console.error('[reset-extraction] Failed to update message metadata:', error);
    return NextResponse.json({ error: 'Failed to reset extraction state' }, { status: 500 });
  }
}
