import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { enqueueExtraction } from '@/lib/memory-queue';
import { Message } from '@/types';
import { loadSettings } from '@/lib/settings';


export async function GET(request: NextRequest) {
  const conversationId = request.nextUrl.searchParams.get('conversation_id')?.trim();

  if (!conversationId) {
    return NextResponse.json({ error: 'Missing conversation_id' }, { status: 400 });
  }

  const db = getDb();
  const row = db.prepare(`
    SELECT status, merge_count, updated_at
    FROM memory_tasks
    WHERE conversation_id = ?
    ORDER BY id DESC
    LIMIT 1
  `).get(conversationId) as { status: string; merge_count: number; updated_at: string } | undefined;

  if (!row) {
    return NextResponse.json({ status: 'idle', mergeCount: 0, updatedAt: null });
  }

  return NextResponse.json({
    status: row.status,
    mergeCount: row.merge_count || 0,
    updatedAt: row.updated_at,
  });
}

/**
 * POST /api/memory-tasks
 * 手动触发记忆提取
 * body: { conversation_id: string }
 */
export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => ({}));
  const { conversation_id } = body as { conversation_id?: string };

  if (!conversation_id) {
    return NextResponse.json({ error: 'Missing conversation_id' }, { status: 400 });
  }

  const db = getDb();

  // 获取对话信息
  const conversation = db.prepare('SELECT * FROM conversations WHERE id = ?').get(conversation_id) as { id: string; character_id: string; ignore_memory: number } | undefined;
  if (!conversation) {
    return NextResponse.json({ error: '对话不存在' }, { status: 404 });
  }

  // 获取所有消息
  const allMessages = db.prepare(
    'SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at ASC, seq ASC'
  ).all(conversation_id) as Message[];

  for (const msg of allMessages) {
    if (typeof (msg as Record<string, unknown>).metadata === 'string') {
      (msg as Record<string, unknown>).metadata = JSON.parse((msg as Record<string, unknown>).metadata as string);
    }
  }

  // 收集未提取的用户消息
  const unextracted = allMessages.filter(message => {
    const meta = message.metadata as Record<string, unknown> || {};
    return message.role === 'user' && !meta.memory_extracted;
  });

  if (unextracted.length === 0) {
    return NextResponse.json({ error: '没有待提取的消息' }, { status: 400 });
  }

  // 构建完整对话片段：未提取的用户消息 + 紧随其后的 assistant 回复
  const unextractedIds = new Set(unextracted.map(m => m.id));
  const extractionMessages: Message[] = [];
  let includeNext = false;
  for (const msg of allMessages) {
    const msgMeta = (msg.metadata || {}) as Record<string, unknown>;
    if (msgMeta.isSummary) continue;
    if (unextractedIds.has(msg.id)) {
      extractionMessages.push(msg);
      includeNext = true;
    } else if (includeNext && msg.role === 'assistant') {
      const meta = msg.metadata as Record<string, unknown> || {};
      if (!meta.memory_extracted) {
        extractionMessages.push(msg);
      }
      includeNext = false;
    } else {
      includeNext = false;
    }
  }

  // 入队提取
  enqueueExtraction(conversation.character_id, conversation_id, extractionMessages);

  return NextResponse.json({ ok: true, messageCount: extractionMessages.length });
}
