import { NextRequest, NextResponse } from 'next/server';
import * as crypto from 'crypto';
import { z } from 'zod';
import { getDb } from '@/lib/db';
import { Message } from '@/types';
import { readJsonObject } from '@/lib/request-json';
import {
  ascendingMessageOrderSqlForChain,
  buildChainMessageScope,
  chainMaxSeq,
  resolveConversationChain,
} from '@/lib/conversation-chain';

const duplicateBodySchema = z.object({
  // full   = 物理复制全部消息（旧行为，两份互不影响）
  // linked = 仅索引：不复制消息，只记录继承到父对话的哪个 seq 为止
  mode: z.enum(['full', 'linked']).optional(),
});

/**
 * POST /api/conversations/[id]/duplicate
 * 复制一段对话，返回新对话对象
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  // 旧客户端的复制请求没有 body；继续把它视为缺省 full，但非空的非法 JSON 仍要拒绝。
  let bodyData: Record<string, unknown> = {};
  if (request.body !== null) {
    const body = await readJsonObject(request);
    if (!body.ok) return body.response;
    bodyData = body.data;
  }
  const parsed = duplicateBodySchema.safeParse(bodyData);
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
  }
  const mode = parsed.data.mode ?? 'full';

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

  // 原对话本身可能已是链式子对话，可见消息要沿链展开
  const chain = resolveConversationChain(db, id);
  const scope = buildChainMessageScope(chain);

  if (mode === 'linked') {
    const seqEnd = chainMaxSeq(db, scope);
    db.prepare(`
      INSERT INTO conversations (id, character_id, title, created_at, updated_at, parent_id, parent_seq_end)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(newId, original.character_id, newTitle, now, now, id, seqEnd);

    const created = db.prepare('SELECT * FROM conversations WHERE id = ?').get(newId);
    return NextResponse.json(created, { status: 201 });
  }

  const insertConversation = db.prepare(`
    INSERT INTO conversations (id, character_id, title, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?)
  `);

  // 复制全部消息，保持顺序，重新分配 id 和 seq
  // 链内 seq 是权威顺序：晚生成的插入回复可能拥有更早的 seq。
  // 独立对话保留旧的 created_at-first 行为，避免改变既有导入数据语义。
  const messages = db.prepare(
    `SELECT * FROM messages WHERE ${scope.sql} ORDER BY ${ascendingMessageOrderSqlForChain(chain)}`
  ).all(...scope.params) as Message[];

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
