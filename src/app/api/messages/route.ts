import { NextRequest, NextResponse } from 'next/server';
import * as crypto from 'crypto';
import { getDb } from '@/lib/db';
import { Message, MessageAttachment } from '@/types';
import { serializeTypedMessages } from '@/lib/messages';
import { messageCreateSchema, formatZodFieldErrors } from '@/lib/schemas';
import { createMessageTokenCount, metadataWithTokenCountProvenance } from '@/lib/message-token-provenance';
import {
  ascendingMessageOrderSqlForChain,
  buildChainMessageScope,
  nextChainSeq,
  resolveConversationChain,
} from '@/lib/conversation-chain';
import { MEMORY_PROCESSED_SQL } from '@/lib/memory-extraction-scope';
import { getSummaryCoverageIds } from '@/lib/summary-context-tokens';

export async function GET(request: NextRequest) {
  const conversationId = request.nextUrl.searchParams.get('conversation_id')?.trim();
  const all = request.nextUrl.searchParams.get('all') === '1';
  // 搜索跳转的目标消息：返回一段包含它、延伸到最新的已加载范围（见下方 rangeFromSeq）
  const aroundMessageId = request.nextUrl.searchParams.get('around_message_id')?.trim() || null;
  const wantsPaged = request.nextUrl.searchParams.has('limit')
    || request.nextUrl.searchParams.has('before_seq')
    || request.nextUrl.searchParams.has('from_seq')
    || aroundMessageId !== null;
  const limitParam = Number(request.nextUrl.searchParams.get('limit') || '80');
  const beforeSeqParam = request.nextUrl.searchParams.get('before_seq');
  const beforeSeq = beforeSeqParam ? Number(beforeSeqParam) : null;
  // 刷新已加载范围：返回 seq >= from_seq 的全部消息（前端已持有这段，不受单页 200 条限制），
  // 否则长对话里往上翻过 200 条后刷新会把上面那段整体丢掉。
  const fromSeqParam = request.nextUrl.searchParams.get('from_seq');
  const fromSeq = fromSeqParam !== null && Number.isFinite(Number(fromSeqParam)) ? Number(fromSeqParam) : null;

  if (!conversationId) {
    return NextResponse.json({ error: 'Missing conversation_id' }, { status: 400 });
  }

  const db = getDb();
  // 链式子对话不物理持有父对话的消息，读取范围要沿 parent 链展开
  const chain = resolveConversationChain(db, conversationId);
  const scope = buildChainMessageScope(chain);
  if (all || !wantsPaged) {
    const messages = db.prepare(
      `SELECT * FROM messages WHERE ${scope.sql} ORDER BY ${ascendingMessageOrderSqlForChain(chain)}`,
    ).all(...scope.params) as Message[];

    return NextResponse.json(serializeTypedMessages(messages));
  }

  const limit = Math.floor(Math.min(Math.max(Number.isFinite(limitParam) ? limitParam : 80, 1), 200));
  const pageLimit = limit + 1;

  // 搜索跳转：从「目标消息」与「最新一页的起点」中较早的一条取到最新，目标必在其中、且至少一整页，
  // 之后照常按 before_seq 往上翻。曾直接拉 all=1（两千多条的对话约 7MB），
  // 而且已加载范围从此变成整段，之后每条回复的收尾刷新也都是整段。
  // 目标不在视图内、或整段不足一页（最新一页已含全部）时退回最新一页。
  let rangeFromSeq = fromSeq;
  if (rangeFromSeq === null && beforeSeq === null && aroundMessageId !== null) {
    const target = db.prepare(
      `SELECT seq FROM messages WHERE ${scope.sql} AND id = ?`,
    ).get(...scope.params, aroundMessageId) as { seq: number } | undefined;
    const latestPageStart = target && db.prepare(
      `SELECT seq FROM messages WHERE ${scope.sql} ORDER BY seq DESC LIMIT 1 OFFSET ?`,
    ).get(...scope.params, limit - 1) as { seq: number } | undefined;
    if (target && latestPageStart) rangeFromSeq = Math.min(target.seq, latestPageStart.seq);
  }

  let rawMessages = rangeFromSeq !== null
    ? db.prepare(
        `SELECT * FROM messages WHERE ${scope.sql} AND seq >= ? ORDER BY seq DESC`,
      ).all(...scope.params, rangeFromSeq) as Message[]
    : beforeSeq !== null && Number.isFinite(beforeSeq)
    ? db.prepare(
        `SELECT * FROM messages WHERE ${scope.sql} AND seq < ? ORDER BY seq DESC LIMIT ?`,
      ).all(...scope.params, beforeSeq, pageLimit) as Message[]
    : db.prepare(
        `SELECT * FROM messages WHERE ${scope.sql} ORDER BY seq DESC LIMIT ?`,
      ).all(...scope.params, pageLimit) as Message[];

  const hasLoadedRange = rangeFromSeq !== null && rawMessages.length > 0;
  // 已加载范围可能被删空；回退最新一页，避免仍有历史时返回空列表和无法继续分页的 null 游标。
  if (rangeFromSeq !== null && !hasLoadedRange) {
    rawMessages = db.prepare(
      `SELECT * FROM messages WHERE ${scope.sql} ORDER BY seq DESC LIMIT ?`,
    ).all(...scope.params, pageLimit) as Message[];
  }

  const hasMore = hasLoadedRange
    ? Boolean(db.prepare(`SELECT 1 FROM messages WHERE ${scope.sql} AND seq < ? LIMIT 1`).get(...scope.params, rangeFromSeq))
    : rawMessages.length > limit;
  const messages = (hasLoadedRange ? rawMessages : rawMessages.slice(0, limit)).reverse();
  let unextractedCount: number | undefined;
  let totalTokens: number | undefined;

  // 只有首页/刷新消费整对话统计；older-page 由缓存保留已有 metadata，避免每页重复全表聚合。
  if (beforeSeq === null) {
    const unextractedRow = db.prepare(
      `SELECT COUNT(*) as cnt FROM messages
       WHERE ${scope.sql} AND role = 'user'
       AND NOT (${MEMORY_PROCESSED_SQL})`
    ).get(...scope.params) as { cnt: number };
    unextractedCount = unextractedRow.cnt;

    // 整对话的 token 总和（基于服务端持久化的 token_count），用于前端在分页未加载完时正确显示。
    // 与聊天上下文一致：最新总结加未覆盖消息，旧总结仍按 seq 边界计算。
    const lastSummaryRow = db.prepare(
      `SELECT id, seq, metadata FROM messages
       WHERE ${scope.sql} AND CASE WHEN json_valid(metadata)
         THEN json_extract(metadata, '$.isSummary') = 1 ELSE 0 END
       ORDER BY seq DESC LIMIT 1`
    ).get(...scope.params) as { id: string; seq: number; metadata: string } | undefined;
    const coveredIds = lastSummaryRow ? getSummaryCoverageIds(lastSummaryRow.metadata) : undefined;
    const tokenSumRow = (lastSummaryRow && coveredIds
      ? db.prepare(`SELECT SUM(token_count) as s FROM messages WHERE ${scope.sql}
          AND (id = ? OR (
            COALESCE(CASE WHEN json_valid(metadata) THEN json_extract(metadata, '$.isSummary') END, 0) != 1
            AND id NOT IN (SELECT value FROM json_each(?))
          ))`).get(...scope.params, lastSummaryRow.id, JSON.stringify(coveredIds))
      : lastSummaryRow
      ? db.prepare(`SELECT SUM(token_count) as s FROM messages WHERE ${scope.sql} AND seq >= ?`)
          .get(...scope.params, lastSummaryRow.seq)
      : db.prepare(`SELECT SUM(token_count) as s FROM messages WHERE ${scope.sql}`)
          .get(...scope.params)) as { s: number | null };
    totalTokens = tokenSumRow.s ?? 0;
  }

  return NextResponse.json({
    messages: serializeTypedMessages(messages),
    hasMore,
    oldestSeq: messages[0]?.seq ?? null,
    ...(unextractedCount !== undefined ? { unextractedCount } : {}),
    ...(totalTokens !== undefined ? { totalTokens } : {}),
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
  const { conversation_id, role, content, metadata } = parsed.data;

  const db = getDb();
  const msgId = crypto.randomUUID().slice(0, 12);
  const now = new Date().toISOString();
  const baseMetadata = metadata ?? {};
  const attachments = Array.isArray(baseMetadata.attachments)
    ? baseMetadata.attachments as MessageAttachment[]
    : undefined;
  const tokenResult = createMessageTokenCount(content, role, attachments);
  const metaStr = JSON.stringify(metadataWithTokenCountProvenance(baseMetadata, tokenResult.provenance));

  // 用事务包裹 SELECT MAX(seq) + INSERT + UPDATE conversations，避免并发写入产生重复 seq
  db.transaction(() => {
    const nextSeq = nextChainSeq(db, conversation_id);
    db.prepare(`
      INSERT INTO messages (id, conversation_id, role, content, token_count, created_at, seq, metadata)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(msgId, conversation_id, role, content, tokenResult.tokenCount, now, nextSeq, metaStr);

    db.prepare('UPDATE conversations SET updated_at = ? WHERE id = ?').run(now, conversation_id);
  })();

  const message = db.prepare('SELECT * FROM messages WHERE id = ?').get(msgId) as Message;
  return NextResponse.json(serializeTypedMessages([message])[0], { status: 201 });
}
