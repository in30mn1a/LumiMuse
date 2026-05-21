import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';

/**
 * 尝试把用户输入解析为日期范围
 * 支持格式：2026/3/30、2026-03-30、3月30日、3/30 等
 * 返回 [startISO, endISO] 或 null
 */
function isValidParsedDate(year: number, month: number, day: number, startDate: Date): boolean {
  return startDate.getFullYear() === year
    && startDate.getMonth() === month - 1
    && startDate.getDate() === day;
}

function parseDateRange(input: string): [string, string] | null {
  const now = new Date();
  let year: number | null = null;
  let month: number | null = null;
  let day: number | null = null;

  // 2026/3/30 或 2026-03-30
  let match = input.match(/^(\d{4})[/\-.](\d{1,2})[/\-.](\d{1,2})$/);
  if (match) {
    year = parseInt(match[1]);
    month = parseInt(match[2]);
    day = parseInt(match[3]);
  }


  if (!match) {
    match = input.match(/^(\d{4})年(\d{1,2})月(\d{1,2})日?$/);
    if (match) {
      year = parseInt(match[1]);
      month = parseInt(match[2]);
      day = parseInt(match[3]);
    }
  }

  // 3月30日 或 3月30
  if (!match) {
    match = input.match(/^(\d{1,2})月(\d{1,2})日?$/);
    if (match) {
      year = now.getFullYear();
      month = parseInt(match[1]);
      day = parseInt(match[2]);
    }
  }

  // 3/30 或 03-30（无年份）
  if (!match) {
    match = input.match(/^(\d{1,2})[/\-.](\d{1,2})$/);
    if (match) {
      year = now.getFullYear();
      month = parseInt(match[1]);
      day = parseInt(match[2]);
    }
  }

  if (!year || !month || !day) return null;
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;

  // 用本地时间构造当天 00:00 和 23:59:59，toISOString 会自动转为 UTC
  const startDate = new Date(year, month - 1, day, 0, 0, 0, 0);
  if (!isValidParsedDate(year, month, day, startDate)) return null;
  const endDate = new Date(year, month - 1, day, 23, 59, 59, 999);
  return [startDate.toISOString(), endDate.toISOString()];
}

/**
 * GET /api/messages/search?q=关键词&limit=10
 * 按消息内容关键词搜索，支持日期搜索
 */
export async function GET(request: NextRequest) {
  const q = request.nextUrl.searchParams.get('q')?.trim();
  const limitParam = Number(request.nextUrl.searchParams.get('limit') || '15');
  const offsetParam = Number(request.nextUrl.searchParams.get('offset') || '0');
  const limit = Math.min(Math.max(Number.isFinite(limitParam) ? limitParam : 15, 1), 50);
  const offset = Math.max(Number.isFinite(offsetParam) ? offsetParam : 0, 0);
  const pageSize = limit + 1;

  if (!q) return NextResponse.json([]);

  const db = getDb();

  // 检测是否为日期搜索
  const dateRange = parseDateRange(q);

  let rows: Array<{
    message_id: string;
    content: string;
    role: string;
    created_at: string;
    conversation_id: string;
    conversation_title: string;
    character_id: string;
    character_name: string;
    avatar_url: string | null;
  }>;

  if (dateRange) {
    // 日期搜索：按 created_at 范围 + 内容关键词（OR 逻辑）
    rows = db.prepare(`
      SELECT
        m.id        AS message_id,
        m.content   AS content,
        m.role      AS role,
        m.created_at AS created_at,
        c.id        AS conversation_id,
        c.title     AS conversation_title,
        ch.id       AS character_id,
        ch.name     AS character_name,
        ch.avatar_url AS avatar_url
      FROM messages m
      JOIN conversations c  ON m.conversation_id = c.id
      JOIN characters   ch ON c.character_id     = ch.id
      WHERE (m.created_at >= ? AND m.created_at <= ?) AND m.role IN ('user', 'assistant')
      ORDER BY m.created_at ASC
      LIMIT ? OFFSET ?
    `).all(dateRange[0], dateRange[1], pageSize, offset) as typeof rows;
  } else {
    // 普通关键词搜索
    const normalized = q.replace(/"/g, '""');
    const ftsQuery = normalized.includes(' ') ? `"${normalized}"` : normalized;
    const shouldUseLikeFirst = /[\u4e00-\u9fff]/.test(q);
    const searchLike = (): typeof rows => db.prepare(`
      SELECT
        m.id        AS message_id,
        m.content   AS content,
        m.role      AS role,
        m.created_at AS created_at,
        c.id        AS conversation_id,
        c.title     AS conversation_title,
        ch.id       AS character_id,
        ch.name     AS character_name,
        ch.avatar_url AS avatar_url
      FROM messages m
      JOIN conversations c  ON m.conversation_id = c.id
      JOIN characters   ch ON c.character_id     = ch.id
      WHERE m.content LIKE ? AND m.role IN ('user', 'assistant')
      ORDER BY m.created_at DESC
      LIMIT ? OFFSET ?
    `).all(`%${q}%`, pageSize, offset) as typeof rows;

    if (shouldUseLikeFirst) {
      rows = searchLike();
    } else {
      // 非中文走 FTS5；FTS query 解析错误或零结果（unicode61 把 query 全过滤掉）回退到 LIKE
      try {
        const ftsRows = db.prepare(`
          SELECT
            m.id        AS message_id,
            m.content   AS content,
            m.role      AS role,
            m.created_at AS created_at,
            c.id        AS conversation_id,
            c.title     AS conversation_title,
            ch.id       AS character_id,
            ch.name     AS character_name,
            ch.avatar_url AS avatar_url
          FROM messages_fts fts
          JOIN messages m      ON m.id = fts.id
          JOIN conversations c ON m.conversation_id = c.id
          JOIN characters ch   ON c.character_id = ch.id
          WHERE messages_fts MATCH ? AND m.role IN ('user', 'assistant')
          ORDER BY m.created_at DESC
          LIMIT ? OFFSET ?
        `).all(ftsQuery, pageSize, offset) as typeof rows;
        rows = ftsRows.length === 0 ? searchLike() : ftsRows;
      } catch {
        rows = searchLike();
      }
    }
  }

  const hasMore = rows.length > limit;
  const pageRows = hasMore ? rows.slice(0, limit) : rows;

  // 截取关键词周围的片段（最多 80 字）
  const snippet = (text: string, keyword: string) => {
    const idx = text.toLowerCase().indexOf(keyword.toLowerCase());
    if (idx === -1) return text.slice(0, 80);
    const start = Math.max(0, idx - 20);
    const end = Math.min(text.length, idx + keyword.length + 60);
    return (start > 0 ? '…' : '') + text.slice(start, end) + (end < text.length ? '…' : '');
  };

  return NextResponse.json({
    results: pageRows.map(r => ({
      messageId: r.message_id,
      snippet: dateRange ? r.content.slice(0, 80) : snippet(r.content, q),
      role: r.role,
      createdAt: r.created_at,
      conversationId: r.conversation_id,
      conversationTitle: r.conversation_title,
      characterId: r.character_id,
      characterName: r.character_name,
      avatarUrl: r.avatar_url,
    })),
    hasMore,
  });
}
