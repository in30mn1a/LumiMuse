import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { getDb } from '@/lib/db';
import { readJsonObject } from '@/lib/request-json';
import {
  ascendingMessageOrderSqlForChain,
  buildChainMessageScope,
  resolveConversationChain,
} from '@/lib/conversation-chain';
import { MEMORY_PROCESSED_SQL } from '@/lib/memory-extraction-scope';
import { isMessageMemoryExtracted } from '@/lib/messages';
import type { ExtractionStatusItem, MessageMetadata } from '@/types';

const resetExtractionBodySchema = z.object({
  messageIds: z.array(z.string()).optional(),
  action: z.enum(['reset', 'mark']).optional(),
});

/** 弹窗每行只显示正文开头（单行 truncate），与旧版前端 content.slice(0, 60) 保持一致 */
const PREVIEW_CHARS = 60;

/**
 * GET /api/conversations/[id]/reset-extraction
 * 「切换提取状态」弹窗的列表数据：用户消息的 id、正文开头、时间和提取状态，按对话时间升序。
 *
 * 弹窗曾拉 /api/messages?all=1（全部角色的消息 + 完整正文与 metadata），
 * 两千多条的长对话响应约 7MB，慢网络下要几十秒；而弹窗只用到这几个字段（约 0.3MB）。
 * 提取状态复用 MEMORY_PROCESSED_SQL，和顶栏「N 待提取」计数、POST 的 reset 判定一致。
 */
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: conversationId } = await params;
  const db = getDb();
  const chain = resolveConversationChain(db, conversationId);
  const scope = buildChainMessageScope(chain);
  const rows = db.prepare(
    `SELECT id, substr(content, 1, ${PREVIEW_CHARS}) AS preview, created_at,
       (${MEMORY_PROCESSED_SQL}) AS extracted
     FROM messages
     WHERE ${scope.sql} AND role = 'user'
     ORDER BY ${ascendingMessageOrderSqlForChain(chain)}`
  ).all(...scope.params) as Array<Omit<ExtractionStatusItem, 'extracted'> & { extracted: number }>;

  const items: ExtractionStatusItem[] = rows.map(row => ({ ...row, extracted: row.extracted === 1 }));
  return NextResponse.json(items);
}

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
  const chain = resolveConversationChain(db, conversationId);
  const scope = buildChainMessageScope(chain);
  const allMessages = db.prepare(
    `SELECT id, metadata, role
     FROM messages
     WHERE ${scope.sql}
     ORDER BY ${ascendingMessageOrderSqlForChain(chain)}`
  ).all(...scope.params) as { id: string; metadata: string; role: string }[];

  if (allMessages.length === 0) {
    return NextResponse.json({ error: '对话不存在或无消息' }, { status: 404 });
  }

  const targetSet = messageIds === undefined
    ? null
    : new Set(messageIds); // 只有未传 messageIds 才表示全部操作；显式空数组表示不操作

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
          // 标记为已提取；已处理的（含只有 noop 标记的旧数据）不计入 resetCount，
          // 否则前端按 resetCount 扣减「N 待提取」会多扣
          if (!isMessageMemoryExtracted(meta as MessageMetadata)) {
            meta.memory_extracted = true;
            updateStmt.run(JSON.stringify(meta), msg.id);
            updated++;
          }
        } else if (
          meta.memory_extracted
          || typeof meta.memory_noop_extracted_at === 'string'
        ) {
          // 重置（同时清除 noop 标记，否则这条消息仍会被视为已处理）
          delete meta.memory_extracted;
          delete meta.memory_noop_extracted_at;
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
