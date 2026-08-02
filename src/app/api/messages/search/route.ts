import { NextRequest, NextResponse } from 'next/server';
import { randomUUID } from 'node:crypto';
import { getDb } from '@/lib/db';
import { loadSettings } from '@/lib/settings';
import { currentYearInZone, zonedDayRangeToUtc } from '@/lib/chat-time';
import type { TextHighlightRange } from '@/lib/text-highlight';

function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, char => `\\${char}`);
}

function isLongCjkQuery(value: string): boolean {
  const codePoints = Array.from(value);
  return codePoints.length >= 3 && codePoints.every(codePoint => /\p{Script=Han}/u.test(codePoint));
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function literalHighlightRanges(text: string, keyword: string): TextHighlightRange[] {
  const matcher = new RegExp(escapeRegExp(keyword), 'gi');
  return Array.from(text.matchAll(matcher), match => ({
    start: match.index,
    end: match.index + match[0].length,
    text: match[0],
  }));
}

function ftsHighlightRanges(
  markedText: string,
  originalText: string,
  startMarker: string,
  endMarker: string,
): TextHighlightRange[] {
  const ranges: TextHighlightRange[] = [];
  let markedCursor = 0;
  let plainText = '';

  while (markedCursor < markedText.length) {
    const start = markedText.indexOf(startMarker, markedCursor);
    if (start === -1) {
      plainText += markedText.slice(markedCursor);
      break;
    }

    plainText += markedText.slice(markedCursor, start);
    const matchStart = plainText.length;
    const contentStart = start + startMarker.length;
    const end = markedText.indexOf(endMarker, contentStart);
    if (end === -1) return [];

    const matchedText = markedText.slice(contentStart, end);
    plainText += matchedText;
    ranges.push({ start: matchStart, end: plainText.length, text: matchedText });
    markedCursor = end + endMarker.length;
  }

  return plainText === originalText ? ranges : [];
}

/**
 * 尝试把用户输入解析为日期范围
 * 支持格式：2026/3/30、2026-03-30、3月30日、3/30 等
 * 返回 [startISO, endISO] 或 null
 *
 * 必须按用户时区解析：消息 created_at 存的是 UTC，而用户说的「3月30日」指他本地那一天。
 * 服务器时区（容器默认 UTC）与用户不同时，日边界会整体偏移，搜出来的结果头尾都不对。
 */
function parseDateRange(input: string, timeZone?: string): [string, string] | null {
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
      year = currentYearInZone(timeZone);
      month = parseInt(match[1]);
      day = parseInt(match[2]);
    }
  }

  // 3/30 或 03-30（无年份）
  if (!match) {
    match = input.match(/^(\d{1,2})[/\-.](\d{1,2})$/);
    if (match) {
      year = currentYearInZone(timeZone);
      month = parseInt(match[1]);
      day = parseInt(match[2]);
    }
  }

  if (!year || !month || !day) return null;
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;

  // 日期合法性（如 2 月 30 日）由 zonedDayRangeToUtc 内部按日历判定，与时区无关
  return zonedDayRangeToUtc(year, month, day, timeZone);
}

/**
 * GET /api/messages/search?q=关键词&limit=10&characterId=xxx
 * 按消息内容关键词搜索，支持日期搜索；带 characterId 时只搜该角色的对话
 */
export async function GET(request: NextRequest) {
  const q = request.nextUrl.searchParams.get('q')?.trim();
  const characterId = request.nextUrl.searchParams.get('characterId')?.trim() || null;
  const limitParam = Number(request.nextUrl.searchParams.get('limit') || '15');
  const offsetParam = Number(request.nextUrl.searchParams.get('offset') || '0');
  const limit = Math.floor(Math.min(Math.max(Number.isFinite(limitParam) ? limitParam : 15, 1), 50));
  const offset = Math.floor(Math.max(Number.isFinite(offsetParam) ? offsetParam : 0, 0));
  const pageSize = limit + 1;

  if (!q) return NextResponse.json([]);

  const db = getDb();
  const markerId = randomUUID();
  const highlightStartMarker = `\u001e${markerId}:start\u001f`;
  const highlightEndMarker = `\u001e${markerId}:end\u001f`;

  // 检测是否为日期搜索。按用户上报时区解析，否则容器 UTC 会让日边界整体偏移
  const dateRange = parseDateRange(q, loadSettings().client_timezone);

  // 角色过滤：子句紧跟 role 条件，参数插在关键词之后、分页参数之前
  const charClause = characterId ? 'AND ch.id = ?' : '';
  const charParams: string[] = characterId ? [characterId] : [];

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
    highlighted_content: string | null;
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
        ch.avatar_url AS avatar_url,
        NULL AS highlighted_content
      FROM messages m
      JOIN conversations c  ON m.conversation_id = c.id
      JOIN characters   ch ON c.character_id     = ch.id
      WHERE (m.created_at >= ? AND m.created_at <= ?) AND m.role IN ('user', 'assistant') ${charClause}
      ORDER BY m.created_at ASC
      LIMIT ? OFFSET ?
    `).all(dateRange[0], dateRange[1], ...charParams, pageSize, offset) as typeof rows;
  } else {
    // 普通关键词搜索
    const normalized = q.replace(/"/g, '""');
    const ftsQuery = normalized.includes(' ') ? `"${normalized}"` : normalized;
    const shouldUseLikeFirst = Array.from(q).some(codePoint => /\p{Script=Han}/u.test(codePoint));
    const shouldUseTrigram = isLongCjkQuery(q);
    const escapedKeyword = escapeLikePattern(q);
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
        ch.avatar_url AS avatar_url,
        NULL AS highlighted_content
      FROM messages m
      JOIN conversations c  ON m.conversation_id = c.id
      JOIN characters   ch ON c.character_id     = ch.id
      WHERE m.content LIKE ? ESCAPE '\\' AND m.role IN ('user', 'assistant') ${charClause}
      ORDER BY m.created_at DESC, m.seq DESC, m.id DESC
      LIMIT ? OFFSET ?
    `).all(`%${escapedKeyword}%`, ...charParams, pageSize, offset) as typeof rows;

    if (shouldUseTrigram) {
      try {
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
            ch.avatar_url AS avatar_url,
            highlight(messages_fts_trigram, 1, ?, ?) AS highlighted_content
          FROM messages_fts_trigram fts
          JOIN messages m      ON m.id = fts.id
          JOIN conversations c ON m.conversation_id = c.id
          JOIN characters ch   ON c.character_id = ch.id
          WHERE messages_fts_trigram MATCH ? AND m.role IN ('user', 'assistant') ${charClause}
          ORDER BY m.created_at DESC, m.seq DESC, m.id DESC
          LIMIT ? OFFSET ?
        `).all(highlightStartMarker, highlightEndMarker, `"${normalized}"`, ...charParams, pageSize, offset) as typeof rows;
      } catch {
        rows = searchLike();
      }
    } else if (shouldUseLikeFirst) {
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
            ch.avatar_url AS avatar_url,
            highlight(messages_fts, 1, ?, ?) AS highlighted_content
          FROM messages_fts fts
          JOIN messages m      ON m.id = fts.id
          JOIN conversations c ON m.conversation_id = c.id
          JOIN characters ch   ON c.character_id = ch.id
          WHERE messages_fts MATCH ? AND m.role IN ('user', 'assistant') ${charClause}
          ORDER BY m.created_at DESC, m.seq DESC, m.id DESC
          LIMIT ? OFFSET ?
        `).all(highlightStartMarker, highlightEndMarker, ftsQuery, ...charParams, pageSize, offset) as typeof rows;
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
      highlightRanges: dateRange
        ? []
        : r.highlighted_content === null
          ? literalHighlightRanges(r.content, q)
          : ftsHighlightRanges(
              r.highlighted_content,
              r.content,
              highlightStartMarker,
              highlightEndMarker,
            ),
    })),
    hasMore,
  });
}
