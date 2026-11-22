import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { enqueueExtraction } from '@/lib/memory-queue';
import { resolveMessageScope } from '@/lib/conversation-chain';
import { loadPendingMemoryExtractionBatch } from '@/lib/memory-extraction-scope';
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
  const scope = resolveMessageScope(db, conversationId);
  // 「任务涉及的消息里有没有落在当前视图内的」：以任务自己的 message_ids 为外层、按 messages 主键逐条查，
  // 再校验可见范围（CROSS JOIN 固定连接顺序）。曾写成先展开整个视图的消息、每条再扫一遍任务 id 列表，
  // 代价是 任务数 × 视图消息数 × 每任务 id 数；done 任务长期保留，长对话里一次轮询要几秒，
  // 同步 SQLite 会把整个服务卡住（前端提取期间每 1.5s 轮询一次）。
  // scope.sql 的列名不带表前缀：子查询里只有 messages 有 conversation_id / seq，json_each 没有同名列。
  const row = db.prepare(`
    SELECT
      task.status,
      task.merge_count,
      ${hasRetryCount ? 'task.retry_count' : '0 AS retry_count'},
      ${hasErrorMessage ? 'task.error_message' : 'NULL AS error_message'},
      ${hasStartedAt ? 'task.started_at' : 'NULL AS started_at'},
      task.updated_at
    FROM memory_tasks AS task
    WHERE task.conversation_id = ?
      OR EXISTS (
        SELECT 1
        FROM json_each(
          CASE WHEN json_valid(task.message_ids) THEN task.message_ids ELSE '[]' END
        ) AS task_message
        CROSS JOIN messages AS visible_message
        WHERE task_message.type = 'text'
          AND visible_message.id = task_message.value
          AND ${scope.sql}
      )
    ORDER BY
      CASE WHEN task.status IN ('pending', 'processing') THEN 0 ELSE 1 END,
      task.updated_at DESC,
      task.id DESC
    LIMIT 1
  `).get(conversationId, ...scope.params) as {
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
  const conversation = db.prepare('SELECT * FROM conversations WHERE id = ?').get(conversation_id) as { id: string; character_id: string } | undefined;
  if (!conversation) {
    return NextResponse.json({ error: '对话不存在' }, { status: 404 });
  }

  const { unprocessedUsers, extractionMessages } = loadPendingMemoryExtractionBatch(db, conversation_id);
  if (unprocessedUsers.length === 0) {
    return NextResponse.json({ error: '没有待提取的消息' }, { status: 400 });
  }

  // 入队提取
  enqueueExtraction(conversation.character_id, conversation_id, extractionMessages);

  return NextResponse.json({ ok: true, messageCount: extractionMessages.length });
}
