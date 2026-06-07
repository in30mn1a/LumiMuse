import { NextRequest, NextResponse } from 'next/server';
import * as crypto from 'crypto';
import { getDb } from '@/lib/db';
import { Message } from '@/types';
import { serializeTypedMessages } from '@/lib/messages';
import { messageCreateSchema, formatZodFieldErrors } from '@/lib/schemas';

export async function GET(request: NextRequest) {
  const conversationId = request.nextUrl.searchParams.get('conversation_id')?.trim();
  const all = request.nextUrl.searchParams.get('all') === '1';
  const wantsPaged = request.nextUrl.searchParams.has('limit') || request.nextUrl.searchParams.has('before_seq');
  const limitParam = Number(request.nextUrl.searchParams.get('limit') || '80');
  const beforeSeqParam = request.nextUrl.searchParams.get('before_seq');
  const beforeSeq = beforeSeqParam ? Number(beforeSeqParam) : null;

  if (!conversationId) {
    return NextResponse.json({ error: 'Missing conversation_id' }, { status: 400 });
  }

  const db = getDb();
  if (all || !wantsPaged) {
    const messages = db.prepare(
      'SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at ASC, seq ASC',
    ).all(conversationId) as Message[];

    return NextResponse.json(serializeTypedMessages(messages));
  }

  const limit = Math.min(Math.max(Number.isFinite(limitParam) ? limitParam : 80, 1), 200);
  const pageLimit = limit + 1;
  const rawMessages = beforeSeq !== null && Number.isFinite(beforeSeq)
    ? db.prepare(
        'SELECT * FROM messages WHERE conversation_id = ? AND seq < ? ORDER BY seq DESC LIMIT ?',
      ).all(conversationId, beforeSeq, pageLimit) as Message[]
    : db.prepare(
        'SELECT * FROM messages WHERE conversation_id = ? ORDER BY seq DESC LIMIT ?',
      ).all(conversationId, pageLimit) as Message[];

  const hasMore = rawMessages.length > limit;
  const messages = rawMessages.slice(0, limit).reverse();

  // 从数据库查询真实的未提取用户消息数量（不受分页限制）
  const unextractedRow = db.prepare(
    `SELECT COUNT(*) as cnt FROM messages
     WHERE conversation_id = ? AND role = 'user'
     AND (metadata IS NULL OR metadata = '{}' OR json_extract(metadata, '$.memory_extracted') IS NULL)`
  ).get(conversationId) as { cnt: number };

  // 整对话的 token 总和（基于服务端持久化的 token_count），用于前端在分页未加载完时正确显示。
  // 与前端 messageTokens 的语义一致：若存在 summary 消息，则从最后一条 summary 起累加；否则全量。
  const lastSummaryRow = db.prepare(
    `SELECT seq FROM messages
     WHERE conversation_id = ? AND json_extract(metadata, '$.isSummary') = 1
     ORDER BY seq DESC LIMIT 1`
  ).get(conversationId) as { seq: number } | undefined;
  const tokenSumRow = (lastSummaryRow
    ? db.prepare('SELECT SUM(token_count) as s FROM messages WHERE conversation_id = ? AND seq >= ?')
        .get(conversationId, lastSummaryRow.seq)
    : db.prepare('SELECT SUM(token_count) as s FROM messages WHERE conversation_id = ?')
        .get(conversationId)) as { s: number | null };
  const totalTokens = tokenSumRow.s ?? 0;

  return NextResponse.json({
    messages: serializeTypedMessages(messages),
    hasMore,
    oldestSeq: messages[0]?.seq ?? null,
    unextractedCount: unextractedRow.cnt,
    totalTokens,
  });
}

export async function POST(request: NextRequest) {
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  const parsed = messageCreateSchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Invalid request body', fieldErrors: formatZodFieldErrors(parsed.error) },
      { status: 400 },
    );
  }
  const { conversation_id, role, content, token_count, metadata } = parsed.data;

  const db = getDb();
  const msgId = crypto.randomUUID().slice(0, 12);
  const now = new Date().toISOString();
  const metaStr = metadata ? JSON.stringify(metadata) : '{}';

  // 用事务包裹 SELECT MAX(seq) + INSERT + UPDATE conversations，避免并发写入产生重复 seq
  db.transaction(() => {
    const nextSeq = ((db.prepare('SELECT MAX(seq) as m FROM messages WHERE conversation_id = ?').get(conversation_id) as { m: number | null }).m ?? 0) + 1;
    db.prepare(`
      INSERT INTO messages (id, conversation_id, role, content, token_count, created_at, seq, metadata)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(msgId, conversation_id, role, content, token_count || 0, now, nextSeq, metaStr);

    db.prepare('UPDATE conversations SET updated_at = ? WHERE id = ?').run(now, conversation_id);
  })();

  const message = db.prepare('SELECT * FROM messages WHERE id = ?').get(msgId) as Message;
  return NextResponse.json(serializeTypedMessages([message])[0], { status: 201 });
}
