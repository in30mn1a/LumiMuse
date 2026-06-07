import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { enqueueExtraction } from '@/lib/memory-queue';
import { Message } from '@/types';
import { isMessageMemoryExtracted, isSummaryMessage, serializeTypedMessages } from '@/lib/messages';
import { readJsonObject } from '@/lib/request-json';
import { z } from 'zod';

const DEFAULT_STUCK_THRESHOLD_MS = 5 * 60 * 1000;
const memoryTasksPostBodySchema = z.object({
  conversation_id: z.string().min(1),
});

function parseStuckThreshold(value: string | null): number {
  if (!value) return DEFAULT_STUCK_THRESHOLD_MS;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_STUCK_THRESHOLD_MS;
}

function calculateStuckDiagnostics(
  status: string,
  startedAt: string | null,
  thresholdMs: number,
): { isStuck: boolean; stuckMs: number | null } {
  if (status !== 'processing' || !startedAt) {
    return { isStuck: false, stuckMs: null };
  }

  const startedTime = Date.parse(startedAt);
  if (!Number.isFinite(startedTime)) {
    return { isStuck: false, stuckMs: null };
  }

  const stuckMs = Math.max(0, Date.now() - startedTime);
  return { isStuck: stuckMs >= thresholdMs, stuckMs };
}

export async function GET(request: NextRequest) {
  const conversationId = request.nextUrl.searchParams.get('conversation_id')?.trim();
  const stuckThresholdMs = parseStuckThreshold(request.nextUrl.searchParams.get('stuck_threshold_ms'));

  if (!conversationId) {
    return NextResponse.json({ error: 'Missing conversation_id' }, { status: 400 });
  }

  const db = getDb();
  const columns = db.prepare("PRAGMA table_info(memory_tasks)").all() as { name: string }[];
  const hasRetryCount = columns.some(column => column.name === 'retry_count');
  const hasErrorMessage = columns.some(column => column.name === 'error_message');
  const hasStartedAt = columns.some(column => column.name === 'started_at');
  const row = db.prepare(`
    SELECT
      status,
      merge_count,
      ${hasRetryCount ? 'retry_count' : '0 AS retry_count'},
      ${hasErrorMessage ? 'error_message' : 'NULL AS error_message'},
      ${hasStartedAt ? 'started_at' : 'NULL AS started_at'},
      updated_at
    FROM memory_tasks
    WHERE conversation_id = ?
    ORDER BY id DESC
    LIMIT 1
  `).get(conversationId) as {
    status: string;
    merge_count: number;
    retry_count: number;
    error_message: string | null;
    started_at: string | null;
    updated_at: string;
  } | undefined;

  if (!row) {
    return NextResponse.json({
      status: 'idle',
      mergeCount: 0,
      retryCount: 0,
      errorMessage: null,
      startedAt: null,
      isStuck: false,
      stuckMs: null,
      stuckThresholdMs,
      updatedAt: null,
    });
  }

  const startedAt = row.started_at || null;
  const stuckDiagnostics = calculateStuckDiagnostics(row.status, startedAt, stuckThresholdMs);

  return NextResponse.json({
    status: row.status,
    mergeCount: row.merge_count || 0,
    retryCount: row.retry_count || 0,
    errorMessage: row.error_message || null,
    startedAt,
    isStuck: stuckDiagnostics.isStuck,
    stuckMs: stuckDiagnostics.stuckMs,
    stuckThresholdMs,
    updatedAt: row.updated_at,
  });
}

/**
 * POST /api/memory-tasks
 * 手动触发记忆提取
 * body: { conversation_id: string }
 */
export async function POST(request: NextRequest) {
  const body = await readJsonObject(request);
  if (!body.ok) return body.response;

  const parsed = memoryTasksPostBodySchema.safeParse(body.data);
  if (!parsed.success) {
    return NextResponse.json({ error: 'Missing conversation_id' }, { status: 400 });
  }
  const { conversation_id } = parsed.data;

  const db = getDb();

  // 获取对话信息
  const conversation = db.prepare('SELECT * FROM conversations WHERE id = ?').get(conversation_id) as { id: string; character_id: string; ignore_memory: number } | undefined;
  if (!conversation) {
    return NextResponse.json({ error: '对话不存在' }, { status: 404 });
  }

  // 获取所有消息
  const allMessages = serializeTypedMessages(
    db.prepare(
      'SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at ASC, seq ASC'
    ).all(conversation_id) as Message[]
  );

  // 收集未提取的用户消息
  const unextracted = allMessages.filter(
    message => message.role === 'user' && !isMessageMemoryExtracted(message.metadata)
  );

  if (unextracted.length === 0) {
    return NextResponse.json({ error: '没有待提取的消息' }, { status: 400 });
  }

  // 构建完整对话片段：未提取的用户消息 + 紧随其后的 assistant 回复
  const unextractedIds = new Set(unextracted.map(m => m.id));
  const extractionMessages: Message[] = [];
  let includeNext = false;
  for (const msg of allMessages) {
    if (isSummaryMessage(msg.metadata)) continue;
    if (unextractedIds.has(msg.id)) {
      extractionMessages.push(msg);
      includeNext = true;
    } else if (includeNext && msg.role === 'assistant') {
      if (!isMessageMemoryExtracted(msg.metadata)) {
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
